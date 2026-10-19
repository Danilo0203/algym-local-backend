// Operator tool: builds the Windows package in a new disposable PostgreSQL cluster.
// Input is data extracted from a read-only Hostinger dump; no source SQL is run.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { splitMigration } from './bootstrap.mjs';
import { catalog, insertTables, verifyForeignKeys, tableRows, sha, migrationHashes, exportPackage, writePackage } from './transfer.mjs';

const [input,output,pgBin]=process.argv.slice(2);
if(!input || !output || !pgBin) throw new Error('Uso: node prepare-transfer.mjs origen.json destino.algym /ruta/postgresql/bin');
const raw=JSON.parse(await readFile(input,'utf8'));
if(raw.kind!=='AlGym.Hostinger.ReadOnlySnapshot' || !Array.isArray(raw.tables)) throw new Error('Origen inválido.');
const root=await mkdtemp(path.join(tmpdir(),'algym-prepare-transfer-'));
const media=path.join(root,'media'); await mkdir(media);
const server=createServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port; await new Promise(r=>server.close(r));
const password=randomBytes(32).toString('hex'), installationId=randomUUID();
const run=(name,args)=>execFileSync(path.join(pgBin,name+(process.platform==='win32'?'.exe':'')),args,{stdio:'pipe',env:{...process.env,PGPASSWORD:password}});
const pgData=path.join(root,'postgres'); let started=false,admin,client;
try {
  await writeFile(path.join(root,'password'),password,{mode:0o600});
  run('initdb',['-D',pgData,'-U','postgres','--encoding=UTF8','--locale=C','--auth=scram-sha-256','--pwfile='+path.join(root,'password')]);
  run('pg_ctl',['-D',pgData,'-w','-l',path.join(root,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} ${process.platform==='win32'?'':`-k "${root}"`} -c cluster_name=AlGym-${installationId}`,'start']);
  started=true;
  const config={host:'127.0.0.1',port,user:'postgres',password};
  admin=new pg.Client({...config,database:'postgres'}); await admin.connect();
  await admin.query(`CREATE ROLE algym_migrator NOLOGIN; CREATE ROLE algym_app LOGIN;`);
  await admin.query('CREATE DATABASE algym_windows OWNER algym_migrator TEMPLATE template0');
  await admin.query(`COMMENT ON DATABASE algym_windows IS 'AlGym Windows ${installationId}'`);
  client=new pg.Client({...config,database:'algym_windows'}); await client.connect();
  await client.query("SET TIME ZONE 'UTC'; SET DateStyle='ISO,YMD'");
  const migrations=await migrationHashes();
  const directory=fileURLToPath(new URL('../database/migrations/',import.meta.url));
  async function applyMigration(m) {
    const {before,body}=splitMigration(await readFile(path.join(directory,m.name),'utf8'));
    if(before.trim()) await client.query(before);
    await client.query('BEGIN;\n'+body+'\nCOMMIT;'); await client.query('RESET ALL');
  }
  for(const m of migrations.slice(0,2)) await applyMigration(m);
  const target=await catalog(client), imported=[], ignoredAuthColumns={};
  for(const source of raw.tables) {
    const t=target.find(t=>t.schema===source.schema&&t.name===source.name);
    if(!t) { if(source.rows.length) throw new Error(`Tabla sin correspondencia: ${source.schema}.${source.name}`); continue; }
    const extra=source.columns.filter(c=>!t.columns.includes(c));
    if(extra.length && source.schema==='public') throw new Error(`Columnas sin correspondencia en ${source.name}: ${extra.join(',')}`);
    if(extra.length) ignoredAuthColumns[source.name]=extra;
    const columns=source.columns.filter(c=>t.columns.includes(c));
    const indices=columns.map(c=>source.columns.indexOf(c));
    imported.push({...t,columns,rows:source.rows.map(r=>indices.map(i=>r[i]))});
  }
  const roles=imported.find(t=>t.name==='roles');
  const emptyRbac=['roles','permissions','role_permissions'].every(n=>!imported.find(t=>t.name===n)?.rows.length);
  if(!roles?.rows.length && !emptyRbac) throw new Error('El catálogo de permisos de origen está incompleto.');
  await client.query('BEGIN; SET LOCAL session_replication_role=replica');
  await insertTables(client,imported); await verifyForeignKeys(client); await client.query('COMMIT');
  if(emptyRbac) await client.query(`INSERT INTO public.roles(slug,name,scope,is_system,is_protected) VALUES
    ('owner','Propietario','panel',true,false),('admin','Administrador','panel',true,false),
    ('employee','Empleado','panel',true,false),('trainer','Entrenador','panel',true,false),('client','Cliente','client',true,false)`);
  const hashes=(rows)=>rows.map(r=>sha(JSON.stringify(r))).sort();
  // Preserve a normalized fingerprint of every original business column before upgrading.
  await client.query("SET TIME ZONE 'UTC'; SET DateStyle='ISO,YMD'");
  const baseline=new Map();
  for(const t of imported) if(!['roles','permissions','role_permissions'].includes(t.name)) baseline.set(t.name,hashes(await tableRows(client,t)));
  for(const m of migrations.slice(2)) {
    await applyMigration(m);
  }
  await client.query("SET TIME ZONE 'UTC'; SET DateStyle='ISO,YMD'");
  if(emptyRbac) await client.query(`INSERT INTO public.role_permissions(role_id,permission_id)
    SELECT r.id,p.id FROM public.roles r CROSS JOIN public.permissions p WHERE r.slug IN ('owner','admin') ON CONFLICT DO NOTHING`);
  await verifyForeignKeys(client);
  const differences=[];
  for(const t of imported) {
    if(!baseline.has(t.name)) continue;
    if(JSON.stringify(baseline.get(t.name))!==JSON.stringify(hashes(await tableRows(client,t)))) differences.push(t.name);
  }
  if(differences.length) throw new Error('Las migraciones cambiaron columnas de origen; revisar: '+differences.join(','));
  await client.query(`DO $$ DECLARE r record; n bigint; BEGIN
    FOR r IN SELECT ns.nspname AS schema,c.relname AS name,a.attname AS col,
      pg_get_serial_sequence(format('%I.%I',ns.nspname,c.relname),a.attname) AS seq
      FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE ns.nspname='public' AND c.relkind='r'
    LOOP IF r.seq IS NOT NULL THEN
      EXECUTE format('SELECT COALESCE(MAX(%I),0)+1 FROM %I.%I',r.col,r.schema,r.name) INTO n;
      EXECUTE format('ALTER SEQUENCE %s RESTART WITH %s',r.seq,GREATEST(n,1));
    END IF; END LOOP; END $$`);
  const payload=await exportPackage(client,media,{kind:'Hostinger',capturedAt:raw.capturedAt,
    archivedDeviceCommands:raw.archivedDeviceCommands??0,rbacInitialized:emptyRbac});
  const report=await writePackage(output,payload);
  await writeFile(output+'.report.json',JSON.stringify({...report,source:payload.source,verifiedOriginalTables:baseline.size,ignoredAuthColumns},null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({...report,source:payload.source,verifiedOriginalTables:baseline.size}));
} catch(e) {
  await client?.query('ROLLBACK').catch(()=>{});
  console.error(e.code ? `Preparación detenida (${e.code}); revisar el esquema en la copia aislada.` : e.message);
  process.exitCode=1;
} finally {
  await client?.end(); await admin?.end();
  if(started) run('pg_ctl',['-D',pgData,'-m','fast','-w','stop']);
  // Keep the private stopped cluster for diagnosis until the delivery is validated.
  console.log('Copia de ensayo detenida: '+root);
}
