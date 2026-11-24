import test from 'node:test';
import assert from 'node:assert/strict';
import {internal,startGateway} from './helpers.mjs';
const owner={sub:'owner-web',email:'web@example.com',email_verified:true};
const other={sub:'other'};
const start=(gw,fields={acknowledge_risk:true},who=owner,method='rubika.web_companion')=>internal(gw,'/internal/v1/connect/start',{method:'POST',body:{owner:who,method,fields}});
const poll=(gw,s,who=owner)=>internal(gw,'/internal/v1/connect/'+s+'?sub='+who.sub);
const relay=async(gw,route,body,token)=>{
  const r=await fetch(gw.base+'/companion/v1/'+route,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  return {status:r.status,json:await r.json()};
};
async function pair(gw,method){
  const s=await start(gw,undefined,owner,method);
  assert.equal(s.json.status,'pending');
  const code=s.json.message.en.match(/Pairing code: ([A-Za-z0-9_-]{32})/)[1];
  const p=await relay(gw,'pair',{code});
  assert.equal(p.status,200);
  assert.equal((await relay(gw,'pair',{code})).status,404);
  return {session:s.json.session,code,...p.json};
}
async function take(gw,token){
  for(let i=0;i<60;i++){
    const r=await relay(gw,'next',{},token);
    if(r.json.job)return r.json.job;
    await new Promise(r=>setTimeout(r,10));
  }
  throw new Error('No relay job');
}
const settings=(gw,key,fields,who=owner)=>internal(gw,'/internal/v1/accounts/'+key+'/settings',{method:'POST',body:{owner:who,...fields}});
const send=(gw,key,fields,who=owner)=>internal(gw,'/internal/v1/accounts/'+key+'/send',{method:'POST',body:{owner:who,kind:'text',chat_id:'chat-42',text:'Test message',...fields}});
test('browser companion is opt-in, with five distinct methods',async()=>{
  const off=await startGateway();
  try{assert.equal((await internal(off,'/internal/v1/connect/methods')).json.methods.length,5);assert.equal((await relay(off,'pair',{code:'x'.repeat(32)})).status,404)}finally{await off.close()}
  const gw=await startGateway({env:{IRAN_WEB_COMPANION_ENABLED:'1'}});
  try{
    const methods=(await internal(gw,'/internal/v1/connect/methods')).json.methods;
    assert.equal(methods.length,10);
    assert.deepEqual(methods.filter(m=>m.mode==='web').map(m=>m.key),['bale','eitaa','rubika','soroushplus','gap'].map(x=>x+'.web_companion'));
    assert.equal((await start(gw,{})).json.status,'error');
  }finally{await gw.close()}
});
test('pairing is single-use, owner scoped, and completes only after local approval',async()=>{
  const gw=await startGateway({env:{IRAN_WEB_COMPANION_ENABLED:'1'}});
  try{
    const p=await pair(gw);
    assert.equal((await poll(gw,p.session,other)).status,404);
    assert.equal((await relay(gw,'heartbeat',{signed_in:true},p.token)).status,400);
    assert.equal((await poll(gw,p.session)).json.status,'pending');
    assert.equal((await relay(gw,'heartbeat',{signed_in:true,approved:true,label:'My account'},p.token)).status,200);
    assert.equal((await poll(gw,p.session)).json.account.mode,'web');
    const a=gw.store.account(p.account_key);
    assert.equal(a.send_enabled,false);assert.deepEqual(a.allowed_chats,[]);
    assert.ok(!JSON.stringify(gw.store.data).includes(p.token));
    assert.ok(!gw.lines.join('\n').includes(p.code));
    const discovery=()=>internal(gw,'/internal/v1/owners/accounts?sub='+owner.sub);
    assert.equal((await discovery()).json.accounts[0].publish_ready,false);
    assert.equal((await discovery()).json.accounts[0].status,'connected');
    await relay(gw,'heartbeat',{signed_in:false},p.token);
    assert.equal((await discovery()).json.accounts[0].status,'offline');
    await relay(gw,'heartbeat',{signed_in:true},p.token);
    assert.equal((await discovery()).json.accounts[0].status,'connected');
  }finally{await gw.close()}
});
test('chat relay, send locks, one-time local authorization and revocation',async()=>{
  const gw=await startGateway({env:{IRAN_WEB_COMPANION_ENABLED:'1'}});
  try{
    const p=await pair(gw,'bale.web_companion'),key=p.account_key,token=p.token;
    await relay(gw,'heartbeat',{signed_in:true,approved:true},token);
    assert.equal((await settings(gw,key,{allowed_chats:['chat-42']},other)).status,404);
    assert.equal((await send(gw,key,{confirm:true})).status,400);
    assert.equal((await settings(gw,key,{allowed_chats:['*']})).status,400);
    assert.equal((await settings(gw,key,{allowed_chats:['chat-42'],send_enabled:true})).status,200);
    assert.equal((await send(gw,key,{confirm:false})).status,400);
    assert.equal((await send(gw,key,{confirm:true,chat_id:'other'})).status,400);
    assert.equal((await internal(gw,'/internal/v1/accounts/'+key+'/publish',{method:'POST',body:{text:'no'}})).status,400);
    const reading=internal(gw,'/internal/v1/accounts/'+key+'/updates?sub='+owner.sub);
    const j=await take(gw,token);assert.equal(j.op,'listChats');
    assert.equal((await relay(gw,'next',{},token)).json.job,null);
    await relay(gw,'result',{id:j.id,ok:true,result:{chats:[{chatId:'chat-42',title:'Sample'}]}},token);
    assert.equal((await reading).json.chats[0].chat_id,'chat-42');
    const writing=send(gw,key,{confirm:true}),job=await take(gw,token);
    assert.equal(job.op,'sendMessage');
    assert.deepEqual(job.args,{chatId:'chat-42',text:'Test message',confirm:true});
    assert.equal((await relay(gw,'authorize',{id:job.id},'x'.repeat(43))).status,401);
    assert.equal((await relay(gw,'authorize',{id:job.id},token)).status,200);
    assert.equal((await relay(gw,'authorize',{id:job.id},token)).status,409);
    await relay(gw,'result',{id:job.id,ok:true,result:{messageId:'sent-id'}},token);
    assert.equal((await writing).json.message_id,'sent-id');
    const rate=send(gw,key,{confirm:true}),next=await take(gw,token);
    assert.equal((await relay(gw,'authorize',{id:next.id},token)).status,429);
    await relay(gw,'result',{id:next.id,ok:false},token);
    assert.equal((await rate).status,400);
    assert.equal((await internal(gw,'/internal/v1/accounts/'+key+'/remove',{method:'POST',body:{owner}})).status,200);
    assert.equal((await relay(gw,'heartbeat',{signed_in:true},token)).status,401);
    assert.ok(!gw.lines.join('\n').includes('Test message'));
  }finally{await gw.close()}
});
test('cancellation invalidates pending companion credentials',async()=>{
  const gw=await startGateway({env:{IRAN_WEB_COMPANION_ENABLED:'1'}});
  try{
    const p=await pair(gw,'gap.web_companion');
    assert.equal((await internal(gw,'/internal/v1/connect/'+p.session+'/cancel',{method:'POST',body:{owner:other}})).status,404);
    assert.equal((await internal(gw,'/internal/v1/connect/'+p.session+'/cancel',{method:'POST',body:{owner}})).status,200);
    assert.equal((await relay(gw,'heartbeat',{signed_in:true,approved:true},p.token)).status,401);
  }finally{await gw.close()}
});
