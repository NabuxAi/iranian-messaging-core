// Bot APIs that copy Telegram's method names and {ok, result} envelope.
import { callApi, formFrom, ProviderError } from './http.mjs';

const FILE_METHOD = {
  photo: ['sendPhoto', 'photo'],
  video: ['sendVideo', 'video'],
  audio: ['sendAudio', 'audio'],
  voice: ['sendVoice', 'voice'],
  document: ['sendDocument', 'document']
};

export function telegramLike({ id, label, apiBase, tokenEnv, docs }) {
  const url = (token, method) => `${apiBase}/bot${token}/${method}`;
  const unwrap = body => {
    if (!body?.ok) throw new ProviderError('PROVIDER_API_REJECTED', body?.description);
    return body.result;
  };
  const call = async (ctx, method, json) => unwrap(await callApi(url(ctx.token, method), { json }, ctx.fetcher));

  return {
    id, label, tokenEnv, docs,
    capabilities: ['send_text', 'send_file', 'edit_text', 'delete', 'get_updates', 'get_chat', 'get_me'],

    async getMe(ctx) {
      const me = await call(ctx, 'getMe', {});
      return { id: String(me.id), username: me.username ?? null, name: me.first_name ?? null };
    },

    async sendText(ctx, { chatId, text, replyToMessageId }) {
      const sent = await call(ctx, 'sendMessage', {
        chat_id: chatId, text, ...(replyToMessageId ? { reply_to_message_id: Number(replyToMessageId) } : {})
      });
      return { messageId: String(sent.message_id) };
    },

    async sendFile(ctx, { chatId, file, kind, caption }) {
      const [method, field] = FILE_METHOD[kind] || FILE_METHOD.document;
      const form = formFrom({ chat_id: chatId, caption }, { field, ...file });
      const sent = unwrap(await callApi(url(ctx.token, method), { form }, ctx.fetcher));
      return { messageId: String(sent.message_id) };
    },

    async editText(ctx, { chatId, messageId, text }) {
      await call(ctx, 'editMessageText', { chat_id: chatId, message_id: Number(messageId), text });
      return { edited: true };
    },

    async deleteMessage(ctx, { chatId, messageId }) {
      await call(ctx, 'deleteMessage', { chat_id: chatId, message_id: Number(messageId) });
      return { deleted: true };
    },

    async getChat(ctx, { chatId }) {
      const chat = await call(ctx, 'getChat', { chat_id: chatId });
      return { id: String(chat.id), type: chat.type, title: chat.title ?? null,
        username: chat.username ?? null, name: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || null };
    },

    async getUpdates(ctx, { offset, limit }) {
      const updates = await call(ctx, 'getUpdates', {
        ...(offset ? { offset: Number(offset) } : {}), limit, timeout: 0
      });
      const items = updates.map(update => {
        const message = update.message || update.channel_post || update.edited_message || update.callback_query?.message;
        return {
          updateId: String(update.update_id),
          kind: Object.keys(update).find(k => k !== 'update_id') || 'unknown',
          chatId: message?.chat?.id != null ? String(message.chat.id) : null,
          chatTitle: message?.chat?.title || message?.chat?.username || message?.chat?.first_name || null,
          messageId: message?.message_id != null ? String(message.message_id) : null,
          from: message?.from?.username || message?.from?.first_name || null,
          text: update.callback_query?.data ?? message?.text ?? message?.caption ?? null,
          date: message?.date ? new Date(message.date * 1000).toISOString() : null
        };
      });
      const last = updates.at(-1)?.update_id;
      return { updates: items, nextOffset: last != null ? String(last + 1) : offset ?? null };
    }
  };
}
