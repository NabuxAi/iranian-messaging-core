// Browser plumbing shared by every web-app driver: one persistent Chrome
// profile per messenger, optional proxy, and the write locks.
import os from 'node:os';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

export const MAX_TEXT = 4000;
export const MAX_WEB_FILE_BYTES = 20 * 1024 * 1024;

const sessions = new Map();

export function assertEnabled() {
  if (process.env.NABU_BROWSER_ENABLE !== '1') throw new Error('BROWSER_DISABLED_SET_NABU_BROWSER_ENABLE');
}

function profileDir(id) {
  return path.join(process.env.NABU_BROWSER_PROFILE_DIR ||
    path.join(os.homedir(), '.nabuxai', 'iranian-messaging-profiles'), id);
}

function launchOptions() {
  const proxy = (process.env.NABU_BROWSER_PROXY || '').trim();
  const executablePath = (process.env.CHROME_EXECUTABLE_PATH || '').trim();
  return {
    headless: process.env.NABU_BROWSER_HEADLESS === '1',
    viewport: null,
    acceptDownloads: false,
    ...(executablePath ? { executablePath }
      : { channel: process.env.NABU_BROWSER_CHANNEL || 'chrome' }),
    ...(proxy ? { proxy: { server: proxy } } : {})
  };
}

export function openSession(app) {
  const s = sessions.get(app.id);
  return s && !s.page.isClosed() ? s : null;
}

export async function session(app, { open = false } = {}) {
  const existing = openSession(app);
  if (existing) return existing;
  if (!open) throw new Error('WEB_APP_NOT_OPEN_CALL_OPEN_FIRST');
  const { chromium } = await import('playwright-core');
  const folder = profileDir(app.id);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const context = await chromium.launchPersistentContext(folder, launchOptions());
  const page = context.pages()[0] || await context.newPage();
  const s = { context, page };
  sessions.set(app.id, s);
  context.on('close', () => sessions.delete(app.id));
  return s;
}

export async function closeSession(app) {
  const s = sessions.get(app.id);
  if (!s) return false;
  sessions.delete(app.id);
  await s.context.close();
  return true;
}

export function assertOnApp(app, page) {
  const current = new URL(page.url());
  if (current.protocol !== 'https:' || current.hostname !== app.host) throw new Error('BROWSER_LEFT_ALLOWED_DOMAIN');
}

// Runs fn(arg) in the page; errors come back as WEB_APP_ERROR: <reason>.
export async function evaluate(page, fn, arg) {
  try {
    return await page.evaluate(fn, arg);
  } catch (error) {
    const reason = String(error?.message || error).split('\n')[0].replace(/^.*?Error: /, '');
    throw new Error('WEB_APP_ERROR: ' + reason);
  }
}

// Same three locks as the bot gateway, with a separate allowlist per web app
// because this writes as the user, not as a bot.
export function guardWrite(app, chatId, confirm) {
  if (confirm !== true) throw new Error('EXPLICIT_CONFIRMATION_REQUIRED');
  const key = `${app.id.toUpperCase()}_WEB_ALLOWED_CHATS`;
  const allowed = new Set((process.env[key] || '').split(',')
    .map(s => s.trim().replace(/^@/, '').toLowerCase()).filter(Boolean));
  const id = String(chatId ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!id) throw new Error('INVALID_CHAT_ID');
  if (!allowed.has('*') && !allowed.has(id)) throw new Error(`RECIPIENT_NOT_ALLOWLISTED_ADD_TO_${key}`);
  if (process.env.NABU_MESSAGING_ENABLE_SEND !== '1') throw new Error('SEND_DISABLED_BY_DEFAULT_SET_NABU_MESSAGING_ENABLE_SEND');
}
