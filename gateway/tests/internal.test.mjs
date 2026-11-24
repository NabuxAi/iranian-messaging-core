import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERNAL, internal, startGateway } from './helpers.mjs';

const owner = { sub: 'user-1', email: 'owner@example.com', email_verified: true, name: 'Hussein' };
const BALE_TOKEN = '123456789:BaleTokenSecretValue';

async function connectBale(gw, fields = { token: BALE_TOKEN, default_chat_id: '@nabuxchan' }, who = owner) {
  return internal(gw, '/internal/v1/connect/start', { method: 'POST', body: { owner: who, method: 'bot_token', messenger: 'bale', fields } });
}

test('the internal API is hidden without its token and refuses a wrong one', async () => {
  const off = await startGateway({ env: { INTERNAL_SERVICE_TOKEN: '' } });
  try {
    assert.equal((await internal(off, '/internal/v1/owners/accounts?sub=x')).status, 404);
  } finally { await off.close(); }
  const gw = await startGateway();
  try {
    assert.equal((await internal(gw, '/internal/v1/owners/accounts?sub=x', { token: 'wrong' })).status, 401);
    assert.equal((await internal(gw, '/internal/v1/owners/accounts?sub=x', { token: `${INTERNAL}x` })).status, 401);
    const r = await fetch(`${gw.base}/internal/v1/connect/methods`);
    assert.equal(r.status, 401);
    assert.equal((await internal(gw, '/internal/v1/owners/accounts')).status, 400);
  } finally { await gw.close(); }
});

test('connect methods list one official bot_token method per messenger', async () => {
  const gw = await startGateway();
  try {
    const { status, json } = await internal(gw, '/internal/v1/connect/methods');
    assert.equal(status, 200);
    assert.equal(json.provider, 'iran');
    assert.deepEqual(json.methods.map(m => m.messenger), ['bale', 'eitaa', 'rubika', 'soroushplus', 'gap']);
    for (const m of json.methods) {
      assert.equal(m.id, 'bot_token');
      assert.equal(m.mode, 'official');
      assert.ok(m.label.fa && m.label.en && m.help.fa && m.help.en);
      assert.deepEqual(m.fields.map(f => f.name), ['token', 'default_chat_id']);
      assert.equal(m.fields[0].type, 'password');
    }
    const one = await internal(gw, '/internal/v1/connect/methods?messenger=rubika');
    assert.deepEqual(one.json.methods.map(m => m.key), ['rubika.bot_token']);
  } finally { await gw.close(); }
});

test('connecting a bot from Social creates the owner and the account, found by sub or verified email', async () => {
  const gw = await startGateway();
  try {
    const r = await connectBale(gw);
    assert.equal(r.json.status, 'done', JSON.stringify(r.json));
    const acc = r.json.account;
    assert.match(acc.account_key, /^irm_bale_[a-z0-9]{32}$/);
    assert.equal(acc.messenger, 'bale');
    assert.equal(acc.kind, 'bot');
    assert.equal(acc.mode, 'official');
    assert.equal(acc.label, 'کانال نابکس');

    const bySub = await internal(gw, '/internal/v1/owners/accounts?sub=user-1');
    assert.deepEqual(bySub.json.accounts.map(a => a.account_key), [acc.account_key]);
    assert.equal(bySub.json.accounts[0].messenger, 'bale');
    assert.equal(bySub.json.accounts[0].status, 'connected');
    assert.equal(bySub.json.accounts[0].publish_ready, true);
    const byEmail = await internal(gw, '/internal/v1/owners/accounts?sub=someone-else&email=OWNER@example.com');
    assert.equal(byEmail.json.accounts.length, 1);
    assert.equal((await internal(gw, '/internal/v1/owners/accounts?sub=stranger')).json.accounts.length, 0);

    const one = await internal(gw, `/internal/v1/accounts/${acc.account_key}`);
    assert.equal(one.status, 200);
    assert.equal(one.json.account.default_chat, '@nabuxchan');
    assert.deepEqual(one.json.account.allowed_chats, ['@nabuxchan']);
    assert.equal((await internal(gw, '/internal/v1/accounts/irm_bale_nope')).status, 404);

    // The token is sealed at rest: neither the store nor any log line holds it.
    const stored = JSON.stringify(gw.store.data);
    assert.ok(!stored.includes('BaleTokenSecretValue'));
    assert.ok(!gw.lines.join('\n').includes('BaleTokenSecretValue'));
    assert.ok(!gw.lines.join('\n').includes('user-1'));
    assert.ok(!gw.lines.join('\n').includes('owner@example.com'));
  } finally { await gw.close(); }
});

test('an unverified email never matches, and a new sub with a verified email adopts that owner', async () => {
  const gw = await startGateway();
  try {
    await connectBale(gw, { token: BALE_TOKEN }, { sub: 'u-a', email: 'x@example.com', email_verified: false });
    assert.equal((await internal(gw, '/internal/v1/owners/accounts?email=x@example.com')).json.accounts.length, 0);
    await connectBale(gw, { token: BALE_TOKEN }, { sub: 'u-b', email: 'y@example.com', email_verified: true });
    await connectBale(gw, { token: '987654321:OtherBotToken' }, { sub: 'u-c', email: 'y@example.com', email_verified: true });
    assert.equal(gw.store.ownerBySub('u-b'), gw.store.ownerBySub('u-c'));
    assert.equal((await internal(gw, '/internal/v1/owners/accounts?sub=u-b')).json.accounts.length, 1, 'same bot id updates the account');
  } finally { await gw.close(); }
});

test('a rejected token and a malformed token come back as errors Social can show', async () => {
  const gw = await startGateway({ messengerOpts: { rejectTokens: ['111111111:Revoked'] } });
  try {
    const bad = await connectBale(gw, { token: '111111111:Revoked' });
    assert.equal(bad.json.status, 'error');
    assert.equal(bad.json.code, 'BOT_TOKEN_REJECTED');
    assert.ok(bad.json.error.fa && bad.json.error.en);
    const odd = await connectBale(gw, { token: 'abc/../x?y' });
    assert.equal(odd.json.code, 'INVALID_BOT_TOKEN');
    const unknown = await internal(gw, '/internal/v1/connect/start', { method: 'POST', body: { owner, method: 'bot_token', messenger: 'icq', fields: {} } });
    assert.equal(unknown.status, 400);
    assert.equal((await internal(gw, '/internal/v1/connect/start', { method: 'POST', body: { method: 'bot_token', messenger: 'bale' } })).status, 400);
    assert.equal((await internal(gw, '/internal/v1/connect/abc')).status, 404);
  } finally { await gw.close(); }
});

test('Gap has no getMe: the bot connects unverified; the dotted method key works too', async () => {
  const gw = await startGateway();
  try {
    const r = await internal(gw, '/internal/v1/connect/start', { method: 'POST',
      body: { owner, method: 'gap.bot_token', fields: { token: 'a1b2c3d4e5f6a7b8c9d0', default_chat_id: '12345' } } });
    assert.equal(r.json.status, 'done');
    assert.equal(r.json.account.messenger, 'gap');
    assert.equal(gw.messengers.calls.length, 0, 'nothing was called to connect it');
    const view = gw.accounts.view(gw.store.account(r.json.account.account_key));
    assert.equal(view.verified, false);
  } finally { await gw.close(); }
});

test('publishing goes to the default chat and keeps the account locks', async () => {
  const gw = await startGateway();
  try {
    const key = (await connectBale(gw)).json.account.account_key;
    const pub = body => internal(gw, `/internal/v1/accounts/${key}/publish`, { method: 'POST', body });

    const text = await pub({ kind: 'text', text: 'سلام', title: 'خبر', link: 'https://nabuxai.com' });
    assert.equal(text.status, 200, JSON.stringify(text.json));
    assert.equal(text.json.remote_id, '7');
    assert.equal(text.json.messenger, 'bale');
    const sent = gw.messengers.calls.find(c => c.method === 'sendMessage');
    assert.equal(sent.host, 'tapi.bale.ai');
    assert.equal(sent.body.chat_id, '@nabuxchan');
    assert.equal(sent.body.text, 'خبر\n\nسلام\n\nhttps://nabuxai.com');

    const image = await internal(gw, `/internal/v1/accounts/${key}/publish/image`, { method: 'POST',
      body: { image_url: 'https://cdn.example.com/a.jpg', caption: 'عکس' } });
    assert.equal(image.status, 200, JSON.stringify(image.json));
    assert.deepEqual(gw.media.fetched, ['https://cdn.example.com/a.jpg']);
    const photo = gw.messengers.calls.find(c => c.method === 'sendPhoto');
    assert.equal(photo.body.get('chat_id'), '@nabuxchan');
    assert.equal(photo.body.get('caption'), 'عکس');

    assert.equal((await pub({ kind: 'carousel' })).json.detail, 'unsupported_publish_kind');
    assert.equal((await pub({ kind: 'image' })).json.detail, 'media_url_required');

    // Sending switched off in the panel: Social cannot publish either.
    const account = gw.store.account(key);
    await gw.accounts.updateSettings(account, { sendEnabled: false });
    const off = await pub({ kind: 'text', text: 'x' });
    assert.equal(off.status, 400);
    assert.match(off.json.detail, /^SEND_DISABLED_BY_DEFAULT/);
    await gw.accounts.updateSettings(account, { sendEnabled: true, allowedChats: '' });
    assert.match((await pub({ kind: 'text', text: 'x' })).json.detail, /^RECIPIENT_NOT_ALLOWLISTED/);
    await gw.accounts.updateSettings(account, { defaultChat: '' });
    assert.match((await pub({ kind: 'text', text: 'x' })).json.detail, /^DEFAULT_CHAT_NOT_SET/);
    assert.ok(!gw.lines.join('\n').includes('سلام'), 'message bodies are not logged');
  } finally { await gw.close(); }
});

test('a bot connected without a default chat cannot publish until the owner picks one', async () => {
  const gw = await startGateway();
  try {
    const key = (await connectBale(gw, { token: BALE_TOKEN })).json.account.account_key;
    const r = await internal(gw, `/internal/v1/accounts/${key}/publish/text`, { method: 'POST', body: { text: 'x' } });
    assert.equal(r.status, 400);
    assert.equal((await internal(gw, `/internal/v1/accounts/${key}`)).json.account.publish_ready, false);
  } finally { await gw.close(); }
});

test('a provider failure is a 502 with a short reason and no token', async () => {
  const gw = await startGateway({ messengerOpts: { rejectTokens: ['Revoked'] } });
  try {
    const key = (await connectBale(gw)).json.account.account_key;
    gw.store.updateAccount(key, { token_sealed: gw.keys.seal('123456789:RevokedLater') });
    const r = await internal(gw, `/internal/v1/accounts/${key}/publish`, { method: 'POST', body: { kind: 'text', text: 'x' } });
    assert.equal(r.status, 502);
    assert.equal(r.json.detail, 'PROVIDER_HTTP_ERROR_401');
    assert.equal(r.json.provider_detail, 'Unauthorized');
    assert.ok(!JSON.stringify(r.json).includes('RevokedLater'));
    await gw.accounts.check(gw.store.account(key));
    assert.equal(gw.store.account(key).status, 'expired');
  } finally { await gw.close(); }
});
