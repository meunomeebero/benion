import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(process.argv[2]||path.join(os.tmpdir(),'benion-shard.zip'));
const subdomain=process.env.BENION_SHARD_SUBDOMAIN;
if(subdomain!==undefined&&!/^[a-zA-Z0-9]{1,100}$/.test(subdomain))throw new Error('INVALID_SHARD_SUBDOMAIN');
const files=['LICENSE','.shardcloud','package.json','server.mjs','runtime.mjs','connection.mjs','accounts.mjs','owner-config.mjs','automation.mjs','campaigns.mjs','publishing.mjs','conversions.mjs','content-workflow.mjs','inbox.mjs','sales.mjs','llm-provider.mjs','integrations/meta.mjs','login.css','tokens.css','fonts/nunito-500.ttf','fonts/nunito-700.ttf','fonts/nunito-800.ttf','fonts/OFL.txt','privacy-page/index.html'];
const publicFiles=['index.html','styles.css','app.mjs','simulator.mjs','ui/api.mjs'];
const stage=await fs.mkdtemp(path.join(os.tmpdir(),'benion-package-'));
try{
  const hash=createHash('sha256');
  for(const [source,target] of [...files.map(f=>[f,f]),...publicFiles.map(f=>[f,'public/'+f])]){
    const stat=await fs.lstat(path.join(root,source));
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('UNSAFE_PACKAGE_FILE');
    let bytes=await fs.readFile(path.join(root,source));
    if(source==='.shardcloud'&&subdomain)bytes=Buffer.from(`${bytes.toString('utf8').trimEnd()}\nSUBDOMAIN=${subdomain}\n`);
    if(/(?:IG(?:AA|AB)[A-Za-z0-9_-]{40,}|sk-(?:or-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,})/.test(bytes.toString('utf8')))throw new Error('POSSIBLE_SECRET_IN_PACKAGE');
    hash.update(target+'\0').update(bytes);
    await fs.mkdir(path.dirname(path.join(stage,target)),{recursive:true});
    await fs.writeFile(path.join(stage,target),bytes,{mode:0o644});
  }
  const revision=hash.digest('hex');
  await fs.writeFile(path.join(stage,'release.json'),JSON.stringify({revision}));
  await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.rm(output,{force:true});
  execFileSync('zip',['-q','-r',output,'.'],{cwd:stage,stdio:'pipe'});
  const entries=execFileSync('unzip',['-Z1',output],{encoding:'utf8'}).trim().split('\n');
  const allowed=new Set([...files,...publicFiles.map(f=>'public/'+f),'release.json']);
  if(entries.some(f=>!f.endsWith('/')&&!allowed.has(f)))throw new Error('UNEXPECTED_PACKAGE_FILE');
  console.log(JSON.stringify({output,revision,fileCount:allowed.size,bytes:(await fs.stat(output)).size}));
}finally{await fs.rm(stage,{recursive:true,force:true});}
