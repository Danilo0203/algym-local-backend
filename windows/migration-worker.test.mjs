import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { processJob } from './migration-worker.mjs';

test('worker confines jobs, rechecks owner, rejects changed files and recovers completed imports', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'algym-web-worker-'));
  await mkdir(path.join(root, 'private'));
  await mkdir(path.join(root, 'migration', 'outbox'), { recursive: true });
  await writeFile(path.join(root, 'private', 'installation.json'), '{}');
  let authorized = true, executions = 0;
  const bytes = Buffer.from('test package');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  async function job(digest = sha256) {
    const id = randomUUID(), folder = path.join(root, 'migration', 'inbox', id);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'data.algym'), bytes);
    await writeFile(path.join(folder, 'request.json'), JSON.stringify({ version: 1, userId: randomUUID(), sessionId: randomUUID(),
      sha256: digest, tokenHash: 'a'.repeat(64), createdAt: Date.now(), command: 'ignored', path: '../ignored' }));
    await writeFile(path.join(folder, 'ready'), ''); return id;
  }
  const run = id => processJob({ appRoot: '/trusted/app', dataRoot: root, id,
    authorizeJob: async () => { if (!authorized) throw new Error('Owner session required'); },
    executeJob: async (app, data, file, digest, result) => {
      executions++; assert.equal(app, '/trusted/app'); assert.equal(data, root); assert.equal(digest, sha256);
      assert.ok(file.startsWith(path.join(root, 'private'))); assert.deepEqual(await readFile(file), bytes);
      await writeFile(result, JSON.stringify({ success: true })); return 0;
    } });
  const status = async id => JSON.parse(await readFile(path.join(root, 'migration', 'outbox', id + '.json'), 'utf8'));
  try {
    await run('../escape'); assert.equal(executions, 0);
    authorized = false;
    const denied = await job(); await run(denied); assert.equal((await status(denied)).state, 'failed'); assert.equal(executions, 0);
    authorized = true;
    const changed = await job('b'.repeat(64)); await run(changed); assert.equal((await status(changed)).state, 'failed'); assert.equal(executions, 0);
    const good = await job(); await run(good); assert.equal((await status(good)).state, 'succeeded'); assert.equal(executions, 1);
    await run(good); assert.equal(executions, 1);
    await access(path.join(root, 'migration', 'inbox', good, 'data.algym')); // cleanup belongs to the low-privilege backend
    await writeFile(path.join(root, 'private', 'last-import.json'), JSON.stringify({ sha256 }));
    const recovered = await job();
    await writeFile(path.join(root, 'migration', 'outbox', recovered + '.json'), JSON.stringify({ state: 'running' }));
    authorized = false; await run(recovered); assert.equal((await status(recovered)).state, 'succeeded'); assert.equal(executions, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
