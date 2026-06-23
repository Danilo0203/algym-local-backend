import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import bcrypt from "bcryptjs";
import type { CookieOptions, Request } from "express";
import type { PoolClient } from "pg";

import { env } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { withUserTransaction } from "../../db/transaction.js";
import { AppError } from "../../errors/app-error.js";
import {
  loginBodySchema,
  sessionTokenSchema,
  type LoginBody,
} from "./auth.schemas.js";

type AuthUserRow = {
  id: string;
  email: string | null;
  encrypted_password: string | null;
  deleted_at: string | null;
};

type SessionRow = {
  id: string;
  user_id: string;
  secret_hash: Buffer;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date;
};

type AuthProfileRow = {
  id: string;
  email: string | null;
  full_name: string;
  role: string;
  is_active: boolean;
};

export type AuthenticatedUser = {
  id: string;
  email: string | null;
  profile: {
    fullName: string;
    role: string;
    isActive: boolean;
  };
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

const fallbackPasswordHash = bcrypt.hashSync(
  "algym-invalid-credentials-placeholder",
  10,
);

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

async function getProfileForUser(
  client: PoolClient,
  userId: string,
): Promise<AuthProfileRow | null> {
  const result = await client.query<AuthProfileRow>(
    `
      SELECT
        u.id,
        u.email,
        p.full_name,
        p.role::text AS role,
        p.is_active
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

function toAuthenticatedUser(
  row: AuthProfileRow,
): AuthenticatedUser {
  return {
    id: row.id,
    email: row.email,
    profile: {
      fullName: row.full_name,
      role: row.role,
      isActive: row.is_active,
    },
  };
}

async function createSession(
  userId: string,
  request: Request,
): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const secret = randomBytes(32).toString("base64url");
  const secretHash = hashSessionSecret(secret);
  const expiresAt = new Date(Date.now() + sessionTtlMilliseconds);

  const result = await pool.query<{
    id: string;
    expires_at: Date;
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
      RETURNING id, expires_at
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
    expiresAt: session.expires_at,
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

export async function authenticateUser(
  input: LoginBody,
  request: Request,
): Promise<{
  user: AuthenticatedUser;
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

  const profile = await withUserTransaction(user.id, (client) =>
    getProfileForUser(client, user.id),
  );

  if (!profile) {
    throw invalidCredentialsError;
  }

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
    user: toAuthenticatedUser(profile),
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
        revoked_at,
        last_used_at
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

export async function getCurrentUser(
  userId: string,
): Promise<AuthenticatedUser> {
  const profile = await withUserTransaction(userId, (client) =>
    getProfileForUser(client, userId),
  );

  if (!profile) {
    throw invalidSessionError;
  }

  return toAuthenticatedUser(profile);
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

export function readSessionTokenFromRequest(
  request: Request,
): string {
  const token = request.cookies?.[env.AUTH_COOKIE_NAME];

  if (typeof token !== "string") {
    throw invalidSessionError;
  }

  return token;
}
