import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { csrfOf, internal, signIn, startGateway } from './helpers.mjs';

const REDIRECT = 'https://claude.example/api/mcp/auth_callback';

async function rpc(gw, token, method, params = {}, id = 1) {
  const r = await fetch(`${gw.base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  return { status: r.status, json: r.status === 200 ? await r.json() : null, headers: r.headers };
}

const callTool = async (gw, token, name, args) => {
  const r = await rpc(gw, token, 'tools/call', { name, arguments: args });
  const res = r.json.result;
  return { isError: Boolean(res.isError), text: res.content[0].text };
};

// The whole connector flow: register, authorize, consent, token.
async function connectClient(gw, b) {
  const reg = await fetch(`${gw.base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) }).then(r => r.json());
  assert.ok(reg.client_id && reg.client_secret);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', state: 'st-1', resource: `${gw.config.baseUrl}/mcp` });
  const auth = await b.go(`/authorize?${q}`);
  assert.equal(auth.status, 302);
  assert.match(auth.location, /^\/oauth\/consent\//);
  const consent = await b.go(auth.location);
  assert.equal(consent.status, 200);
  assert.ok(consent.text.includes('Claude'));
  const approved = await b.go(auth.location, { method: 'POST', form: { csrf: csrfOf(consent.text), decision: 'approve' } });
  assert.equal(approved.status, 302);
  const back = new URL(approved.location);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'st-1');
  const code = back.searchParams.get('code');
  const tokenRes = await fetch(`${gw.base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT,
      client_id: reg.client_id, client_secret: reg.client_secret }) });
  const tokens = await tokenRes.json();
  assert.equal(tokenRes.status, 200, JSON.stringify(tokens));
  // The code works once.
  const again = await fetch(`${gw.base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT,
      client_id: reg.client_id, client_secret: reg.client_secret }) });
  assert.equal(again.status, 400);
  return { reg, tokens };
}

test('/mcp needs a token and points clients at the OAuth metadata', async () => {
  const gw = await startGateway();
  try {
    const r = await rpc(gw, 'nope', 'tools/list');
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource\/mcp"/);
    const meta = await fetch(`${gw.base}/.well-known/oauth-authorization-server`).then(x => x.json());
    assert.equal(meta.registration_endpoint, 'http://localhost/register');
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
    assert.equal((await fetch(`${gw.base}/mcp`)).status, 401);
  } finally { await gw.close(); }
});

test('the consent page sends a signed-out person to Nabux first and can be denied', async () => {
  const gw = await startGateway();
  try {
    const b = await signIn(gw);
    const reg = await fetch(`${gw.base}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Evil <script>', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) }).then(r => r.json());
    const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256', state: 's' });
    const auth = await b.go(`/authorize?${q}`);
    const anon = await fetch(gw.base + auth.location, { redirect: 'manual' });
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get('location'), /^\/auth\/nabu\/login\?next=/);
    const consent = await b.go(auth.location);
    assert.ok(!consent.text.includes('<script>'), 'client names are escaped');
    const noCsrf = await b.go(auth.location, { method: 'POST', form: { decision: 'approve' } });
    assert.equal(noCsrf.location, '/dashboard');
    const denied = await b.go(auth.location, { method: 'POST', form: { csrf: csrfOf(consent.text), decision: 'deny' } });
    assert.equal(new URL(denied.location).searchParams.get('error'), 'access_denied');
  } finally { await gw.close(); }
});

test('an AI client signs in, sees the owner\'s bots and writes only through the locks', async () => {
  const gw = await startGateway();
  try {
    const b = await signIn(gw);
    const { reg, tokens } = await connectClient(gw, b);

    const init = await rpc(gw, tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(init.status, 200);
    assert.equal(init.json.result.serverInfo.name, 'iran-messengers');

    let names = (await rpc(gw, tokens.access_token, 'tools/list')).json.result.tools.map(t => t.name);
    assert.deepEqual(names, ['iran_accounts'], 'no messenger tools before a bot is connected');

    // Same owner connects a Bale bot from Social (no default chat, so nothing allowed yet) and a Gap bot.
    const owner = { sub: 'user-1', email: 'owner@example.com', email_verified: true };
    const bale = (await internal(gw, '/internal/v1/connect/start', { method: 'POST',
      body: { owner, method: 'bot_token', messenger: 'bale', fields: { token: '123456789:BaleTokenSecretValue' } } })).json.account.account_key;
    await internal(gw, '/internal/v1/connect/start', { method: 'POST',
      body: { owner, method: 'bot_token', messenger: 'gap', fields: { token: 'a1b2c3d4e5f6a7b8c9d0' } } });

    names = (await rpc(gw, tokens.access_token, 'tools/list')).json.result.tools.map(t => t.name);
    for (const n of ['bale_bot_send_message', 'bale_bot_get_updates', 'bale_bot_get_me', 'gap_bot_send_message', 'gap_bot_delete_message']) assert.ok(names.includes(n), n);
    assert.ok(!names.includes('gap_bot_get_me'), 'Gap has no getMe');
    assert.ok(!names.some(n => n.startsWith('rubika_')), 'no Rubika bot, no Rubika tools');

    const listed = JSON.parse((await callTool(gw, tokens.access_token, 'iran_accounts', {})).text);
    assert.equal(listed.accounts.length, 2);
    assert.ok(!JSON.stringify(listed).includes('BaleTokenSecretValue'));

    const send = args => callTool(gw, tokens.access_token, 'bale_bot_send_message', { text: 'hi', ...args });
    assert.match((await send({ chatId: '@x', confirm: false })).text, /EXPLICIT_CONFIRMATION_REQUIRED/);
    assert.match((await send({ chatId: '@x', confirm: true })).text, /RECIPIENT_NOT_ALLOWLISTED_ADD_IT_TO_THE_ACCOUNT_ALLOWED_CHATS/);
    assert.match((await send({ confirm: true })).text, /CHAT_ID_REQUIRED_NO_DEFAULT_CHAT_SET/);
    await gw.accounts.updateSettings(gw.store.account(bale), { allowedChats: '@x', defaultChat: '@x' });
    assert.match((await send({ chatId: '@x', confirm: true })).text, /SEND_DISABLED_BY_DEFAULT_TURN_ON_SENDING_FOR_THE_ACCOUNT/);
    await gw.accounts.updateSettings(gw.store.account(bale), { sendEnabled: true });
    const ok = await send({ confirm: true });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(JSON.parse(ok.text).messageId, '7');
    assert.equal(gw.messengers.calls.at(-1).body.chat_id, '@x');

    // send_file only takes URLs, fetched through the guarded downloader.
    const file = await callTool(gw, tokens.access_token, 'bale_bot_send_file', { fileUrl: 'https://cdn.example.com/a.jpg', kind: 'photo', confirm: true });
    assert.equal(file.isError, false, file.text);
    assert.deepEqual(gw.media.fetched, ['https://cdn.example.com/a.jpg']);

    // Refresh rotates the pair; the old access token dies with it.
    const refreshed = await fetch(`${gw.base}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id, client_secret: reg.client_secret }) })
      .then(r => r.json());
    assert.ok(refreshed.access_token && refreshed.access_token !== tokens.access_token);
    assert.equal((await rpc(gw, tokens.access_token, 'tools/list')).status, 401);
    assert.equal((await rpc(gw, refreshed.access_token, 'tools/list')).status, 200);

    // Another owner's token never sees these bots.
    gw.store.ensureOwner({ sub: 'user-2' });
    const other = gw.oauth.issuePersonalToken(gw.store.ownerBySub('user-2').id);
    assert.deepEqual((await rpc(gw, other, 'tools/list')).json.result.tools.map(t => t.name), ['iran_accounts']);
    assert.equal(JSON.parse((await callTool(gw, other, 'iran_accounts', {})).text).accounts.length, 0);

    // Revoking everything from the panel ends access.
    gw.store.revokeOwnerTokens(gw.store.ownerBySub('user-1').id);
    assert.equal((await rpc(gw, refreshed.access_token, 'tools/list')).status, 401);
  } finally { await gw.close(); }
});

test('with two bots on one messenger the account must be named', async () => {
  const gw = await startGateway();
  try {
    const owner = gw.store.ensureOwner({ sub: 'user-1' });
    const a = (await gw.accounts.addBot(owner.id, { messenger: 'rubika', token: 'RubikaTokenOne0000' })).account;
    // The fake answers the same bot id; make the second one a different bot.
    gw.store.insertAccount({ ...a, key: 'irm_rubika_second00000000000000000000000', bot_id: 'other', username: 'second_bot' });
    const token = gw.oauth.issuePersonalToken(owner.id);
    const r = await callTool(gw, token, 'rubika_bot_get_me', {});
    assert.match(r.text, /ACCOUNT_REQUIRED_ONE_OF/);
    const named = await callTool(gw, token, 'rubika_bot_get_me', { account: '@second_bot' });
    assert.equal(named.isError, false, named.text);
  } finally { await gw.close(); }
});
