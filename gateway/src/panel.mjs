// The panel: Sign in with Nabux, the owner's messenger bots, their write
// permissions, Connect to AI, tools, settings, and the MCP consent page.
// Persian first (fa is the default language), English on the toggle.
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AccountError } from './accounts.mjs';
import { pkcePair, safeEqual } from './crypto.mjs';
import { errorText } from './internal.mjs';
import { log } from './log.mjs';
import { buildMcpServer } from './mcp.mjs';
import { can } from './messengers.mjs';
import { FLOW_COOKIE, SSO_GUARD_COOKIE, safeNext } from './session.mjs';
import {
  Ctx, LANG_COOKIE, THEME_COOKIE, appPage, badge, button, card, checkbox, connectAi, copyButton, dangerZone, details, emptyState,
  endpointRow, grid, html, icon, kvList, messagePage, notice, postForm, selectField, send, serveStatic, signinPage, stack, stat,
  statusBadge, steps, table, textField, textareaField, tile, toolsList
} from './ui.mjs';

const FLOW_TTL = 600;
const SILENT_ERRORS = new Set(['login_required', 'consent_required', 'interaction_required', 'account_selection_required']);

const STRINGS = {
  fa: {
    'nav.overview': 'نمای کلی', 'nav.accounts': 'بات‌ها', 'nav.connect': 'اتصال به هوش مصنوعی', 'nav.tools': 'ابزارها', 'nav.settings': 'تنظیمات'
  },
  en: {
    'nav.overview': 'Overview', 'nav.accounts': 'Bots', 'nav.connect': 'Connect to AI', 'nav.tools': 'Tools', 'nav.settings': 'Settings'
  }
};

export function panelRouter({ config, keys, store, accounts, messengers, sessions, nabuauth, oauth, version }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '64kb' }));
  const host = new URL(config.baseUrl).host;
  const secure = config.baseUrl.startsWith('https://');
  const mcpUrl = `${config.baseUrl}/mcp`;

  const consoleInfo = {
    product: 'Iran MCP', productFa: 'پیام‌رسان‌های ایرانی', color: '#239F40', glyph: 'chat',
    baseUrl: config.baseUrl, host, nabuauthUrl: config.nabuauth.url, nabuauthEnabled: nabuauth.enabled, strings: STRINGS,
    nav: [
      { key: 'overview', href: '/dashboard', label: { fa: 'نمای کلی', en: 'Overview' }, icon: 'overview', section: 'workspace' },
      { key: 'accounts', href: '/dashboard/accounts', label: { fa: 'بات‌ها', en: 'Bots' }, icon: 'accounts', section: 'workspace' },
      { key: 'connect', href: '/dashboard/connect', label: { fa: 'اتصال به هوش مصنوعی', en: 'Connect to AI' }, icon: 'connect', section: 'workspace' },
      { key: 'tools', href: '/dashboard/tools', label: { fa: 'ابزارها', en: 'Tools' }, icon: 'tools', section: 'workspace' },
      { key: 'settings', href: '/dashboard/settings', label: { fa: 'تنظیمات', en: 'Settings' }, icon: 'settings', section: 'developers' }
    ]
  };

  const ctxOf = req => new Ctx(consoleInfo, req, sessions.owner(req), sessions.csrf(req));
  const mTile = (m, size = 28) => tile(m.color, 'chat', size);
  const mName = (ctx, m) => (ctx.lang === 'fa' ? m.fa : m.label);
  const toastOf = (ctx, req) => ({
    added: ctx.pick('بات وصل شد', 'Bot connected'), saved: ctx.pick('ذخیره شد', 'Saved'), checked: ctx.pick('بررسی شد', 'Checked'),
    removed: ctx.pick('حذف شد', 'Removed'), revoked: ctx.pick('دسترسی‌ها قطع شد', 'Access revoked')
  })[String(req.query.done || '')] || null;

  const loginUrl = next => `/auth/nabu/login?next=${encodeURIComponent(safeNext(next))}`;
  const guard = res => res.cookie(SSO_GUARD_COOKIE, '1', { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 30 * 60 * 1000 });

  function requireLogin(req, res, next) {
    const owner = sessions.owner(req);
    if (!owner) return res.redirect(302, nabuauth.enabled ? loginUrl(req.originalUrl) : '/');
    req.owner = owner;
    next();
  }
  const csrfOk = (req, res) => {
    if (sessions.csrfOk(req, req.body?.csrf)) return true;
    res.redirect(303, '/dashboard');
    return false;
  };

  // ---- static, prefs, NabuAuth --------------------------------------------
  router.get('/static/console/{*path}', (req, res) => {
    req.params.path = [].concat(req.params.path || []).join('/');
    serveStatic(req, res);
  });

  router.get('/console/prefs', (req, res) => {
    const opts = { maxAge: 365 * 86400 * 1000, path: '/', sameSite: 'lax', secure };
    const lang = String(req.query.lang || '').toLowerCase();
    const theme = String(req.query.theme || '').toLowerCase();
    if (lang === 'fa' || lang === 'en') res.cookie(LANG_COOKIE, lang, opts);
    if (['light', 'dark', 'system'].includes(theme)) res.cookie(THEME_COOKIE, theme, opts);
    res.redirect(303, safeNext(req.query.next, '/'));
  });

  router.get('/auth/nabu/login', (req, res) => {
    if (!nabuauth.enabled) return res.redirect(302, '/');
    const silent = req.query.prompt === 'none';
    const { state, verifier, challenge } = pkcePair();
    const flow = keys.sign({ purpose: 'nabu', state, verifier, silent, next: safeNext(req.query.next),
      exp: Math.floor(Date.now() / 1000) + FLOW_TTL }, 'flow');
    res.cookie(FLOW_COOKIE, flow, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: FLOW_TTL * 1000 });
    if (silent) guard(res);
    res.redirect(302, nabuauth.authorizeUrl({ state, challenge, prompt: silent ? 'none' : null }));
  });

  router.get('/auth/nabu/callback', async (req, res) => {
    if (!nabuauth.enabled) return res.redirect(302, '/');
    const ctx = ctxOf(req);
    const flow = keys.unsign(req.cookies[FLOW_COOKIE], 'flow');
    res.clearCookie(FLOW_COOKIE, { path: '/' });
    const error = String(req.query.error || '').trim();
    if (error) {
      if (SILENT_ERRORS.has(error) || flow?.silent) { guard(res); return res.redirect(303, '/?sso=0'); }
      return send(res, ctx, ctx.t('auth.cancelled.title'), messagePage(ctx, { title: ctx.t('auth.cancelled.title'), message: error.slice(0, 100),
        action: [ctx.t('auth.retry'), '/auth/nabu/login'] }));
    }
    const code = String(req.query.code || '').trim();
    if (!flow || flow.purpose !== 'nabu' || !code || !safeEqual(flow.state, String(req.query.state || ''))) {
      return send(res, ctx, ctx.t('auth.expired.title'), messagePage(ctx, { title: ctx.t('auth.expired.title'), message: ctx.t('auth.expired.text'),
        t: 'warning', action: [ctx.t('auth.retry'), '/auth/nabu/login'] }));
    }
    try {
      const profile = await nabuauth.exchange(code, flow.verifier);
      const owner = store.ensureOwner(profile);
      sessions.start(res, owner.id);
      res.clearCookie(SSO_GUARD_COOKIE, { path: '/' });
      log('signin', { ok: true });
      res.redirect(303, safeNext(flow.next));
    } catch (err) {
      log('signin', { ok: false, error: String(err.message).slice(0, 80) });
      send(res, ctx, ctx.t('auth.failed.title'), messagePage(ctx, { title: ctx.t('auth.failed.title'), message: err.message,
        action: [ctx.t('auth.retry'), '/auth/nabu/login'] }));
    }
  });

  router.post('/auth/logout', (req, res) => {
    if (!sessions.csrfOk(req, req.body?.csrf)) return res.redirect(303, '/dashboard');
    sessions.end(res);
    guard(res);
    res.redirect(303, nabuauth.enabled ? nabuauth.endSessionUrl(`${config.baseUrl}/`) : '/');
  });

  // ---- sign-in landing ------------------------------------------------------
  router.get('/', (req, res) => {
    if (sessions.owner(req)) return res.redirect(302, '/dashboard');
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    if (nabuauth.enabled && wantsHtml && !req.cookies[SSO_GUARD_COOKIE] && req.query.sso !== '0') {
      guard(res);
      return res.redirect(302, `/auth/nabu/login?prompt=none&next=${encodeURIComponent(safeNext(req.query.next))}`);
    }
    const ctx = ctxOf(req);
    const features = messengers.map(m => ({ tile: mTile(m, 18), title: mName(ctx, m),
      text: ctx.pick(`بات رسمی ${m.fa}: ارسال پیام و فایل، انتشار در کانال${can(m, 'get_updates') ? '، خواندن پیام‌های ورودی' : ''}`,
        `${m.label} official bot: send messages and files, publish to a channel${can(m, 'get_updates') ? ', read incoming messages' : ''}`) }));
    send(res, ctx, consoleInfo.product, signinPage(ctx, {
      headline: ctx.pick('پیام‌رسان‌های ایرانی، در دستیار هوش مصنوعی شما', 'Iranian messengers, inside your AI assistant'),
      tagline: ctx.pick('بات‌های بله، ایتا، روبیکا، سروش پلاس و گپ را یک بار وصل کنید و از Claude، ChatGPT یا Social MCP پیام بفرستید و در کانال‌هایتان منتشر کنید؛ با قفل‌های ایمنی روی هر ارسال.',
        'Connect your Bale, Eitaa, Rubika, Soroush Plus and Gap bots once, then message and publish to your channels from Claude, ChatGPT or Social MCP, with safety locks on every send.'),
      features,
      trust: ctx.pick('فقط API رسمی بات‌ها', 'Official bot APIs only'),
      privacy: ctx.pick('توکن بات‌ها رمزنگاری‌شده روی همین سرور در ایران می‌ماند و فقط برای کارهایی به کار می‌رود که شما یا دستیارتان درخواست می‌کنید. هیچ ارسالی بدون فهرست مجاز و روشن بودن ارسال انجام نمی‌شود.',
        'Bot tokens stay encrypted on this server in Iran and are used only for what you or your assistant ask for. Nothing is sent unless the chat is allowed and sending is on.'),
      loginHref: loginUrl(req.query.next)
    }));
  });

  // ---- dashboard --------------------------------------------------------------
  router.get('/dashboard', requireLogin, async (req, res) => {
    const ctx = ctxOf(req);
    const list = store.accountsOf(req.owner.id);
    const views = list.map(a => accounts.view(a));
    const ai = store.connectionsOf(req.owner.id).length;
    const used = new Set(list.map(a => a.messenger)).size;
    const sending = views.filter(v => v.send_enabled).length;
    const stats = grid([
      stat(ctx.pick('بات‌های وصل', 'Connected bots'), ctx.num(list.length), { iconName: 'accounts', href: '/dashboard/accounts',
        hint: ctx.pick(`در ${ctx.num(used)} پیام‌رسان`, `on ${used} messenger(s)`) }),
      stat(ctx.pick('ارسال روشن', 'Sending on'), ctx.num(sending), { iconName: 'send', t: 'success',
        hint: ctx.pick('بقیه فقط می‌خوانند', 'the others only read') }),
      stat(ctx.pick('اتصال‌های هوش مصنوعی', 'AI connections'), ctx.num(ai), { iconName: 'sparkles', href: '/dashboard/connect',
        hint: ctx.pick('کلاینت با دسترسی فعال', 'clients with access') }),
      stat(ctx.pick('پیام‌رسان‌ها', 'Messengers'), ctx.num(messengers.length), { iconName: 'message', t: 'info',
        hint: messengers.map(m => mName(ctx, m)).join(ctx.lang === 'fa' ? '، ' : ', ') })
    ], 4);
    const rows = views.map(v => {
      const m = messengers.find(x => x.id === v.messenger);
      return [
        html`<a href="/dashboard/accounts/${v.account_key}" class="nx-cell">${m ? mTile(m, 32) : ''}<span class="nx-cell__main"><span class="nx-cell__title" style="display:block"><bdi>${v.label}</bdi></span><span class="nx-cell__sub" style="display:block">${m ? mName(ctx, m) : v.messenger}</span></span></a>`,
        statusBadge(ctx, v.status),
        v.send_enabled ? badge(ctx.pick('ارسال روشن', 'Sending on'), 'success') : badge(ctx.pick('فقط خواندن', 'Read only'), 'neutral')
      ];
    });
    const accountsCard = card(table([ctx.pick('بات', 'Bot'), ctx.pick('وضعیت', 'Status'), ctx.pick('ارسال', 'Sending')], rows, {
      empty: emptyState(ctx.pick('هنوز باتی وصل نشده', 'No bots yet'), ctx.pick('اولین بات خود را وصل کنید.', 'Connect your first bot.'),
        { action: button(ctx.pick('افزودن بات', 'Add a bot'), '/dashboard/accounts/new', { iconName: 'plus' }) })
    }), { title: ctx.pick('بات‌ها', 'Bots'), flush: true, actions: button(ctx.pick('مدیریت', 'Manage'), '/dashboard/accounts', { variant: 'ghost', size: 'sm' }) });
    const start = card(steps([
      [ctx.pick('ورود با حساب Nabux', 'Sign in with Nabux'), '', true],
      [ctx.pick('اتصال یک بات', 'Connect a bot'), '', list.length > 0],
      [ctx.pick('انتخاب کانال پیش‌فرض و روشن کردن ارسال', 'Pick a default channel and turn sending on'), '', sending > 0],
      [ctx.pick('افزودن به Claude، ChatGPT یا Cursor', 'Add to Claude, ChatGPT or Cursor'), '', ai > 0]
    ], ctx.lang), { title: ctx.pick('شروع کار', 'Getting started') });
    const endpoint = card(endpointRow(null, mcpUrl, ctx, { hint: ctx.pick('آدرس را در هر کلاینت MCP وارد کنید؛ ورود با Nabux انجام می‌شود.', 'Paste it into any MCP client; sign-in is with Nabux.') }),
      { title: ctx.pick('آدرس MCP', 'MCP endpoint'), actions: button(ctx.pick('راهنما', 'Guide'), '/dashboard/connect', { variant: 'ghost', size: 'sm', trailing: 'arrow' }) });
    send(res, ctx, ctx.t('nav.overview'), appPage(ctx, {
      title: ctx.t('nav.overview'), active: 'overview', toast: toastOf(ctx, req),
      subtitle: ctx.pick(`خوش آمدید${req.owner.name ? `، ${req.owner.name}` : ''}. بات‌های پیام‌رسان‌های ایرانی شما در یک نگاه.`,
        `Welcome${req.owner.name ? `, ${req.owner.name}` : ''}. Your Iranian messenger bots at a glance.`),
      actions: button(ctx.pick('افزودن بات', 'Add a bot'), '/dashboard/accounts/new', { iconName: 'plus' }),
      body: stack([stats, html`<div class="nx-grid nx-grid--2">${accountsCard}${stack([start, endpoint])}</div>`])
    }));
  });

  // ---- accounts -----------------------------------------------------------------
  router.get('/dashboard/accounts', requireLogin, (req, res) => {
    const ctx = ctxOf(req);
    const list = store.accountsOf(req.owner.id);
    const cards = messengers.map(m => {
      const mine = list.filter(a => a.messenger === m.id).map(a => accounts.view(a));
      const rows = mine.map(v => [
        html`<a href="/dashboard/accounts/${v.account_key}"><b><bdi>${v.label}</bdi></b></a>${v.username ? html`<br><span class="nx-muted" dir="ltr">@${v.username}</span>` : ''}`,
        v.default_chat ? html`<code dir="ltr">${v.default_chat}</code>` : html`<span class="nx-muted">${ctx.pick('تعیین نشده', 'Not set')}</span>`,
        statusBadge(ctx, v.status),
        v.send_enabled ? badge(ctx.pick('ارسال روشن', 'Sending on'), 'success') : badge(ctx.pick('فقط خواندن', 'Read only'))
      ]);
      return card(table([ctx.pick('بات', 'Bot'), ctx.pick('کانال پیش‌فرض', 'Default channel'), ctx.pick('وضعیت', 'Status'), ctx.pick('ارسال', 'Sending')], rows, {
        empty: html`<p class="nx-muted" style="padding:16px 20px">${ctx.pick('هنوز باتی در این پیام‌رسان وصل نکرده‌اید.', 'No bot on this messenger yet.')}</p>`
      }), { title: html`<span class="nx-cell">${mTile(m, 24)}<span>${mName(ctx, m)}</span></span>`, flush: true,
        subtitle: ctx.text(m.tokenHelp),
        actions: button(ctx.pick('افزودن بات', 'Add bot'), `/dashboard/accounts/new?messenger=${m.id}`, { variant: 'secondary', size: 'sm', iconName: 'plus' }) });
    });
    const web = notice(ctx.pick('حالت وب (حساب شخصی خودتان در یک پنجرهٔ Chrome روی سرور) در مرحلهٔ بعد اضافه می‌شود. این حالت غیررسمی است و ممکن است حساب را محدود کند؛ تا آن زمان نسخهٔ محلی هر پیام‌رسان (npx -y @nabuxai/<name>-mcp) را روی رایانهٔ خودتان به کار ببرید.',
      'Web mode (your own account in a Chrome window on the server) comes in the next phase. It is unofficial and can get an account limited; until then, run each messenger\'s local server (npx -y @nabuxai/<name>-mcp) on your own computer.'),
    { t: 'warning', title: ctx.pick('حساب شخصی (حالت وب)', 'Your own account (web mode)') });
    send(res, ctx, ctx.t('nav.accounts'), appPage(ctx, {
      title: ctx.t('nav.accounts'), active: 'accounts', toast: toastOf(ctx, req),
      subtitle: ctx.pick('هر بات یک حساب است: توکنش رمزنگاری‌شده نگه داشته می‌شود و فقط به گفت‌وگوهای مجاز می‌نویسد.', 'Each bot is one account: its token is kept encrypted and it writes only to allowed chats.'),
      actions: button(ctx.pick('افزودن بات', 'Add a bot'), '/dashboard/accounts/new', { iconName: 'plus' }),
      body: stack([...cards, web])
    }));
  });

  function newBotPage(req, res, { values = {}, error = null, status = 200 } = {}) {
    const ctx = ctxOf(req);
    const chosen = messengers.find(m => m.id === (values.messenger || req.query.messenger)) || messengers[0];
    const form = html`<form method="post" action="/dashboard/accounts/new" class="nx-stack nx-stack--md">${ctx.csrfField()}
      ${error ? notice(error, { t: 'danger' }) : ''}
      ${selectField('messenger', ctx.pick('پیام‌رسان', 'Messenger'), messengers.map(m => [m.id, mName(ctx, m)]), { value: chosen.id })}
      ${textField('token', ctx.pick('توکن بات', 'Bot token'), { type: 'password', required: true, ltr: true, autocomplete: 'off',
        placeholder: chosen.tokenPlaceholder, hint: ctx.text(chosen.tokenHelp) })}
      ${textField('default_chat', ctx.pick('کانال یا گفت‌وگوی پیش‌فرض (اختیاری)', 'Default channel or chat (optional)'), { value: values.default_chat || '', ltr: true,
        placeholder: '@channel', hint: ctx.pick(`جایی که Social و ابزار انتشار در آن پست می‌گذارند: ${ctx.text(chosen.chatHint)}`, `Where Social and publishing post: ${ctx.text(chosen.chatHint)}`) })}
      ${checkbox('allow_send', ctx.pick('اجازهٔ ارسال به همین کانال را بده (آن را به فهرست مجاز اضافه و ارسال را روشن می‌کند)', 'Allow sending to this chat (adds it to the allowed chats and turns sending on)'), { checked: values.allow_send !== false })}
      <div>${button(ctx.pick('بررسی و وصل کردن', 'Check and connect'), null, { iconName: 'plug' })}</div></form>`;
    send(res, ctx, ctx.pick('افزودن بات', 'Add a bot'), appPage(ctx, {
      title: ctx.pick('افزودن بات', 'Add a bot'), active: 'accounts',
      subtitle: ctx.pick('توکن با getMe در خود پیام‌رسان بررسی و سپس رمزنگاری‌شده ذخیره می‌شود. هیچ‌جا نمایش داده نمی‌شود.',
        'The token is checked with the messenger\'s getMe, then stored encrypted. It is never shown again.'),
      body: html`<div class="nx-grid nx-grid--2">${card(form)}${card(stack(messengers.map(m => html`<div class="nx-cell" style="align-items:flex-start">${mTile(m, 24)}<div><b>${mName(ctx, m)}</b><p class="nx-muted">${ctx.text(m.tokenHelp)}</p></div></div>`)),
        { title: ctx.pick('توکن را از کجا بگیرم؟', 'Where do I get a token?') })}</div>`
    }), status);
  }

  router.get('/dashboard/accounts/new', requireLogin, (req, res) => newBotPage(req, res));

  router.post('/dashboard/accounts/new', requireLogin, async (req, res) => {
    if (!csrfOk(req, res)) return;
    const b = req.body || {};
    const values = { messenger: String(b.messenger || ''), default_chat: String(b.default_chat || ''), allow_send: b.allow_send === '1' };
    try {
      const { account } = await accounts.addBot(req.owner.id, { messenger: values.messenger, token: b.token,
        defaultChat: values.default_chat, allowSend: values.allow_send });
      log('panel', { action: 'add_bot', messenger: values.messenger, ok: true });
      res.redirect(303, `/dashboard/accounts/${account.key}?done=added`);
    } catch (err) {
      const code = err instanceof AccountError ? err.message : String(err.message || 'ERROR');
      log('panel', { action: 'add_bot', messenger: values.messenger, ok: false, error: code });
      const ctx = ctxOf(req);
      newBotPage(req, res, { values, error: ctx.text(errorText(code)), status: 400 });
    }
  });

  const own = (req, res) => {
    const a = accounts.get(req.owner.id, req.params.key);
    if (!a) { res.redirect(303, '/dashboard/accounts'); return null; }
    return a;
  };

  router.get('/dashboard/accounts/:key', requireLogin, (req, res) => {
    const a = own(req, res);
    if (!a) return;
    const ctx = ctxOf(req);
    const v = accounts.view(a);
    const m = messengers.find(x => x.id === a.messenger);
    const info = card(kvList([
      [ctx.pick('پیام‌رسان', 'Messenger'), html`<span class="nx-cell">${mTile(m, 20)}${mName(ctx, m)}</span>`],
      [ctx.pick('بات', 'Bot'), v.username ? html`<span dir="ltr">@${v.username}</span>` : (v.bot_name || '—')],
      [ctx.pick('وضعیت', 'Status'), html`${statusBadge(ctx, v.status)} ${v.verified ? '' : badge(ctx.pick('بررسی‌نشده', 'Not verifiable'), 'warning')}`],
      [ctx.pick('حالت', 'Mode'), badge(v.mode === 'web' ? ctx.pick('حساب شخصی مرورگری', 'Personal browser account') : ctx.pick('بات رسمی', 'Official bot'), 'info', false)],
      [ctx.pick('کلید حساب', 'Account key'), html`<span class="nx-cell"><code dir="ltr" class="nx-key">${v.account_key}</code>${copyButton(v.account_key, ctx)}</span>`],
      [ctx.pick('توانایی‌ها', 'Can do'), html`<span dir="ltr">${v.capabilities.join(', ')}</span>`]
    ]), { title: ctx.pick('مشخصات', 'Details'), actions: postForm(`/dashboard/accounts/${a.key}/check`, ctx,
      button(ctx.pick('بررسی اتصال', 'Check connection'), null, { variant: 'ghost', size: 'sm', iconName: 'refresh' })) });
    const settings = card(html`<form method="post" action="/dashboard/accounts/${a.key}/settings" class="nx-stack nx-stack--md">${ctx.csrfField()}
      ${textField('default_chat', ctx.pick('کانال یا گفت‌وگوی پیش‌فرض', 'Default channel or chat'), { value: v.default_chat || '', ltr: true, placeholder: '@channel',
        hint: ctx.pick(`انتشار از Social و ابزارها بدون chatId به این‌جا می‌رود. ${ctx.text(m.chatHint)}${v.default_chat_title ? ` — ${v.default_chat_title}` : ''}`,
          `Publishing from Social, and tools called without a chatId, go here. ${ctx.text(m.chatHint)}${v.default_chat_title ? ` — ${v.default_chat_title}` : ''}`) })}
      ${textareaField('allowed_chats', ctx.pick('گفت‌وگوهای مجاز برای نوشتن', 'Chats it may write to'), { value: v.allowed_chats.join('\n'), ltr: true, mono: true, rows: 4,
        hint: ctx.pick('هر خط یک گفت‌وگو. «*» یعنی هر گفت‌وگو. خالی یعنی هیچ‌جا.', 'One chat per line. "*" means any chat. Empty means none.') })}
      ${checkbox('send_enabled', ctx.pick('ارسال روشن باشد (بدون این، بات فقط می‌خواند و پیش‌نمایش می‌دهد)', 'Sending is on (without it the bot only reads and previews)'), { checked: v.send_enabled })}
      <div>${button(ctx.pick('ذخیره', 'Save'))}</div></form>`, { title: ctx.pick('قفل‌های ارسال', 'Write locks'),
      subtitle: ctx.pick('هر ارسال از هوش مصنوعی نیاز به تأیید صریح (confirm)، گفت‌وگوی مجاز و روشن بودن ارسال دارد.', 'Every send from an AI needs an explicit confirm, an allowed chat, and sending on.') });
    const replace = card(details(ctx.pick('جایگزینی توکن', 'Replace the token'), html`<form method="post" action="/dashboard/accounts/new" class="nx-stack nx-stack--md">${ctx.csrfField()}<input type="hidden" name="messenger" value="${a.messenger}">
      ${textField('token', ctx.pick('توکن تازه', 'New token'), { type: 'password', required: true, ltr: true, autocomplete: 'off', hint: ctx.pick('اگر توکن همین بات باشد، همین حساب به‌روز می‌شود.', 'If it is the same bot, this account is updated.') })}
      <div>${button(ctx.pick('ذخیرهٔ توکن', 'Save token'), null, { variant: 'secondary' })}</div></form>`, { subtle: true }));
    const danger = dangerZone(ctx, [[ctx.pick('حذف این بات', 'Remove this bot'), ctx.pick('توکن از این سرور پاک می‌شود و Social دیگر به آن منتشر نمی‌کند.', 'The token is erased from this server and Social stops publishing to it.'),
      postForm(`/dashboard/accounts/${a.key}/delete`, ctx, button(ctx.pick('حذف', 'Remove'), null, { variant: 'danger', size: 'sm', iconName: 'trash' }), { confirm: ctx.pick('این بات حذف شود؟', 'Remove this bot?') })]]);
    send(res, ctx, v.label, appPage(ctx, { title: v.label, active: 'accounts', toast: toastOf(ctx, req),
      subtitle: v.mode === 'web' ? ctx.pick(`حساب شخصی ${m.fa}`, `${m.label} personal account`) : ctx.pick(`بات ${m.fa}`, `${m.label} bot`), body: html`<div class="nx-grid nx-grid--2">${stack(v.mode === 'web' ? [info] : [info, replace])}${stack([settings, danger])}</div>` }));
  });

  router.post('/dashboard/accounts/:key/settings', requireLogin, async (req, res) => {
    if (!csrfOk(req, res)) return;
    const a = own(req, res);
    if (!a) return;
    try {
      await accounts.updateSettings(a, { defaultChat: req.body.default_chat ?? '', allowedChats: req.body.allowed_chats ?? '', sendEnabled: req.body.send_enabled === '1' });
      log('panel', { action: 'settings', messenger: a.messenger, ok: true });
      res.redirect(303, `/dashboard/accounts/${a.key}?done=saved`);
    } catch (err) {
      const ctx = ctxOf(req);
      send(res, ctx, ctx.t('auth.failed.title'), messagePage(ctx, { title: ctx.pick('ذخیره نشد', 'Not saved'), message: ctx.text(errorText(err.message)),
        t: 'warning', action: [ctx.pick('بازگشت', 'Back'), `/dashboard/accounts/${a.key}`] }), 400);
    }
  });

  router.post('/dashboard/accounts/:key/check', requireLogin, async (req, res) => {
    if (!csrfOk(req, res)) return;
    const a = own(req, res);
    if (!a) return;
    await accounts.check(a);
    res.redirect(303, `/dashboard/accounts/${a.key}?done=checked`);
  });

  router.post('/dashboard/accounts/:key/delete', requireLogin, (req, res) => {
    if (!csrfOk(req, res)) return;
    const a = own(req, res);
    if (!a) return;
    accounts.remove(a);
    log('panel', { action: 'remove', messenger: a.messenger, ok: true });
    res.redirect(303, '/dashboard/accounts?done=removed');
  });

  // ---- connect to AI, tools, settings ------------------------------------------------
  function connectPage(req, res, token = null) {
    const ctx = ctxOf(req);
    const tokenHtml = token
      ? stack([notice(ctx.t('ai.token.once'), { t: 'warning' }), endpointRow(ctx.t('ai.token.header'), `Authorization: Bearer ${token}`, ctx)])
      : stack([html`<p class="nx-muted">${ctx.t('ai.token.text')}</p>`, postForm('/dashboard/token', ctx, button(ctx.t('ai.token.create'), null, { variant: 'secondary', iconName: 'key' }))]);
    const social = notice(ctx.pick('در Social MCP (social.nabuxai.com) با همین حساب Nabux وارد شوید: بات‌های این‌جا خودکار پیوند می‌خورند و می‌توانید هم‌زمان با بقیهٔ شبکه‌ها در کانال پیش‌فرضشان منتشر کنید.',
      'Sign in to Social MCP (social.nabuxai.com) with the same Nabux account: these bots link automatically and you can publish to their default channels alongside every other network.'),
    { t: 'accent', title: ctx.pick('همراه با Social MCP', 'With Social MCP'), iconName: 'sparkles' });
    send(res, ctx, ctx.t('nav.connect'), appPage(ctx, { title: ctx.t('nav.connect'), active: 'connect',
      subtitle: ctx.pick('این آدرس را در کلاینت هوش مصنوعی خود اضافه کنید؛ ورود با حساب Nabux انجام می‌شود.', 'Add this endpoint to your AI client; it signs in with your Nabux account.'),
      body: stack([card(endpointRow(ctx.t('endpoint'), mcpUrl, ctx)), card(connectAi(ctx, { serverName: 'iran-messengers', mcpUrl, tokenHtml })), social]) }));
  }
  router.get('/dashboard/connect', requireLogin, (req, res) => connectPage(req, res));
  router.post('/dashboard/token', requireLogin, (req, res) => {
    if (!csrfOk(req, res)) return;
    log('panel', { action: 'personal_token', ok: true });
    connectPage(req, res, oauth.issuePersonalToken(req.owner.id));
  });

  router.get('/dashboard/tools', requireLogin, async (req, res) => {
    const ctx = ctxOf(req);
    const server = buildMcpServer({ ownerId: req.owner.id, store, accounts, messengers, version, panelUrl: `${config.baseUrl}/dashboard` });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const client = new Client({ name: 'panel', version });
    await client.connect(a);
    const tools = (await client.listTools()).tools.sort((x, y) => x.name.localeCompare(y.name));
    await client.close();
    send(res, ctx, ctx.t('nav.tools'), appPage(ctx, { title: ctx.t('nav.tools'), active: 'tools',
      subtitle: ctx.pick('ابزارهای هر پیام‌رسان وقتی ظاهر می‌شوند که باتی در آن وصل کرده باشید.', 'A messenger\'s tools appear once you connect a bot on it.'),
      body: card(toolsList(ctx, tools)) }));
  });

  router.get('/dashboard/settings', requireLogin, (req, res) => {
    const ctx = ctxOf(req);
    const o = req.owner;
    const conns = store.connectionsOf(o.id);
    const account = card(kvList([
      [ctx.pick('نام', 'Name'), o.name || '—'], [ctx.pick('ایمیل', 'Email'), o.email ? html`<span dir="ltr">${o.email}</span>` : '—'],
      [ctx.pick('اتصال‌های هوش مصنوعی', 'AI connections'), ctx.num(conns.length)]
    ]), { title: ctx.pick('حساب Nabux', 'Nabux account'), actions: button(ctx.t('user.manage'), `${config.nabuauth.url}/`, { variant: 'ghost', size: 'sm', trailing: 'external' }) });
    const danger = dangerZone(ctx, [
      [ctx.pick('قطع همهٔ دسترسی‌های هوش مصنوعی', 'Revoke all AI access'), ctx.pick('همهٔ کلاینت‌ها و توکن‌های شخصی باید دوباره وصل شوند.', 'Every client and personal token has to connect again.'),
        postForm('/dashboard/tokens/revoke', ctx, button(ctx.pick('قطع دسترسی', 'Revoke'), null, { variant: 'danger', size: 'sm' }), { confirm: ctx.pick('همهٔ دسترسی‌ها قطع شود؟', 'Revoke all access?') })],
      [ctx.t('user.signout'), ctx.pick('از این مرورگر خارج شوید.', 'Sign out of this browser.'),
        postForm('/auth/logout', ctx, button(ctx.t('user.signout'), null, { variant: 'secondary', size: 'sm', iconName: 'logout' }))]
    ]);
    send(res, ctx, ctx.t('nav.settings'), appPage(ctx, { title: ctx.t('nav.settings'), active: 'settings', toast: toastOf(ctx, req), body: stack([account, danger]) }));
  });

  router.post('/dashboard/tokens/revoke', requireLogin, (req, res) => {
    if (!csrfOk(req, res)) return;
    store.revokeOwnerTokens(req.owner.id);
    log('panel', { action: 'revoke_all', ok: true });
    res.redirect(303, '/dashboard/settings?done=revoked');
  });

  // ---- MCP consent ----------------------------------------------------------------------
  router.get('/oauth/consent/:txn', requireLogin, (req, res) => {
    const ctx = ctxOf(req);
    const t = oauth.transaction(req.params.txn);
    if (!t) {
      return send(res, ctx, ctx.t('auth.expired.title'), messagePage(ctx, { title: ctx.t('auth.expired.title'), message: ctx.t('auth.expired.text'), t: 'warning' }), 400);
    }
    const redirectHost = new URL(t.redirect_uri).host;
    const n = store.accountsOf(req.owner.id).length;
    const body = card(stack([
      html`<p>${ctx.pick(`«${t.client_name}» می‌خواهد به بات‌های پیام‌رسان شما (${ctx.num(n)} بات) دسترسی داشته باشد.`, `“${t.client_name}” wants to use your messenger bots (${n}).`)}</p>`,
      notice(ctx.pick('دستیار می‌تواند بخواند و پیش‌نمایش بگیرد. ارسال فقط به گفت‌وگوهای مجاز، با ارسال روشن و با تأیید صریح انجام می‌شود.',
        'The assistant can read and preview. It can send only to allowed chats, with sending on, and with an explicit confirm.'), { t: 'info' }),
      html`<p class="nx-muted">${ctx.pick('بازگشت به:', 'Returns to:')} <code dir="ltr">${redirectHost}</code></p>`,
      html`<form method="post" action="/oauth/consent/${req.params.txn}" class="nx-actions">${ctx.csrfField()}<button class="nx-btn nx-btn--primary" type="submit" name="decision" value="approve">${icon('check')}<span>${ctx.pick('اجازه بده', 'Allow')}</span></button><button class="nx-btn nx-btn--ghost" type="submit" name="decision" value="deny"><span>${ctx.pick('رد', 'Deny')}</span></button></form>`
    ]), { title: ctx.pick('اجازهٔ دسترسی', 'Allow access') });
    send(res, ctx, ctx.pick('اجازهٔ دسترسی', 'Allow access'), appPage(ctx, { title: ctx.pick('اجازهٔ دسترسی', 'Allow access'), body }));
  });

  router.post('/oauth/consent/:txn', requireLogin, (req, res) => {
    if (!csrfOk(req, res)) return;
    const url = oauth.finish(req.params.txn, req.owner.id, req.body.decision === 'approve');
    if (!url) return res.redirect(303, '/dashboard');
    log('oauth', { action: 'consent', approved: req.body.decision === 'approve' });
    res.redirect(302, url);
  });

  return router;
}
