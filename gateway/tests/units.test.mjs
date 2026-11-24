import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkToken, parseChats } from '../src/accounts.mjs';
import { createKeys, safeEqual } from '../src/crypto.mjs';
import { redactPath } from '../src/log.mjs';
import { createSafeGet, gatewayFetcher, isPublicAddress, makeGuardedLookup } from '../src/safefetch.mjs';
import { Store } from '../src/store.mjs';
import { SECRET } from './helpers.mjs';

test('sealed values round-trip and refuse tampering or another key', () => {
  const keys = createKeys(SECRET);
  const sealed = keys.seal('123:secret-token');
  assert.ok(!sealed.includes('secret-token'));
  assert.equal(keys.open(sealed), '123:secret-token');
  assert.notEqual(keys.seal('same'), keys.seal('same'), 'a fresh IV every time');
  const parts = sealed.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => keys.open(parts.join('.')));
  assert.throws(() => createKeys(`${SECRET}-other`).open(sealed));
  const signed = keys.sign({ a: 1, exp: Math.floor(Date.now() / 1000) + 60 }, 'session');
  assert.equal(keys.unsign(signed, 'session').a, 1);
  assert.equal(keys.unsign(signed, 'flow'), null, 'purposes do not mix');
  assert.equal(keys.unsign(keys.sign({ exp: 1 }, 'session'), 'session'), null, 'expired');
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'abcd'));
});

test('only public addresses count as public', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'not-an-ip']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['1.1.1.1', '89.44.240.182', '2606:4700:4700::1111', '::ffff:1.1.1.1']) assert.equal(isPublicAddress(ip), true, ip);
});

test('media downloads: https only, public hosts only, redirects re-checked, size capped', async () => {
  const hops = [];
  const request = async url => {
    hops.push(url.href);
    if (url.hostname === 'jump.example.com') return { redirect: 'https://127.0.0.1/admin', status: 302 };
    if (url.hostname === 'big.example.com') throw Object.assign(new Error('MEDIA_TOO_LARGE'));
    return { status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from('png') };
  };
  const get = createSafeGet({ request });
  await assert.rejects(get('http://cdn.example.com/a.png'), /MEDIA_URL_MUST_BE_HTTPS/);
  await assert.rejects(get('https://127.0.0.1/a.png'), /MEDIA_URL_NOT_PUBLIC/);
  await assert.rejects(get('https://[::1]/a.png'), /MEDIA_URL_NOT_PUBLIC/);
  await assert.rejects(get('https://localhost/a.png'), /MEDIA_URL_NOT_PUBLIC/);
  await assert.rejects(get('https://coolify:8000/x'), /MEDIA_URL_PORT_NOT_ALLOWED/);
  await assert.rejects(get('https://user:pw@cdn.example.com/x'), /MEDIA_URL_WITH_CREDENTIALS/);
  await assert.rejects(get('https://jump.example.com/a.png'), /MEDIA_URL_NOT_PUBLIC/);
  const ok = await get('https://cdn.example.com/a.png');
  assert.equal(ok.ok, true);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await ok.arrayBuffer()).toString(), 'png');

  // The connect-time check: a public-looking name that resolves to a private address is refused.
  const rebinding = createSafeGet({ lookup: makeGuardedLookup((_h, _o, cb) => cb(null, [{ address: '10.0.0.7', family: 4 }])) });
  await assert.rejects(rebinding('https://evil.example.com/x'), /MEDIA_URL_NOT_PUBLIC/);
  await assert.rejects(get('https://localhost./a.png'), /MEDIA_URL_NOT_PUBLIC/);
});

test('the gateway fetcher sends GETs through the guard and API calls straight through', async () => {
  const seen = [];
  const f = gatewayFetcher({ safeGet: async url => { seen.push(['guard', url]); return {}; }, apiFetch: async (url, init) => { seen.push(['api', url, init.method]); return {}; } });
  await f('https://cdn.example.com/a.jpg', { redirect: 'follow' });
  await f('https://tapi.bale.ai/botX/sendMessage', { method: 'POST', body: '{}' });
  assert.deepEqual(seen, [['guard', 'https://cdn.example.com/a.jpg'], ['api', 'https://tapi.bale.ai/botX/sendMessage', 'POST']]);
});

test('tokens and chat lists are checked before anything is stored', () => {
  assert.equal(checkToken(' 123456:abcDEF-_x '), '123456:abcDEF-_x');
  for (const bad of ['short', '123456 789:abc', '123/../../x:abcdef', 'abc?x=1defgh', 'abc#frag-defgh', 'user@evil.com/x']) {
    assert.throws(() => checkToken(bad), /INVALID_BOT_TOKEN/, bad);
  }
  assert.deepEqual(parseChats('@a\n@b, @a\n\n*'), ['@a', '@b', '*']);
  assert.throws(() => parseChats(Array.from({ length: 51 }, (_, i) => `@c${i}`)), /TOO_MANY_ALLOWED_CHATS/);
});

test('the store survives a restart, writes 0600 and keeps only hashes of OAuth secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irm-'));
  const file = path.join(dir, 'db.json');
  try {
    const s = new Store(file);
    const o = s.ensureOwner({ sub: 'sub-1', email: 'A@B.com', emailVerified: true });
    s.putToken('irm_at_secret', { kind: 'access', owner_id: o.id, pair_id: 'p', expires_at: Math.floor(Date.now() / 1000) + 60 });
    s.putCode('the-code', { client_id: 'c', expires_at: Math.floor(Date.now() / 1000) + 60 });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('irm_at_secret') && !raw.includes('the-code'));
    const again = new Store(file);
    assert.equal(again.ownerBySub('sub-1').email, 'a@b.com');
    assert.equal(again.token('irm_at_secret').owner_id, o.id);
    assert.equal(again.takeCode('the-code').client_id, 'c');
    assert.equal(again.takeCode('the-code'), null, 'a code works once');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('access log paths hide account keys and never carry a query', () => {
  assert.equal(redactPath('/internal/v1/accounts/irm_bale_abcdef0123/publish?x=1'), '/internal/v1/accounts/irm_bale_…/publish');
  assert.equal(redactPath('/internal/v1/owners/accounts?sub=s&email=e'), '/internal/v1/owners/accounts');
  assert.equal(redactPath('/oauth/consent/abc123'), '/oauth/consent/…');
  assert.equal(redactPath('/internal/v1/connect/methods'), '/internal/v1/connect/methods');
});
