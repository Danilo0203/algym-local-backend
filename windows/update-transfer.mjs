// Three-way updates: the imported snapshot is the ancestor, never the live source.
// All reconciliation is local. No source connection or clock command is performed.
import pg from 'pg';
import { readFile, writeFile, mkdir, lstat, realpath, unlink } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRequest } from './bootstrap.mjs';
import { readPackage, validatePackage, assertTarget, tableRows, insertTables, verifyForeignKeys, sha } from './transfer.mjs';

const quote = s => '"' + s.replaceAll('"', '""') + '"';
const name = t => `${t.schema}.${t.name}`;
const sqlName = t => `${quote(t.schema)}.${quote(t.name)}`;
const protectedTables = new Set(['public.device_commands', 'public.roles', 'public.permissions', 'public.role_permissions']);
const keyOf = (t, row) => JSON.stringify(t.pk.map(c => row[t.columns.indexOf(c)]));
const equal = (t, a, b) => !!a && !!b && t.columns.every((c, i) => c === 'updated_at' || a[i] === b[i]);
const snapshotTime = data => Date.parse(data.source?.capturedAt ?? data.createdAt);
const digestRows = tables => sha(JSON.stringify(tables.map(t => [name(t), t.rows.map(r => sha(JSON.stringify(r))).sort()])));
const rowObject = (t, row) => Object.fromEntries(t.columns.map((c, i) => [c, row[i]]));
function indexRows(t, rows) {
  const result = new Map();
  for (const row of rows) {
    const key = keyOf(t, row);
    if (t.pk.some(c => row[t.columns.indexOf(c)] === null) || result.has(key)) throw new Error('El respaldo contiene identificadores repetidos o incompletos.');
    result.set(key, row);
  }
  return result;
}
function businessKeys(t, row) {
  const r = rowObject(t, row);
  const normalized = v => String(v ?? '').trim().toLowerCase().normalize('NFKC');
  const out = [];
  if (name(t) === 'public.attendance_logs') out.push(['attendance', r.device_id, r.biometric_id, r.punch_time, r.status1, r.status2]);
  if (name(t) === 'auth.users' && r.email) out.push(['email', normalized(r.email)]);
  if (name(t) === 'public.profiles') {
    if (r.biometric_id !== null) out.push(['biometric', r.biometric_id]);
    if (r.device_id !== null) out.push(['device', r.device_id]);
    if (r.phone?.replace(/\D/g, '').length >= 7) out.push(['person-phone', r.phone.replace(/\D/g, ''), r.birth_date]);
    if (r.full_name && r.birth_date) out.push(['person-name', normalized(r.full_name).replace(/\s+/g, ' '), r.birth_date]);
  }
  if (name(t) === 'public.payments' && r.user_id && r.payment_date) {
    const timestamp = Date.parse(r.payment_date);
    if (Number.isFinite(timestamp)) out.push(['possible-payment', r.user_id, new Date(timestamp - 21600000).toISOString().slice(0, 10), r.amount_paid, r.method]);
  }
  if (name(t) === 'public.subscriptions') out.push(['membership', r.user_id, r.plan_id, r.start_date, r.end_date]);
  if (name(t) === 'public.plans') out.push(['plan', normalized(r.name), r.duration_days, r.price]);
  return out.map(x => JSON.stringify(x));
}

export function planUpdate({base, incoming, local, metadata, mappings = {}}) {
  const maps = structuredClone(mappings), conflicts = [], operations = [], totals = { inserted: 0, updated: 0, retained: 0, unchanged: 0, duplicates: 0, ignoredDeletions: 0 };
  const perTable = [], projected = [], catalogs = new Map(metadata.map(t => [name(t), t]));
  const conflict = (t, reason) => {
    const previous = conflicts.find(c => c.table === name(t) && c.reason === reason);
    if (previous) previous.count++; else conflicts.push({table: name(t), reason, count: 1});
  };
  const byName = data => new Map(data.tables.map(t => [name(t), t]));
  const oldTables = byName(base), newTables = byName(incoming), liveTables = byName(local);
  const getMap = t => maps[name(t)] ??= {};
  const historical = new Set();
  for (const t of metadata) {
    if (protectedTables.has(name(t))) continue;
    for (const row of oldTables.get(name(t)).rows) getMap(t)[keyOf(t,row)] ??= t.pk.map(c=>row[t.columns.indexOf(c)]);
    for (const destination of Object.values(getMap(t))) historical.add(name(t)+':'+JSON.stringify(destination));
  }
  // Allocate collisions only for newly created numeric primary keys. Existing IDs
  // never change, and the source-to-local mapping is committed with the snapshot.
  for (const t of metadata) {
    if (protectedTables.has(name(t))) continue;
    const old = indexRows(t, oldTables.get(name(t)).rows), current = indexRows(t, liveTables.get(name(t)).rows);
    const fresh = indexRows(t, newTables.get(name(t)).rows);
    let next = 0n;
    if (t.numericPk) for (const rows of [current, fresh]) for (const row of rows.values()) next = BigInt(row[t.columns.indexOf(t.pk[0])]) > next ? BigInt(row[t.columns.indexOf(t.pk[0])]) : next;
    if (t.numericPk) for (const values of Object.values(getMap(t))) if (BigInt(values[0]) > next) next = BigInt(values[0]);
    const attendance = new Map();
    if (name(t) === 'public.attendance_logs') for (const row of current.values()) attendance.set(businessKeys(t, row)[0], row);
    for (const [sourceKey, row] of fresh) {
      if (old.has(sourceKey) || getMap(t)[sourceKey]) continue;
      if (name(t) === 'public.attendance_logs') {
        const duplicate = attendance.get(businessKeys(t, row)[0]);
        if (duplicate) { getMap(t)[sourceKey] = t.pk.map(c => duplicate[t.columns.indexOf(c)]); continue; }
      }
      if (current.has(sourceKey) && t.numericPk) getMap(t)[sourceKey] = [(++next).toString()];
      else getMap(t)[sourceKey] = t.pk.map(c => row[t.columns.indexOf(c)]);
    }
  }
  function transform(t, row) {
    const result = [...row], mapped = maps[name(t)]?.[keyOf(t, row)];
    if (mapped) t.pk.forEach((c, i) => { result[t.columns.indexOf(c)] = mapped[i]; });
    for (const fk of t.foreignKeys) {
      const target = catalogs.get(fk.table);
      if (!target || JSON.stringify(target.pk) !== JSON.stringify(fk.targetColumns)) continue;
      const sourceKey = JSON.stringify(fk.columns.map(c => row[t.columns.indexOf(c)]));
      const values = maps[fk.table]?.[sourceKey];
      if (values) fk.columns.forEach((c, i) => { result[t.columns.indexOf(c)] = values[i]; });
    }
    return result;
  }
  const locallyChangedParents = new Set(), locallyChanged = new Set();
  // A source update must not overwrite an aggregate referenced by local activity.
  for (const t of metadata) {
    if (protectedTables.has(name(t))) continue;
    const old = indexRows(t, oldTables.get(name(t)).rows.map(r => transform(t, r)));
    for (const row of liveTables.get(name(t)).rows) if (!equal(t, old.get(keyOf(t, row)), row)) {
      locallyChanged.add(name(t)+':'+keyOf(t,row));
      for (const fk of t.foreignKeys) locallyChangedParents.add(fk.table + ':' + JSON.stringify(fk.columns.map(c => row[t.columns.indexOf(c)])));
    }
  }
  for (const t of metadata) {
    const stats = {table: name(t), inserted: 0, updated: 0, retained: 0, unchanged: 0, duplicates: 0, ignoredDeletions: 0};
    perTable.push(stats);
    const count = kind => { totals[kind]++; stats[kind]++; };
    const current = indexRows(t, liveTables.get(name(t)).rows), result = new Map(current);
    const old = indexRows(t, oldTables.get(name(t)).rows.map(r => transform(t, r)));
    const freshRows = newTables.get(name(t)).rows.map(r => transform(t, r));
    const fresh = indexRows(t, freshRows);
    if (protectedTables.has(name(t))) {
      current.forEach(() => count('retained'));
      if (name(t) === 'public.device_commands' && fresh.size) conflict(t, 'clock_commands');
      projected.push({...t, rows: [...result.values()]}); continue;
    }
    const natural = new Map();
    for (const row of current.values()) for (const key of businessKeys(t, row)) {
      if (!natural.has(key)) natural.set(key, new Set()); natural.get(key).add(keyOf(t, row));
    }
    for (const [key, remote] of fresh) {
      const ancestor = old.get(key), here = current.get(key);
      if (!ancestor) {
        if (here && name(t) === 'public.attendance_logs') {
          // The clock's event identity is independent of each database sequence.
          const stable = t.columns.every((c, i) => ['id', 'created_at', 'raw_line'].includes(c) || here[i] === remote[i]);
          if (stable) { count('duplicates'); continue; }
          conflict(t, 'different_clock_event'); continue;
        }
        if (here) { if (equal(t, here, remote)) count('duplicates'); else conflict(t, 'id_collision'); continue; }
        if (historical.has(name(t)+':'+key)) { conflict(t, 'changed_after_local_deletion'); continue; }
        const sharedFinancialActivity = t.foreignKeys.some(fk => {
          if (!['public.products','public.cash_sessions','public.subscriptions'].includes(fk.table)) return false;
          const parent = fk.table+':'+JSON.stringify(fk.columns.map(c=>remote[t.columns.indexOf(c)]));
          return locallyChanged.has(parent) || locallyChangedParents.has(parent);
        });
        if (sharedFinancialActivity) { conflict(t, 'local_related_activity'); continue; }
        let duplicate = false;
        for (const naturalKey of businessKeys(t, remote)) {
          if (natural.has(naturalKey)) duplicate = true;
          if (!natural.has(naturalKey)) natural.set(naturalKey, new Set()); natural.get(naturalKey).add(key);
        }
        if (duplicate) { conflict(t, 'possible_duplicate'); continue; }
        if (name(t) === 'public.profiles' && remote[t.columns.indexOf('role')] !== 'client') { conflict(t, 'protected_account'); continue; }
        result.set(key, remote); operations.push({kind: 'insert', table: t, row: remote}); count('inserted');
      } else if (!here) {
        if (!equal(t, ancestor, remote)) conflict(t, 'changed_after_local_deletion');
        else count('retained'); // Do not resurrect a local deletion.
      } else if (t.schema === 'auth') {
        count('retained'); // Existing passwords, identities and account state stay local.
      } else if (equal(t, ancestor, remote)) {
        count(equal(t, ancestor, here) ? 'unchanged' : 'retained');
      } else if (!equal(t, ancestor, here)) {
        conflict(t, 'changed_both');
      } else if (locallyChangedParents.has(name(t) + ':' + key)) {
        conflict(t, 'local_related_activity');
      } else if (name(t) === 'public.profiles' && ['role','is_active','biometric_id','device_id'].some(c => remote[t.columns.indexOf(c)] !== ancestor[t.columns.indexOf(c)])) {
        conflict(t, 'protected_account_or_clock');
      } else {
        result.set(key, remote); operations.push({kind: 'update', table: t, row: remote}); count('updated');
      }
    }
    for (const key of current.keys()) if (!fresh.has(key)) count(old.has(key) ? 'ignoredDeletions' : 'retained');
    projected.push({...t, rows: [...result.values()]});
  }
  return {totals, perTable, conflicts, operations, projected, mappings: maps};
}

async function readMetadata(client, tables) {
  const result = [];
  for (const t of tables) {
    const primary = (await client.query(`SELECT a.attname AS col, a.atttypid::regtype::text AS type FROM pg_constraint c
      CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(num,ord)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num
      WHERE c.conrelid=$1::regclass AND c.contype='p' ORDER BY k.ord`, [sqlName(t)])).rows;
    if (!primary.length) throw new Error('Una tabla no tiene una identidad compatible con la actualización.');
    const foreignKeys = (await client.query(`SELECT ns.nspname||'.'||cl.relname AS "table",
      array_agg(a.attname::text ORDER BY k.ord) AS columns, array_agg(b.attname::text ORDER BY k.ord) AS "targetColumns"
      FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY k(src,dst,ord)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.src
      JOIN pg_attribute b ON b.attrelid=c.confrelid AND b.attnum=k.dst
      JOIN pg_class cl ON cl.oid=c.confrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace
      WHERE c.conrelid=$1::regclass AND c.contype='f' GROUP BY c.oid,ns.nspname,cl.relname`, [sqlName(t)])).rows;
    result.push({...t, pk: primary.map(r => r.col), numericPk: primary.length === 1 && ['integer','bigint','smallint'].includes(primary[0].type), foreignKeys});
  }
  return result;
}
async function applyRows(client, plan) {
  await client.query('SET LOCAL session_replication_role=replica');
  for (const operation of plan.operations) {
    const {table: t, row} = operation;
    if (operation.kind === 'insert') await insertTables(client, [{...t, rows: [row]}]);
    else {
      const conditions = t.pk.map((c, i) => `${quote(c)}=$${row.length + i + 1}`).join(' AND ');
      const updated = await client.query(`UPDATE ${sqlName(t)} SET ${t.columns.map((c, i) => `${quote(c)}=$${i+1}`).join(',')} WHERE ${conditions}`, [...row, ...t.pk.map(c => row[t.columns.indexOf(c)])]);
      if (updated.rowCount !== 1) throw new Error('Los datos locales cambiaron. Revisa la actualización nuevamente.');
    }
  }
  await verifyForeignKeys(client);
  for (const t of plan.projected) {
    const actual = await tableRows(client, t);
    if (digestRows([{...t, rows: actual}]) !== digestRows([t])) throw new Error('La verificación final no coincide. Se conservaron los datos anteriores.');
  }
}
async function advanceSequences(client, incoming) {
  const sequences = (await client.query(`SELECT ns.nspname AS schema, s.relname AS name, tn.nspname AS "tableSchema", t.relname AS "tableName", a.attname AS col
    FROM pg_class s JOIN pg_namespace ns ON ns.oid=s.relnamespace
    LEFT JOIN pg_depend d ON d.objid=s.oid AND d.classid='pg_class'::regclass AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
    LEFT JOIN pg_class t ON t.oid=d.refobjid LEFT JOIN pg_namespace tn ON tn.oid=t.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
    WHERE s.relkind='S' AND ns.nspname='public'`)).rows;
  for (const s of sequences) {
    const current = (await client.query(`SELECT last_value::text,is_called FROM ${sqlName(s)}`)).rows[0];
    let next = BigInt(current.last_value) + (current.is_called ? 1n : 0n);
    const remote = incoming.sequences.find(v => v.schema === s.schema && v.name === s.name);
    if (remote) { const value = BigInt(remote.last_value) + (remote.is_called ? 1n : 0n); if (value > next) next = value; }
    if (s.name === 'profiles_biometric_id_seq' && !s.col) Object.assign(s, {tableSchema:'public',tableName:'profiles',col:'biometric_id'});
    if (s.col) {
      const value = (await client.query(`SELECT (COALESCE(MAX(${quote(s.col)}),0)+1)::text AS n FROM ${quote(s.tableSchema)}.${quote(s.tableName)}`)).rows[0].n;
      if (BigInt(value) > next) next = BigInt(value);
    }
    await client.query(`ALTER SEQUENCE ${sqlName(s)} RESTART WITH ${next}`);
  }
}
async function copyMedia(data, root, created) {
  if ((await lstat(root)).isSymbolicLink() || !(await lstat(root)).isDirectory()) throw new Error('Carpeta multimedia inválida.');
  for (const file of data.media) {
    const dir = path.join(root, file.path.split('/')[0]); await mkdir(dir, {recursive: true});
    if ((await lstat(dir)).isSymbolicLink() || path.dirname(await realpath(dir)) !== await realpath(root)) throw new Error('Ruta multimedia inválida.');
    const target = path.join(root, file.path), bytes = Buffer.from(file.base64, 'base64');
    try { await writeFile(target, bytes, {flag:'wx', mode:0o600}); created.push(target); }
    catch (error) { if (error.code !== 'EEXIST' || (await lstat(target)).isSymbolicLink() || sha(await readFile(target)) !== file.sha256) throw error; }
  }
}

export async function updatePackage(raw, filename, mediaRoot, expectedHash, {baselineFile, preview = false, expectedPlan} = {}) {
  const request = validateRequest({...raw, owner:null});
  const incoming = await readPackage(filename);
  const incomingBytes = await readFile(filename);
  if (sha(incomingBytes) !== incoming.sha256) throw new Error('El respaldo cambió después de la revisión.');
  if (incoming.sha256 !== expectedHash) throw new Error('El respaldo cambió después de la revisión.');
  const client = new pg.Client({host:request.host, port:request.port, database:request.database, user:'postgres', password:request.adminPassword, connectionTimeoutMillis:10000});
  const created = []; let committed = false;
  await client.connect();
  try {
    await client.query("BEGIN; SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO,YMD'");
    await client.query('SELECT pg_advisory_xact_lock(829417,1)');
    const tables = await assertTarget(client, request, incoming.data);
    await client.query(`LOCK TABLE ${tables.map(sqlName).join(',')},algym_installer.state IN SHARE ROW EXCLUSIVE MODE`);
    const state = new Map((await client.query('SELECT key,value FROM algym_installer.state')).rows.map(r => [r.key,r.value]));
    if (!state.get('import_sha256')) throw new Error('Completa primero la importación inicial.');
    const saved = state.has('merge_snapshot') ? JSON.parse(state.get('merge_snapshot')) : null;
    let baseline;
    if (saved) {
      const bytes = Buffer.from(saved.packageBase64, 'base64');
      if (sha(bytes) !== saved.sha256) throw new Error('La referencia de actualización está dañada.');
      baseline = {sha256:saved.sha256, data:validatePackage(JSON.parse(gunzipSync(bytes,{maxOutputLength:512*1024*1024}).toString('utf8')))};
    } else {
      if (!baselineFile) throw new Error('Selecciona también el respaldo original que se importó en esta computadora.');
      baseline = await readPackage(baselineFile);
      if (baseline.sha256 !== state.get('import_sha256')) throw new Error('El respaldo original no coincide con el que se importó en esta computadora.');
    }
    await assertTarget(client, request, baseline.data);
    if (incoming.sha256 === baseline.sha256) {
      await client.query('ROLLBACK');
      return {version:1, sha256:incoming.sha256, canApply:false, alreadyApplied:true, totals:{inserted:0,updated:0,retained:0,unchanged:0,duplicates:0,ignoredDeletions:0}, tables:[], conflicts:[]};
    }
    if (baseline.data.source?.kind !== 'Hostinger' || incoming.data.source?.kind !== 'Hostinger' || !(snapshotTime(incoming.data) > snapshotTime(baseline.data)))
      throw new Error('Selecciona una copia de Hostinger posterior a la última actualización.');
    const owners = data => { const t=data.tables.find(t=>name(t)==='public.profiles'); return t.rows.filter(r=>r[t.columns.indexOf('role')]==='owner').map(r=>r[t.columns.indexOf('id')]); };
    if (!owners(baseline.data).some(id=>owners(incoming.data).includes(id))) throw new Error('La copia no corresponde a las cuentas de origen de esta instalación.');
    const metadata = await readMetadata(client, tables), local = {tables:[]};
    for (const t of metadata) local.tables.push({...t, rows:await tableRows(client,t)});
    const plan = planUpdate({base:baseline.data, incoming:incoming.data, local, metadata, mappings:saved?.mappings});
    const planHash = sha(JSON.stringify([baseline.sha256,incoming.sha256,digestRows(local.tables),plan.mappings,plan.totals,plan.conflicts]));
    const report = {version:1, sha256:incoming.sha256, baseSha256:baseline.sha256, snapshotAt:incoming.data.source.capturedAt,
      planHash, canApply:plan.conflicts.length===0, totals:plan.totals, tables:plan.perTable, conflicts:plan.conflicts};
    if (!preview && (!expectedPlan || expectedPlan !== planHash)) throw new Error('Los datos locales cambiaron. Revisa la actualización nuevamente.');
    if (plan.conflicts.length) { await client.query('ROLLBACK'); return report; }
    // Preview applies the projected rows inside a rolled-back transaction to
    // check every unique/check/FK constraint. No sequences or files are changed.
    await client.query('SAVEPOINT validation');
    try { await applyRows(client, plan); }
    catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT validation');
      if (['23505','23514','23503','23502','22P02','22003'].includes(error.code) || /Hay referencias incompletas/.test(error.message)) {
        report.canApply=false; report.conflicts.push({table: error.table ? `public.${error.table}` : 'integridad',reason:'constraint',count:1});
        await client.query('ROLLBACK'); return report;
      }
      throw error;
    }
    if (preview) { await client.query('ROLLBACK'); return report; }
    await copyMedia(incoming.data, mediaRoot, created);
    await advanceSequences(client, incoming.data);
    const snapshot = {sha256:incoming.sha256, packageBase64:incomingBytes.toString('base64'), mappings:plan.mappings};
    await client.query("INSERT INTO algym_installer.state(key,value) VALUES ('merge_snapshot',$1),('last_update_report',$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(snapshot),JSON.stringify(report)]);
    await client.query('COMMIT'); committed=true;
    return {...report, applied:true};
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>{});
    if (!committed) for (const file of created) await unlink(file).catch(()=>{});
    if (error.code) throw new Error(`Actualización detenida (${error.code}). Los datos anteriores se conservaron.`);
    throw error;
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [action,file,digest] = process.argv.slice(2);
    if (!['review','update'].includes(action)) throw new Error('Acción inválida.');
    let input=''; for await (const chunk of process.stdin) { input+=chunk; if(input.length>20000) throw new Error('Solicitud inválida.'); }
    const raw=JSON.parse(input.replace(/^\uFEFF/,''));
    console.log(JSON.stringify(await updatePackage(raw,file,raw.mediaRoot,digest,{baselineFile:raw.baselineFile,preview:action==='review',expectedPlan:raw.expectedPlan})));
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
