import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ownerLogin, validateLogin } from './login.mjs';
import { createHandler, HttpError } from './service.mjs';

const token = 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000)+3600 })).toString('base64url') + '.signature';
test('login validates input and only exposes a short owner session after authorization', async () => {
  let authorized=false;
  const login=ownerLogin({authUrl:'http://private-auth'}, async req=>{assert.equal(req.headers.authorization,'Bearer '+token);authorized=true;}, async(url,options)=>{
    assert.equal(url,'http://private-auth/token?grant_type=password'); assert.equal(options.redirect,'error');
    assert.deepEqual(JSON.parse(options.body),{email:'owner@example.test',password:'password'});
    return Response.json({access_token:token,refresh_token:'must-not-leak',user:{private:'must-not-leak'}});
  });
  const result=await login({email:' Owner@example.test ',password:'password'});
  assert.equal(authorized,true);assert.deepEqual(Object.keys(result).sort(),['accessToken','expiresAt']);
  assert.equal(result.accessToken,token);assert.ok(result.expiresAt>Date.now());
  for(const bad of [null,[],{email:'bad',password:'x'},{email:'a@b.test',password:''},{email:'a@b.test',password:'x',url:'http://attacker'}]) assert.throws(()=>validateLogin(bad));
  const denied=ownerLogin({authUrl:'http://private-auth'},async()=>{throw new HttpError(403,'Owner required');},async()=>Response.json({access_token:token}));
  await assert.rejects(denied({email:'a@b.test',password:'x'}),error=>error.status===403);
  const invalid=ownerLogin({authUrl:'http://private-auth'},async()=>{throw Error('must not call');},async()=>Response.json({error:'private detail'},{status:400}));
  await assert.rejects(invalid({email:'a@b.test',password:'x'}),error=>error.status===401&&!error.message.includes('private detail'));
});
test('HTTP login is bounded and rate limited without changing existing job authorization', async()=>{
  let calls=0;
  const server=createServer(createHandler({jobs:{latest:()=>null},authorize:async()=>{throw new HttpError(401,'No session');},login:async body=>{calls++;validateLogin(body);return {accessToken:token,expiresAt:Date.now()+30000};}}));
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  const post=body=>fetch(base+'/session',{method:'POST',headers:{'content-type':'application/json'},body});
  try {
    assert.equal((await(await fetch(base+'/health')).json()).nativeLogin,true);
    assert.equal((await fetch(base+'/jobs')).status,401);
    assert.equal((await fetch(base+'/session',{method:'POST',body:'x'})).status,415);
    assert.equal((await post('x'.repeat(4097))).status,413);assert.equal(calls,0);
    assert.equal((await post('{')).status,400);
    for(let i=0;i<3;i++) assert.equal((await post(JSON.stringify({email:'owner@example.test',password:'x'}))).status,200);
    assert.equal((await post(JSON.stringify({email:'owner@example.test',password:'x'}))).status,429);
    assert.equal(calls,3);
  } finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
