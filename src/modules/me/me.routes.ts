import { Router } from "express";

import { AppError } from "../../errors/app-error.js";
import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { getOwnMembershipData, getOwnProfileData, getOwnRoutineData } from "./me.service.js";

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

meRouter.use((_request, _response, next) => {
  next(new AppError(405, "METHOD_NOT_ALLOWED", "Método no permitido"));
});
