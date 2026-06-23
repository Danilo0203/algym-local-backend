import type { Server } from "node:http";

import { app } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import {
  closeDatabasePool,
  verifyDatabaseConnection,
} from "./db/pool.js";

let server: Server | undefined;
let shuttingDown = false;

async function start(): Promise<void> {
  await verifyDatabaseConnection();

  server = app.listen(env.PORT, env.HOST, () => {
    logger.info(
      {
        host: env.HOST,
        port: env.PORT,
      },
      `ALGYM API disponible en http://${env.HOST}:${env.PORT}`,
    );
  });
}

async function shutdown(
  signal: string,
  exitCode = 0,
): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  logger.info(
    { signal },
    "Cerrando ALGYM API",
  );

  const forceExitTimer = setTimeout(() => {
    logger.error("El cierre excedió el tiempo permitido");
    process.exit(1);
  }, 10_000);

  forceExitTimer.unref();

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  await closeDatabasePool();

  logger.info("ALGYM API cerrada correctamente");
  process.exit(exitCode);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("uncaughtException", (error) => {
  logger.fatal(
    { error },
    "Excepción no controlada",
  );

  void shutdown("uncaughtException", 1);
});

process.on("unhandledRejection", (error) => {
  logger.fatal(
    { error },
    "Promesa rechazada sin manejar",
  );

  void shutdown("unhandledRejection", 1);
});

start().catch((error) => {
  logger.fatal(
    { error },
    "No se pudo iniciar ALGYM API",
  );

  process.exit(1);
});
