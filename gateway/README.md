# Iran Messengers MCP gateway (hosted)

One hosted, multi-tenant service for all five messengers in this family (Bale, Eitaa, Rubika, Soroush Plus, Gap). People sign in with their Nabux account, connect their own bots in a small Persian-first panel, and then use them from:

- any MCP client (Claude, ChatGPT, Cursor, Claude Code) at `https://ir.nabuxai.com/mcp`, with OAuth;
- **Social MCP** (`social.nabuxai.com`), which links these bots automatically and publishes to them next to the other networks.

It runs the core's bot operations (`../src/bot.mjs`) with each account's own token and locks, and the official bot adapters from the published messenger packages. It has to run on a server with an Iranian IP: most of these bot APIs answer nothing else.

**Phase 1 is bot mode only.** Web mode (the person's own account in a server-side Chrome with a ticketed live view for the sign-in code) is not in this service yet; the panel says so and points to the local `npx -y @nabuxai/<name>-mcp` servers for it.

## What an account is

One official bot on one messenger, owned by one Nabux user (keyed by the NabuAuth `sub`; a verified email only adopts an existing owner when a sub is new).

| Field | |
|---|---|
| `account_key` | `irm_<messenger>_<32 random a-z0-9>`; opaque, never chosen by a person |
| token | checked with `getMe` where the messenger has it (Gap has none), then sealed with AES-256-GCM under a key derived from `APP_SECRET_KEY`; never shown again, never logged |
| default chat | where Social publishes, and where tools go when called without a `chatId` |
| allowed chats | the chats it may write to (`*` = any); empty = none |
| sending | off unless switched on: the per-account form of `NABU_MESSAGING_ENABLE_SEND` |

Every write keeps the core's three locks, per account: `confirm: true` (AI tools), the chat on the allowed chats, and sending switched on. Adding a bot with a default chat and "allow sending" ticked (the panel's default, and what a connect from Social does) puts that one chat on the list and turns sending on, because the owner has just named it as the place to publish.

## MCP

`POST /mcp`, Streamable HTTP, stateless (a server per request, so the tool list always matches the owner's bots). OAuth 2.1 with dynamic client registration (`/register`), PKCE (`/authorize` → one-click consent behind Sign in with Nabux → `/token`), refresh rotation and `/revoke`; metadata at `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp`. A personal token (panel → Connect to AI) works as an `Authorization: Bearer` header for clients without OAuth.

Tools: `iran_accounts`, and for each messenger the owner has a bot on, the core's bot tools with an optional `account` argument (account key or `@username`; needed only with two bots on one messenger) and an optional `chatId` (default chat when left out): `<id>_bot_preview_message`, `_get_me`, `_get_chat`, `_get_updates`, `_send_message`, `_send_file` (https URL only), `_edit_message`, `_delete_message`, as far as the messenger supports them.

## Internal API (Social)

All routes need `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` (constant-time compare; 401 on a wrong token, 404 while it is unset). Social keeps the same value as `SOCIAL_<PROVIDER>_TOKEN`.

```http
GET  /internal/v1/owners/accounts?sub=<sub>&email=<verified email>
→ {"ok":true,"provider":"iran","accounts":[{"account_key":"irm_bale_…","messenger":"bale","label":"کانال نابکس",
    "kind":"bot","mode":"official","status":"connected","connected_at":"…","username":"…","default_chat":"@…","publish_ready":true}]}

GET  /internal/v1/accounts/{account_key}           → {"ok":true,"account":{…, "allowed_chats":[…],"send_enabled":true,"publish":["text","image","video"]}}
POST /internal/v1/accounts/{account_key}/publish   {"kind":"text|image|video","text":"…","media_url":"https://…","title":"…","link":"…"}
POST /internal/v1/accounts/{account_key}/publish/text   {"text":"…"}
POST /internal/v1/accounts/{account_key}/publish/image  {"image_url":"https://…","caption":"…"}
→ 200 {"ok":true,"provider":"iran","messenger":"bale","kind":"text","chat_id":"@…","remote_id":"7","result":{…}}
→ 400 {"detail":"SEND_DISABLED_BY_DEFAULT_…|RECIPIENT_NOT_ALLOWLISTED_…|DEFAULT_CHAT_NOT_SET_…|media_url_required|…"}
→ 502 {"detail":"PROVIDER_…","provider_detail":"…"}
```

Publishing always goes to the account's default chat. Media URLs are downloaded by the gateway: https on port 443 only, every resolved address must be public (checked at connect time, so DNS rebinding does not help), redirects re-checked, size capped by `MEDIA_MAX_BYTES`.

Connect from Social (the v1 connect contract): `GET /internal/v1/connect/methods[?messenger=bale]` lists one `bot_token` method per messenger (`messenger` field, `key` `bale.bot_token`, fields `token` + `default_chat_id`, mode `official`). `POST /internal/v1/connect/start` with `{"owner":{sub,email,email_verified,name},"method":"bot_token","messenger":"bale","fields":{…}}` (or `"method":"bale.bot_token"`) answers `{"status":"done","account":{…}}` or `{"status":"error","error":{"fa","en"},"code":"BOT_TOKEN_REJECTED","retry":true}` at once; bot tokens need no further steps, so `/connect/{session}` answers 404.

## Environment

| Variable | Default | |
|---|---|---|
| `PUBLIC_BASE_URL` | `https://ir.nabuxai.com` | issuer, MCP URL, redirect URIs |
| `APP_SECRET_KEY` | — (required, ≥ 32 chars) | seals bot tokens and signs cookies; changing it orphans every stored bot |
| `INTERNAL_SERVICE_TOKEN` | empty (internal API off) | shared with Social |
| `NABUAUTH_URL` / `NABUAUTH_CLIENT_ID` / `NABUAUTH_CLIENT_SECRET` / `NABUAUTH_REDIRECT_URI` / `NABUAUTH_SCOPES` | `https://auth.nabuxai.com` / — / — / `<base>/auth/nabu/callback` / `openid profile email` | Sign in with Nabux (client `iran-mcp`) |
| `DATA_DIR` | `/data` | the state file `iran-gateway.json` (mode 0600) |
| `PROVIDER_ID` | `iran` | the `provider` Social sees |
| `MESSENGERS` | `bale,eitaa,rubika,soroushplus,gap` | which messengers are offered |
| `CONNECT_RETURN_ORIGINS` | `https://social.nabuxai.com` | reserved for redirect-type connect methods |
| `ACCESS_TOKEN_TTL` / `REFRESH_TOKEN_TTL` / `AUTH_CODE_TTL` / `SESSION_TTL` | 3600 / 7776000 / 300 / 2592000 | seconds |
| `MEDIA_MAX_BYTES` / `MEDIA_TIMEOUT_MS` | 52428800 / 30000 | media downloads |
| `MAX_ACCOUNTS_PER_OWNER` | 50 | |
| `TRUST_PROXY` | 1 | hops of reverse proxy in front (Traefik) |
| `NABU_MESSAGING_TIMEOUT_MS`, `BALE_API_BASE`, `EITAA_API_BASE`, `RUBIKA_API_BASE`, `SOROUSHPLUS_API_BASE`, `GAP_API_BASE` | official hosts | read by the core and the adapters |

## Run and deploy

```bash
cd gateway && npm install && npm test
APP_SECRET_KEY=$(openssl rand -hex 32) PUBLIC_BASE_URL=http://localhost:8000 DATA_DIR=./data npm start
```

Docker: `docker build -f gateway/Dockerfile .` from the repository root. Coolify: Docker Compose build pack, base directory `/gateway`, compose file `/docker-compose.coolify.yml`, domain `https://ir.nabuxai.com` on service `iran-gateway` port 8000, on a server in Iran. Run one replica: the state is one JSON file on the `/data` volume. Health: `GET /healthz`.

Logs are one JSON line per event: paths without query strings and with account keys cut to their prefix; never tokens, codes, cookies, sub/email or message bodies.
