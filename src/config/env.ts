import dotenv from "dotenv";
import { z } from "zod";

const environmentFile =
  process.env.ALGYM_ENV_FILE?.trim() || ".env";

const dotenvResult = dotenv.config({
  path: environmentFile,
});

if (dotenvResult.error && process.env.NODE_ENV !== "production") {
  console.warn(
    `No se pudo cargar el archivo de entorno: ${environmentFile}`,
  );
}

const environmentBooleanSchema = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  HOST: z.string().min(1).default("127.0.0.1"),

  PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(4000),

  DB_HOST: z.string().min(1).default("127.0.0.1"),

  DB_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(5432),

  DB_NAME: z.string().min(1).default("algym"),

  DB_USER: z.string().min(1).default("algym_app"),

  DB_PASSWORD: z
    .string()
    .min(1, "DB_PASSWORD es obligatoria"),

  DB_POOL_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10),

  CORS_ORIGINS: z
    .string()
    .default(
      "http://localhost:3000,http://127.0.0.1:3000",
    )
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  AUTH_COOKIE_NAME: z
    .string()
    .min(1)
    .default("algym_session"),

  AUTH_SESSION_TTL_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(12),

  AUTH_COOKIE_SECURE: environmentBooleanSchema,

  AUTH_COOKIE_SAME_SITE: z
    .enum(["lax", "strict", "none"])
    .default("lax"),

  TRUST_PROXY: environmentBooleanSchema,
});

const parsedEnvironment =
  environmentSchema.safeParse(process.env);

if (!parsedEnvironment.success) {
  console.error(
    "Variables de entorno inválidas:",
    parsedEnvironment.error.flatten().fieldErrors,
  );

  throw new Error(
    "No se pudo iniciar ALGYM por configuración inválida.",
  );
}

if (
  parsedEnvironment.data.AUTH_COOKIE_SAME_SITE === "none" &&
  !parsedEnvironment.data.AUTH_COOKIE_SECURE
) {
  throw new Error(
    "AUTH_COOKIE_SECURE debe ser true cuando AUTH_COOKIE_SAME_SITE es none.",
  );
}

export const env = parsedEnvironment.data;
