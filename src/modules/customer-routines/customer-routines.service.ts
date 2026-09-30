import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import type {
  CreateCustomerRoutineInput,
  CreateRoutineDetailInput,
  CustomerRoutineMutationResponse,
  CustomerRoutineWorkspaceResponse,
  RoutineDetailRecord,
  RoutineDetailMutationResponse,
  RoutineRecord,
  TrainingProfileRecord,
  UpdateCustomerRoutineInput,
  UpdateRoutineDetailInput,
} from "./customer-routines.types.js";

const manageRoutinePermission = "customers.manage_routine";

type AuthorizationRow = { permissions: string[] | null; is_owner: boolean };
type CustomerNutritionRow = {
  birth_date: string | null;
  gender: "male" | "female" | "other" | null;
  weight_kg: string | number | null;
  height_cm: string | number | null;
  body_type: string | null;
  diet_type: string | null;
  activity_level: string | null;
};
type TrainingProfileRow = Omit<TrainingProfileRecord, "created_at" | "updated_at"> & {
  created_at: Date | string;
  updated_at: Date | string;
};
type RoutineRow = Omit<RoutineRecord, "reviewed_at"> & {
  reviewed_at: Date | string | null;
};
type RoutineDetailRow = Omit<RoutineDetailRecord, "target_rir"> & {
  target_rir: string | number | null;
  exercise_name: string | null;
  exercise_display_name: string | null;
  exercise_display_name_es: string | null;
  exercise_image_url: string | null;
  exercise_video_url: string | null;
};

const forbiddenError = new AppError(
  403,
  "FORBIDDEN",
  "No autorizado para consultar la rutina del cliente",
);
const customerNotFoundError = new AppError(
  404,
  "CUSTOMER_NOT_FOUND",
  "Cliente no encontrado",
);
const routineNotFoundError = new AppError(
  404,
  "ROUTINE_NOT_FOUND",
  "Rutina no encontrada",
);
const routineDetailNotFoundError = new AppError(
  404,
  "ROUTINE_DETAIL_NOT_FOUND",
  "Detalle de rutina no encontrado",
);
const routineWriteForbiddenError = new AppError(
  403,
  "FORBIDDEN",
  "No autorizado para administrar la rutina del cliente",
);

function toNumber(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

async function assertAccess(client: PoolClient): Promise<void> {
  const auth = await getAuthorization(client);
  if (hasManageRoutineAccess(auth)) return;
  throw forbiddenError;
}

async function getAuthorization(client: PoolClient): Promise<AuthorizationRow> {
  const result = await client.query<AuthorizationRow>(`
    SELECT public.get_current_permissions() AS permissions,
           public.is_owner() AS is_owner
  `);
  return result.rows[0] ?? { permissions: [], is_owner: false };
}

function hasManageRoutineAccess(auth: AuthorizationRow): boolean {
  return auth.is_owner || (auth.permissions ?? []).includes(manageRoutinePermission);
}

function mapRoutineRow(row: RoutineRow): RoutineRecord {
  return {
    ...row,
    reviewed_at: row.reviewed_at ? toIso(row.reviewed_at) : null,
  };
}

function mapRoutineDetailRow(row: RoutineDetailRow): RoutineDetailRecord {
  return {
    id: Number(row.id),
    routine_id: row.routine_id,
    day_of_week: row.day_of_week,
    exercise_id: row.exercise_id === null ? null : Number(row.exercise_id),
    exercise_order: row.exercise_order,
    block_type: row.block_type,
    sets: row.sets,
    reps: row.reps,
    rest_seconds: row.rest_seconds,
    duration_minutes: row.duration_minutes,
    target_rir: toNumber(row.target_rir),
    notes: row.notes,
    exercise_name_snapshot:
      row.exercise_display_name_es ??
      row.exercise_display_name ??
      row.exercise_name ??
      row.exercise_name_snapshot,
    exercise_image_url: row.exercise_image_url,
    exercise_video_url: row.exercise_video_url,
  };
}

function getMissingRequirements(
  profile: TrainingProfileRecord | null,
  nutrition: CustomerRoutineWorkspaceResponse["nutritionContext"],
): string[] {
  const missing: string[] = [];
  if (!nutrition.birthDate) missing.push("Fecha de nacimiento");
  if (!nutrition.gender) missing.push("Género");
  if (!nutrition.weightKg) missing.push("Peso");
  if (!nutrition.heightCm) missing.push("Estatura");
  if (!profile?.primary_goal) missing.push("Objetivo principal");
  if (profile?.parq_requires_attention === null || profile?.parq_requires_attention === undefined) {
    missing.push("Screening PAR-Q");
  }
  if (profile?.parq_requires_attention === true && !profile.injuries_or_pain?.trim()) {
    missing.push("Motivo de la atención especial");
  }
  if (!profile?.experience_level) missing.push("Nivel de experiencia");
  if (!profile?.days_per_week) missing.push("Días por semana");
  if (!profile?.session_minutes) missing.push("Duración por sesión");
  if (!profile?.activity_level) missing.push("Nivel de actividad");
  if (!profile?.cardio_preference) missing.push("Preferencia de cardio");
  if (
    profile?.training_location &&
    profile.training_location !== "gym" &&
    profile.equipment_available.length === 0
  ) {
    missing.push("Equipo disponible");
  }
  return missing;
}

export async function getCustomerRoutineWorkspace(
  actorUserId: string,
  customerId: string,
): Promise<CustomerRoutineWorkspaceResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    await assertAccess(client);

    const customerResult = await client.query<CustomerNutritionRow>(
      `
        SELECT
          to_char(profiles.birth_date, 'YYYY-MM-DD') AS birth_date,
          profiles.gender::text AS gender,
          assessment.weight_kg,
          assessment.height_cm,
          assessment.body_type,
          assessment.diet_type,
          assessment.activity_level
        FROM public.profiles
        LEFT JOIN LATERAL (
          SELECT weight_kg, height_cm, body_type, diet_type, activity_level
          FROM public.body_assessments
          WHERE user_id = profiles.id
          ORDER BY date DESC, id DESC
          LIMIT 1
        ) AS assessment ON true
        WHERE profiles.id = $1
          AND profiles.role = 'client'
        LIMIT 1
      `,
      [customerId],
    );
    const nutritionRow = customerResult.rows[0];
    if (!nutritionRow) throw customerNotFoundError;

    const trainingProfileResult = await client.query<TrainingProfileRow>(
      `SELECT * FROM public.training_profiles WHERE user_id = $1 LIMIT 1`,
      [customerId],
    );
    const trainingRow = trainingProfileResult.rows[0];
    const trainingProfile: TrainingProfileRecord | null = trainingRow
      ? {
          ...trainingRow,
          created_at: toIso(trainingRow.created_at),
          updated_at: toIso(trainingRow.updated_at),
        }
      : null;
    const nutritionContext: CustomerRoutineWorkspaceResponse["nutritionContext"] = {
      birthDate: nutritionRow.birth_date,
      gender: nutritionRow.gender,
      weightKg: toNumber(nutritionRow.weight_kg),
      heightCm: toNumber(nutritionRow.height_cm),
      bodyType: nutritionRow.body_type,
      dietType: nutritionRow.diet_type,
      activityLevel: nutritionRow.activity_level,
    };

    const routinesResult = await client.query<RoutineRow>(
      `
        SELECT
          id, user_id, created_by, name,
          to_char(start_date, 'YYYY-MM-DD') AS start_date,
          to_char(end_date, 'YYYY-MM-DD') AS end_date,
          is_active, goal, status, source, training_profile_id,
          primary_goal, secondary_goal, generation_version,
          reviewed_by, reviewed_at
        FROM public.routines
        WHERE user_id = $1
        ORDER BY reviewed_at DESC NULLS LAST,
                 start_date DESC NULLS LAST,
                 id DESC
      `,
      [customerId],
    );
    const routines: RoutineRecord[] = routinesResult.rows.map(mapRoutineRow);
    const draftRoutine = routines.find((routine) => routine.status === "draft") ?? null;
    const activeRoutine = routines.find((routine) => routine.status === "active") ?? null;
    const pendingRoutine = routines.find((routine) => routine.status === "pending_profile") ?? null;
    const routineIds = [draftRoutine?.id, activeRoutine?.id, pendingRoutine?.id].filter(
      (id): id is string => Boolean(id),
    );
    const detailsByRoutine = new Map<string, RoutineDetailRecord[]>();

    if (routineIds.length > 0) {
      const detailsResult = await client.query<RoutineDetailRow>(
        `
          SELECT
            details.id, details.routine_id, details.day_of_week,
            details.exercise_id, details.exercise_order, details.block_type,
            details.sets, details.reps, details.rest_seconds,
            details.duration_minutes, details.target_rir, details.notes,
            details.exercise_name_snapshot,
            exercises.name AS exercise_name,
            exercises.display_name AS exercise_display_name,
            exercises.display_name_es AS exercise_display_name_es,
            exercises.image_url AS exercise_image_url,
            exercises.video_url AS exercise_video_url
          FROM public.routine_details AS details
          LEFT JOIN public.exercises ON exercises.id = details.exercise_id
          WHERE details.routine_id = ANY($1::uuid[])
          ORDER BY details.day_of_week, details.exercise_order, details.id
        `,
        [routineIds],
      );

      for (const row of detailsResult.rows) {
        const mapped = mapRoutineDetailRow(row);
        const current = detailsByRoutine.get(mapped.routine_id) ?? [];
        current.push(mapped);
        detailsByRoutine.set(mapped.routine_id, current);
      }
    }

    return {
      trainingProfile,
      nutritionContext,
      trainingProfileStatus: trainingProfile?.is_complete ? "complete" : "pending",
      missingRequirements: getMissingRequirements(trainingProfile, nutritionContext),
      draftRoutine,
      activeRoutine,
      pendingRoutine,
      draftDetails: draftRoutine ? detailsByRoutine.get(draftRoutine.id) ?? [] : [],
      activeDetails: activeRoutine ? detailsByRoutine.get(activeRoutine.id) ?? [] : [],
      pendingDetails: pendingRoutine ? detailsByRoutine.get(pendingRoutine.id) ?? [] : [],
    };
  });
}

async function assertCustomerExists(
  client: PoolClient,
  customerId: string,
): Promise<void> {
  const result = await client.query(
    `SELECT id FROM public.profiles WHERE id = $1 AND role = 'client' LIMIT 1`,
    [customerId],
  );
  if (!result.rows[0]) throw customerNotFoundError;
}

async function lockCustomerRoutines(
  client: PoolClient,
  customerId: string,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
    [customerId],
  );
}

async function assertTrainingProfileBelongsToCustomer(
  client: PoolClient,
  customerId: string,
  trainingProfileId: string | null | undefined,
): Promise<void> {
  if (!trainingProfileId) return;
  const result = await client.query(
    `SELECT id FROM public.training_profiles WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [trainingProfileId, customerId],
  );
  if (!result.rows[0]) {
    throw new AppError(
      404,
      "TRAINING_PROFILE_NOT_FOUND",
      "Perfil de entrenamiento no encontrado para el cliente",
    );
  }
}

async function archiveCurrentCustomerRoutines(
  client: PoolClient,
  customerId: string,
  exceptRoutineId?: string,
): Promise<void> {
  await client.query(
    `
      UPDATE public.routines
      SET status = 'archived', is_active = false
      WHERE user_id = $1
        AND status IN ('active', 'pending_profile')
        AND ($2::uuid IS NULL OR id <> $2::uuid)
    `,
    [customerId, exceptRoutineId ?? null],
  );
}

const routineSelectSql = `
  SELECT
    id, user_id, created_by, name,
    to_char(start_date, 'YYYY-MM-DD') AS start_date,
    to_char(end_date, 'YYYY-MM-DD') AS end_date,
    is_active, goal, status, source, training_profile_id,
    primary_goal, secondary_goal, generation_version,
    reviewed_by, reviewed_at
  FROM public.routines
`;

async function findCustomerRoutine(
  client: PoolClient,
  customerId: string,
  routineId: string,
): Promise<RoutineRecord | null> {
  const result = await client.query<RoutineRow>(
    `${routineSelectSql} WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [routineId, customerId],
  );
  return result.rows[0] ? mapRoutineRow(result.rows[0]) : null;
}

async function getCustomerRoutineForManager(
  client: PoolClient,
  customerId: string,
  routineId: string,
): Promise<RoutineRecord> {
  const routine = await findCustomerRoutine(client, customerId, routineId);
  if (!routine) throw routineNotFoundError;
  return routine;
}

function assertEditableRoutine(routine: RoutineRecord): void {
  if (routine.status === "draft" || routine.status === "active") return;
  throw new AppError(
    409,
    "ROUTINE_NOT_EDITABLE",
    "Solo se pueden editar detalles de una rutina en borrador o activa",
  );
}

function assertRoutineDateRange(
  startDate: string | null,
  endDate: string | null,
): void {
  if (!startDate || !endDate || endDate >= startDate) return;
  throw new AppError(
    422,
    "INVALID_ROUTINE_DATES",
    "La fecha final no puede ser anterior a la inicial",
  );
}

async function resolveExerciseSnapshot(
  client: PoolClient,
  exerciseId: number | null | undefined,
): Promise<string | null> {
  if (!exerciseId) return null;
  const result = await client.query<{
    name: string;
    display_name: string | null;
    display_name_es: string | null;
  }>(
    `SELECT name, display_name, display_name_es FROM public.exercises WHERE id = $1 LIMIT 1`,
    [exerciseId],
  );
  const exercise = result.rows[0];
  if (!exercise) {
    throw new AppError(404, "EXERCISE_NOT_FOUND", "Ejercicio no encontrado");
  }
  return exercise.display_name_es ?? exercise.display_name ?? exercise.name;
}

const routineDetailSelectSql = `
  SELECT
    details.id, details.routine_id, details.day_of_week,
    details.exercise_id, details.exercise_order, details.block_type,
    details.sets, details.reps, details.rest_seconds,
    details.duration_minutes, details.target_rir, details.notes,
    details.exercise_name_snapshot,
    exercises.name AS exercise_name,
    exercises.display_name AS exercise_display_name,
    exercises.display_name_es AS exercise_display_name_es,
    exercises.image_url AS exercise_image_url,
    exercises.video_url AS exercise_video_url
  FROM public.routine_details AS details
  LEFT JOIN public.exercises ON exercises.id = details.exercise_id
`;

async function getRoutineDetail(
  client: PoolClient,
  routineId: string,
  detailId: number,
): Promise<RoutineDetailRecord> {
  const result = await client.query<RoutineDetailRow>(
    `${routineDetailSelectSql} WHERE details.id = $1 AND details.routine_id = $2 LIMIT 1`,
    [detailId, routineId],
  );
  if (!result.rows[0]) throw routineDetailNotFoundError;
  return mapRoutineDetailRow(result.rows[0]);
}

export async function createCustomerRoutine(
  actorUserId: string,
  customerId: string,
  input: CreateCustomerRoutineInput,
): Promise<CustomerRoutineMutationResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getAuthorization(client);
    if (!hasManageRoutineAccess(auth)) throw routineWriteForbiddenError;

    await assertCustomerExists(client, customerId);
    await lockCustomerRoutines(client, customerId);
    await assertTrainingProfileBelongsToCustomer(
      client,
      customerId,
      input.training_profile_id,
    );

    const status = input.status ?? "draft";
    const source = input.source ?? "admin";
    if (status === "active") {
      await archiveCurrentCustomerRoutines(client, customerId);
    }

    const result = await client.query<RoutineRow>(
      `
        INSERT INTO public.routines (
          user_id, created_by, name, start_date, end_date, is_active,
          goal, status, source, training_profile_id, primary_goal,
          secondary_goal, generation_version, reviewed_by, reviewed_at
        ) VALUES (
          $1::uuid, $2::uuid, $3::text,
          COALESCE($4::date, CURRENT_DATE), $5::date, $6::boolean,
          $7::text, $8::text, $9::text, $10::uuid, $11::text, $12::text,
          $13::text,
          CASE
            WHEN $8::text = 'active' THEN $2::uuid
            ELSE NULL::uuid
          END,
          CASE
            WHEN $8::text = 'active' THEN now()
            ELSE NULL::timestamptz
          END
        )
        RETURNING
          id, user_id, created_by, name,
          to_char(start_date, 'YYYY-MM-DD') AS start_date,
          to_char(end_date, 'YYYY-MM-DD') AS end_date,
          is_active, goal, status, source, training_profile_id,
          primary_goal, secondary_goal, generation_version,
          reviewed_by, reviewed_at
      `,
      [
        customerId,
        actorUserId,
        input.name,
        input.start_date ?? null,
        input.end_date ?? null,
        status === "active",
        input.goal ?? null,
        status,
        source,
        input.training_profile_id ?? null,
        input.primary_goal ?? null,
        input.secondary_goal ?? null,
        input.generation_version ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Routine insert did not return a row");

    return { customer_id: customerId, routine: mapRoutineRow(row) };
  });
}

export async function updateCustomerRoutine(
  actorUserId: string,
  customerId: string,
  routineId: string,
  input: UpdateCustomerRoutineInput,
): Promise<CustomerRoutineMutationResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getAuthorization(client);
    const canManage = hasManageRoutineAccess(auth);
    const current = await findCustomerRoutine(client, customerId, routineId);

    if (!current) {
      if (!canManage) throw routineWriteForbiddenError;
      await assertCustomerExists(client, customerId);
      throw routineNotFoundError;
    }
    if (!canManage && current.created_by !== actorUserId) {
      throw routineWriteForbiddenError;
    }

    await lockCustomerRoutines(client, customerId);
    const trainingProfileId =
      input.training_profile_id === undefined
        ? current.training_profile_id
        : input.training_profile_id;
    await assertTrainingProfileBelongsToCustomer(
      client,
      customerId,
      trainingProfileId,
    );

    const status = input.status ?? current.status;
    const startDate =
      input.start_date === undefined ? current.start_date : input.start_date;
    const endDate = input.end_date === undefined ? current.end_date : input.end_date;
    assertRoutineDateRange(startDate, endDate);

    const activatesRoutine = status === "active" && current.status !== "active";
    if (activatesRoutine) {
      await archiveCurrentCustomerRoutines(client, customerId, routineId);
    }

    const result = await client.query<RoutineRow>(
      `
        UPDATE public.routines
        SET name = $3,
            start_date = $4::date,
            end_date = $5::date,
            is_active = $6,
            goal = $7,
            status = $8,
            source = $9,
            training_profile_id = $10,
            primary_goal = $11,
            secondary_goal = $12,
            generation_version = $13,
            reviewed_by = CASE WHEN $14 THEN $15::uuid ELSE reviewed_by END,
            reviewed_at = CASE WHEN $14 THEN now() ELSE reviewed_at END
        WHERE id = $1 AND user_id = $2
        RETURNING
          id, user_id, created_by, name,
          to_char(start_date, 'YYYY-MM-DD') AS start_date,
          to_char(end_date, 'YYYY-MM-DD') AS end_date,
          is_active, goal, status, source, training_profile_id,
          primary_goal, secondary_goal, generation_version,
          reviewed_by, reviewed_at
      `,
      [
        routineId,
        customerId,
        input.name ?? current.name,
        startDate,
        endDate,
        status === "active",
        input.goal === undefined ? current.goal : input.goal,
        status,
        input.source ?? current.source,
        trainingProfileId,
        input.primary_goal === undefined ? current.primary_goal : input.primary_goal,
        input.secondary_goal === undefined ? current.secondary_goal : input.secondary_goal,
        input.generation_version === undefined
          ? current.generation_version
          : input.generation_version,
        activatesRoutine,
        actorUserId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw routineNotFoundError;

    return { customer_id: customerId, routine: mapRoutineRow(row) };
  });
}

export async function createRoutineDetail(
  actorUserId: string,
  customerId: string,
  routineId: string,
  input: CreateRoutineDetailInput,
): Promise<RoutineDetailMutationResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getAuthorization(client);
    if (!hasManageRoutineAccess(auth)) throw routineWriteForbiddenError;
    await assertCustomerExists(client, customerId);
    const routine = await getCustomerRoutineForManager(client, customerId, routineId);
    assertEditableRoutine(routine);

    const resolvedSnapshot =
      input.exercise_name_snapshot ??
      (await resolveExerciseSnapshot(client, input.exercise_id));
    const inserted = await client.query<{ id: string | number }>(
      `
        INSERT INTO public.routine_details (
          routine_id, day_of_week, exercise_id, exercise_order, block_type,
          sets, reps, rest_seconds, duration_minutes, target_rir, notes,
          exercise_name_snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
      `,
      [
        routineId,
        input.day_of_week,
        input.exercise_id ?? null,
        input.exercise_order ?? null,
        input.block_type ?? "strength",
        input.sets ?? null,
        input.reps ?? null,
        input.rest_seconds ?? null,
        input.duration_minutes ?? null,
        input.target_rir ?? null,
        input.notes ?? null,
        resolvedSnapshot,
      ],
    );
    const detailId = Number(inserted.rows[0]?.id);
    const detail = await getRoutineDetail(client, routineId, detailId);

    return { customer_id: customerId, routine_id: routineId, detail };
  });
}

export async function updateRoutineDetail(
  actorUserId: string,
  customerId: string,
  routineId: string,
  detailId: number,
  input: UpdateRoutineDetailInput,
): Promise<RoutineDetailMutationResponse> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getAuthorization(client);
    if (!hasManageRoutineAccess(auth)) throw routineWriteForbiddenError;
    await assertCustomerExists(client, customerId);
    const routine = await getCustomerRoutineForManager(client, customerId, routineId);
    assertEditableRoutine(routine);
    const current = await getRoutineDetail(client, routineId, detailId);

    const exerciseId =
      input.exercise_id === undefined ? current.exercise_id : input.exercise_id;
    let exerciseNameSnapshot =
      input.exercise_name_snapshot === undefined
        ? current.exercise_name_snapshot
        : input.exercise_name_snapshot;
    if (input.exercise_id !== undefined && input.exercise_name_snapshot === undefined) {
      exerciseNameSnapshot = await resolveExerciseSnapshot(client, exerciseId);
    } else if (exerciseId) {
      await resolveExerciseSnapshot(client, exerciseId);
    }

    await client.query(
      `
        UPDATE public.routine_details
        SET day_of_week = $3,
            exercise_id = $4,
            exercise_order = $5,
            block_type = $6,
            sets = $7,
            reps = $8,
            rest_seconds = $9,
            duration_minutes = $10,
            target_rir = $11,
            notes = $12,
            exercise_name_snapshot = $13
        WHERE id = $1 AND routine_id = $2
      `,
      [
        detailId,
        routineId,
        input.day_of_week ?? current.day_of_week,
        exerciseId,
        input.exercise_order === undefined
          ? current.exercise_order
          : input.exercise_order,
        input.block_type ?? current.block_type,
        input.sets === undefined ? current.sets : input.sets,
        input.reps === undefined ? current.reps : input.reps,
        input.rest_seconds === undefined
          ? current.rest_seconds
          : input.rest_seconds,
        input.duration_minutes === undefined
          ? current.duration_minutes
          : input.duration_minutes,
        input.target_rir === undefined ? current.target_rir : input.target_rir,
        input.notes === undefined ? current.notes : input.notes,
        exerciseNameSnapshot,
      ],
    );
    const detail = await getRoutineDetail(client, routineId, detailId);

    return { customer_id: customerId, routine_id: routineId, detail };
  });
}

export async function deleteRoutineDetail(
  actorUserId: string,
  customerId: string,
  routineId: string,
  detailId: number,
): Promise<void> {
  return withUserTransaction(actorUserId, async (client) => {
    const auth = await getAuthorization(client);
    if (!hasManageRoutineAccess(auth)) throw routineWriteForbiddenError;
    await assertCustomerExists(client, customerId);
    const routine = await getCustomerRoutineForManager(client, customerId, routineId);
    assertEditableRoutine(routine);

    const result = await client.query(
      `DELETE FROM public.routine_details WHERE id = $1 AND routine_id = $2 RETURNING id`,
      [detailId, routineId],
    );
    if (result.rowCount !== 1) throw routineDetailNotFoundError;
  });
}
