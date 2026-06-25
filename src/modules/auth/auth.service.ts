import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import bcrypt from "bcryptjs";
import type { CookieOptions, Request } from "express";
import type { PoolClient } from "pg";

import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import {
  authorizationScopeSchema,
  authenticatedUserContextSchema,
  changePasswordBodySchema,
  loginBodySchema,
  sessionTokenSchema,
  type AuthenticatedUserContext,
  type ChangePasswordBody,
  type LoginBody,
} from "./auth.schemas.js";

type AuthUserRow = {
  id: string;
  email: string | null;
  encrypted_password: string | null;
  deleted_at: string | null;
};

type AuthUserPasswordRow = {
  id: string;
  encrypted_password: string | null;
};

type SessionRow = {
  id: string;
  user_id: string;
  secret_hash: Buffer;
  expires_at: Date;
  revoked_at: Date | null;
};

type AuthenticatedUserContextRow = {
  id: string;
  email: string | null;
  full_name: string;
  profile_role: string;
  is_active: boolean;
  role_slug: string;
  permissions: string[] | null;
  is_owner: boolean;
};

export type SessionContext = {
  sessionId: string;
  userId: string;
};

const SESSION_UPDATE_INTERVAL_SQL = "interval '5 minutes'";
const sessionTtlMilliseconds =
  env.AUTH_SESSION_TTL_HOURS * 60 * 60 * 1000;

const invalidCredentialsError = new AppError(
  401,
  "INVALID_CREDENTIALS",
  "Credenciales inválidas",
);

const invalidSessionError = new AppError(
  401,
  "INVALID_SESSION",
  "Sesión inválida",
);

const invalidCurrentPasswordError = new AppError(
  400,
  "INVALID_CURRENT_PASSWORD",
  "La contraseña actual es incorrecta",
);

const passwordUnchangedError = new AppError(
  400,
  "PASSWORD_UNCHANGED",
  "La nueva contraseña no puede ser igual a la actual",
);

const userNotFoundError = new AppError(
  404,
  "USER_NOT_FOUND",
  "Usuario no encontrado",
);

const inactiveProfileError = new AppError(
  403,
  "PROFILE_INACTIVE",
  "Perfil inactivo",
);

const fallbackPasswordHash = bcrypt.hashSync(
  "algym-invalid-credentials-placeholder",
  10,
);

const panelRoleSlugs = new Set([
  "admin",
  "employee",
  "owner",
  "trainer",
]);

function resolveAuthorizationScope(
  roleSlug: string,
): "panel" | "client" {
  if (roleSlug === "client") {
    return authorizationScopeSchema.parse("client");
  }

  if (panelRoleSlugs.has(roleSlug)) {
    return authorizationScopeSchema.parse("panel");
  }

  throw new AppError(
    500,
    "UNKNOWN_ROLE_SCOPE",
    "No se pudo determinar el scope del rol",
  );
}

export function getSessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE,
    sameSite: env.AUTH_COOKIE_SAME_SITE,
    path: "/",
    maxAge: sessionTtlMilliseconds,
  };
}

export function clearSessionCookie(request: Request): void {
  request.res?.clearCookie(
    env.AUTH_COOKIE_NAME,
    getSessionCookieOptions(),
  );
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function buildSessionToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

function hashSessionSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function parseSessionToken(token: string): {
  sessionId: string;
  secret: string;
} {
  const parsedToken = sessionTokenSchema.safeParse(token);

  if (!parsedToken.success) {
    throw invalidSessionError;
  }

  const [sessionId, secret] = parsedToken.data.split(".", 2);

  if (!sessionId || !secret) {
    throw invalidSessionError;
  }

  return {
    sessionId,
    secret,
  };
}

async function findUserByEmail(
  email: string,
): Promise<AuthUserRow | null> {
  const result = await pool.query<AuthUserRow>(
    `
      SELECT
        id,
        email,
        encrypted_password,
        deleted_at
      FROM auth.users
      WHERE lower(email) = $1
      LIMIT 1
    `,
    [normalizeEmail(email)],
  );

  return result.rows[0] ?? null;
}

function toAuthenticatedUserContext(
  row: AuthenticatedUserContextRow,
): AuthenticatedUserContext {
  return authenticatedUserContextSchema.parse({
    user: {
      id: row.id,
      email: row.email,
      profile: {
        fullName: row.full_name,
        role: row.profile_role,
        isActive: row.is_active,
      },
    },
    authorization: {
      roleSlug: row.role_slug,
      scope: resolveAuthorizationScope(row.role_slug),
      permissions: row.permissions ?? [],
      isOwner: row.is_owner,
    },
  });
}

async function queryAuthenticatedUserContext(
  client: PoolClient,
  userId: string,
): Promise<AuthenticatedUserContextRow | null> {
  const result = await client.query<AuthenticatedUserContextRow>(
    `
      SELECT
        u.id,
        u.email,
        p.full_name,
        p.role::text AS profile_role,
        p.is_active,
        public.get_current_role_slug() AS role_slug,
        public.get_current_permissions() AS permissions,
        public.is_owner() AS is_owner
      FROM auth.users AS u
      INNER JOIN public.profiles AS p
        ON p.id = u.id
      WHERE u.id = $1
        AND u.deleted_at IS NULL
      LIMIT 1
    `,
    [userId],
  );

  return result.rows[0] ?? null;
}

async function createSession(
  userId: string,
  request: Request,
): Promise<{
  token: string;
}> {
  const secret = randomBytes(32).toString("base64url");
  const secretHash = hashSessionSecret(secret);
  const expiresAt = new Date(Date.now() + sessionTtlMilliseconds);

  const result = await pool.query<{
    id: string;
  }>(
    `
      INSERT INTO auth.sessions (
        user_id,
        secret_hash,
        expires_at,
        user_agent,
        ip_address
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `,
    [
      userId,
      secretHash,
      expiresAt,
      request.get("user-agent") ?? null,
      request.ip ?? null,
    ],
  );

  const session = result.rows[0];

  if (!session) {
    throw new AppError(
      500,
      "SESSION_CREATE_FAILED",
      "No se pudo crear la sesión",
    );
  }

  return {
    token: buildSessionToken(session.id, secret),
  };
}

async function updateLastUsedAt(sessionId: string): Promise<void> {
  await pool.query(
    `
      UPDATE auth.sessions
      SET last_used_at = now()
      WHERE id = $1
        AND last_used_at < now() - ${SESSION_UPDATE_INTERVAL_SQL}
    `,
    [sessionId],
  );
}

async function resolveAuthenticatedUserContext(
  userId: string,
  missingContextError: AppError,
): Promise<AuthenticatedUserContext> {
  const contextRow = await withUserTransaction(userId, (client) =>
    queryAuthenticatedUserContext(client, userId),
  );

  if (!contextRow) {
    throw missingContextError;
  }

  if (!contextRow.is_active) {
    throw inactiveProfileError;
  }

  return toAuthenticatedUserContext(contextRow);
}

export async function getAuthenticatedUserContext(
  userId: string,
): Promise<AuthenticatedUserContext> {
  return resolveAuthenticatedUserContext(
    userId,
    invalidSessionError,
  );
}

export async function authenticateUser(
  input: LoginBody,
  request: Request,
): Promise<{
  context: AuthenticatedUserContext;
  token: string;
}> {
  const body = loginBodySchema.parse(input);
  const user = await findUserByEmail(body.email);
  const passwordHash =
    user?.encrypted_password ?? fallbackPasswordHash;

  const passwordMatches = await bcrypt.compare(
    body.password,
    passwordHash,
  );

  if (
    !user ||
    !passwordMatches ||
    user.deleted_at !== null ||
    user.encrypted_password === null
  ) {
    throw invalidCredentialsError;
  }

  const context = await resolveAuthenticatedUserContext(
    user.id,
    invalidCredentialsError,
  );
  const session = await createSession(user.id, request);

  await pool.query(
    `
      UPDATE auth.users
      SET last_sign_in_at = now()
      WHERE id = $1
    `,
    [user.id],
  );

  return {
    context,
    token: session.token,
  };
}

export async function validateSessionToken(
  token: string,
): Promise<SessionContext> {
  const { sessionId, secret } = parseSessionToken(token);

  const result = await pool.query<SessionRow>(
    `
      SELECT
        id,
        user_id,
        secret_hash,
        expires_at,
        revoked_at
      FROM auth.sessions
      WHERE id = $1
      LIMIT 1
    `,
    [sessionId],
  );

  const session = result.rows[0];

  if (!session || session.revoked_at !== null) {
    throw invalidSessionError;
  }

  if (session.expires_at.getTime() <= Date.now()) {
    throw invalidSessionError;
  }

  const calculatedHash = hashSessionSecret(secret);

  if (
    session.secret_hash.length !== calculatedHash.length ||
    !timingSafeEqual(session.secret_hash, calculatedHash)
  ) {
    throw invalidSessionError;
  }

  await updateLastUsedAt(session.id);

  return {
    sessionId: session.id,
    userId: session.user_id,
  };
}

export async function revokeSessionToken(
  token: string | undefined,
): Promise<void> {
  if (!token) {
    return;
  }

  const parsedToken = sessionTokenSchema.safeParse(token);

  if (!parsedToken.success) {
    return;
  }

  const [sessionId, secret] = parsedToken.data.split(".", 2);

  if (!sessionId || !secret) {
    return;
  }

  const result = await pool.query<Pick<SessionRow, "secret_hash">>(
    `
      SELECT secret_hash
      FROM auth.sessions
      WHERE id = $1
      LIMIT 1
    `,
    [sessionId],
  );

  const session = result.rows[0];

  if (!session) {
    return;
  }

  const calculatedHash = hashSessionSecret(secret);

  if (
    session.secret_hash.length !== calculatedHash.length ||
    !timingSafeEqual(session.secret_hash, calculatedHash)
  ) {
    return;
  }

  await pool.query(
    `
      UPDATE auth.sessions
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1
    `,
    [sessionId],
  );
}

async function getUserPasswordById(
  client: PoolClient,
  userId: string,
): Promise<AuthUserPasswordRow | null> {
  const result = await client.query<AuthUserPasswordRow>(
    `
      SELECT
        id,
        encrypted_password
      FROM auth.users
      WHERE id = $1
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [userId],
  );

  return result.rows[0] ?? null;
}

async function revokeAllUserSessions(
  client: PoolClient,
  userId: string,
): Promise<void> {
  await client.query(
    `
      UPDATE auth.sessions
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE user_id = $1
    `,
    [userId],
  );
}

export async function changeAuthenticatedUserPassword(
  userId: string,
  input: ChangePasswordBody,
): Promise<{
  message: string;
  success: true;
}> {
  const body = changePasswordBodySchema.parse(input);

  return withUserTransaction(userId, async (client) => {
    const user = await getUserPasswordById(client, userId);

    if (!user || user.encrypted_password === null) {
      throw userNotFoundError;
    }

    const currentPasswordMatches = await bcrypt.compare(
      body.currentPassword,
      user.encrypted_password,
    );

    if (!currentPasswordMatches) {
      throw invalidCurrentPasswordError;
    }

    const passwordUnchanged = await bcrypt.compare(
      body.newPassword,
      user.encrypted_password,
    );

    if (passwordUnchanged) {
      throw passwordUnchangedError;
    }

    const newPasswordHash = await bcrypt.hash(body.newPassword, 10);

    const updateResult = await client.query(
      `
        UPDATE auth.users
        SET
          encrypted_password = $1,
          updated_at = now()
        WHERE id = $2
          AND deleted_at IS NULL
      `,
      [newPasswordHash, userId],
    );

    if (updateResult.rowCount === 0) {
      throw new AppError(
        500,
        "PASSWORD_UPDATE_FAILED",
        "No se pudo actualizar la contraseña",
      );
    }

    await revokeAllUserSessions(client, userId);

    return {
      success: true as const,
      message: "Contraseña actualizada correctamente",
    };
  });
}

export function readSessionTokenFromRequest(
  request: Request,
): string {
  const token = request.cookies?.[env.AUTH_COOKIE_NAME];

  if (typeof token !== "string") {
    throw invalidSessionError;
  }

  return token;
}
