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
// Managing one account from Social (manage contract v1). Every route is
// owner-scoped like discovery: the NabuAuth sub (and the verified email, when
// Social has one) must own the account, or the answer is 404 account_not_found.
// GETs take ?sub=&email=, POSTs {"owner": {"sub", "email"}}.
//
//   GET  /internal/v1/manage                           what this gateway lets Social manage
//   GET  /internal/v1/accounts/{key}/settings          label, default chat, allowed chats, sending switch
//   POST /internal/v1/accounts/{key}/settings          {owner, label?, default_chat?, allowed_chats?, send_enabled?}
//   POST /internal/v1/accounts/{key}/remove            {owner}   (DELETE /accounts/{key}?sub= too)
//   POST /internal/v1/accounts/{key}/send              {owner, chat_id?, kind, text|file_url, caption?, confirm}
//   GET  /internal/v1/accounts/{key}/updates?limit=    recent incoming messages, where the bot API has them
//
// Publishing and sending keep the account's locks: confirm: true, the chat on
// its allowed chats and sending switched on. Reading updates never passes an
// offset, so nothing is marked as delivered. Message bodies, chat ids and
// tokens never reach the log.
import express from 'express';
import { AccountError, cleanLabel, MAX_LABEL, parseChats } from './accounts.mjs';
import { safeEqual } from './crypto.mjs';
import { log } from './log.mjs';
import { can } from './messengers.mjs';

const MAX_SUB = 255;
const MAX_EMAIL = 320;
const PUBLISH_KINDS = ['text', 'image', 'video'];
const SEND_KINDS = ['text', 'photo', 'video', 'audio', 'voice', 'document'];
const MAX_TEXT = 4000;
const MAX_UPDATES = 50;
const MAX_UPDATE_TEXT = 1000;

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
  UNKNOWN_MESSENGER: 'این پیام‌رسان پشتیبانی نمی‌شود.',
  TOO_MANY_ALLOWED_CHATS: 'حداکثر ۵۰ گفت‌وگوی مجاز می‌شود گذاشت.',
  LABEL_TOO_LONG: `نام حساب حداکثر ${MAX_LABEL} نویسه است.`,
  INVALID_SEND_ENABLED: 'مقدار «ارسال روشن» باید بله یا خیر باشد.',
  EXPLICIT_CONFIRMATION_REQUIRED: 'ارسال تأیید صریح می‌خواهد.',
  RECIPIENT_NOT_ALLOWLISTED: 'این گفت‌وگو در فهرست گفت‌وگوهای مجاز این حساب نیست.',
  SEND_DISABLED: 'ارسال برای این حساب خاموش است؛ اول در تنظیمات روشنش کنید.',
  CHAT_ID_REQUIRED: 'گفت‌وگو را مشخص کنید یا برای حساب گفت‌وگوی پیش‌فرض بگذارید.',
  INVALID_MESSAGE: 'متن پیام خالی است یا از ۴۰۰۰ نویسه بلندتر است.',
  FILE_URL_REQUIRED: 'برای فرستادن فایل، نشانی https فایل لازم است.',
  UNSUPPORTED_SEND_KIND: 'این نوع ارسال پشتیبانی نمی‌شود.',
  NOT_SUPPORTED: 'بات این پیام‌رسان این کار را پشتیبانی نمی‌کند.',
  PROVIDER_REJECTED: 'پیام‌رسان درخواست را نپذیرفت.',
  PROVIDER_UNREACHABLE: 'پیام‌رسان در دسترس نبود. کمی بعد دوباره امتحان کنید.',
  MEDIA: 'فایل از آن نشانی گرفته نشد.'
};
const ERRORS_EN = {
  BOT_TOKEN_REJECTED: 'The messenger rejected this token. Take it again from the bot maker.',
  INVALID_BOT_TOKEN: 'This does not look like a bot token.',
  INVALID_CHAT_ID: 'The chat id is not valid.',
  MESSENGER_UNREACHABLE: 'The messenger could not be reached. Try again in a moment.',
  TOO_MANY_ACCOUNTS: 'You have reached the limit of accounts.',
  UNKNOWN_MESSENGER: 'This messenger is not supported.',
  TOO_MANY_ALLOWED_CHATS: 'At most 50 allowed chats.',
  LABEL_TOO_LONG: `The account name is at most ${MAX_LABEL} characters.`,
  INVALID_SEND_ENABLED: 'send_enabled must be true or false.',
  EXPLICIT_CONFIRMATION_REQUIRED: 'Sending needs an explicit confirm.',
  RECIPIENT_NOT_ALLOWLISTED: 'This chat is not on the account\'s allowed chats.',
  SEND_DISABLED: 'Sending is off for this account; turn it on in the settings first.',
  CHAT_ID_REQUIRED: 'Name a chat, or set a default chat for the account.',
  INVALID_MESSAGE: 'The message is empty or longer than 4000 characters.',
  FILE_URL_REQUIRED: 'Sending a file needs its https URL.',
  UNSUPPORTED_SEND_KIND: 'This kind of message is not supported.',
  NOT_SUPPORTED: 'This messenger\'s bot cannot do that.',
  PROVIDER_REJECTED: 'The messenger refused the request.',
  PROVIDER_UNREACHABLE: 'The messenger could not be reached. Try again in a moment.',
  MEDIA: 'The file could not be fetched from that URL.'
};
// Codes that carry a hint after a prefix (RECIPIENT_NOT_ALLOWLISTED_ADD_IT_…) share one text.
const PREFIXES = [
  ['RECIPIENT_NOT_ALLOWLISTED', 'RECIPIENT_NOT_ALLOWLISTED'], ['SEND_DISABLED', 'SEND_DISABLED'],
  ['DEFAULT_CHAT_NOT_SET', 'CHAT_ID_REQUIRED'], ['CHAT_ID_REQUIRED', 'CHAT_ID_REQUIRED'], ['NOT_SUPPORTED_BY_', 'NOT_SUPPORTED'],
  ['PROVIDER_API_REJECTED', 'PROVIDER_REJECTED'], ['PROVIDER_HTTP_ERROR', 'PROVIDER_REJECTED'],
  ['PROVIDER_UNREACHABLE', 'PROVIDER_UNREACHABLE'], ['PROVIDER_TIMEOUT', 'PROVIDER_UNREACHABLE'], ['MEDIA_', 'MEDIA'],
  ['INVALID_MEDIA_URL', 'MEDIA'], ['FILE_', 'MEDIA'], ['INVALID_FILE_URL', 'MEDIA']
];
export const errorText = code => {
  const c = String(code || '');
  const key = ERRORS_FA[c] ? c : (PREFIXES.find(([p]) => c.startsWith(p)) || [])[1];
  return { fa: (key && ERRORS_FA[key]) || `خطا: ${c}`, en: (key && ERRORS_EN[key]) || `Error: ${c}` };
};

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
      connected_at: v.connected_at, username: v.username, default_chat: v.default_chat, publish_ready: publishReady(a), manage: true };
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

  // ---- manage from Social (owner-scoped) ----------------------------------
  router.get('/manage', (_req, res) => {
    res.json({ ok: true, provider: config.providerId, version: 1,
      routes: { settings: true, remove: true, send: true, updates: true },
      send_kinds: SEND_KINDS, limits: { text: MAX_TEXT, allowed_chats: 50, label: MAX_LABEL, updates: MAX_UPDATES } });
  });

  // The account behind :key, only when this sub (or verified email) owns it.
  const owned = (req, res, who) => {
    const sub = normSub(who?.sub);
    if (!sub) { res.status(400).json({ detail: 'owner_sub_required' }); return null; }
    const owners = new Set(store.ownersMatching(sub, normEmail(who?.email)).map(o => o.id));
    const a = store.account(req.params.key);
    if (!a || !owners.has(a.owner_id)) { res.status(404).json({ detail: 'account_not_found' }); return null; }
    return a;
  };
  const ownerQuery = req => ({ sub: req.query.sub, email: req.query.email });
  const ownerBody = req => (req.body && typeof req.body.owner === 'object' && req.body.owner) || {};
  const fail = (res, err, where, fields = {}) => {
    const [status, out] = errorBody(err);
    log(where, { ...fields, ok: false, error: String(out.detail).slice(0, 60) });
    res.status(status).json({ ...out, error: errorText(out.detail) });
  };

  const settingsOf = a => {
    const v = accounts.view(a);
    const m = messengers.find(x => x.id === a.messenger);
    return { ...summary(a), custom_label: v.custom_label, bot_name: v.bot_name, verified: v.verified,
      messenger_label: m ? { fa: m.fa, en: m.label } : { fa: a.messenger, en: a.messenger },
      chat_hint: m ? m.chatHint : null, default_chat_title: v.default_chat_title, allowed_chats: v.allowed_chats,
      send_enabled: v.send_enabled, capabilities: v.capabilities, updated_at: v.updated_at,
      can: { send_text: m ? can(m, 'send_text') : false, send_file: m ? can(m, 'send_file') : false,
        read_updates: m ? can(m, 'get_updates') : false },
      send_kinds: m && can(m, 'send_file') ? SEND_KINDS : ['text'] };
  };

  router.get('/accounts/:key/settings', (req, res) => {
    const a = owned(req, res, ownerQuery(req));
    if (!a) return;
    res.json({ ok: true, provider: config.providerId, account: settingsOf(a) });
  });

  const updateSettings = async (req, res) => {
    const a = owned(req, res, ownerBody(req));
    if (!a) return;
    const b = req.body || {};
    const changes = {};
    try {
      if (b.label !== undefined) changes.label = cleanLabel(b.label);
      if (b.allowed_chats !== undefined) changes.allowedChats = parseChats(b.allowed_chats);
      if (b.default_chat !== undefined) changes.defaultChat = b.default_chat ?? '';
      if (b.send_enabled !== undefined) {
        if (typeof b.send_enabled !== 'boolean') throw new AccountError('INVALID_SEND_ENABLED');
        changes.sendEnabled = b.send_enabled;
      }
      const updated = await accounts.updateSettings(a, changes);
      log('manage', { action: 'settings', messenger: a.messenger, ok: true });
      res.json({ ok: true, provider: config.providerId, account: settingsOf(updated) });
    } catch (err) { fail(res, err, 'manage', { action: 'settings', messenger: a.messenger }); }
  };
  router.post('/accounts/:key/settings', updateSettings);
  router.patch('/accounts/:key/settings', updateSettings);

  const remove = (req, res, who) => {
    const a = owned(req, res, who);
    if (!a) return;
    accounts.remove(a);
    log('manage', { action: 'remove', messenger: a.messenger, ok: true });
    res.json({ ok: true, provider: config.providerId, removed: a.key });
  };
  router.post('/accounts/:key/remove', (req, res) => remove(req, res, ownerBody(req)));
  router.delete('/accounts/:key', (req, res) => remove(req, res, ownerQuery(req)));

  // One message or one file to one chat. The core's bot ops hold the locks:
  // confirm must be exactly true, the chat on the allowed chats, sending on.
  router.post('/accounts/:key/send', async (req, res) => {
    const a = owned(req, res, ownerBody(req));
    if (!a) return;
    const b = req.body || {};
    const kind = String(b.kind || 'text').toLowerCase();
    const fields = { action: 'send', messenger: a.messenger, kind };
    try {
      if (!SEND_KINDS.includes(kind)) throw new AccountError('UNSUPPORTED_SEND_KIND');
      const chatId = String(b.chat_id ?? '').trim() || a.default_chat;
      if (!chatId) throw new AccountError('CHAT_ID_REQUIRED');
      const confirm = b.confirm === true;
      const ops = accounts.ops(a);
      let result;
      if (kind === 'text') {
        const text = typeof b.text === 'string' ? b.text : '';
        if (!confirm) {
          let preview = null;
          try { preview = ops.preview({ chatId, text }); delete preview.text; } catch { preview = null; }
          return res.status(400).json({ detail: 'EXPLICIT_CONFIRMATION_REQUIRED', error: errorText('EXPLICIT_CONFIRMATION_REQUIRED'),
            preview });
        }
        result = await ops.sendMessage({ chatId, text, replyToMessageId: b.reply_to_message_id || undefined, confirm });
      } else {
        const fileUrl = String(b.file_url || '').trim();
        if (!fileUrl) throw new AccountError('FILE_URL_REQUIRED');
        const caption = String(b.caption ?? b.text ?? '').trim() || undefined;
        result = await ops.sendFile({ chatId, fileUrl, kind, caption, confirm });
      }
      log('manage', { ...fields, ok: true });
      res.json({ ok: true, provider: config.providerId, messenger: a.messenger, kind, chat_id: chatId,
        message_id: result.messageId ?? null });
    } catch (err) { fail(res, err, 'manage', fields); }
  });

  // Recent incoming messages, newest first, and the chats they came from. No
  // offset is sent, so the messenger keeps every update pending (read-only).
  router.get('/accounts/:key/updates', async (req, res) => {
    const a = owned(req, res, ownerQuery(req));
    if (!a) return;
    const m = messengers.find(x => x.id === a.messenger);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), MAX_UPDATES);
    if (!m || !can(m, 'get_updates')) {
      return res.json({ ok: true, provider: config.providerId, supported: false, messenger: a.messenger, updates: [], chats: [] });
    }
    try {
      const { updates } = await accounts.ops(a).getUpdates({ limit: 100 });
      const allowed = new Set(a.allowed_chats);
      const items = updates.slice(-limit).reverse().map(u => ({
        kind: u.kind ?? null, chat_id: u.chatId ?? null, chat_title: u.chatTitle ?? null, message_id: u.messageId ?? null,
        from: u.from != null ? String(u.from).slice(0, 120) : null,
        text: u.text != null ? String(u.text).slice(0, MAX_UPDATE_TEXT) : null, date: u.date ?? null }));
      const chats = new Map();
      for (const u of updates.slice().reverse()) {
        if (!u.chatId || chats.has(u.chatId)) continue;
        chats.set(u.chatId, { chat_id: u.chatId, title: u.chatTitle ?? null, last_at: u.date ?? null,
          allowed: allowed.has('*') || allowed.has(u.chatId), is_default: a.default_chat === u.chatId });
      }
      log('manage', { action: 'updates', messenger: a.messenger, ok: true, count: items.length });
      res.json({ ok: true, provider: config.providerId, supported: true, messenger: a.messenger, updates: items,
        chats: [...chats.values()].slice(0, MAX_UPDATES) });
    } catch (err) { fail(res, err, 'manage', { action: 'updates', messenger: a.messenger }); }
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
