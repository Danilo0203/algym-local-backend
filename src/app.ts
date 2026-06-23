import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type {
  NextFunction,
  Request,
  Response,
} from "express";

import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { healthRouter } from "./modules/health/health.routes.js";

export const app = express();

const allowedOrigins = new Set(env.CORS_ORIGINS);

app.disable("x-powered-by");

app.use(
  pinoHttp({
    logger,
  }),
);

app.use(helmet());

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origen no permitido"));
    },
  }),
);

app.use(
  express.json({
    limit: "1mb",
  }),
);

app.use("/health", healthRouter);

app.use((_request: Request, response: Response) => {
  response.status(404).json({
    error: "Ruta no encontrada",
  });
});

app.use(
  (
    error: unknown,
    request: Request,
    response: Response,
    _next: NextFunction,
  ) => {
    request.log.error(
      { error },
      "Error no controlado en la solicitud",
    );

    response.status(500).json({
      error: "Error interno del servidor",
    });
  },
);
