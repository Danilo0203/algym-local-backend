import { Pool } from "pg";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

export const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: "algym-local-backend",
});

pool.on("error", (error) => {
  logger.error(
    { error },
    "Error inesperado en el pool de PostgreSQL",
  );
});

export async function verifyDatabaseConnection(): Promise<void> {
  const result = await pool.query<{
    database_name: string;
    database_user: string;
  }>(`
    SELECT
      current_database() AS database_name,
      current_user AS database_user
  `);

  const connection = result.rows[0];

  logger.info(
    {
      database: connection?.database_name,
      user: connection?.database_user,
    },
    "Conexión con PostgreSQL establecida",
  );
}

export async function closeDatabasePool(): Promise<void> {
  await pool.end();
}
