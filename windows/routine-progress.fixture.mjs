import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { bootstrap } from './bootstrap.mjs';

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// All databases, roles, credentials and media belong to a new disposable cluster.
export async function createRoutineProgressFixture() {
  const bin = process.env.ALGYM_INSTALLER_PG_BIN;
  if (!bin) throw new Error('ALGYM_INSTALLER_PG_BIN is required');
  const root = await mkdtemp(path.join(tmpdir(), 'algym-progress-test-'));
  const data = path.join(root, 'postgres');
  const request = { installationId: randomUUID(), host: '127.0.0.1', port: await freePort(),
    database: 'algym_windows', adminPassword: randomBytes(32).toString('hex'),
    appPassword: randomBytes(32).toString('hex'), syncPassword: randomBytes(32).toString('hex'),
    owner: { name: 'Propietario de prueba', email: 'owner@example.test', password: 'Test-only password 123' } };
  const config = { host: request.host, port: request.port, user: 'postgres', password: request.adminPassword, database: 'algym_test' };
  const run = (name, args) => execFileSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')), args,
    { encoding: 'utf8', stdio: name === 'pg_ctl' ? 'ignore' : 'pipe', windowsHide: true,
      env: { ...process.env, PGPASSWORD: request.adminPassword } });
  let started = false;
  let api;
  let admin;
  const close = async () => {
    if (api && api.exitCode === null) {
      const ended = new Promise((resolve) => api.once('exit', resolve)); api.kill(); await ended;
    }
    await admin?.end();
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    // mkdtemp is the sole source of this path; never delete outside that directory.
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('algym-progress-test-')) throw new Error('Unsafe fixture path');
    await rm(root, { recursive: true, force: true });
  };
  try {
    await writeFile(path.join(root, 'password'), request.adminPassword, { mode: 0o600 });
    run('initdb', ['-D', data, '-U', 'postgres', '--encoding=UTF8', '--locale=C', '--auth=scram-sha-256', '--pwfile=' + path.join(root, 'password')]);
    run('pg_ctl', ['-D', data, '-w', '-l', path.join(root, 'postgres.log'), '-o',
      `-h 127.0.0.1 -p ${request.port} ${process.platform === 'win32' ? '' : `-k "${root}"`} -c cluster_name=AlGym-${request.installationId}`, 'start']);
    started = true;
    await bootstrap(request);
    const setup = new pg.Client({ ...config, database: 'postgres' });
    await setup.connect();
    try { await setup.query('CREATE DATABASE algym_test TEMPLATE algym_windows'); } finally { await setup.end(); }
    admin = new pg.Client(config);
    await admin.connect();
    const apiPort = await freePort();
    let apiOutput = '';
    api = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.js', import.meta.url))], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ALGYM_ENV_FILE: path.join(root, 'no-environment-file'), NODE_ENV: 'production',
        HOST: '127.0.0.1', PORT: String(apiPort), DB_HOST: request.host, DB_PORT: String(request.port),
        DB_NAME: 'algym_test', DB_USER: 'algym_app', DB_PASSWORD: request.appPassword,
        LOCAL_MEDIA_ROOT: path.join(root, 'media'), AUTH_COOKIE_SECURE: 'false', LOG_LEVEL: 'fatal' },
    });
    api.stdout.on('data', (chunk) => { apiOutput = (apiOutput + chunk).slice(-4000); });
    api.stderr.on('data', (chunk) => { apiOutput = (apiOutput + chunk).slice(-4000); });
    const baseUrl = `http://127.0.0.1:${apiPort}`;
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { ready = (await fetch(`${baseUrl}/health/ready`)).ok; } catch { /* startup */ }
      if (ready) break;
      if (api.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error(`Isolated backend failed to start: ${apiOutput}`);
    const createClient = async (label) => {
      const id = randomUUID();
      const email = `${id}@progress.example.test`;
      const password = 'Client progress test 123';
      await admin.query("INSERT INTO auth.users(id,email,encrypted_password,raw_user_meta_data,created_at,updated_at) VALUES($1,$2,$3,'{}',now(),now())",
        [id, email, await bcrypt.hash(password, 10)]);
      await admin.query("INSERT INTO public.profiles(id,full_name,phone,birth_date,gender,role,is_active) VALUES($1,$2,'55555555','1990-01-01','male','client',true)", [id, label]);
      const login = await fetch(`${baseUrl}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      if (login.status !== 200) throw new Error('Synthetic client login failed');
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const routineId = (await admin.query("INSERT INTO public.routines(user_id,name,status,is_active) VALUES($1,'Rutina de prueba','active',true) RETURNING id", [id])).rows[0].id;
      const detailIds = [];
      for (const [day, name] of [[1, 'Abdominal bicicleta'], [1, 'Sentadilla'], [2, 'Abdominal bicicleta']]) {
        detailIds.push(Number((await admin.query(`INSERT INTO public.routine_details(routine_id,day_of_week,exercise_order,exercise_name_snapshot,sets,reps,rest_seconds)
          VALUES($1,$2,$3,$4,4,'10',15) RETURNING id`, [routineId, day, detailIds.length + 1, name])).rows[0].id));
      }
      return { id, email, password, cookie, routineId, detailIds };
    };
    return { baseUrl, admin, appConfig: { ...config, user: 'algym_app', password: request.appPassword }, createClient, close };
  } catch (error) { await close(); throw error; }
}
