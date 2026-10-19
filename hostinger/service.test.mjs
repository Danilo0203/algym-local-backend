import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExportJobs, ownerAuthorizer, createHandler, HttpError } from './service.mjs';
import { sourceConfig } from './pipeline.mjs';

test('authorization rechecks active owner and live session after GoTrue, ignoring metadata', async () => {
  const userId=randomUUID(),sessionId=randomUUID(); let calls=0,allow=false;
  const token='header.'+Buffer.from(JSON.stringify({sub:userId,session_id:sessionId,user_metadata:{role:'owner'}})).toString('base64url')+'.signature';
  const authorize=ownerAuthorizer({authUrl:'http://auth'}, {fetcher:async()=>({ok:true,json:async()=>({id:userId,user_metadata:{role:'owner'}})}),pool:{query:async(sql,args)=>{calls++;assert.match(sql,/p.role::text='owner' AND p.is_active/);assert.match(sql,/s.not_after/);assert.deepEqual(args,[userId,sessionId]);return {rows:allow?[{id:userId}]:[]};}}});
  await assert.rejects(authorize({headers:{}}),e=>e.status===401); assert.equal(calls,0);
  await assert.rejects(authorize({headers:{authorization:'Bearer '+token}}),e=>e.status===403);
  allow=true; assert.equal(await authorize({headers:{authorization:'Bearer '+token}}),userId);
  const rejected=ownerAuthorizer({authUrl:'http://auth'}, {fetcher:async()=>({ok:false}),pool:{query:async()=>{throw Error('must not query');}}});
  await assert.rejects(rejected({headers:{authorization:'Bearer '+token}}),e=>e.status===401);
  assert.match(sourceConfig({host:'db',options:'unsafe'}).options,/default_transaction_read_only=on/);
});

test('HTTP export requires confirmation, isolates owners, deduplicates retries, and streams artifacts', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'algym-export-test-'));let builds=0;
  let release;const block=new Promise(r=>release=r);
  const jobs=new ExportJobs({root},async({folder})=>{builds++;await block;await writeFile(path.join(folder,'data.algym'),'package');await writeFile(path.join(folder,'source.dump'),'archive');return {sha256:'a'.repeat(64),snapshotAt:'2026-10-19T10:00:00Z',customers:1,plans:2,payments:3};});
  await jobs.init();const owner=randomUUID(),other=randomUUID();
  const server=createServer(createHandler({jobs,authorize:async req=>{if(![owner,other].includes(req.headers.authorization))throw new HttpError(403,'No autorizado');return req.headers.authorization;}}));
  server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
  const request=(p,method='GET',body,who=owner)=>fetch(url+p,{method,headers:{authorization:who,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
  try {
    assert.equal((await request('/jobs','GET',null,'invalid')).status,403);
    const id=randomUUID();assert.equal((await request('/jobs','POST',{id,confirmed:false})).status,400);assert.equal(builds,0);
    assert.equal((await request('/jobs','POST',{id,confirmed:true,path:'/private'})).status,400);
    assert.equal((await request('/jobs','POST',{id,confirmed:true})).status,202);
    assert.equal((await request('/jobs','POST',{id,confirmed:true})).status,202);assert.equal(builds,1);
    assert.equal((await request('/jobs/'+id,'GET',null,other)).status,404);
    assert.equal((await request('/jobs/'+id+'/file')).status,409);
    assert.equal((await request('/jobs','POST',{id:randomUUID(),confirmed:true},other)).status,409);
    release();await jobs.running;
    const data=await (await request('/jobs/'+id)).json();assert.equal(data.state,'ready');assert.equal('userId' in data,false);
    assert.equal(await (await request('/jobs/'+id+'/file')).text(),'package');
    assert.equal(await (await request('/jobs/'+id+'/archive')).text(),'archive');
    assert.equal((await request('/jobs/'+id+'/archive','GET',null,other)).status,404);
    assert.equal((await request('/jobs','POST',{id:randomUUID(),confirmed:true})).status,429);
    jobs.jobs.get(id).expiresAt=Date.now()-1;await jobs.cleanup();assert.equal((await request('/jobs/'+id)).status,404);
  } finally {server.closeAllConnections();server.close();await rm(root,{recursive:true,force:true});}
});


test('failed persistence releases the worker and never offers an unrecorded backup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'algym-export-failure-'));
  const jobs = new ExportJobs({root}, async ({folder}) => {
    await rm(folder, {recursive:true,force:true});
    return {sha256:'a'.repeat(64),snapshotAt:'2026-10-19T10:00:00Z',customers:1};
  });
  try {
    await jobs.init(); const id=randomUUID(), owner=randomUUID();
    await jobs.start(id, owner); await jobs.running;
    assert.equal(jobs.active,null); assert.equal(jobs.get(id,owner).state,'failed');
  } finally { await rm(root,{recursive:true,force:true}); }
});
