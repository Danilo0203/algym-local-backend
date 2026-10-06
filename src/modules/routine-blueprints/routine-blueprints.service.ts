import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import { localAvatarUrl } from "../media/media.service.js";
import type { CreateBlueprintInput } from "./routine-blueprints.schemas.js";

type BlueprintRow = {
  id: string;
  name: string;
  primary_goal: string | null;
  secondary_goal: string | null;
  source_routine_id: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};
type DetailRow = {
  id: string;
  blueprint_id: string;
  day_of_week: number;
  exercise_id: string | null;
  exercise_order: number | null;
  block_type: "warmup" | "strength" | "accessory" | "cardio" | "mobility";
  sets: number | null;
  reps: string | null;
  rest_seconds: number | null;
  duration_minutes: number | null;
  target_rir: number | string | null;
  notes: string | null;
  exercise_name_snapshot: string | null;
  exercise_name?: string | null;
  exercise_display_name?: string | null;
  exercise_display_name_es?: string | null;
  exercise_image_url?: string | null;
};

const blueprintColumns = "id, name, primary_goal, secondary_goal, source_routine_id, created_by, created_at, updated_at";
const detailColumns = `day_of_week, exercise_id, exercise_order, block_type,
  sets, reps, rest_seconds, duration_minutes, target_rir, notes, exercise_name_snapshot`;
const imagePattern = /^\/api\/media\/exercises\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/;

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function blueprint(row: BlueprintRow) {
  return { ...row, created_at: iso(row.created_at), updated_at: iso(row.updated_at) };
}

function detail(row: DetailRow) {
  return {
    id: Number(row.id),
    blueprint_id: row.blueprint_id,
    day_of_week: row.day_of_week,
    exercise_id: row.exercise_id === null ? null : Number(row.exercise_id),
    exercise_order: row.exercise_order,
    block_type: row.block_type,
    sets: row.sets,
    reps: row.reps,
    rest_seconds: row.rest_seconds,
    duration_minutes: row.duration_minutes,
    target_rir: row.target_rir === null ? null : Number(row.target_rir),
    notes: row.notes,
    exercise_name_snapshot:
      row.exercise_display_name_es ?? row.exercise_display_name ??
      row.exercise_name ?? row.exercise_name_snapshot,
    exercise_image_url: imagePattern.test(row.exercise_image_url ?? "")
      ? row.exercise_image_url : null,
    exercise_video_url: null,
  };
}

async function requireAccess(client: PoolClient, operation: "view" | "manage"): Promise<void> {
  const result = await client.query<{ permissions: string[] | null; is_owner: boolean }>(
    "SELECT public.get_current_permissions() AS permissions, public.is_owner() AS is_owner",
  );
  const current = result.rows[0];
  const canView = current?.permissions?.includes("routines.view") ?? false;
  const canManage = current?.permissions?.includes("routines.manage_blueprints") ?? false;
  if (!current?.is_owner && (!canView || (operation === "manage" && !canManage))) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para esta operación de plantillas de rutinas");
  }
}

async function findBlueprint(client: PoolClient, id: string, lock = false) {
  const result = await client.query<BlueprintRow>(
    `SELECT ${blueprintColumns} FROM public.routine_blueprints WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, "BLUEPRINT_NOT_FOUND", "Plantilla no encontrada");
  return row;
}

export async function listBlueprints(actorUserId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireAccess(client, "view");
    const result = await client.query<BlueprintRow & {
      day_count: string;
      exercise_count: string;
      assignment_count: string;
      preview_users: Array<{ name: string | null; avatar: string | null }>;
    }>(`
      SELECT bp.*,
             COALESCE(stats.day_count, 0) AS day_count,
             COALESCE(stats.exercise_count, 0) AS exercise_count,
             COALESCE(assigned.assignment_count, 0) AS assignment_count,
             COALESCE(assigned.preview_users, '[]'::jsonb) AS preview_users
      FROM public.routine_blueprints AS bp
      LEFT JOIN LATERAL (
        SELECT count(DISTINCT day_of_week)::int AS day_count,
               count(*)::int AS exercise_count
        FROM public.routine_blueprint_details
        WHERE blueprint_id = bp.id
      ) AS stats ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS assignment_count,
               COALESCE(jsonb_agg(jsonb_build_object('name', selected.full_name,
                 'avatar', selected.avatar_url) ORDER BY selected.assigned_at DESC)
                 FILTER (WHERE selected.rank <= 4), '[]'::jsonb) AS preview_users
        FROM (
          SELECT profile.full_name, profile.avatar_url, assignment.assigned_at,
                 row_number() OVER (ORDER BY assignment.assigned_at DESC) AS rank
          FROM public.routine_blueprint_assignments AS assignment
          JOIN public.routines AS routine ON routine.id = assignment.assigned_routine_id
          JOIN public.profiles AS profile ON profile.id = assignment.user_id
          WHERE assignment.blueprint_id = bp.id AND routine.status IN ('active', 'draft')
        ) AS selected
      ) AS assigned ON true
      ORDER BY bp.created_at DESC, bp.id DESC
    `);
    return { data: result.rows.map((row) => ({
      ...blueprint(row),
      day_count: Number(row.day_count),
      exercise_count: Number(row.exercise_count),
      assignment_count: Number(row.assignment_count),
      preview_users: row.preview_users.map((user) => ({ ...user, avatar: localAvatarUrl(user.avatar) })),
    })) };
  });
}

export async function getBlueprint(actorUserId: string, id: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireAccess(client, "view");
    const record = await findBlueprint(client, id);
    const details = await client.query<DetailRow>(`
      SELECT d.*, e.name AS exercise_name, e.display_name AS exercise_display_name,
             e.display_name_es AS exercise_display_name_es, e.image_url AS exercise_image_url
      FROM public.routine_blueprint_details AS d
      LEFT JOIN public.exercises AS e ON e.id = d.exercise_id
      WHERE d.blueprint_id = $1
      ORDER BY d.day_of_week, d.exercise_order NULLS LAST, d.id
    `, [id]);
    const assignments = await client.query<{
      id: string; blueprint_id: string; user_id: string; assigned_routine_id: string;
      assigned_by: string; assigned_at: Date | string; customer_name: string | null;
      customer_avatar: string | null; routine_status: string;
    }>(`
      SELECT a.id, a.blueprint_id, a.user_id, a.assigned_routine_id,
             a.assigned_by, a.assigned_at, p.full_name AS customer_name,
             p.avatar_url AS customer_avatar, r.status AS routine_status
      FROM public.routine_blueprint_assignments AS a
      JOIN public.routines AS r ON r.id = a.assigned_routine_id
      JOIN public.profiles AS p ON p.id = a.user_id
      WHERE a.blueprint_id = $1 AND r.status IN ('active', 'draft')
      ORDER BY a.assigned_at DESC, a.id DESC
    `, [id]);
    return {
      blueprint: blueprint(record),
      details: details.rows.map(detail),
      assignments: assignments.rows.map((row) => ({
        ...row,
        customer_avatar: localAvatarUrl(row.customer_avatar),
        assigned_at: iso(row.assigned_at),
      })),
    };
  });
}

export async function createBlueprint(actorUserId: string, input: CreateBlueprintInput) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireAccess(client, "manage");
    const result = await client.query<{ id: string }>(`
      INSERT INTO public.routine_blueprints
        (name, primary_goal, secondary_goal, created_by)
      VALUES ($1, $2, $3, $4) RETURNING id
    `, [input.title, input.primary_goal, input.secondary_goal, actorUserId]);
    const blueprintId = result.rows[0]!.id;
    for (let dayIndex = 0; dayIndex < input.days.length; dayIndex++) {
      const day = input.days[dayIndex]!;
      for (let exerciseIndex = 0; exerciseIndex < day.exercises.length; exerciseIndex++) {
        const exercise = day.exercises[exerciseIndex]!;
        await client.query(`
          INSERT INTO public.routine_blueprint_details
            (blueprint_id, day_of_week, exercise_id, exercise_order,
             block_type, sets, reps, rest_seconds, duration_minutes, target_rir)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [blueprintId, dayIndex + 1, exercise.exercise_id, exerciseIndex + 1,
          exercise.block_type, exercise.sets, exercise.reps, exercise.rest_seconds,
          exercise.duration_minutes, exercise.target_rir]);
      }
    }
    return { success: true, blueprintId };
  });
}

export async function saveRoutineAsBlueprint(actorUserId: string, routineId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireAccess(client, "manage");
    const source = await client.query<{
      id: string; name: string; primary_goal: string | null; secondary_goal: string | null;
      created_by: string | null; user_id: string | null; reviewed_at: Date | null;
    }>(`
      SELECT id, name, primary_goal, secondary_goal, created_by, user_id, reviewed_at
      FROM public.routines WHERE id = $1 FOR UPDATE
    `, [routineId]);
    const routine = source.rows[0];
    if (!routine) throw new AppError(404, "ROUTINE_NOT_FOUND", "No se encontró la rutina");

    const existing = await client.query<{ id: string }>(`
      SELECT id FROM public.routine_blueprints WHERE source_routine_id = $1
      ORDER BY created_at, id LIMIT 1 FOR UPDATE
    `, [routineId]);
    let blueprintId = existing.rows[0]?.id;
    if (blueprintId) {
      await client.query(`
        UPDATE public.routine_blueprints
        SET name = $2, primary_goal = $3, secondary_goal = $4,
            created_by = $5, updated_at = now()
        WHERE id = $1
      `, [blueprintId, routine.name, routine.primary_goal, routine.secondary_goal,
        routine.created_by ?? actorUserId]);
      await client.query("DELETE FROM public.routine_blueprint_details WHERE blueprint_id = $1", [blueprintId]);
    } else {
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO public.routine_blueprints
          (name, primary_goal, secondary_goal, source_routine_id, created_by, created_at)
        VALUES ($1,$2,$3,$4,$5,COALESCE($6,now())) RETURNING id
      `, [routine.name, routine.primary_goal, routine.secondary_goal, routineId,
        routine.created_by ?? actorUserId, routine.reviewed_at]);
      blueprintId = inserted.rows[0]!.id;
    }

    await client.query(`
      INSERT INTO public.routine_blueprint_details
        (blueprint_id, ${detailColumns})
      SELECT $1, ${detailColumns}
      FROM public.routine_details WHERE routine_id = $2
      ORDER BY day_of_week, exercise_order NULLS LAST, id
    `, [blueprintId, routineId]);
    return { success: true, blueprintId };
  });
}

export async function renameBlueprint(actorUserId: string, id: string, name: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireAccess(client, "manage");
    const result = await client.query(`
      UPDATE public.routine_blueprints SET name = $2, updated_at = now()
      WHERE id = $1 RETURNING id
    `, [id, name]);
    if (!result.rowCount) throw new AppError(404, "BLUEPRINT_NOT_FOUND", "Plantilla no encontrada");
    return { success: true };
  });
}

export async function assignBlueprint(actorUserId: string, id: string, customerId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireAccess(client, "manage");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [customerId]);
    const source = await findBlueprint(client, id, true);
    const customer = await client.query(`
      SELECT id FROM public.profiles WHERE id = $1 AND role = 'client' AND is_active = true
    `, [customerId]);
    if (!customer.rowCount) throw new AppError(404, "CUSTOMER_NOT_FOUND", "Cliente activo no encontrado");

    await client.query(`
      UPDATE public.routines SET status = 'archived', is_active = false
      WHERE user_id = $1 AND status IN ('active', 'pending_profile', 'draft')
    `, [customerId]);
    const created = await client.query<{ id: string }>(`
      INSERT INTO public.routines
        (user_id, created_by, name, is_active, goal, status, source,
         primary_goal, secondary_goal, generation_version, reviewed_by, reviewed_at)
      VALUES ($1,$2,$3,true,$4,'active','admin',$5,$6,'blueprint_v1',$2,now())
      RETURNING id
    `, [customerId, actorUserId, source.name,
      source.primary_goal ?? "Personalizada", source.primary_goal, source.secondary_goal]);
    const routineId = created.rows[0]!.id;
    await client.query(`
      INSERT INTO public.routine_details (routine_id, ${detailColumns})
      SELECT $1, ${detailColumns}
      FROM public.routine_blueprint_details WHERE blueprint_id = $2
      ORDER BY day_of_week, exercise_order NULLS LAST, id
    `, [routineId, id]);
    await client.query(`
      INSERT INTO public.routine_blueprint_assignments
        (blueprint_id, user_id, assigned_routine_id, assigned_by)
      VALUES ($1,$2,$3,$4)
    `, [id, customerId, routineId, actorUserId]);
    return { success: true, routineId };
  });
}

export async function unassignBlueprint(actorUserId: string, id: string, customerId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireAccess(client, "manage");
    await findBlueprint(client, id);
    await client.query(`
      DELETE FROM public.routine_blueprint_assignments
      WHERE blueprint_id = $1 AND user_id = $2
    `, [id, customerId]);
    return { success: true };
  });
}

export async function searchActiveClients(actorUserId: string, query: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requireAccess(client, "manage");
    const escaped = query.replace(/[\\%_]/g, "\\$&");
    const result = await client.query<{
      id: string; full_name: string | null; avatar_url: string | null;
    }>(`
      SELECT id, full_name, avatar_url FROM public.profiles
      WHERE role = 'client' AND is_active = true
        AND full_name ILIKE $1 ESCAPE '\\'
      ORDER BY full_name ASC NULLS LAST, id ASC LIMIT 20
    `, [`%${escaped}%`]);
    return { data: result.rows.map((row) => ({
      ...row,
      avatar_url: localAvatarUrl(row.avatar_url),
      full_name: row.full_name ?? "Sin nombre",
    })) };
  });
}
