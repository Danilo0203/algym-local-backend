import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import {
  profileResponseSchema,
  profileUpdateSchema,
} from "./profile.schemas.js";
import type {
  ProfileResponse,
  ProfileUpdateInput,
} from "./profile.types.js";

type ProfileAuthorizationRow = {
  permissions: string[] | null;
  is_owner: boolean;
};

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string;
  phone: string;
  birth_date: string;
  gender: "male" | "female" | "other";
  avatar_url: string | null;
  role: string | null;
  created_at: Date | null;
  updated_at: Date | null;
  is_active: boolean;
};

const profileUpdatePermission = "profile.update";

const profileNotFoundError = new AppError(
  404,
  "PROFILE_NOT_FOUND",
  "Perfil no encontrado",
);

const profileInactiveError = new AppError(
  403,
  "PROFILE_INACTIVE",
  "Perfil inactivo",
);

const forbiddenProfileUpdateError = new AppError(
  403,
  "FORBIDDEN",
  "No autorizado para editar el perfil",
);

const profileColumnMap = {
  full_name: "full_name",
  phone: "phone",
  birth_date: "birth_date",
  gender: "gender",
} as const satisfies Record<keyof ProfileUpdateInput, string>;

async function getProfileAuthorization(
  client: PoolClient,
): Promise<ProfileAuthorizationRow> {
  const result = await client.query<ProfileAuthorizationRow>(
    `
      SELECT
        public.get_current_permissions() AS permissions,
        public.is_owner() AS is_owner
    `,
  );

  return (
    result.rows[0] ?? {
      permissions: [],
      is_owner: false,
    }
  );
}

function assertProfileWriteAccess(
  authorization: ProfileAuthorizationRow,
): void {
  const permissions = authorization.permissions ?? [];

  if (
    authorization.is_owner ||
    permissions.includes(profileUpdatePermission)
  ) {
    return;
  }

  throw forbiddenProfileUpdateError;
}

function mapProfileRow(row: ProfileRow): ProfileResponse {
  if (!row.is_active) {
    throw profileInactiveError;
  }

  return profileResponseSchema.parse({
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    phone: row.phone,
    birth_date: row.birth_date,
    gender: row.gender,
    avatar_url: row.avatar_url,
    role: row.role,
    created_at: row.created_at?.toISOString() ?? null,
    updated_at: row.updated_at?.toISOString() ?? null,
  });
}

async function getProfileRow(
  client: PoolClient,
  userId: string,
): Promise<ProfileRow | null> {
  const result = await client.query<ProfileRow>(
    `
      SELECT
        p.id,
        u.email,
        p.full_name,
        p.phone,
        to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date,
        p.gender::text AS gender,
        p.avatar_url,
        p.role::text AS role,
        p.created_at,
        p.updated_at,
        p.is_active
      FROM public.profiles AS p
      INNER JOIN auth.users AS u
        ON u.id = p.id
      WHERE p.id = $1
        AND u.deleted_at IS NULL
      LIMIT 1
    `,
    [userId],
  );

  return result.rows[0] ?? null;
}

function buildProfileUpdateQuery(input: ProfileUpdateInput): {
  assignments: string[];
  values: Array<string>;
} {
  const assignments: string[] = [];
  const values: Array<string> = [];

  for (const [field, column] of Object.entries(profileColumnMap) as Array<
    [keyof ProfileUpdateInput, string]
  >) {
    const value = input[field];

    if (value === undefined) {
      continue;
    }

    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  return {
    assignments,
    values,
  };
}

export async function getProfile(
  userId: string,
): Promise<ProfileResponse> {
  return withUserTransaction(userId, async (client) => {
    const profile = await getProfileRow(client, userId);

    if (!profile) {
      throw profileNotFoundError;
    }

    return mapProfileRow(profile);
  });
}

export async function updateProfile(
  userId: string,
  body: unknown,
): Promise<ProfileResponse> {
  return withUserTransaction(userId, async (client) => {
    const authorization = await getProfileAuthorization(client);
    assertProfileWriteAccess(authorization);

    const input = profileUpdateSchema.parse(body);
    const { assignments, values } = buildProfileUpdateQuery(input);

    if (assignments.length === 0) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        "Solicitud inválida",
      );
    }

    const updateResult = await client.query<{ id: string }>(
      `
        UPDATE public.profiles
        SET
          ${assignments.join(", ")},
          updated_at = now()
        WHERE id = $${values.length + 1}
        RETURNING id
      `,
      [...values, userId],
    );

    if (updateResult.rowCount === 0) {
      throw profileNotFoundError;
    }

    const profile = await getProfileRow(client, userId);

    if (!profile) {
      throw profileNotFoundError;
    }

    return mapProfileRow(profile);
  });
}
