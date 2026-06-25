import { Router } from "express";

import { AppError } from "../../errors/app-error.js";
import {
  readSessionTokenFromRequest,
  validateSessionToken,
} from "../auth/auth.service.js";
import {
  getProfile,
  updateProfile,
} from "./profile.service.js";

export const profileRouter = Router();

profileRouter.get("/", async (request, response, next) => {
  try {
    const token = readSessionTokenFromRequest(request);
    const session = await validateSessionToken(token);
    const profile = await getProfile(session.userId);

    response.status(200).json(profile);
  } catch (error) {
    next(error);
  }
});

profileRouter.patch("/", async (request, response, next) => {
  try {
    const token = readSessionTokenFromRequest(request);
    const session = await validateSessionToken(token);
    const profile = await updateProfile(
      session.userId,
      request.body,
    );

    response.status(200).json(profile);
  } catch (error) {
    next(error);
  }
});

profileRouter.use((_request, _response, next) => {
  next(
    new AppError(
      405,
      "METHOD_NOT_ALLOWED",
      "Método no permitido",
    ),
  );
});
