// Panel sessions: a signed, HttpOnly cookie naming the owner, and a CSRF
// token bound to that cookie (the same scheme as the Nabux MCP Console).
import { safeEqual } from './crypto.mjs';

export const SESSION_COOKIE = 'irm_session';
export const FLOW_COOKIE = 'irm_nabu_flow';
export const SSO_GUARD_COOKIE = 'irm_sso_tried';

export function parseCookies(req, _res, next) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = ''; }
  }
  req.cookies = out;
  next();
}

export function safeNext(value, fallback = '/dashboard') {
  const next = String(value || '');
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\') || next.length > 500 || /[\x00-\x1f]/.test(next)) return fallback;
  return next;
}

export function createSessions({ keys, store, secure, ttl }) {
  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure, path: '/' };
  return {
    cookieOpts,

    start(res, ownerId) {
      const value = keys.sign({ oid: ownerId, n: keys.mac(Date.now() + Math.random(), 'nonce').slice(0, 16),
        exp: Math.floor(Date.now() / 1000) + ttl }, 'session');
      res.cookie(SESSION_COOKIE, value, { ...cookieOpts, maxAge: ttl * 1000 });
    },

    end(res) { res.clearCookie(SESSION_COOKIE, { path: '/' }); },

    owner(req) {
      if (req._owner !== undefined) return req._owner;
      const payload = keys.unsign(req.cookies?.[SESSION_COOKIE], 'session');
      req._owner = payload ? store.owner(payload.oid) : null;
      return req._owner;
    },

    csrf(req) { return keys.mac(req.cookies?.[SESSION_COOKIE] || '', 'csrf').slice(0, 32); },

    csrfOk(req, value) {
      if (!req.cookies?.[SESSION_COOKIE] || !value) return false;
      return safeEqual(this.csrf(req), String(value));
    }
  };
}
