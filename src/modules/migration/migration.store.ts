import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Readable } from "node:stream";
import { z } from "zod";
import { AppError } from "../../errors/app-error.js";

const exec = promisify(execFile);
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
export const previewSchema = z.object({
  snapshotAt: z.string().datetime({ offset: true }), sha256: hash,
  customers: count, plans: count, memberships: count, payments: count,
  attendance: count, routines: count, images: count,
});
const metadataSchema = z.object({ userId: uuid, createdAt: z.number(), tokenHash: hash, preview: previewSchema });
const statusSchema = z.object({
  tokenHash: hash, state: z.enum(["running", "succeeded", "failed"]),
  message: z.string().max(500), updatedAt: z.string(),
});
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export type MigrationPreview = z.infer<typeof previewSchema>;

async function readJson(filename: string): Promise<unknown> {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error("Invalid metadata");
  return JSON.parse(await readFile(filename, "utf8"));
}
export async function inspectPackage(filename: string): Promise<MigrationPreview> {
  const tool = fileURLToPath(new URL("../../../windows/transfer.mjs", import.meta.url));
  try {
    const { stdout } = await exec(process.execPath, [tool, "inspect", filename], { timeout: 60000, maxBuffer: 65536, windowsHide: true });
    return previewSchema.parse(JSON.parse(stdout));
  } catch {
    throw new AppError(400, "INVALID_PACKAGE", "El archivo no es un respaldo AlGym válido o está incompleto.");
  }
}

export class MigrationStore {
  private uploading = false;
  private starting = false;
  constructor(readonly root: string, private inspect = inspectPackage) {}
  private folder(id: string) { return path.join(this.root, "inbox", uuid.parse(id)); }
  private async metadata(id: string) {
    try { return metadataSchema.parse(await readJson(path.join(this.folder(id), "metadata.json"))); }
    catch { throw new AppError(404, "PACKAGE_NOT_FOUND", "Selecciona el archivo nuevamente."); }
  }
  async info() {
    try {
      const heartbeat = z.object({ updatedAt: z.number() }).parse(await readJson(path.join(this.root, "outbox", "heartbeat.json")));
      return { available: Date.now() - heartbeat.updatedAt < 30000 };
    } catch { return { available: false }; }
  }
  private async requireReady() {
    if (!(await this.info()).available) throw new AppError(503, "MIGRATION_UNAVAILABLE", "El servicio de importación no está disponible. Revisa la instalación de Windows.");
  }
  async upload(userId: string, stream: Readable) {
    await this.requireReady();
    if (this.uploading) throw new AppError(409, "MIGRATION_BUSY", "Espera a que termine la carga actual.");
    this.uploading = true;
    const id = randomUUID(), token = randomBytes(32).toString("hex"), folder = this.folder(id);
    try {
      let files = 0;
      for (const name of await readdir(path.join(this.root, "inbox"))) {
        if (!uuid.safeParse(name).success) continue;
        const dir = this.folder(name);
        const entry = await lstat(dir);
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        // A queued job belongs to the worker; never remove it while it may be running.
        const queued = await lstat(path.join(dir, "request.json")).then(() => true, () => false);
        if ((!queued && Date.now() - entry.mtimeMs > 3600000) || Date.now() - entry.mtimeMs > 86400000) { await rm(dir, { recursive: true }); continue; }
        const finished = await readJson(path.join(this.root, "outbox", `${name}.json`)).then(value => {
          const parsed = statusSchema.safeParse(value);
          return parsed.success && ["succeeded", "failed"].includes(parsed.data.state);
        }, () => false);
        if (finished) await rm(path.join(dir, "data.algym"), { force: true });
        if (await lstat(path.join(dir, "data.algym")).then(() => true, () => false)) files++;
      }
      if (files >= 3) throw new AppError(429, "UPLOAD_LIMIT", "Hay archivos pendientes. Espera una hora antes de volver a cargar otro respaldo.");
      await mkdir(folder, { mode: 0o700 });
      const file = await open(path.join(folder, "data.algym"), "wx", 0o600);
      let size = 0;
      try {
        for await (const chunk of stream) {
          size += chunk.length;
          if (size > MAX_PACKAGE_BYTES) throw new AppError(413, "PAYLOAD_TOO_LARGE", "El respaldo supera el límite de 256 MB.");
          await file.writeFile(chunk);
        }
      } finally { await file.close(); }
      const preview = await this.inspect(path.join(folder, "data.algym"));
      await writeFile(path.join(folder, "metadata.json"), JSON.stringify({ userId, createdAt: Date.now(), tokenHash: tokenHash(token), preview }), { flag: "wx", mode: 0o600 });
      return { id, token, preview };
    } catch (error) {
      await rm(folder, { recursive: true, force: true }); throw error;
    } finally { this.uploading = false; }
  }
  async start(id: string, userId: string, sessionId: string, digest: string) {
    await this.requireReady();
    if (this.starting) throw new AppError(409, "MIGRATION_BUSY", "Ya se está preparando una importación.");
    this.starting = true;
    try {
      const metadata = await this.metadata(id);
      if (metadata.userId !== userId) throw new AppError(403, "FORBIDDEN", "El respaldo pertenece a otra sesión propietaria.");
      if (Date.now() - metadata.createdAt > 3600000 || metadata.preview.sha256 !== digest) throw new AppError(409, "PACKAGE_EXPIRED", "Selecciona y revisa el respaldo nuevamente.");
      const lock = await open(path.join(this.folder(id), "request.json"), "wx", 0o600).catch(() => null);
      if (!lock) return { id, state: "queued" };
      try {
        await lock.writeFile(JSON.stringify({ version: 1, userId, sessionId, sha256: digest, tokenHash: metadata.tokenHash, createdAt: Date.now() }));
      } finally { await lock.close(); }
      // The worker watches this final marker, never a partly written request.
      await writeFile(path.join(this.folder(id), "ready"), "", { flag: "wx", mode: 0o600 });
      return { id, state: "queued" };
    } finally { this.starting = false; }
  }
  async status(id: string, token: string) {
    const metadata = await this.metadata(id);
    const supplied = Buffer.from(tokenHash(token)), expected = Buffer.from(metadata.tokenHash);
    if (!/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(supplied, expected) || Date.now() - metadata.createdAt > 86400000)
      throw new AppError(404, "JOB_NOT_FOUND", "No se encontró esta importación.");
    try {
      const status = statusSchema.parse(await readJson(path.join(this.root, "outbox", `${id}.json`)));
      if (status.tokenHash !== metadata.tokenHash) throw new Error("Invalid status");
      if (["succeeded", "failed"].includes(status.state)) await rm(path.join(this.folder(id), "data.algym"), { force: true });
      return { state: status.state, message: status.message, updatedAt: status.updatedAt };
    } catch {
      return { state: "queued", message: "Esperando al servicio de importación…" };
    }
  }
}
