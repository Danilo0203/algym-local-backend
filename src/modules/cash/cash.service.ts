import bcrypt from "bcryptjs";
import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import type { CashHistoryQuery, CloseCashSessionInput, OpenCashSessionInput } from "./cash.schemas.js";

type Authorization = { role: string | null; permissions: string[] | null; is_owner: boolean };
type SessionRow = {
  id: string; session_number: string; cash_register_id: string; cash_register_name: string | null;
  opened_by_user_id: string; opened_by_name: string | null;
  closed_by_user_id: string | null; closed_by_name: string | null;
  opened_at: Date; closed_at: Date | null;
  opening_amount: string; expected_amount: string | null; counted_amount: string | null;
  difference_amount: string | null; status: string; notes: string | null;
};
type MovementRow = {
  id: string; cash_session_id: string | null; movement_type: string; category: string;
  payment_method: "cash" | "card" | "transfer" | null;
  amount: string; cash_effect_amount: string; session_link_status: string; origin: string;
  source_payment_id: string | null; source_subscription_id: string | null;
  source_product_sale_id: string | null; source_product_sale_status: string | null;
  product_sale_number: string | null; product_sale_items_summary: string | null;
  customer_id: string | null; customer_name: string | null;
  created_by_user_id: string; created_by_name: string | null;
  note: string | null; created_at: Date; voided_at: Date | null;
  source_payment_status: string | null;
};

async function authorization(client: PoolClient): Promise<Authorization> {
  const result = await client.query<Authorization>(
    `SELECT public.get_my_role()::text AS role,
            public.get_current_permissions() AS permissions,
            public.is_owner() AS is_owner`,
  );
  return result.rows[0] ?? { role: null, permissions: [], is_owner: false };
}

function canOperate(auth: Authorization): boolean {
  return auth.is_owner || (auth.permissions?.includes("cash.operate") ?? false);
}

function requireOperator(auth: Authorization): void {
  if (!canOperate(auth)) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para operar caja");
  }
}

const sessionColumns = `
  s.id, s.session_number, s.cash_register_id, r.name AS cash_register_name,
  s.opened_by_user_id, opener.full_name AS opened_by_name,
  s.closed_by_user_id, closer.full_name AS closed_by_name,
  s.opened_at, s.closed_at, s.opening_amount, s.expected_amount,
  s.counted_amount, s.difference_amount, s.status, s.notes`;

const movementColumns = `
  m.id, m.cash_session_id, m.movement_type, m.category, m.payment_method,
  m.amount, m.cash_effect_amount, m.session_link_status, m.origin,
  m.source_payment_id, m.source_subscription_id, m.source_product_sale_id,
  sale.status AS source_product_sale_status,
  sale.sale_number AS product_sale_number,
  (SELECT string_agg(item.product_name || ' x' || item.quantity::text, ', ' ORDER BY item.created_at)
     FROM public.product_sale_items AS item
    WHERE item.product_sale_id = sale.id) AS product_sale_items_summary,
  m.customer_id, customer.full_name AS customer_name,
  m.created_by_user_id, creator.full_name AS created_by_name,
  m.note, m.created_at, m.voided_at, payment.status::text AS source_payment_status`;

const movementJoins = `
  LEFT JOIN public.profiles AS customer ON customer.id = m.customer_id
  LEFT JOIN public.profiles AS creator ON creator.id = m.created_by_user_id
  LEFT JOIN public.payments AS payment ON payment.id = m.source_payment_id
  LEFT JOIN public.product_sales AS sale ON sale.id = m.source_product_sale_id`;

function mapSession(row: SessionRow) {
  return {
    ...row,
    cash_register_name: row.cash_register_name || "Caja",
    opened_by_name: row.opened_by_name || "Usuario",
    closed_by_name: row.closed_by_user_id ? row.closed_by_name || "Usuario" : null,
    opened_at: row.opened_at.toISOString(),
    closed_at: row.closed_at?.toISOString() ?? null,
    opening_amount: Number(row.opening_amount),
    expected_amount: row.expected_amount === null ? null : Number(row.expected_amount),
    counted_amount: row.counted_amount === null ? null : Number(row.counted_amount),
    difference_amount: row.difference_amount === null ? null : Number(row.difference_amount),
  };
}

function mapMovement(row: MovementRow) {
  return {
    ...row,
    amount: Number(row.amount),
    cash_effect_amount: Number(row.cash_effect_amount),
    customer_name: row.customer_id ? row.customer_name || "Cliente" : null,
    created_by_name: row.created_by_name || "Usuario",
    created_at: row.created_at.toISOString(),
    voided_at: row.voided_at?.toISOString() ?? null,
  };
}

type MovementView = ReturnType<typeof mapMovement>;

function summarize(movements: MovementView[], openingAmount: number) {
  const summary = {
    openingAmount, expectedAmount: openingAmount,
    countedAmount: null as number | null,
    differenceAmount: null as number | null,
    totalsByMethod: { cash: 0, card: 0, transfer: 0 },
    refunds: 0, adjustments: 0, voids: 0, salesCount: 0,
  };
  for (const movement of movements) {
    if (movement.voided_at) continue;
    summary.expectedAmount += movement.cash_effect_amount;
    if (movement.movement_type === "sale") {
      summary.salesCount += 1;
      if (movement.payment_method) summary.totalsByMethod[movement.payment_method] += movement.amount;
    } else if (movement.movement_type === "refund") {
      summary.refunds += movement.amount;
    } else if (movement.movement_type === "adjustment") {
      summary.adjustments += movement.cash_effect_amount;
    } else if (movement.movement_type === "void") {
      summary.voids += movement.amount;
    }
  }
  return summary;
}

export async function getCashDashboard(actorUserId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await authorization(client);
    requireOperator(auth);

    const registerResult = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM public.cash_registers
       WHERE is_active = true ORDER BY created_at ASC LIMIT 1`,
    );
    const register = registerResult.rows[0] ?? null;
    let currentSession: ReturnType<typeof mapSession> | null = null;
    let supervisedOpenSessions: ReturnType<typeof mapSession>[] = [];
    let sessionMovements: MovementView[] = [];
    let summary: ReturnType<typeof summarize> | null = null;

    if (register) {
      const sessionResult = await client.query<SessionRow>(
        `SELECT ${sessionColumns} FROM public.cash_sessions AS s
         JOIN public.cash_registers AS r ON r.id = s.cash_register_id
         LEFT JOIN public.profiles AS opener ON opener.id = s.opened_by_user_id
         LEFT JOIN public.profiles AS closer ON closer.id = s.closed_by_user_id
         WHERE s.opened_by_user_id = $1 AND s.status = 'open'
         ORDER BY s.opened_at DESC LIMIT 1`,
        [actorUserId],
      );
      const row = sessionResult.rows[0];
      if (row) {
        currentSession = mapSession(row);
        const movements = await client.query<MovementRow>(
          `SELECT ${movementColumns} FROM public.cash_movements AS m
           ${movementJoins}
           WHERE m.cash_session_id = $1 ORDER BY m.created_at DESC`,
          [row.id],
        );
        sessionMovements = movements.rows.map(mapMovement);
        summary = summarize(sessionMovements, currentSession.opening_amount);
      }

      if (auth.is_owner) {
        const supervised = await client.query<SessionRow>(
          `SELECT ${sessionColumns} FROM public.cash_sessions AS s
           JOIN public.cash_registers AS r ON r.id = s.cash_register_id
           LEFT JOIN public.profiles AS opener ON opener.id = s.opened_by_user_id
           LEFT JOIN public.profiles AS closer ON closer.id = s.closed_by_user_id
           WHERE s.cash_register_id = $1 AND s.status = 'open'
             AND s.opened_by_user_id <> $2
           ORDER BY s.opened_at DESC`,
          [register.id, actorUserId],
        );
        supervisedOpenSessions = supervised.rows.map(mapSession);
      }
    }

    const outOfSessionResult = await client.query<MovementRow>(
      `SELECT ${movementColumns} FROM public.cash_movements AS m
       ${movementJoins}
       WHERE m.session_link_status = 'out_of_session'
         AND m.created_by_user_id = $1
         AND (m.created_at AT TIME ZONE 'America/Guatemala')::date =
             (now() AT TIME ZONE 'America/Guatemala')::date
       ORDER BY m.created_at DESC`,
      [actorUserId],
    );
    const outOfSessionMovements = outOfSessionResult.rows.map(mapMovement);
    const activityMovements = [...sessionMovements, ...outOfSessionMovements]
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));

    return {
      access: { role: auth.role, userId: actorUserId }, register, currentSession,
      supervisedOpenSessions, summary, sessionMovements, outOfSessionMovements,
      activityMovements, canOpenSession: !currentSession,
      canOperateSession: Boolean(currentSession),
    };
  });
}

const historySortColumns = new Set([
  "session_number", "opened_at", "closed_at", "opening_amount", "difference_amount", "status",
]);

function historyOrder(sort: string | undefined): string {
  if (!sort) return "s.opened_at DESC, s.id DESC";
  const order = sort.split(",").map((part) => {
    const [column, direction] = part.split(":");
    if (!column || !historySortColumns.has(column) || !["asc", "desc"].includes(direction ?? "")) {
      throw new AppError(400, "VALIDATION_ERROR", "Orden del historial inválido");
    }
    return `s.${column} ${direction!.toUpperCase()} NULLS LAST`;
  });
  return [...order, "s.id DESC"].join(", ");
}

function historyWhere(input: CashHistoryQuery, actorUserId: string | null, withNumber: boolean,
  withOpenedBy: boolean) {
  const values: unknown[] = [];
  const filters: string[] = [];
  const add = (fragment: string, value: unknown) => {
    values.push(value);
    filters.push(fragment.replace("?", `$${values.length}`));
  };
  if (withNumber && input.sessionNumber) {
    add("s.session_number ILIKE ? ESCAPE '\\'",
      `%${input.sessionNumber.replace(/[\\%_]/g, "\\$&")}%`);
  }
  if (input.status !== "all") add("s.status = ?", input.status);
  if (input.dateFrom) {
    add("s.opened_at >= (?::date::timestamp AT TIME ZONE 'America/Guatemala')", input.dateFrom);
  }
  if (input.dateTo) {
    add("s.opened_at < ((?::date + 1)::timestamp AT TIME ZONE 'America/Guatemala')", input.dateTo);
  }
  if (actorUserId) add("s.opened_by_user_id = ?::uuid", actorUserId);
  else if (withOpenedBy && input.openedByUserId) add("s.opened_by_user_id = ?::uuid", input.openedByUserId);
  return { clause: filters.length ? `WHERE ${filters.join(" AND ")}` : "", values };
}

export async function getCashHistory(actorUserId: string, input: CashHistoryQuery) {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await authorization(client);
    requireOperator(auth);
    const where = historyWhere(input, auth.is_owner ? null : actorUserId, true, true);
    const count = await client.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM public.cash_sessions AS s ${where.clause}`,
      where.values,
    );
    const sessions = await client.query<SessionRow>(
      `SELECT ${sessionColumns} FROM public.cash_sessions AS s
       JOIN public.cash_registers AS r ON r.id = s.cash_register_id
       LEFT JOIN public.profiles AS opener ON opener.id = s.opened_by_user_id
       LEFT JOIN public.profiles AS closer ON closer.id = s.closed_by_user_id
       ${where.clause}
       ORDER BY ${historyOrder(input.sort)}
       LIMIT $${where.values.length + 1} OFFSET $${where.values.length + 2}`,
      [...where.values, input.perPage, (input.page - 1) * input.perPage],
    );

    let availableUsers: Array<{ id: string; name: string }> = [];
    if (auth.is_owner) {
      const usersWhere = historyWhere(input, null, false, false);
      const users = await client.query<{ id: string; name: string }>(
        `SELECT DISTINCT s.opened_by_user_id AS id,
                COALESCE(p.full_name, 'Usuario') AS name
         FROM public.cash_sessions AS s
         LEFT JOIN public.profiles AS p ON p.id = s.opened_by_user_id
         ${usersWhere.clause}`,
        usersWhere.values,
      );
      availableUsers = users.rows.sort((left, right) => left.name.localeCompare(right.name, "es"));
    }

    return {
      access: { role: auth.role, userId: actorUserId },
      sessions: sessions.rows.map(mapSession), availableUsers,
      totalItems: Number(count.rows[0]?.total ?? 0),
      filters: {
        dateFrom: input.dateFrom || "", dateTo: input.dateTo || "", status: input.status,
        openedByUserId: auth.is_owner ? input.openedByUserId || "" : actorUserId,
      },
    };
  });
}

export async function getCashSessionDetail(actorUserId: string, sessionId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await authorization(client);
    requireOperator(auth);
    const sessions = await client.query<SessionRow>(
      `SELECT ${sessionColumns} FROM public.cash_sessions AS s
       JOIN public.cash_registers AS r ON r.id = s.cash_register_id
       LEFT JOIN public.profiles AS opener ON opener.id = s.opened_by_user_id
       LEFT JOIN public.profiles AS closer ON closer.id = s.closed_by_user_id
       WHERE s.id = $1`,
      [sessionId],
    );
    const row = sessions.rows[0];
    if (!row) throw new AppError(404, "CASH_SESSION_NOT_FOUND", "Sesión de caja no encontrada");
    const session = mapSession(row);
    const movements = await client.query<MovementRow>(
      `SELECT ${movementColumns} FROM public.cash_movements AS m
       ${movementJoins}
       WHERE m.cash_session_id = $1 ORDER BY m.created_at DESC`,
      [sessionId],
    );
    const mappedMovements = movements.rows.map(mapMovement);
    const summary = summarize(mappedMovements, session.opening_amount);
    summary.countedAmount = session.counted_amount;
    summary.differenceAmount = session.difference_amount;
    if (session.expected_amount !== null) summary.expectedAmount = session.expected_amount;

    return {
      access: { role: auth.role, userId: actorUserId },
      session, summary, movements: mappedMovements,
    };
  });
}

export async function ensureCashRegister(actorUserId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await authorization(client);
    requireOperator(auth);
    if (!auth.is_owner && auth.role !== "admin") {
      throw new AppError(403, "FORBIDDEN", "No autorizado para configurar la caja principal");
    }

    const active = await client.query<{ id: string; name: string }>(
      `SELECT id, name FROM public.cash_registers WHERE is_active = true
       ORDER BY created_at ASC LIMIT 1`,
    );
    if (active.rows[0]) return { register: active.rows[0] };

    const existing = await client.query<{ id: string; name: string }>(
      `UPDATE public.cash_registers SET is_active = true
       WHERE name = 'Caja principal' RETURNING id, name`,
    );
    if (existing.rows[0]) return { register: existing.rows[0] };

    const created = await client.query<{ id: string; name: string }>(
      `INSERT INTO public.cash_registers (name, is_active)
       VALUES ('Caja principal', true) RETURNING id, name`,
    );
    return { register: created.rows[0]! };
  });
}

function cashOperationError(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && error.code === "P0001") {
    const message = "message" in error && typeof error.message === "string"
      ? error.message : "Operación de caja inválida";
    throw new AppError(400, "CASH_OPERATION_FAILED", message);
  }
  throw error;
}

export async function openCashSession(actorUserId: string, input: OpenCashSessionInput) {
  try {
    return await withUserTransaction(actorUserId, async (client) => {
      requireOperator(await authorization(client));
      const result = await client.query<SessionRow>(
        `SELECT * FROM public.open_cash_session($1::uuid, $2::numeric, $3::text)`,
        [input.registerId, input.openingAmount, input.notes || null],
      );
      return { id: result.rows[0]!.id };
    });
  } catch (error) { cashOperationError(error); }
}

type PrivilegedUser = { id: string; encrypted_password: string | null };

export async function closeCashSession(
  actorUserId: string, sessionId: string, input: CloseCashSessionInput,
) {
  try {
    return await withUserTransaction(actorUserId, async (client) => {
      const auth = await authorization(client);
      requireOperator(auth);
      let closedByUserId = actorUserId;
      const canSelfAuthorize = auth.is_owner || auth.role === "admin"
        || (auth.permissions?.includes("cash.close_without_admin_password") ?? false);
      if (!canSelfAuthorize) {
        if (!input.adminPassword?.trim()) {
          throw new AppError(400, "ADMIN_PASSWORD_REQUIRED",
            "Debes ingresar la contraseña de un administrador u owner para cerrar la caja.");
        }
        const privileged = await client.query<PrivilegedUser>(
          `SELECT u.id, u.encrypted_password FROM auth.users AS u
           WHERE private.is_active_cash_authorizer(u.id)
             AND u.deleted_at IS NULL
             AND u.encrypted_password IS NOT NULL`,
        );
        let authorizedId: string | null = null;
        for (const user of privileged.rows) {
          if (user.encrypted_password && await bcrypt.compare(input.adminPassword, user.encrypted_password)) {
            authorizedId = user.id;
            break;
          }
        }
        if (!authorizedId) {
          throw new AppError(403, "INVALID_ADMIN_PASSWORD",
            "La contraseña no coincide con ningún administrador u owner.");
        }
        closedByUserId = authorizedId;
      }

      const result = await client.query<SessionRow>(
        `SELECT * FROM public.close_cash_session(
          $1::uuid, $2::numeric, $3::text, $4::uuid, $5::uuid)`,
        [sessionId, input.countedAmount, input.notes || null, actorUserId, closedByUserId],
      );
      return { id: result.rows[0]!.id, status: result.rows[0]!.status };
    });
  } catch (error) { cashOperationError(error); }
}
