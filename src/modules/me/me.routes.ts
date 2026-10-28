import { Router } from "express";
import { z } from "zod";

import { AppError } from "../../errors/app-error.js";
import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { getOwnMembershipData, getOwnProfileData, getOwnRoutineData } from "./me.service.js";
import { resetOwnRoutineDay, setOwnExerciseCompletion } from "./routine-progress.service.js";

export const meRouter = Router();

meRouter.get("/profile", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await getOwnProfileData(session.userId));
  } catch (error) {
    next(error);
  }
});

meRouter.get("/membership", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await getOwnMembershipData(session.userId));
  } catch (error) {
    next(error);
  }
});

meRouter.get("/routine", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await getOwnRoutineData(session.userId));
  } catch (error) {
    next(error);
  }
});

meRouter.put("/routine/:routineId/details/:detailId/completion", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const routineId = z.uuid().parse(request.params.routineId);
    const detailId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(request.params.detailId);
    const { completed } = z.object({ completed: z.boolean() }).strict().parse(request.body);
    response.status(200).json(await setOwnExerciseCompletion(session.userId, routineId, detailId, completed));
  } catch (error) {
    next(error);
  }
});

meRouter.delete("/routine/:routineId/days/:day/completion", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const routineId = z.uuid().parse(request.params.routineId);
    const day = z.coerce.number().int().min(1).max(7).parse(request.params.day);
    response.status(200).json(await resetOwnRoutineDay(session.userId, routineId, day));
  } catch (error) {
    next(error);
  }
});

meRouter.use((_request, _response, next) => {
  next(new AppError(405, "METHOD_NOT_ALLOWED", "Método no permitido"));
});
