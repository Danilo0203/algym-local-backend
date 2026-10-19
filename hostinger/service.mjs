import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile, stat, rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import pg from 'pg';
import { buildExport, sourceConfig } from './pipeline.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export function ownerAuthorizer(config, { pool = new pg.Pool({ ...sourceConfig(config.source), max: 2, idleTimeoutMillis: 10000 }), fetcher = fetch } = {}) {
  return async function authorize(req) {
    const token = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token || token.length > 16000) throw new HttpError(401, 'Inicia sesión para exportar.');
    const response = await fetcher(config.authUrl + '/user', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new HttpError(401, 'La sesión no es válida. Inicia sesión otra vez.');
    const user = await response.json();
    let claims;
    try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')); } catch { throw new HttpError(401, 'Sesión inválida.'); }
    if (!uuid.test(user.id ?? '') || claims.sub !== user.id || !uuid.test(claims.session_id ?? '')) throw new HttpError(401, 'Sesión inválida.');
    // GoTrue validates the token, then the database rechecks the live role and session.
    // Never trust user_metadata, a browser role, or an old JWT role claim.
    const { rows } = await pool.query(`SELECT p.id FROM public.profiles p JOIN auth.sessions s ON s.user_id=p.id
      WHERE p.id=$1 AND s.id=$2 AND p.role::text='owner' AND p.is_active
        AND (s.not_after IS NULL OR s.not_after>now())`, [user.id, claims.session_id]);
    if (!rows.length) throw new HttpError(403, 'Solo una cuenta propietaria activa puede exportar.');
    return user.id;
  };
}
const publicJob = job => ({ id: job.id, state: job.state, message: job.message, createdAt: job.createdAt, expiresAt: job.expiresAt,
  ...(job.state === 'ready' ? { preview: job.preview } : {}) });
export class ExportJobs {
  jobs = new Map(); active = null;
  constructor(config, build = buildExport) { this.config = config; this.build = build; }
  async init() {
    await mkdir(this.config.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.config.root)) {
      if (!uuid.test(name)) continue;
      try {
        const job = JSON.parse(await readFile(path.join(this.config.root, name, 'job.json'), 'utf8'));
        if (job.id !== name || !uuid.test(job.userId) || !Number.isFinite(job.expiresAt)) continue;
        if (job.state === 'running') { job.state = 'failed'; job.message = 'La preparación se interrumpió. Genera una copia nueva.'; }
        this.jobs.set(name, job);
      } catch { /* An incomplete directory is never offered for download. */ }
    }
    await this.cleanup();
  }
  async cleanup() {
    for (const [id, job] of this.jobs) if (job.expiresAt < Date.now() && id !== this.active) {
      await rm(path.join(this.config.root, id), { recursive: true, force: true }); this.jobs.delete(id);
    }
  }
  async save(job) {
    const file = path.join(this.config.root, job.id, 'job.json');
    await writeFile(file + '.tmp', JSON.stringify(job), { mode: 0o600 });
    await rename(file + '.tmp', file);
  }
  get(id, userId) {
    const job = this.jobs.get(id);
    if (!job || job.userId !== userId || job.expiresAt < Date.now()) throw new HttpError(404, 'La exportación no existe o ya expiró.');
    return job;
  }
  latest(userId) { return [...this.jobs.values()].filter(j => j.userId === userId && j.expiresAt > Date.now()).sort((a,b) => b.createdAt-a.createdAt)[0]; }
  async start(id, userId) {
    if (!uuid.test(id)) throw new HttpError(400, 'Solicitud inválida.');
    if (this.jobs.has(id)) return publicJob(this.get(id, userId));
    if (this.active) throw new HttpError(409, 'Ya se está preparando un respaldo. Espera a que termine.');
    const latest = this.latest(userId);
    if (latest && Date.now()-latest.createdAt < 300000) throw new HttpError(429, 'Espera cinco minutos entre exportaciones. Puedes descargar la última copia disponible.');
    if (this.jobs.size >= 12) throw new HttpError(429, 'Se alcanzó el límite de copias temporales. Espera a que expiren.');
    this.active = id;
    const job = { id, userId, state: 'running', message: 'Preparando exportación…', createdAt: Date.now(), expiresAt: Date.now()+86400000 };
    try {
      await this.cleanup(); await mkdir(path.join(this.config.root, id), { mode: 0o700 });
      this.jobs.set(id, job); await this.save(job);
    } catch (error) { this.jobs.delete(id); this.active = null; throw error; }
    this.running = this.run(job);
    return publicJob(job);
  }
  async run(job) {
    try {
      const report = await this.build({ ...this.config, folder: path.join(this.config.root, job.id),
        stage: message => { job.message = message; } });
      job.preview = { snapshotAt: report.snapshotAt, sha256: report.sha256, customers: report.customers, plans: report.plans,
        memberships: report.memberships, payments: report.payments, attendance: report.attendance, routines: report.routines,
        archivedDeviceCommands: report.source?.archivedDeviceCommands ?? 0 };
      job.state = 'ready'; job.message = 'Archivo verificado y listo para descargar.';
    } catch (error) {
      job.state = 'failed'; job.message = /Storage/.test(error.message) ? 'Hay imágenes en Storage. Esta versión necesita preparar también esos archivos antes de exportar.' : 'No se pudo preparar una copia compatible. Los datos de Hostinger se conservaron; revisa el servicio antes de reintentar.';
    } finally {
      try { await this.save(job); }
      catch { job.state = 'failed'; job.message = 'No se pudo guardar la exportación. Revisa el espacio disponible antes de reintentar.'; }
      finally { this.active = null; }
    }
  }
}
export function createHandler({ jobs, authorize }) {
  const limits = new Map();
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const route = new URL(req.url, 'http://internal').pathname;
      if (req.method === 'GET' && route === '/health') { json(200, { status: 'ready' }); return; }
      const now = Date.now(), ip = req.socket.remoteAddress;
      for (const [key, item] of limits) if (item.until < now) limits.delete(key);
      const limit = limits.get(ip) ?? { count: 0, until: now+60000 }; limit.count++; limits.set(ip, limit);
      if (limit.count > 90 || limits.size > 10000) throw new HttpError(429, 'Demasiadas solicitudes. Espera un momento.');
      const userId = await authorize(req);
      if (route === '/jobs' && req.method === 'GET') { const job=jobs.latest(userId); json(200, { job: job ? publicJob(job) : null }); return; }
      if (route === '/jobs' && req.method === 'POST') {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1024) throw new HttpError(413, 'Solicitud demasiado grande.'); }
        let data; try { data = JSON.parse(body); } catch { throw new HttpError(400, 'Solicitud inválida.'); }
        if (data.confirmed !== true || !uuid.test(data.id ?? '') || Object.keys(data).some(k => !['id','confirmed'].includes(k))) throw new HttpError(400, 'Confirma la exportación antes de continuar.');
        json(202, await jobs.start(data.id, userId)); return;
      }
      const match = /^\/jobs\/([a-f0-9-]{36})(?:\/(file|archive))?$/.exec(route);
      if (!match || !uuid.test(match[1]) || req.method !== 'GET') throw new HttpError(404, 'Ruta no disponible.');
      const job = jobs.get(match[1], userId);
      if (!match[2]) { json(200, publicJob(job)); return; }
      if (job.state !== 'ready') throw new HttpError(409, 'El respaldo todavía no está listo.');
      const archive = match[2] === 'archive', filename = path.join(jobs.config.root, job.id, archive ? 'source.dump' : 'data.algym');
      const size = (await stat(filename)).size;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size,
        'Content-Disposition': `attachment; filename="Hostinger-AlGym-${job.preview.snapshotAt.replace(/[:.]/g,'-')}.${archive ? 'dump' : 'algym'}"` });
      await pipeline(createReadStream(filename), res);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      json(error.status ?? 503, { error: error.status ? error.message : 'El exportador no está disponible temporalmente.' });
    }
  };
}
