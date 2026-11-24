// Downloads a media URL someone else gave us (an AI client, Social) without
// letting it reach this server's own network: https on port 443 only, every
// address the name resolves to must be public, the check happens at connect
// time (so a DNS answer cannot change between check and use), redirects are
// followed by hand and checked again, and the body is capped while it streams.
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) blocked.addSubnet(addr, bits, 'ipv6');

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    // IPv4-mapped in hex (::ffff:7f00:1): refuse rather than decode. (A
    // ::ffff:0:0/96 rule in the BlockList would also match every IPv4 check.)
    if (/^(0{0,4}:){0,5}:?ffff:/i.test(address) || /^::ffff:/i.test(address)) return false;
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

export class FetchBlocked extends Error {}

// The connect-time check: every address the name resolves to must be public.
export function makeGuardedLookup(resolve = dns.lookup) {
  return function guardedLookup(hostname, options, callback) {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) {
        const e = new FetchBlocked('MEDIA_URL_NOT_PUBLIC');
        e.code = 'EBLOCKED';
        return callback(e);
      }
      if (options && options.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function checkUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new FetchBlocked('INVALID_MEDIA_URL'); }
  if (url.protocol !== 'https:') throw new FetchBlocked('MEDIA_URL_MUST_BE_HTTPS');
  if (url.username || url.password) throw new FetchBlocked('MEDIA_URL_WITH_CREDENTIALS');
  if (url.port && url.port !== '443') throw new FetchBlocked('MEDIA_URL_PORT_NOT_ALLOWED');
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (net.isIP(host) && !isPublicAddress(host)) throw new FetchBlocked('MEDIA_URL_NOT_PUBLIC');
  if (!net.isIP(host) && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || !host.includes('.'))) {
    throw new FetchBlocked('MEDIA_URL_NOT_PUBLIC');
  }
  return url;
}

function getOnce(url, { maxBytes, timeoutMs, lookup }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', lookup, timeout: timeoutMs,
      headers: { 'User-Agent': 'NabuxIranGateway/0.1', Accept: '*/*' } }, res => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: res.headers.location, status });
      }
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > maxBytes) { res.destroy(); return reject(new FetchBlocked('MEDIA_TOO_LARGE')); }
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { res.destroy(); reject(new FetchBlocked('MEDIA_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new FetchBlocked('MEDIA_DOWNLOAD_TIMEOUT')));
    req.on('error', err => reject(err instanceof FetchBlocked ? err
      : err.code === 'EBLOCKED' ? new FetchBlocked('MEDIA_URL_NOT_PUBLIC') : new FetchBlocked('MEDIA_DOWNLOAD_FAILED')));
    req.end();
  });
}

// A fetch()-shaped GET: { ok, status, headers.get(), arrayBuffer(), json() }.
export function createSafeGet({ maxBytes = 50 * 1024 * 1024, timeoutMs = 30000, maxRedirects = 3, lookup = makeGuardedLookup(), request = getOnce } = {}) {
  return async function safeGet(raw) {
    let url = checkUrl(String(raw));
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const res = await request(url, { maxBytes, timeoutMs, lookup });
      if (res.redirect) { url = checkUrl(new URL(res.redirect, url).href); continue; }
      const headers = res.headers || {};
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        url: url.href,
        headers: { get: name => { const v = headers[String(name).toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; } },
        arrayBuffer: async () => res.body.buffer.slice(res.body.byteOffset, res.body.byteOffset + res.body.byteLength),
        json: async () => JSON.parse(res.body.toString('utf8'))
      };
    }
    throw new FetchBlocked('MEDIA_TOO_MANY_REDIRECTS');
  };
}

// The fetcher handed to the core's bot operations. Messenger API calls are
// POSTs to the adapter's fixed hosts; the only plain GET the core makes is the
// download of a fileUrl, which is user input, so it goes through safeGet.
export function gatewayFetcher({ safeGet, apiFetch = fetch }) {
  return (url, init = {}) => {
    const method = String(init.method || 'GET').toUpperCase();
    if (method === 'GET' && init.body == null) return safeGet(url);
    return apiFetch(url, init);
  };
}
