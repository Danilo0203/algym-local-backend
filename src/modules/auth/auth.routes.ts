import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

import { env } from "../../config/env.js";
import { AppError } from "../../errors/app-error.js";
import { loginBodySchema } from "./auth.schemas.js";
import {
  authenticateUser,
  clearSessionCookie,
  getAuthenticatedUserContext,
  getSessionCookieOptions,
  readSessionTokenFromRequest,
  revokeSessionToken,
  validateSessionToken,
} from "./auth.service.js";

export const authRouter = Router();

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

authRouter.use((_request, _response, next) => {
  next(
    new AppError(
      405,
      "METHOD_NOT_ALLOWED",
      "Método no permitido",
    ),
  );
});
