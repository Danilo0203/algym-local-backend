import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type {
  NextFunction,
  Request,
  Response,
} from "express";
import { ZodError } from "zod";

import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { isAppError } from "./errors/app-error.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes.js";
import { healthRouter } from "./modules/health/health.routes.js";

export const app = express();

const allowedOrigins = new Set(env.CORS_ORIGINS);

app.disable("x-powered-by");

if (env.TRUST_PROXY) {
  app.set("trust proxy", 1);
}

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

app.use(cookieParser());

app.use(
  express.json({
    limit: "1mb",
  }),
);

app.use("/auth", authRouter);
app.use("/dashboard", dashboardRouter);
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
    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Solicitud inválida",
          details: error.flatten().fieldErrors,
        },
      });
      return;
    }

    if (isAppError(error)) {
      if (error.statusCode >= 500) {
        request.log.error(
          { error },
          "Error controlado del servidor",
        );
      }

      response.status(error.statusCode).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined
            ? { details: error.details }
            : {}),
        },
      });
      return;
    }

    request.log.error({ error }, "Error no controlado en la solicitud");

    response.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Error interno del servidor",
      },
    });
  },
);
