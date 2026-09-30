import { Router } from "express";

import { AppError } from "../../errors/app-error.js";
import {
  readSessionTokenFromRequest,
  validateSessionToken,
} from "../auth/auth.service.js";
import { createPlanSchema, planIdParamSchema, updatePlanSchema } from "./plans.schemas.js";
import { createPlan, deactivatePlan, getPlanById, listPlans, updatePlan } from "./plans.service.js";

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

plansRouter.post("/", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = createPlanSchema.parse(request.body);
    const plan = await createPlan(session.userId, input);
    response.status(201).json(plan);
  } catch (error) {
    next(error);
  }
});

plansRouter.put("/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const planId = planIdParamSchema.parse(request.params.id);
    const input = updatePlanSchema.parse(request.body);
    const plan = await updatePlan(session.userId, planId, input);
    response.status(200).json(plan);
  } catch (error) {
    next(error);
  }
});

plansRouter.delete("/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const planId = planIdParamSchema.parse(request.params.id);
    const plan = await deactivatePlan(session.userId, planId);
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
