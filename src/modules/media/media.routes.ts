import express, { Router } from "express";
import { z } from "zod";

import { AppError } from "../../errors/app-error.js";
import { withUserTransaction } from "../../db/transaction.js";
import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { lockMediaBytes, readMedia, requireMediaReadPermission, requireMediaUploadPermission, saveMedia } from "./media.service.js";

export const mediaRouter = Router();
const mediaKindSchema = z.enum(["exercises", "products"]);

mediaRouter.post("/:kind", express.raw({ type: ["image/png", "image/jpeg", "image/webp", "image/gif"], limit: "5mb" }), async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const kind = mediaKindSchema.parse(request.params.kind);
    await requireMediaUploadPermission(session.userId, kind);
    if (!Buffer.isBuffer(request.body)) {
      throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Se requiere una imagen PNG, JPEG, WebP o GIF");
    }
    const saved = await withUserTransaction(session.userId, async (client) => {
      await lockMediaBytes(client, kind, request.body);
      return saveMedia(kind, request.body);
    });
    response.status(201).json({ url: saved.url, sha256: saved.sha256, bytes: saved.bytes });
  } catch (error) {
    next(error);
  }
});

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
