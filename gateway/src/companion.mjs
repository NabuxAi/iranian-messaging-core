// Local browser companion: short-lived, one-time pairing and an account-scoped relay.
// Login credentials, cookies and browser profiles never leave the user's device.
import express from 'express';
import { randomToken, randomString, sha256, safeEqual } from './crypto.mjs';

const PAIR_TTL = 10 * 60_000, ONLINE_TTL = 60_000, JOB_TTL = 50_000;
const text = (fa, en) => ({ fa, en });
const fault = code => new Error(code);
const exactChat = value => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
  !/[\s,]/.test(value) && value !== '*';

export function createCompanion({ config, store }) {
  const enabled = config.webCompanionEnabled === true;
  const pairs = new Map(), jobs = new Map(), online = new Map();
  const router = express.Router();
  const now = () => Date.now();
  const sweep = () => {
    for (const [id, p] of pairs) if (p.expires <= now()) pairs.delete(id);
    for (const key of online.keys()) if (!store.account(key)) online.delete(key);
  };
  const status = a => enabled && (online.get(a.key) || 0) > now() - ONLINE_TTL ? 'connected' : 'offline';
  const methods = messengers => enabled ? messengers.map(m => ({
    id: 'web_companion', key: m.id + '.web_companion', messenger: m.id, mode: 'web',
    label: text('حساب شخصی ' + m.fa + ' (مرورگر)', m.label + ' personal account (browser)'),
    help: text('برنامه همراه Nabux روی رایانه خودتان باز می‌شود. ورود فقط در مرورگر پیام‌رسان انجام می‌شود.',
      'Run the Nabux companion on your own computer. Sign in only in the messenger browser.'),
    risk: text('روش غیررسمی است و ممکن است پیام‌رسان حساب را محدود کند. فقط حساب خود را وصل کنید.',
      'Unofficial access may cause account restrictions. Connect only your own account.'),
    fields: [{name:'acknowledge_risk',type:'checkbox',required:true,label:text(
      'مالک این حساب هستم و دسترسی به گفتگوهای آن از سوشال را می‌پذیرم.',
      'I own this account and consent to Social accessing its chats.')}]
  })) : [];
  function pending(p) {
    if (p.done) {
      const a = store.account(p.key);
      if (!a) return {status:'error',reason:'account_removed',error:text('حساب حذف شد.','Account removed.'),retry:false};
      return {status:'done',account:{account_key:a.key,label:a.custom_label,kind:'profile',mode:'web',status:status(a)}};
    }
    const guide = 'https://github.com/NabuxAi/iranian-messaging-core/tree/main/gateway#local-browser-companion';
    return {status:'pending',session:p.id,poll_after:3,message:p.code
      ? text('کد اتصال: '+p.code+' — راهنمای برنامه همراه: '+guide,
        'Pairing code: '+p.code+' — Follow the companion instructions: '+guide)
      : text('ورود و تأیید اتصال را در برنامه همراه کامل کنید.','Complete sign-in and approve the connection in the companion.')};
  }
  function start(owner,messenger,fields) {
    sweep();
    if (!enabled) throw fault('WEB_COMPANION_DISABLED');
    if (fields.acknowledge_risk !== true) throw fault('EXPLICIT_CONFIRMATION_REQUIRED');
    if (store.accountsOf(owner.id).length >= config.maxAccountsPerOwner) throw fault('TOO_MANY_ACCOUNTS');
    if ([...pairs.values()].filter(p=>p.owner===owner.id&&!p.done).length>=3 || pairs.size>=200) throw fault('TOO_MANY_PAIRINGS');
    const code=randomToken(24);
    const p={id:randomToken(24),key:'irm_'+messenger+'_'+randomString(32),owner:owner.id,messenger,
      code,codeHash:sha256(code),expires:now()+PAIR_TTL};
    pairs.set(p.id,p);
    return pending(p);
  }
  function session(id,sub) {
    sweep();
    const p=pairs.get(id);
    return p && store.ownerBySub(sub)?.id===p.owner ? p : null;
  }
  function cancel(p) { if(!p.done) pairs.delete(p.id); }
  function revoke(a) {
    jobs.get(a.key)?.finish(fault('WEB_ACCOUNT_REVOKED'));
    online.delete(a.key);
    for(const [id,p] of pairs) if(p.key===a.key) pairs.delete(id);
  }
  router.use((req,res,next)=>{
    res.set('Cache-Control','no-store');
    if(!enabled) return res.status(404).json({detail:'not_found'});
    if(!req.is('application/json')) return res.status(415).json({detail:'json_required'});
    next();
  },express.json({limit:'1mb'}));
  router.post('/pair',(req,res)=>{
    sweep();
    const code=req.body?.code;
    if(typeof code!=='string'||!/^[A-Za-z0-9_-]{32}$/.test(code)) return res.status(404).json({detail:'pairing_not_found'});
    const hash=sha256(code);
    const p=[...pairs.values()].find(x=>x.code&&safeEqual(x.codeHash,hash));
    if(!p) return res.status(404).json({detail:'pairing_not_found'});
    const token=randomToken(32);
    p.code=null;p.codeHash=null;p.tokenHash=sha256(token);
    res.json({token,account_key:p.key,messenger:p.messenger});
  });
  router.use((req,res,next)=>{
    sweep();
    const token=String(req.get('Authorization')||'').match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if(!token) return res.status(401).json({detail:'unauthorized'});
    const hash=sha256(token);
    const p=[...pairs.values()].find(x=>x.tokenHash&&!x.done&&safeEqual(x.tokenHash,hash));
    const a=store.data.accounts.find(x=>x.mode==='web'&&x.companion_hash&&safeEqual(x.companion_hash,hash));
    if(!p&&!a) return res.status(401).json({detail:'unauthorized'});
    req.companion={p,a,key:a?.key||p.key};
    next();
  });
  router.post('/heartbeat',(req,res)=>{
    const {p,a,key}=req.companion;
    const ready=req.body?.signed_in===true;
    if(!a&&p&&ready){
      if(req.body?.approved!==true) return res.status(400).json({detail:'approval_required'});
      if(store.accountsOf(p.owner).length>=config.maxAccountsPerOwner) return res.status(409).json({detail:'account_limit'});
      const label=String(req.body?.label||'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,80)||p.messenger+' Web';
      store.insertAccount({key,owner_id:p.owner,messenger:p.messenger,kind:'profile',mode:'web',
        companion_hash:p.tokenHash,custom_label:label,status:'offline',verified:false,
        default_chat:'',default_chat_title:null,allowed_chats:[],send_enabled:false,
        created_at:Math.floor(now()/1000),updated_at:Math.floor(now()/1000)});
      p.done=true;p.tokenHash=null;
    }
    if(ready&&store.account(key)) online.set(key,now()); else online.delete(key);
    res.json({ok:true});
  });
  router.post('/next',(req,res)=>{
    const {a,key}=req.companion;
    const j=jobs.get(key);
    if(!a||status(a)!=='connected'||!j||j.delivered||j.expires<=now()) return res.json({job:null});
    j.delivered=true;
    res.json({job:{id:j.id,op:j.op,args:j.args,expires:j.expires}});
  });
  function writeAllowed(a,args){
    return a.send_enabled===true&&args.confirm===true&&exactChat(args.chatId)&&a.allowed_chats.includes(args.chatId);
  }
  router.post('/authorize',(req,res)=>{
    const {a,key}=req.companion,j=jobs.get(key);
    if(!a||!j||j.id!==req.body?.id||!j.delivered||j.authorized||j.expires<=now()||
      j.op!=='sendMessage'||!writeAllowed(a,j.args)) return res.status(409).json({detail:'job_not_authorized'});
    const times=(a.web_send_attempts||[]).filter(x=>x>now()-3600_000);
    if(times.length>=12||(times.length&&now()-times.at(-1)<20_000)) return res.status(429).json({detail:'WEB_SEND_RATE_LIMIT'});
    store.updateAccount(a.key,{web_send_attempts:[...times,now()]});
    j.authorized=true;
    res.json({ok:true});
  });
  router.post('/result',(req,res)=>{
    const {key}=req.companion,j=jobs.get(key);
    if(!j||j.id!==req.body?.id||!j.delivered||j.expires<=now()) return res.status(409).json({detail:'job_expired'});
    if(req.body.ok===true&&(j.op!=='sendMessage'||j.authorized)) j.finish(null,req.body.result??{});
    else j.finish(fault('WEB_OPERATION_FAILED_OR_DECLINED'));
    res.json({ok:true});
  });
  async function run(a,op,args){
    if(!enabled||status(a)!=='connected') throw fault('WEB_COMPANION_OFFLINE');
    if(jobs.has(a.key)) throw fault('WEB_COMPANION_BUSY');
    if(op==='sendMessage'){
      if(!writeAllowed(a,args)) throw fault('EXPLICIT_CONFIRMATION_OR_CHAT_ALLOWLIST_REQUIRED');
      if(typeof args.text!=='string'||!args.text.trim()||args.text.length>4000) throw fault('INVALID_MESSAGE');
    }
    return new Promise((resolve,reject)=>{
      const j={id:randomToken(24),op,args,expires:now()+JOB_TTL,delivered:false,authorized:false};
      j.finish=(err,data)=>{clearTimeout(timer);jobs.delete(a.key);err?reject(err):resolve(data)};
      const timer=setTimeout(()=>j.finish(fault('WEB_OPERATION_TIMEOUT_CHECK_BEFORE_RETRY')),JOB_TTL);
      jobs.set(a.key,j);
    });
  }
  function ops(a){
    const limit=n=>Math.min(50,Math.max(1,Number(n)||20));
    return {
      preview:({chatId,text})=>({approvedRecipient:exactChat(chatId)&&a.allowed_chats.includes(chatId),sendEnabled:a.send_enabled===true,willSend:false,text}),
      listChats:({limit:n=30,query=''}={})=>run(a,'listChats',{limit:limit(n),query:String(query).slice(0,100)}),
      readChat:({chatId,limit:n=20})=>{if(!exactChat(chatId))throw fault('INVALID_CHAT_ID');return run(a,'readChat',{chatId,limit:limit(n)})},
      sendMessage:({chatId,text,confirm})=>run(a,'sendMessage',{chatId,text,confirm}),
      sendFile:()=>{throw fault('WEB_FILE_NOT_SUPPORTED')}
    };
  }
  return {enabled,router,methods,start,pending,session,cancel,revoke,status,ops};
}
