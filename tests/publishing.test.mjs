import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { PublishingService } from '../publishing.mjs';
import { CampaignService, DEFAULT_PUBLIC_REPLIES } from '../campaigns.mjs';
import { GraphClient, SendLedger } from '../integrations/meta.mjs';
import { createBenionServer } from '../server.mjs';
import { runtimeConfig } from '../runtime.mjs';
const ACCOUNT='17841400000000100', OTHER='17840000000000002', USERNAME='example.owner';
const ORIGIN='https://publishing.example', PASSWORD='publishing-test-only-password';
const ENV={BENION_MODE:'production',BENION_PUBLIC_ORIGIN:ORIGIN,BENION_ADMIN_PASSWORD:PASSWORD,BENION_SESSION_SECRET:'publishing-test-only-session-secret-long-enough'};
async function fixture(t,{uncertain=false}={}){
 const root=await mkdtemp(path.join(os.tmpdir(),'benion-publishing-test-'));const webRoot=path.join(root,'public');await mkdir(webRoot);
 let now=Date.parse('2026-10-21T12:00:00Z');let publishCount=0,dmCount=0,publicCount=0;let published=false;let comments=[];let publishing,campaigns;
 const dataDir=path.join(root,'private');await mkdir(dataDir,{mode:0o700});
 const ledger=new SendLedger({directory:path.join(dataDir,'ledger'),clock:()=>now});
 const client=new GraphClient({accountId:ACCOUNT,accessToken:'fixture-token-not-real',apiVersion:'v26.0',ledger,clock:()=>now,fetchImpl:async(url,options)=>{
  const endpoint=url.pathname;const payload=options.body?JSON.parse(options.body):null;let body;
  if(endpoint.endsWith('/media')&&options.method==='POST'){assert.equal(payload.media_type,'REELS');body={id:'300'};}
  else if(endpoint.endsWith('/media_publish')){publishCount++;const state=JSON.parse(await readFile(path.join(dataDir,'publishing.json'),'utf8'));assert.equal(state.jobs[0].state,'publishing');assert.equal((await publishing.routing()).blocked,true);published=true;if(!uncertain)comments.push({id:'500',text:'Oi',timestamp:new Date(now).toISOString(),username:'test_person',from:{id:'200',username:'test_person'}});if(uncertain)throw new Error('simulated lost POST response');body={id:'400'};}
  else if(endpoint==='/v26.0/300/')body={status_code:'FINISHED'};
  else if(endpoint.endsWith('/media'))body={data:[{id:'100',shortcode:'BaseReel',permalink:'https://www.instagram.com/reel/BaseReel/',comments_count:0},...(published?[{id:'400',shortcode:'NewReel',permalink:'https://www.instagram.com/reel/NewReel/',comments_count:comments.length}]:[])]};
  else if(endpoint.endsWith('/comments'))body={data:endpoint.endsWith('/100/comments')?[]:comments};
  else if(endpoint.endsWith('/messages')){dmCount++;assert.equal(payload.message.text,'Oi, teste gratuito!\n\nhttps://example.com/trial');body={recipient_id:'200',message_id:'accepted-dm-1'};}
  else if(endpoint.endsWith('/replies')){publicCount++;assert.ok(DEFAULT_PUBLIC_REPLIES.includes(payload.message));body={id:'900'};}
  else throw new Error('Unexpected fixture endpoint '+endpoint);
  return {ok:true,status:200,json:async()=>body};
 }});
 const provider=async()=>({client,ledger,identity:{userId:ACCOUNT,username:USERNAME}});
 const services=[];
 function runtime(){campaigns=new CampaignService({dataDir,clientProvider:provider,clock:()=>now,accountId:ACCOUNT,accountUsername:USERNAME,mediaEligibility:async id=>{const r=await publishing.routing();return (!r.blocked||r.knownMediaIds.includes(id))&&!r.mediaIds.includes(id);}});publishing=new PublishingService({dataDir,accountId:ACCOUNT,clientProvider:provider,campaigns,clock:()=>now,origin:ORIGIN});services.push({campaigns,publishing});return{campaigns,publishing};}
 runtime();
 const otherDir=path.join(root,'other');await mkdir(otherDir,{mode:0o700});
 const other=new PublishingService({dataDir:otherDir,accountId:OTHER,clientProvider:async()=>({client,identity:{userId:OTHER}}),campaigns:{},clock:()=>now,origin:ORIGIN});
 const connection={status:()=>({connected:true}),messagingContext:provider};
 const accounts={resolve:async(id=ACCOUNT)=>{if(id===ACCOUNT)return{connection,campaigns,publishing};if(id===OTHER)return{connection,publishing:other};throw new Error('ACCOUNT_NOT_FOUND');},runtimes:async()=>[{connection,campaigns,publishing}],list:async()=>({accounts:[]})};
 const app=createBenionServer({env:ENV,config:runtimeConfig(ENV),webRoot,privateDirectory:dataDir,connection,accounts,clock:()=>now});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const s of services){await s.publishing.shutdown();await s.campaigns.shutdown();}app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));await rm(root,{recursive:true,force:true});});
 const request=(url,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:app.server.address().port,path:url,method,headers:{Host:'publishing.example',...headers}},res=>{const parts=[];res.on('data',p=>parts.push(p));res.on('end',()=>{const buffer=Buffer.concat(parts);resolve({status:res.statusCode,headers:res.headers,buffer,json:()=>JSON.parse(buffer.toString())});});});req.on('error',reject);if(body)req.write(body);req.end();});
 const login=await request('/admin/login',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password:PASSWORD}).toString()});
 const cookie=login.headers['set-cookie'][0].split(';')[0];const headers={Cookie:cookie,'X-Benion-Request':'1',Origin:ORIGIN};
 const api=(url,options={})=>request(url,{...options,headers:{...headers,...options.headers}});
 const post=async(url,body,extra={})=>{const nonce=(await api('/api/csrf')).json().nonce;return api(url,{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json','X-Benion-CSRF':nonce,...extra}});};
 const group={id:randomUUID(),name:'Campanha gratuita'};
 const job={id:randomUUID(),groupId:group.id,title:'Reel 1',videoUrl:'https://media.example/video.mp4',caption:'Legenda de teste',scheduledAt:new Date(now+16*60000).toISOString(),dmText:'Oi, teste gratuito!',dmLink:'https://example.com/trial'};
 return {request,api,post,group,job,app,dataDir,runtime,get campaigns(){return campaigns;},get publishing(){return publishing;},advance:ms=>{now+=ms;},comment:()=>comments.push({id:'500',text:'Oi',timestamp:new Date(now).toISOString(),username:'test_person',from:{id:'200',username:'test_person'}}),counts:()=>({publishCount,dmCount,publicCount})};
}

test('HTTP scheduling → restart → publish → fixed public reply + DM → durable comparison; account isolation and cancellation',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/api/publishing')).status,401);
 assert.equal((await f.api('/api/publishing/groups',{method:'POST',body:JSON.stringify(f.group),headers:{'Content-Type':'application/json'}})).status,403);
 const general=await f.campaigns.create({name:'Automação geral',scope:'all_reels',mediaId:null,messageText:'Outro link https://example.com',keywords:[]});await f.campaigns.start(general.id);
 assert.equal((await f.post('/api/publishing/groups',f.group)).status,200);
 assert.equal((await f.post('/api/publishing/reels',{...f.job,publicReplies:['Injected reply']})).status,400);
 assert.equal((await f.post('/api/publishing/reels',f.job)).status,200);
 assert.equal((await f.post('/api/publishing/reels',f.job)).status,200);
 assert.equal((await f.post('/api/publishing/reels',{...f.job,dmText:'Different draft'})).json().error,'SCHEDULE_CONFLICT');
 assert.equal((await f.api('/api/publishing',{headers:{'X-Benion-Account':OTHER}})).json().jobs.length,0);
 assert.equal((await f.post(`/api/publishing/reels/${f.job.id}/cancel`,{},{'X-Benion-Account':OTHER})).status,400);
 const cancelled={...f.job,id:randomUUID(),title:'Reel 2'};await f.post('/api/publishing/reels',cancelled);assert.equal((await f.post(`/api/publishing/reels/${cancelled.id}/cancel`,{})).status,200);
 await f.app.worker();assert.deepEqual(f.counts(),{publishCount:0,dmCount:0,publicCount:0});
 await f.campaigns.shutdown();await f.publishing.shutdown();f.runtime();
 f.advance(2*60000);await f.app.worker();assert.equal((await f.publishing.list()).jobs[0].state,'ready');assert.equal(f.counts().publishCount,0);
 f.advance(14*60000);await f.app.worker();assert.equal((await f.publishing.list()).jobs[0].state,'active');assert.equal(f.counts().publishCount,1);
 assert.equal((await f.campaigns.status(general.id)).status.running,true);await f.campaigns.pollOnce(general.id);assert.equal(f.counts().dmCount,0);
 f.advance(60000);await f.campaigns.pollOnce(f.job.id);
 assert.deepEqual(f.counts(),{publishCount:1,dmCount:1,publicCount:1});
 assert.deepEqual((await f.api('/api/publishing')).json().jobs[0].metrics,{accepted:1,unknown:0,rejected:0,publicAccepted:1});
 await f.campaigns.stop(f.job.id);await assert.rejects(()=>f.campaigns.update(f.job.id,{publicReplies:['alterada']}),{code:'PUBLICATION_RULES_FIXED'});await f.campaigns.shutdown();await f.publishing.shutdown();f.runtime();await f.app.worker();
 const result=(await f.api('/api/publishing')).json();assert.equal(result.jobs.length,2);assert.equal(result.jobs[0].metrics.accepted,1);assert.equal(result.jobs[0].automation.enabled,false);assert.equal(result.jobs[1].state,'cancelled');assert.equal(f.counts().publishCount,1);
});

test('ambiguous publication survives restart without another POST or wrong all-Reels DM',async t=>{
 const f=await fixture(t,{uncertain:true});await f.post('/api/publishing/groups',f.group);await f.post('/api/publishing/reels',f.job);f.advance(16*60000);await f.app.worker();
 assert.equal((await f.publishing.list()).jobs[0].reason,'PUBLISH_OUTCOME_UNKNOWN');assert.equal((await f.publishing.routing()).blocked,true);assert.deepEqual((await f.publishing.routing()).knownMediaIds,['100']);
 await f.publishing.shutdown();await f.campaigns.shutdown();f.runtime();await f.app.worker();assert.equal(f.counts().publishCount,1);assert.equal((await f.publishing.list()).jobs[0].mediaId,null);
});

test('MP4 upload is authenticated and scoped; Meta can read only the opaque video URL, including range requests',async t=>{
 const f=await fixture(t);const bytes=Buffer.concat([Buffer.from([0,0,0,16]),Buffer.from('ftypisom'),Buffer.alloc(16)]);
 const nonce=(await f.api('/api/csrf')).json().nonce;
 const response=await f.api('/api/publishing/video',{method:'POST',headers:{'Content-Type':'video/mp4','Content-Length':bytes.length,'X-Benion-CSRF':nonce},body:bytes});assert.equal(response.status,200);
 const url=new URL(response.json().videoUrl);const full=await f.request(url.pathname);assert.equal(full.status,200);assert.deepEqual(full.buffer,bytes);
 const part=await f.request(url.pathname,{headers:{Range:'bytes=4-7'}});assert.equal(part.status,206);assert.equal(part.buffer.toString(),'ftyp');
 assert.equal((await f.request(url.pathname.replace(ACCOUNT,OTHER))).status,404);assert.equal((await f.request('/videos/'+ACCOUNT+'/publishing.json')).status,303);
 assert.equal((await f.request('/api/publishing/video',{method:'POST',body:bytes,headers:{'Content-Type':'video/mp4','Content-Length':bytes.length}})).status,401);
});
