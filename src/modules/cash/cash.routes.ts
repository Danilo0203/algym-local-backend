import { rateLimit } from "express-rate-limit";
import { Router } from "express";
import { z } from "zod";
import { getPaymentReceipt, getSaleReceipt, getSalesHistory } from "./cash-receipts.service.js";
import { getCashDeviceOperation, getCashDeviceStatus, requestManualDrawer, requestReceipt } from "./cash-devices.service.js";

import { AppError } from "../../errors/app-error.js";
import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { cashHistoryQuerySchema, cashProductSaleSchema, cashProductSaleVoidSchema, cashProductSearchSchema, cashSessionIdSchema, closeCashSessionSchema, manualCashMovementSchema, openCashSessionSchema } from "./cash.schemas.js";
import { closeCashSession, ensureCashRegister, getCashDashboard, getCashHistory, getCashSessionDetail, openCashSession, recordManualCashMovement } from "./cash.service.js";
import { searchCashProducts, sellCashProducts, voidCashProductSale } from "./cash-product-sales.service.js";

export const cashRouter = Router();

cashRouter.get("/sales", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = z.object({
      page: z.coerce.number().int().min(1).max(100000).default(1),
      search: z.string().trim().max(150).default(""),
      dateFrom: z.iso.date().optional(), dateTo: z.iso.date().optional(),
    }).parse(request.query);
    response.json(await getSalesHistory(session.userId, input));
  } catch (error) { next(error); }
});

cashRouter.get("/devices", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.json(await getCashDeviceStatus(session.userId));
  } catch (error) { next(error); }
});
cashRouter.get("/devices/operations/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.json(await getCashDeviceOperation(session.userId, z.string().uuid().parse(request.params.id)));
  } catch (error) { next(error); }
});
const deviceLimiter = rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: true, legacyHeaders: false });
cashRouter.post("/devices/drawer", deviceLimiter, async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = z.object({ requestId: z.string().uuid(), reason: z.string().trim().min(3).max(200) }).parse(request.body);
    response.status(202).json(await requestManualDrawer(session.userId, input.requestId, input.reason));
  } catch (error) { next(error); }
});
cashRouter.get("/sales/:id/receipt", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.json(await getSaleReceipt(session.userId, z.string().uuid().parse(request.params.id)));
  } catch (error) { next(error); }
});
cashRouter.get("/payments/:id/receipt", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.json(await getPaymentReceipt(session.userId, z.string().uuid().parse(request.params.id)));
  } catch (error) { next(error); }
});
cashRouter.post("/sales/:id/receipt", deviceLimiter, async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = z.object({ requestId: z.string().uuid() }).parse(request.body);
    response.status(202).json(await requestReceipt(session.userId, z.string().uuid().parse(request.params.id), input.requestId));
  } catch (error) { next(error); }
});

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

cashRouter.post("/sessions/:id/movements", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const sessionId = cashSessionIdSchema.parse(request.params.id);
    const input = manualCashMovementSchema.parse(request.body);
    response.status(201).json(await recordManualCashMovement(session.userId, sessionId, input));
  } catch (error) { next(error); }
});

cashRouter.get("/products/search", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = cashProductSearchSchema.parse(request.query);
    response.status(200).json(await searchCashProducts(session.userId, input.search));
  } catch (error) { next(error); }
});

cashRouter.post("/products/sales", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = cashProductSaleSchema.parse(request.body);
    response.status(201).json(await sellCashProducts(session.userId, input));
  } catch (error) { next(error); }
});

cashRouter.post("/products/sales/:id/void", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const saleId = cashSessionIdSchema.parse(request.params.id);
    const input = cashProductSaleVoidSchema.parse(request.body);
    response.status(201).json(await voidCashProductSale(session.userId, saleId, input));
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
