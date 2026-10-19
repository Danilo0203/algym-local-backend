import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const windows = fileURLToPath(new URL('../windows/', import.meta.url));
export const readonlyOptions = '-c default_transaction_read_only=on -c statement_timeout=180000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=240000 -c work_mem=4MB';
export function sourceConfig(config) {
  return { host: config.host, port: config.port, database: config.database, user: config.user, password: config.password,
    options: readonlyOptions, connectionTimeoutMillis: 10000, application_name: 'algym-readonly-export' };
}
export async function command(file, args, { env = process.env, timeout = 300000, maxOutput = 65536 } = {}) {
  return await new Promise((resolve, reject) => {
    let stdout = '', size = 0, expired = false;
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maxOutput) { expired = true; child.kill('SIGKILL'); } else stdout += chunk; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('No se pudo iniciar una herramienta de exportación.')); });
    child.on('exit', code => { clearTimeout(timer); code === 0 && !expired ? resolve(stdout) : reject(new Error('La preparación no terminó. Revisa la compatibilidad del respaldo y los recursos disponibles.')); });
  });
}
export async function prepareDump({ folder, pgBin, capturedAt, run = command }) {
  const temp = path.join(folder, 'temporary'); await mkdir(temp, { recursive: true, mode: 0o700 });
  try {
    await run('python3', [path.join(windows, 'extract-hostinger-dump.py'), path.join(folder, 'source.dump'),
      path.join(folder, 'source.json'), '--pg-restore', path.join(pgBin, 'pg_restore'), '--captured-at', capturedAt, '--archive-clock-commands']);
    await run(process.execPath, [path.join(windows, 'prepare-transfer.mjs'), path.join(folder, 'source.json'),
      path.join(folder, 'data.algym'), pgBin], { env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp }, timeout: 300000 });
    const report = JSON.parse(await readFile(path.join(folder, 'data.algym.report.json'), 'utf8'));
    if (!report.sha256 || report.customers === undefined) throw new Error('No se pudo verificar el archivo exportado.');
    return report;
  } finally {
    // The converter normally stops its disposable cluster. Also stop it after a timeout.
    for (const entry of await readdir(temp).catch(() => [])) {
      const cluster = path.join(temp, entry, 'postgres');
      if (entry.startsWith('algym-prepare-transfer-')) await run(path.join(pgBin, 'pg_ctl'), ['-D', cluster, '-m', 'immediate', '-w', 'stop'], { timeout: 15000 }).catch(() => {});
    }
    await rm(temp, { recursive: true, force: true });
    await rm(path.join(folder, 'source.json'), { force: true });
  }
}
export async function buildExport({ folder, source, pgBin, stage = () => {}, run = command }) {
  const client = new pg.Client(sourceConfig(source)); await client.connect();
  let capturedAt;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const check = await client.query("SELECT current_setting('transaction_read_only') AS readonly, transaction_timestamp() AS captured, pg_export_snapshot() AS snapshot");
    if (check.rows[0].readonly !== 'on') throw new Error('La conexión de origen debe ser de solo lectura.');
    const stored = await client.query('SELECT EXISTS(SELECT 1 FROM storage.objects LIMIT 1) AS files');
    if (stored.rows[0].files) throw new Error('El origen contiene archivos en Storage. Hay que preparar también esas imágenes antes de exportar.');
    capturedAt = check.rows[0].captured.toISOString();
    stage('Creando una copia consistente de Hostinger…');
    await run(path.join(pgBin, 'pg_dump'), ['--host', source.host, '--port', String(source.port), '--username', source.user,
      '--dbname', source.database, '--no-password', '--format=custom', '--compress=3', '--lock-wait-timeout=3000',
      '--snapshot', check.rows[0].snapshot, '--file', path.join(folder, 'source.dump')],
      { env: { ...process.env, PGPASSWORD: source.password, PGOPTIONS: readonlyOptions }, timeout: 180000 });
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { await client.end(); }
  if ((await stat(path.join(folder, 'source.dump'))).size > 1024 * 1024 * 1024) throw new Error('El respaldo completo supera el tamaño permitido. Requiere una exportación asistida.');
  stage('Preparando y verificando el archivo para Windows…');
  return await prepareDump({ folder, pgBin, capturedAt, run });
}
