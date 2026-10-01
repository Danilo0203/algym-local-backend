import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";

export type MediaKind = "exercises" | "products";

const maxImageBytes = 5 * 1024 * 1024;
const filenamePattern = /^[a-f0-9]{64}\.(png|jpg|webp|gif)$/;

function mediaRoot() {
  return path.resolve(process.env.LOCAL_MEDIA_ROOT?.trim() || "data/media");
}

function contentTypeForExtension(extension: string) {
  switch (extension) {
    case "png": return "image/png";
    case "jpg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    default: throw new AppError(400, "INVALID_MEDIA", "Formato de imagen no permitido");
  }
}

function imageExtension(bytes: Buffer): string | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "png";
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  if (bytes.length >= 16 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    return "gif";
  }
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "webp";
  }
  return null;
}

export async function requireMediaUploadPermission(actorUserId: string, kind: MediaKind) {
  await withUserTransaction(actorUserId, async (client) => {
    const result = await client.query<{ permissions: string[] | null; is_owner: boolean }>(
      "SELECT public.get_current_permissions() AS permissions, public.is_owner() AS is_owner",
    );
    const auth = result.rows[0];
    const permissionPrefix = kind === "exercises" ? "exercises" : "products";
    if (!auth?.is_owner && !["create", "update"].some((action) => auth?.permissions?.includes(`${permissionPrefix}.${action}`))) {
      throw new AppError(403, "FORBIDDEN", "No autorizado para subir imágenes");
    }
  });
}

export async function requireMediaReadPermission(actorUserId: string, kind: MediaKind, filename: string) {
  if (!filenamePattern.test(filename)) {
    throw new AppError(400, "INVALID_MEDIA", "Nombre de archivo inválido");
  }

  const url = `/api/media/${kind}/${filename}`;
  await withUserTransaction(actorUserId, async (client) => {
    const result = await client.query<{ permissions: string[] | null; is_owner: boolean }>(
      "SELECT public.get_current_permissions() AS permissions, public.is_owner() AS is_owner",
    );
    const auth = result.rows[0];
    const allowed = kind === "exercises"
      ? ["exercises.view", "exercises.create", "exercises.update", "routines.view", "customers.manage_routine"]
      : ["products.view", "products.create", "products.update", "products.delete", "inventory.view", "inventory.adjust"];
    const canViewCatalog = Boolean(auth?.is_owner || allowed.some((permission) => auth?.permissions?.includes(permission)));

    if (!canViewCatalog) {
      if (kind !== "exercises") throw new AppError(403, "FORBIDDEN", "No autorizado para consultar esta imagen");
      const ownActiveRoutine = await client.query(
        `SELECT 1
         FROM public.exercises AS exercise
         JOIN public.routine_details AS detail ON detail.exercise_id = exercise.id
         JOIN public.routines AS routine ON routine.id = detail.routine_id
         WHERE exercise.image_url = $1
           AND routine.user_id = $2
           AND routine.status = 'active'
           AND routine.is_active = true
         LIMIT 1`,
        [url, actorUserId],
      );
      if (!ownActiveRoutine.rows[0]) {
        throw new AppError(403, "FORBIDDEN", "No autorizado para consultar esta imagen");
      }
      return;
    }

    const table = kind === "exercises" ? "public.exercises" : "public.products";
    const referenced = await client.query(`SELECT 1 FROM ${table} WHERE image_url = $1 LIMIT 1`, [url]);
    if (!referenced.rows[0]) throw new AppError(404, "MEDIA_NOT_FOUND", "Imagen no encontrada");
  });
}

export async function saveMedia(kind: MediaKind, bytes: Buffer) {
  if (bytes.length === 0 || bytes.length > maxImageBytes) {
    throw new AppError(400, "INVALID_MEDIA", "La imagen debe medir como máximo 5 MB");
  }
  const extension = imageExtension(bytes);
  if (!extension) throw new AppError(400, "INVALID_MEDIA", "Formato de imagen no permitido");

  const digest = createHash("sha256").update(bytes).digest("hex");
  const filename = `${digest}.${extension}`;
  const directory = path.join(mediaRoot(), kind);
  const destination = path.join(directory, filename);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return { url: `/api/media/${kind}/${filename}`, sha256: digest, bytes: bytes.length };
}

export async function readMedia(kind: MediaKind, filename: string) {
  if (!filenamePattern.test(filename)) {
    throw new AppError(400, "INVALID_MEDIA", "Nombre de archivo inválido");
  }
  try {
    const file = await open(path.join(mediaRoot(), kind, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stats = await file.stat();
      if (!stats.isFile() || stats.size > maxImageBytes) {
        throw new AppError(400, "INVALID_MEDIA", "Archivo local inválido");
      }
      bytes = await file.readFile();
    } finally {
      await file.close();
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== filename.slice(0, 64)) {
      throw new AppError(409, "MEDIA_CORRUPTED", "La imagen local no coincide con su hash");
    }
    if (imageExtension(bytes) !== filename.split(".")[1]) {
      throw new AppError(409, "MEDIA_CORRUPTED", "El formato de la imagen local no coincide");
    }
    return { bytes, contentType: contentTypeForExtension(filename.split(".")[1]!) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
      throw new AppError(400, "INVALID_MEDIA", "Enlace simbólico no permitido");
    }
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new AppError(404, "MEDIA_NOT_FOUND", "Imagen no encontrada");
    }
    throw error;
  }
}
