// Builds the MCP server for ONE messenger from its bot adapter (official bot
// API) and/or web driver (the user's own account through the web app).
// Tool names carry the messenger id (eitaa_bot_send_message,
// eitaa_web_send_message, ...) so several of these servers can be installed
// side by side.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createBotOps } from './bot.mjs';
import { createWebOps } from './web/ops.mjs';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const ok = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const run = handler => async args => {
  try { return ok(await handler(args ?? {})); }
  catch (err) {
    const detail = err.detail ? ` (${err.detail})` : '';
    return { isError: true, content: [{ type: 'text', text: err.message + detail }] };
  }
};

const confirm = z.boolean().describe('Must be true, and only after the user has explicitly approved this exact action.');

function registerBotTools(server, id, label, ops) {
  const caps = ops.adapter.capabilities;
  const has = c => caps.includes(c);
  const chatId = z.string().min(1).max(128).describe(`${label} chat, group or channel id for the bot.`);
  const messageId = z.string().min(1).max(64).describe('Id of a message this bot sent.');
  const tool = (name, title, description, inputSchema, annotations, handler) =>
    server.registerTool(`${id}_bot_${name}`, { title, description, inputSchema, annotations }, run(handler));
  const BOT_WRITE = `Needs confirm: true, the chat in ${id.toUpperCase()}_ALLOWED_CHAT_IDS and NABU_MESSAGING_ENABLE_SEND=1.`;

  tool('info', `${label} bot: setup`, `Show what the ${label} bot integration supports and which env vars it needs.`,
    {}, { ...READ, openWorldHint: false }, () => ops.info());
  tool('preview_message', `${label} bot: preview`, 'Check whether a text message would be sent, without sending.',
    { chatId, text: z.string().min(1).max(4000) }, { ...READ, openWorldHint: false }, args => ops.preview(args));
  if (has('get_me')) tool('get_me', `${label} bot: who am I`, 'Check the bot token and return the bot id, username and name.', {}, READ, () => ops.getMe());
  if (has('get_chat')) tool('get_chat', `${label} bot: chat info`, 'Type, title and username of a chat the bot can see.', { chatId }, READ, args => ops.getChat(args));
  if (has('get_updates')) {
    tool('get_updates', `${label} bot: incoming`, 'Messages and events the bot received. Pass nextOffset as offset for newer ones. Marks earlier updates as delivered.',
      { offset: z.string().max(128).optional(), limit: z.number().int().min(1).max(100).optional() }, { ...READ, idempotentHint: false }, args => ops.getUpdates(args));
  }
  if (has('send_text')) {
    tool('send_message', `${label} bot: send text`, 'Send ONE text message through the bot. No bulk sending. ' + BOT_WRITE,
      { chatId, text: z.string().min(1).max(4000), replyToMessageId: z.string().max(64).optional(), confirm }, WRITE, args => ops.sendMessage(args));
  }
  if (has('send_file')) {
    tool('send_file', `${label} bot: send file`, 'Send ONE file from an https URL or a path inside NABU_MESSAGING_FILE_ROOT. ' + BOT_WRITE,
      { chatId, fileUrl: z.string().url().optional(), filePath: z.string().max(500).optional(),
        kind: z.enum(['photo', 'video', 'audio', 'voice', 'document']).optional(), caption: z.string().max(4000).optional(), confirm },
      WRITE, args => ops.sendFile(args));
  }
  if (has('edit_text')) {
    tool('edit_message', `${label} bot: edit`, 'Replace the text of a message the bot sent. ' + BOT_WRITE,
      { chatId, messageId, text: z.string().min(1).max(4000), confirm }, { ...WRITE, idempotentHint: true }, args => ops.editMessage(args));
  }
  if (has('delete')) {
    tool('delete_message', `${label} bot: delete`, 'Delete a message the bot sent. Cannot be undone. ' + BOT_WRITE,
      { chatId, messageId, confirm }, { ...WRITE, destructiveHint: true, idempotentHint: true }, args => ops.deleteMessage(args));
  }
}

function registerWebTools(server, id, label, ops) {
  const chatId = z.string().min(1).max(128).describe(ops.driver.chatIdHint || '"me" for Saved Messages, @username, or a chatId from list_chats.');
  const msgId = z.string().min(1).max(64).describe('messageId from read_chat.');
  const msgIds = z.array(z.string().min(1).max(64)).min(1).max(50).describe('messageIds from read_chat.');
  const userId = z.string().min(1).max(64).describe('userId from get_members or get_contacts.');
  const ID = id.toUpperCase();
  const CHAT_WRITE = `Needs confirm: true after the user approves, the chat in ${ID}_WEB_ALLOWED_CHATS and NABU_MESSAGING_ENABLE_SEND=1.`;
  const ACCOUNT_CHANGE = `Changes the user's account: needs confirm: true after the user approves, NABU_WEB_ALLOW_ACCOUNT_CHANGES=1 and (for an existing chat) the chat in ${ID}_WEB_ALLOWED_CHATS.`;
  const supported = new Set(ops.capabilities().supported);
  const tool = (name, opName, title, description, inputSchema, annotations, handler) => {
    if (opName && !supported.has(opName)) return;
    server.registerTool(`${id}_web_${name}`, { title: `${label} (own account): ${title}`, description, inputSchema, annotations }, run(handler));
  };

  tool('capabilities', null, 'capabilities', `Which ${label} web operations are available here.`, {}, { ...READ, openWorldHint: false }, () => ops.capabilities());
  tool('open', null, 'open', `Open ${label} Web in a visible Chrome window with a saved profile and report whether the user is signed in. Needs NABU_BROWSER_ENABLE=1; set NABU_BROWSER_PROXY (e.g. socks5://127.0.0.1:1088) when this machine has no Iranian IP.`,
    {}, WRITE, () => ops.open());
  tool('status', null, 'sign-in status', 'Whether the web app is open and signed in, or which login step it waits on.', {}, { ...READ, openWorldHint: false }, () => ops.status());
  tool('login_start', null, 'start sign-in', 'Type the user\'s mobile number on the login page and continue. The verification code and any 2FA password must be typed by the user in the browser window; never ask for them in chat.',
    { phone: z.string().min(10).max(16).describe('Iranian mobile, e.g. 0912xxxxxxx.') }, WRITE, args => ops.loginStart(args));
  tool('close', null, 'close', 'Close the web app window. The sign-in stays saved.', {}, { ...WRITE, openWorldHint: false }, () => ops.close());

  tool('list_chats', null, 'list chats', 'Chats, groups and channels with chatId, title, username, unread count and whether the user can post.',
    { limit: z.number().int().min(1).max(100).optional(), query: z.string().max(100).optional() }, READ, args => ops.listChats(args));
  tool('read_chat', null, 'read chat', 'Recent messages of one chat, newest first. Pass nextBeforeMessageId as beforeMessageId for older ones.',
    { chatId, limit: z.number().int().min(1).max(100).optional(), beforeMessageId: z.string().max(64).optional() }, READ, args => ops.readChat(args));
  tool('send_message', null, 'send text', 'Send ONE text message from the user\'s own account. No bulk sending. ' + CHAT_WRITE,
    { chatId, text: z.string().min(1).max(4000), replyToMessageId: z.string().max(64).optional(), confirm }, WRITE, args => ops.sendMessage(args));
  tool('send_file', null, 'send file', 'Send ONE file (up to 20 MB) from an https URL or a path inside NABU_MESSAGING_FILE_ROOT; images go as photos. ' + CHAT_WRITE,
    { chatId, fileUrl: z.string().url().optional(), filePath: z.string().max(500).optional(), caption: z.string().max(4000).optional(), confirm },
    WRITE, args => ops.sendFile(args));

  tool('edit_message', 'editText', 'edit', 'Replace the text or caption of one of the user\'s messages. ' + CHAT_WRITE,
    { chatId, messageId: msgId, text: z.string().min(1).max(4000), confirm }, { ...WRITE, idempotentHint: true }, args => ops.editMessage(args));
  tool('delete_messages', 'deleteMessages', 'delete', 'Delete messages; forEveryone (default true) also removes them for the other side where allowed. Cannot be undone. ' + CHAT_WRITE,
    { chatId, messageIds: msgIds, forEveryone: z.boolean().optional(), confirm }, { ...WRITE, destructiveHint: true, idempotentHint: true }, args => ops.deleteMessages(args));
  tool('forward_messages', 'forwardMessages', 'forward', 'Forward up to 10 messages to another chat; the destination must be allowlisted. ' + CHAT_WRITE,
    { fromChatId: chatId, messageIds: msgIds, toChatId: chatId, confirm }, WRITE, args => ops.forwardMessages(args));
  tool('pin_message', 'pinMessage', 'pin/unpin', 'Pin a message, or unpin it with unpin: true. ' + CHAT_WRITE,
    { chatId, messageId: msgId, unpin: z.boolean().optional(), confirm }, { ...WRITE, idempotentHint: true }, args => ops.pinMessage(args));
  tool('mark_read', 'markRead', 'mark read', 'Mark everything in a chat as read for the user.', { chatId }, { ...WRITE, idempotentHint: true }, args => ops.markRead(args));
  tool('send_location', 'sendLocation', 'send location', 'Send one location pin. ' + CHAT_WRITE,
    { chatId, latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180), confirm }, WRITE, args => ops.sendLocation(args));
  tool('send_contact', 'sendContact', 'send contact', 'Send one contact card. ' + CHAT_WRITE,
    { chatId, phone: z.string().min(5).max(20), firstName: z.string().min(1).max(64), lastName: z.string().max(64).optional(), confirm },
    WRITE, args => ops.sendContact(args));
  tool('send_poll', 'sendPoll', 'send poll', 'Send one poll with 2-10 options. ' + CHAT_WRITE,
    { chatId, question: z.string().min(1).max(300), options: z.array(z.string().min(1).max(100)).min(2).max(10),
      anonymous: z.boolean().optional(), multipleAnswers: z.boolean().optional(), confirm }, WRITE, args => ops.sendPoll(args));

  tool('get_chat_info', 'getChatInfo', 'chat details', 'Title, username, type, description, member count and the user\'s role.', { chatId }, READ, args => ops.getChatInfo(args));
  tool('get_members', 'getMembers', 'members', 'Members of a group or channel the user can see (userId, name, username, role).',
    { chatId, limit: z.number().int().min(1).max(200).optional(), query: z.string().max(64).optional() }, READ, args => ops.getMembers(args));
  tool('search_messages', 'searchMessages', 'search', 'Search messages by text in one chat (chatId) or across all chats.',
    { chatId: chatId.optional(), query: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).optional() }, READ, args => ops.searchMessages(args));
  tool('download_media', 'downloadMedia', 'download media', 'Save one message\'s photo, video or file under NABU_MESSAGING_FILE_ROOT/downloads/ and return its path.',
    { chatId, messageId: msgId }, { ...WRITE, openWorldHint: false }, args => ops.downloadMedia(args));
  tool('get_unread', 'getUnread', 'unread', 'Chats with unread messages and their newest unread messages, without marking them read. Poll this to receive messages.',
    { limit: z.number().int().min(1).max(100).optional() }, READ, args => ops.getUnread(args));
  tool('get_contacts', 'getContacts', 'contacts', 'The user\'s contacts (userId, name, username). Phone numbers are not returned.',
    { limit: z.number().int().min(1).max(200).optional(), query: z.string().max(64).optional() }, READ, args => ops.getContacts(args));

  tool('create_chat', 'createChat', 'create group/channel', 'Create one group or channel owned by the user. ' + ACCOUNT_CHANGE,
    { type: z.enum(['group', 'channel']), title: z.string().min(1).max(128), about: z.string().max(255).optional(), confirm }, WRITE, args => ops.createChat(args));
  tool('update_chat', 'updateChat', 'rename/describe', 'Change the title and/or description of a group or channel the user administers. ' + ACCOUNT_CHANGE,
    { chatId, title: z.string().min(1).max(128).optional(), about: z.string().max(255).optional(), confirm }, { ...WRITE, idempotentHint: true }, args => ops.updateChat(args));
  tool('get_invite_link', 'getInviteLink', 'invite link', 'Invite link of a group or channel the user administers.', { chatId }, READ, args => ops.getInviteLink(args));
  tool('join_chat', 'joinChat', 'join', 'Join one group or channel by invite link or @username. ' + ACCOUNT_CHANGE,
    { link: z.string().min(2).max(200), confirm }, WRITE, args => ops.joinChat(args));
  tool('leave_chat', 'leaveChat', 'leave', 'Leave one group or channel. ' + ACCOUNT_CHANGE, { chatId, confirm }, { ...WRITE, destructiveHint: true }, args => ops.leaveChat(args));
  tool('add_members', 'addMembers', 'add members', 'Add up to 5 users to a group or channel the user administers. Only add people who agreed to it. ' + ACCOUNT_CHANGE,
    { chatId, userIds: z.array(z.string().min(1).max(64)).min(1).max(5), confirm }, WRITE, args => ops.addMembers(args));
  tool('remove_member', 'removeMember', 'remove member', 'Remove (ban: true also blocks) one member. ' + ACCOUNT_CHANGE,
    { chatId, userId, ban: z.boolean().optional(), confirm }, { ...WRITE, destructiveHint: true }, args => ops.removeMember(args));
  tool('set_admin', 'setAdmin', 'admin rights', 'Promote one member to admin (isAdmin: true) or demote them. ' + ACCOUNT_CHANGE,
    { chatId, userId, isAdmin: z.boolean().optional(), confirm }, { ...WRITE, idempotentHint: true }, args => ops.setAdmin(args));
}

export function createMessengerServer({ id, label, version = '0.1.0', botAdapter = null, webDriver = null, fetcher }) {
  if (!/^[a-z][a-z0-9]*$/.test(id)) throw new Error('INVALID_MESSENGER_ID');
  const server = new McpServer({ name: `${id}-mcp`, version });
  if (botAdapter) registerBotTools(server, id, label, createBotOps(botAdapter, fetcher));
  if (webDriver) registerWebTools(server, id, label, createWebOps(webDriver));
  return server;
}

export async function runStdio(options) {
  const server = createMessengerServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}
