// Bot mode: one messenger's official bot API, behind the same locks for every
// write: NABU_MESSAGING_ENABLE_SEND=1, confirm: true, and the chat on that
// messenger's <ID>_ALLOWED_CHAT_IDS list ("*" = any chat for that messenger).
import { loadFile } from './files.mjs';

const MAX_TEXT = 4000;
const FILE_KINDS = ['photo', 'video', 'audio', 'voice', 'document'];

const sendEnabled = () => process.env.NABU_MESSAGING_ENABLE_SEND === '1';

function allowed(adapter, chatId) {
  const list = new Set((process.env[`${adapter.id.toUpperCase()}_ALLOWED_CHAT_IDS`] || '')
    .split(',').map(s => s.trim()).filter(Boolean));
  return list.has('*') || list.has(chatId);
}

function tokenFor(adapter) {
  const token = (process.env[adapter.tokenEnv] || '').trim();
  if (!token || token.length < 10 || /\s/.test(token)) throw new Error(`BOT_TOKEN_MISSING_SET_${adapter.tokenEnv}`);
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

function guardWrite(adapter, chatId, confirm) {
  if (confirm !== true) throw new Error('EXPLICIT_CONFIRMATION_REQUIRED');
  if (!allowed(adapter, chatId)) throw new Error(`RECIPIENT_NOT_ALLOWLISTED_ADD_TO_${adapter.id.toUpperCase()}_ALLOWED_CHAT_IDS`);
  if (!sendEnabled()) throw new Error('SEND_DISABLED_BY_DEFAULT_SET_NABU_MESSAGING_ENABLE_SEND');
}

const context = (adapter, fetcher) => ({ token: tokenFor(adapter), fetcher });

// All bot operations for one adapter. fetcher is injectable for tests.
export function createBotOps(adapter, fetcher = fetch) {
  return {
    adapter,

    info() {
      return { id: adapter.id, label: adapter.label, capabilities: [...adapter.capabilities], tokenEnv: adapter.tokenEnv,
        tokenConfigured: Boolean((process.env[adapter.tokenEnv] || '').trim()),
        allowlistEnv: `${adapter.id.toUpperCase()}_ALLOWED_CHAT_IDS`, docs: adapter.docs || null, notes: adapter.notes || null };
    },

    preview({ chatId, text }) {
      const id = chatIdOf(chatId);
      const body = textOf(text);
      const hasToken = Boolean((process.env[adapter.tokenEnv] || '').trim());
      const approved = allowed(adapter, id);
      return { chatId: id, text: body, approvedRecipient: approved, sendEnabled: sendEnabled(), tokenConfigured: hasToken,
        willSend: approved && sendEnabled() && hasToken,
        note: 'Preview never sends. Sending needs confirm: true, an allowlisted chat and NABU_MESSAGING_ENABLE_SEND=1.' };
    },

    async sendMessage({ chatId, text, replyToMessageId, confirm }) {
      supports(adapter, 'send_text');
      const id = chatIdOf(chatId);
      const body = textOf(text);
      guardWrite(adapter, id, confirm);
      return { ok: true, chatId: id, ...(await adapter.sendText(context(adapter, fetcher), { chatId: id, text: body, replyToMessageId })) };
    },

    async sendFile({ chatId, filePath, fileUrl, kind, caption, confirm }) {
      supports(adapter, 'send_file');
      const id = chatIdOf(chatId);
      const cap = textOf(caption, { optional: true });
      guardWrite(adapter, id, confirm);
      const ctx = context(adapter, fetcher);
      const file = await loadFile({ filePath, fileUrl }, fetcher);
      const result = await adapter.sendFile(ctx, { chatId: id, file, kind: FILE_KINDS.includes(kind) ? kind : 'document', caption: cap });
      return { ok: true, chatId: id, fileName: file.name, ...result };
    },

    async editMessage({ chatId, messageId, text, confirm }) {
      supports(adapter, 'edit_text');
      const id = chatIdOf(chatId);
      const body = textOf(text);
      guardWrite(adapter, id, confirm);
      return { ok: true, chatId: id, messageId: String(messageId),
        ...(await adapter.editText(context(adapter, fetcher), { chatId: id, messageId: String(messageId), text: body })) };
    },

    async deleteMessage({ chatId, messageId, confirm }) {
      supports(adapter, 'delete');
      const id = chatIdOf(chatId);
      guardWrite(adapter, id, confirm);
      return { ok: true, chatId: id, messageId: String(messageId),
        ...(await adapter.deleteMessage(context(adapter, fetcher), { chatId: id, messageId: String(messageId) })) };
    },

    // Reads need the token but no allowlist: they only show what the bot already receives.
    async getUpdates({ offset, limit }) {
      supports(adapter, 'get_updates');
      const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
      return adapter.getUpdates(context(adapter, fetcher), { offset, limit: n });
    },

    async getMe() {
      supports(adapter, 'get_me');
      return { bot: await adapter.getMe(context(adapter, fetcher)) };
    },

    async getChat({ chatId }) {
      supports(adapter, 'get_chat');
      return { chat: await adapter.getChat(context(adapter, fetcher), { chatId: chatIdOf(chatId) }) };
    }
  };
}
