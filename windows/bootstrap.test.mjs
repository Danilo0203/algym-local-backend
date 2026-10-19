import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, splitMigration } from './bootstrap.mjs';

const request = { installationId: '12345678-1234-1234-1234-123456789abc', host: '127.0.0.1',
  port: 55432, database: 'algym_windows', adminPassword: 'a'.repeat(64),
  appPassword: 'b'.repeat(64), syncPassword: 'c'.repeat(64),
  owner: { name: 'Propietario', email: 'owner@example.test', password: 'una clave privada' } };
test('refuses remote, conventional production ports, foreign databases and unsafe role passwords', () => {
  for (const change of [{ host: '192.168.1.10' }, { port: 5432 }, { database: 'algym' },
    { adminPassword: "'; DROP ROLE algym_app; --" }, { installationId: 'bad' }]) {
    assert.throws(() => validateRequest({ ...request, ...change }));
  }
  assert.equal(validateRequest(request), request);
});
test('enforces bcrypt byte limit and minimum initial password length', () => {
  for (const password of ['short', 'á'.repeat(37)]) {
    assert.throws(() => validateRequest({ ...request, owner: { ...request.owner, password } }));
  }
});
test('keeps enum prelude separate and rejects an unknown migration transaction shape', () => {
  const result = splitMigration("-- enum\nALTER TYPE role ADD VALUE 'custom';\nBEGIN;\nSELECT 1;\nCOMMIT;\n");
  assert.match(result.before, /ALTER TYPE/);
  assert.match(result.body, /SELECT 1/);
  assert.throws(() => splitMigration('CREATE TABLE unsafe(id int);'));
  assert.throws(() => splitMigration('BEGIN;\nSELECT 1;\nCOMMIT;\nDROP TABLE x;'));
});
