import { createHash, createHmac, randomBytes, timingSafeEqual, scryptSync } from 'node:crypto';
import { constants, lstatSync, mkdirSync, realpathSync, openSync, fstatSync, readFileSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const LEGACY_SESSION_TTL = 12 * 60 * 60 * 1000;
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1', '::1']);
const equal = (a,b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const within=(candidate,root)=>{const relative=path.relative(root,candidate);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative));};
const digest=value=>createHash('sha256').update(value).digest('hex');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const emptySessions=()=>({version:1,sessions:{},revokedLegacy:{}});

export function runtimeConfig(env = process.env) {
  const production = env.BENION_MODE === 'production';
  const port = Number(production ? (env.PORT || 80) : (env.BENION_PORT || 5197));
  const origin = production ? env.BENION_PUBLIC_ORIGIN : `http://127.0.0.1:${port}`;
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('BENION_ORIGIN_REQUIRED'); }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || parsed.origin !== origin || parsed.username || parsed.password ||
    (production && (parsed.protocol !== 'https:' || !env.BENION_ADMIN_PASSWORD || env.BENION_ADMIN_PASSWORD.length < 20 || !env.BENION_SESSION_SECRET || env.BENION_SESSION_SECRET.length < 32 || env.BENION_ADMIN_PASSWORD===env.BENION_SESSION_SECRET))) throw new Error('BENION_RUNTIME_INVALID');
  return { production, port, origin, host:production?'0.0.0.0':'127.0.0.1', password:production?env.BENION_ADMIN_PASSWORD:null, sessionSecret:production?env.BENION_SESSION_SECRET:null };
}

export class AdminAccess {
  #config; #clock; #passwordHash; #passwordFingerprint; #sessionKey; #directory; #servedRoot; #attempts=[]; #nonces=new Map();
  constructor(config,{clock=Date.now,privateDirectory,servedRoot}={}) {
    this.#config=config;this.#clock=clock;
    if(config.production){
      if(typeof privateDirectory!=='string'||typeof servedRoot!=='string'||!path.isAbsolute(privateDirectory)||!path.isAbsolute(servedRoot)||within(privateDirectory,servedRoot))throw new Error('SESSION_STORE_UNSAFE');
      this.#directory=path.resolve(privateDirectory);this.#servedRoot=path.resolve(servedRoot);
      this.#sessionKey=config.sessionSecret;
      this.#passwordHash=scryptSync(config.password,config.sessionSecret,32);
      this.#passwordFingerprint=createHmac('sha256',config.sessionSecret).update(config.password).digest();
    }
  }
  #mac(value){return createHmac('sha256',this.#sessionKey).update(value).digest('hex');}
  #cookie(req){
    const rows=String(req.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('benion_admin='));
    return rows.length===1?rows[0].slice(13):null;
  }
  #privateDirectory(create=false){
    try{
      if(create)mkdirSync(this.#directory,{recursive:true,mode:0o700});
      const stat=lstatSync(this.#directory);
      if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||(process.getuid&&stat.uid!==process.getuid())||within(realpathSync(this.#directory),realpathSync(this.#servedRoot)))throw new Error();
      return this.#directory;
    }catch(error){if(!create&&error.code==='ENOENT')return null;throw new Error('SESSION_STORE_UNSAFE');}
  }
  #readSessions(){
    if(!this.#privateDirectory())return emptySessions();
    let fd;
    try{
      fd=openSync(path.join(this.#directory,'admin-sessions.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
      const stat=fstatSync(fd);
      if(!stat.isFile()||(stat.mode&0o777)!==0o600||(process.getuid&&stat.uid!==process.getuid())||stat.size>1024*1024)throw new Error();
      const state=JSON.parse(readFileSync(fd,'utf8'));
      if(!object(state)||Object.keys(state).sort().join(',')!=='revokedLegacy,sessions,version'||state.version!==1||!object(state.sessions)||!object(state.revokedLegacy)||Object.keys(state.sessions).length>4096||
        !Object.entries(state.sessions).every(([key,value])=>/^[a-f0-9]{64}$/.test(key)&&object(value)&&Object.keys(value).every(k=>['createdAt','legacyExpiresAt'].includes(k))&&Number.isSafeInteger(value.createdAt)&&value.createdAt>=0&&(value.legacyExpiresAt===undefined||(Number.isSafeInteger(value.legacyExpiresAt)&&value.legacyExpiresAt>=0)))||
        !Object.entries(state.revokedLegacy).every(([key,value])=>/^[a-f0-9]{64}$/.test(key)&&Number.isSafeInteger(value)&&value>=0))throw new Error();
      return state;
    }catch(error){if(error.code==='ENOENT')return emptySessions();throw new Error('SESSION_STORE_UNSAFE');}
    finally{if(fd!==undefined)closeSync(fd);}
  }
  #writeSessions(state){
    let temporary,fd;
    try{
      this.#privateDirectory(true);
      const destination=path.join(this.#directory,'admin-sessions.json');
      try{const stat=lstatSync(destination);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600||(process.getuid&&stat.uid!==process.getuid()))throw new Error();}catch(error){if(error.code!=='ENOENT')throw error;}
      for(const [key,expiresAt]of Object.entries(state.revokedLegacy))if(expiresAt<=this.#clock())delete state.revokedLegacy[key];
      const encoded=JSON.stringify(state);if(Object.keys(state.sessions).length>4096||Buffer.byteLength(encoded)>1024*1024)throw new Error();
      temporary=path.join(this.#directory,'.admin-sessions-'+randomBytes(16).toString('hex')+'.tmp');
      fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      writeFileSync(fd,encoded);fsyncSync(fd);closeSync(fd);fd=undefined;
      renameSync(temporary,destination);temporary=undefined;
      fd=openSync(this.#directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);fsyncSync(fd);closeSync(fd);fd=undefined;
    }catch{throw new Error('SESSION_STORE_UNSAFE');}
    finally{if(fd!==undefined)closeSync(fd);if(temporary)try{unlinkSync(temporary);}catch{}}
  }
  #session(req){
    if(req.headers.host!==new URL(this.#config.origin).host)return null;
    const cookie=this.#cookie(req);const current=/^v2\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(cookie||'');
    const legacy=/^([a-f0-9]{64})\.(\d{13})\.([a-f0-9]{64})$/.exec(cookie||'');
    if((!current&&!legacy)||(current&&!equal(current[2],this.#mac('v2.'+current[1])))||(legacy&&!equal(legacy[3],this.#mac(legacy[1]+'.'+legacy[2]))))return null;
    const id=digest(cookie);const state=this.#readSessions();const entry=state.sessions[id];
    if(entry)return {id,cookie,state,entry};
    const legacyExpiresAt=legacy?Number(legacy[2]):null;
    if(!legacy||legacyExpiresAt<=this.#clock()||legacyExpiresAt>this.#clock()+LEGACY_SESSION_TTL||state.revokedLegacy[id]>this.#clock())return null;
    return {id,cookie,state,entry:null,legacyExpiresAt};
  }
  authenticated(req){
    if(!this.#config.production) return LOOPBACK.has(req.socket.remoteAddress)&&req.headers.host===new URL(this.#config.origin).host;
    try{return Boolean(this.#session(req));}catch{return false;}
  }
  #sessionCookie(value,maxAge=COOKIE_MAX_AGE){return `benion_admin=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;}
  refresh(req,res){
    if(!this.#config.production)return;
    const session=this.#session(req);if(!session)throw new Error('AUTH_REQUIRED');
    if(!session.entry){session.state.sessions[session.id]={createdAt:this.#clock(),legacyExpiresAt:session.legacyExpiresAt};this.#writeSessions(session.state);}
    // Browsers cap persistent cookies at 400 days. Active use renews that cap;
    // the private registry keeps the session valid until explicit logout.
    res.setHeader('Set-Cookie',this.#sessionCookie(session.cookie));
  }
  async login(req,res){
    if(!this.#config.production){res.writeHead(303,{Location:'/'}).end();return;}
    if(req.method!=='POST'||req.headers.host!==new URL(this.#config.origin).host||req.headers.origin!==this.#config.origin||!/^application\/x-www-form-urlencoded(?:;.*)?$/i.test(req.headers['content-type']||'')){res.writeHead(403).end('Acesso recusado.');return;}
    this.#attempts=this.#attempts.filter(t=>this.#clock()-t<15*60*1000);
    let text;
    try{text=await readRequest(req,{maxBytes:2048});}catch{res.writeHead(400).end('Formulário inválido.');return;}
    const data=new URLSearchParams(text);
    const candidate=data.getAll('password');
    const matchingCandidate=candidate.length===1&&candidate[0].length<=256&&timingSafeEqual(createHmac('sha256',this.#sessionKey).update(candidate[0]).digest(),this.#passwordFingerprint);
    // A stranger exhausting the failed-attempt budget must not lock out the owner.
    // The cheap keyed comparison avoids running scrypt on throttled bad guesses.
    if(this.#attempts.length>=10&&!matchingCandidate){res.writeHead(429,{'Retry-After':'900'}).end('Tente novamente mais tarde.');return;}
    this.#attempts.push(this.#clock());
    const valid=candidate.length===1&&candidate[0].length<=256&&timingSafeEqual(scryptSync(candidate[0],this.#sessionKey,32),this.#passwordHash);
    if(!valid){res.writeHead(303,{Location:'/admin/login?error=1'}).end();return;}
    this.#attempts=[];
    const value='v2.'+randomBytes(32).toString('hex');const cookie=value+'.'+this.#mac(value);const state=this.#readSessions();
    if(Object.keys(state.sessions).length>=4096)throw new Error('SESSION_STORE_FULL');
    state.sessions[digest(cookie)]={createdAt:this.#clock()};this.#writeSessions(state);
    res.writeHead(303,{Location:'/', 'Set-Cookie':this.#sessionCookie(cookie),'Cache-Control':'no-store'}).end();
  }
  logout(req,res){
    if(this.#config.production){
      const session=this.#session(req);if(!session)throw new Error('AUTH_REQUIRED');
      const expiresAt=session.entry?.legacyExpiresAt??session.legacyExpiresAt;
      delete session.state.sessions[session.id];if(expiresAt>this.#clock())session.state.revokedLegacy[session.id]=expiresAt;
      this.#writeSessions(session.state);
      for(const [nonce,value]of this.#nonces)if(value.session===session.id)this.#nonces.delete(nonce);
      res.setHeader('Set-Cookie',this.#sessionCookie('',0));
    }
    return {loggedOut:true};
  }
  issueNonce(req){
    for(const [key,value]of this.#nonces)if(value.expiresAt<=this.#clock())this.#nonces.delete(key);
    const session=this.#config.production?digest(this.#cookie(req)||''):'loopback';
    if(!this.authenticated(req))throw new Error('AUTH_REQUIRED');
    while(this.#nonces.size>=128)this.#nonces.delete(this.#nonces.keys().next().value);
    const nonce=randomBytes(32).toString('hex');
    this.#nonces.set(nonce,{session,expiresAt:this.#clock()+300000});
    return nonce;
  }
  guard(req,mutation=false,{videoUpload=false}={}){
    if(!this.authenticated(req))throw new Error('AUTH_REQUIRED');
    if(req.headers.host!==new URL(this.#config.origin).host||req.headers['x-benion-request']!=='1'||(req.headers.origin!==undefined&&req.headers.origin!==this.#config.origin)||(req.headers['sec-fetch-site']!==undefined&&req.headers['sec-fetch-site']!=='same-origin'))throw new Error('ACCESS_DENIED');
    if(mutation){
      const validType=videoUpload?req.headers['content-type']==='video/mp4':/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'');
      if(req.headers.origin!==this.#config.origin||!validType)throw new Error('ACCESS_DENIED');
      const nonce=req.headers['x-benion-csrf'];const entry=this.#nonces.get(nonce);
      const session=this.#config.production?digest(this.#cookie(req)||''):'loopback';
      if(!entry||entry.expiresAt<=this.#clock()||!equal(entry.session,session))throw new Error('CSRF_INVALID');
      this.#nonces.delete(nonce);
    } else if(req.headers.origin===undefined&&req.headers['sec-fetch-site']!=='same-origin')throw new Error('ACCESS_DENIED');
  }
}

export async function readRequest(req,{maxBytes=65536,timeoutMs=10000,json=false,raw=false}={}){
  return new Promise((resolve,reject)=>{
    let size=0,done=false;const chunks=[];
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(new Error(error)):resolve(value);};
    const timer=setTimeout(()=>{req.resume();finish('BODY_TIMEOUT');},timeoutMs);timer.unref?.();
    const length=Number(req.headers['content-length']);
    if(Number.isFinite(length)&&length>maxBytes){req.resume();finish('BODY_TOO_LARGE');return;}
    req.on('data',chunk=>{size+=chunk.length;if(size>maxBytes){chunks.length=0;finish('BODY_TOO_LARGE');}else if(!done)chunks.push(chunk);});
    req.on('end',()=>{if(done)return;try{const bytes=Buffer.concat(chunks);const text=raw?bytes:bytes.toString('utf8');finish(null,json?JSON.parse(text):text);}catch{finish('INVALID_BODY');}});
    req.on('error',()=>finish('INVALID_BODY'));req.on('aborted',()=>finish('INVALID_BODY'));
  });
}

export function loginPage(error=false){return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar · Benion</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect x='4' y='4' width='56' height='56' rx='18' fill='%23285DE5'/%3E%3Cpath d='M23 18v29h13c7 0 11-5 11-11s-4-11-11-11H23m0 11h12' fill='none' stroke='white' stroke-width='5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"><link rel="stylesheet" href="/login.css"></head><body><main><p class="brand"><span class="brand-mark" aria-hidden="true">b</span><span>benion<span class="brand-period">.</span></span></p><h1>Sua operação, em um lugar.</h1><p class="lead">Entre para acompanhar as conversas e automações do Instagram.</p><form method="post" action="/admin/login"><label for="password">Senha do painel</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256"${error?' aria-invalid="true" aria-describedby="password-error"':''}>${error?'<p id="password-error" class="field-error" role="alert">Confira a senha e tente novamente.</p>':''}<button class="button primary" type="submit">Entrar no Benion</button></form><footer><a href="/privacy">Privacidade</a></footer></main></body></html>`;}
