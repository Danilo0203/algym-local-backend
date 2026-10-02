import { Router } from "express";

import { AppError } from "../../errors/app-error.js";
import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { attachExerciseImageSchema, createExerciseSchema, createExerciseWithImageSchema, decodeExerciseImage, exerciseIdSchema, updateExerciseSchema } from "./exercises.schemas.js";
import { archiveStarterExercises, attachExerciseImage, createExercise, createExerciseWithImage, listExercises, updateExercise } from "./exercises.service.js";

export const exercisesRouter = Router();

exercisesRouter.get("/", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await listExercises(session.userId));
  } catch (error) { next(error); }
});

exercisesRouter.post("/", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const input = createExerciseSchema.parse(request.body);
    response.status(201).json(await createExercise(session.userId, input));
  } catch (error) { next(error); }
});

exercisesRouter.post("/with-image", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const { image_base64, ...input } = createExerciseWithImageSchema.parse(request.body);
    response.status(201).json(await createExerciseWithImage(
      session.userId, input, decodeExerciseImage(image_base64),
    ));
  } catch (error) { next(error); }
});

exercisesRouter.post("/image-attachment", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const { exercise_id, image_base64, original_file_name } = attachExerciseImageSchema.parse(request.body);
    response.status(200).json(await attachExerciseImage(
      session.userId, exercise_id, original_file_name, decodeExerciseImage(image_base64),
    ));
  } catch (error) { next(error); }
});

exercisesRouter.post("/archive-starter", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    response.status(200).json(await archiveStarterExercises(session.userId));
  } catch (error) { next(error); }
});

exercisesRouter.patch("/:id", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const id = exerciseIdSchema.parse(request.params.id);
    const input = updateExerciseSchema.parse(request.body);
    response.status(200).json(await updateExercise(session.userId, id, input));
  } catch (error) { next(error); }
});

exercisesRouter.use((_request, _response, next) => {
  next(new AppError(405, "METHOD_NOT_ALLOWED", "Método no permitido"));
});
