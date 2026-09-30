import bcrypt from "bcryptjs";
import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import type { CreateUserInput, InternalUserRole, UpdateUserInput } from "./users.schemas.js";

type UserRow = {
  id: string;
  email: string;
  full_name: string;
  role: InternalUserRole;
  created_at: Date;
  last_sign_in_at: Date | null;
  is_active: boolean;
};

type LockedUser = UserRow;

const userColumns = `
  users.id,
  users.email,
  profiles.full_name,
  profiles.role::text AS role,
  COALESCE(profiles.created_at, users.created_at) AS created_at,
  users.last_sign_in_at,
  profiles.is_active
`;

async function requirePermission(client: PoolClient, permission: string): Promise<string> {
  const result = await client.query<{ allowed: boolean; actor_role: string | null }>(
    `SELECT (public.is_owner() OR public.has_permission($1)) AS allowed,
            public.get_current_role_slug() AS actor_role`,
    [permission],
  );
  if (!result.rows[0]?.allowed) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para administrar usuarios");
  }
  return result.rows[0].actor_role ?? "";
}

function assertRoleAssignment(actorRole: string, targetRole: InternalUserRole): void {
  if ((targetRole === "admin" || targetRole === "owner") &&
      actorRole !== "admin" && actorRole !== "owner") {
    throw new AppError(403, "FORBIDDEN", "No autorizado para asignar este rol");
  }
}

async function getLockedUser(client: PoolClient, userId: string): Promise<LockedUser> {
  const result = await client.query<LockedUser>(
    `SELECT ${userColumns}
     FROM auth.users AS users
     JOIN public.profiles AS profiles ON profiles.id = users.id
     WHERE users.id = $1 AND users.deleted_at IS NULL
       AND profiles.role IN ('owner', 'admin', 'trainer', 'employee')
     FOR UPDATE OF users, profiles`,
    [userId],
  );
  if (!result.rows[0]) {
    throw new AppError(404, "USER_NOT_FOUND", "Usuario no encontrado");
  }
  return result.rows[0];
}

async function protectLastOwner(client: PoolClient, existing: LockedUser): Promise<void> {
  if (existing.role !== "owner" || !existing.is_active) return;
  await client.query("SELECT pg_advisory_xact_lock(573145) ");
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM public.profiles AS profiles
     JOIN auth.users AS users ON users.id = profiles.id
     WHERE profiles.role = 'owner' AND profiles.is_active = true
       AND users.deleted_at IS NULL`,
  );
  if (Number(result.rows[0]?.count ?? 0) <= 1) {
    throw new AppError(409, "LAST_OWNER", "No se puede desactivar al último propietario");
  }
}

export async function listInternalUsers(actorUserId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "users.view");
    const result = await client.query<UserRow>(
      `SELECT ${userColumns}
       FROM auth.users AS users
       JOIN public.profiles AS profiles ON profiles.id = users.id
       WHERE users.deleted_at IS NULL
         AND profiles.role IN ('owner', 'admin', 'trainer', 'employee')
       ORDER BY COALESCE(profiles.created_at, users.created_at) DESC, users.id DESC`,
    );
    return { data: result.rows };
  });
}

export async function listInternalRoles(actorUserId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "users.view");
    const result = await client.query<{ slug: InternalUserRole; name: string }>(
      `SELECT slug, name FROM public.roles
       WHERE scope = 'panel' AND slug IN ('owner', 'admin', 'trainer', 'employee')
       ORDER BY name, slug`,
    );
    return { data: result.rows };
  });
}

export async function createInternalUser(actorUserId: string, input: CreateUserInput) {
  return withUserTransaction(actorUserId, async (client) => {
    const actorRole = await requirePermission(client, "users.create");
    assertRoleAssignment(actorRole, input.role);
    const hash = await bcrypt.hash(input.password, 10);
    try {
      const user = await client.query<{ id: string }>(
        `INSERT INTO auth.users
           (email, encrypted_password, email_confirmed_at, raw_app_meta_data,
            raw_user_meta_data, created_at, updated_at)
         VALUES ($1, $2, now(),
                 jsonb_build_object('provider', 'email', 'providers', ARRAY['email']),
                 jsonb_build_object('full_name', $3::text, 'role', $4::text),
                 now(), now())
         RETURNING id`,
        [input.email, hash, input.full_name, input.role],
      );
      const userId = user.rows[0]!.id;
      await client.query(
        `INSERT INTO public.profiles
           (id, full_name, phone, birth_date, biometric_id, role, is_active)
         VALUES ($1, $2, '', NULL, NULL, $3::public.user_role, true)`,
        [userId, input.full_name, input.role],
      );
      return { id: userId };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new AppError(409, "EMAIL_ALREADY_EXISTS", "El correo ya está registrado");
      }
      throw error;
    }
  });
}

export async function updateInternalUser(
  actorUserId: string,
  userId: string,
  input: UpdateUserInput,
) {
  return withUserTransaction(actorUserId, async (client) => {
    const actorRole = await requirePermission(client, "users.update");
    const existing = await getLockedUser(client, userId);
    assertRoleAssignment(actorRole, existing.role);
    if (input.role) assertRoleAssignment(actorRole, input.role);
    if (input.is_active === false && actorUserId === userId) {
      throw new AppError(409, "SELF_DEACTIVATE", "No puedes desactivar tu propia cuenta");
    }
    if (existing.role === "owner" &&
        ((input.role && input.role !== "owner") || input.is_active === false)) {
      await protectLastOwner(client, existing);
    }

    const fullName = input.full_name ?? existing.full_name;
    const role = input.role ?? existing.role;
    if (input.full_name || input.role || input.is_active !== undefined) {
      await client.query(
        `UPDATE public.profiles
         SET full_name = $2, role = $3::public.user_role,
             is_active = COALESCE($4::boolean, is_active), updated_at = now()
         WHERE id = $1`,
        [userId, fullName, role, input.is_active ?? null],
      );
    }

    const passwordHash = input.password ? await bcrypt.hash(input.password, 10) : null;
    await client.query(
      `UPDATE auth.users
       SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb)
                                  || jsonb_build_object('full_name', $2::text, 'role', $3::text),
           encrypted_password = COALESCE($4, encrypted_password),
           updated_at = now()
       WHERE id = $1`,
      [userId, fullName, role, passwordHash],
    );
    if (passwordHash || role !== existing.role || input.is_active === false) {
      await client.query(
        `UPDATE auth.sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );
    }
    return { id: userId };
  });
}

export async function deleteInternalUser(actorUserId: string, userId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    const actorRole = await requirePermission(client, "users.delete");
    if (actorUserId === userId) {
      throw new AppError(409, "SELF_DELETE", "No puedes eliminar tu propia cuenta");
    }
    const existing = await getLockedUser(client, userId);
    assertRoleAssignment(actorRole, existing.role);
    await protectLastOwner(client, existing);
    await client.query(
      `UPDATE auth.users
       SET deleted_at = now(), encrypted_password = NULL, updated_at = now()
       WHERE id = $1`,
      [userId],
    );
    await client.query(
      `UPDATE public.profiles SET is_active = false, updated_at = now() WHERE id = $1`,
      [userId],
    );
    await client.query(
      `UPDATE auth.sessions SET revoked_at = COALESCE(revoked_at, now())
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    return { id: userId };
  });
}
