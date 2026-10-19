import pino from "pino";

import { env } from "./env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: "algym-local-backend",
    environment: env.NODE_ENV,
  },
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      "req.headers['x-algym-import-token']",
      "res.headers.set-cookie",
      "res.headers['set-cookie']",
    ],
    censor: "[Redacted]",
  },
});
