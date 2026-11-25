#!/usr/bin/env node
// Run on the account owner's device, never on the gateway.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWebOps } from '@nabuxai/iranian-messaging-core';

const base='https://ir.nabuxai.com/companion/v1';
const root=path.join(os.homedir(),'.nabuxai','iranian-social');
const rl=createInterface({input:stdin,output:stdout});
const ids=['bale','eitaa','rubika','soroushplus','gap'];
const validKey=k=>typeof k==='string'&&/^irm_(bale|eitaa|rubika|soroushplus|gap)_[a-z0-9]{32}$/.test(k);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let creds,ops,stopping=false;
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{stopping=true;rl.close()});
const folder=k=>{if(!validKey(k))throw new Error('Invalid account key');return path.join(root,k)};
async function api(route,data={},token=creds?.token){
  const res=await fetch(base+route,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10_000),
    headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
  if(!res.ok)throw Object.assign(new Error('Gateway HTTP '+res.status),{status:res.status});
  return res.json();
}
function validate(c){
  if(!validKey(c?.account_key)||!ids.includes(c.messenger)||!c.account_key.startsWith('irm_'+c.messenger+'_')||
    !/^[A-Za-z0-9_-]{43}$/.test(c.token))throw new Error('Invalid companion credentials');
}
async function main(){
  if(!stdin.isTTY)throw new Error('Run in an interactive terminal on your own device.');
  if(process.argv[2]==='resume'){
    creds=JSON.parse(await readFile(path.join(folder(process.argv[3]),'connection.json'),'utf8'));
    validate(creds);
  }else{
    console.log('Nabux browser companion. Only connect your own account. Your sign-in remains local; requested chat data travels through the gateway.');
    const code=(await rl.question('Pairing code shown in Social MCP: ')).trim();
    creds=await api('/pair',{code},null);validate(creds);
    await mkdir(folder(creds.account_key),{recursive:true,mode:0o700});
    await writeFile(path.join(folder(creds.account_key),'connection.json'),JSON.stringify(creds),{mode:0o600,flag:'wx'});
  }
  process.env.NABU_BROWSER_ENABLE='1';
  process.env.NABU_BROWSER_HEADLESS='0';
  process.env.NABU_BROWSER_PROFILE_DIR=path.join(folder(creds.account_key),'browser');
  process.env.NABU_MESSAGING_ENABLE_SEND='0';
  process.env.NABU_WEB_ALLOW_ACCOUNT_CHANGES='0';
  const {webDriver}=await import('@nabuxai/'+creds.messenger+'-mcp');
  if(webDriver.id!==creds.messenger)throw new Error('Unexpected web driver');
  ops=createWebOps(webDriver);
  await ops.open();
  console.log('Sign in directly in Chrome. Never type your password or OTP in this terminal.');
  await rl.question('After signing in, press Enter. ');
  if((await ops.status()).signedIn!==true)throw new Error('Messenger does not report a signed-in account.');
  console.log('This permits Social and your authorized MCP clients to list and read chats. Sending is off by default and needs separate approval here for each message.');
  if((await rl.question('Type YES to allow access: ')).trim()!=='YES')return;
  await api('/heartbeat',{signed_in:true,approved:true,label:creds.messenger+' Web'});
  console.log('Connected. Keep Chrome and this terminal open. Resume with: npm run companion -- resume '+creds.account_key);
  while(!stopping){
    try{
      const ready=(await ops.status()).signedIn===true;
      await api('/heartbeat',{signed_in:ready});
      if(!ready){console.log('Sign in again in Chrome.');await sleep(5000);continue}
      const {job}=await api('/next');
      if(job&&Date.now()<job.expires){
        let result,ok=false;
        try{
          if(job.op==='listChats'||job.op==='readChat'){result=await ops[job.op](job.args);ok=true}
          else if(job.op==='sendMessage'){
            const {chatId,text,confirm}=job.args||{};
            if(confirm!==true||typeof chatId!=='string'||!chatId||chatId==='*'||chatId.length>128||/[\s,]/.test(chatId)||
              typeof text!=='string'||!text.trim()||text.length>4000)throw new Error('Invalid send');
            console.log('Recipient: '+JSON.stringify(chatId));
            console.log('Exact message: '+JSON.stringify(text));
            const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),Math.max(1,job.expires-Date.now()-2000));
            let answer;
            try{answer=await rl.question('Type SEND to approve this message: ',{signal:ac.signal})}finally{clearTimeout(timer)}
            if(answer==='SEND'&&!stopping&&Date.now()<job.expires-1000){
              await api('/authorize',{id:job.id});
              if(Date.now()>=job.expires)throw new Error('Expired send');
              const k=creds.messenger.toUpperCase()+'_WEB_ALLOWED_CHATS';
              process.env[k]=chatId;process.env.NABU_MESSAGING_ENABLE_SEND='1';
              try{result=await ops.sendMessage({chatId,text,confirm:true});ok=result?.ok===true}
              finally{process.env.NABU_MESSAGING_ENABLE_SEND='0';delete process.env[k]}
            }
          }
        }catch{ok=false}
        await api('/result',{id:job.id,ok,result:ok?result:undefined});
      }
    }catch(err){
      if(err.status===401||err.status===404){console.log('Connection revoked or expired. Pair again if desired.');break}
      if(!stopping)console.log('Connection unavailable. No message will be replayed automatically.');
      await sleep(3000);
    }
    await sleep(1500);
  }
}
try{await main()}catch(err){console.error('Companion stopped. '+(err.status?'HTTP '+err.status:'Check the pairing, browser and network.'));process.exitCode=1}
finally{if(creds?.token)await api('/heartbeat',{signed_in:false}).catch(()=>{});await ops?.close().catch(()=>{});rl.close()}
