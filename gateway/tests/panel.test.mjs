import test from 'node:test';
import assert from 'node:assert/strict';
import { browser, csrfOf, signIn, startGateway } from './helpers.mjs';

test('a signed-out visit tries a silent Nabux sign-in once, then shows the Persian landing page', async () => {
  const gw = await startGateway();
  try {
    const b = browser(gw.base);
    const first = await b.go('/');
    assert.equal(first.status, 302);
    assert.match(first.location, /^\/auth\/nabu\/login\?prompt=none/);
    const login = await b.go(first.location);
    const to = new URL(login.location);
    assert.equal(to.origin + to.pathname, 'https://auth.test/oauth/authorize');
    assert.equal(to.searchParams.get('client_id'), 'iran-mcp');
    assert.equal(to.searchParams.get('prompt'), 'none');
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(to.searchParams.get('redirect_uri'), 'http://localhost/auth/nabu/callback');
    const none = await b.go(`/auth/nabu/callback?error=login_required&state=${to.searchParams.get('state')}`);
    assert.equal(none.location, '/?sso=0');
    const landing = await b.go('/?sso=0');
    assert.equal(landing.status, 200);
    assert.match(landing.text, /<html lang="fa" dir="rtl"/);
    assert.ok(landing.text.includes('ادامه با Nabux'));
    for (const name of ['بله', 'ایتا', 'روبیکا', 'سروش پلاس', 'گپ']) assert.ok(landing.text.includes(name), name);
    assert.ok(landing.text.includes('/static/console/console.css?v='));
    const css = await fetch(`${gw.base}/static/console/console.css`);
    assert.equal(css.status, 200);
    assert.equal((await fetch(`${gw.base}/static/console/fonts/vazirmatn-arabic.woff2`)).status, 200);
    assert.equal((await fetch(`${gw.base}/static/console/../package.json`)).status, 404);
    const en = await b.go('/?sso=0&lang=en');
    assert.match(en.text, /<html lang="en" dir="ltr"/);
  } finally { await gw.close(); }
});

test('a forged or replayed callback does not sign anyone in', async () => {
  const gw = await startGateway();
  try {
    const b = browser(gw.base);
    const r = await b.go('/auth/nabu/callback?code=x&state=forged');
    assert.equal(r.status, 200);
    assert.ok(!b.jar.has('irm_session'));
    const dash = await b.go('/dashboard');
    assert.equal(dash.status, 302);
    assert.match(dash.location, /^\/auth\/nabu\/login\?next=%2Fdashboard/);
    const s = await signIn(gw);
    const exchanged = gw.nabu.seen.find(x => x.path === '/oauth/token').body;
    assert.match(exchanged, /client_secret=nabu-client-secret/);
    assert.match(exchanged, /code_verifier=/);
    assert.ok(s.jar.has('irm_session'));
    assert.ok(!gw.lines.join('\n').includes('nabu-code'), 'the code is never logged');
  } finally { await gw.close(); }
});

test('the owner adds a bot, sets the default channel and allowed chats, and removes it', async () => {
  const gw = await startGateway();
  try {
    const b = await signIn(gw);
    const dash = await b.go('/dashboard');
    assert.equal(dash.status, 200);
    assert.ok(dash.text.includes('هنوز باتی وصل نشده'));
    const form = await b.go('/dashboard/accounts/new?messenger=bale');
    const csrf = csrfOf(form.text);
    assert.ok(csrf);

    const bad = await b.go('/dashboard/accounts/new', { method: 'POST', form: { csrf, messenger: 'bale', token: 'short' } });
    assert.equal(bad.status, 400);
    assert.ok(bad.text.includes('این توکن معتبر به نظر نمی‌رسد'));
    assert.ok(!bad.text.includes('value="short"'), 'a token is never written back into the page');

    const added = await b.go('/dashboard/accounts/new', { method: 'POST',
      form: { csrf, messenger: 'bale', token: '123456789:BaleTokenSecretValue', default_chat: '@nabuxchan', allow_send: '1' } });
    assert.equal(added.status, 303);
    const key = added.location.match(/\/dashboard\/accounts\/(irm_bale_[a-z0-9]{32})/)[1];
    const page = await b.go(added.location);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('کانال نابکس'));
    assert.ok(!page.text.includes('BaleTokenSecretValue'));
    assert.ok(!page.text.includes('<b>Bot</b>'), 'names from the messenger are escaped');
    const account = gw.store.account(key);
    assert.equal(account.send_enabled, true);
    assert.deepEqual(account.allowed_chats, ['@nabuxchan']);

    const saved = await b.go(`/dashboard/accounts/${key}/settings`, { method: 'POST',
      form: { csrf: csrfOf(page.text), default_chat: '@other', allowed_chats: '@other\n@nabuxchan\n@other' } });
    assert.equal(saved.status, 303);
    assert.deepEqual(gw.store.account(key).allowed_chats, ['@other', '@nabuxchan']);
    assert.equal(gw.store.account(key).send_enabled, false, 'an unticked box turns sending off');
    assert.equal(gw.store.account(key).default_chat, '@other');

    const noCsrf = await b.go(`/dashboard/accounts/${key}/delete`, { method: 'POST', form: {} });
    assert.equal(noCsrf.location, '/dashboard');
    assert.ok(gw.store.account(key));

    // Someone else's browser cannot open or change it.
    const stranger = await startOther(gw);
    const peek = await stranger.go(`/dashboard/accounts/${key}`);
    assert.equal(peek.location, '/dashboard/accounts');

    const list = await b.go('/dashboard/accounts');
    assert.ok(list.text.includes('@other'));
    const tools = await b.go('/dashboard/tools');
    assert.ok(tools.text.includes('bale_bot_send_message'));
    const connect = await b.go('/dashboard/connect');
    assert.ok(connect.text.includes('http://localhost/mcp'));
    const tok = await b.go('/dashboard/token', { method: 'POST', form: { csrf: csrfOf(connect.text) } });
    assert.match(tok.text, /Authorization: Bearer irm_pt_/);

    const removed = await b.go(`/dashboard/accounts/${key}/delete`, { method: 'POST', form: { csrf: csrfOf(page.text) } });
    assert.equal(removed.location, '/dashboard/accounts?done=removed');
    assert.equal(gw.store.account(key), null);
    assert.ok(!gw.lines.join('\n').includes('BaleTokenSecretValue'));
  } finally { await gw.close(); }
});

// A second person's session, signed with the gateway's own key.
async function startOther(gw) {
  const { createKeys } = await import('../src/crypto.mjs');
  const owner = gw.store.ensureOwner({ sub: 'user-9' });
  const b = browser(gw.base);
  const value = createKeys(gw.config.secretKey).sign({ oid: owner.id, n: 'x', exp: Math.floor(Date.now() / 1000) + 600 }, 'session');
  b.jar.set('irm_session', encodeURIComponent(value));
  return b;
}

test('sign out clears the session and a tampered session cookie is ignored', async () => {
  const gw = await startGateway();
  try {
    const b = await signIn(gw);
    const page = await b.go('/dashboard/settings');
    assert.equal(page.status, 200);
    const tampered = browser(gw.base);
    tampered.jar.set('irm_session', b.jar.get('irm_session').replace(/.$/, c => (c === 'A' ? 'B' : 'A')));
    assert.equal((await tampered.go('/dashboard')).status, 302);
    const out = await b.go('/auth/logout', { method: 'POST', form: { csrf: csrfOf(page.text) } });
    assert.match(out.location, /^https:\/\/auth\.test\/oauth\/logout\?post_logout_redirect_uri=/);
    assert.ok(!b.jar.has('irm_session'));
  } finally { await gw.close(); }
});
