// Everything the gateway reads from the environment, in one place.
import path from 'node:path';

const int = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};
const list = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  const baseUrl = (env.PUBLIC_BASE_URL || 'https://ir.nabuxai.com').trim().replace(/\/+$/, '');
  const dataDir = (env.DATA_DIR || '/data').trim();
  return {
    appName: env.APP_NAME || 'Iran Messengers MCP',
    baseUrl,
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 8000),
    dataDir,
    webCompanionEnabled: env.IRAN_WEB_COMPANION_ENABLED === "1",
    dbFile: env.DB_FILE || path.join(dataDir, 'iran-gateway.json'),
    secretKey: env.APP_SECRET_KEY || '',
    internalToken: (env.INTERNAL_SERVICE_TOKEN || '').trim(),
    providerId: (env.PROVIDER_ID || 'iran').trim(),
    returnOrigins: list(env.CONNECT_RETURN_ORIGINS || 'https://social.nabuxai.com'),
    trustProxy: env.TRUST_PROXY === undefined ? 1 : int(env.TRUST_PROXY, 1),
    accessTokenTtl: int(env.ACCESS_TOKEN_TTL, 3600),
    refreshTokenTtl: int(env.REFRESH_TOKEN_TTL, 90 * 86400),
    authCodeTtl: int(env.AUTH_CODE_TTL, 300),
    sessionTtl: int(env.SESSION_TTL, 30 * 86400),
    mediaMaxBytes: int(env.MEDIA_MAX_BYTES, 50 * 1024 * 1024),
    mediaTimeoutMs: int(env.MEDIA_TIMEOUT_MS, 30000),
    maxAccountsPerOwner: int(env.MAX_ACCOUNTS_PER_OWNER, 50),
    messengers: list(env.MESSENGERS || 'bale,eitaa,rubika,soroushplus,gap'),
    nabuauth: {
      url: (env.NABUAUTH_URL || 'https://auth.nabuxai.com').trim().replace(/\/+$/, ''),
      clientId: (env.NABUAUTH_CLIENT_ID || '').trim(),
      clientSecret: (env.NABUAUTH_CLIENT_SECRET || '').trim(),
      redirectUri: (env.NABUAUTH_REDIRECT_URI || '').trim() || `${baseUrl}/auth/nabu/callback`,
      scopes: (env.NABUAUTH_SCOPES || '').trim() || 'openid profile email'
    }
  };
}

export function validateConfig(config) {
  if ((config.secretKey || '').length < 32) throw new Error('APP_SECRET_KEY must be set to a random value of at least 32 characters');
  if (!/^https?:\/\//.test(config.baseUrl)) throw new Error('PUBLIC_BASE_URL must start with https://');
}
