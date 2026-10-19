// Portable data only: the importer never executes SQL or paths supplied by a package.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, readdir, unlink, realpath } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { validateRequest } from './bootstrap.mjs';

const LIMIT = 512 * 1024 * 1024;
const id = (s) => '"' + s.replaceAll('"', '""') + '"';
const qualified = (t) => `${id(t.schema)}.${id(t.name)}`;
const key = (t) => `${t.schema}.${t.name}`;
export const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const migrationDirectory = fileURLToPath(new URL('../database/migrations/', import.meta.url));

export async function migrationHashes() {
  const names = (await readdir(migrationDirectory)).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
  return Promise.all(names.map(async (name) => ({ name, sha256: sha(await readFile(path.join(migrationDirectory, name))) })));
}

export async function catalog(client) {
  const rows = (await client.query(`SELECT n.nspname AS schema, c.relname AS name,
    array_agg(a.attname::text ORDER BY a.attnum) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated=''
    WHERE c.relkind='r' AND (n.nspname='public' OR (n.nspname='auth' AND c.relname IN ('users','identities')))
    GROUP BY n.nspname,c.relname ORDER BY n.nspname,c.relname`)).rows;
  return rows;
}

export async function tableRows(client, t) {
  return (await client.query(`SELECT json_build_array(${t.columns.map((c) => `${id(c)}::text`).join(',')}) AS row
    FROM ${qualified(t)}`)).rows.map((r) => r.row);
}

function assertImage(file) {
  if (!/^(exercises|products|avatars)\/[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp)$/.test(file.path ?? '') ||
      typeof file.base64 !== 'string' || file.base64.length > 7 * 1024 * 1024) throw new Error('Archivo de imagen inválido.');
  const bytes = Buffer.from(file.base64, 'base64');
  if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString('base64') !== file.base64 ||
      sha(bytes) !== file.sha256 || path.basename(file.path).split('.')[0] !== file.sha256) throw new Error('La imagen no coincide con su hash.');
  const ext = path.extname(file.path);
  const valid = ext === '.png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) :
    ext === '.gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString()) :
    ext === '.webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' :
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!valid) throw new Error('El contenido de una imagen no corresponde a su formato.');
  return bytes;
}

export function validatePackage(data) {
  if (data?.kind !== 'AlGym.Transfer' || data.version !== 1 || !Number.isFinite(Date.parse(data.createdAt)) ||
      !Array.isArray(data.tables) || data.tables.length < 2 || data.tables.length > 100 ||
      !Array.isArray(data.migrations) || !Array.isArray(data.sequences) || data.sequences.length > 100 ||
      !Array.isArray(data.media) || data.media.length > 100000) throw new Error('El archivo no es un paquete de migración AlGym compatible.');
  const names = new Set();
  for (const t of data.tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(t.name ?? '') ||
        !(t.schema === 'public' || t.schema === 'auth' && ['users', 'identities'].includes(t.name)) ||
        names.has(key(t)) || !Array.isArray(t.columns) || !t.columns.length || t.columns.length > 160 ||
        new Set(t.columns).size !== t.columns.length || t.columns.some((c) => !/^[a-z][a-z0-9_]*$/.test(c)) ||
        !Array.isArray(t.rows) || t.rows.some((r) => !Array.isArray(r) || r.length !== t.columns.length ||
          r.some((v) => v !== null && typeof v !== 'string'))) throw new Error('Tabla o fila inválida en el paquete.');
    names.add(key(t));
  }
  const files = new Map();
  for (const f of data.media) { if (files.has(f.path)) throw new Error('Imagen duplicada.'); files.set(f.path, assertImage(f)); }
  for (const [name, fields] of [['exercises', ['image_url', 'animation_url']], ['products', ['image_url']], ['profiles', ['avatar_url']]]) {
    const t = data.tables.find((t) => t.schema === 'public' && t.name === name);
    if (!t) continue;
    for (const field of fields) {
      const index = t.columns.indexOf(field);
      if (index < 0) continue;
      for (const row of t.rows) {
        const url = row[index];
        if (url && (!url.startsWith('/api/media/') || !files.has(url.slice(11)))) {
          throw new Error(`Falta una imagen local de ${name}. Prepare los archivos antes de importar.`);
        }
      }
    }
  }
  const users = data.tables.find((t) => key(t) === 'auth.users');
  const profiles = data.tables.find((t) => key(t) === 'public.profiles');
  if (!users || !profiles) throw new Error('Faltan las cuentas del sistema.');
  const owners = profiles.rows.filter((r) => r[profiles.columns.indexOf('role')] === 'owner' && r[profiles.columns.indexOf('is_active')] === 'true')
    .map((r) => r[profiles.columns.indexOf('id')]);
  if (!users.rows.some((r) => owners.includes(r[users.columns.indexOf('id')]) &&
      /^\$2[aby]\$/.test(r[users.columns.indexOf('encrypted_password')] ?? '') &&
      r[users.columns.indexOf('deleted_at')] === null)) throw new Error('El paquete requiere una cuenta propietaria activa con contraseña local.');
  return data;
}

export async function readPackage(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > LIMIT / 2) throw new Error('Archivo inválido o demasiado grande (máximo 256 MB).');
  const bytes = await readFile(filename);
  if (bytes.length > LIMIT / 2) throw new Error('Archivo demasiado grande.');
  let data;
  try { data = JSON.parse(gunzipSync(bytes, { maxOutputLength: LIMIT }).toString('utf8')); }
  catch { throw new Error('El paquete está dañado o supera el límite de 512 MB descomprimido.'); }
  return { data: validatePackage(data), sha256: sha(bytes) };
}

export function summary(data, digest) {
  const count = (name) => data.tables.find((t) => key(t) === name)?.rows.length ?? 0;
  return { kind: data.kind, createdAt: data.createdAt, snapshotAt: data.source?.capturedAt ?? data.createdAt, sha256: digest,
    users: count('auth.users'), customers: data.tables.find((t) => key(t) === 'public.profiles')?.rows
      .filter((r) => r[data.tables.find((t) => key(t) === 'public.profiles').columns.indexOf('role')] === 'client').length ?? 0,
    plans: count('public.plans'), memberships: count('public.subscriptions'), payments: count('public.payments'),
    attendance: count('public.attendance_logs'), routines: count('public.routines'), images: data.media.length,
    tables: data.tables.map((t) => ({ name: key(t), count: t.rows.length })) };
}

export async function exportPackage(client, mediaRoot, source = {}) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await client.query("SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO,YMD'");
    const tables = await catalog(client);
    for (const t of tables) t.rows = await tableRows(client, t);
    const sequences = (await client.query(`SELECT schemaname AS schema,sequencename AS name FROM pg_sequences
      WHERE schemaname='public' ORDER BY sequencename`)).rows;
    for (const s of sequences) Object.assign(s, (await client.query(`SELECT last_value::text,is_called FROM ${qualified(s)}`)).rows[0]);
    const media = [];
    if (mediaRoot) {
      for (const dir of ['exercises', 'products', 'avatars']) {
        const folder = path.join(mediaRoot, dir);
        let entries;
        try { if ((await lstat(folder)).isSymbolicLink()) throw new Error('No se admiten enlaces en media.'); entries = await readdir(folder); }
        catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        for (const name of entries) {
          const file = path.join(folder, name);
          if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) throw new Error('Archivo de media inválido.');
          const bytes = await readFile(file);
          media.push({ path: `${dir}/${name}`, sha256: sha(bytes), base64: bytes.toString('base64') });
        }
      }
    }
    const data = validatePackage({ kind: 'AlGym.Transfer', version: 1, createdAt: new Date().toISOString(), source,
      migrations: await migrationHashes(), tables, sequences, media });
    await client.query('COMMIT');
    return data;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
}

export async function writePackage(filename, data) {
  validatePackage(data);
  const bytes = gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 });
  if (bytes.length > LIMIT / 2) throw new Error('Paquete demasiado grande.');
  await writeFile(filename, bytes, { mode: 0o600, flag: 'wx' });
  return summary(data, sha(bytes));
}

async function assertTarget(client, request, data) {
  const identity = (await client.query(`SELECT current_setting('cluster_name') AS cluster,
    shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()`)).rows[0];
  if (identity?.cluster !== `AlGym-${request.installationId}` || identity.marker !== `AlGym Windows ${request.installationId}`)
    throw new Error('La base no pertenece a esta instalación de Windows.');
  const expected = await migrationHashes();
  const applied = (await client.query('SELECT name,sha256 FROM algym_installer.migrations ORDER BY name')).rows;
  if (JSON.stringify(data.migrations) !== JSON.stringify(expected) || JSON.stringify(applied) !== JSON.stringify(expected))
    throw new Error('La versión del paquete y del instalador no coincide. Prepare el paquete para esta versión.');
  const target = await catalog(client);
  if (target.length !== data.tables.length || target.some((t) => {
    const source = data.tables.find((s) => key(s) === key(t));
    return !source || JSON.stringify(source.columns) !== JSON.stringify(t.columns);
  })) throw new Error('El esquema de los datos no coincide con la versión instalada.');
  return target;
}

async function assertEmpty(client, tables) {
  const seed = new Set(['auth.users','auth.identities','public.profiles','public.roles','public.permissions','public.role_permissions','public.cash_registers']);
  for (const t of tables) {
    if (!seed.has(key(t)) && (await client.query(`SELECT 1 FROM ${qualified(t)} LIMIT 1`)).rowCount)
      throw new Error('Esta instalación ya tiene datos. La importación inicial no puede reemplazar operaciones existentes.');
  }
  const u = (await client.query('SELECT count(*)::int AS n FROM auth.users')).rows[0].n;
  const p = (await client.query("SELECT count(*)::int AS n FROM public.profiles WHERE role='owner' AND is_active")).rows[0].n;
  const all = (await client.query('SELECT count(*)::int AS n FROM public.profiles')).rows[0].n;
  const registers = (await client.query('SELECT name FROM public.cash_registers')).rows;
  if (u !== 1 || p !== 1 || all !== 1 || registers.length !== 1 || registers[0].name !== 'Caja principal' ||
      (await client.query('SELECT 1 FROM auth.identities LIMIT 1')).rowCount)
    throw new Error('El destino debe ser una instalación nueva con su cuenta propietaria inicial.');
}

export async function verifyForeignKeys(client) {
  const constraints = (await client.query(`SELECT con.conname,ns.nspname AS schema,cl.relname AS name,
    rn.nspname AS refschema,rc.relname AS refname,con.confmatchtype,
    ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY x(num,ord)
      JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=x.num ORDER BY x.ord) AS cols,
    ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY x(num,ord)
      JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=x.num ORDER BY x.ord) AS refs
    FROM pg_constraint con JOIN pg_class cl ON cl.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=cl.relnamespace
    JOIN pg_class rc ON rc.oid=con.confrelid JOIN pg_namespace rn ON rn.oid=rc.relnamespace
    WHERE con.contype='f' AND ns.nspname IN ('public','auth')`)).rows;
  for (const c of constraints) {
    const present = c.cols.map((x) => `a.${id(x)} IS NOT NULL`).join(' AND ');
    const match = c.cols.map((x,i) => `a.${id(x)}=b.${id(c.refs[i])}`).join(' AND ');
    const partial = c.confmatchtype === 'f' ? ` OR ((${c.cols.map((x) => `a.${id(x)} IS NULL`).join(' OR ')}) AND (${c.cols.map((x) => `a.${id(x)} IS NOT NULL`).join(' OR ')}))` : '';
    if ((await client.query(`SELECT 1 FROM ${qualified(c)} a WHERE ((${present}) AND NOT EXISTS
      (SELECT 1 FROM ${id(c.refschema)}.${id(c.refname)} b WHERE ${match})) ${partial} LIMIT 1`)).rowCount)
      throw new Error(`Hay referencias incompletas en ${c.name}. No se importó la base.`);
  }
}

export async function insertTables(client, tables) {
  for (const t of tables) {
    const batchSize = Math.max(1, Math.floor(10000 / t.columns.length));
    for (let start = 0; start < t.rows.length; start += batchSize) {
      const batch = t.rows.slice(start, start + batchSize);
      const params = batch.flat();
      const values = batch.map((r,i) => '(' + r.map((_,j) => '$' + (i*t.columns.length+j+1)).join(',') + ')').join(',');
      await client.query(`INSERT INTO ${qualified(t)} (${t.columns.map(id).join(',')}) OVERRIDING SYSTEM VALUE VALUES ${values}`, params);
    }
  }
}

export async function importPackage(raw, filename, mediaRoot, expectedHash, preview = false) {
  const request = validateRequest({ ...raw, owner: null });
  const { data, sha256 } = await readPackage(filename);
  if (expectedHash !== sha256) throw new Error('El archivo cambió después de la revisión. Selecciónelo de nuevo.');
  const client = new pg.Client({ host: request.host, port: request.port, database: request.database,
    user: 'postgres', password: request.adminPassword, connectionTimeoutMillis: 10000, application_name: 'algym-data-import' });
  await client.connect();
  const created = [];
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='120s'; SET LOCAL TIME ZONE 'UTC'");
    await client.query('SELECT pg_advisory_xact_lock(829417,1)');
    const tables = await assertTarget(client, request, data);
    const previous = (await client.query("SELECT value FROM algym_installer.state WHERE key='import_sha256'")).rows[0]?.value;
    if (previous) {
      if (previous !== sha256) throw new Error('Ya se importó otro respaldo en esta instalación.');
      await client.query('ROLLBACK');
      return { ...summary(data, sha256), alreadyImported: true };
    }
    // Lock every participating table before checking emptiness, including sessions.
    await client.query(`LOCK TABLE ${tables.map(qualified).join(',')},auth.sessions IN ACCESS EXCLUSIVE MODE`);
    await assertEmpty(client, tables);
    if (preview) { await client.query('ROLLBACK'); return summary(data, sha256); }
    if ((await lstat(mediaRoot)).isSymbolicLink() || !(await lstat(mediaRoot)).isDirectory()) throw new Error('Carpeta de imágenes inválida.');
    await client.query('SET LOCAL session_replication_role=replica');
    await client.query(`TRUNCATE ${tables.map(qualified).join(',')},auth.sessions RESTART IDENTITY`);
    await insertTables(client, data.tables);
    await verifyForeignKeys(client);
    const sequences = (await client.query("SELECT schemaname AS schema,sequencename AS name FROM pg_sequences WHERE schemaname='public'")).rows;
    if (sequences.length !== data.sequences.length || data.sequences.some((s) =>
      !sequences.some((t) => key(s) === key(t)) || !/^\d+$/.test(s.last_value ?? '') || typeof s.is_called !== 'boolean'))
      throw new Error('Secuencias incompatibles.');
    for (const s of data.sequences) {
      // ALTER RESTART is transactional, unlike setval. The next value follows the exported sequence.
      const next = BigInt(s.last_value) + (s.is_called ? 1n : 0n);
      await client.query(`ALTER SEQUENCE ${qualified(s)} RESTART WITH ${next}`);
    }
    // Compare every stored value, not only counts. Sorted row hashes also preserve decimal/bigint precision.
    for (const t of data.tables) {
      const hashes = (rows) => rows.map((r) => sha(JSON.stringify(r))).sort();
      if (JSON.stringify(hashes(await tableRows(client,t))) !== JSON.stringify(hashes(t.rows)))
        throw new Error(`La verificación de ${t.name} no coincide. No se importó la base.`);
    }
    for (const file of data.media) {
      const dir = path.join(mediaRoot, file.path.split('/')[0]);
      await mkdir(dir, { recursive: true });
      if ((await lstat(dir)).isSymbolicLink() || path.dirname(await realpath(dir)) !== await realpath(mediaRoot)) throw new Error('Ruta de imágenes inválida.');
      const destination = path.join(mediaRoot, file.path);
      const bytes = assertImage(file);
      try { await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 }); created.push(destination); }
      catch (e) {
        if (e.code !== 'EEXIST' || (await lstat(destination)).isSymbolicLink() || sha(await readFile(destination)) !== file.sha256) throw e;
      }
    }
    await client.query("INSERT INTO algym_installer.state(key,value) VALUES ('import_sha256',$1),('import_created_at',$2)", [sha256,data.createdAt]);
    await client.query('COMMIT'); committed = true;
    return { ...summary(data, sha256), imported: true };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (!committed) for (const f of created) await unlink(f).catch(() => {});
    // SQL errors may contain names/emails/values. Never expose their detail to logs.
    if (e.code) throw new Error(`No se completó la importación (${e.code}). Los datos anteriores se conservaron.`);
    throw e;
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [action, file, digest] = process.argv.slice(2);
    if (action === 'inspect') {
      const { data, sha256 } = await readPackage(file); console.log(JSON.stringify(summary(data,sha256)));
    } else if (action === 'import' || action === 'preview') {
      let input=''; for await (const chunk of process.stdin) { input+=chunk; if(input.length>20000) throw new Error('Solicitud inválida.'); }
      const request=JSON.parse(input.replace(/^\uFEFF/,''));
      console.log(JSON.stringify(await importPackage(request,file,request.mediaRoot,digest,action==='preview')));
    } else throw new Error('Acción inválida.');
  } catch(e) { console.error(e.message); process.exitCode=1; }
}
