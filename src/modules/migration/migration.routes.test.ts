import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
// These tests never connect to PostgreSQL, including when a developer has .env.
process.env.DB_PASSWORD = "unused";
process.env.DB_HOST = "127.0.0.1"; process.env.DB_PORT = "1"; process.env.DB_NAME = "unused_migration_tests";
const { createMigrationRouter } = await import("./migration.routes.js");
const { MigrationStore } = await import("./migration.store.js");
const { AppError } = await import("../../errors/app-error.js");
const origin = "http://127.0.0.1:3000";
test("web import requires owner and origin, confirms the reviewed package, and protects status capabilities", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "algym-migration-routes-"));
  const userId = randomUUID(), sessionId = randomUUID(); let allowed = true;
  await mkdir(path.join(root, "inbox")); await mkdir(path.join(root, "outbox"));
  await writeFile(path.join(root, "outbox", "heartbeat.json"), JSON.stringify({ updatedAt: Date.now() }));
  const digest = "a".repeat(64);
  const store = new MigrationStore(root, async filename => {
    if ((await readFile(filename)).toString() !== "valid") throw new AppError(400, "INVALID_PACKAGE", "Paquete inválido");
    return { snapshotAt: new Date().toISOString(), sha256: digest, customers: 178, plans: 9, memberships: 524, payments: 551, attendance: 15904, routines: 133, images: 0 };
  });
  const app = express(); app.use(express.json());
  app.use(createMigrationRouter(store, async () => {
    if (!allowed) throw new AppError(403, "FORBIDDEN", "Solo propietario"); return { userId, sessionId };
  }));
  app.use(((error, _req, res, _next) => { res.status(error.statusCode ?? 400).json({ error: { message: error.message } }); }) as ErrorRequestHandler);
  try {
    assert.equal((await request(app).post("/packages").set("Content-Type", "application/octet-stream").send("valid")).status, 403);
    assert.equal((await request(app).post("/packages").set("Origin", "https://evil.test").send({})).status, 403);
    allowed = false;
    assert.equal((await request(app).get("/")).status, 403);
    assert.equal((await request(app).post("/packages").set("Origin", origin).set("Content-Type", "application/octet-stream").send("valid")).status, 403);
    allowed = true;
    assert.equal((await request(app).post("/packages").set("Origin", origin).set("Content-Type", "application/octet-stream").send("bad")).status, 400);
    const uploaded = await request(app).post("/packages").set("Origin", origin).set("Content-Type", "application/octet-stream").send("valid");
    assert.equal(uploaded.status, 201);
    const { id, token } = uploaded.body;
    assert.equal((await request(app).post(`/packages/${id}/import`).set("Origin", origin).send({ confirmed: false, sha256: digest })).status, 400);
    assert.equal((await request(app).post(`/packages/${id}/import`).set("Origin", origin).send({ confirmed: true, sha256: "b".repeat(64) })).status, 409);
    assert.equal((await request(app).post(`/packages/${id}/import`).set("Origin", origin).send({ confirmed: true, sha256: digest })).status, 202);
    const queued = JSON.parse(await readFile(path.join(root, "inbox", id, "request.json"), "utf8"));
    assert.equal(queued.userId, userId); assert.equal(queued.sessionId, sessionId); assert.equal(queued.sha256, digest);
    allowed = false; // The old account/session disappears during an actual import.
    const endpoint = `/jobs/${id}/status`;
    assert.equal((await request(app).post(endpoint).set("Origin", origin).set("x-algym-import-token", "0".repeat(64))).status, 404);
    assert.equal((await request(app).post(endpoint).set("Origin", origin).set("x-algym-import-token", token)).body.state, "queued");
    await writeFile(path.join(root, "outbox", `${id}.json`), JSON.stringify({ tokenHash: queued.tokenHash, state: "succeeded", message: "Listo", updatedAt: new Date().toISOString() }));
    const done = await request(app).post(endpoint).set("Origin", origin).set("x-algym-import-token", token);
    assert.equal(done.body.state, "succeeded"); assert.equal(done.body.tokenHash, undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
