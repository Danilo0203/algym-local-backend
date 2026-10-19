import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const migrationsPath = fileURLToPath(new URL('../database/migrations/', import.meta.url));
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";

export function validateRequest(request) {
  if (!/^[a-f0-9-]{36}$/.test(request.installationId ?? '') ||
      request.host !== '127.0.0.1' || !Number.isInteger(request.port) ||
      request.port < 1024 || request.port > 65535 || request.port === 5432 ||
      request.database !== 'algym_windows') {
    throw new Error('El instalador requiere su instancia privada de PostgreSQL en loopback.');
  }
  for (const key of ['adminPassword', 'appPassword', 'syncPassword']) {
    if (!/^[a-f0-9]{64}$/.test(request[key] ?? '')) throw new Error(`Clave interna inválida: ${key}`);
  }
  if (request.owner && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.owner.email ?? '') ||
      !request.owner.name?.trim() || request.owner.name.length > 150 ||
      typeof request.owner.password !== 'string' || request.owner.password.length < 12 ||
      Buffer.byteLength(request.owner.password) > 72)) {
    throw new Error('La cuenta propietaria requiere nombre, correo y contraseña de 12 a 72 bytes.');
  }
  return request;
}

// Existing migrations own their transaction. Migration 0030 also has an enum
// addition that MUST commit before the following transaction can use it.
export function splitMigration(sql) {
  const begin = /^BEGIN;\s*$/m.exec(sql);
  const commit = /^COMMIT;\s*$/m.exec(sql);
  if (!begin || !commit || commit.index <= begin.index || sql.slice(commit.index + commit[0].length).trim()) {
    throw new Error('Migración sin límites de transacción reconocidos.');
  }
  return { before: sql.slice(0, begin.index), body: sql.slice(begin.index + begin[0].length, commit.index) };
}

async function seedRoles(client) {
  await client.query(`INSERT INTO public.roles (slug, name, scope, is_system, is_protected)
    VALUES ('owner', 'Propietario', 'panel', true, false),
           ('admin', 'Administrador', 'panel', true, false),
           ('employee', 'Empleado', 'panel', true, false),
           ('trainer', 'Entrenador', 'panel', true, false),
           ('client', 'Cliente', 'client', true, false)
    ON CONFLICT (slug) DO NOTHING`);
}

export async function bootstrap(raw, directory = migrationsPath) {
  const request = validateRequest(raw);
  const config = { host: request.host, port: request.port, user: 'postgres',
    password: request.adminPassword, connectionTimeoutMillis: 10000,
    application_name: 'algym-windows-installer' };
  const admin = new pg.Client({ ...config, database: 'postgres' });
  await admin.connect();
  let client;
  try {
    const cluster = await admin.query("SELECT current_setting('cluster_name') AS name");
    if (cluster.rows[0].name !== `AlGym-${request.installationId}`) {
      throw new Error('Esta instancia PostgreSQL no pertenece a la instalación.');
    }
    await admin.query('SELECT pg_advisory_lock(829417, 1)');
    const found = await admin.query(`SELECT shobj_description(oid, 'pg_database') AS marker
      FROM pg_database WHERE datname = $1`, [request.database]);
    const marker = `AlGym Windows ${request.installationId}`;
    if (found.rowCount && found.rows[0].marker !== marker) {
      throw new Error('La base existente no pertenece al instalador; no se modificó.');
    }
    if (!found.rowCount) {
      if (!request.owner) throw new Error('Falta la cuenta propietaria para una instalación nueva.');
      await admin.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'algym_migrator') THEN
          CREATE ROLE algym_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'algym_app') THEN
          CREATE ROLE algym_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
      END $$`);
      await admin.query('CREATE DATABASE algym_windows OWNER algym_migrator ENCODING \'UTF8\' TEMPLATE template0');
      await admin.query(`COMMENT ON DATABASE algym_windows IS ${literal(marker)}`);
    }
    client = new pg.Client({ ...config, database: request.database });
    await client.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS algym_installer;
      REVOKE ALL ON SCHEMA algym_installer FROM PUBLIC;
      CREATE TABLE IF NOT EXISTS algym_installer.migrations (
        name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS algym_installer.state (key text PRIMARY KEY, value text NOT NULL)`);
    const files = (await readdir(directory)).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
    if (!files.length) throw new Error('El paquete no contiene migraciones.');
    const applied = new Map((await client.query('SELECT name, sha256 FROM algym_installer.migrations')).rows
      .map((row) => [row.name, row.sha256]));
    for (const name of applied.keys()) {
      if (!files.includes(name)) throw new Error('No se permite instalar una versión anterior del esquema.');
    }
    // Validate EVERY checksum before executing any new migration.
    const migrations = await Promise.all(files.map(async (name) => {
      const sql = await readFile(path.join(directory, name), 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      if (applied.has(name) && applied.get(name) !== sha256) throw new Error(`Migración aplicada alterada: ${name}`);
      return { name, sql, sha256 };
    }));
    for (const { name, sql, sha256 } of migrations) {
      if (applied.has(name)) continue;
      const { before, body } = splitMigration(sql);
      if (before.trim()) await client.query(before);
      try {
        await client.query(`BEGIN;\n${body}\nINSERT INTO algym_installer.migrations (name, sha256)
          VALUES (${literal(name)}, ${literal(sha256)});\nCOMMIT;`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`No se pudo aplicar ${name} (${error.code ?? 'SQL'}).`, { cause: error });
      }
      await client.query('RESET ALL');
      // Historical schema does not contain the role data required by later migrations.
      if (name.startsWith('0006_')) await seedRoles(client);
    }
    await client.query(`ALTER ROLE algym_app PASSWORD ${literal(request.appPassword)};
      ALTER ROLE algym_sync PASSWORD ${literal(request.syncPassword)};
      REVOKE CONNECT ON DATABASE algym_windows FROM PUBLIC;
      GRANT CONNECT ON DATABASE algym_windows TO algym_app, algym_sync, algym_migrator`);
    const initialized = await client.query("SELECT value FROM algym_installer.state WHERE key = 'initialized'");
    if (!initialized.rowCount) {
      if (!request.owner) throw new Error('Falta completar la cuenta propietaria.');
      const hash = await bcrypt.hash(request.owner.password, 12);
      await client.query('BEGIN');
      try {
        const count = await client.query('SELECT count(*)::int AS count FROM auth.users');
        if (count.rows[0].count !== 0) throw new Error('La base ya contiene usuarios; no se reemplazarán.');
        await seedRoles(client);
        await client.query(`INSERT INTO public.role_permissions (role_id, permission_id)
          SELECT r.id, p.id FROM public.roles r CROSS JOIN public.permissions p
          WHERE r.slug IN ('owner', 'admin') ON CONFLICT DO NOTHING`);
        const user = await client.query(`INSERT INTO auth.users
          (email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
          VALUES ($1, $2, now(), '{"provider":"email","providers":["email"]}'::jsonb,
            jsonb_build_object('full_name', $3::text, 'role', 'owner'), now(), now()) RETURNING id`,
        [request.owner.email.toLowerCase().trim(), hash, request.owner.name.trim()]);
        await client.query(`INSERT INTO public.profiles (id, full_name, phone, birth_date, biometric_id, role, is_active)
          VALUES ($1, $2, '', NULL, NULL, 'owner', true)`, [user.rows[0].id, request.owner.name.trim()]);
        await client.query(`INSERT INTO public.cash_registers (name) VALUES ('Caja principal')`);
        await client.query("INSERT INTO algym_installer.state VALUES ('initialized', 'true')");
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    }
    return { ok: true, migrations: files.length };
  } finally {
    await client?.end();
    await admin.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 16384) throw new Error('Solicitud demasiado grande.');
    }
    console.log(JSON.stringify(await bootstrap(JSON.parse(input.replace(/^\uFEFF/, '')))));
  } catch (error) {
    // No query text, credentials, stack or customer data in installation logs.
    console.error(`No se completó la base local: ${error.message}`);
    process.exitCode = 1;
  }
}
