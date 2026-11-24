// Small crypto helpers: sealed secrets (AES-256-GCM), signed values (HMAC),
// opaque keys, token hashes and constant-time comparison.
import crypto from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomString(length = 32, alphabet = ALPHABET) {
  let out = '';
  while (out.length < length) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

// Constant time for any two strings: both sides are hashed to the same length first.
export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const y = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(x, y) && String(a ?? '').length === String(b ?? '').length;
}

export function createKeys(secret) {
  if (!secret || secret.length < 16) throw new Error('APP_SECRET_KEY is too short');
  const derive = purpose => crypto.createHash('sha256').update(`iran-gateway:${purpose}:${secret}`).digest();
  const sealKey = derive('seal');

  return {
    // "v1.<iv>.<tag>.<ciphertext>", all base64url. Used for bot tokens at rest.
    seal(plaintext) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', sealKey, iv);
      const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
    },

    open(sealed) {
      const [version, iv, tag, data] = String(sealed || '').split('.');
      if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('SEALED_VALUE_INVALID');
      const decipher = crypto.createDecipheriv('aes-256-gcm', sealKey, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    },

    // "v1.<payload>.<hmac>" for cookies and short-lived flows.
    sign(payload, purpose = 'flow') {
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = crypto.createHmac('sha256', derive(`sign:${purpose}`)).update(body).digest('base64url');
      return `v1.${body}.${sig}`;
    },

    unsign(value, purpose = 'flow') {
      const parts = String(value || '').split('.');
      if (parts.length !== 3 || parts[0] !== 'v1') return null;
      const good = crypto.createHmac('sha256', derive(`sign:${purpose}`)).update(parts[1]).digest('base64url');
      if (!safeEqual(good, parts[2])) return null;
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (!payload || typeof payload !== 'object') return null;
        if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
        return payload;
      } catch { return null; }
    },

    mac(value, purpose) {
      return crypto.createHmac('sha256', derive(`mac:${purpose}`)).update(String(value)).digest('hex');
    }
  };
}

export function pkcePair() {
  const verifier = randomToken(48);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { state: randomToken(24), verifier, challenge };
}
