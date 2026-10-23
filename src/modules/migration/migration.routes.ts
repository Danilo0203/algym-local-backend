import { Router, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../../config/env.js";
import { AppError } from "../../errors/app-error.js";
import { getAuthenticatedUserContext, readSessionTokenFromRequest, validateSessionToken } from "../auth/auth.service.js";
import { MAX_PACKAGE_BYTES, MigrationStore } from "./migration.store.js";

async function requireOwner(request: Request) {
  const session = await validateSessionToken(readSessionTokenFromRequest(request));
  const context = await getAuthenticatedUserContext(session.userId);
  if (!context.authorization.isOwner) throw new AppError(403, "FORBIDDEN", "Solo la cuenta propietaria puede importar datos.");
  return session;
}

export function createMigrationRouter(store: MigrationStore | null, authorize = requireOwner) {
  const router = Router();
  router.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });
  router.use(rateLimit({ windowMs: 60000, limit: 90, standardHeaders: true, legacyHeaders: false }));
  router.use((request, _response, next) => {
    // CORS alone is not CSRF protection. A same-origin browser must send this header.
    const origin = request.get("origin");
    if ((request.method !== "GET" && !origin) || (origin && !env.CORS_ORIGINS.includes(origin))) {
      next(new AppError(403, "INVALID_ORIGIN", "Origen de la solicitud no permitido.")); return;
    }
    next();
  });
  router.get("/", async (request, response, next) => {
    try { await authorize(request); response.json(store ? await store.info() : { available: false }); }
    catch (error) { next(error); }
  });
  // Status uses a random, expiring capability so it survives session replacement.
  // It exposes only progress, never customer data or a mutation.
  router.post("/jobs/:id/status", async (request, response, next) => {
    try {
      if (!store) throw new AppError(404, "NOT_AVAILABLE", "Importación no disponible.");
      response.json(await store.status(z.string().uuid().parse(request.params.id), request.get("x-algym-import-token") ?? ""));
    } catch (error) { next(error); }
  });
  router.post("/packages", async (request, response, next) => {
    try {
      const session = await authorize(request);
      if (!store) throw new AppError(503, "NOT_AVAILABLE", "Esta función requiere la instalación local de Windows actualizada.");
      if (!request.is("application/octet-stream")) throw new AppError(415, "INVALID_PACKAGE", "Selecciona un archivo .algym.");
      if (Number(request.get("content-length")) > MAX_PACKAGE_BYTES) throw new AppError(413, "PAYLOAD_TOO_LARGE", "El respaldo supera el límite de 256 MB.");
      response.status(201).json(await store.upload(session.userId, request));
    } catch (error) { next(error); }
  });
  router.post("/packages/:id/import", async (request, response, next) => {
    try {
      const session = await authorize(request);
      if (!store) throw new AppError(503, "NOT_AVAILABLE", "Importación no disponible.");
      const body = z.object({ confirmed: z.literal(true), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
      response.status(202).json(await store.start(z.string().uuid().parse(request.params.id), session.userId, session.sessionId, body.sha256));
    } catch (error) { next(error); }
  });
  router.post("/packages/:id/review", async (request, response, next) => {
    try {
      const session = await authorize(request);
      if (!store) throw new AppError(503, "NOT_AVAILABLE", "Actualización no disponible.");
      const body = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), baselineId: z.string().uuid().optional() }).strict().parse(request.body);
      response.status(202).json(await store.start(z.string().uuid().parse(request.params.id), session.userId, session.sessionId, body.sha256, {mode:"review",baselineId:body.baselineId}));
    } catch(error) { next(error); }
  });
  router.post("/packages/:id/update", async (request, response, next) => {
    try {
      const session = await authorize(request);
      if (!store) throw new AppError(503, "NOT_AVAILABLE", "Actualización no disponible.");
      const body = z.object({ confirmed:z.literal(true), sha256:z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
      response.status(202).json(await store.update(z.string().uuid().parse(request.params.id), session.userId, session.sessionId, body.sha256));
    } catch(error) { next(error); }
  });
  return router;
}

export const migrationRouter = createMigrationRouter(
  process.env.ALGYM_MIGRATION_ROOT ? new MigrationStore(process.env.ALGYM_MIGRATION_ROOT) : null,
);
