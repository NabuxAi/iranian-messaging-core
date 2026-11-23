import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBotOps, createWebOps, createMessengerServer, telegramLike } from '../src/index.mjs';

const VARS = ['NABU_MESSAGING_ENABLE_SEND', 'NABU_BROWSER_ENABLE', 'NABU_WEB_ALLOW_ACCOUNT_CHANGES', 'NABU_MESSAGING_FILE_ROOT',
  'DEMO_BOT_TOKEN', 'DEMO_ALLOWED_CHAT_IDS', 'DEMO_WEB_ALLOWED_CHATS'];
const saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
beforeEach(() => { for (const k of VARS) delete process.env[k]; });
afterEach(() => { for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const bot = telegramLike({ id: 'demo', label: 'Demo', apiBase: 'https://api.demo.test', tokenEnv: 'DEMO_BOT_TOKEN' });
const fakeFetch = (...bodies) => {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => bodies.shift() };
  };
  return { fetcher, calls };
};

// A web driver that records calls and never opens a browser.
const webDriver = { id: 'demo', label: 'Demo Web', url: 'https://web.demo.test/', host: 'web.demo.test',
  loginState: async () => ({ signedIn: true }), listChats: async () => ({ total: 0, chats: [] }),
  readChat: async () => ({ messages: [] }), sendText: async () => ({}), sendFile: async () => ({}),
  editText: async () => ({ edited: true }), joinChat: async () => ({}), updateChat: async () => ({}) };

test('bot writes need confirm, the allowlist and the send switch, in that order', async () => {
  const { fetcher } = fakeFetch({ ok: true, result: { message_id: 1 } });
  const ops = createBotOps(bot, fetcher);
  process.env.DEMO_BOT_TOKEN = 'demo-token-123456';
  await assert.rejects(ops.sendMessage({ chatId: '1', text: 'x', confirm: false }), /EXPLICIT_CONFIRMATION_REQUIRED/);
  await assert.rejects(ops.sendMessage({ chatId: '1', text: 'x', confirm: true }), /RECIPIENT_NOT_ALLOWLISTED_ADD_TO_DEMO_ALLOWED_CHAT_IDS/);
  process.env.DEMO_ALLOWED_CHAT_IDS = '1';
  await assert.rejects(ops.sendMessage({ chatId: '1', text: 'x', confirm: true }), /SEND_DISABLED_BY_DEFAULT/);
  process.env.NABU_MESSAGING_ENABLE_SEND = '1';
  const out = await ops.sendMessage({ chatId: '1', text: 'x', confirm: true });
  assert.equal(out.messageId, '1');
});

test('bot token never appears in errors', async () => {
  process.env.DEMO_BOT_TOKEN = 'secret-token-abcdef';
  const ops = createBotOps(bot, async () => { throw new Error('connect ECONNREFUSED https://api.demo.test/botsecret-token-abcdef/getMe'); });
  await assert.rejects(ops.getMe(), err => err.message === 'PROVIDER_UNREACHABLE' &&
    !String(err.detail).includes('secret-token') && !err.message.includes('secret-token'));
});

test('web writes are locked the same way; account changes need their own switch', async () => {
  const ops = createWebOps(webDriver);
  await assert.rejects(ops.editMessage({ chatId: 'me', messageId: '1', text: 'x', confirm: true }), /BROWSER_DISABLED/);
  process.env.NABU_BROWSER_ENABLE = '1';
  process.env.NABU_MESSAGING_ENABLE_SEND = '1';
  await assert.rejects(ops.editMessage({ chatId: 'me', messageId: '1', text: 'x', confirm: true }), /RECIPIENT_NOT_ALLOWLISTED_ADD_TO_DEMO_WEB_ALLOWED_CHATS/);
  await assert.rejects(ops.joinChat({ link: '@x', confirm: true }), /ACCOUNT_CHANGES_DISABLED/);
  process.env.NABU_WEB_ALLOW_ACCOUNT_CHANGES = '1';
  await assert.rejects(ops.updateChat({ chatId: '-5', title: 'T', confirm: true }), /RECIPIENT_NOT_ALLOWLISTED/);
  // Passes every lock and stops only because no browser window is open.
  process.env.DEMO_WEB_ALLOWED_CHATS = 'me';
  await assert.rejects(ops.editMessage({ chatId: 'me', messageId: '1', text: 'x', confirm: true }), /WEB_APP_NOT_OPEN_CALL_OPEN_FIRST/);
});

test('ops the driver lacks say NOT_SUPPORTED, and are listed as such', async () => {
  process.env.NABU_BROWSER_ENABLE = '1';
  const ops = createWebOps(webDriver);
  await assert.rejects(ops.getMembers({ chatId: '-1' }), /NOT_SUPPORTED_BY_DEMO_WEB: getMembers/);
  const caps = ops.capabilities();
  assert.ok(caps.supported.includes('editText'));
  assert.ok(caps.notSupported.includes('getMembers'));
});

test('input limits hold before anything runs', () => {
  const ops = createWebOps(webDriver);
  assert.throws(() => ops.addMembers({ chatId: '-1', userIds: ['1', '2', '3', '4', '5', '6'], confirm: true }), /AT_MOST_5_MEMBERS_PER_CALL/);
  assert.throws(() => ops.sendPoll({ chatId: 'me', question: 'q', options: ['a'], confirm: true }), /POLL_NEEDS_2_TO_10_OPTIONS/);
  assert.throws(() => ops.sendLocation({ chatId: 'me', latitude: 91, longitude: 0, confirm: true }), /INVALID_COORDINATES/);
});

test('the server registers prefixed tools only for what the driver and bot support', async () => {
  const server = createMessengerServer({ id: 'demo', label: 'Demo', botAdapter: bot, webDriver });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  const names = (await client.listTools()).tools.map(t => t.name);
  assert.ok(names.includes('demo_bot_send_message'));
  assert.ok(names.includes('demo_web_send_message'));
  assert.ok(names.includes('demo_web_edit_message'));
  assert.ok(!names.includes('demo_web_get_members'));
  assert.ok(names.every(n => n.startsWith('demo_')));
  const res = await client.callTool({ name: 'demo_web_join_chat', arguments: { link: '@x', confirm: true } });
  assert.equal(res.isError, true);
  await client.close();
});
