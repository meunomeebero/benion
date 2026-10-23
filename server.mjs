import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConnectionHandler } from './connection.mjs';
import { inspectInstagramToken, validateWebhookSignature, verifyWebhookQuery } from './integrations/meta.mjs';
import { runtimeConfig, AdminAccess, loginPage, readRequest } from './runtime.mjs';
import { AccountRegistry, createAccountRuntime } from './accounts.mjs';
import { ModelProviderStore, DEFAULT_MODEL } from './llm-provider.mjs';
import { loadOwnerConfig } from './owner-config.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const packagedRelease=await fs.readFile(path.join(root,'release.json'),'utf8').then(JSON.parse).catch(()=>null);
const staticFiles=new Map([['/','index.html'],['/index.html','index.html'],['/styles.css','styles.css'],['/app.mjs','app.mjs'],['/simulator.mjs','simulator.mjs'],['/ui/api.mjs','ui/api.mjs']]);
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8'};
const securityHeaders={
  'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
  'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
const within=(candidate,base)=>{const relative=path.relative(base,candidate);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
const escapeHTML=value=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

// BENION_DATA_DIR isolates an install; otherwise keep the historical locations.
function privateDirectoryFor(env,config,webRoot){
  if(!env.BENION_DATA_DIR)return config.production?path.join(root,'.benion-private'):path.join(os.homedir(),'.local','share','benion');
  const directory=path.resolve(env.BENION_DATA_DIR);
  if(!path.isAbsolute(env.BENION_DATA_DIR)||within(directory,path.resolve(webRoot)))throw new Error('BENION_DATA_DIR_INVALID');
  return directory;
}
function privacyPage(template,env){
  const name=typeof env.BENION_OPERATOR_NAME==='string'?env.BENION_OPERATOR_NAME.trim():'';
  const email=typeof env.BENION_PRIVACY_EMAIL==='string'?env.BENION_PRIVACY_EMAIL.trim():'';
  return template.replaceAll('{{OPERATOR_NAME}}',escapeHTML(name&&name.length<=120?name:'the operator of this Benion instance'))
    .replaceAll('{{PRIVACY_EMAIL}}',escapeHTML(/^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email)?email:'contact not configured'));
}

export function createBenionServer({env=process.env,config=runtimeConfig(env),webRoot=config.production?path.join(root,'public'):root,privateDirectory=privateDirectoryFor(env,config,webRoot),owner=null,connection=null,inbox=null,catalog=null,assistantConfig=null,previewAssistant=null,campaigns=null,publishing=null,assertAssistantActivation=null,accounts=null,modelProvider=null,inspectToken=inspectInstagramToken,clock=Date.now}={}){
  // Injected services describe the configured primary account; they need owner config.
  if(connection&&!owner&&!accounts)throw new Error('OWNER_CONFIG_REQUIRED');
  const access=new AdminAccess(config,{clock,privateDirectory,servedRoot:webRoot});
  const runtime={environment:config.production?'hosted':'local'};
  const runtimeFactory=({account,dataDir,legacy=null})=>createAccountRuntime({account,dataDir,servedRoot:webRoot,inspectToken,env,clock,modelProvider,legacy});
  // The configured primary account keeps the original root private layout.
  const primaryRuntime=!owner?null:connection?{connection,inbox,catalog,assistantConfig,previewAssistant,campaigns,publishing,assertAssistantActivation,legacy:owner.legacy}
    :runtimeFactory({account:owner.primaryAccount,dataDir:privateDirectory,legacy:owner.legacy});
  accounts ||= new AccountRegistry({privateDirectory,servedRoot:webRoot,inspectToken,clock,
    primaryAccount:owner?.primaryAccount??null,primaryRuntime,runtimeFactory});
  const handlers=new WeakMap();
  const controlled=selected=>{
    if(handlers.has(selected))return handlers.get(selected);
    const {connection,campaigns}=selected;
    let transitions=Promise.resolve();
    const transition=operation=>{const next=transitions.then(operation,operation);transitions=next.catch(()=>{});return next;};
    const service={status:()=>({...connection.status(),runtime}),connect:async b=>({...await connection.connect(b),runtime}),verifyAccess:async b=>({...await connection.verifyAccess(b),runtime}),startAutomation:async b=>transition(async()=>{
      connection.assertAutomationStart?.(b);
      if(campaigns){const active=(await campaigns.list()).runningCampaignId;if(active)await campaigns.stop(active);}
      return {...await connection.startAutomation(b),runtime};
    }),stopAutomation:b=>({...connection.stopAutomation(b),runtime})};
    const controls={transition,connectionHandler:createConnectionHandler({service,origin:config.origin,clock,allowRemote:config.production})};
    handlers.set(selected,controls);return controls;
  };
  const revision=/^[a-f0-9]{64}$/.test(packagedRelease?.revision||'')?packagedRelease.revision:/^[a-f0-9]{7,64}$/.test(env.BENION_RELEASE_REVISION||'')?env.BENION_RELEASE_REVISION:'local';
  const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}).end(JSON.stringify(data));};
  const worker=()=>accounts.runtimes().then(values=>Promise.allSettled(values.flatMap(value=>[
    ...(value.inbox?.processPending?[value.inbox.processPending()]:[]),
    ...(value.campaigns?.restoreRunning?[value.campaigns.restoreRunning()]:[]),
    ...(value.publishing?.processDue?[value.publishing.processDue()]:[]),
  ]))).catch(()=>{});
  const server=http.createServer(async(req,res)=>{
    Object.entries(securityHeaders).forEach(([key,value])=>res.setHeader(key,value));
    if(config.production)res.setHeader('Strict-Transport-Security','max-age=31536000');
    let url;
    try{url=new URL(req.url,config.origin);}catch{json(res,400,{error:'INVALID_REQUEST'});return;}
    try{
      if(url.pathname==='/health'&&req.method==='GET'){json(res,200,{service:'benion',status:'ready',revision});return;}
      const video=/^\/videos\/(\d{1,40})\/([a-f0-9-]{36})\.mp4$/.exec(url.pathname);
      if(video&&['GET','HEAD'].includes(req.method)){
        // Only explicitly uploaded public media. Never expose arbitrary private files.
        let file;
        try{file=await (await accounts.resolve(video[1])).publishing?.videoFile(video[2]);}catch{}
        if(!file){res.writeHead(404).end();return;}
        let start=0,end=file.size-1,status=200;
        if(req.headers.range){const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!range||Number(range[1])>=file.size||range[2]&&Number(range[2])<Number(range[1])){await file.handle.close();res.writeHead(416,{'Content-Range':`bytes */${file.size}`}).end();return;}start=Number(range[1]);end=range[2]?Math.min(Number(range[2]),end):end;status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${file.size}`);}
        res.writeHead(status,{'Content-Type':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes'});
        if(req.method==='HEAD'){await file.handle.close();res.end();return;}
        const stream=file.handle.createReadStream({start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
      }
      if(url.pathname==='/privacy'||url.pathname==='/privacy/'){
        if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
        const body=privacyPage(await fs.readFile(path.join(root,'privacy-page','index.html'),'utf8'),env);
        res.removeHeader('Content-Security-Policy');res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; frame-ancestors 'none'");
        res.writeHead(200,{'Content-Type':types['.html']}).end(req.method==='HEAD'?undefined:body);return;
      }
      const publicAsset=new Map([['/login.css','login.css'],['/tokens.css','tokens.css'],['/fonts/nunito-500.ttf','fonts/nunito-500.ttf'],['/fonts/nunito-700.ttf','fonts/nunito-700.ttf'],['/fonts/nunito-800.ttf','fonts/nunito-800.ttf'],['/fonts/OFL.txt','fonts/OFL.txt']]).get(url.pathname);
      if(publicAsset&&['GET','HEAD'].includes(req.method)){
        const body=await fs.readFile(path.join(root,publicAsset));res.writeHead(200,{'Content-Type':types[path.extname(publicAsset)]}).end(req.method==='HEAD'?undefined:body);return;
      }
      if(url.pathname==='/admin/login'){
        // Native form POSTs need their same-origin Origin; no-referrer makes it null.
        if(req.method==='GET'){
          if(access.authenticated(req)){access.refresh(req,res);res.writeHead(303,{Location:'/'}).end();return;}
          res.setHeader('Referrer-Policy','same-origin');res.writeHead(200,{'Content-Type':types['.html']}).end(loginPage(url.searchParams.get('error')==='1'));return;
        }
        await access.login(req,res);return;
      }
      if(url.pathname==='/webhooks/instagram'){
        if(req.method==='GET'){
          if(!env.BENION_META_VERIFY_TOKEN){res.writeHead(503).end('Webhook ainda não configurado.');return;}
          const check=verifyWebhookQuery(url.searchParams,env.BENION_META_VERIFY_TOKEN);res.writeHead(check.status,{'Content-Type':'text/plain; charset=utf-8'}).end(check.body);return;
        }
        if(req.method!=='POST'){res.writeHead(405).end();return;}
        if(!env.BENION_META_APP_SECRET){json(res,503,{error:'WEBHOOK_NOT_CONFIGURED'});return;}
        const raw=await readRequest(req,{raw:true,maxBytes:262144});
        if(!validateWebhookSignature(raw,req.headers['x-hub-signature-256'],env.BENION_META_APP_SECRET)){json(res,403,{error:'INVALID_SIGNATURE'});return;}
        let payload;try{payload=JSON.parse(raw.toString('utf8'));}catch{json(res,400,{error:'INVALID_BODY'});return;}
        await accounts.ingestWebhook(payload);
        json(res,200,{accepted:true});setImmediate(worker);return;
      }
      if(!access.authenticated(req)){
        if(url.pathname.startsWith('/api/'))json(res,401,{error:'AUTH_REQUIRED',message:'Entre no painel para continuar.'});
        else res.writeHead(303,{Location:'/admin/login'}).end();
        return;
      }
      req.benionAuthenticated=true;
      if(url.pathname.startsWith('/api/')){
        if(!url.pathname.startsWith('/api/connection')||url.pathname==='/api/connection/recovery')access.guard(req,req.method==='POST',{videoUpload:url.pathname==='/api/publishing/video'});
        if(url.search){json(res,400,{error:'INVALID_REQUEST'});return;}
        if(req.method==='POST'&&url.pathname==='/api/admin/logout'){
          const body=await readRequest(req,{json:true,maxBytes:128});
          if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)throw new Error('INVALID_REQUEST');
          json(res,200,access.logout(req,res));return;
        }
        access.refresh(req,res);
        if(req.method==='GET'&&url.pathname==='/api/csrf'){json(res,200,{nonce:access.issueNonce(req)});return;}
        if(req.method==='GET'&&url.pathname==='/api/accounts'){json(res,200,await accounts.list());return;}
        if(req.method==='POST'&&url.pathname==='/api/accounts'){
          const body=await readRequest(req,{json:true,maxBytes:12000});
          try{json(res,200,await accounts.register(body));}finally{if(body&&typeof body==='object')body.accessToken=undefined;}
          return;
        }
        // The provider credential is global; it works before any account exists.
        if(req.method==='GET'&&url.pathname==='/api/assistant/provider'){json(res,200,modelProvider?.publicStatus()??{configured:false,name:'openrouter',model:DEFAULT_MODEL,available:false});return;}
        if(req.method==='POST'&&url.pathname==='/api/assistant/provider'&&modelProvider){
          const body=await readRequest(req,{json:true,maxBytes:2048});
          try{json(res,200,await modelProvider.set(body));}finally{if(body&&typeof body==='object')body.apiKey=undefined;}
          return;
        }
        const selected=await accounts.resolve(req.headers['x-benion-account']);
        if(url.pathname==='/api/connection/recovery'){
          if(req.method!=='GET'){json(res,405,{error:'UNAVAILABLE'});return;}
          const records=selected.legacy?.recovery;
          if(!records){json(res,404,{error:'RECOVERY_NOT_AVAILABLE'});return;}
          json(res,200,records);return;
        }
        const {connection,inbox,catalog,assistantConfig,previewAssistant,campaigns,publishing}=selected;
        const {connectionHandler,transition}=controlled(selected);
        if(await connectionHandler(req,res))return;
        if(req.method==='GET'&&url.pathname==='/api/publishing'){json(res,200,publishing?await publishing.list():{available:false,groups:[],jobs:[]});return;}
        if(req.method==='POST'&&publishing&&url.pathname==='/api/publishing/groups'){json(res,200,await publishing.createGroup(await readRequest(req,{json:true,maxBytes:2048})));return;}
        if(req.method==='POST'&&publishing&&url.pathname==='/api/publishing/reels'){json(res,200,await publishing.schedule(await readRequest(req,{json:true,maxBytes:20000})));return;}
        if(req.method==='POST'&&publishing&&url.pathname==='/api/publishing/video'){json(res,200,await publishing.upload(req));return;}
        const publication=/^\/api\/publishing\/reels\/([a-f0-9-]{36})\/cancel$/.exec(url.pathname);
        if(req.method==='POST'&&publishing&&publication){const body=await readRequest(req,{json:true,maxBytes:128});if(!body||Object.keys(body).length)throw new Error('INVALID_REQUEST');json(res,200,await publishing.cancel(publication[1]));return;}
        if(req.method==='GET'&&url.pathname==='/api/inbox'){if(!inbox){json(res,200,{threads:[],available:false,reason:'INBOX_NOT_CONFIGURED'});return;}json(res,200,await inbox.list());return;}
        if(req.method==='GET'&&url.pathname==='/api/catalog'){json(res,200,catalog?await catalog.get():{products:[],available:false});return;}
        if(req.method==='GET'&&url.pathname==='/api/assistant/config'){json(res,200,assistantConfig?await assistantConfig.get():{enabled:false,faqEnabled:false,salesEnabled:false,storyEnabled:false,followerEnabled:false,available:false});return;}
        if(req.method==='POST'&&url.pathname==='/api/assistant/preview'&&previewAssistant){
          const body=await readRequest(req,{json:true,maxBytes:65536});
          const validText=(value,maximum,empty=false)=>typeof value==='string'&&(empty||value.trim())&&Buffer.byteLength(value,'utf8')<=maximum;
          if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['text','history','kind'].includes(k))||!['message','story_reply','story_mention'].includes(body.kind)||
             !validText(body.text,4000,body.kind==='story_mention')||!Array.isArray(body.history)||body.history.length>20||
             !body.history.every(m=>m&&typeof m==='object'&&!Array.isArray(m)&&Object.keys(m).every(k=>['direction','text'].includes(k))&&['inbound','outbound'].includes(m.direction)&&validText(m.text,1000)))throw new Error('INVALID_PREVIEW_CONTEXT');
          const decision=await previewAssistant.makeDecision({text:body.text,messages:body.history,kind:body.kind,inboundId:'simulation',inboundAt:new Date(clock()).toISOString(),verifiedRecipient:true,handoff:false,optout:false,mediaOnly:!body.text.trim()});
          json(res,200,{mode:'simulation',...decision});return;
        }
        if(req.method==='GET'&&url.pathname==='/api/campaigns'){json(res,200,campaigns?await campaigns.list():{campaigns:[],runningCampaignId:null,available:false});return;}
        if(req.method==='GET'&&url.pathname==='/api/campaigns/media'&&campaigns){json(res,200,await campaigns.listMedia());return;}
        if(req.method==='POST'&&url.pathname==='/api/campaigns'&&campaigns){json(res,200,await campaigns.create(await readRequest(req,{json:true,maxBytes:12000})));return;}
        const campaign=/^\/api\/campaigns\/([a-zA-Z0-9_-]{1,100})(?:\/(start|stop))?$/.exec(url.pathname);
        if(campaign&&campaigns&&req.method==='POST'){
          const body=await readRequest(req,{json:true,maxBytes:12000});
          if(campaign[2]&&(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length))throw new Error('INVALID_CAMPAIGN_ACTION');
          const result=campaign[2]?await transition(async()=>{
            if(campaign[2]==='start'){if(connection.stopAutomationAndDrain)await connection.stopAutomationAndDrain({});else connection.stopAutomation({});return campaigns.start(campaign[1]);}
            return campaigns.stop(campaign[1]);
          }):await campaigns.update(campaign[1],body);
          json(res,200,result);return;
        }
        const thread=/^\/api\/inbox\/threads\/([a-zA-Z0-9_-]{1,100})(?:\/(reply|handoff|assistant))?$/.exec(url.pathname);
        if(thread&&inbox){
          if(req.method==='GET'&&!thread[2]){json(res,200,await inbox.detail(thread[1]));return;}
          if(req.method==='POST'&&thread[2]){
            const body=await readRequest(req,{json:true,maxBytes:12000});
            const publicKeys=thread[2]==='reply'?['text','requestId']:['enabled'];
            if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==publicKeys.length||!publicKeys.every(key=>Object.hasOwn(body,key)))throw new Error('INVALID_THREAD_ACTION');
            const result=thread[2]==='reply'?await inbox.reply(thread[1],{text:body.text,requestId:body.requestId}):thread[2]==='handoff'?await inbox.setHandoff(thread[1],{enabled:body.enabled}):await inbox.setAssistant(thread[1],{enabled:body.enabled});
            json(res,200,result);return;
          }
        }
        if(req.method==='POST'&&url.pathname==='/api/catalog'&&catalog){json(res,200,await catalog.set(await readRequest(req,{json:true})));return;}
        if(req.method==='POST'&&url.pathname==='/api/assistant/config'&&assistantConfig){const body=await readRequest(req,{json:true,maxBytes:12000});await selected.assertAssistantActivation?.(body);json(res,200,await assistantConfig.set(body));setImmediate(worker);return;}
        json(res,404,{error:'UNAVAILABLE',message:'Este recurso ainda precisa de configuração.'});return;
      }
      if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'}).end();return;}
      access.refresh(req,res);
      const file=staticFiles.get(url.pathname);
      if(!file){res.writeHead(404).end('Página não encontrada.');return;}
      const body=await fs.readFile(path.join(webRoot,file));
      res.writeHead(200,{'Content-Type':types[path.extname(file)]}).end(req.method==='HEAD'?undefined:body);
    }catch(error){
      const code=typeof error.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:typeof error.message==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.message)?error.message:'REQUEST_FAILED';
      json(res,['ACCESS_DENIED','CSRF_INVALID'].includes(code)?403:code==='AUTH_REQUIRED'?401:400,{error:code,message:'Não foi possível concluir. Confira o estado do recurso antes de tentar novamente.'});
    }
  });
  server.requestTimeout=300000;server.headersTimeout=10000;
  return {server,connection:primaryRuntime?.connection??null,access,privateDirectory,worker,inbox:primaryRuntime?.inbox??null,campaigns:primaryRuntime?.campaigns??null,accounts};
}

export async function startBenion(env=process.env){
  const config=runtimeConfig(env);
  const webRoot=config.production?path.join(root,'public'):root;
  const privateDirectory=privateDirectoryFor(env,config,webRoot);
  // Fails with OWNER_CONFIG_REQUIRED before serving if root-layout state lacks owner.json.
  const owner=await loadOwnerConfig(privateDirectory);
  const modelProvider=new ModelProviderStore({dataDir:privateDirectory,env});
  await modelProvider.load();
  const app=createBenionServer({env,config,webRoot,privateDirectory,owner,modelProvider});
  await app.accounts.runtimes();
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(config.port,config.host,resolve);});
  const workerTimer=setInterval(app.worker,60000);workerTimer.unref();
  setImmediate(async()=>{for(const service of await app.accounts.runtimes()){try{await service.connection.messagingContext();}catch{}}app.worker();});
  console.log(`Benion: ${config.origin}`);
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;clearInterval(workerTimer);for(const service of await app.accounts.runtimes()){await service.publishing?.shutdown?.();try{await service.connection.stopAutomationAndDrain({});}catch{}try{if(service.campaigns?.shutdown)await service.campaigns.shutdown();else await service.campaigns?.stop();}catch{}await service.inbox?.shutdown?.();}app.server.close(()=>{process.exitCode=0;});};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await startBenion();
