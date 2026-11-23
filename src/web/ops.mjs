// Web mode: drives one messenger's web app from the user's OWN signed-in
// account. The user signs in once in a visible window (the verification code
// and any 2FA password are always typed by the user there) and the browser
// profile keeps the session.
//
// Every operation is a method on the driver; a driver that lacks one answers
// NOT_SUPPORTED_BY_<ID>_WEB. Locks, on top of NABU_BROWSER_ENABLE=1:
//   reads            - none beyond being signed in
//   writes to a chat - confirm: true, the chat in <ID>_WEB_ALLOWED_CHATS,
//                      NABU_MESSAGING_ENABLE_SEND=1
//   account changes  - (create/join/leave chats, members, admins) confirm: true,
//                      NABU_WEB_ALLOW_ACCOUNT_CHANGES=1, and the chat allowlist
//                      wherever an existing chat is changed
// Nothing loops over many recipients: one chat per call, and at most
// MAX_MEMBERS_PER_CALL users added per call.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadFile } from '../files.mjs';
import {
  MAX_TEXT, MAX_WEB_FILE_BYTES, assertEnabled, assertOnApp, closeSession, guardWrite, openSession, session
} from './session.mjs';

export const MAX_MEMBERS_PER_CALL = 5;
const MAX_IDS = 50;

export const OPTIONAL_OPS = Object.freeze([
  'editText', 'deleteMessages', 'forwardMessages', 'pinMessage', 'markRead',
  'sendLocation', 'sendContact', 'sendPoll',
  'getChatInfo', 'getMembers', 'searchMessages', 'downloadMedia', 'getUnread', 'getContacts',
  'createChat', 'updateChat', 'getInviteLink', 'joinChat', 'leaveChat', 'addMembers', 'removeMember', 'setAdmin'
]);

const textOf = (value, name = 'INVALID_MESSAGE', max = MAX_TEXT) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(name);
  return value;
};
const idsOf = list => {
  const out = (Array.isArray(list) ? list : [list]).map(String).map(s => s.trim()).filter(Boolean);
  if (!out.length || out.length > MAX_IDS) throw new Error('INVALID_MESSAGE_IDS');
  return out;
};
const limitOf = (value, fallback, max = 200) => Math.min(Math.max(Number(value) || fallback, 1), max);

export function createWebOps(driver) {
  const ID = driver.id.toUpperCase();

  async function page() {
    const { page: p } = await session(driver);
    assertOnApp(driver, p);
    return p;
  }

  function op(name) {
    if (typeof driver[name] !== 'function') throw new Error(`NOT_SUPPORTED_BY_${ID}_WEB: ${name}`);
    return driver[name].bind(driver);
  }

  function guardAccount(confirm, chatId) {
    if (confirm !== true) throw new Error('EXPLICIT_CONFIRMATION_REQUIRED');
    if (process.env.NABU_WEB_ALLOW_ACCOUNT_CHANGES !== '1') throw new Error('ACCOUNT_CHANGES_DISABLED_SET_NABU_WEB_ALLOW_ACCOUNT_CHANGES');
    if (chatId !== undefined) guardWrite(driver, chatId, true);
    else if (process.env.NABU_MESSAGING_ENABLE_SEND !== '1') throw new Error('SEND_DISABLED_BY_DEFAULT_SET_NABU_MESSAGING_ENABLE_SEND');
  }

  async function run(name, args, guard) {
    assertEnabled();
    const fn = op(name);
    if (guard) guard();
    return fn(await page(), args);
  }

  const sendResult = (result, what) => ({ ok: !result.pending, ...result,
    ...(result.pending ? { note: `Still ${what}; keep the web app open until it finishes.` } : {}) });

  return {
    driver,

    capabilities() {
      return {
        supported: ['listChats', 'readChat', 'sendText', 'sendFile', ...OPTIONAL_OPS.filter(n => typeof driver[n] === 'function')],
        notSupported: OPTIONAL_OPS.filter(n => typeof driver[n] !== 'function'),
        notes: driver.notes || null
      };
    },

    async open() {
      assertEnabled();
      const { page: p } = await session(driver, { open: true });
      // Always load the app's root: Chrome may restore an old address, which
      // leaves the app in a state the driver does not expect.
      if (p.url() !== driver.url) await p.goto(driver.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      assertOnApp(driver, p);
      await p.waitForTimeout(4000);
      return { ...(await driver.loginState(p)),
        note: 'If not signed in, call the login_start tool with the phone number; the user types the code in the browser window.' };
    },

    async status() {
      const s = openSession(driver);
      if (!s) return { open: false };
      return { open: true, ...(await driver.loginState(s.page)) };
    },

    async loginStart({ phone }) {
      assertEnabled();
      const digits = String(phone || '').replace(/\D/g, '').replace(/^0098|^98|^0/, '');
      if (!/^9\d{9}$/.test(digits)) throw new Error('INVALID_IRANIAN_MOBILE_EXPECTED_09XXXXXXXXX');
      const p = await page();
      const state = await driver.loginState(p);
      if (state.signedIn) return state;
      await driver.loginStart(p, digits);
      await p.waitForTimeout(4000);
      return { ...(await driver.loginState(p)),
        note: 'A code was sent (in the messenger app or by SMS). The user must type it in the browser window, not in chat.' };
    },

    async close() {
      const closed = await closeSession(driver);
      return { closed, ...(closed ? { note: 'The sign-in stays saved in the browser profile.' } : {}) };
    },

    async listChats({ limit, query }) {
      assertEnabled();
      const result = await driver.listChats(await page(), { limit: limitOf(limit, 30, 100) });
      const q = String(query || '').trim().toLowerCase();
      const chats = q ? result.chats.filter(c => `${c.title || ''} ${c.username || ''}`.toLowerCase().includes(q)) : result.chats;
      return { total: result.total, chats };
    },

    async readChat({ chatId, limit, beforeMessageId }) {
      assertEnabled();
      return driver.readChat(await page(), { chatId: String(chatId), limit: limitOf(limit, 20, 100), before: beforeMessageId ?? null });
    },

    async sendMessage({ chatId, text, replyToMessageId, confirm }) {
      assertEnabled();
      textOf(text);
      guardWrite(driver, chatId, confirm);
      return sendResult(await driver.sendText(await page(), { chatId: String(chatId), text,
        ...(replyToMessageId ? { replyToMessageId: String(replyToMessageId) } : {}) }), 'sending');
    },

    async sendFile({ chatId, filePath, fileUrl, caption, confirm }) {
      assertEnabled();
      if (caption !== undefined && (typeof caption !== 'string' || caption.length > MAX_TEXT)) throw new Error('INVALID_CAPTION');
      guardWrite(driver, chatId, confirm);
      const file = await loadFile({ filePath, fileUrl });
      if (file.bytes.length > MAX_WEB_FILE_BYTES) throw new Error('FILE_TOO_LARGE_FOR_WEB_UPLOAD');
      return { fileName: file.name, ...sendResult(await driver.sendFile(await page(), { chatId: String(chatId), file, caption: caption ?? '' }), 'uploading') };
    },

    // ---- message operations (chat writes) ----
    editMessage: ({ chatId, messageId, text, confirm }) =>
      run('editText', { chatId: String(chatId), messageId: String(messageId), text: textOf(text) }, () => guardWrite(driver, chatId, confirm)),

    deleteMessages: ({ chatId, messageIds, forEveryone = true, confirm }) =>
      run('deleteMessages', { chatId: String(chatId), messageIds: idsOf(messageIds), forEveryone: forEveryone !== false },
        () => guardWrite(driver, chatId, confirm)),

    forwardMessages: ({ fromChatId, messageIds, toChatId, confirm }) =>
      run('forwardMessages', { fromChatId: String(fromChatId), messageIds: idsOf(messageIds).slice(0, 10), toChatId: String(toChatId) },
        () => guardWrite(driver, toChatId, confirm)),

    pinMessage: ({ chatId, messageId, unpin = false, confirm }) =>
      run('pinMessage', { chatId: String(chatId), messageId: String(messageId), unpin: Boolean(unpin) }, () => guardWrite(driver, chatId, confirm)),

    // Marking read only changes the user's own read state, so it needs no allowlist.
    markRead: ({ chatId }) => run('markRead', { chatId: String(chatId) }),

    sendLocation({ chatId, latitude, longitude, confirm }) {
      const lat = Number(latitude); const lng = Number(longitude);
      if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) throw new Error('INVALID_COORDINATES');
      return run('sendLocation', { chatId: String(chatId), latitude: lat, longitude: lng }, () => guardWrite(driver, chatId, confirm));
    },

    sendContact: ({ chatId, phone, firstName, lastName = '', confirm }) =>
      run('sendContact', { chatId: String(chatId), phone: textOf(String(phone ?? ''), 'INVALID_PHONE', 20),
        firstName: textOf(firstName, 'INVALID_NAME', 64), lastName: String(lastName || '').slice(0, 64) }, () => guardWrite(driver, chatId, confirm)),

    sendPoll({ chatId, question, options, anonymous = true, multipleAnswers = false, confirm }) {
      const opts = (options || []).map(o => textOf(String(o), 'INVALID_POLL_OPTION', 100));
      if (opts.length < 2 || opts.length > 10) throw new Error('POLL_NEEDS_2_TO_10_OPTIONS');
      return run('sendPoll', { chatId: String(chatId), question: textOf(question, 'INVALID_QUESTION', 300), options: opts,
        anonymous: anonymous !== false, multipleAnswers: Boolean(multipleAnswers) }, () => guardWrite(driver, chatId, confirm));
    },

    // ---- reading ----
    getChatInfo: ({ chatId }) => run('getChatInfo', { chatId: String(chatId) }),
    getMembers: ({ chatId, limit, query }) => run('getMembers', { chatId: String(chatId), limit: limitOf(limit, 50), query: String(query || '') }),
    searchMessages: ({ chatId, query, limit }) =>
      run('searchMessages', { chatId: chatId ? String(chatId) : null, query: textOf(query, 'INVALID_QUERY', 200), limit: limitOf(limit, 20) }),
    getUnread: ({ limit }) => run('getUnread', { limit: limitOf(limit, 20) }),
    // Contacts come back without phone numbers.
    getContacts: ({ limit, query }) => run('getContacts', { limit: limitOf(limit, 100), query: String(query || '') }),

    // Saves the media of one message under NABU_MESSAGING_FILE_ROOT/downloads/<id>/.
    async downloadMedia({ chatId, messageId }) {
      const root = process.env.NABU_MESSAGING_FILE_ROOT;
      if (!root) throw new Error('DOWNLOADS_NEED_NABU_MESSAGING_FILE_ROOT');
      const result = await run('downloadMedia', { chatId: String(chatId), messageId: String(messageId) });
      const safe = String(result.name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';
      const dir = path.join(path.resolve(root), 'downloads', driver.id);
      await mkdir(dir, { recursive: true });
      const target = path.join(dir, `${Date.now()}-${safe}`);
      await writeFile(target, Buffer.from(result.base64, 'base64'));
      return { savedTo: path.relative(path.resolve(root), target), mime: result.mime || null, size: Buffer.byteLength(result.base64, 'base64') };
    },

    // ---- chat management (account changes) ----
    createChat({ type, title, about = '', confirm }) {
      if (!['group', 'channel'].includes(type)) throw new Error('TYPE_MUST_BE_GROUP_OR_CHANNEL');
      return run('createChat', { type, title: textOf(title, 'INVALID_TITLE', 128), about: String(about || '').slice(0, 255) },
        () => guardAccount(confirm));
    },

    updateChat({ chatId, title, about, confirm }) {
      if (title === undefined && about === undefined) throw new Error('NOTHING_TO_UPDATE');
      return run('updateChat', { chatId: String(chatId), ...(title !== undefined ? { title: textOf(title, 'INVALID_TITLE', 128) } : {}),
        ...(about !== undefined ? { about: String(about).slice(0, 255) } : {}) }, () => guardAccount(confirm, chatId));
    },

    getInviteLink: ({ chatId }) => run('getInviteLink', { chatId: String(chatId) }),
    joinChat: ({ link, confirm }) => run('joinChat', { link: textOf(String(link ?? ''), 'INVALID_LINK', 200) }, () => guardAccount(confirm)),
    leaveChat: ({ chatId, confirm }) => run('leaveChat', { chatId: String(chatId) }, () => guardAccount(confirm, chatId)),

    addMembers({ chatId, userIds, confirm }) {
      const users = idsOf(userIds);
      if (users.length > MAX_MEMBERS_PER_CALL) throw new Error(`AT_MOST_${MAX_MEMBERS_PER_CALL}_MEMBERS_PER_CALL`);
      return run('addMembers', { chatId: String(chatId), userIds: users }, () => guardAccount(confirm, chatId));
    },

    removeMember: ({ chatId, userId, ban = false, confirm }) =>
      run('removeMember', { chatId: String(chatId), userId: String(userId), ban: Boolean(ban) }, () => guardAccount(confirm, chatId)),

    setAdmin: ({ chatId, userId, isAdmin = true, confirm }) =>
      run('setAdmin', { chatId: String(chatId), userId: String(userId), isAdmin: isAdmin !== false }, () => guardAccount(confirm, chatId))
  };
}
