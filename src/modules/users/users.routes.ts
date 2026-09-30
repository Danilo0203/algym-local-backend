import { Router } from "express";

import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { createUserSchema, updateUserSchema, userIdParamSchema } from "./users.schemas.js";
import {
  createInternalUser,
  deleteInternalUser,
  listInternalRoles,
  listInternalUsers,
  updateInternalUser,
} from "./users.service.js";

export const usersRouter = Router();

usersRouter.get("/roles", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await listInternalRoles(session.userId));
  } catch (error) { next(error); }
});

usersRouter.get("/", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await listInternalUsers(session.userId));
  } catch (error) { next(error); }
});

usersRouter.post("/", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = createUserSchema.parse(request.body);
    response.status(201).json(await createInternalUser(session.userId, input));
  } catch (error) { next(error); }
});

usersRouter.patch("/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const userId = userIdParamSchema.parse(request.params.id);
    const input = updateUserSchema.parse(request.body);
    response.status(200).json(await updateInternalUser(session.userId, userId, input));
  } catch (error) { next(error); }
});

usersRouter.delete("/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const userId = userIdParamSchema.parse(request.params.id);
    await deleteInternalUser(session.userId, userId);
    response.status(204).end();
  } catch (error) { next(error); }
});
