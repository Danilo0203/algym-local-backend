import { randomBytes } from "node:crypto";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import { readMedia } from "../media/media.service.js";
import type { CreateExerciseInput, UpdateExerciseInput } from "./exercises.schemas.js";

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
  equipments: string[];
  image_url: string | null;
  is_active: boolean;
  is_favorite: boolean;
  is_preview_hidden: boolean;
};

const columns = "id, slug, name, display_name, display_name_es, provider, provider_item_id, body_parts, target_muscles, equipments, image_url, is_active, is_favorite, is_preview_hidden";

function toExercise(row: ExerciseRow) {
  return { ...row, id: Number(row.id) };
}

async function requirePermission(
  client: import("pg").PoolClient,
  permission: string,
) {
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
    await requirePermission(client, "exercises.view");
    const result = await client.query<ExerciseRow>(
      `SELECT ${columns} FROM public.exercises
       WHERE is_active = true
       ORDER BY display_name ASC NULLS LAST, name ASC, id ASC`,
    );
    return { data: result.rows.map(toExercise), total: result.rowCount ?? 0 };
  });
}

export async function createExercise(actorUserId: string, input: CreateExerciseInput) {
  const filename = input.image_url.split("/").at(-1)!;
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "exercises.create");
    await readMedia("exercises", filename);
    const baseSlug = input.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "exercise";
    const slug = `${baseSlug}-${randomBytes(4).toString("hex")}`;
    const result = await client.query<ExerciseRow>(
      `INSERT INTO public.exercises
        (slug, name, display_name, provider, exercise_type, image_url, animation_url,
         raw_payload, last_synced_at, is_active)
       VALUES ($1, $2, $2, 'custom_local', 'custom', $3, $3,
               jsonb_build_object('source', 'manual_upload', 'original_file_name', $4::text),
               now(), true)
       RETURNING ${columns}`,
      [slug, input.name, input.image_url, input.original_file_name ?? null],
    );
    return toExercise(result.rows[0]!);
  });
}

export async function updateExercise(actorUserId: string, id: number, input: UpdateExerciseInput) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "exercises.update");
    const result = await client.query<ExerciseRow>(
      `UPDATE public.exercises
       SET name = COALESCE($2, name),
           display_name = COALESCE($2, display_name),
           is_favorite = COALESCE($3, is_favorite),
           is_preview_hidden = COALESCE($4, is_preview_hidden)
       WHERE id = $1
       RETURNING ${columns}`,
      [id, input.displayName ?? null, input.isFavorite ?? null, input.isPreviewHidden ?? null],
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
