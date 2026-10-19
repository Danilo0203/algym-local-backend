import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import pg from 'pg';
import { bootstrap } from './bootstrap.mjs';
import { exportPackage, writePackage, importPackage, readPackage, validatePackage } from './transfer.mjs';

test('portable migration validates contents, rolls back bad data, preserves every row and blocks existing operations', {
  skip: !process.env.ALGYM_INSTALLER_PG_BIN, timeout: 180000,
}, async () => {
  const root=await mkdtemp(path.join(tmpdir(),'algym-transfer-test-'));
  const server=createServer(); await new Promise((r)=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port; await new Promise((r)=>server.close(r));
  const request={ installationId:randomUUID(),host:'127.0.0.1',port,database:'algym_windows',
    adminPassword:randomBytes(32).toString('hex'),appPassword:randomBytes(32).toString('hex'),syncPassword:randomBytes(32).toString('hex'),
    owner:{name:'Prueba',email:'owner@example.test',password:'Test-only pass 123456'} };
  const data=path.join(root,'pg'), media=path.join(root,'media'); await mkdir(media);
  const run=(name,args)=>execFileSync(path.join(process.env.ALGYM_INSTALLER_PG_BIN,name+(process.platform==='win32'?'.exe':'')),args,
    {stdio:'pipe',env:{...process.env,PGPASSWORD:request.adminPassword}});
  let started=false,client;
  try {
    await writeFile(path.join(root,'password'),request.adminPassword,{mode:0o600});
    run('initdb',['-D',data,'-U','postgres','--encoding=UTF8','--locale=C','--auth=scram-sha-256','--pwfile='+path.join(root,'password')]);
    run('pg_ctl',['-D',data,'-w','-l',path.join(root,'pg.log'),'-o',`-h 127.0.0.1 -p ${port} ${process.platform==='win32'?'':`-k "${root}"`} -c cluster_name=AlGym-${request.installationId}`,'start']);
    started=true; await bootstrap(request);
    client=new pg.Client({host:request.host,port,user:'postgres',password:request.adminPassword,database:request.database}); await client.connect();
    await client.query("INSERT INTO public.plans(id,name,duration_days,price) VALUES(9007199254740993,'Plan de prueba',30,123.45)");
    const payload=await exportPackage(client,media,{kind:'test'});
    const owner=payload.tables.find(t=>t.schema==='auth'&&t.name==='users');
    const profiles=payload.tables.find(t=>t.name==='profiles');
    const oldId=owner.rows[0][owner.columns.indexOf('id')], newId=randomUUID();
    owner.rows[0][owner.columns.indexOf('id')]=newId; profiles.rows[0][profiles.columns.indexOf('id')]=newId;
    const sequence=payload.sequences.find(s=>s.name==='plans_id_seq'); sequence.last_value='9007199254740993'; sequence.is_called=true;
    const file=path.join(root,'data.algym'); const report=await writePackage(file,payload);
    await assert.rejects(importPackage(request,file,media,report.sha256),/ya tiene datos/);
    await client.query('DELETE FROM public.plans');
    await assert.rejects(importPackage(request,file,media,'0'.repeat(64)),/cambió/);
    await assert.rejects(importPackage({...request,installationId:randomUUID()},file,media,report.sha256),/no pertenece/);
    const incompatible=structuredClone(payload); incompatible.migrations[0].sha256='0'.repeat(64);
    const incompatibleFile=path.join(root,'incompatible.algym'), incompatibleReport=await writePackage(incompatibleFile,incompatible);
    await assert.rejects(importPackage(request,incompatibleFile,media,incompatibleReport.sha256),/versión/);
    assert.throws(()=>validatePackage({...payload,media:[{path:'../escape.png',base64:'a'}]}),/imagen/);
    const bad=structuredClone(payload); bad.tables.find(t=>t.name==='profiles').rows[0][profiles.columns.indexOf('id')]=randomUUID();
    const badFile=path.join(root,'bad.algym'), badReport=await writePackage(badFile,bad).catch(()=>({}));
    // A broken profile must be rejected before mutation (owner validation or FK verification).
    if(badReport.sha256) await assert.rejects(importPackage(request,badFile,media,badReport.sha256));
    const foreign=structuredClone(payload), identities=foreign.tables.find(t=>t.schema==='auth'&&t.name==='identities');
    identities.rows.push(identities.columns.map(c=>({id:randomUUID(),user_id:randomUUID(),provider:'email',identity_data:'{}'}[c]??null)));
    const foreignFile=path.join(root,'foreign.algym'), foreignReport=await writePackage(foreignFile,foreign);
    await assert.rejects(importPackage(request,foreignFile,media,foreignReport.sha256),/referencias incompletas/);
    assert.equal((await client.query('SELECT id FROM auth.users')).rows[0].id,oldId);
    const invalid=structuredClone(payload); const plan=invalid.tables.find(t=>t.name==='plans');
    plan.rows[0][plan.columns.indexOf('price')]='not-a-number';
    const invalidFile=path.join(root,'invalid.algym'), invalidReport=await writePackage(invalidFile,invalid);
    await assert.rejects(importPackage(request,invalidFile,media,invalidReport.sha256),/conservaron/);
    assert.equal((await client.query('SELECT id FROM auth.users')).rows[0].id,oldId);
    assert.equal((await client.query('SELECT count(*)::int n FROM public.plans')).rows[0].n,0);
    const preview=await importPackage(request,file,media,report.sha256,true); assert.equal(preview.plans,1);
    assert.equal((await client.query('SELECT id FROM auth.users')).rows[0].id,oldId);
    assert.equal((await importPackage(request,file,media,report.sha256)).imported,true);
    assert.equal((await client.query('SELECT id FROM auth.users')).rows[0].id,newId);
    assert.equal((await client.query('SELECT id::text,price::text FROM public.plans')).rows[0].id,'9007199254740993');
    assert.equal((await client.query('SELECT price::text FROM public.plans')).rows[0].price,'123.45');
    assert.equal((await client.query("SELECT nextval('public.plans_id_seq')::text AS n")).rows[0].n,'9007199254740994');
    assert.equal((await importPackage(request,file,media,report.sha256)).alreadyImported,true);
    await assert.rejects(importPackage(request,invalidFile,media,invalidReport.sha256),/otro respaldo/);
    await bootstrap({...request,owner:null}); // upgrades still work after import
    const corrupt=path.join(root,'corrupt.algym'); await writeFile(corrupt,(await readFile(file)).subarray(0,20));
    await assert.rejects(readPackage(corrupt),/dañado/);
  } finally {
    await client?.end(); if(started) run('pg_ctl',['-D',data,'-m','fast','-w','stop']);
    await rm(root,{recursive:true,force:true});
  }
});
