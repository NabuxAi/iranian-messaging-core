// Managing one account from Social (manage contract v1): settings, remove,
// send and recent incoming messages, owner-scoped by the NabuAuth sub, with
// every messenger API faked (tests/helpers.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { internal, startGateway } from './helpers.mjs';

const owner = { sub: 'user-1', email: 'owner@example.com', email_verified: true, name: 'Hussein' };
const stranger = { sub: 'user-2', email: 'other@example.com', email_verified: true };
const BALE_TOKEN = '123456789:BaleTokenSecretValue';

async function connect(gw, { messenger = 'bale', fields = { token: BALE_TOKEN, default_chat_id: '@nabuxchan' }, who = owner } = {}) {
  const r = await internal(gw, '/internal/v1/connect/start', { method: 'POST', body: { owner: who, method: 'bot_token', messenger, fields } });
  assert.equal(r.json.status, 'done', JSON.stringify(r.json));
  return r.json.account.account_key;
}
const q = (who = owner) => `sub=${encodeURIComponent(who.sub)}${who.email ? `&email=${encodeURIComponent(who.email)}` : ''}`;
const ownerOf = (who = owner) => ({ sub: who.sub, email: who.email });

test('the gateway says what Social may manage, and discovery marks accounts as manageable', async () => {
  const gw = await startGateway();
  try {
    const caps = await internal(gw, '/internal/v1/manage');
    assert.equal(caps.status, 200);
    assert.equal(caps.json.version, 1);
    assert.deepEqual(caps.json.routes, { settings: true, remove: true, send: true, updates: true });
    assert.ok(caps.json.send_kinds.includes('photo') && caps.json.send_kinds.includes('document'));
    assert.equal((await internal(gw, '/internal/v1/manage', { token: 'wrong' })).status, 401);
    const key = await connect(gw);
    const found = await internal(gw, `/internal/v1/owners/accounts?${q()}`);
    assert.equal(found.json.accounts[0].account_key, key);
    assert.equal(found.json.accounts[0].manage, true);
  } finally { await gw.close(); }
});

test('settings are read and changed only by the owner (sub or verified email), others get 404', async () => {
  const gw = await startGateway();
  try {
    const key = await connect(gw);
    await connect(gw, { messenger: 'soroushplus', fields: { token: '987654321:StrangerBot' }, who: stranger });
    const read = await internal(gw, `/internal/v1/accounts/${key}/settings?${q()}`);
    assert.equal(read.status, 200, JSON.stringify(read.json));
    const s = read.json.account;
    assert.equal(s.account_key, key);
    assert.equal(s.messenger, 'bale');
    assert.deepEqual(s.messenger_label, { fa: 'بله', en: 'Bale' });
    assert.equal(s.default_chat, '@nabuxchan');
    assert.deepEqual(s.allowed_chats, ['@nabuxchan']);
    assert.equal(s.send_enabled, true);
    assert.equal(s.label, 'کانال نابکس');
    assert.deepEqual(s.can, { send_text: true, send_file: true, read_updates: true });
    assert.ok(!JSON.stringify(read.json).includes('BaleTokenSecretValue'), 'the token never leaves the gateway');

    // Found through the verified email of a second Nabux sub, like discovery.
    assert.equal((await internal(gw, `/internal/v1/accounts/${key}/settings?sub=new-sub&email=OWNER@example.com`)).status, 200);
    // Not the owner, no sub, unknown key: nothing is revealed.
    assert.equal((await internal(gw, `/internal/v1/accounts/${key}/settings?${q(stranger)}`)).status, 404);
    assert.equal((await internal(gw, `/internal/v1/accounts/${key}/settings?sub=stranger`)).json.detail, 'account_not_found');
    assert.equal((await internal(gw, `/internal/v1/accounts/${key}/settings`)).status, 400);
    assert.equal((await internal(gw, `/internal/v1/accounts/irm_bale_nope/settings?${q()}`)).status, 404);
    const theirs = await internal(gw, `/internal/v1/accounts/${key}/settings`, { method: 'POST', body: { owner: ownerOf(stranger), send_enabled: false } });
    assert.equal(theirs.status, 404);
    assert.equal(gw.store.account(key).send_enabled, true, 'a stranger changed nothing');

    const saved = await internal(gw, `/internal/v1/accounts/${key}/settings`, { method: 'POST', body: {
      owner: ownerOf(), label: '  بات فروش \n ', default_chat: '-100', allowed_chats: ['-100', '555', '555'], send_enabled: false } });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.equal(saved.json.account.label, 'بات فروش');
    assert.equal(saved.json.account.custom_label, 'بات فروش');
    assert.equal(saved.json.account.default_chat, '-100');
    assert.equal(saved.json.account.default_chat_title, 'کانال نابکس');
    assert.deepEqual(saved.json.account.allowed_chats, ['-100', '555']);
    assert.equal(saved.json.account.send_enabled, false);
    // PATCH works too, and only the fields sent change. An empty label falls back to the chat title.
    const patched = await internal(gw, `/internal/v1/accounts/${key}/settings`, { method: 'PATCH', body: { owner: ownerOf(), send_enabled: true, label: '' } });
    assert.equal(patched.json.account.send_enabled, true);
    assert.deepEqual(patched.json.account.allowed_chats, ['-100', '555']);
    assert.equal(patched.json.account.label, 'کانال نابکس');
    // The gateway's own panel view shows the same values.
    assert.equal(gw.accounts.view(gw.store.account(key)).send_enabled, true);

    const bad = async (body, code) => {
      const r = await internal(gw, `/internal/v1/accounts/${key}/settings`, { method: 'POST', body: { owner: ownerOf(), ...body } });
      assert.equal(r.status, 400, JSON.stringify(r.json));
      assert.equal(r.json.detail, code);
      assert.ok(r.json.error.fa && r.json.error.en);
    };
    await bad({ send_enabled: 'yes' }, 'INVALID_SEND_ENABLED');
    await bad({ default_chat: 'two words' }, 'INVALID_CHAT_ID');
    await bad({ allowed_chats: Array.from({ length: 51 }, (_, i) => `c${i}`) }, 'TOO_MANY_ALLOWED_CHATS');
    await bad({ label: 'x'.repeat(81) }, 'LABEL_TOO_LONG');
    assert.equal(gw.store.account(key).send_enabled, true, 'a refused change changes nothing');
  } finally { await gw.close(); }
});

test('sending keeps every lock: confirm, allowed chat and the sending switch', async () => {
  const gw = await startGateway();
  try {
    const key = await connect(gw);
    const send = body => internal(gw, `/internal/v1/accounts/${key}/send`, { method: 'POST', body: { owner: ownerOf(), ...body } });
    const sends = () => gw.messengers.calls.filter(c => c.method.startsWith('send'));

    const unconfirmed = await send({ text: 'سلام دنیا' });
    assert.equal(unconfirmed.status, 400);
    assert.equal(unconfirmed.json.detail, 'EXPLICIT_CONFIRMATION_REQUIRED');
    assert.equal(unconfirmed.json.preview.willSend, true);
    assert.equal(unconfirmed.json.preview.chatId, '@nabuxchan');
    assert.equal(unconfirmed.json.preview.text, undefined);
    assert.equal((await send({ text: 'x', confirm: 'true' })).json.detail, 'EXPLICIT_CONFIRMATION_REQUIRED', 'only a real boolean confirms');
    assert.equal(sends().length, 0, 'nothing was sent without confirm');

    const ok = await send({ text: 'سلام دنیا', confirm: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual({ chat: ok.json.chat_id, id: ok.json.message_id, kind: ok.json.kind }, { chat: '@nabuxchan', id: '7', kind: 'text' });
    assert.equal(sends()[0].body.chat_id, '@nabuxchan');
    assert.equal(sends()[0].body.text, 'سلام دنیا');

    const notAllowed = await send({ chat_id: '555', text: 'x', confirm: true });
    assert.equal(notAllowed.status, 400);
    assert.match(notAllowed.json.detail, /^RECIPIENT_NOT_ALLOWLISTED/);
    assert.equal(notAllowed.json.error.en, 'This chat is not on the account\'s allowed chats.');

    const photo = await send({ chat_id: '@nabuxchan', kind: 'photo', file_url: 'https://cdn.example.com/a.jpg', caption: 'عکس', confirm: true });
    assert.equal(photo.status, 200, JSON.stringify(photo.json));
    assert.equal(photo.json.message_id, '8');
    const doc = await send({ kind: 'document', file_url: 'https://cdn.example.com/a.pdf', confirm: true });
    assert.equal(doc.status, 200, JSON.stringify(doc.json));
    assert.ok(gw.messengers.calls.some(c => c.method === 'sendDocument'));
    const fileUnconfirmed = await send({ kind: 'photo', file_url: 'https://cdn.example.com/b.jpg' });
    assert.equal(fileUnconfirmed.json.detail, 'EXPLICIT_CONFIRMATION_REQUIRED');
    assert.ok(!gw.media.fetched.includes('https://cdn.example.com/b.jpg'), 'nothing is downloaded before confirm');
    assert.equal((await send({ kind: 'photo', confirm: true })).json.detail, 'FILE_URL_REQUIRED');
    assert.equal((await send({ kind: 'sticker', text: 'x', confirm: true })).json.detail, 'UNSUPPORTED_SEND_KIND');
    assert.equal((await send({ text: '', confirm: true })).json.detail, 'INVALID_MESSAGE');

    await internal(gw, `/internal/v1/accounts/${key}/settings`, { method: 'POST', body: { owner: ownerOf(), send_enabled: false } });
    const off = await send({ text: 'x', confirm: true });
    assert.match(off.json.detail, /^SEND_DISABLED_BY_DEFAULT/);
    assert.equal(off.json.error.fa, 'ارسال برای این حساب خاموش است؛ اول در تنظیمات روشنش کنید.');
    await internal(gw, `/internal/v1/accounts/${key}/settings`, { method: 'POST', body: { owner: ownerOf(), send_enabled: true, default_chat: '' } });
    assert.equal((await send({ text: 'x', confirm: true })).json.detail, 'CHAT_ID_REQUIRED');

    const theirs = await internal(gw, `/internal/v1/accounts/${key}/send`, { method: 'POST', body: { owner: ownerOf(stranger), text: 'x', confirm: true } });
    assert.equal(theirs.status, 404);
    const log = gw.lines.join('\n');
    assert.ok(!log.includes('سلام دنیا') && !log.includes('@nabuxchan') && !log.includes('cdn.example.com'), 'bodies, chats and URLs are not logged');
    assert.ok(!log.includes('BaleTokenSecretValue') && !log.includes('user-1'));
  } finally { await gw.close(); }
});

test('Gap has no file kinds to choose from but sends text; a provider failure is a 502 with a reason', async () => {
  const gw = await startGateway({ messengerOpts: { rejectTokens: ['Revoked'] } });
  try {
    const gap = await connect(gw, { messenger: 'gap', fields: { token: 'a1b2c3d4e5f6a7b8c9d0', default_chat_id: '12345' } });
    const s = (await internal(gw, `/internal/v1/accounts/${gap}/settings?${q()}`)).json.account;
    assert.equal(s.can.read_updates, false);
    const sent = await internal(gw, `/internal/v1/accounts/${gap}/send`, { method: 'POST', body: { owner: ownerOf(), text: 'hi', confirm: true } });
    assert.equal(sent.status, 200, JSON.stringify(sent.json));

    const key = await connect(gw);
    gw.store.updateAccount(key, { token_sealed: gw.keys.seal('123456789:RevokedLater') });
    const r = await internal(gw, `/internal/v1/accounts/${key}/send`, { method: 'POST', body: { owner: ownerOf(), text: 'x', confirm: true } });
    assert.equal(r.status, 502);
    assert.equal(r.json.detail, 'PROVIDER_HTTP_ERROR_401');
    assert.equal(r.json.error.en, 'The messenger refused the request.');
    assert.ok(!JSON.stringify(r.json).includes('RevokedLater'));
  } finally { await gw.close(); }
});

test('recent messages are read without marking anything delivered; messengers without updates say so', async () => {
  const gw = await startGateway();
  try {
    const key = await connect(gw);
    const r = await internal(gw, `/internal/v1/accounts/${key}/updates?${q()}&limit=2`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.supported, true);
    assert.deepEqual(r.json.updates.map(u => u.text), ['ممنون', 'پست کانال'], 'newest first, limited');
    assert.equal(r.json.updates[0].chat_id, '555');
    assert.equal(r.json.updates[0].chat_title, 'Sara');
    assert.equal(r.json.updates[0].date, new Date(1767225720 * 1000).toISOString());
    assert.deepEqual(r.json.chats.map(c => [c.chat_id, c.allowed]), [['555', false], ['-100', false]]);
    const call = gw.messengers.calls.find(c => c.method === 'getUpdates');
    assert.equal(call.body.offset, undefined, 'no offset: the messenger keeps the updates pending');
    assert.equal(call.body.timeout, 0);

    await internal(gw, `/internal/v1/accounts/${key}/settings`, { method: 'POST', body: { owner: ownerOf(), allowed_chats: ['555'] } });
    const again = await internal(gw, `/internal/v1/accounts/${key}/updates?${q()}`);
    assert.equal(again.json.updates.length, 3);
    assert.equal(again.json.chats.find(c => c.chat_id === '555').allowed, true);
    assert.equal((await internal(gw, `/internal/v1/accounts/${key}/updates?${q(stranger)}`)).status, 404);
    assert.ok(!gw.lines.join('\n').includes('ممنون'), 'incoming text is not logged');

    const eitaa = await connect(gw, { messenger: 'eitaa', fields: { token: 'bot12345:EitaaTokenValue', default_chat_id: '@chan' } });
    const none = await internal(gw, `/internal/v1/accounts/${eitaa}/updates?${q()}`);
    assert.equal(none.status, 200);
    assert.equal(none.json.supported, false);
    assert.deepEqual(none.json.updates, []);
  } finally { await gw.close(); }
});

test('removing an account erases it for its owner only', async () => {
  const gw = await startGateway();
  try {
    const key = await connect(gw);
    const other = await connect(gw, { messenger: 'soroushplus', fields: { token: '555555555:SecondBotToken' } });
    assert.notEqual(other, key);
    assert.equal((await internal(gw, `/internal/v1/accounts/${key}/remove`, { method: 'POST', body: { owner: ownerOf(stranger) } })).status, 404);
    assert.ok(gw.store.account(key));
    const r = await internal(gw, `/internal/v1/accounts/${key}/remove`, { method: 'POST', body: { owner: ownerOf() } });
    assert.equal(r.status, 200);
    assert.equal(r.json.removed, key);
    assert.equal(gw.store.account(key), null);
    assert.equal((await internal(gw, `/internal/v1/accounts/${key}/settings?${q()}`)).status, 404);
    assert.deepEqual((await internal(gw, `/internal/v1/owners/accounts?${q()}`)).json.accounts.map(a => a.account_key), [other]);
    const del = await internal(gw, `/internal/v1/accounts/${other}?${q()}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.equal(gw.store.account(other), null);
  } finally { await gw.close(); }
});
