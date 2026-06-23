import { Router } from "express";

import { pool } from "../../db/pool.js";

export const healthRouter = Router();

healthRouter.get("/live", (_request, response) => {
  response.status(200).json({
    status: "ok",
    service: "algym-local-backend",
  });
});

healthRouter.get("/ready", async (_request, response, next) => {
  try {
    const result = await pool.query<{
      database_name: string;
      database_user: string;
      postgres_version: string;
      schema_ready: boolean;
      server_time: string;
    }>(`
      SELECT
        current_database() AS database_name,
        current_user AS database_user,
        current_setting('server_version') AS postgres_version,
        to_regclass('public.profiles') IS NOT NULL AS schema_ready,
        now()::text AS server_time
    `);

    const database = result.rows[0];

    response.status(200).json({
      status: database?.schema_ready ? "ready" : "not_ready",
      service: "algym-local-backend",
      database: {
        connected: true,
        name: database?.database_name,
        user: database?.database_user,
        version: database?.postgres_version,
        schemaReady: database?.schema_ready,
      },
      timestamp: database?.server_time,
    });
  } catch (error) {
    next(error);
  }
});
