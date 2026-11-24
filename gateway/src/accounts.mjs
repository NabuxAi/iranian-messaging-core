// Messenger accounts of an owner. Phase 1 is bot mode: one official bot per
// account, its token sealed at rest, and per account the same three write
// locks as the stdio servers (confirm: true, the chat on the account's
// allowed chats, sending switched on for the account).
import { createBotOps } from '../../src/bot.mjs';
import { randomString, sha256 } from './crypto.mjs';
import { can, messengerById } from './messengers.mjs';

const MAX_CHATS = 50;
const now = () => Math.floor(Date.now() / 1000);

export class AccountError extends Error {
  constructor(code, status = 400) { super(code); this.status = status; }
}

export function normalizeChat(value) {
  const chat = String(value ?? '').trim();
  if (!chat) return '';
  if (chat.length > 128 || /[\s,]/.test(chat)) throw new AccountError('INVALID_CHAT_ID');
  return chat;
}

export function parseChats(value) {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]+/);
  const out = [];
  for (const item of items) {
    const chat = normalizeChat(item);
    if (chat && !out.includes(chat)) out.push(chat);
  }
  if (out.length > MAX_CHATS) throw new AccountError('TOO_MANY_ALLOWED_CHATS');
  return out;
}

// A bot token goes into the API URL path (or a header): no whitespace and
// nothing that could change the URL around it.
export function checkToken(token) {
  const t = String(token ?? '').trim();
  if (!/^[^\s/?#%\\@]{10,512}$/.test(t)) throw new AccountError('INVALID_BOT_TOKEN');
  return t;
}

export const iso = ts => (ts ? new Date(ts * 1000).toISOString() : null);

export function createAccounts({ store, keys, fetcher, messengers, maxPerOwner = 50 }) {
  const messenger = id => {
    const m = messengerById(messengers, id);
    if (!m) throw new AccountError('UNKNOWN_MESSENGER');
    return m;
  };

  const opsWith = (m, settings) => createBotOps(m.adapter, fetcher, settings);

  function settingsOf(account) {
    return { token: keys.open(account.token_sealed), allowedChats: account.allowed_chats, sendEnabled: account.send_enabled === true };
  }

  function label(account) {
    const m = messengerById(messengers, account.messenger);
    return account.default_chat_title || (account.username ? `@${account.username}` : null) || account.bot_name ||
      `${m ? m.label : account.messenger} bot`;
  }

  function view(account) {
    const m = messengerById(messengers, account.messenger);
    return {
      account_key: account.key,
      messenger: account.messenger,
      messenger_label: m ? m.label : account.messenger,
      label: label(account),
      kind: account.kind,
      mode: account.mode,
      status: account.status,
      username: account.username || null,
      bot_name: account.bot_name || null,
      verified: account.verified === true,
      default_chat: account.default_chat || null,
      default_chat_title: account.default_chat_title || null,
      allowed_chats: [...account.allowed_chats],
      send_enabled: account.send_enabled === true,
      capabilities: m ? [...m.adapter.capabilities] : [],
      connected_at: iso(account.created_at),
      updated_at: iso(account.updated_at)
    };
  }

  // The bot's identity from getMe, where the messenger has it.
  async function identify(m, token) {
    if (!can(m, 'get_me')) return { verified: false, botId: null, username: null, name: null };
    try {
      const { bot } = await opsWith(m, { token, allowedChats: [], sendEnabled: false }).getMe();
      return { verified: true, botId: bot.id != null ? String(bot.id) : null, username: bot.username || null, name: bot.name || null };
    } catch (err) {
      if (/PROVIDER_(API_REJECTED|HTTP_ERROR_40[134])/.test(err.message)) throw new AccountError('BOT_TOKEN_REJECTED');
      throw new AccountError(err.message.startsWith('PROVIDER_') ? 'MESSENGER_UNREACHABLE' : err.message, 502);
    }
  }

  async function chatTitle(m, settings, chatId) {
    if (!chatId || !can(m, 'get_chat')) return null;
    try {
      const { chat } = await opsWith(m, settings).getChat({ chatId });
      return chat.title || (chat.username ? `@${chat.username}` : null) || chat.name || null;
    } catch { return null; }
  }

  return {
    view,
    label,

    list(ownerId) { return store.accountsOf(ownerId).map(view); },

    get(ownerId, key) {
      const account = store.account(key);
      return account && account.owner_id === ownerId ? account : null;
    },

    // Adds a bot (or replaces the token of the same bot). With a default chat,
    // allowSend puts that chat on the allowlist and turns sending on: the
    // owner has just named it as the place this account publishes to.
    async addBot(ownerId, { messenger: id, token, defaultChat = '', allowSend = false }) {
      const m = messenger(id);
      const clean = checkToken(token);
      const chat = normalizeChat(defaultChat);
      const who = await identify(m, clean);
      const tokenHash = sha256(`${m.id}:${clean}`);
      const mine = store.accountsOf(ownerId).filter(a => a.messenger === m.id);
      const existing = mine.find(a => (who.botId && a.bot_id === who.botId) || a.token_hash === tokenHash);
      if (!existing && store.accountsOf(ownerId).length >= maxPerOwner) throw new AccountError('TOO_MANY_ACCOUNTS');
      const allowed = existing ? [...existing.allowed_chats] : [];
      if (chat && allowSend && !allowed.includes(chat)) allowed.push(chat);
      const settings = { token: clean, allowedChats: allowed, sendEnabled: false };
      const title = chat ? await chatTitle(m, settings, chat) : null;
      const fields = {
        token_sealed: keys.seal(clean), token_hash: tokenHash, bot_id: who.botId, username: who.username, bot_name: who.name,
        verified: who.verified, status: 'connected', checked_at: now(), allowed_chats: allowed,
        ...(chat ? { default_chat: chat, default_chat_title: title } : {}),
        ...(chat && allowSend ? { send_enabled: true } : {})
      };
      if (existing) return { account: store.updateAccount(existing.key, fields), created: false };
      return {
        created: true,
        account: store.insertAccount({
          key: `irm_${m.id}_${randomString(32)}`, owner_id: ownerId, messenger: m.id, kind: 'bot', mode: 'official',
          default_chat: '', default_chat_title: null, send_enabled: false, created_at: now(), updated_at: now(), ...fields
        })
      };
    },

    async updateSettings(account, { defaultChat, allowedChats, sendEnabled }) {
      const m = messenger(account.messenger);
      const changes = {};
      if (allowedChats !== undefined) changes.allowed_chats = parseChats(allowedChats);
      if (sendEnabled !== undefined) changes.send_enabled = sendEnabled === true;
      if (defaultChat !== undefined) {
        const chat = normalizeChat(defaultChat);
        changes.default_chat = chat;
        changes.default_chat_title = chat ? await chatTitle(m, settingsOf(account), chat) : null;
      }
      return store.updateAccount(account.key, changes);
    },

    // Asks the messenger whether the token still works.
    async check(account) {
      const m = messenger(account.messenger);
      if (!can(m, 'get_me')) return store.updateAccount(account.key, { checked_at: now() });
      try {
        const { bot } = await opsWith(m, settingsOf(account)).getMe();
        return store.updateAccount(account.key, { status: 'connected', checked_at: now(), username: bot.username || account.username,
          bot_name: bot.name || account.bot_name });
      } catch (err) {
        const rejected = /PROVIDER_(API_REJECTED|HTTP_ERROR_40[134])/.test(err.message);
        return store.updateAccount(account.key, { status: rejected ? 'expired' : 'error', checked_at: now() });
      }
    },

    remove(account) { return store.deleteAccount(account.key); },

    // The core's bot operations bound to this account's own token and locks.
    ops(account) { return opsWith(messenger(account.messenger), settingsOf(account)); },

    messenger
  };
}
