import { Router } from "express";

import { AppError } from "../../errors/app-error.js";
import {
  readSessionTokenFromRequest,
  validateSessionToken,
} from "../auth/auth.service.js";
import { planIdParamSchema } from "./plans.schemas.js";
import { getPlanById, listPlans } from "./plans.service.js";

export const plansRouter = Router();

plansRouter.get("/", async (request, response, next) => {
  try {
    const token = readSessionTokenFromRequest(request);
    const session = await validateSessionToken(token);
    const plans = await listPlans(session.userId);

    response.status(200).json(plans);
  } catch (error) {
    next(error);
  }
});

plansRouter.get("/:id", async (request, response, next) => {
  try {
    const token = readSessionTokenFromRequest(request);
    const session = await validateSessionToken(token);
    const planId = planIdParamSchema.parse(request.params.id);
    const plan = await getPlanById(session.userId, planId);

    response.status(200).json(plan);
  } catch (error) {
    next(error);
  }
});

plansRouter.use((_request, _response, next) => {
  next(
    new AppError(
      405,
      "METHOD_NOT_ALLOWED",
      "Método no permitido",
    ),
  );
});
