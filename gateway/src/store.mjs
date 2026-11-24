// The gateway's state: owners, messenger accounts, OAuth clients, codes and
// tokens. One JSON file under DATA_DIR, rewritten atomically (temp file +
// rename, mode 0600) after every change. Secrets inside are sealed (bot
// tokens) or hashed (OAuth codes and tokens); nothing here is usable as-is.
//
// This fits one gateway instance with a few thousand accounts. Run a single
// replica: two processes writing the same file would lose each other's writes.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './crypto.mjs';

const EMPTY = () => ({ version: 1, seq: 0, owners: [], accounts: [], clients: {}, codes: {}, tokens: {} });
const now = () => Math.floor(Date.now() / 1000);

export class Store {
  constructor(file = null) {
    this.file = file;
    this.data = EMPTY();
    if (file && fs.existsSync(file)) {
      this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
  }

  save() {
    this.sweep();
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  sweep() {
    const t = now();
    for (const [k, v] of Object.entries(this.data.codes)) if (v.expires_at < t) delete this.data.codes[k];
    for (const [k, v] of Object.entries(this.data.tokens)) if (v.expires_at && v.expires_at < t) delete this.data.tokens[k];
  }

  // ---- owners (one per NabuAuth account) ---------------------------------
  owner(id) { return this.data.owners.find(o => o.id === id) || null; }
  ownerBySub(sub) { return sub ? this.data.owners.find(o => o.subs.includes(sub)) || null : null; }

  // Same rule as the other Nabux gateways: the sub decides; a verified email
  // only adopts an existing owner when this sub has never been seen.
  ensureOwner({ sub, email = '', emailVerified = false, name = '', picture = '' }) {
    if (!sub) throw new Error('OWNER_SUB_REQUIRED');
    const mail = String(email || '').trim().toLowerCase();
    let owner = this.ownerBySub(sub);
    if (!owner && mail && emailVerified) {
      owner = this.data.owners.find(o => o.email === mail && o.email_verified) || null;
      if (owner) owner.subs.push(sub);
    }
    if (!owner) {
      owner = { id: ++this.data.seq, subs: [sub], email: '', email_verified: false, name: '', picture: '', created_at: now() };
      this.data.owners.push(owner);
    }
    if (mail) { owner.email = mail; owner.email_verified = Boolean(emailVerified); }
    if (name) owner.name = String(name).slice(0, 200);
    if (picture !== undefined) owner.picture = String(picture || '').slice(0, 500);
    owner.seen_at = now();
    this.save();
    return owner;
  }

  ownersMatching(sub, email) {
    const mail = String(email || '').trim().toLowerCase();
    return this.data.owners.filter(o => (sub && o.subs.includes(sub)) || (mail && o.email === mail && o.email_verified));
  }

  // ---- messenger accounts -------------------------------------------------
  accountsOf(ownerId) { return this.data.accounts.filter(a => a.owner_id === ownerId); }
  account(key) { return key ? this.data.accounts.find(a => a.key === key) || null : null; }

  insertAccount(account) { this.data.accounts.push(account); this.save(); return account; }

  updateAccount(key, changes) {
    const a = this.account(key);
    if (!a) return null;
    Object.assign(a, changes, { updated_at: now() });
    this.save();
    return a;
  }

  deleteAccount(key) {
    const before = this.data.accounts.length;
    this.data.accounts = this.data.accounts.filter(a => a.key !== key);
    if (this.data.accounts.length !== before) this.save();
    return this.data.accounts.length !== before;
  }

  // ---- OAuth (dynamic client registration, codes, tokens) ----------------
  client(id) { return this.data.clients[id] || null; }
  putClient(client) { this.data.clients[client.client_id] = client; this.save(); return client; }

  putCode(code, record) { this.data.codes[sha256(code)] = record; this.save(); }
  peekCode(code) {
    const r = this.data.codes[sha256(code)];
    return r && r.expires_at >= now() ? r : null;
  }
  takeCode(code) {
    const k = sha256(code);
    const r = this.data.codes[k];
    delete this.data.codes[k];
    this.save();
    return r && r.expires_at >= now() ? r : null;
  }

  putToken(token, record) { this.data.tokens[sha256(token)] = { ...record, created_at: now() }; this.save(); }
  token(token) {
    const r = this.data.tokens[sha256(token)];
    return r && (!r.expires_at || r.expires_at >= now()) ? r : null;
  }
  revokeToken(token) {
    const r = this.data.tokens[sha256(token)];
    if (r) this.revokePair(r.pair_id);
  }
  revokePair(pairId) {
    for (const [k, v] of Object.entries(this.data.tokens)) if (v.pair_id === pairId) delete this.data.tokens[k];
    this.save();
  }
  revokeOwnerTokens(ownerId) {
    for (const [k, v] of Object.entries(this.data.tokens)) if (v.owner_id === ownerId) delete this.data.tokens[k];
    this.save();
  }
  // The AI clients an owner has connected: one entry per live token pair.
  connectionsOf(ownerId) {
    const pairs = new Map();
    for (const t of Object.values(this.data.tokens)) {
      if (t.owner_id !== ownerId || (t.expires_at && t.expires_at < now())) continue;
      const seen = pairs.get(t.pair_id);
      if (!seen || t.kind === 'refresh') pairs.set(t.pair_id, t);
    }
    return [...pairs.values()].map(t => ({ client_id: t.client_id, label: t.label || null, created_at: t.created_at }));
  }
}
