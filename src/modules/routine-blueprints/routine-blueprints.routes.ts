import { Router } from "express";

import { AppError } from "../../errors/app-error.js";
import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import {
  assignBlueprintSchema,
  blueprintCustomerIdSchema,
  blueprintIdSchema,
  blueprintRoutineIdSchema,
  createBlueprintSchema,
  renameBlueprintSchema,
  searchClientsSchema,
} from "./routine-blueprints.schemas.js";
import {
  assignBlueprint,
  createBlueprint,
  getBlueprint,
  listBlueprints,
  renameBlueprint,
  saveRoutineAsBlueprint,
  searchActiveClients,
  unassignBlueprint,
} from "./routine-blueprints.service.js";

export const routineBlueprintsRouter = Router();

routineBlueprintsRouter.get("/", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await listBlueprints(session.userId));
  } catch (error) { next(error); }
});

routineBlueprintsRouter.get("/clients", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const { query } = searchClientsSchema.parse(request.query);
    response.status(200).json(await searchActiveClients(session.userId, query));
  } catch (error) { next(error); }
});

routineBlueprintsRouter.post("/", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = createBlueprintSchema.parse(request.body);
    response.status(201).json(await createBlueprint(session.userId, input));
  } catch (error) { next(error); }
});

routineBlueprintsRouter.post("/from-routine/:routineId", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const routineId = blueprintRoutineIdSchema.parse(request.params.routineId);
    response.status(201).json(await saveRoutineAsBlueprint(session.userId, routineId));
  } catch (error) { next(error); }
});

routineBlueprintsRouter.get("/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = blueprintIdSchema.parse(request.params.id);
    response.status(200).json(await getBlueprint(session.userId, id));
  } catch (error) { next(error); }
});

routineBlueprintsRouter.patch("/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = blueprintIdSchema.parse(request.params.id);
    const { name } = renameBlueprintSchema.parse(request.body);
    response.status(200).json(await renameBlueprint(session.userId, id, name));
  } catch (error) { next(error); }
});

routineBlueprintsRouter.post("/:id/assign", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = blueprintIdSchema.parse(request.params.id);
    const { userId } = assignBlueprintSchema.parse(request.body);
    response.status(201).json(await assignBlueprint(session.userId, id, userId));
  } catch (error) { next(error); }
});

routineBlueprintsRouter.delete("/:id/assign/:userId", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = blueprintIdSchema.parse(request.params.id);
    const userId = blueprintCustomerIdSchema.parse(request.params.userId);
    response.status(200).json(await unassignBlueprint(session.userId, id, userId));
  } catch (error) { next(error); }
});

routineBlueprintsRouter.use((_request, _response, next) => {
  next(new AppError(405, "METHOD_NOT_ALLOWED", "Método no permitido"));
});
