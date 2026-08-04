import type { PoolClient } from "pg";
import { ZodError } from "zod";

import { withUserTransaction } from "../../db/transaction.js";
import {
  AppError,
  isAppError,
} from "../../errors/app-error.js";
import {
  bodyAssessmentCreateSchema,
  bodyAssessmentsQuerySchema,
  bodyAssessmentUpdateSchema,
  customerHealthProfileUpdateSchema,
} from "./customers-health.schemas.js";
import type {
  BodyAssessmentsResponse,
  BodyAssessmentWriteInput,
  CustomerBodyAssessment,
  CustomerHealthProfile,
  CustomerHealthProfileUpdateInput,
} from "./customers-health.types.js";

type AuthorizationRow = {
  permissions: string[] | null;
  is_owner: boolean;
};

type CustomerRow = {
  id: string;
};

type CustomerHealthProfileRow = Omit<
  CustomerHealthProfile,
  "created_at" | "updated_at"
> & {
  created_at: Date;
  updated_at: Date;
};

export type BodyAssessmentRow = {
  id: string;
  customer_id: string;
  assessment_date: string | null;
  weight_kg: string | null;
  height_cm: string | null;
  body_fat_percentage: string | null;
  muscle_mass_kg: string | null;
  chest: string | null;
  waist: string | null;
  hip: string | null;
  arm_right: string | null;
  arm_left: string | null;
  leg_right: string | null;
  leg_left: string | null;
  notes: string | null;
  body_type: string | null;
  activity_level: string | null;
  water_liters_goal: string | null;
  daily_calories: number | null;
  protein_grams: number | null;
  carbs_grams: number | null;
  fat_grams: number | null;
  diet_type: string | null;
  created_at: Date;
  updated_at: Date;
  total_count?: string;
};

type TotalRow = {
  total: string;
};

const healthProfileColumns = [
  "parq_requires_attention",
  "parq_details",
  "injuries_or_pain",
  "medical_conditions",
  "medications",
  "medical_clearance_notes",
  "restricted_movements",
  "primary_goal",
  "secondary_goal",
  "focus_areas",
  "experience_level",
  "days_per_week",
  "session_minutes",
  "training_location",
  "equipment_available",
  "cardio_preference",
  "exercise_preferences",
  "exercise_dislikes",
  "diet_type",
  "activity_level",
] as const satisfies ReadonlyArray<keyof CustomerHealthProfileUpdateInput>;

const assessmentColumnMap = {
  assessment_date: "date",
  weight_kg: "weight_kg",
  height_cm: "height_cm",
  body_fat_percentage: "body_fat_percentage",
  muscle_mass_kg: "muscle_mass_kg",
  chest: "chest",
  waist: "waist",
  hip: "hip",
  arm_right: "arm_right",
  arm_left: "arm_left",
  leg_right: "leg_right",
  leg_left: "leg_left",
  notes: "notes",
} as const satisfies Partial<Record<keyof BodyAssessmentWriteInput, string>>;

const nutritionColumnMap = {
  body_type: "body_type",
  activity_level: "activity_level",
  water_liters_goal: "water_liters_goal",
  daily_calories: "daily_calories",
  protein_grams: "protein_grams",
  carbs_grams: "carbs_grams",
  fat_grams: "fat_grams",
  diet_type: "diet_type",
} as const;

const customerNotFoundError = new AppError(
  404,
  "CUSTOMER_NOT_FOUND",
  "Cliente no encontrado",
);

const assessmentNotFoundError = new AppError(
  404,
  "BODY_ASSESSMENT_NOT_FOUND",
  "Evaluación corporal no encontrada",
);

const forbiddenHealthViewError = new AppError(
  403,
  "FORBIDDEN",
  "No autorizado para consultar el perfil de salud",
);

const forbiddenHealthUpdateError = new AppError(
  403,
  "FORBIDDEN",
  "No autorizado para editar el perfil de salud",
);

const forbiddenAssessmentsViewError = new AppError(
  403,
  "FORBIDDEN",
  "No autorizado para consultar evaluaciones corporales",
);

const forbiddenAssessmentsManageError = new AppError(
  403,
  "FORBIDDEN",
  "No autorizado para administrar evaluaciones corporales",
);

const persistenceError = new AppError(
  500,
  "HEALTH_DATA_PERSISTENCE_ERROR",
  "No se pudieron procesar los datos de salud",
);

const noHealthProfileChangesError = new AppError(
  400,
  "NO_HEALTH_PROFILE_CHANGES",
  "Los campos vacíos enviados no producen cambios",
);

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function hasPermission(
  authorization: AuthorizationRow,
  permission: string,
): boolean {
  return authorization.is_owner ||
    (authorization.permissions ?? []).includes(permission);
}

function isEmptyHealthProfileValue(value: unknown): boolean {
  return value === null || value === undefined ||
    (typeof value === "string" && value.length === 0) ||
    (Array.isArray(value) && value.length === 0);
}

function sanitizePersistenceError(error: unknown): never {
  if (isAppError(error) || error instanceof ZodError) {
    throw error;
  }

  throw persistenceError;
}

async function getAuthorization(
  client: PoolClient,
): Promise<AuthorizationRow> {
  const result = await client.query<AuthorizationRow>(`
    SELECT
      public.get_current_permissions() AS permissions,
      public.is_owner() AS is_owner
  `);

  return result.rows[0] ?? { permissions: [], is_owner: false };
}

async function assertCustomerExists(
  client: PoolClient,
  customerId: string,
): Promise<void> {
  const result = await client.query<CustomerRow>(
    `
      SELECT profiles.id
      FROM public.profiles
      INNER JOIN auth.users ON users.id = profiles.id
      WHERE profiles.id = $1
        AND profiles.role = 'client'
        AND users.deleted_at IS NULL
      LIMIT 1
    `,
    [customerId],
  );

  if (!result.rows[0]) {
    throw customerNotFoundError;
  }
}

function mapHealthProfile(
  customerId: string,
  row: CustomerHealthProfileRow | undefined,
): CustomerHealthProfile {
  return {
    customer_id: customerId,
    parq_requires_attention: row?.parq_requires_attention ?? null,
    parq_details: row?.parq_details ?? null,
    injuries_or_pain: row?.injuries_or_pain ?? null,
    medical_conditions: row?.medical_conditions ?? null,
    medications: row?.medications ?? null,
    medical_clearance_notes: row?.medical_clearance_notes ?? null,
    restricted_movements: row?.restricted_movements ?? null,
    primary_goal: row?.primary_goal ?? null,
    secondary_goal: row?.secondary_goal ?? null,
    focus_areas: row?.focus_areas ?? null,
    experience_level: row?.experience_level ?? null,
    days_per_week: row?.days_per_week ?? null,
    session_minutes: row?.session_minutes ?? null,
    training_location: row?.training_location ?? null,
    equipment_available: row?.equipment_available ?? null,
    cardio_preference: row?.cardio_preference ?? null,
    exercise_preferences: row?.exercise_preferences ?? null,
    exercise_dislikes: row?.exercise_dislikes ?? null,
    diet_type: row?.diet_type ?? null,
    activity_level: row?.activity_level ?? null,
    created_at: row?.created_at.toISOString() ?? null,
    updated_at: row?.updated_at.toISOString() ?? null,
  };
}

export function mapBodyAssessmentRow(
  row: BodyAssessmentRow,
): CustomerBodyAssessment {
  const nutritionSnapshot = {
    body_type: row.body_type,
    activity_level: row.activity_level,
    water_liters_goal: toNumber(row.water_liters_goal),
    daily_calories: row.daily_calories,
    protein_grams: row.protein_grams,
    carbs_grams: row.carbs_grams,
    fat_grams: row.fat_grams,
    diet_type: row.diet_type,
  };
  const hasNutritionSnapshot = Object.values(nutritionSnapshot)
    .some((value) => value !== null);

  return {
    id: row.id,
    customer_id: row.customer_id,
    assessment_date: row.assessment_date,
    weight_kg: toNumber(row.weight_kg),
    height_cm: toNumber(row.height_cm),
    body_fat_percentage: toNumber(row.body_fat_percentage),
    muscle_mass_kg: toNumber(row.muscle_mass_kg),
    chest: toNumber(row.chest),
    waist: toNumber(row.waist),
    hip: toNumber(row.hip),
    arm_right: toNumber(row.arm_right),
    arm_left: toNumber(row.arm_left),
    leg_right: toNumber(row.leg_right),
    leg_left: toNumber(row.leg_left),
    notes: row.notes,
    body_type: row.body_type,
    activity_level: row.activity_level,
    water_liters_goal: toNumber(row.water_liters_goal),
    daily_calories: row.daily_calories,
    protein_grams: row.protein_grams,
    carbs_grams: row.carbs_grams,
    fat_grams: row.fat_grams,
    diet_type: row.diet_type,
    nutrition_snapshot: hasNutritionSnapshot ? nutritionSnapshot : null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

async function getHealthProfileRow(
  client: PoolClient,
  customerId: string,
): Promise<CustomerHealthProfileRow | undefined> {
  const result = await client.query<CustomerHealthProfileRow>(
    `
      SELECT
        user_id AS customer_id,
        parq_requires_attention,
        parq_details,
        injuries_or_pain,
        medical_conditions,
        medications,
        medical_clearance_notes,
        restricted_movements,
        primary_goal,
        secondary_goal,
        focus_areas,
        experience_level,
        days_per_week,
        session_minutes,
        training_location,
        equipment_available,
        cardio_preference,
        exercise_preferences,
        exercise_dislikes,
        diet_type,
        activity_level,
        created_at,
        updated_at
      FROM public.customer_health_profiles
      WHERE user_id = $1
      LIMIT 1
    `,
    [customerId],
  );

  return result.rows[0];
}

async function getBodyAssessmentRow(
  client: PoolClient,
  customerId: string,
  assessmentId: string,
): Promise<BodyAssessmentRow | undefined> {
  const result = await client.query<BodyAssessmentRow>(
    `
      SELECT
        id,
        user_id AS customer_id,
        to_char(date, 'YYYY-MM-DD') AS assessment_date,
        weight_kg,
        height_cm,
        body_fat_percentage,
        muscle_mass_kg,
        chest,
        waist,
        hip,
        arm_right,
        arm_left,
        leg_right,
        leg_left,
        notes,
        body_type,
        activity_level,
        water_liters_goal,
        daily_calories,
        protein_grams,
        carbs_grams,
        fat_grams,
        diet_type,
        created_at,
        updated_at
      FROM public.body_assessments
      WHERE id = $1
        AND user_id = $2
      LIMIT 1
    `,
    [assessmentId, customerId],
  );

  return result.rows[0];
}

function buildAssessmentValues(input: BodyAssessmentWriteInput): {
  columns: string[];
  values: unknown[];
} {
  const columns: string[] = [];
  const values: unknown[] = [];

  for (const [field, column] of Object.entries(
    assessmentColumnMap,
  ) as Array<[keyof typeof assessmentColumnMap, string]>) {
    const value = input[field];
    if (value === undefined) continue;
    columns.push(column);
    values.push(value);
  }

  if (input.nutrition_snapshot === null) {
    for (const column of Object.values(nutritionColumnMap)) {
      columns.push(column);
      values.push(null);
    }
  } else if (input.nutrition_snapshot !== undefined) {
    for (const [field, column] of Object.entries(
      nutritionColumnMap,
    ) as Array<[keyof typeof nutritionColumnMap, string]>) {
      const value = input.nutrition_snapshot[field];
      if (value === undefined) continue;
      columns.push(column);
      values.push(value);
    }
  }

  return { columns, values };
}

export async function getCustomerHealthProfile(
  actorUserId: string,
  customerId: string,
): Promise<CustomerHealthProfile> {
  try {
    return await withUserTransaction(actorUserId, async (client) => {
      const authorization = await getAuthorization(client);
      if (!hasPermission(authorization, "customer_health_profiles.view")) {
        throw forbiddenHealthViewError;
      }

      await assertCustomerExists(client, customerId);
      const profile = await getHealthProfileRow(client, customerId);
      return mapHealthProfile(customerId, profile);
    });
  } catch (error) {
    sanitizePersistenceError(error);
  }
}

export async function updateCustomerHealthProfile(
  actorUserId: string,
  customerId: string,
  body: unknown,
): Promise<CustomerHealthProfile> {
  try {
    return await withUserTransaction(actorUserId, async (client) => {
      const authorization = await getAuthorization(client);
      if (!hasPermission(authorization, "customer_health_profiles.manage")) {
        throw forbiddenHealthUpdateError;
      }

      const input = customerHealthProfileUpdateSchema.parse(body);
      await assertCustomerExists(client, customerId);
      const existingProfile = await getHealthProfileRow(client, customerId);
      const columns = healthProfileColumns.filter(
        (column) => input[column] !== undefined,
      );

      if (
        columns.every((column) => isEmptyHealthProfileValue(input[column])) &&
        columns.every((column) =>
          isEmptyHealthProfileValue(existingProfile?.[column])
        )
      ) {
        throw noHealthProfileChangesError;
      }

      const values = columns.map((column) => input[column]);
      const insertColumns = ["user_id", ...columns];
      const placeholders = insertColumns.map((_, index) => `$${index + 1}`);
      const assignments = columns.map(
        (column) => `${column} = EXCLUDED.${column}`,
      );

      await client.query(
        `
          INSERT INTO public.customer_health_profiles (
            ${insertColumns.join(", ")}
          )
          VALUES (${placeholders.join(", ")})
          ON CONFLICT (user_id) DO UPDATE
          SET ${assignments.join(", ")}
        `,
        [customerId, ...values],
      );

      const profile = await getHealthProfileRow(client, customerId);
      if (!profile) throw persistenceError;
      return mapHealthProfile(customerId, profile);
    });
  } catch (error) {
    sanitizePersistenceError(error);
  }
}

export async function listCustomerBodyAssessments(
  actorUserId: string,
  customerId: string,
  query: unknown,
): Promise<BodyAssessmentsResponse> {
  try {
    return await withUserTransaction(actorUserId, async (client) => {
      const authorization = await getAuthorization(client);
      if (!hasPermission(authorization, "body_assessments.view")) {
        throw forbiddenAssessmentsViewError;
      }

      const input = bodyAssessmentsQuerySchema.parse(query);
      await assertCustomerExists(client, customerId);
      const offset = (input.page - 1) * input.page_size;
      const result = await client.query<BodyAssessmentRow>(
        `
          SELECT
            id,
            user_id AS customer_id,
            to_char(date, 'YYYY-MM-DD') AS assessment_date,
            weight_kg,
            height_cm,
            body_fat_percentage,
            muscle_mass_kg,
            chest,
            waist,
            hip,
            arm_right,
            arm_left,
            leg_right,
            leg_left,
            notes,
            body_type,
            activity_level,
            water_liters_goal,
            daily_calories,
            protein_grams,
            carbs_grams,
            fat_grams,
            diet_type,
            created_at,
            updated_at,
            count(*) OVER()::text AS total_count
          FROM public.body_assessments
          WHERE user_id = $1
          ORDER BY date DESC NULLS LAST, id DESC
          LIMIT $2 OFFSET $3
        `,
        [customerId, input.page_size, offset],
      );
      const countResult = await client.query<TotalRow>(
        `
          SELECT count(*)::text AS total
          FROM public.body_assessments
          WHERE user_id = $1
        `,
        [customerId],
      );
      const total = Number.parseInt(
        countResult.rows[0]?.total ?? "0",
        10,
      );

      return {
        data: result.rows.map(mapBodyAssessmentRow),
        meta: {
          page: input.page,
          page_size: input.page_size,
          total,
          total_pages: total === 0 ? 0 : Math.ceil(total / input.page_size),
        },
      };
    });
  } catch (error) {
    sanitizePersistenceError(error);
  }
}

export async function createCustomerBodyAssessment(
  actorUserId: string,
  customerId: string,
  body: unknown,
): Promise<CustomerBodyAssessment> {
  try {
    return await withUserTransaction(actorUserId, async (client) => {
      const authorization = await getAuthorization(client);
      if (!hasPermission(authorization, "body_assessments.manage")) {
        throw forbiddenAssessmentsManageError;
      }

      const input = bodyAssessmentCreateSchema.parse(body);
      await assertCustomerExists(client, customerId);
      const { columns, values } = buildAssessmentValues(input);
      const insertColumns = ["user_id", ...columns];
      const placeholders = insertColumns.map((_, index) => `$${index + 1}`);
      const insertResult = await client.query<{ id: string }>(
        `
          INSERT INTO public.body_assessments (
            ${insertColumns.join(", ")}
          )
          VALUES (${placeholders.join(", ")})
          RETURNING id
        `,
        [customerId, ...values],
      );
      const assessmentId = insertResult.rows[0]?.id;
      if (!assessmentId) throw persistenceError;

      const assessment = await getBodyAssessmentRow(
        client,
        customerId,
        assessmentId,
      );
      if (!assessment) throw persistenceError;
      return mapBodyAssessmentRow(assessment);
    });
  } catch (error) {
    sanitizePersistenceError(error);
  }
}

export async function updateCustomerBodyAssessment(
  actorUserId: string,
  customerId: string,
  assessmentId: string,
  body: unknown,
): Promise<CustomerBodyAssessment> {
  try {
    return await withUserTransaction(actorUserId, async (client) => {
      const authorization = await getAuthorization(client);
      if (!hasPermission(authorization, "body_assessments.manage")) {
        throw forbiddenAssessmentsManageError;
      }

      const input = bodyAssessmentUpdateSchema.parse(body);
      await assertCustomerExists(client, customerId);
      const { columns, values } = buildAssessmentValues(input);
      const assignments = columns.map(
        (column, index) => `${column} = $${index + 1}`,
      );
      const updateResult = await client.query<{ id: string }>(
        `
          UPDATE public.body_assessments
          SET ${assignments.join(", ")}
          WHERE id = $${values.length + 1}
            AND user_id = $${values.length + 2}
          RETURNING id
        `,
        [...values, assessmentId, customerId],
      );

      if (updateResult.rowCount === 0) {
        throw assessmentNotFoundError;
      }

      const assessment = await getBodyAssessmentRow(
        client,
        customerId,
        assessmentId,
      );
      if (!assessment) throw persistenceError;
      return mapBodyAssessmentRow(assessment);
    });
  } catch (error) {
    sanitizePersistenceError(error);
  }
}
