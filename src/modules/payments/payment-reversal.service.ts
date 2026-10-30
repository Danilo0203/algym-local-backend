import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import type { ReversePaymentInput } from "./payments.schemas.js";
import { enrollmentLock } from "../enrollment/enrollment.service.js";

type Authorization = { permissions: string[] | null; is_owner: boolean };
type Payment = {
  payment_kind: "membership" | "enrollment" | null;
  enrollment_year: number | null;
  collection_id: string;
  id: string;
  user_id: string | null;
  subscription_id: string | null;
  amount_original: string;
  amount_paid: string;
  method: "cash" | "card" | "transfer";
  status: string;
};

function canOperate(auth: Authorization | undefined): boolean {
  return Boolean(auth?.is_owner || auth?.permissions?.includes("cash.operate"));
}

function canReverse(auth: Authorization | undefined): boolean {
  return Boolean(auth?.is_owner || (auth?.permissions?.includes("cash.operate")
    && auth.permissions.includes("cash.reverse_payment")
    && auth.permissions.includes("customers.manage_membership")));
}

export async function getPaymentReversalContext(actorUserId: string, paymentId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    const authorization = await client.query<Authorization>(
      `SELECT public.get_current_permissions() AS permissions, public.is_owner() AS is_owner`,
    );
    if (!canOperate(authorization.rows[0])) {
      throw new AppError(403, "FORBIDDEN", "No autorizado para consultar cobros de caja");
    }

    const result = await client.query<{
      payment_id: string; user_id: string; user_name: string | null; payment_kind: string | null;
      subscription_id: string | null; plan_name: string | null;
      amount_original: string; discount_amount: string; amount_paid: string;
      method: "cash" | "card" | "transfer"; payment_date: Date; status: string;
    }>(
      `SELECT payment.id AS payment_id, payment.user_id, payment.payment_kind,
              customer.full_name AS user_name, payment.subscription_id,
              CASE WHEN payment.payment_kind = 'enrollment' THEN 'Inscripción ' || payment.enrollment_year
                ELSE plan.name END AS plan_name, payment.amount_original::text AS amount_original,
              payment.discount_amount::text AS discount_amount,
              payment.amount_paid::text AS amount_paid, payment.method,
              payment.payment_date, payment.status
       FROM public.payments AS payment
       LEFT JOIN public.profiles AS customer ON customer.id = payment.user_id
       LEFT JOIN public.subscriptions AS subscription ON subscription.id = payment.subscription_id
       LEFT JOIN public.plans AS plan ON plan.id = subscription.plan_id
       WHERE payment.id = $1`,
      [paymentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...row,
      user_name: row.user_name || "Cliente",
      amount_original: Number(row.amount_original),
      discount_amount: Number(row.discount_amount),
      amount_paid: Number(row.amount_paid),
      payment_date: row.payment_date.toISOString(),
    };
  });
}

export async function reverseAndRecreatePayment(
  actorUserId: string, paymentId: string, input: ReversePaymentInput,
) {
  try {
    return await withUserTransaction(actorUserId, async (client) => {
      const authorization = await client.query<Authorization>(
        `SELECT public.get_current_permissions() AS permissions, public.is_owner() AS is_owner`,
      );
      if (!canReverse(authorization.rows[0])) {
        throw new AppError(403, "FORBIDDEN", "No autorizado para corregir pagos");
      }

      const originalResult = await client.query<Payment>(
        `SELECT id, user_id, subscription_id, payment_kind, enrollment_year, collection_id,
                amount_original::text AS amount_original,
                amount_paid::text AS amount_paid, method, status
         FROM public.payments WHERE id = $1 FOR UPDATE`,
        [paymentId],
      );
      const original = originalResult.rows[0];
      if (!original) throw new AppError(404, "PAYMENT_NOT_FOUND", "Pago no encontrado");
      if (original.status !== "posted") {
        throw new AppError(409, "PAYMENT_ALREADY_REVERSED", "El pago ya fue reversado");
      }
      if ((!original.subscription_id && original.payment_kind !== "enrollment") || !original.user_id) {
        throw new AppError(422, "PAYMENT_NOT_MEMBERSHIP", "Este pago no pertenece a una membresía");
      }
      if (Math.abs(Number(original.amount_original) - input.amountOriginal) > 0.009) {
        throw new AppError(409, "PAYMENT_CHANGED", "El importe original cambió; vuelve a cargar el pago");
      }
      const sourceCategory = original.payment_kind ?? input.sourceCategory;
      if (original.payment_kind === "enrollment") {
        await enrollmentLock(client, original.user_id);
        if (input.discountAmount !== 0 || input.amountPaid !== Number(original.amount_original)) {
          throw new AppError(400, "INVALID_ENROLLMENT_CORRECTION", "La inscripción conserva su importe original y no admite descuentos");
        }
      }

      const reversalNote = `Reverso del pago ${paymentId}${input.note ? `: ${input.note}` : ""}`;
      const reversal = await client.query<{ id: string }>(
        `SELECT id FROM public.insert_reversal_cash_movement(
           $1::uuid, $2::uuid, $3::text, $4::text
         )`,
        [paymentId, actorUserId, sourceCategory, reversalNote],
      );

      const replacement = await client.query<{ id: string }>(
        `INSERT INTO public.payments
           (subscription_id, user_id, amount_original, discount_amount, amount_paid,
            method, payment_date, created_by_user_id, status, payment_kind, enrollment_year, collection_id)
         VALUES ($1, $2, $3::numeric, $4::numeric, $5::numeric,
                 $6::public.payment_method, now(), $7, 'posted', $8, $9, $10)
         RETURNING id`,
        [original.subscription_id, original.user_id, input.amountOriginal,
          input.discountAmount, input.amountPaid, input.paymentMethod, actorUserId,
          original.payment_kind, original.enrollment_year, original.collection_id],
      );
      const replacementId = replacement.rows[0]!.id;
      if (original.payment_kind === "enrollment") {
        await client.query(`UPDATE public.customer_enrollments SET payment_id = $2, recorded_by = $3
          WHERE payment_id = $1`, [paymentId, replacementId, actorUserId]);
      }

      const reversed = await client.query<{ id: string }>(
        `UPDATE public.payments
         SET status = 'reversed', reversed_at = now(), reversed_by_user_id = $2,
             replacement_payment_id = $3, reversal_reason = $4
         WHERE id = $1 RETURNING id`,
        [paymentId, actorUserId, replacementId, input.reason],
      );
      if (reversed.rowCount !== 1) {
        throw new AppError(409, "PAYMENT_REVERSAL_FAILED", "El pago no quedó reversado");
      }
      const movement = await client.query<{ id: string }>(
        `SELECT id FROM public.attach_payment_to_cash(
           $1::uuid, $2::uuid, $3::text, $4::text
         )`,
        [replacementId, actorUserId, sourceCategory, input.note ?? null],
      );
      return {
        reversed_payment_id: paymentId,
        replacement_payment_id: replacementId,
        reversal_movement_id: reversal.rows[0]!.id,
        replacement_movement_id: movement.rows[0]!.id,
      };
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P0001") {
      throw new AppError(400, "PAYMENT_REVERSAL_FAILED", "No se pudo corregir este pago");
    }
    throw error;
  }
}
