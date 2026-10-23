import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, cp, readFile } from 'node:fs/promises';
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

test('fresh private cluster, 38 migrations, owner login, retry, and foreign-instance protection', {
  skip: !process.env.ALGYM_INSTALLER_PG_BIN, timeout: 120000,
}, async () => {
  const bin = process.env.ALGYM_INSTALLER_PG_BIN;
  const root = await mkdtemp(path.join(tmpdir(), 'algym-installer-test-'));
  const data = path.join(root, 'postgres');
  const migrationDir = fileURLToPath(new URL('../database/migrations/', import.meta.url));
  const request = { installationId: randomUUID(), host: '127.0.0.1', port: await freePort(),
    database: 'algym_windows', adminPassword: randomBytes(32).toString('hex'),
    appPassword: randomBytes(32).toString('hex'), syncPassword: randomBytes(32).toString('hex'),
    owner: { name: 'Propietario de prueba', email: 'owner@example.test', password: 'Test-only password 123' } };
  const executable = (name) => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
  const run = (name, args) => execFileSync(executable(name), args, { encoding: 'utf8', stdio: 'pipe',
    env: { ...process.env, PGPASSWORD: request.adminPassword } });
  let started = false;
  let api;
  let admin;
  try {
    await writeFile(path.join(root, 'password'), request.adminPassword, { mode: 0o600 });
    run('initdb', ['-D', data, '-U', 'postgres', '--encoding=UTF8', '--locale=C', '--auth=scram-sha-256',
      '--pwfile=' + path.join(root, 'password')]);
    const socket = process.platform === 'win32' ? '' : `-k "${root}"`;
    run('pg_ctl', ['-D', data, '-w', '-l', path.join(root, 'postgres.log'), '-o',
      `-h 127.0.0.1 -p ${request.port} ${socket} -c cluster_name=AlGym-${request.installationId}`, 'start']);
    started = true;
    assert.deepEqual(await bootstrap(request), { ok: true, migrations: 38 });
    admin = new pg.Client({ host: request.host, port: request.port, user: 'postgres',
      password: request.adminPassword, database: request.database });
    await admin.connect();
    const user = (await admin.query('SELECT id, encrypted_password FROM auth.users')).rows[0];
    assert.equal(await bcrypt.compare(request.owner.password, user.encrypted_password), true);
    assert.equal((await admin.query('SELECT count(*)::int AS n FROM public.cash_registers')).rows[0].n, 1);
    assert.equal((await admin.query("SELECT rolsuper OR rolbypassrls AS privileged FROM pg_roles WHERE rolname='algym_app'")).rows[0].privileged, false);
    assert.equal((await admin.query("SELECT pg_has_role('algym_app', 'service_role', 'MEMBER') AS member")).rows[0].member, false);
    const applied = await admin.query('SELECT name, sha256, applied_at FROM algym_installer.migrations ORDER BY name');
    await bootstrap({ ...request, owner: null });
    assert.deepEqual((await admin.query('SELECT name, sha256, applied_at FROM algym_installer.migrations ORDER BY name')).rows, applied.rows);
    assert.equal((await admin.query('SELECT id FROM auth.users')).rows[0].id, user.id);
    await assert.rejects(bootstrap({ ...request, installationId: randomUUID() }), /no pertenece/);
    const modified = path.join(root, 'migrations');
    await cp(migrationDir, modified, { recursive: true });
    const first = path.join(modified, '0001_local_auth_compat.sql');
    await writeFile(first, (await readFile(first, 'utf8')) + '\n-- altered\n');
    await assert.rejects(bootstrap(request, modified), /alterada/);
    const apiPort = await freePort();
    api = spawn(process.execPath, [fileURLToPath(new URL('../dist/server.js', import.meta.url))], {
      env: { ...process.env, ALGYM_ENV_FILE: path.join(root, 'no-environment-file'), NODE_ENV: 'production',
        HOST: '127.0.0.1', PORT: String(apiPort), DB_HOST: request.host, DB_PORT: String(request.port),
        DB_NAME: request.database, DB_USER: 'algym_app', DB_PASSWORD: request.appPassword,
        LOCAL_MEDIA_ROOT: path.join(root, 'media'), AUTH_COOKIE_SECURE: 'false' }, stdio: 'pipe',
    });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { ready = (await fetch(`http://127.0.0.1:${apiPort}/health/ready`)).ok; } catch { }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(ready, true, 'compiled backend must start against the newly installed database');
    const response = await fetch(`http://127.0.0.1:${apiPort}/auth/login`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: request.owner.email, password: request.owner.password }) });
    assert.equal(response.status, 200, await response.text());
    assert.match(response.headers.get('set-cookie'), /algym_session=/);
    // Exercise media in the compiled Windows payload: preserve GIF and allow MP4 for clients.
    const ownerCookie = response.headers.get('set-cookie').split(';')[0];
    const requestJson = (url, body, cookie = ownerCookie) => fetch(`http://127.0.0.1:${apiPort}${url}`, {
      method: 'POST', headers: {'Content-Type':'application/json',cookie}, body:JSON.stringify(body) });
    const mp4 = await readFile(new URL('./fixtures/exercise.mp4', import.meta.url));
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
    const created = [];
    for (const [bytes,extension] of [[gif,'gif'],[mp4,'mp4']]) {
      const upload = await requestJson('/exercises/with-image',{name:`Demo ${extension}`,image_base64:bytes.toString('base64')});
      assert.equal(upload.status,201); const item=await upload.json();
      assert.ok(item.image_url.endsWith(`.${extension}`)); created.push(item);
    }
    const clientId=randomUUID(); const clientPassword='Client media test 123';
    await admin.query("INSERT INTO auth.users(id,email,encrypted_password,raw_user_meta_data,created_at,updated_at) VALUES($1,$2,$3,'{}',now(),now())",
      [clientId,'media-client@example.test',await bcrypt.hash(clientPassword,10)]);
    await admin.query("INSERT INTO public.profiles(id,full_name,phone,birth_date,gender,role,biometric_id,is_active) VALUES($1,'Cliente MP4','55555555','1990-01-01','male','client',999991,true)",[clientId]);
    const routine=(await admin.query("INSERT INTO public.routines(user_id,created_by,name,status,is_active) VALUES($1,$2,'Rutina MP4','active',true) RETURNING id",[clientId,user.id])).rows[0];
    for(const item of created) await admin.query('INSERT INTO public.routine_details(routine_id,day_of_week,exercise_id) VALUES($1,1,$2)',[routine.id,item.id]);
    const login=await requestJson('/auth/login',{email:'media-client@example.test',password:clientPassword});
    assert.equal(login.status,200); const clientCookie=login.headers.get('set-cookie').split(';')[0];
    const routineResponse=await fetch(`http://127.0.0.1:${apiPort}/me/routine`,{headers:{cookie:clientCookie}});
    assert.equal(routineResponse.status,200); const details=(await routineResponse.json()).workspace.activeDetails;
    for(const item of created) assert.ok(details.some(d=>d.exercise_image_url===item.image_url));
    for(const [index,bytes] of [gif,mp4].entries()) {
      const mediaUrl=`http://127.0.0.1:${apiPort}${created[index].image_url.replace('/api','')}`;
      const media=await fetch(mediaUrl,{headers:{cookie:clientCookie}});
      assert.equal(media.status,200);assert.deepEqual(Buffer.from(await media.arrayBuffer()),bytes);
      assert.equal((await fetch(mediaUrl)).status,401);
    }
    const videoUrl=`http://127.0.0.1:${apiPort}${created[1].image_url.replace('/api','')}`;
    const range=await fetch(videoUrl,{headers:{cookie:clientCookie,range:'bytes=0-1'}});
    assert.equal(range.status,206);assert.equal(range.headers.get('content-type'),'video/mp4');
    assert.deepEqual(Buffer.from(await range.arrayBuffer()),mp4.subarray(0,2));
    assert.equal((await fetch(videoUrl,{headers:{cookie:clientCookie,range:`bytes=${mp4.length}-`}})).status,416);

    const connection = ['-h', request.host, '-p', String(request.port), '-U', 'postgres'];
    run('pg_dump', [...connection, '-d', request.database, '-Fc', '-f', path.join(root, 'backup.dump')]);
    await admin.query('CREATE DATABASE algym_restore_verification');
    run('pg_restore', [...connection, '-d', 'algym_restore_verification', '--exit-on-error', path.join(root, 'backup.dump')]);
    const restored = new pg.Client({ host: request.host, port: request.port, user: 'postgres',
      password: request.adminPassword, database: 'algym_restore_verification' });
    await restored.connect();
    try {
      assert.equal((await restored.query('SELECT id FROM auth.users')).rows[0].id, user.id);
      assert.equal((await restored.query('SELECT count(*)::int AS n FROM algym_installer.migrations')).rows[0].n, 38);
    } finally { await restored.end(); }
  } finally {
    if (api && api.exitCode === null) {
      const ended = new Promise((resolve) => api.once('exit', resolve)); api.kill('SIGTERM'); await ended;
    }
    await admin?.end();
    if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    await rm(root, { recursive: true, force: true });
  }
});
