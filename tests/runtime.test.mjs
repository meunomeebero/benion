import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,chmod,lstat,symlink,unlink,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {runtimeConfig,AdminAccess} from '../runtime.mjs';
import {createBenionServer} from '../server.mjs';

const ORIGIN='https://benion-test.example';
const PASSWORD='test-only-password-32-characters';
const ENV={BENION_MODE:'production',BENION_PUBLIC_ORIGIN:ORIGIN,BENION_ADMIN_PASSWORD:PASSWORD,BENION_SESSION_SECRET:'test-only-session-secret-64-characters-long-enough',BENION_RELEASE_REVISION:'abc123abc123'};
const OWNER={primaryAccount:{id:'17841400000000100',username:'example.owner'},legacy:null};
async function fixture(extra={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'benion-runtime-'));const webRoot=path.join(directory,'public');await mkdir(webRoot);
  await writeFile(path.join(webRoot,'index.html'),'private-dashboard');
  const connection={status:()=>({connected:false}),stopAutomation:()=>({}),connect:async()=>({connected:false}),verifyAccess:async()=>({connected:false}),startAutomation:async()=>({})};
  const privateDirectory=path.join(directory,'private');
  const create=()=>createBenionServer({env:ENV,config:runtimeConfig(ENV),webRoot,privateDirectory,owner:OWNER,connection,...extra});
  let app=create();let port;
  const listen=async()=>{await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));port=app.server.address().port;};
  const stop=async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));};
  await listen();
  const request=(pathname,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:pathname,method,headers:{Host:'benion-test.example',...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()}));
    });req.on('error',reject);if(body)req.write(body);req.end();
  });
  const login=async(password=PASSWORD)=>{
    const response=await request('/admin/login',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password}).toString()});
    return {response,cookie:response.headers['set-cookie']?.[0]?.split(';')[0]};
  };
  return {get app(){return app;},request,login,privateDirectory,webRoot,restart:async()=>{await stop();app=create();await listen();},close:async()=>{await stop();await rm(directory,{recursive:true,force:true});}};
}
const apiHeaders=cookie=>({Cookie:cookie,'X-Benion-Request':'1','Sec-Fetch-Site':'same-origin'});

test('production requires HTTPS origin and distinct sufficiently strong login/session configuration',()=>{
  assert.throws(()=>runtimeConfig({BENION_MODE:'production'}));
  assert.throws(()=>runtimeConfig({...ENV,BENION_PUBLIC_ORIGIN:'http://benion-test.example'}));
  assert.throws(()=>runtimeConfig({...ENV,BENION_ADMIN_PASSWORD:'short'}));
  assert.throws(()=>runtimeConfig({...ENV,BENION_ADMIN_PASSWORD:ENV.BENION_SESSION_SECRET}));
  assert.equal(runtimeConfig(ENV).host,'0.0.0.0');assert.equal(runtimeConfig({}).host,'127.0.0.1');
});

test('failed guesses are throttled without allowing strangers to lock out the correct owner password',async()=>{
  const fx=await fixture();try{
    for(let i=0;i<10;i++)assert.equal((await fx.login('wrong-password')).response.status,303);
    assert.equal((await fx.login('another-wrong-password')).response.status,429);
    const owner=await fx.login();assert.equal(owner.response.status,303);assert.ok(owner.cookie);
  }finally{await fx.close();}
});

test('anonymous cloud visitors can read privacy and health, but not leads, dashboard, code or API',async()=>{
  const fx=await fixture();try{
    assert.equal((await fx.request('/')).status,303);
    assert.equal((await fx.request('/data/recovery.json')).status,303);
    assert.equal((await fx.request('/app.mjs')).status,303);
    const api=await fx.request('/api/connection/status');assert.equal(api.status,401);assert.equal(api.text.includes('token'),false);
    const health=await fx.request('/health');assert.deepEqual(JSON.parse(health.text),{service:'benion',status:'ready',revision:'abc123abc123'});
    const privacy=await fx.request('/privacy');assert.equal(privacy.status,200);assert.doesNotMatch(privacy.text,/\{\{[A-Z_]+\}\}/);
    assert.equal((await fx.request('/admin/login')).status,200);
  }finally{await fx.close();}
});

test('login document keeps form origin available while null, missing and foreign origins stay forbidden',async()=>{
  const fx=await fixture();try{
    for(const pathname of ['/admin/login','/admin/login?error=1']){
      const page=await fx.request(pathname);
      assert.equal(page.status,200);
      assert.equal(page.headers['referrer-policy'],'same-origin');
      assert.match(page.headers['content-security-policy'],/form-action 'self'/);
      assert.match(page.text,/<form method="post" action="\/admin\/login">/);
      assert.equal(page.headers['set-cookie'],undefined);
    }
    assert.equal((await fx.request('/health')).headers['referrer-policy'],'no-referrer');
    for(const origin of ['null',undefined,'https://foreign.example']){
      const headers={'Content-Type':'application/x-www-form-urlencoded',...(origin===undefined?{}:{Origin:origin})};
      const rejected=await fx.request('/admin/login',{method:'POST',headers,body:new URLSearchParams({password:PASSWORD}).toString()});
      assert.equal(rejected.status,403);
      assert.equal(rejected.text,'Acesso recusado.');
      assert.equal(rejected.headers['set-cookie'],undefined);
    }
    const accepted=await fx.login();
    assert.equal(accepted.response.status,303);assert.equal(accepted.response.headers.location,'/');
    assert.ok(accepted.cookie);assert.equal((await fx.request('/',{headers:{Cookie:accepted.cookie}})).text,'private-dashboard');
  }finally{await fx.close();}
});

test('login is same-origin, password checked and session tampering or foreign Host cannot reveal private data',async()=>{
  const fx=await fixture();try{
    const rejected=await fx.request('/admin/login',{method:'POST',headers:{Origin:'https://foreign.example','Content-Type':'application/x-www-form-urlencoded'},body:'password='+PASSWORD});assert.equal(rejected.status,403);
    const wrong=await fx.login('wrong-password');assert.equal(wrong.response.headers.location,'/admin/login?error=1');assert.equal(wrong.cookie,undefined);
    const {response,cookie}=await fx.login();assert.equal(response.status,303);assert.match(response.headers['set-cookie'][0],/HttpOnly; Secure; SameSite=Strict/);
    const dashboard=await fx.request('/',{headers:{Cookie:cookie}});assert.equal(dashboard.text,'private-dashboard');
    assert.equal((await fx.request('/',{headers:{Cookie:cookie+'a'}})).status,303);
    assert.equal((await fx.request('/',{headers:{Cookie:cookie,Host:'foreign.example'}})).status,303);
    assert.equal((await fx.request('/.benion-private/connection.json',{headers:{Cookie:cookie}})).status,404);
  }finally{await fx.close();}
});

test('new API mutations require admin session plus single-use CSRF bound to that session and exact origin',async()=>{
  let writes=0;const catalog={get:async()=>({products:[]}),set:async body=>{writes++;return body;}};
  const fx=await fixture({catalog});try{
    const {cookie}=await fx.login();
    const nonce=JSON.parse((await fx.request('/api/csrf',{headers:apiHeaders(cookie)})).text).nonce;
    const second=(await fx.login()).cookie;
    const mutation={method:'POST',headers:{...apiHeaders(cookie),Origin:ORIGIN,'Content-Type':'application/json','X-Benion-CSRF':nonce},body:'{"products":[]}'};
    assert.equal((await fx.request('/api/catalog',{...mutation,headers:{...mutation.headers,Origin:'https://foreign.example'}})).status,403);
    assert.equal((await fx.request('/api/catalog',{...mutation,headers:{...mutation.headers,Cookie:second}})).status,403);
    assert.equal(writes,0);
    assert.equal((await fx.request('/api/catalog',mutation)).status,200);assert.equal(writes,1);
    assert.equal((await fx.request('/api/catalog',mutation)).status,403);assert.equal(writes,1);
    const status=await fx.request('/api/connection/status',{headers:apiHeaders(cookie)});assert.equal(status.status,200);assert.equal(JSON.parse(status.text).runtime.environment,'hosted');
  }finally{await fx.close();}
});

test('owner sessions persist beyond twelve hours and server restarts; active visits renew the browser cookie',async()=>{
  let now=Date.parse('2026-10-09T12:00:00Z');const fx=await fixture({clock:()=>now});
  try{
    const {response,cookie}=await fx.login();
    assert.match(cookie,/^benion_admin=v2\.[a-f0-9]{64}\.[a-f0-9]{64}$/);
    assert.match(response.headers['set-cookie'][0],/Max-Age=34560000/);
    const stored=await readFile(path.join(fx.privateDirectory,'admin-sessions.json'),'utf8');
    assert.equal(stored.includes(cookie),false);assert.equal(stored.includes(cookie.split('.')[1]),false);assert.equal(stored.includes(PASSWORD),false);
    assert.equal((await lstat(fx.privateDirectory)).mode&0o777,0o700);
    assert.equal((await lstat(path.join(fx.privateDirectory,'admin-sessions.json'))).mode&0o777,0o600);
    now+=13*60*60*1000;await fx.restart();
    const page=await fx.request('/admin/login',{headers:{Cookie:cookie}});
    assert.equal(page.status,303);assert.equal(page.headers.location,'/');
    assert.equal(page.headers['set-cookie'][0].split(';')[0],cookie);
    assert.match(page.headers['set-cookie'][0],/Max-Age=34560000/);
    now+=401*24*60*60*1000;
    const dashboard=await fx.request('/',{headers:{Cookie:cookie}});
    assert.equal(dashboard.text,'private-dashboard');assert.match(dashboard.headers['set-cookie'][0],/Max-Age=34560000/);
    assert.equal((await fx.request('/api/connection/status',{headers:apiHeaders(cookie)})).status,200);
  }finally{await fx.close();}
});

test('connection nonce responses preserve admin renewal and the existing first-cookie contract',async()=>{
  let verified=0;const fx=await fixture({connection:{status:()=>({connected:false}),verifyAccess:async()=>{verified++;return {connected:false};}}});
  try{
    const {cookie}=await fx.login();const response=await fx.request('/api/connection/csrf',{headers:apiHeaders(cookie)});
    assert.equal(response.status,200);assert.equal(response.headers['set-cookie'].length,2);
    assert.match(response.headers['set-cookie'][0],/^benion_csrf=[a-f0-9]{64};.*HttpOnly;.*SameSite=Strict;.*Secure/);
    assert.equal(response.headers['set-cookie'][1].split(';')[0],cookie);
    const cookies=cookie+'; '+response.headers['set-cookie'][0].split(';')[0];
    const mutation={method:'POST',headers:{...apiHeaders(cookies),Origin:ORIGIN,'Content-Type':'application/json','X-Benion-CSRF':JSON.parse(response.text).nonce},body:'{}'};
    assert.equal((await fx.request('/api/connection/verify',mutation)).status,200);assert.equal(verified,1);
    assert.equal((await fx.request('/api/connection/verify',mutation)).status,403);assert.equal(verified,1);
  }finally{await fx.close();}
});

test('explicit logout requires same-origin single-use CSRF and revokes copied cookies durably without ending another session',async()=>{
  const fx=await fixture();try{
    const {cookie}=await fx.login();const other=(await fx.login()).cookie;
    const nonce=JSON.parse((await fx.request('/api/csrf',{headers:apiHeaders(cookie)})).text).nonce;
    const mutation={method:'POST',headers:{...apiHeaders(cookie),Origin:ORIGIN,'Content-Type':'application/json','X-Benion-CSRF':nonce},body:'{}'};
    for(const origin of ['null','https://foreign.example',undefined]){
      const headers={...mutation.headers};if(origin===undefined)delete headers.Origin;else headers.Origin=origin;
      assert.equal((await fx.request('/api/admin/logout',{...mutation,headers})).status,403);
    }
    assert.equal((await fx.request('/api/admin/logout',{headers:apiHeaders(cookie)})).status,404);
    assert.equal((await fx.request('/api/admin/logout',{...mutation,headers:{...mutation.headers,'X-Benion-CSRF':'missing'}})).status,403);
    assert.equal((await fx.request('/',{headers:{Cookie:cookie}})).text,'private-dashboard');
    const logout=await fx.request('/api/admin/logout',mutation);
    assert.equal(logout.status,200);assert.deepEqual(JSON.parse(logout.text),{loggedOut:true});assert.match(logout.headers['set-cookie'][0],/^benion_admin=;.*Max-Age=0/);
    assert.equal((await fx.request('/api/csrf',{headers:apiHeaders(cookie)})).status,401);
    assert.equal((await fx.request('/api/admin/logout',mutation)).status,401);
    await fx.restart();
    assert.equal((await fx.request('/',{headers:{Cookie:cookie}})).status,303);
    assert.equal((await fx.request('/',{headers:{Cookie:other}})).text,'private-dashboard');
    assert.equal((await fx.login()).response.status,303,'owner can explicitly log in again with the unchanged password');
  }finally{await fx.close();}
});

test('a still-valid legacy cookie upgrades without a password and keeps its CSRF binding beyond the old expiration',async()=>{
  let now=Date.parse('2026-10-09T12:00:00Z');const fx=await fixture({clock:()=>now});
  try{
    const value='ab'.repeat(32)+'.'+(now+12*60*60*1000);const cookie='benion_admin='+value+'.'+createHmac('sha256',ENV.BENION_SESSION_SECRET).update(value).digest('hex');
    const csrf=await fx.request('/api/csrf',{headers:apiHeaders(cookie)});
    assert.equal(csrf.status,200);assert.equal(csrf.headers['set-cookie'][0].split(';')[0],cookie);
    const nonce=JSON.parse(csrf.text).nonce;
    now+=13*60*60*1000;
    const logout=await fx.request('/api/admin/logout',{method:'POST',headers:{...apiHeaders(cookie),Origin:ORIGIN,'Content-Type':'application/json','X-Benion-CSRF':nonce},body:'{}'});
    assert.equal(logout.status,403,'the old five-minute nonce expires independently from the persistent session');
    assert.equal((await fx.request('/',{headers:{Cookie:cookie}})).text,'private-dashboard');
    await fx.restart();assert.equal((await fx.request('/admin/login',{headers:{Cookie:cookie}})).status,303);
    const fresh=JSON.parse((await fx.request('/api/csrf',{headers:apiHeaders(cookie)})).text).nonce;
    assert.equal((await fx.request('/api/admin/logout',{method:'POST',headers:{...apiHeaders(cookie),Origin:ORIGIN,'Content-Type':'application/json','X-Benion-CSRF':fresh},body:'{}'})).status,200);
    assert.equal((await fx.request('/',{headers:{Cookie:cookie}})).status,303);
  }finally{await fx.close();}
});

test('logout of a migrated legacy cookie cannot recreate the session within the original twelve-hour window',async()=>{
  let now=Date.parse('2026-10-09T12:00:00Z');const fx=await fixture({clock:()=>now});
  try{
    const value='cd'.repeat(32)+'.'+(now+12*60*60*1000);const cookie='benion_admin='+value+'.'+createHmac('sha256',ENV.BENION_SESSION_SECRET).update(value).digest('hex');
    const nonce=JSON.parse((await fx.request('/api/csrf',{headers:apiHeaders(cookie)})).text).nonce;
    assert.equal((await fx.request('/api/admin/logout',{method:'POST',headers:{...apiHeaders(cookie),Origin:ORIGIN,'Content-Type':'application/json','X-Benion-CSRF':nonce},body:'{}'})).status,200);
    now+=60*60*1000;await fx.restart();
    assert.equal((await fx.request('/admin/login',{headers:{Cookie:cookie}})).status,200);
    assert.equal((await fx.request('/api/csrf',{headers:apiHeaders(cookie)})).status,401);
  }finally{await fx.close();}
});

test('unsafe session registry permissions, corruption or symlinks fail closed and cannot replace the private state',async()=>{
  const fx=await fixture();try{
    const {cookie}=await fx.login();const filename=path.join(fx.privateDirectory,'admin-sessions.json');
    const saved=await readFile(filename,'utf8');
    await chmod(filename,0o644);
    assert.equal((await fx.request('/',{headers:{Cookie:cookie}})).status,303);assert.equal((await fx.login()).cookie,undefined);
    assert.equal(await readFile(filename,'utf8'),saved);
    await chmod(filename,0o600);await writeFile(filename,'{"version":1,"sessions":null}');
    assert.equal((await fx.request('/api/csrf',{headers:apiHeaders(cookie)})).status,401);assert.equal((await fx.login()).cookie,undefined);
    assert.equal(await readFile(filename,'utf8'),'{"version":1,"sessions":null}');
    await writeFile(filename,saved);await chmod(fx.privateDirectory,0o755);
    assert.equal((await fx.request('/',{headers:{Cookie:cookie}})).status,303);assert.equal((await fx.login()).cookie,undefined);
    await chmod(fx.privateDirectory,0o700);const victim=path.join(fx.webRoot,'victim.json');await writeFile(victim,'unchanged');
    await unlink(filename);await symlink(victim,filename);
    assert.equal((await fx.request('/',{headers:{Cookie:cookie}})).status,303);assert.equal((await fx.login()).cookie,undefined);
    assert.equal(await readFile(victim,'utf8'),'unchanged');
  }finally{await fx.close();}
});

test('the session store cannot be served publicly and missing registry entries cannot authenticate signed opaque cookies',async()=>{
  const fx=await fixture();try{
    assert.throws(()=>new AdminAccess(runtimeConfig(ENV),{privateDirectory:fx.webRoot,servedRoot:fx.webRoot}),/SESSION_STORE_UNSAFE/);
    assert.throws(()=>new AdminAccess(runtimeConfig(ENV),{privateDirectory:path.join(fx.webRoot,'private'),servedRoot:fx.webRoot}),/SESSION_STORE_UNSAFE/);
    const value='v2.'+'ef'.repeat(32);const cookie='benion_admin='+value+'.'+createHmac('sha256',ENV.BENION_SESSION_SECRET).update(value).digest('hex');
    assert.equal((await fx.request('/',{headers:{Cookie:cookie}})).status,303);
    await mkdir(fx.privateDirectory,{mode:0o700});
    const target=path.join(fx.webRoot,'elsewhere');await mkdir(target,{mode:0o700});
    await rm(fx.privateDirectory,{recursive:true});await symlink(target,fx.privateDirectory);
    assert.equal((await fx.login()).cookie,undefined);
    await assert.rejects(readFile(path.join(target,'admin-sessions.json')),error=>error.code==='ENOENT');
  }finally{await fx.close();}
});

test('legacy migration cannot overflow the durable session registry or replace it with unreadable state',async()=>{
  const now=Date.parse('2026-10-09T12:00:00Z');const fx=await fixture({clock:()=>now});
  try{
    await fx.login();const filename=path.join(fx.privateDirectory,'admin-sessions.json');
    const state={version:1,sessions:Object.fromEntries(Array.from({length:4096},(_,i)=>[i.toString(16).padStart(64,'0'),{createdAt:now}])),revokedLegacy:{}};
    const encoded=JSON.stringify(state);await writeFile(filename,encoded);
    const value='12'.repeat(32)+'.'+(now+12*60*60*1000);const cookie='benion_admin='+value+'.'+createHmac('sha256',ENV.BENION_SESSION_SECRET).update(value).digest('hex');
    assert.equal((await fx.request('/',{headers:{Cookie:cookie}})).status,400);
    assert.equal(await readFile(filename,'utf8'),encoded);
  }finally{await fx.close();}
});

test('verified signed webhooks persist before acknowledgement; altered raw bytes never reach inbox',async()=>{
  const secret='test-only-meta-app-secret';let calls=0,persisted=false;
  const inbox={ingestWebhook:async(payload,verification)=>{assert.equal(verification.signatureVerified,true);assert.equal(verification.verifiedAccountId,OWNER.primaryAccount.id);assert.equal(payload.object,'instagram');calls++;persisted=true;},processPending:async()=>{assert.equal(persisted,true);}};
  const fx=await fixture({env:{...ENV,BENION_META_APP_SECRET:secret,BENION_META_VERIFY_TOKEN:'test-verifier'},inbox});
  try{
    const body=JSON.stringify({object:'instagram',entry:[{id:OWNER.primaryAccount.id}]});const signature='sha256='+createHmac('sha256',secret).update(body).digest('hex');
    assert.equal((await fx.request('/webhooks/instagram',{method:'POST',headers:{'X-Hub-Signature-256':signature,'Content-Type':'application/json'},body:body+' '})).status,403);assert.equal(calls,0);
    assert.equal((await fx.request('/webhooks/instagram',{method:'POST',headers:{'X-Hub-Signature-256':signature,'Content-Type':'application/json'},body})).status,200);assert.equal(calls,1);
    const verify=await fx.request('/webhooks/instagram?hub.mode=subscribe&hub.verify_token=test-verifier&hub.challenge=123');assert.equal(verify.text,'123');
    assert.equal((await fx.request('/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123')).status,403);
  }finally{await fx.close();}
});
