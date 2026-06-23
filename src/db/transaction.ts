import type { PoolClient } from "pg";

import { pool } from "./pool.js";

type TransactionHandler<T> = (
  client: PoolClient,
) => Promise<T>;

export async function withUserTransaction<T>(
  userId: string,
  handler: TransactionHandler<T>,
): Promise<T> {
  const client = await pool.connect();

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

    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Se conserva el error original.
    }

    throw error;
  } finally {
    client.release();
  }
}
