import { Router } from "express";
import { z } from "zod";

import { AppError } from "../../errors/app-error.js";
import { readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { readMedia, requireMediaReadPermission } from "./media.service.js";

export const mediaRouter = Router();
const mediaKindSchema = z.enum(["exercises", "products", "avatars"]);

mediaRouter.get("/:kind/:filename", async (request, response, next) => {
  try {
    const session = await validateSessionToken(readSessionTokenFromRequest(request));
    const kind = mediaKindSchema.parse(request.params.kind);
    const filename = z.string().parse(request.params.filename);
    await requireMediaReadPermission(session.userId, kind, filename);
    const file = await readMedia(kind, filename);
    response.set("Content-Type", file.contentType);
    response.set("Cache-Control", "private, max-age=86400, immutable");
    if (file.contentType === "video/mp4") {
      response.set("Accept-Ranges", "bytes");
      const ranges = request.range(file.bytes.length, { combine: true });
      if (ranges === -1 || ranges === -2) {
        response.set("Cache-Control", "no-store");
        response.set("Content-Range", `bytes */${file.bytes.length}`);
        response.status(416).end();
        return;
      }
      if (ranges && ranges.type === "bytes" && ranges.length === 1) {
        const { start, end } = ranges[0]!;
        response.set("Content-Range", `bytes ${start}-${end}/${file.bytes.length}`);
        response.status(206).send(file.bytes.subarray(start, end + 1));
        return;
      }
    }
    response.status(200).send(file.bytes);
  } catch (error) {
    next(error);
  }
});

mediaRouter.use((_request, _response, next) => {
  next(new AppError(405, "METHOD_NOT_ALLOWED", "Método no permitido"));
});
