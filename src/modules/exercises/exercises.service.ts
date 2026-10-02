import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import { discardNewMedia, lockMediaBytes, lockMediaFilename, readMedia, saveMedia } from "../media/media.service.js";
import type { CreateExerciseInput, CreateExerciseWithImageInput, UpdateExerciseInput } from "./exercises.schemas.js";

type ExerciseRow = {
  id: string;
  slug: string | null;
  name: string;
  display_name: string | null;
  display_name_es: string | null;
  provider: string | null;
  provider_item_id: string | null;
  body_parts: string[];
  target_muscles: string[];
  secondary_muscles: string[];
  equipments: string[];
  exercise_type: string | null;
  instructions: string[];
  tips: string[];
  keywords: string[];
  variations: string[];
  image_url: string | null;
  video_url: string | null;
  description: string | null;
  raw_payload: unknown;
  last_synced_at: Date | null;
  is_active: boolean;
  is_favorite: boolean;
  is_preview_hidden: boolean;
};

const columns = `id, slug, name, display_name, display_name_es, provider, provider_item_id,
  body_parts, target_muscles, secondary_muscles, equipments, exercise_type,
  instructions, tips, keywords, variations, image_url, video_url, description,
  raw_payload, last_synced_at, is_active, is_favorite, is_preview_hidden`;

function toExercise(row: ExerciseRow) {
  const localImage = /^\/api\/media\/exercises\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(row.image_url ?? "")
    ? row.image_url
    : null;
  return {
    ...row,
    id: Number(row.id),
    image_url: localImage,
    video_url: null,
    last_synced_at: row.last_synced_at?.toISOString() ?? null,
  };
}

async function requirePermission(client: PoolClient, permission: string) {
  const result = await client.query<{ permissions: string[] | null; is_owner: boolean }>(
    "SELECT public.get_current_permissions() AS permissions, public.is_owner() AS is_owner",
  );
  const auth = result.rows[0];
  if (!auth?.is_owner && !auth?.permissions?.includes(permission)) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para administrar ejercicios");
  }
}

export async function listExercises(actorUserId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await client.query<{ permissions: string[] | null; is_owner: boolean }>(
      "SELECT public.get_current_permissions() AS permissions, public.is_owner() AS is_owner",
    );
    const allowed = ["exercises.view", "routines.view", "customers.manage_routine"];
    if (!auth.rows[0]?.is_owner && !allowed.some((permission) => auth.rows[0]?.permissions?.includes(permission))) {
      throw new AppError(403, "FORBIDDEN", "No autorizado para consultar ejercicios");
    }
    const result = await client.query<ExerciseRow>(
      `SELECT ${columns} FROM public.exercises
       WHERE is_active = true
       ORDER BY display_name ASC NULLS LAST, name ASC, id ASC`,
    );
    return { data: result.rows.map(toExercise), total: result.rowCount ?? 0 };
  });
}

async function insertExerciseRow(client: PoolClient, input: CreateExerciseInput) {
  const filename = input.image_url?.split("/").at(-1);
  const baseSlug = input.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "exercise";
  const slug = `${baseSlug}-${randomBytes(4).toString("hex")}`;
  const result = await client.query<ExerciseRow>(
    `INSERT INTO public.exercises
      (slug, name, display_name, provider, exercise_type, image_url, animation_url,
       body_parts, target_muscles, secondary_muscles, equipments, instructions, keywords,
       raw_payload, last_synced_at, is_active)
     VALUES ($1, $2, $2, 'custom_local', $6, $3, $3,
             $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[],
             jsonb_build_object('source', $4::text, 'original_file_name', $5::text),
             now(), true)
     RETURNING ${columns}`,
    [slug, input.name, input.image_url ?? null, filename ? "manual_upload" : "manual_entry",
      input.original_file_name ?? null, input.exercise_type ?? "strength",
      input.body_parts ?? [], input.target_muscles ?? [], input.secondary_muscles ?? [],
      input.equipments ?? [], input.instructions ?? [], input.keywords ?? []],
  );
  return toExercise(result.rows[0]!);
}

export async function createExercise(actorUserId: string, input: CreateExerciseInput) {
  const filename = input.image_url?.split("/").at(-1);
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "exercises.create");
    if (filename) {
      await lockMediaFilename(client, "exercises", filename);
      await readMedia("exercises", filename);
    }
    return insertExerciseRow(client, input);
  });
}

export async function createExerciseWithImage(
  actorUserId: string, input: Omit<CreateExerciseWithImageInput, "image_base64">, bytes: Buffer,
) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "exercises.create");
    await lockMediaBytes(client, "exercises", bytes);
    let saved: Awaited<ReturnType<typeof saveMedia>> | undefined;
    try {
      saved = await saveMedia("exercises", bytes);
      return await insertExerciseRow(client, {
        ...input, image_url: saved.url,
      });
    } catch (error) {
      if (saved?.created) await discardNewMedia("exercises", saved.url.split("/").at(-1)!);
      throw error;
    }
  });
}

async function updateExerciseRow(client: PoolClient, id: number, input: UpdateExerciseInput) {
  const result = await client.query<ExerciseRow>(
    `UPDATE public.exercises
       SET name = COALESCE($2, name),
           display_name = COALESCE($2, display_name),
           is_favorite = COALESCE($3, is_favorite),
           is_preview_hidden = COALESCE($4, is_preview_hidden),
           image_url = COALESCE($5, image_url),
           animation_url = COALESCE($5, animation_url),
           body_parts = COALESCE($7::text[], body_parts),
           target_muscles = COALESCE($8::text[], target_muscles),
           secondary_muscles = COALESCE($9::text[], secondary_muscles),
           equipments = COALESCE($10::text[], equipments),
           exercise_type = COALESCE($11::text, exercise_type),
           instructions = COALESCE($12::text[], instructions),
           keywords = COALESCE($13::text[], keywords),
           raw_payload = CASE WHEN $5::text IS NOT NULL
             THEN COALESCE(raw_payload, '{}'::jsonb) || jsonb_build_object(
               'source', 'manual_upload', 'original_file_name', $6::text)
             ELSE raw_payload END
       WHERE id = $1
       RETURNING ${columns}`,
      [id, input.displayName ?? null, input.isFavorite ?? null, input.isPreviewHidden ?? null,
      input.imageUrl ?? null, input.originalFileName ?? null, input.body_parts ?? null,
      input.target_muscles ?? null, input.secondary_muscles ?? null, input.equipments ?? null,
      input.exercise_type ?? null, input.instructions ?? null, input.keywords ?? null],
  );
  const exercise = result.rows[0];
  if (!exercise) throw new AppError(404, "EXERCISE_NOT_FOUND", "Ejercicio no encontrado");
  if (input.displayName) {
    await client.query(
      "UPDATE public.routine_details SET exercise_name_snapshot = $2 WHERE exercise_id = $1",
      [id, input.displayName],
    );
  }
  return toExercise(exercise);
}

export async function updateExercise(actorUserId: string, id: number, input: UpdateExerciseInput) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "exercises.update");
    if (input.imageUrl) {
      const filename = input.imageUrl.split("/").at(-1)!;
      await lockMediaFilename(client, "exercises", filename);
      await readMedia("exercises", filename);
    }
    return updateExerciseRow(client, id, input);
  });
}

export async function attachExerciseImage(
  actorUserId: string, id: number, originalFileName: string | undefined, bytes: Buffer,
) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "exercises.update");
    await lockMediaBytes(client, "exercises", bytes);
    let saved: Awaited<ReturnType<typeof saveMedia>> | undefined;
    try {
      saved = await saveMedia("exercises", bytes);
      return await updateExerciseRow(client, id, {
        imageUrl: saved.url, originalFileName,
      });
    } catch (error) {
      if (saved?.created) await discardNewMedia("exercises", saved.url.split("/").at(-1)!);
      throw error;
    }
  });
}

export async function archiveStarterExercises(actorUserId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "exercises.update");
    const result = await client.query(
      "UPDATE public.exercises SET is_active = false WHERE provider = 'starter_pack' AND is_active = true",
    );
    return { archived: result.rowCount ?? 0 };
  });
}
