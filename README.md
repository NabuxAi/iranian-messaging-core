# @nabuxai/iranian-messaging-core

The shared core of the NabuxAI MCP servers for Iranian messengers. You normally install one of the messenger packages, not this one:

| Messenger | Package | Repository |
|---|---|---|
| Eitaa (ایتا) | [`@nabuxai/eitaa-mcp`](https://www.npmjs.com/package/@nabuxai/eitaa-mcp) | [NabuxAi/eitaa-mcp](https://github.com/NabuxAi/eitaa-mcp) |
| Rubika (روبیکا) | [`@nabuxai/rubika-mcp`](https://www.npmjs.com/package/@nabuxai/rubika-mcp) | [NabuxAi/rubika-mcp](https://github.com/NabuxAi/rubika-mcp) |
| Bale (بله) | [`@nabuxai/bale-mcp`](https://www.npmjs.com/package/@nabuxai/bale-mcp) | [NabuxAi/bale-mcp](https://github.com/NabuxAi/bale-mcp) |
| Soroush Plus (سروش پلاس) | [`@nabuxai/soroushplus-mcp`](https://www.npmjs.com/package/@nabuxai/soroushplus-mcp) | [NabuxAi/soroushplus-mcp](https://github.com/NabuxAi/soroushplus-mcp) |
| Gap (گپ) | [`@nabuxai/gap-mcp`](https://www.npmjs.com/package/@nabuxai/gap-mcp) | [NabuxAi/gap-mcp](https://github.com/NabuxAi/gap-mcp) |

## What is in here

- `createMessengerServer({ id, label, botAdapter, webDriver })` builds a stdio MCP server for one messenger. Tools are prefixed with the messenger id (`eitaa_web_send_message`, `rubika_bot_send_message`, …) so several servers can run side by side. A web tool is only registered when the driver implements it.
- **Bot mode** (`createBotOps`): the messenger's official bot API.
- **Web mode** (`createWebOps`): the messenger's web app, driven in a local Chrome window with the user's own signed-in account. The user signs in once; the verification code and any 2FA password are always typed by the user in that window.
- The safety locks shared by every messenger (see below), `telegramLike()` for Telegram-style bot APIs, and helpers for files and HTTP.

## Safety locks

| Action | Needs |
|---|---|
| Reading | the bot token (bot mode) or a signed-in window and `NABU_BROWSER_ENABLE=1` (web mode) |
| Writing to a chat (send, edit, delete, pin, forward, polls, …) | `confirm: true`, the chat in `<ID>_ALLOWED_CHAT_IDS` (bot) or `<ID>_WEB_ALLOWED_CHATS` (web), and `NABU_MESSAGING_ENABLE_SEND=1` |
| Account changes (create/join/leave chats, members, admins) | all of the above plus `NABU_WEB_ALLOW_ACCOUNT_CHANGES=1` |

There is no bulk sending: one chat per call and at most 5 members added per call. See [SECURITY.md](SECURITY.md).

## Writing a driver

A web driver is an object with `id`, `label`, `url`, `host`, `loginState(page)`, `loginStart(page, digits)`, `listChats`, `readChat`, `sendText`, `sendFile`, and any of the optional operations in `OPTIONAL_OPS` (`editText`, `deleteMessages`, `forwardMessages`, `pinMessage`, `markRead`, `sendLocation`, `sendContact`, `sendPoll`, `getChatInfo`, `getMembers`, `searchMessages`, `downloadMedia`, `getUnread`, `getContacts`, `createChat`, `updateChat`, `getInviteLink`, `joinChat`, `leaveChat`, `addMembers`, `removeMember`, `setAdmin`). Each receives the Playwright `page` and validated arguments; the locks have already been applied.

## License

MIT © NabuxAI. Not affiliated with or endorsed by any of the messengers above.
