import type { PoolClient } from "pg";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { afterCommit, withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import { cashDeviceTransport, type DeviceResult } from "./cash-device-transport.js";
import { readSaleReceipt, requireCashDeviceAccess } from "./cash-receipts.service.js";
import { receiptBytes } from "./receipt.js";

const pulse = Buffer.from([0x1b, 0x70, 0, 0x32, 0xfa]);
let deviceQueue: Promise<void> = Promise.resolve();

function configured() { return Boolean(env.CASH_PRINTER_NAME && env.CASH_DEVICE_DATA_DIR); }

function dispatch(actorUserId: string, id: string, kind: "drawer" | "receipt", bytes: Buffer) {
  const operation = deviceQueue.then(async () => {
    const claimed = await withUserTransaction(actorUserId, async (client) => {
      const result = await client.query(
        `UPDATE public.cash_device_operations SET status = 'dispatching'
         WHERE id = $1 AND actor_user_id = $2 AND status = 'pending'
           AND created_at > now() - interval '30 seconds'
         RETURNING id`, [id, actorUserId]);
      return result.rowCount === 1;
    });
    if (!claimed) return;
    let outcome: DeviceResult;
    try { outcome = await cashDeviceTransport.send(id, kind, bytes); }
    catch (error) {
      logger.error({ error, operationId: id }, "No se pudo confirmar la orden del dispositivo");
      outcome = { status: "unknown", message: "No se pudo confirmar la orden. Comprueba el equipo antes de volver a intentarlo." };
    }
    await withUserTransaction(actorUserId, async (client) => {
      await client.query(`UPDATE public.cash_device_operations
        SET status = $2, message = $3, spool_job_id = $4, finished_at = now()
        WHERE id = $1 AND status = 'dispatching'`,
      [id, outcome.status, outcome.message, outcome.jobId ?? null]);
    });
  });
  deviceQueue = operation.catch((error: unknown) => {
    logger.error({ error, operationId: id }, "Error de control del dispositivo de caja");
  });
  return deviceQueue;
}

export async function queueAutomaticDrawer(
  client: PoolClient, actorUserId: string, movementId: string, method: string,
) {
  if (method !== "cash" || !env.CASH_DRAWER_ENABLED || !configured()) return;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.cash_device_operations (actor_user_id, movement_id, kind, collection_id)
     SELECT $1, m.id, 'drawer_auto', p.collection_id FROM public.cash_movements m
     LEFT JOIN public.payments p ON p.id = m.source_payment_id
     WHERE m.id = $2 AND m.created_by_user_id = $1 AND m.movement_type = 'sale'
       AND m.payment_method = 'cash' AND m.amount > 0 AND m.voided_at IS NULL
     ON CONFLICT DO NOTHING RETURNING id`,
    [actorUserId, movementId],
  );
  const id = rows[0]?.id;
  if (id) afterCommit(client, () => dispatch(actorUserId, id, "drawer", pulse));
}

async function expireOperations(client: PoolClient) {
  await client.query(`UPDATE public.cash_device_operations
    SET status = CASE WHEN status = 'pending' THEN 'expired' ELSE 'unknown' END,
        message = 'La orden caducó. Comprueba el equipo; no se reenviará automáticamente.', finished_at = now()
    WHERE actor_user_id = auth.uid() AND
      ((status = 'pending' AND created_at < now() - interval '30 seconds')
       OR (status = 'dispatching' AND created_at < now() - interval '60 seconds'))`);
}

export function getCashDeviceStatus(actorUserId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireCashDeviceAccess(client);
    await expireOperations(client);
    const { rows } = await client.query(
      `SELECT id, kind, status, message, movement_id, created_at FROM public.cash_device_operations
       WHERE actor_user_id = $1 AND created_at > now() - interval '1 day'
       ORDER BY created_at DESC LIMIT 8`, [actorUserId],
    );
    return { configured: configured(), automaticDrawer: configured() && env.CASH_DRAWER_ENABLED,
      printerName: env.CASH_PRINTER_NAME || null, operations: rows };
  });
}

export function getCashDeviceOperation(actorUserId: string, id: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireCashDeviceAccess(client);
    await expireOperations(client);
    const { rows } = await client.query(
      "SELECT id, kind, status, message, spool_job_id FROM public.cash_device_operations WHERE id = $1", [id],
    );
    if (!rows[0]) throw new AppError(404, "OPERATION_NOT_FOUND", "Orden no encontrada");
    return rows[0];
  });
}

export function requestReceipt(actorUserId: string, movementId: string, requestId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    const receipt = await readSaleReceipt(client, movementId);
    if (!configured()) throw new AppError(409, "PRINTER_NOT_CONFIGURED", "La impresora de recibos no está configurada");
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO public.cash_device_operations(id, actor_user_id, movement_id, kind)
       VALUES ($1, $2, $3, 'receipt') ON CONFLICT (id) DO NOTHING RETURNING id`,
      [requestId, actorUserId, movementId],
    );
    if (inserted.rows[0]) {
      const bytes = receiptBytes(receipt);
      afterCommit(client, () => dispatch(actorUserId, requestId, "receipt", bytes));
    } else {
      const existing = await client.query(
        "SELECT id FROM public.cash_device_operations WHERE id = $1 AND actor_user_id = $2 AND movement_id = $3 AND kind = 'receipt'",
        [requestId, actorUserId, movementId]);
      if (!existing.rows[0]) throw new AppError(409, "REQUEST_CONFLICT", "La solicitud ya fue utilizada");
    }
    return { id: requestId };
  });
}

export function requestManualDrawer(actorUserId: string, requestId: string, reason: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireCashDeviceAccess(client);
    if (!configured() || !env.CASH_DRAWER_ENABLED) {
      throw new AppError(409, "DRAWER_NOT_CONFIGURED", "El cajón no está habilitado");
    }
    const session = await client.query(
      "SELECT id FROM public.cash_sessions WHERE opened_by_user_id = $1 AND status = 'open' LIMIT 1", [actorUserId]);
    if (!session.rows[0]) throw new AppError(409, "CASH_SESSION_REQUIRED", "Abre tu turno de caja primero");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.cash_device_operations(id, actor_user_id, kind, reason)
       VALUES ($1, $2, 'drawer_manual', $3) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [requestId, actorUserId, reason],
    );
    if (rows[0]) afterCommit(client, () => dispatch(actorUserId, requestId, "drawer", pulse));
    else {
      const existing = await client.query(
        "SELECT id FROM public.cash_device_operations WHERE id = $1 AND actor_user_id = $2 AND kind = 'drawer_manual'", [requestId, actorUserId]);
      if (!existing.rows[0]) throw new AppError(409, "REQUEST_CONFLICT", "La solicitud ya fue utilizada");
    }
    return { id: requestId };
  });
}
