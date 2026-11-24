// MCP OAuth 2.1 for Claude, ChatGPT and other connectors: dynamic client
// registration, authorization code + PKCE, refresh rotation and revocation
// (the SDK's mcpAuthRouter drives the endpoints; this is its provider). The
// authorization step is a one-click consent page behind Sign in with Nabux.
// Codes and tokens are stored as SHA-256 hashes only.
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { randomString, randomToken } from './crypto.mjs';

export const SCOPE = 'messengers';
export const PERSONAL_CLIENT_ID = 'personal-token';
const TXN_TTL_MS = 10 * 60 * 1000;
const PERSONAL_EXPIRY = 100 * 365 * 86400;
const now = () => Math.floor(Date.now() / 1000);

export function createOAuthProvider({ store, config }) {
  const transactions = new Map();

  const sweep = () => {
    const limit = Date.now() - TXN_TTL_MS;
    for (const [id, t] of transactions) if (t.created < limit) transactions.delete(id);
  };

  function issue(clientId, ownerId, scopes, resource) {
    const access = `irm_at_${randomToken(32)}`;
    const refresh = `irm_rt_${randomToken(32)}`;
    const pair = randomString(16);
    const t = now();
    store.putToken(access, { kind: 'access', client_id: clientId, owner_id: ownerId, scopes, pair_id: pair, resource: resource || null,
      expires_at: t + config.accessTokenTtl });
    store.putToken(refresh, { kind: 'refresh', client_id: clientId, owner_id: ownerId, scopes, pair_id: pair, resource: resource || null,
      expires_at: t + config.refreshTokenTtl });
    return { access_token: access, token_type: 'Bearer', expires_in: config.accessTokenTtl, scope: scopes.join(' '), refresh_token: refresh };
  }

  const provider = {
    clientsStore: {
      getClient: id => store.client(id) || undefined,
      registerClient: client => store.putClient({ ...client, client_name: String(client.client_name || '').slice(0, 100) || undefined })
    },

    // Park the request and send the person to the consent page.
    async authorize(client, params, res) {
      sweep();
      const id = randomToken(24);
      transactions.set(id, { client_id: client.client_id, client_name: client.client_name || client.client_id,
        redirect_uri: params.redirectUri, state: params.state, challenge: params.codeChallenge,
        resource: params.resource ? params.resource.href : null, created: Date.now() });
      res.redirect(302, `/oauth/consent/${id}`);
    },

    async challengeForAuthorizationCode(client, code) {
      const r = store.peekCode(code);
      if (!r || r.client_id !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
      return r.challenge;
    },

    async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
      const r = store.takeCode(code);
      if (!r || r.client_id !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
      if (redirectUri && redirectUri !== r.redirect_uri) throw new InvalidGrantError('redirect_uri does not match');
      if (!store.owner(r.owner_id)) throw new InvalidGrantError('Owner no longer exists');
      return issue(client.client_id, r.owner_id, [SCOPE], r.resource);
    },

    async exchangeRefreshToken(client, refreshToken) {
      const r = store.token(refreshToken);
      if (!r || r.kind !== 'refresh' || r.client_id !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
      store.revokePair(r.pair_id);
      return issue(client.client_id, r.owner_id, [SCOPE], r.resource);
    },

    async verifyAccessToken(token) {
      const r = store.token(token);
      if (!r || r.kind !== 'access' || !store.owner(r.owner_id)) throw new InvalidTokenError('Invalid or expired token');
      return { token, clientId: r.client_id, scopes: r.scopes, expiresAt: r.expires_at || now() + PERSONAL_EXPIRY,
        extra: { ownerId: r.owner_id } };
    },

    async revokeToken(client, { token }) {
      const r = store.token(token);
      if (r && r.client_id === client.client_id) store.revokePair(r.pair_id);
    }
  };

  return {
    provider,

    transaction(id) { sweep(); return transactions.get(String(id || '')) || null; },

    // The person approved or denied; answer the client with a code or an error.
    finish(id, ownerId, approved) {
      const t = transactions.get(id);
      transactions.delete(id);
      if (!t) return null;
      const url = new URL(t.redirect_uri);
      if (approved) {
        const code = randomToken(32);
        store.putCode(code, { client_id: t.client_id, owner_id: ownerId, challenge: t.challenge, redirect_uri: t.redirect_uri,
          resource: t.resource, expires_at: now() + config.authCodeTtl });
        url.searchParams.set('code', code);
      } else {
        url.searchParams.set('error', 'access_denied');
      }
      if (t.state) url.searchParams.set('state', t.state);
      return url.href;
    },

    issuePersonalToken(ownerId) {
      const token = `irm_pt_${randomToken(32)}`;
      store.putToken(token, { kind: 'access', client_id: PERSONAL_CLIENT_ID, owner_id: ownerId, scopes: [SCOPE], pair_id: randomString(16),
        label: 'personal', expires_at: null });
      return token;
    }
  };
}
