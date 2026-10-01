import type { PoolClient } from "pg";

import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import type { CreateRoleInput, DeleteRoleInput, UpdateRoleInput } from "./roles.schemas.js";

type RoleRow = {
  id: string;
  slug: string;
  name: string;
  scope: "panel" | "client";
  is_system: boolean;
  is_protected: boolean;
  created_at: Date;
  updated_at: Date;
};

const roleColumns = "id, slug, name, scope, is_system, is_protected, created_at, updated_at";

async function requirePermission(client: PoolClient, permission: string) {
  const result = await client.query<{ allowed: boolean; is_owner: boolean }>(
    `SELECT (public.is_owner() OR public.has_permission($1)) AS allowed,
            public.is_owner() AS is_owner`,
    [permission],
  );
  if (!result.rows[0]?.allowed) {
    throw new AppError(403, "FORBIDDEN", "No autorizado para administrar roles");
  }
  return result.rows[0];
}

async function requireRole(client: PoolClient, roleId: string, lock = false): Promise<RoleRow> {
  const result = await client.query<RoleRow>(
    `SELECT ${roleColumns} FROM public.roles WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [roleId],
  );
  if (!result.rows[0]) throw new AppError(404, "ROLE_NOT_FOUND", "Rol no encontrado");
  return result.rows[0];
}

async function validatePermissionIds(client: PoolClient, permissionIds: string[]): Promise<void> {
  if (permissionIds.length === 0) return;
  const result = await client.query<{ id: string }>(
    `SELECT id FROM public.permissions WHERE id = ANY($1::uuid[])`,
    [permissionIds],
  );
  if (result.rows.length !== permissionIds.length) {
    throw new AppError(400, "INVALID_PERMISSION", "Uno o más permisos no existen");
  }
}

async function replaceRolePermissions(client: PoolClient, roleId: string, permissionIds: string[]) {
  await validatePermissionIds(client, permissionIds);
  await client.query("DELETE FROM public.role_permissions WHERE role_id = $1", [roleId]);
  if (permissionIds.length > 0) {
    await client.query(
      `INSERT INTO public.role_permissions (role_id, permission_id)
       SELECT $1::uuid, id FROM public.permissions WHERE id = ANY($2::uuid[])`,
      [roleId, permissionIds],
    );
  }
}

export async function listRoles(actorUserId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "roles.view");
    const result = await client.query<RoleRow & { user_count: string }>(
      `SELECT roles.*, count(profiles.id)::text AS user_count
       FROM public.roles AS roles
       LEFT JOIN public.profiles AS profiles
         ON profiles.panel_role_id = roles.id
         OR (profiles.panel_role_id IS NULL AND profiles.role::text = roles.slug)
       GROUP BY roles.id
       ORDER BY roles.created_at, roles.slug`,
    );
    return { data: result.rows.map((role) => ({ ...role, user_count: Number(role.user_count) })) };
  });
}

export async function listPermissions(actorUserId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "roles.view");
    const result = await client.query(
      `SELECT id, key, description, module, action
       FROM public.permissions ORDER BY module, action, key`,
    );
    return { data: result.rows };
  });
}

export async function listRolePermissionIds(actorUserId: string, roleId: string) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "roles.view");
    await requireRole(client, roleId);
    const result = await client.query<{ permission_id: string }>(
      `SELECT permission_id FROM public.role_permissions
       WHERE role_id = $1 ORDER BY permission_id`,
      [roleId],
    );
    return { data: result.rows.map((row) => row.permission_id) };
  });
}

export async function createRole(actorUserId: string, input: CreateRoleInput) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "roles.create");
    await validatePermissionIds(client, input.permissionIds);
    try {
      const result = await client.query<RoleRow>(
        `INSERT INTO public.roles (slug, name, scope, is_system, is_protected)
         VALUES ($1, $2, 'panel', false, false) RETURNING ${roleColumns}`,
        [input.slug, input.name],
      );
      const role = result.rows[0]!;
      if (input.permissionIds.length > 0) {
        await client.query(
          `INSERT INTO public.role_permissions (role_id, permission_id)
           SELECT $1::uuid, id FROM public.permissions WHERE id = ANY($2::uuid[])`,
          [role.id, input.permissionIds],
        );
      }
      return role;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw new AppError(409, "ROLE_SLUG_EXISTS", "Ya existe un rol con este identificador");
      }
      throw error;
    }
  });
}

export async function updateRole(actorUserId: string, roleId: string, input: UpdateRoleInput) {
  return withUserTransaction(actorUserId, async (client) => {
    const actor = await requirePermission(client, "roles.update");
    const role = await requireRole(client, roleId, true);
    if (role.is_protected && !actor.is_owner) {
      throw new AppError(403, "PROTECTED_ROLE", "Solo el propietario puede editar este rol");
    }
    if (input.permissionIds !== undefined) {
      await replaceRolePermissions(client, roleId, input.permissionIds);
      await client.query(
        `UPDATE auth.sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE user_id IN (
           SELECT id FROM public.profiles WHERE panel_role_id = $1
         ) AND revoked_at IS NULL`,
        [roleId],
      );
    }
    if (input.name !== undefined) {
      await client.query(
        "UPDATE public.roles SET name = $2, updated_at = now() WHERE id = $1",
        [roleId, input.name],
      );
    }
    return requireRole(client, roleId);
  });
}

export async function deleteRole(actorUserId: string, roleId: string, input: DeleteRoleInput) {
  return withUserTransaction(actorUserId, async (client) => {
    await requirePermission(client, "roles.delete");
    const role = await requireRole(client, roleId, true);
    if (role.is_system || role.is_protected) {
      throw new AppError(403, "PROTECTED_ROLE", "No se puede eliminar un rol del sistema");
    }
    const assigned = await client.query<{ id: string }>(
      `SELECT profiles.id FROM public.profiles AS profiles
       WHERE profiles.panel_role_id = $1 FOR UPDATE OF profiles`,
      [role.id],
    );
    if (assigned.rows.length > 0) {
      if (!input.replacementRoleSlug) {
        throw new AppError(409, "REASSIGN_REQUIRED", "El rol tiene usuarios asignados");
      }
      const actorRole = await client.query<{ base_role: string }>(
        "SELECT public.get_my_role()::text AS base_role",
      );
      if (!['owner', 'admin'].includes(actorRole.rows[0]?.base_role ?? '')) {
        throw new AppError(403, "FORBIDDEN", "No autorizado para reasignar usuarios");
      }
      const replacement = await client.query<{ id: string; slug: string; is_system: boolean }>(
        `SELECT id, slug, is_system FROM public.roles
         WHERE slug = $1 AND scope = $2 AND id <> $3 FOR UPDATE`,
        [input.replacementRoleSlug, role.scope, role.id],
      );
      const nextRole = replacement.rows[0];
      if (!nextRole || (nextRole.is_system && !["owner", "admin", "trainer", "employee"].includes(nextRole.slug))) {
        throw new AppError(400, "INVALID_REPLACEMENT_ROLE", "Rol de reemplazo no válido");
      }
      const ids = assigned.rows.map((row) => row.id);
      await client.query(
        `UPDATE public.profiles
         SET role = (CASE WHEN $2::boolean THEN $3::text ELSE 'custom' END)::public.user_role,
             panel_role_id = CASE WHEN $2::boolean THEN NULL ELSE $4::uuid END,
             updated_at = now()
         WHERE id = ANY($1::uuid[])`,
        [ids, nextRole.is_system, nextRole.slug, nextRole.id],
      );
      await client.query(
        `UPDATE auth.users
         SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb)
                                  || jsonb_build_object('role', $2::text), updated_at = now()
         WHERE id = ANY($1::uuid[])`,
        [ids, nextRole.slug],
      );
      await client.query(
        `UPDATE auth.sessions SET revoked_at = COALESCE(revoked_at, now())
         WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
        [ids],
      );
    }
    await client.query("DELETE FROM public.roles WHERE id = $1", [roleId]);
  });
}
