import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import pg from 'pg';
import {bootstrap} from './bootstrap.mjs';
import {exportPackage, writePackage, sha} from './transfer.mjs';
import {updatePackage} from './update-transfer.mjs';

test('incremental update preserves local rows, maps numeric collisions, dedupes clock events and is atomic/idempotent', {skip:!process.env.ALGYM_INSTALLER_PG_BIN,timeout:180000}, async () => {
  const root=await mkdtemp(path.join(tmpdir(),'algym-update-test-'));
  const server=createServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port; await new Promise(r=>server.close(r));
  const request={installationId:randomUUID(),host:'127.0.0.1',port,database:'algym_windows',
    adminPassword:randomBytes(32).toString('hex'),appPassword:randomBytes(32).toString('hex'),syncPassword:randomBytes(32).toString('hex'),
    owner:{name:'Test owner',email:'owner@example.test',password:'Test only password 12345'}};
  const media=path.join(root,'media'); await mkdir(media);
  const run=(tool,args)=>execFileSync(path.join(process.env.ALGYM_INSTALLER_PG_BIN,tool+(process.platform==='win32'?'.exe':'')),args,{stdio:process.platform==='win32'?'ignore':'pipe',env:{...process.env,PGPASSWORD:request.adminPassword}});
  let started=false,client;
  const table=(data,name)=>data.tables.find(t=>t.name===name);
  const change=(t,row,values)=>t.columns.map((c,i)=>Object.hasOwn(values,c)?values[c]:row[i]);
  const append=(data,name,values)=>{const t=table(data,name);t.rows.push(t.columns.map(c=>values[c]??null));};
  async function save(data,label) {const file=path.join(root,label+'.algym'); const report=await writePackage(file,data);return {file,hash:report.sha256};}
  try {
    await writeFile(path.join(root,'password'),request.adminPassword,{mode:0o600});
    run('initdb',['-D',path.join(root,'pg'),'-U','postgres','--encoding=UTF8','--locale=C','--auth=scram-sha-256','--pwfile='+path.join(root,'password')]);
    run('pg_ctl',['-D',path.join(root,'pg'),'-w','-l',path.join(root,'pg.log'),'-o',`-h 127.0.0.1 -p ${port} ${process.platform==='win32'?'':`-k "${root}"`} -c cluster_name=AlGym-${request.installationId}`,'start']);started=true;
    await bootstrap(request);
    client=new pg.Client({host:request.host,port,user:'postgres',password:request.adminPassword,database:request.database});await client.connect();
    const owner=(await client.query('SELECT id FROM auth.users')).rows[0].id;
    await client.query("INSERT INTO public.plans(id,name,duration_days,price) VALUES (1,'Original',30,100)");
    await client.query("INSERT INTO public.attendance_logs(id,device_id,biometric_id,punch_time,status1,status2) VALUES(1,'clock',1,'2026-10-19T12:00Z',0,0)");
    const base=await exportPackage(client,media,{kind:'Hostinger',capturedAt:'2026-10-19T00:00:00Z'}), original=await save(base,'original');
    await client.query("INSERT INTO algym_installer.state(key,value) VALUES('import_sha256',$1)",[original.hash]);
    const remote=structuredClone(base);remote.source.capturedAt='2026-10-22T00:00:00Z';remote.createdAt=remote.source.capturedAt;
    const plans=table(remote,'plans');plans.rows[0]=change(plans,plans.rows[0],{price:'120.00'});
    plans.rows.push(change(plans,plans.rows[0],{id:'2',name:'Remote plan',price:'200.00'}));
    const sub=randomUUID(),payment=randomUUID();
    append(remote,'subscriptions',{id:sub,user_id:owner,plan_id:'2',start_date:'2026-10-22',end_date:'2026-11-21',status:'active',created_at:'2026-10-22 00:00:00+00',discount_amount:'0.00',grace_days:'3'});
    append(remote,'payments',{id:payment,subscription_id:sub,user_id:owner,amount_original:'200.00',discount_amount:'0.00',amount_paid:'200.00',method:'cash',payment_date:'2026-10-22 13:00:00+00',created_by_user_id:owner,status:'posted'});
    const attendance=table(remote,'attendance_logs');
    attendance.rows.push(change(attendance,attendance.rows[0],{id:'2',punch_time:'2026-10-22 13:00:00+00'}));
    attendance.rows.push(change(attendance,attendance.rows[0],{id:'3',punch_time:'2026-10-22 12:00:00+00'}));
    const incoming=await save(remote,'updated');
    await client.query("INSERT INTO public.plans(id,name,duration_days,price) VALUES (2,'Local plan',15,80)");
    await client.query("UPDATE public.profiles SET medical_notes='LOCAL ONLY' WHERE id=$1",[owner]);
    const localPayment=randomUUID();
    await client.query("INSERT INTO public.payments(id,user_id,amount_original,discount_amount,amount_paid,method,payment_date,status) VALUES($1,$2,80,0,80,'cash','2026-10-21T12:00Z','posted')",[localPayment,owner]);
    await client.query("INSERT INTO public.attendance_logs(id,device_id,biometric_id,punch_time,status1,status2) VALUES(2,'clock',1,'2026-10-22T12:00Z',0,0)");
    const before=await exportPackage(client,media,{kind:'test'});
    await assert.rejects(updatePackage(request,incoming.file,media,incoming.hash,{preview:true}),/original/);
    await assert.rejects(updatePackage(request,incoming.file,media,incoming.hash,{preview:true,baselineFile:incoming.file}),/no coincide/);
    const review=await updatePackage(request,incoming.file,media,incoming.hash,{preview:true,baselineFile:original.file});
    assert.equal(review.canApply,true,JSON.stringify(review));assert.equal(review.totals.duplicates,1);assert.equal(review.totals.updated,1);
    assert.deepEqual((await exportPackage(client,media,{kind:'test'})).tables,before.tables);
    assert.equal((await client.query("SELECT count(*)::int n FROM algym_installer.state WHERE key='merge_snapshot'")).rows[0].n,0);
    await client.query("UPDATE public.profiles SET medical_notes='LOCAL CHANGED AFTER REVIEW' WHERE id=$1",[owner]);
    await assert.rejects(updatePackage(request,incoming.file,media,incoming.hash,{baselineFile:original.file,expectedPlan:review.planHash}),/cambiaron/);
    const fresh=await updatePackage(request,incoming.file,media,incoming.hash,{preview:true,baselineFile:original.file});
    const applied=await updatePackage(request,incoming.file,media,incoming.hash,{baselineFile:original.file,expectedPlan:fresh.planHash});
    assert.equal(applied.applied,true);
    assert.equal((await client.query('SELECT medical_notes FROM public.profiles WHERE id=$1',[owner])).rows[0].medical_notes,'LOCAL CHANGED AFTER REVIEW');
    assert.deepEqual((await client.query('SELECT id::text,name FROM public.plans ORDER BY id')).rows,[{id:'1',name:'Original'},{id:'2',name:'Local plan'},{id:'3',name:'Remote plan'}]);
    assert.equal((await client.query('SELECT plan_id::text FROM public.subscriptions WHERE id=$1',[sub])).rows[0].plan_id,'3');
    assert.equal((await client.query('SELECT count(*)::int n FROM public.payments')).rows[0].n,2);
    assert.equal((await client.query('SELECT count(*)::int n FROM public.attendance_logs')).rows[0].n,3);
    assert.equal((await updatePackage(request,incoming.file,media,incoming.hash,{preview:true})).alreadyApplied,true);
    const after=await exportPackage(client,media,{kind:'test'});
    const future=structuredClone(remote);future.source.capturedAt='2026-10-23T00:00:00Z';future.createdAt=future.source.capturedAt;
    table(future,'plans').rows[1]=change(table(future,'plans'),table(future,'plans').rows[1],{description:'Remote change'});
    const next=await save(future,'future'), nextReview=await updatePackage(request,next.file,media,next.hash,{preview:true});
    assert.equal(nextReview.canApply,true,JSON.stringify(nextReview));
    await updatePackage(request,next.file,media,next.hash,{expectedPlan:nextReview.planHash});
    assert.equal((await client.query('SELECT description FROM public.plans WHERE id=3')).rows[0].description,'Remote change');
    assert.equal((await client.query('SELECT count(*)::int n FROM public.plans')).rows[0].n,3);
    // Conflicting edits block the whole operation; no quiet local-wins data loss.
    await client.query("UPDATE public.plans SET price=250 WHERE id=3");
    const conflict=structuredClone(future);conflict.source.capturedAt='2026-10-24T00:00:00Z';conflict.createdAt=conflict.source.capturedAt;
    table(conflict,'plans').rows[1]=change(table(conflict,'plans'),table(conflict,'plans').rows[1],{price:'220.00'});
    const conflictFile=await save(conflict,'conflict');
    const blocked=await updatePackage(request,conflictFile.file,media,conflictFile.hash,{preview:true});
    assert.equal(blocked.canApply,false);assert.ok(blocked.conflicts.some(c=>c.reason==='changed_both'));
    assert.equal((await client.query('SELECT price::text FROM public.plans WHERE id=3')).rows[0].price,'250.00');
    // A business event with another UUID is not silently duplicated.
    const duplicate=structuredClone(future);duplicate.source.capturedAt='2026-10-24T00:00:00Z';duplicate.createdAt=duplicate.source.capturedAt;
    table(duplicate,'payments').rows.push(change(table(duplicate,'payments'),table(duplicate,'payments').rows[0],{id:randomUUID()}));
    const duplicateFile=await save(duplicate,'duplicate');
    assert.ok((await updatePackage(request,duplicateFile.file,media,duplicateFile.hash,{preview:true})).conflicts.some(c=>c.reason==='possible_duplicate'));
    // Delete in Hostinger never deletes the locally retained history.
    const deleted=structuredClone(future);deleted.source.capturedAt='2026-10-24T00:00:00Z';deleted.createdAt=deleted.source.capturedAt;table(deleted,'payments').rows=[];
    const deletedFile=await save(deleted,'deleted'), retained=await updatePackage(request,deletedFile.file,media,deletedFile.hash,{preview:true});
    assert.equal(retained.canApply,true,JSON.stringify(retained));assert.equal(retained.totals.ignoredDeletions,1);
    assert.equal((await client.query('SELECT count(*)::int n FROM public.payments')).rows[0].n,2);
    const invalid=structuredClone(future);invalid.source.capturedAt='2026-10-24T00:00:00Z';invalid.createdAt=invalid.source.capturedAt;
    table(invalid,'plans').rows.push(change(table(invalid,'plans'),table(invalid,'plans').rows[0],{id:'9',name:'Invalid',price:'not-a-number'}));
    const invalidFile=await save(invalid,'invalid');
    const invalidReview=await updatePackage(request,invalidFile.file,media,invalidFile.hash,{preview:true});
    assert.equal(invalidReview.canApply,false);assert.ok(invalidReview.conflicts.some(c=>c.reason==='constraint'));
    const mediaFailure=structuredClone(future);mediaFailure.source.capturedAt='2026-10-24T00:00:00Z';mediaFailure.createdAt=mediaFailure.source.capturedAt;
    table(mediaFailure,'plans').rows.push(change(table(mediaFailure,'plans'),table(mediaFailure,'plans').rows[0],{id:'9',name:'Rollback plan'}));
    const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64'), imageName=sha(gif)+'.gif';
    mediaFailure.media=[{path:'exercises/'+imageName,sha256:sha(gif),base64:gif.toString('base64')}];
    await mkdir(path.join(media,'exercises'));await writeFile(path.join(media,'exercises',imageName),'wrong-existing-image');
    const mediaFile=await save(mediaFailure,'media-failure'), mediaReview=await updatePackage(request,mediaFile.file,media,mediaFile.hash,{preview:true});
    assert.equal(mediaReview.canApply,true,JSON.stringify(mediaReview));
    await assert.rejects(updatePackage(request,mediaFile.file,media,mediaFile.hash,{expectedPlan:mediaReview.planHash}),/conservaron/);
    assert.equal((await client.query('SELECT count(*)::int n FROM public.plans WHERE id=9')).rows[0].n,0);
    assert.equal(JSON.parse((await client.query("SELECT value FROM algym_installer.state WHERE key='merge_snapshot'")).rows[0].value).sha256,next.hash);
    await rm(path.join(media,'exercises',imageName));
    assert.deepEqual(after.tables.find(t=>t.name==='users').rows,(await exportPackage(client,media,{kind:'test'})).tables.find(t=>t.name==='users').rows);
  } finally {
    await client?.end();if(started)run('pg_ctl',['-D',path.join(root,'pg'),'-m','fast','-w','stop']);
    await rm(root,{recursive:true,force:true});
  }
});
