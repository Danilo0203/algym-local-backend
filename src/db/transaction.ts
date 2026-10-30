import type { PoolClient } from "pg";

import { pool } from "./pool.js";
import { logger } from "../config/logger.js";

const committedActions = new WeakMap<PoolClient, Array<() => Promise<void>>>();

export function afterCommit(client: PoolClient, action: () => Promise<void>): void {
  const actions = committedActions.get(client);
  if (!actions) throw new Error("La acción requiere una transacción activa");
  actions.push(action);
}

type TransactionHandler<T> = (
  client: PoolClient,
) => Promise<T>;

export async function withUserTransaction<T>(
  userId: string,
  handler: TransactionHandler<T>,
): Promise<T> {
  const client = await pool.connect();
  committedActions.set(client, []);

  try {
    await client.query("BEGIN");

    await client.query(
      `
        SELECT set_config(
          'app.current_user_id',
          $1,
          true
        )
      `,
      [userId],
    );

    const result = await handler(client);

    await client.query("COMMIT");

    // Los dispositivos nunca forman parte del resultado financiero del cobro.
    for (const action of committedActions.get(client) ?? []) {
      void Promise.resolve().then(action).catch((error: unknown) => {
        logger.error({ error }, "No se pudo ejecutar una acción posterior al cobro");
      });
    }

    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Se conserva el error original.
    }

    throw error;
  } finally {
    committedActions.delete(client);
    client.release();
  }
}
