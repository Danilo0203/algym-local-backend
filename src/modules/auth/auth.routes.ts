import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { NextFunction, Request, Response } from "express";

import { env } from "../../config/env.js";
import { AppError } from "../../errors/app-error.js";
import {
  changePasswordBodySchema,
  loginBodySchema,
} from "./auth.schemas.js";
import {
  authenticateUser,
  changeAuthenticatedUserPassword,
  clearSessionCookie,
  getAuthenticatedUserContext,
  getSessionCookieOptions,
  readSessionTokenFromRequest,
  revokeSessionToken,
  validateSessionToken,
} from "./auth.service.js";

export const authRouter = Router();

type SessionLocals = {
  session?: {
    sessionId: string;
    userId: string;
  };
};

function normalizeEmailForRateLimit(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }

  return input.trim().toLowerCase();
}

const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator(request) {
    const ipKey = ipKeyGenerator(request.ip ?? "");
    const emailKey = normalizeEmailForRateLimit(
      request.body?.email,
    );

    return `${ipKey}:${emailKey}`;
  },
  handler(_request, response) {
    response.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Demasiados intentos. Inténtalo de nuevo más tarde.",
      },
    });
  },
});

const changePasswordRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator(request, response) {
    const ipKey = ipKeyGenerator(request.ip ?? "");
    const sessionKey =
      (response.locals as SessionLocals).session?.userId ?? "";

    return `${ipKey}:${sessionKey}`;
  },
  handler(_request, response) {
    response.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Demasiados intentos. Inténtalo de nuevo más tarde.",
      },
    });
  },
});

async function requireAuthenticatedSession(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = readSessionTokenFromRequest(request);
    const session = await validateSessionToken(token);
    (response.locals as SessionLocals).session = session;
    next();
  } catch (error) {
    next(error);
  }
}

authRouter.post(
  "/login",
  loginRateLimiter,
  async (request, response, next) => {
    try {
      const body = loginBodySchema.parse(request.body);
      const result = await authenticateUser(body, request);

      response.cookie(
        env.AUTH_COOKIE_NAME,
        result.token,
        getSessionCookieOptions(),
      );

      response.status(200).json(result.context);
    } catch (error) {
      next(error);
    }
  },
);

authRouter.post("/logout", async (request, response, next) => {
  try {
    const token =
      typeof request.cookies?.[env.AUTH_COOKIE_NAME] === "string"
        ? request.cookies[env.AUTH_COOKIE_NAME]
        : undefined;

    await revokeSessionToken(token);
    clearSessionCookie(request);

    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", async (request, response, next) => {
  try {
    const token = readSessionTokenFromRequest(request);
    const session = await validateSessionToken(token);
    const context = await getAuthenticatedUserContext(
      session.userId,
    );

    response.status(200).json(context);
  } catch (error) {
    next(error);
  }
});

authRouter.post(
  "/change-password",
  requireAuthenticatedSession,
  changePasswordRateLimiter,
  async (request, response, next) => {
    try {
      const session = (response.locals as SessionLocals).session;

      if (!session) {
        throw new AppError(
          401,
          "INVALID_SESSION",
          "Sesión inválida",
        );
      }

      const body = changePasswordBodySchema.parse(request.body);
      const result = await changeAuthenticatedUserPassword(
        session.userId,
        body,
      );

      clearSessionCookie(request);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  },
);

authRouter.use((_request, _response, next) => {
  next(
    new AppError(
      405,
      "METHOD_NOT_ALLOWED",
      "Método no permitido",
    ),
  );
});
