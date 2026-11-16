import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import pg from 'pg';
import { bootstrap } from './bootstrap.mjs';

const migrations = fileURLToPath(new URL('../database/migrations/', import.meta.url));
for (const origin of ['inscripcion', 'caja']) {
  test(`actualización unificada desde 0.3.8 ${origin} conserva migraciones y registros`, { timeout:180000 }, async () => {
    assert.ok(process.env.ALGYM_INSTALLER_PG_BIN);
    const root = await mkdtemp(path.join(tmpdir(),'algym-unified-test-'));
    const server = createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port = server.address().port; await new Promise(resolve=>server.close(resolve));
    assert.notEqual(port,55432); assert.notEqual(port,5432);
    const request = { installationId:randomUUID(),host:'127.0.0.1',port,database:'algym_windows',
      adminPassword:randomBytes(32).toString('hex'),appPassword:randomBytes(32).toString('hex'),syncPassword:randomBytes(32).toString('hex'),
      owner:{name:'Prueba de actualización',email:'upgrade@example.test',password:'Upgrade sintético 12345'} };
    const run = (name,args) => execFileSync(path.join(process.env.ALGYM_INSTALLER_PG_BIN,name+(process.platform==='win32'?'.exe':'')),args,
      {stdio:process.platform==='win32'?'ignore':'pipe',windowsHide:true,env:{...process.env,PGPASSWORD:request.adminPassword}});
    let started=false, db;
    try {
      await writeFile(path.join(root,'password'),request.adminPassword);
      const previous = path.join(root,'previous'); await mkdir(previous);
      for (const name of await readdir(migrations)) {
        if (!/^\d{4}_.*\.sql$/.test(name)) continue;
        const selected = Number(name.slice(0,4)) <= 40 || (origin==='caja'
          ? name==='0041_cash_devices.sql' : ['0041_annual_enrollment.sql','0042_exercise_catalog_delete.sql'].includes(name));
        if(selected) await copyFile(path.join(migrations,name),path.join(previous,name));
      }
      run('initdb',['-D',path.join(root,'pg'),'-U','postgres','--encoding=UTF8','--locale=C','--auth=scram-sha-256','--pwfile='+path.join(root,'password')]);
      run('pg_ctl',['-D',path.join(root,'pg'),'-w','-l',path.join(root,'pg.log'),'-o',`-h 127.0.0.1 -p ${port} -c cluster_name=AlGym-${request.installationId}`,'start']);started=true;
      await bootstrap(request,previous);
      db=new pg.Client({host:request.host,port,user:'postgres',password:request.adminPassword,database:request.database});await db.connect();
      const owner=(await db.query('SELECT id FROM auth.users')).rows[0].id;
      const payment=(await db.query("INSERT INTO payments(user_id,amount_original,discount_amount,amount_paid,method,status) VALUES($1,150,0,150,'cash','posted') RETURNING *",[owner])).rows[0];
      const before=(await db.query('SELECT name,sha256 FROM algym_installer.migrations ORDER BY name')).rows;
      if(origin==='caja') await db.query("INSERT INTO cash_device_operations(actor_user_id,kind,status,reason) VALUES($1,'drawer_manual','sent','Historial previo')",[owner]);
      else await db.query('UPDATE enrollment_settings SET fee=60 WHERE singleton');
      const upgraded=await bootstrap({...request,owner:null});assert.equal(upgraded.migrations,45);
      const after=(await db.query('SELECT name,sha256 FROM algym_installer.migrations ORDER BY name')).rows;
      for(const old of before) assert.deepEqual(after.find(row=>row.name===old.name),old);
      const preserved=(await db.query('SELECT * FROM payments WHERE id=$1',[payment.id])).rows[0];
      for(const key of Object.keys(payment)) assert.deepEqual(preserved[key],payment[key]);
      assert.equal((await db.query('SELECT count(*)::int n FROM auth.users')).rows[0].n,1);
      if(origin==='caja') assert.equal((await db.query("SELECT count(*)::int n FROM cash_device_operations WHERE reason='Historial previo'")).rows[0].n,1);
      else assert.equal(Number((await db.query('SELECT fee FROM enrollment_settings')).rows[0].fee),60);
      assert.equal((await bootstrap({...request,owner:null})).migrations,45);
    } finally {
      await db?.end();if(started)run('pg_ctl',['-D',path.join(root,'pg'),'-m','fast','-w','stop']);
      const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(resolved).startsWith('algym-unified-test-'));
      await rm(resolved,{recursive:true,force:true});
    }
  });
}
