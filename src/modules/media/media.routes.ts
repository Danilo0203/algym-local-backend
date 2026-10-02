import { Router } from "express";
import { z } from "zod";

import { AppError } from "../../errors/app-error.js";
import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { readMedia, requireMediaReadPermission } from "./media.service.js";

export const mediaRouter = Router();
const mediaKindSchema = z.enum(["exercises", "products"]);

mediaRouter.get("/:kind/:filename", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const kind = mediaKindSchema.parse(request.params.kind);
    const filename = z.string().parse(request.params.filename);
    await requireMediaReadPermission(session.userId, kind, filename);
    const file = await readMedia(kind, filename);
    response.set("Content-Type", file.contentType);
    response.set("Cache-Control", "private, max-age=86400, immutable");
    response.status(200).send(file.bytes);
  } catch (error) {
    next(error);
  }
});

mediaRouter.use((_request, _response, next) => {
  next(new AppError(405, "METHOD_NOT_ALLOWED", "Método no permitido"));
});
