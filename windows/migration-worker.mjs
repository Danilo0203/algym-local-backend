// Windows-only privileged worker. No HTTP listener, shell command, SQL, or path
// can be supplied by a web request. Only fixed data-import jobs are accepted.
import { readFile, writeFile, rename, lstat, readdir, mkdir, copyFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const terminal = state => ['succeeded', 'failed'].includes(state);
async function json(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('Invalid metadata');
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}
async function atomicJson(file, data) {
  await writeFile(file + '.tmp', JSON.stringify(data), { mode: 0o600 });
  await rename(file + '.tmp', file);
}
async function authorize(request, installation) {
  const client = new pg.Client({ host: installation.host, port: installation.port, database: installation.database,
    user: 'postgres', password: installation.adminPassword, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.current_user_id',$1,true)", [request.userId]);
    const { rows } = await client.query(`SELECT 1 FROM auth.sessions s JOIN public.profiles p ON p.id=s.user_id
      WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>now()
        AND p.is_active AND public.is_owner()`, [request.sessionId, request.userId]);
    if (!rows.length) throw new Error('Owner session required');
  } finally { await client.query('ROLLBACK').catch(() => {}); await client.end(); }
}
async function execute(appRoot, dataRoot, packageFile, digest, resultFile) {
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(appRoot, 'tools', 'Apply-AlGymData.ps1'), '-AppRoot', appRoot, '-DataRoot', dataRoot,
      '-Package', packageFile, '-ExpectedHash', digest, '-Headless', '-ResultPath', resultFile],
    { windowsHide: true, stdio: 'ignore' });
    child.on('error', reject); child.on('exit', code => resolve(code));
  });
}
function safeMessage(error) {
  const message = String(error?.message ?? error);
  if (/ya tiene datos|instalación nueva|otro respaldo/i.test(message)) return 'Este equipo ya tiene datos. La importación inicial no puede reemplazar operaciones existentes.';
  if (/versión|esquema|migracion/i.test(message)) return 'La versión del respaldo no coincide con la instalación. Prepara un paquete compatible.';
  if (/Owner session required/.test(message)) return 'La sesión propietaria expiró. Inicia sesión y vuelve a seleccionar el respaldo.';
  return 'No se completó la importación. Conserva el respaldo y revisa la instalación antes de reintentar.';
}

export async function processJob({ appRoot, dataRoot, id, authorizeJob = authorize, executeJob = execute }) {
  if (!uuid.test(id)) return;
  const root = path.join(dataRoot, 'migration'), folder = path.join(root, 'inbox', id);
  const output = path.join(root, 'outbox', `${id}.json`);
  const prior = await json(output).catch(() => null);
  if (terminal(prior?.state)) return;
  let request, work;
  const status = (state, message) => atomicJson(output, { tokenHash: request.tokenHash, state, message, updatedAt: new Date().toISOString() });
  try {
    if ((await lstat(folder)).isSymbolicLink() || !(await lstat(folder)).isDirectory()) return;
    await lstat(path.join(folder, 'ready'));
    request = await json(path.join(folder, 'request.json'));
    if (request.version !== 1 || !uuid.test(request.userId) || !uuid.test(request.sessionId) ||
        !hash.test(request.sha256) || !hash.test(request.tokenHash) || !Number.isFinite(request.createdAt)) return;
    const completed = await json(path.join(dataRoot, 'private', 'last-import.json')).catch(() => null);
    // Recover a job interrupted after COMMIT but before its browser status was written.
    if (prior?.state === 'running' && completed?.sha256 === request.sha256) {
      await status('succeeded', 'Este respaldo ya está importado. Los registros se conservaron sin duplicarlos.'); return;
    }
    if (Date.now() - request.createdAt > 1800000 || request.createdAt > Date.now() + 60000) throw new Error('Owner session required');
    const installation = await json(path.join(dataRoot, 'private', 'installation.json'));
    await authorizeJob(request, installation);
    await status('running', 'Preparando el respaldo previo. El sistema se reconectará al terminar.');
    const file = path.join(folder, 'data.algym'), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 268435456) throw new Error('Invalid package');
    work = path.join(dataRoot, 'private', `web-import-${id}`);
    await mkdir(work, { mode: 0o700 });
    const copy = path.join(work, 'data.algym'); await copyFile(file, copy);
    const bytes = await readFile(copy);
    if (bytes.length > 268435456 || createHash('sha256').update(bytes).digest('hex') !== request.sha256) throw new Error('Package changed');
    const resultFile = path.join(work, 'result.json');
    const code = await executeJob(appRoot, dataRoot, copy, request.sha256, resultFile);
    const result = await json(resultFile).catch(() => null);
    if (code !== 0 || !result?.success) throw new Error(result?.message ?? 'Import incomplete');
    await status('succeeded', 'Importación verificada. Inicia sesión con una cuenta del respaldo.');
  } catch (error) {
    if (request && hash.test(request.tokenHash)) await status('failed', safeMessage(error));
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
    if (await json(output).then(r => terminal(r.state), () => false)) await rm(path.join(folder, 'data.algym'), { force: true });
  }
}

async function main() {
  const [appRoot, dataRoot] = process.argv.slice(2);
  if (process.platform !== 'win32' || !path.isAbsolute(appRoot ?? '') || !path.isAbsolute(dataRoot ?? '')) throw new Error('Windows installation required');
  const root = path.join(dataRoot, 'migration');
  const heartbeat = () => atomicJson(path.join(root, 'outbox', 'heartbeat.json'), { updatedAt: Date.now() });
  const timer = setInterval(() => heartbeat().catch(() => {}), 5000);
  await heartbeat();
  try {
    while (true) {
      for (const id of await readdir(path.join(root, 'inbox'))) {
        if (!uuid.test(id)) continue;
        await processJob({ appRoot, dataRoot, id });
        const folder = path.join(root, 'inbox', id);
        const info = await lstat(folder).catch(() => null);
        if (info?.isDirectory() && !info.isSymbolicLink() && Date.now() - info.mtimeMs > 86400000) {
          await rm(folder, { recursive: true, force: true });
          await rm(path.join(root, 'outbox', `${id}.json`), { force: true });
        }
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  } finally { clearInterval(timer); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('El servicio de importación no pudo continuar.'); process.exitCode = 1; });
}
