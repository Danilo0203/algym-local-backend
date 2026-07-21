import { Router } from "express";

import { AppError } from "../../errors/app-error.js";
import {
  readSessionTokenFromRequest,
  validateSessionToken,
} from "../auth/auth.service.js";
import { customerIdParamSchema } from "../customers/customers.schemas.js";
import {
  cancelMembershipSchema,
  createMembershipSchema,
  renewMembershipSchema,
} from "./memberships.schemas.js";
import {
  cancelMembership,
  createMembership,
  getCustomerMembership,
  renewMembership,
} from "./memberships.service.js";

export const membershipsRouter = Router({ mergeParams: true });

membershipsRouter.get("/", async (request, response, next) => {
  try {
    const token = readSessionTokenFromRequest(request);
    const session = await validateSessionToken(token);
    const customerId = customerIdParamSchema.parse((request.params as { id: string }).id);
    const result = await getCustomerMembership(session.userId, customerId);

    response.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

membershipsRouter.post("/", async (request, response, next) => {
  try {
    const token = readSessionTokenFromRequest(request);
    const session = await validateSessionToken(token);
    const customerId = customerIdParamSchema.parse((request.params as { id: string }).id);
    const input = createMembershipSchema.parse(request.body);
    const result = await createMembership(session.userId, customerId, input);

    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

membershipsRouter.post("/renew", async (request, response, next) => {
  try {
    const token = readSessionTokenFromRequest(request);
    const session = await validateSessionToken(token);
    const customerId = customerIdParamSchema.parse((request.params as { id: string }).id);
    const input = renewMembershipSchema.parse(request.body);
    const result = await renewMembership(session.userId, customerId, input);

    response.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

membershipsRouter.patch("/status", async (request, response, next) => {
  try {
    const token = readSessionTokenFromRequest(request);
    const session = await validateSessionToken(token);
    const customerId = customerIdParamSchema.parse((request.params as { id: string }).id);
    const input = cancelMembershipSchema.parse(request.body);
    const result = await cancelMembership(session.userId, customerId, input);

    response.status(200).json(result);
  } catch (error) {
    next(error);
  }
});

membershipsRouter.use((_request, _response, next) => {
  next(
    new AppError(
      405,
      "METHOD_NOT_ALLOWED",
      "Método no permitido",
    ),
  );
});
