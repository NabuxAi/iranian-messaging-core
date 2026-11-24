// The MCP server one owner sees: the core's bot tools (<id>_bot_send_message,
// …) for every messenger the owner has a bot on, with an `account` argument to
// pick the bot, plus iran_accounts to list them. Built per request (stateless
// Streamable HTTP), so the tool list always matches the owner's accounts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { can } from './messengers.mjs';
import { log } from './log.mjs';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const ok = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const fail = err => ({ isError: true, content: [{ type: 'text', text: err.message + (err.detail ? ` (${err.detail})` : '') }] });

export function resolveAccount(accounts, messengerId, wanted) {
  const mine = accounts.filter(a => a.messenger === messengerId);
  if (!mine.length) throw new Error(`NO_${messengerId.toUpperCase()}_ACCOUNT_CONNECT_ONE_IN_THE_PANEL`);
  const w = String(wanted ?? '').trim();
  if (!w) {
    if (mine.length === 1) return mine[0];
    throw new Error(`ACCOUNT_REQUIRED_ONE_OF: ${mine.map(a => a.key).join(', ')}`);
  }
  const name = w.replace(/^@/, '').toLowerCase();
  const found = mine.find(a => a.key === w) || mine.find(a => a.username && a.username.toLowerCase() === name);
  if (!found) throw new Error('ACCOUNT_NOT_FOUND_SEE_IRAN_ACCOUNTS');
  return found;
}

export function buildMcpServer({ ownerId, store, accounts, messengers, version, panelUrl }) {
  const server = new McpServer({ name: 'iran-messengers', version });
  const owned = () => store.accountsOf(ownerId);
  const confirm = z.boolean().describe('Must be true, and only after the user has explicitly approved this exact action.');

  const tool = (name, title, description, inputSchema, annotations, handler) =>
    server.registerTool(name, { title, description, inputSchema, annotations }, async args => {
      try {
        const out = await handler(args ?? {});
        log('tool', { tool: name, ok: true });
        return ok(out);
      } catch (err) {
        log('tool', { tool: name, ok: false, error: String(err.message).slice(0, 80) });
        return fail(err);
      }
    });

  tool('iran_accounts', 'Iranian messengers: accounts',
    'Your connected Iranian messenger accounts (Bale, Eitaa, Rubika, Soroush Plus, Gap): account key, messenger, bot, default chat, the chats it may write to and whether sending is on. Bots are added and their write permissions set only in the panel.',
    {}, { ...READ, openWorldHint: false },
    () => ({ accounts: owned().map(a => accounts.view(a)), panel: panelUrl,
      note: 'Writing needs confirm: true, the chat on the account\'s allowed chats and sending turned on for the account; change those in the panel.' }));

  const present = new Set(owned().filter(a => a.mode !== 'web').map(a => a.messenger));
  for (const m of messengers) {
    if (!present.has(m.id)) continue;
    const id = m.id;
    const has = c => can(m, c);
    const account = z.string().max(80).optional()
      .describe(`account_key from iran_accounts or the bot's @username. Optional when you have one ${m.label} bot.`);
    const chatId = z.string().min(1).max(128).describe(`${m.label} chat, group or channel id for the bot.`);
    const chatOrDefault = chatId.optional().describe(`${m.label} chat id. Optional: the account's default chat when left out.`);
    const messageId = z.string().min(1).max(64).describe('Id of a message this bot sent.');
    const pick = args => resolveAccount(owned().filter(a=>a.mode!=='web'), id, args.account);
    const target = (a, args) => {
      const chat = args.chatId || a.default_chat;
      if (!chat) throw new Error('CHAT_ID_REQUIRED_NO_DEFAULT_CHAT_SET');
      return String(chat);
    };
    const BOT_WRITE = 'Needs confirm: true, the chat on the account\'s allowed chats and sending turned on for the account (both set in the panel).';

    tool(`${id}_bot_preview_message`, `${m.label} bot: preview`, 'Check whether a text message would be sent, without sending.',
      { account, chatId: chatOrDefault, text: z.string().min(1).max(4000) }, { ...READ, openWorldHint: false },
      args => { const a = pick(args); return { account_key: a.key, ...accounts.ops(a).preview({ chatId: target(a, args), text: args.text }) }; });
    if (has('get_me')) {
      tool(`${id}_bot_get_me`, `${m.label} bot: who am I`, 'Check the bot token and return the bot id, username and name.',
        { account }, READ, args => accounts.ops(pick(args)).getMe());
    }
    if (has('get_chat')) {
      tool(`${id}_bot_get_chat`, `${m.label} bot: chat info`, 'Type, title and username of a chat the bot can see.',
        { account, chatId: chatOrDefault }, READ, args => { const a = pick(args); return accounts.ops(a).getChat({ chatId: target(a, args) }); });
    }
    if (has('get_updates')) {
      tool(`${id}_bot_get_updates`, `${m.label} bot: incoming`, 'Messages and events the bot received. Pass nextOffset as offset for newer ones. Marks earlier updates as delivered.',
        { account, offset: z.string().max(128).optional(), limit: z.number().int().min(1).max(100).optional() },
        { ...READ, idempotentHint: false }, args => accounts.ops(pick(args)).getUpdates(args));
    }
    if (has('send_text')) {
      tool(`${id}_bot_send_message`, `${m.label} bot: send text`, 'Send ONE text message through the bot. No bulk sending. ' + BOT_WRITE,
        { account, chatId: chatOrDefault, text: z.string().min(1).max(4000), replyToMessageId: z.string().max(64).optional(), confirm },
        WRITE, args => { const a = pick(args); return accounts.ops(a).sendMessage({ ...args, chatId: target(a, args) }); });
    }
    if (has('send_file')) {
      tool(`${id}_bot_send_file`, `${m.label} bot: send file`, 'Send ONE file from a public https URL (photo, video, audio, voice or document). ' + BOT_WRITE,
        { account, chatId: chatOrDefault, fileUrl: z.string().url().max(2000),
          kind: z.enum(['photo', 'video', 'audio', 'voice', 'document']).optional(), caption: z.string().max(4000).optional(), confirm },
        WRITE, args => { const a = pick(args); return accounts.ops(a).sendFile({ chatId: target(a, args), fileUrl: args.fileUrl, kind: args.kind, caption: args.caption, confirm: args.confirm }); });
    }
    if (has('edit_text')) {
      tool(`${id}_bot_edit_message`, `${m.label} bot: edit`, 'Replace the text of a message the bot sent. ' + BOT_WRITE,
        { account, chatId: chatOrDefault, messageId, text: z.string().min(1).max(4000), confirm }, { ...WRITE, idempotentHint: true },
        args => { const a = pick(args); return accounts.ops(a).editMessage({ ...args, chatId: target(a, args) }); });
    }
    if (has('delete')) {
      tool(`${id}_bot_delete_message`, `${m.label} bot: delete`, 'Delete a message the bot sent. Cannot be undone. ' + BOT_WRITE,
        { account, chatId: chatOrDefault, messageId, confirm }, { ...WRITE, destructiveHint: true, idempotentHint: true },
        args => { const a = pick(args); return accounts.ops(a).deleteMessage({ ...args, chatId: target(a, args) }); });
    }
  }
  for(const m of messengers){
    const web=()=>owned().filter(a=>a.mode==='web');
    if(!web().some(a=>a.messenger===m.id))continue;
    const account=z.string().max(80).optional(),chatId=z.string().min(1).max(128);
    const limit=z.number().int().min(1).max(50).optional();
    const pick=args=>resolveAccount(web(),m.id,args.account);
    tool(m.id+'_web_list_chats',m.label+' Web: list chats','List chats through your connected local browser.',
      {account,limit,query:z.string().max(100).optional()},READ,args=>accounts.ops(pick(args)).listChats(args));
    tool(m.id+'_web_read_chat',m.label+' Web: read chat','Read one chat using your connected local browser.',
      {account,chatId,limit},READ,args=>accounts.ops(pick(args)).readChat(args));
    tool(m.id+'_web_send_message',m.label+' Web: send text','Send one text message. Requires enabled sending, exact recipient permission, explicit approval, and local device confirmation. Never retry automatically after uncertain delivery.',
      {account,chatId,text:z.string().min(1).max(4000),confirm},WRITE,args=>accounts.ops(pick(args)).sendMessage(args));
  }
  return server;
}
