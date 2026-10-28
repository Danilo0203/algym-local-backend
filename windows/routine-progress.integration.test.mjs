import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createRoutineProgressFixture } from './routine-progress.fixture.mjs';

test('routine progress persists, is private, resets only one day and handles routine changes', {
  skip: !process.env.ALGYM_INSTALLER_PG_BIN, timeout: 120000,
}, async () => {
  const fixture = await createRoutineProgressFixture();
  try {
    const first = await fixture.createClient('Cliente primero');
    const second = await fixture.createClient('Cliente segundo');
    const [one, two, otherDay] = first.detailIds;
    const send = (path, method = 'GET', body, cookie = first.cookie) => fetch(`${fixture.baseUrl}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const endpoint = (id, routineId = first.routineId) => `/me/routine/${routineId}/details/${id}/completion`;
    const mark = (id, completed = true) => send(endpoint(id), 'PUT', { completed });
    const progress = async () => (await (await send('/me/routine')).json()).progress.completedDetailIds;
    const resetPath = `/me/routine/${first.routineId}/days/1/completion`;

    assert.equal((await send(endpoint(one), 'PUT', { completed: true }, null)).status, 401);
    assert.equal((await send(resetPath, 'DELETE', undefined, null)).status, 401);
    assert.equal((await send(endpoint(one), 'PUT', { completed: 'true' })).status, 400);
    assert.equal((await send(endpoint(one), 'PUT', { completed: true, userId: second.id })).status, 400);
    assert.equal((await send(endpoint(one), 'PUT', { completed: true }, second.cookie)).status, 404);
    assert.equal((await send(resetPath, 'DELETE', undefined, second.cookie)).status, 404);
    assert.equal((await send(endpoint(second.detailIds[0]), 'PUT', { completed: true })).status, 404);
    assert.deepEqual(await progress(), []);

    assert.equal((await mark(one)).status, 200);
    assert.equal((await mark(one)).status, 200); // Idempotent retries.
    assert.deepEqual(await progress(), [one]);
    assert.equal((await mark(one, false)).status, 200);
    assert.deepEqual(await progress(), []);
    const concurrent = await Promise.all([mark(one), mark(two), mark(otherDay)]);
    assert.ok(concurrent.every((response) => response.status === 200));
    assert.deepEqual(await progress(), first.detailIds);
    assert.deepEqual((await (await send('/me/routine', 'GET', undefined, second.cookie)).json()).progress.completedDetailIds, []);
    assert.equal((await send(resetPath, 'DELETE')).status, 200);
    assert.deepEqual(await progress(), [otherDay]);
    assert.equal((await send(resetPath, 'DELETE')).status, 200);
    assert.equal((await send(`/me/routine/${first.routineId}/days/3/completion`, 'DELETE')).status, 404);
    assert.equal((await send(`/me/routine/${first.routineId}/days/8/completion`, 'DELETE')).status, 400);

    await mark(one);
    await fixture.admin.query('UPDATE public.routine_details SET notes = $2 WHERE id = $1', [one, 'Respira durante el ejercicio']);
    assert.deepEqual(await progress(), [one, otherDay]);
    await fixture.admin.query('UPDATE public.routine_details SET reps = $2 WHERE id = $1', [one, '12']);
    assert.deepEqual(await progress(), [otherDay]);
    await fixture.admin.query('DELETE FROM public.routine_details WHERE id = $1', [otherDay]);
    assert.deepEqual(await progress(), []);

    // Database policies also protect clients if a route forgets an ownership filter.
    const app = new pg.Client(fixture.appConfig);
    await app.connect();
    try {
      await app.query("SELECT set_config('app.current_user_id', $1, false)", [second.id]);
      await assert.rejects(app.query('INSERT INTO public.routine_exercise_completions(user_id,detail_id) VALUES($1,$2)', [second.id, one]), { code: '42501' });
      await mark(one);
      assert.equal((await app.query('SELECT * FROM public.routine_exercise_completions')).rowCount, 0);
      assert.equal((await app.query('DELETE FROM public.routine_exercise_completions WHERE detail_id = $1', [one])).rowCount, 0);
    } finally { await app.end(); }
    await fixture.admin.query("UPDATE public.routines SET status = 'archived', is_active = false WHERE id = $1", [first.routineId]);
    assert.equal((await mark(one)).status, 404);
    assert.equal((await send(resetPath, 'DELETE')).status, 404);
    assert.deepEqual((await (await send('/me/routine')).json()).progress, { routineId: null, completedDetailIds: [] });
  } finally { await fixture.close(); }
});
