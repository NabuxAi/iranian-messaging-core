// Bot mode: one messenger's official bot API, behind the same locks for every
// write: NABU_MESSAGING_ENABLE_SEND=1, confirm: true, and the chat on that
// messenger's <ID>_ALLOWED_CHAT_IDS list ("*" = any chat for that messenger).
//
// A hosted, multi-tenant server passes `settings` instead: { token,
// allowedChats, sendEnabled } for ONE account. Then nothing is read from the
// environment and the same three locks apply to that account's values.
import { loadFile } from './files.mjs';

const MAX_TEXT = 4000;
const FILE_KINDS = ['photo', 'video', 'audio', 'voice', 'document'];

// Where the token, the allowlist and the send switch come from: the
// environment (one bot per process) or one account's settings (hosted).
function envSource(adapter) {
  const listEnv = `${adapter.id.toUpperCase()}_ALLOWED_CHAT_IDS`;
  return {
    token: () => (process.env[adapter.tokenEnv] || '').trim(),
    allowed: () => (process.env[listEnv] || '').split(','),
    sendEnabled: () => process.env.NABU_MESSAGING_ENABLE_SEND === '1',
    tokenHint: `SET_${adapter.tokenEnv}`,
    allowlistHint: `ADD_TO_${listEnv}`,
    sendHint: 'SET_NABU_MESSAGING_ENABLE_SEND'
  };
}

function settingsSource(settings) {
  return {
    token: () => String(settings.token || '').trim(),
    allowed: () => [...(settings.allowedChats || [])],
    sendEnabled: () => settings.sendEnabled === true,
    tokenHint: 'CONNECT_THE_BOT_AGAIN',
    allowlistHint: 'ADD_IT_TO_THE_ACCOUNT_ALLOWED_CHATS',
    sendHint: 'TURN_ON_SENDING_FOR_THE_ACCOUNT'
  };
}

function allowed(source, chatId) {
  const list = new Set(source.allowed().map(s => String(s).trim()).filter(Boolean));
  return list.has('*') || list.has(chatId);
}

function tokenFor(source) {
  const token = source.token();
  if (!token || token.length < 10 || /\s/.test(token)) throw new Error(`BOT_TOKEN_MISSING_${source.tokenHint}`);
  return token;
}

function chatIdOf(value) {
  const id = String(value ?? '').trim();
  if (!id || id.length > 128) throw new Error('INVALID_CHAT_ID');
  return id;
}

function textOf(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT) throw new Error('INVALID_MESSAGE');
  return value;
}

function supports(adapter, capability) {
  if (!adapter.capabilities.includes(capability)) {
    throw new Error(`NOT_SUPPORTED_BY_${adapter.id.toUpperCase()}_BOT: ${capability}`);
  }
}

function guardWrite(source, chatId, confirm) {
  if (confirm !== true) throw new Error('EXPLICIT_CONFIRMATION_REQUIRED');
  if (!allowed(source, chatId)) throw new Error(`RECIPIENT_NOT_ALLOWLISTED_${source.allowlistHint}`);
  if (!source.sendEnabled()) throw new Error(`SEND_DISABLED_BY_DEFAULT_${source.sendHint}`);
}

// All bot operations for one adapter. fetcher is injectable for tests;
// settings (optional) holds one hosted account's token, allowlist and switch.
export function createBotOps(adapter, fetcher = fetch, settings = null) {
  const source = settings ? settingsSource(settings) : envSource(adapter);
  const context = () => ({ token: tokenFor(source), fetcher });
  return {
    adapter,

    info() {
      return { id: adapter.id, label: adapter.label, capabilities: [...adapter.capabilities], tokenEnv: adapter.tokenEnv,
        tokenConfigured: Boolean(source.token()),
        allowlistEnv: settings ? null : `${adapter.id.toUpperCase()}_ALLOWED_CHAT_IDS`, docs: adapter.docs || null, notes: adapter.notes || null };
    },

    preview({ chatId, text }) {
      const id = chatIdOf(chatId);
      const body = textOf(text);
      const hasToken = Boolean(source.token());
      const approved = allowed(source, id);
      const enabled = source.sendEnabled();
      return { chatId: id, text: body, approvedRecipient: approved, sendEnabled: enabled, tokenConfigured: hasToken,
        willSend: approved && enabled && hasToken,
        note: settings
          ? 'Preview never sends. Sending needs confirm: true, the chat on the account\'s allowed chats and sending turned on for the account.'
          : 'Preview never sends. Sending needs confirm: true, an allowlisted chat and NABU_MESSAGING_ENABLE_SEND=1.' };
    },

    async sendMessage({ chatId, text, replyToMessageId, confirm }) {
      supports(adapter, 'send_text');
      const id = chatIdOf(chatId);
      const body = textOf(text);
      guardWrite(source, id, confirm);
      return { ok: true, chatId: id, ...(await adapter.sendText(context(), { chatId: id, text: body, replyToMessageId })) };
    },

    async sendFile({ chatId, filePath, fileUrl, kind, caption, confirm }) {
      supports(adapter, 'send_file');
      const id = chatIdOf(chatId);
      const cap = textOf(caption, { optional: true });
      // A hosted server has no local files to offer: only https URLs.
      if (settings && filePath) throw new Error('LOCAL_FILES_NOT_AVAILABLE_USE_FILEURL');
      guardWrite(source, id, confirm);
      const ctx = context();
      const file = await loadFile({ filePath, fileUrl }, fetcher);
      const result = await adapter.sendFile(ctx, { chatId: id, file, kind: FILE_KINDS.includes(kind) ? kind : 'document', caption: cap });
      return { ok: true, chatId: id, fileName: file.name, ...result };
    },

    async editMessage({ chatId, messageId, text, confirm }) {
      supports(adapter, 'edit_text');
      const id = chatIdOf(chatId);
      const body = textOf(text);
      guardWrite(source, id, confirm);
      return { ok: true, chatId: id, messageId: String(messageId),
        ...(await adapter.editText(context(), { chatId: id, messageId: String(messageId), text: body })) };
    },

    async deleteMessage({ chatId, messageId, confirm }) {
      supports(adapter, 'delete');
      const id = chatIdOf(chatId);
      guardWrite(source, id, confirm);
      return { ok: true, chatId: id, messageId: String(messageId),
        ...(await adapter.deleteMessage(context(), { chatId: id, messageId: String(messageId) })) };
    },

    // Reads need the token but no allowlist: they only show what the bot already receives.
    async getUpdates({ offset, limit }) {
      supports(adapter, 'get_updates');
      const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
      return adapter.getUpdates(context(), { offset, limit: n });
    },

    async getMe() {
      supports(adapter, 'get_me');
      return { bot: await adapter.getMe(context()) };
    },

    async getChat({ chatId }) {
      supports(adapter, 'get_chat');
      return { chat: await adapter.getChat(context(), { chatId: chatIdOf(chatId) }) };
    }
  };
}
