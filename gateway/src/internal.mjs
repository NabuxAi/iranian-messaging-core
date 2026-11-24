// The internal API for Nabux Social (server to server). Every route needs
// Authorization: Bearer <INTERNAL_SERVICE_TOKEN>, compared in constant time;
// 404 while the token is unset, 401 when it does not match.
//
//   GET  /internal/v1/owners/accounts?sub=&email=      owner discovery (auto-link)
//   GET  /internal/v1/accounts/{account_key}           one account
//   POST /internal/v1/accounts/{account_key}/publish   {kind, text, media_url, title, link}
//   POST /internal/v1/accounts/{account_key}/publish/text   {text}
//   POST /internal/v1/accounts/{account_key}/publish/image  {image_url, caption|text}
//   GET  /internal/v1/connect/methods[?messenger=]     how an account can be added
//   POST /internal/v1/connect/start                    add one (bot_token: done at once)
//   GET|POST /internal/v1/connect/{session}[/cancel]   multi-step sessions (none in bot mode)
//
// Publishing goes to the account's default chat and keeps the account's
// locks: the chat must be on its allowed chats and sending must be on.
import express from 'express';
import { AccountError } from './accounts.mjs';
import { safeEqual } from './crypto.mjs';
import { log } from './log.mjs';

const MAX_SUB = 255;
const MAX_EMAIL = 320;
const PUBLISH_KINDS = ['text', 'image', 'video'];

const normSub = v => { const s = String(v ?? '').trim(); return s && s.length <= MAX_SUB ? s : ''; };
const normEmail = v => {
  const e = String(v ?? '').trim().toLowerCase();
  if (!e || e.length > MAX_EMAIL || e.split('@').length !== 2) return '';
  const [local, domain] = e.split('@');
  return local && domain ? e : '';
};

export function errorBody(err) {
  if (err instanceof AccountError) return [err.status, { detail: err.message }];
  const msg = String(err?.message || 'ERROR');
  if (msg.startsWith('PROVIDER_')) return [502, { detail: msg, ...(err.detail ? { provider_detail: String(err.detail).slice(0, 300) } : {}) }];
  return [400, { detail: msg }];
}

const ERRORS_FA = {
  BOT_TOKEN_REJECTED: 'پیام‌رسان این توکن را نپذیرفت. توکن را دوباره از بات‌ساز بگیرید.',
  INVALID_BOT_TOKEN: 'این توکن معتبر به نظر نمی‌رسد.',
  INVALID_CHAT_ID: 'شناسهٔ گفت‌وگو معتبر نیست.',
  MESSENGER_UNREACHABLE: 'پیام‌رسان در دسترس نبود. کمی بعد دوباره امتحان کنید.',
  TOO_MANY_ACCOUNTS: 'به سقف تعداد حساب‌ها رسیده‌اید.',
  UNKNOWN_MESSENGER: 'این پیام‌رسان پشتیبانی نمی‌شود.'
};
const ERRORS_EN = {
  BOT_TOKEN_REJECTED: 'The messenger rejected this token. Take it again from the bot maker.',
  INVALID_BOT_TOKEN: 'This does not look like a bot token.',
  INVALID_CHAT_ID: 'The chat id is not valid.',
  MESSENGER_UNREACHABLE: 'The messenger could not be reached. Try again in a moment.',
  TOO_MANY_ACCOUNTS: 'You have reached the limit of accounts.',
  UNKNOWN_MESSENGER: 'This messenger is not supported.'
};
export const errorText = code => ({ fa: ERRORS_FA[code] || `خطا: ${code}`, en: ERRORS_EN[code] || `Error: ${code}` });

export function connectMethods(messengers) {
  return messengers.map(m => ({
    id: 'bot_token',
    key: `${m.id}.bot_token`,
    messenger: m.id,
    messenger_label: { fa: m.fa, en: m.label },
    mode: 'official',
    label: { fa: `بات رسمی ${m.fa}`, en: `${m.label} official bot` },
    help: m.tokenHelp,
    risk: null,
    fields: [
      { name: 'token', type: 'password', label: { fa: 'توکن بات', en: 'Bot token' }, required: true, placeholder: m.tokenPlaceholder },
      { name: 'default_chat_id', type: 'text', label: { fa: 'کانال یا گفت‌وگوی پیش‌فرض برای انتشار', en: 'Default channel or chat to publish to' },
        required: false, placeholder: '@channel' }
    ]
  }));
}

export function internalRouter({ config, store, accounts, messengers }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!config.internalToken) return res.status(404).json({ detail: 'not_found' });
    if (!safeEqual(req.headers.authorization || '', `Bearer ${config.internalToken}`)) return res.status(401).json({ detail: 'unauthorized' });
    next();
  });

  const summary = a => {
    const v = accounts.view(a);
    return { account_key: v.account_key, messenger: v.messenger, label: v.label, kind: v.kind, mode: v.mode, status: v.status,
      connected_at: v.connected_at, username: v.username, default_chat: v.default_chat, publish_ready: publishReady(a) };
  };
  const publishReady = a => Boolean(a.default_chat && a.send_enabled && (a.allowed_chats.includes('*') || a.allowed_chats.includes(a.default_chat)));

  router.get('/owners/accounts', (req, res) => {
    const sub = normSub(req.query.sub);
    const email = normEmail(req.query.email);
    if (!sub && !email) return res.status(400).json({ detail: 'sub_or_email_required' });
    const owners = store.ownersMatching(sub, email);
    const seen = new Set();
    const list = [];
    for (const o of owners) for (const a of store.accountsOf(o.id)) if (!seen.has(a.key)) { seen.add(a.key); list.push(summary(a)); }
    log('discovery', { owners: owners.length, accounts: list.length });
    res.json({ ok: true, provider: config.providerId, accounts: list });
  });

  const account = (req, res) => {
    const a = store.account(req.params.key);
    if (!a) { res.status(404).json({ detail: 'account_not_found' }); return null; }
    return a;
  };

  router.get('/accounts/:key', (req, res) => {
    const a = account(req, res);
    if (!a) return;
    const v = accounts.view(a);
    res.json({ ok: true, provider: config.providerId, account: { ...summary(a), allowed_chats: v.allowed_chats, send_enabled: v.send_enabled,
      default_chat_title: v.default_chat_title, publish: PUBLISH_KINDS } });
  });

  async function publish(a, { kind = 'text', text = '', mediaUrl = '', title = '', link = '' }) {
    if (!PUBLISH_KINDS.includes(kind)) return [400, { detail: 'unsupported_publish_kind', supported: PUBLISH_KINDS }];
    if (!a.default_chat) return [400, { detail: 'DEFAULT_CHAT_NOT_SET_CHOOSE_ONE_IN_THE_PANEL' }];
    const body = [title, text, link && !String(text).includes(link) ? link : ''].map(s => String(s || '').trim()).filter(Boolean).join('\n\n');
    const ops = accounts.ops(a);
    try {
      let result;
      if (kind === 'text') {
        if (!body) return [400, { detail: 'text_required' }];
        result = await ops.sendMessage({ chatId: a.default_chat, text: body, confirm: true });
      } else {
        if (!mediaUrl) return [400, { detail: 'media_url_required' }];
        result = await ops.sendFile({ chatId: a.default_chat, fileUrl: String(mediaUrl), kind: kind === 'image' ? 'photo' : 'video',
          caption: body || undefined, confirm: true });
      }
      log('publish', { messenger: a.messenger, kind, ok: true });
      return [200, { ok: true, provider: config.providerId, messenger: a.messenger, kind, chat_id: a.default_chat,
        remote_id: result.messageId ?? null, result }];
    } catch (err) {
      const [status, out] = errorBody(err);
      log('publish', { messenger: a.messenger, kind, ok: false, error: out.detail });
      return [status, out];
    }
  }

  router.post('/accounts/:key/publish', async (req, res) => {
    const a = account(req, res);
    if (!a) return;
    const b = req.body || {};
    const [status, out] = await publish(a, { kind: String(b.kind || 'text').toLowerCase(), text: b.text, title: b.title, link: b.link,
      mediaUrl: b.media_url || (Array.isArray(b.media_urls) ? b.media_urls[0] : '') });
    res.status(status).json(out);
  });

  router.post('/accounts/:key/publish/text', async (req, res) => {
    const a = account(req, res);
    if (!a) return;
    const [status, out] = await publish(a, { kind: 'text', text: req.body?.text });
    res.status(status).json(out);
  });

  router.post('/accounts/:key/publish/image', async (req, res) => {
    const a = account(req, res);
    if (!a) return;
    const b = req.body || {};
    const [status, out] = await publish(a, { kind: 'image', mediaUrl: b.image_url || b.media_url, text: b.caption ?? b.text });
    res.status(status).json(out);
  });

  // ---- connect from Social ------------------------------------------------
  router.get('/connect/methods', (req, res) => {
    const only = String(req.query.messenger || '');
    const list = only ? messengers.filter(m => m.id === only) : messengers;
    res.json({ ok: true, provider: config.providerId,
      messengers: messengers.map(m => ({ id: m.id, label: { fa: m.fa, en: m.label } })), methods: connectMethods(list) });
  });

  router.post('/connect/start', async (req, res) => {
    const b = req.body || {};
    const o = b.owner || {};
    const sub = normSub(o.sub);
    if (!sub) return res.status(400).json({ detail: 'owner_sub_required' });
    let method = String(b.method || '');
    let messenger = String(b.messenger || '');
    if (method.includes('.')) [messenger, method] = method.split('.', 2);
    if (method !== 'bot_token') return res.status(400).json({ detail: 'unknown_method' });
    if (!messengers.some(m => m.id === messenger)) return res.status(400).json({ detail: 'unknown_messenger' });
    const owner = store.ensureOwner({ sub, email: normEmail(o.email), emailVerified: o.email_verified === true, name: o.name });
    const f = b.fields || {};
    try {
      const chat = String(f.default_chat_id || f.default_chat || '').trim();
      const { account: a } = await accounts.addBot(owner.id, { messenger, token: f.token, defaultChat: chat, allowSend: Boolean(chat) });
      log('connect', { messenger, ok: true });
      const s = summary(a);
      res.json({ status: 'done', account: { account_key: s.account_key, label: s.label, kind: s.kind, mode: s.mode, status: s.status, messenger } });
    } catch (err) {
      const [, out] = errorBody(err);
      log('connect', { messenger, ok: false, error: out.detail });
      res.json({ status: 'error', error: errorText(out.detail), code: out.detail, retry: true });
    }
  });

  // Bot tokens connect in one step, so there are no open sessions to continue.
  router.get('/connect/:session', (_req, res) => res.status(404).json({ detail: 'session_not_found' }));
  router.post('/connect/:session', (_req, res) => res.status(404).json({ detail: 'session_not_found' }));
  router.post('/connect/:session/cancel', (_req, res) => res.status(404).json({ detail: 'session_not_found' }));

  router.use((err, _req, res, _next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ detail: 'invalid_json' });
    log('error', { where: 'internal', error: String(err?.message || err).slice(0, 120) });
    res.status(500).json({ detail: 'internal_error' });
  });
  return router;
}
