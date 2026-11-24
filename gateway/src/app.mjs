// Assembles the hosted gateway: panel, NabuAuth sign-in, MCP OAuth, the MCP
// endpoint (Streamable HTTP, stateless) and the internal API for Social.
import fs from 'node:fs';
import express from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createAccounts } from './accounts.mjs';
import { createKeys } from './crypto.mjs';
import { internalRouter } from './internal.mjs';
import { accessLog, log } from './log.mjs';
import { buildMcpServer } from './mcp.mjs';
import { enabledMessengers } from './messengers.mjs';
import { createNabuAuth } from './nabuauth.mjs';
import { createOAuthProvider, SCOPE } from './oauth.mjs';
import { panelRouter } from './panel.mjs';
import { createSafeGet, gatewayFetcher } from './safefetch.mjs';
import { createSessions, parseCookies } from './session.mjs';
import { Store } from './store.mjs';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// deps (tests): store, apiFetch (messenger APIs), safeGet (media downloads), authFetch (NabuAuth).
export function createApp(config, deps = {}) {
  const keys = createKeys(config.secretKey);
  const store = deps.store || new Store(config.dbFile);
  const messengers = enabledMessengers(config.messengers);
  const safeGet = deps.safeGet || createSafeGet({ maxBytes: config.mediaMaxBytes, timeoutMs: config.mediaTimeoutMs });
  const fetcher = gatewayFetcher({ safeGet, apiFetch: deps.apiFetch || fetch });
  const accounts = createAccounts({ store, keys, fetcher, messengers, maxPerOwner: config.maxAccountsPerOwner });
  const nabuauth = createNabuAuth(config.nabuauth, deps.authFetch || fetch);
  const secure = config.baseUrl.startsWith('https://');
  const sessions = createSessions({ keys, store, secure, ttl: config.sessionTtl });
  const oauth = createOAuthProvider({ store, config });
  const mcpUrl = new URL(`${config.baseUrl}/mcp`);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(accessLog);
  app.use(parseCookies);

  app.get(['/health', '/healthz'], (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, service: 'iran-messengers-gateway', version: VERSION,
      messengers: messengers.map(m => m.id), nabuauth: nabuauth.enabled, internal_api: Boolean(config.internalToken) });
  });

  // OAuth for MCP clients: metadata, /register, /authorize, /token, /revoke.
  app.use(mcpAuthRouter({
    provider: oauth.provider,
    issuerUrl: new URL(config.baseUrl),
    resourceServerUrl: mcpUrl,
    scopesSupported: [SCOPE],
    resourceName: 'Iran Messengers MCP',
    clientRegistrationOptions: { clientSecretExpirySeconds: 0 }
  }));
  // Some clients look for the resource metadata at the root as well.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({ resource: mcpUrl.href, authorization_servers: [new URL(config.baseUrl).href], scopes_supported: [SCOPE],
      resource_name: 'Iran Messengers MCP' });
  });

  const bearer = requireBearerAuth({ verifier: oauth.provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });
  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
    const ownerId = req.auth?.extra?.ownerId;
    const server = buildMcpServer({ ownerId, store, accounts, messengers, version: VERSION, panelUrl: `${config.baseUrl}/dashboard` });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log('error', { where: 'mcp', error: String(err?.message || err).slice(0, 120) });
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });
  app.all('/mcp', bearer, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless; use POST.' }, id: null });
  });

  app.use('/internal/v1', internalRouter({ config, store, accounts, messengers }));
  app.use(panelRouter({ config, keys, store, accounts, messengers, sessions, nabuauth, oauth, version: VERSION }));

  app.use((_req, res) => res.status(404).type('text/plain').send('not found'));
  app.use((err, _req, res, _next) => {
    log('error', { where: 'app', error: String(err?.message || err).slice(0, 120) });
    if (!res.headersSent) res.status(err?.status && err.status < 500 ? err.status : 500).type('text/plain').send('error');
  });

  return { app, store, accounts, oauth, keys, messengers };
}
