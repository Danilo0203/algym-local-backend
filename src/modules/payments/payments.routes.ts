import { Router } from "express";

import { AppError } from "../../errors/app-error.js";
import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { paidMembershipSchema, paymentsListQuerySchema } from "./payments.schemas.js";
import { createPaidMembership } from "./paid-membership.service.js";
import { listPayments } from "./payments.service.js";

export const paymentsRouter = Router();

paymentsRouter.get("/", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = paymentsListQuerySchema.parse(request.query);
    response.status(200).json(await listPayments(session.userId, input));
  } catch (error) {
    next(error);
  }
});

paymentsRouter.post("/membership", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = paidMembershipSchema.parse(request.body);
    response.status(201).json(await createPaidMembership(session.userId, input));
  } catch (error) {
    next(error);
  }
});

paymentsRouter.use((_request, _response, next) => {
  next(new AppError(405, "METHOD_NOT_ALLOWED", "Método no permitido"));
});
