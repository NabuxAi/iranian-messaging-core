// Test harness: the gateway on an ephemeral port with every outside party
// faked: the messenger bot APIs, media downloads and NabuAuth.
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { setLogSink } from '../src/log.mjs';
import { Store } from '../src/store.mjs';

export const SECRET = 'test-secret-key-0123456789abcdefghijklmnopqrstuvwxyz';
export const INTERNAL = 'internal-token-for-tests';

// Every messenger API answers getMe/sendMessage/sendPhoto/getChat the
// Telegram way (Bale, Soroush Plus), or in its own envelope.
// Pending updates of the Telegram-like bots, oldest first, as getUpdates returns them.
export const FAKE_UPDATES = [
  { update_id: 100, message: { message_id: 1, date: 1767225600, chat: { id: 555, type: 'private', first_name: 'Sara' },
    from: { id: 555, first_name: 'Sara' }, text: 'سلام، قیمت چند است؟' } },
  { update_id: 101, channel_post: { message_id: 9, date: 1767225660, chat: { id: -100, type: 'channel', title: 'کانال نابکس' },
    text: 'پست کانال' } },
  { update_id: 102, message: { message_id: 2, date: 1767225720, chat: { id: 555, type: 'private', first_name: 'Sara' },
    from: { id: 555, first_name: 'Sara' }, text: 'ممنون' } }
];

export function fakeMessengers({ rejectTokens = [] } = {}) {
  const calls = [];
  const apiFetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = u.pathname.split('/').pop();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ host: u.hostname, path: u.pathname, method, body, headers: init.headers || {} });
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
    if (rejectTokens.some(t => u.pathname.includes(t) || init.headers?.token === t)) {
      return reply(401, { ok: false, description: 'Unauthorized', status: 'INVALID_ACCESS' });
    }
    if (u.hostname === 'botapi.rubika.ir') {
      if (method === 'getMe') return reply(200, { status: 'OK', data: { bot: { bot_id: 'b77', username: 'rubibot', bot_title: 'Rubi' } } });
      if (method === 'sendMessage') return reply(200, { status: 'OK', data: { message_id: '501' } });
      return reply(200, { status: 'OK', data: {} });
    }
    if (u.hostname === 'api.gap.im') return reply(200, { id: 900 });
    if (u.hostname === 'eitaayar.ir') {
      if (method === 'getMe') return reply(200, { ok: true, result: { id: 5, username: 'sender', first_name: 'Eitaayar' } });
      return reply(200, { ok: true, result: { message_id: 61 } });
    }
    if (method === 'getMe') return reply(200, { ok: true, result: { id: 42, username: 'nabu_test_bot', first_name: 'Nabu <b>Bot</b>' } });
    if (method === 'getChat') return reply(200, { ok: true, result: { id: -100, type: 'channel', title: 'کانال نابکس', username: 'nabuxchan' } });
    if (method === 'getUpdates') return reply(200, { ok: true, result: FAKE_UPDATES.slice(0, body?.limit || 100) });
    if (method === 'sendMessage') return reply(200, { ok: true, result: { message_id: 7 } });
    if (method === 'sendPhoto' || method === 'sendVideo' || method === 'sendDocument') return reply(200, { ok: true, result: { message_id: 8 } });
    return reply(200, { ok: true, result: true });
  };
  return { apiFetch, calls };
}

export function fakeMedia() {
  const fetched = [];
  const safeGet = async url => {
    fetched.push(String(url));
    if (!String(url).startsWith('https://')) throw new Error('MEDIA_URL_MUST_BE_HTTPS');
    const bytes = Buffer.from('fake-jpeg-bytes');
    return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => bytes };
  };
  return { safeGet, fetched };
}

export function fakeNabuAuth(profile) {
  const seen = [];
  const authFetch = async (url, init = {}) => {
    const u = new URL(String(url));
    seen.push({ path: u.pathname, body: String(init.body || '') });
    if (u.pathname === '/oauth/token') return { ok: true, status: 200, json: async () => ({ access_token: 'nabu-access', token_type: 'Bearer' }) };
    if (u.pathname === '/api/v1/user') return { ok: true, status: 200, json: async () => profile() };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { authFetch, seen };
}

export async function startGateway({ env = {}, profile = () => ({ sub: 'user-1', email: 'Owner@Example.com', email_verified: true, name: 'Hussein' }), messengerOpts } = {}) {
  const lines = [];
  setLogSink(line => lines.push(line));
  const config = loadConfig({
    PUBLIC_BASE_URL: 'http://localhost', APP_SECRET_KEY: SECRET, INTERNAL_SERVICE_TOKEN: INTERNAL,
    NABUAUTH_CLIENT_ID: 'iran-mcp', NABUAUTH_CLIENT_SECRET: 'nabu-client-secret', NABUAUTH_URL: 'https://auth.test', ...env
  });
  const messengers = fakeMessengers(messengerOpts);
  const media = fakeMedia();
  const nabu = fakeNabuAuth(profile);
  const built = createApp(config, { store: new Store(null), apiFetch: messengers.apiFetch, safeGet: media.safeGet, authFetch: nabu.authFetch });
  const server = await new Promise(resolve => { const s = built.app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...built, config, base, server, messengers, media, nabu, lines, close: () => new Promise(r => server.close(r)) };
}

// A tiny browser: keeps cookies, never follows redirects.
export function browser(base) {
  const jar = new Map();
  async function go(path, { method = 'GET', form = null, headers = {} } = {}) {
    const res = await fetch(new URL(path, base), {
      method, redirect: 'manual',
      headers: { Accept: 'text/html', Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (!v || attrs.some(a => /expires=thu, 01 jan 1970/i.test(a))) jar.delete(k); else jar.set(k, v);
    }
    return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
  }
  return { go, jar };
}

export const csrfOf = page => (page.match(/name="csrf" value="([^"]+)"/) || [])[1];

// Signs in through the faked NabuAuth and returns the browser.
export async function signIn(gw) {
  const b = browser(gw.base);
  const start = await b.go('/auth/nabu/login?next=/dashboard');
  const state = new URL(start.location).searchParams.get('state');
  const back = await b.go(`/auth/nabu/callback?code=nabu-code&state=${state}`);
  if (back.status !== 303 || back.location !== '/dashboard') throw new Error(`sign-in failed: ${back.status} ${back.text.slice(0, 200)}`);
  return b;
}

export const internal = (gw, path, { method = 'GET', body, token = INTERNAL } = {}) =>
  fetch(gw.base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, json: await r.json() }));
