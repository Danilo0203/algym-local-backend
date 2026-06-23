import dotenv from "dotenv";

dotenv.config({
  path: process.env.ALGYM_ENV_FILE?.trim() || ".env",
});

process.env.NODE_ENV = "test";
process.env.DB_NAME = "algym_test";
process.env.AUTH_COOKIE_SECURE = "false";
process.env.AUTH_COOKIE_SAME_SITE = "lax";
process.env.AUTH_COOKIE_NAME =
  process.env.AUTH_COOKIE_NAME?.trim() || "algym_session";
