import { rateLimit } from "express-rate-limit";
import { Router } from "express";

import { AppError } from "../../errors/app-error.js";
import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { cashHistoryQuerySchema, cashSessionIdSchema, closeCashSessionSchema, openCashSessionSchema } from "./cash.schemas.js";
import { closeCashSession, ensureCashRegister, getCashDashboard, getCashHistory, getCashSessionDetail, openCashSession } from "./cash.service.js";

export const cashRouter = Router();

cashRouter.get("/dashboard", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await getCashDashboard(session.userId));
  } catch (error) { next(error); }
});

cashRouter.post("/registers/default", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await ensureCashRegister(session.userId));
  } catch (error) { next(error); }
});

cashRouter.post("/sessions", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = openCashSessionSchema.parse(request.body);
    response.status(201).json(await openCashSession(session.userId, input));
  } catch (error) { next(error); }
});

cashRouter.get("/sessions", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = cashHistoryQuerySchema.parse(request.query);
    response.status(200).json(await getCashHistory(session.userId, input));
  } catch (error) { next(error); }
});

cashRouter.get("/sessions/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const sessionId = cashSessionIdSchema.parse(request.params.id);
    response.status(200).json(await getCashSessionDetail(session.userId, sessionId));
  } catch (error) { next(error); }
});

const closeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Demasiados intentos de cierre" } },
});

cashRouter.post("/sessions/:id/close", closeLimiter, async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const sessionId = cashSessionIdSchema.parse(request.params.id);
    const input = closeCashSessionSchema.parse(request.body);
    response.status(200).json(await closeCashSession(session.userId, sessionId, input));
  } catch (error) { next(error); }
});

cashRouter.use((_request, _response, next) => {
  next(new AppError(405, "METHOD_NOT_ALLOWED", "Método no permitido"));
});
