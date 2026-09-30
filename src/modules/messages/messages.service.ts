import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import type { CreateMessageInput, UpdateMessageInput } from "./messages.schemas.js";

type MessageRow = {
  id: string;
  name: string;
  content: string;
  is_active: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

const columns = "id, name, content, is_active, created_by, created_at, updated_at";

async function requirePermission(client: PoolClient, permission: string): Promise<void> {
  const result = await client.query<{ allowed: boolean }>(
    `SELECT (public.is_owner() OR public.has_permission($1)) AS allowed`,
    [permission],
  );
  if (!result.rows[0]?.allowed) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para administrar mensajes");
  }
}

export async function listMessages(actorUserId: string, includeInactive: boolean) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "messages.view");
    const result = await client.query<MessageRow>(
      `SELECT ${columns} FROM public.message_templates
       WHERE $1::boolean OR is_active
       ORDER BY updated_at DESC, id DESC`,
      [includeInactive],
    );
    return { data: result.rows };
  });
}

export async function createMessage(actorUserId: string, input: CreateMessageInput) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "messages.create");
    const result = await client.query<MessageRow>(
      `INSERT INTO public.message_templates (name, content, created_by)
       VALUES ($1, $2, $3) RETURNING ${columns}`,
      [input.name, input.content, actorUserId],
    );
    return result.rows[0]!;
  });
}

export async function updateMessage(
  actorUserId: string,
  messageId: string,
  input: UpdateMessageInput,
) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "messages.update");
    const result = await client.query<MessageRow>(
      `UPDATE public.message_templates
       SET name = COALESCE($2, name),
           content = COALESCE($3, content),
           is_active = COALESCE($4, is_active),
           updated_at = now()
       WHERE id = $1
       RETURNING ${columns}`,
      [messageId, input.name ?? null, input.content ?? null, input.is_active ?? null],
    );
    if (!result.rows[0]) {
      throw new AppError(404, "MESSAGE_NOT_FOUND", "Mensaje no encontrado");
    }
    return result.rows[0];
  });
}

export async function deleteMessage(actorUserId: string, messageId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "messages.delete");
    const result = await client.query<{ id: string }>(
      `DELETE FROM public.message_templates WHERE id = $1 RETURNING id`,
      [messageId],
    );
    if (!result.rows[0]) {
      throw new AppError(404, "MESSAGE_NOT_FOUND", "Mensaje no encontrado");
    }
  });
}
