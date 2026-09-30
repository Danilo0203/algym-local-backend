import { Router } from "express";

import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { createRoleSchema, deleteRoleSchema, roleIdSchema, updateRoleSchema } from "./roles.schemas.js";
import {
  createRole,
  deleteRole,
  listPermissions,
  listRolePermissionIds,
  listRoles,
  updateRole,
} from "./roles.service.js";

export const rolesRouter = Router();

rolesRouter.get("/permissions", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await listPermissions(session.userId));
  } catch (error) { next(error); }
});

rolesRouter.get("/:id/permissions", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = roleIdSchema.parse(request.params.id);
    response.status(200).json(await listRolePermissionIds(session.userId, id));
  } catch (error) { next(error); }
});

rolesRouter.get("/", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await listRoles(session.userId));
  } catch (error) { next(error); }
});

rolesRouter.post("/", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = createRoleSchema.parse(request.body);
    response.status(201).json(await createRole(session.userId, input));
  } catch (error) { next(error); }
});

rolesRouter.patch("/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = roleIdSchema.parse(request.params.id);
    const input = updateRoleSchema.parse(request.body);
    response.status(200).json(await updateRole(session.userId, id, input));
  } catch (error) { next(error); }
});

rolesRouter.delete("/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = roleIdSchema.parse(request.params.id);
    const input = deleteRoleSchema.parse(request.body ?? {});
    await deleteRole(session.userId, id, input);
    response.status(204).end();
  } catch (error) { next(error); }
});
