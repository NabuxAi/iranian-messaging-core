// The Nabux MCP Console look, ported from NabuXUI packages/mcp-console
// (nabux_console.py 1.1.0): the same markup and class names, so the vendored
// console.css / console.js in static/console render it unchanged.
//
// Every value interpolated with html`` is escaped unless it is raw().
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'console');
export const LANG_COOKIE = 'nx_lang';
export const THEME_COOKIE = 'nx_theme';
const TONES = new Set(['neutral', 'accent', 'success', 'warning', 'danger', 'info']);

// ---- escaping -------------------------------------------------------------
class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = s => new Raw(String(s ?? ''));
export const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const render = v => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(render).join('') : esc(v));
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new Raw(out);
}
const attrs = obj => raw(Object.entries(obj || {}).filter(([, v]) => v != null && v !== false)
  .map(([k, v]) => (v === true ? ` ${esc(k)}` : ` ${esc(k)}="${esc(v)}"`)).join(''));

// ---- static files ---------------------------------------------------------
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8' };
const STATIC = new Map();
for (const dir of [STATIC_DIR, path.join(STATIC_DIR, 'fonts')]) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile() && TYPES[path.extname(name)]) STATIC.set(path.relative(STATIC_DIR, full).split(path.sep).join('/'), full);
  }
}
const ASSET_VERSION = (() => {
  const h = crypto.createHash('sha256').update('1.1.0');
  for (const name of [...STATIC.keys()].sort()) h.update(name).update(fs.readFileSync(STATIC.get(name)));
  return h.digest('hex').slice(0, 10);
})();
export const asset = p => `/static/console/${p}?v=${ASSET_VERSION}`;

export function serveStatic(req, res) {
  const file = STATIC.get(req.params.path || '');
  if (!file) return res.status(404).type('text/plain').send('not found');
  const long = req.query.v === ASSET_VERSION || file.endsWith('.woff2');
  res.set({ 'Cache-Control': long ? 'public, max-age=31536000, immutable' : 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' });
  res.type(TYPES[path.extname(file)]).send(fs.readFileSync(file));
}

// ---- icons ----------------------------------------------------------------
const UI_ICONS = {
  overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  accounts: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  connect: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  tools: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  grid: '<circle cx="5" cy="5" r="1.6"/><circle cx="12" cy="5" r="1.6"/><circle cx="19" cy="5" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/><circle cx="5" cy="19" r="1.6"/><circle cx="12" cy="19" r="1.6"/><circle cx="19" cy="19" r="1.6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  languages: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  cursor: '<path d="M4.04 4.24a.5.5 0 0 1 .65-.65l15.5 6.06a.5.5 0 0 1-.06.95l-6.29 1.66a2 2 0 0 0-1.43 1.43l-1.66 6.29a.5.5 0 0 1-.95.06z"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  sparkles: '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/>',
  message: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  send: '<path d="M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.64l-19 6.5a.5.5 0 0 0-.02.94l7.93 3.18a2 2 0 0 1 1.11 1.11z"/><path d="m21.85 2.15-10.94 10.94"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  bot: '<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>'
};

const GLYPHS = {
  telegram: '<path d="M21.4 4.3 2.95 11.43c-1.26.5-1.25 1.2-.23 1.52l4.74 1.48 1.83 5.6c.22.62.11.86.76.86.5 0 .72-.23 1-.5l2.37-2.3 4.92 3.63c.9.5 1.56.24 1.79-.84l3.23-15.24c.33-1.33-.5-1.93-1.96-1.34ZM9.12 14.46l8.73-5.51c.43-.27.83-.12.5.17l-7.48 6.75-.3 3.14Z"/>',
  whatsapp: '<path d="M12 2.6a9.4 9.4 0 0 0-8.1 14.15L2.6 21.4l4.77-1.25A9.4 9.4 0 1 0 12 2.6Z"/>',
  instagram: '<path fill-rule="evenodd" d="M7.8 2.5h8.4a5.3 5.3 0 0 1 5.3 5.3v8.4a5.3 5.3 0 0 1-5.3 5.3H7.8a5.3 5.3 0 0 1-5.3-5.3V7.8a5.3 5.3 0 0 1 5.3-5.3Zm4.2 5.05a4.45 4.45 0 1 1 0 8.9 4.45 4.45 0 0 1 0-8.9Z"/>',
  facebook: '<path d="M15.12 5.32H17V2.14A26.11 26.11 0 0 0 14.26 2c-2.72 0-4.58 1.66-4.58 4.7v2.62H6.61v3.56h3.07V22h3.68v-9.12h3.06l.46-3.56h-3.52V7.05c0-1.03.28-1.73 1.76-1.73Z"/>',
  x: '<path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78ZM16.67 19.18h1.7L7.4 4.73H5.58Z"/>',
  linkedin: '<path d="M4.2 9.2h3.3V20H4.2Zm1.65-5.4a1.92 1.92 0 1 1 0 3.84 1.92 1.92 0 0 1 0-3.84ZM9.6 9.2h3.17v1.48h.05c.44-.84 1.52-1.72 3.13-1.72 3.35 0 3.97 2.2 3.97 5.07V20h-3.3v-5.24c0-1.25-.02-2.86-1.74-2.86-1.75 0-2.01 1.36-2.01 2.77V20H9.6Z"/>',
  threads: '<path d="M12.18 2.5c5.2 0 8.32 3.3 8.32 9.5s-3.12 9.5-8.32 9.5S3.86 18.2 3.86 12s3.12-9.5 8.32-9.5Z"/>',
  youtube: '<path fill-rule="evenodd" d="M21.58 7.19a2.5 2.5 0 0 0-1.77-1.77C18.25 5 12 5 12 5s-6.25 0-7.81.42a2.5 2.5 0 0 0-1.77 1.77C2 8.75 2 12 2 12s0 3.25.42 4.81a2.5 2.5 0 0 0 1.77 1.77C5.75 19 12 19 12 19s6.25 0 7.81-.42a2.5 2.5 0 0 0 1.77-1.77C22 15.25 22 12 22 12s0-3.25-.42-4.81ZM10 15V9l5.2 3Z"/>',
  snapchat: '<path d="M12.07 2.75c1.7 0 3.25.73 4.09 2.15.55.93.48 2.5.4 3.82l-.04.62c.2.1.46.13.73.04.35-.12.74-.14 1 .03.4.25.33.76-.03.97-.2.12-.5.22-.82.32-.48.15-1.01.33-.9.77.37 1.47 1.62 2.7 3.22 3.29.27.1.33.36.2.58-.36.6-1.58.73-2.1.86-.13.24-.1.75-.4.86-.43.15-1.06-.09-1.86.04-1.06.18-1.82 1.45-3.53 1.45s-2.43-1.27-3.49-1.45c-.8-.13-1.43.11-1.86-.04-.3-.11-.27-.62-.4-.86-.52-.13-1.74-.26-2.1-.86-.13-.22-.07-.48.2-.58 1.6-.59 2.85-1.82 3.22-3.29.11-.44-.42-.62-.9-.77-.32-.1-.62-.2-.82-.32-.36-.21-.43-.72-.03-.97.26-.17.65-.15 1-.03.27.09.53.06.73-.04l-.04-.62c-.08-1.32-.15-2.89.4-3.82.84-1.42 2.39-2.15 4.09-2.15h.15Z"/>',
  social: '<circle cx="18" cy="5.5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="18.5" r="3"/><path d="m8.6 13.5 6.8 3.9M15.4 7l-6.8 3.9" stroke="currentColor" stroke-width="1.8" fill="none"/>',
  nabux: '<path d="M6.5 18V6h2.6l6.3 7.7V6H18v12h-2.6L9.1 10.3V18Z"/>',
  // A speech bubble with three dots: this gateway and its messengers.
  chat: '<path fill-rule="evenodd" d="M12 3c5.25 0 9.5 3.69 9.5 8.25S17.25 19.5 12 19.5c-.98 0-1.93-.13-2.82-.37L4.5 21l1.12-3.7C3.68 15.8 2.5 13.64 2.5 11.25 2.5 6.69 6.75 3 12 3Zm-4 7a1.25 1.25 0 1 0 0 2.5A1.25 1.25 0 0 0 8 10Zm4 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Zm4 0a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z"/>'
};

export function icon(name, size = 16, { label = null, cls = '' } = {}) {
  const a11y = label ? html` role="img" aria-label="${label}"` : raw(' aria-hidden="true" focusable="false"');
  return html`<svg class="nx-i ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"${a11y}>${raw(UI_ICONS[name] || UI_ICONS.info)}</svg>`;
}
const glyph = (key, size) => html`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">${raw(GLYPHS[key] || GLYPHS.nabux)}</svg>`;

// ---- colour: the brand colour must carry text at WCAG AA -----------------
const rgbOf = hex => { const v = hex.replace('#', ''); return [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16) / 255); };
const lum = rgb => { const ch = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); const [r, g, b] = rgb.map(ch); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const hexOf = rgb => '#' + rgb.map(c => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');
const contrast = (a, b) => { const [x, y] = [lum(rgbOf(a)), lum(rgbOf(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
export function accessiblePair(color) {
  let rgb = rgbOf(color);
  if (lum(rgb) > 0.4 && contrast(color, '#111111') >= 4.5) return [hexOf(rgb), '#111111'];
  for (let i = 0; i < 40 && contrast(hexOf(rgb), '#ffffff') < 4.5; i++) rgb = rgb.map(c => c * 0.94);
  return [hexOf(rgb), '#ffffff'];
}

// ---- the Nabux MCP family (product switcher) ------------------------------
export const PRODUCTS = [
  ['telegram', 'Telegram MCP', 'tm.nabuxai.com', '#229ED9', 'تلگرام'],
  ['whatsapp', 'WhatsApp MCP', 'wa.nabuxai.com', '#25D366', 'واتس‌اپ'],
  ['instagram', 'Instagram MCP', 'ig.nabuxai.com', '#D62976', 'اینستاگرام'],
  ['facebook', 'Facebook MCP', 'fb.nabuxai.com', '#1877F2', 'فیسبوک'],
  ['x', 'X MCP', 'x.nabuxai.com', '#000000', 'ایکس'],
  ['linkedin', 'LinkedIn MCP', 'li.nabuxai.com', '#0A66C2', 'لینکدین'],
  ['threads', 'Threads MCP', 'th.nabuxai.com', '#000000', 'تردز'],
  ['youtube', 'YouTube MCP', 'yt.nabuxai.com', '#FF0000', 'یوتیوب'],
  ['snapchat', 'Snapchat MCP', 'snap.nabuxai.com', '#FFFC00', 'اسنپ‌چت'],
  ['social', 'Social MCP', 'social.nabuxai.com', '#5647E6', 'سوشال']
].map(([key, name, host, color, fa]) => ({ key, name, host, color, fa, glyph: key }));

export function tile(color, glyphKey, size = 32) {
  const [bg, fg] = accessiblePair(color);
  return html`<span class="nx-ptile" style="--tile:${bg};--tile-fg:${fg};--s:${size}px">${glyph(glyphKey, Math.max(12, Math.round(size * 0.58)))}</span>`;
}
export const nabuxMark = (size = 28) => html`<span class="nx-mark" style="--s:${size}px">${glyph('nabux', Math.max(12, Math.round(size * 0.62)))}</span>`;

// ---- strings ----------------------------------------------------------------
const KIT = {
  en: {
    'nav.section.workspace': 'Workspace', 'nav.section.developers': 'Developers', skip: 'Skip to content',
    'menu.open': 'Open menu', 'menu.close': 'Close menu', 'switcher.label': 'Nabux MCP services',
    'switcher.title': 'Nabux MCP services', 'switcher.here': 'You are here', 'switcher.all': 'One Nabux account signs you in to all of them.',
    'user.menu': 'Account menu', 'user.manage': 'Manage Nabux account', 'user.signout': 'Sign out',
    'theme.label': 'Theme', 'theme.light': 'Light', 'theme.dark': 'Dark', 'theme.system': 'System',
    'lang.label': 'Language', 'lang.other': 'فارسی', 'lang.other.code': 'fa',
    copy: 'Copy', copied: 'Copied to clipboard', 'copy.failed': 'Copy failed — select the text instead',
    endpoint: 'MCP endpoint', 'signin.cta': 'Continue with Nabux', 'signin.eyebrow': 'Nabux MCP gateway',
    'signin.secondary': 'How it works', 'signin.connects': 'What it connects', 'signin.mcp.title': 'What is MCP?',
    'signin.mcp.text': 'The Model Context Protocol is an open standard that lets AI assistants use tools safely. This gateway is an MCP server: you sign in once, choose what it may reach, and your assistant can read and act only on what you allowed.',
    'signin.mcp.s1': 'Sign in with your Nabux account', 'signin.mcp.s2': 'Connect the bots you own',
    'signin.mcp.s3': 'Add the endpoint to Claude, ChatGPT or Cursor', 'signin.trust.encrypted': 'Tokens encrypted at rest',
    'signin.trust.revoke': 'Revoke access any time',
    'signin.disabled.title': 'Nabux sign-in is not set up on this server',
    'signin.disabled.text': 'Set NABUAUTH_CLIENT_ID and NABUAUTH_CLIENT_SECRET to open the panel.',
    'signin.one': 'One account for every Nabux MCP', 'signin.ai': 'Your AI assistant',
    'footer.privacy': 'Privacy', 'footer.terms': 'Terms', 'footer.account': 'Nabux account', 'footer.all': 'All Nabux services',
    'footer.by': 'An MCP gateway by Nabux', 'auth.expired.title': 'This sign-in link has expired',
    'auth.expired.text': 'Sign-in links are good for ten minutes and work once. Start again and it will go through.',
    'auth.cancelled.title': 'Sign-in was cancelled', 'auth.failed.title': 'We could not sign you in', 'auth.retry': 'Try again',
    'auth.home': 'Back to start', 'status.connected': 'Connected', 'status.expired': 'Token rejected', 'status.error': 'Unreachable',
    'danger.title': 'Danger zone', 'tools.search': 'Filter tools', 'tools.count': '{n} tools', 'tools.none': 'No tools match this filter.',
    'tools.noargs': 'No arguments', 'ai.claude': 'Claude', 'ai.chatgpt': 'ChatGPT', 'ai.cursor': 'Cursor', 'ai.claude_code': 'Claude Code',
    'ai.token': 'Personal token', 'ai.claude.s1': 'Open claude.ai → Settings → Connectors.',
    'ai.claude.s2': 'Choose “Add custom connector” and paste the endpoint below.', 'ai.claude.s3': 'Press Connect and sign in with Nabux when asked.',
    'ai.chatgpt.s1': 'Open ChatGPT → Settings → Apps & Connectors → Advanced, and turn on Developer mode.',
    'ai.chatgpt.s2': 'Back in Apps & Connectors choose Create, name it and paste the endpoint below.',
    'ai.chatgpt.s3': 'Pick OAuth as the authentication and sign in with Nabux.',
    'ai.cursor.s1': 'Open Cursor → Settings → MCP → Add new global MCP server.',
    'ai.cursor.s2': 'Add this entry to mcp.json and save. Cursor opens the sign-in page the first time.',
    'ai.claude_code.s1': 'Run this in a terminal, then type /mcp in Claude Code to sign in.',
    'ai.token.text': 'For clients without OAuth: send a personal token as an Authorization: Bearer header. It does not expire, so treat it like a password.',
    'ai.token.create': 'Create personal token', 'ai.token.once': 'Copy it now: this token is shown only once.', 'ai.token.header': 'Authorization header'
  },
  fa: {
    'nav.section.workspace': 'فضای کار', 'nav.section.developers': 'توسعه‌دهندگان', skip: 'رفتن به محتوا',
    'menu.open': 'باز کردن منو', 'menu.close': 'بستن منو', 'switcher.label': 'سرویس‌های MCP نابکس',
    'switcher.title': 'سرویس‌های MCP نابکس', 'switcher.here': 'همین‌جا هستید', 'switcher.all': 'با یک حساب Nabux وارد همهٔ این سرویس‌ها می‌شوید.',
    'user.menu': 'منوی حساب', 'user.manage': 'مدیریت حساب Nabux', 'user.signout': 'خروج',
    'theme.label': 'پوسته', 'theme.light': 'روشن', 'theme.dark': 'تیره', 'theme.system': 'خودکار',
    'lang.label': 'زبان', 'lang.other': 'English', 'lang.other.code': 'en',
    copy: 'کپی', copied: 'کپی شد', 'copy.failed': 'کپی نشد؛ متن را انتخاب و کپی کنید',
    endpoint: 'آدرس MCP', 'signin.cta': 'ادامه با Nabux', 'signin.eyebrow': 'درگاه MCP نابکس',
    'signin.secondary': 'چطور کار می‌کند', 'signin.connects': 'چه چیزهایی را وصل می‌کند', 'signin.mcp.title': 'MCP چیست؟',
    'signin.mcp.text': 'پروتکل MCP استانداردی باز است که به دستیارهای هوش مصنوعی اجازه می‌دهد با خیال راحت از ابزارها استفاده کنند. این درگاه یک سرور MCP است: یک بار وارد می‌شوید، مشخص می‌کنید به چه چیزی دسترسی داشته باشد، و دستیار شما فقط روی همان‌ها کار می‌کند.',
    'signin.mcp.s1': 'با حساب Nabux وارد شوید', 'signin.mcp.s2': 'بات‌هایی را که مال شماست وصل کنید',
    'signin.mcp.s3': 'آدرس را به Claude، ChatGPT یا Cursor بدهید', 'signin.trust.encrypted': 'توکن‌ها رمزنگاری‌شده',
    'signin.trust.revoke': 'قطع دسترسی در هر زمان',
    'signin.disabled.title': 'ورود با Nabux روی این سرور هنوز راه‌اندازی نشده است',
    'signin.disabled.text': 'برای باز شدن پنل، NABUAUTH_CLIENT_ID و NABUAUTH_CLIENT_SECRET را تنظیم کنید.',
    'signin.one': 'یک حساب برای همهٔ MCPهای Nabux', 'signin.ai': 'دستیار هوش مصنوعی شما',
    'footer.privacy': 'حریم خصوصی', 'footer.terms': 'شرایط استفاده', 'footer.account': 'حساب Nabux', 'footer.all': 'همهٔ سرویس‌های Nabux',
    'footer.by': 'درگاه MCP از Nabux', 'auth.expired.title': 'این لینک ورود منقضی شده است',
    'auth.expired.text': 'لینک ورود ده دقیقه اعتبار دارد و فقط یک بار کار می‌کند. دوباره شروع کنید.',
    'auth.cancelled.title': 'ورود لغو شد', 'auth.failed.title': 'ورود انجام نشد', 'auth.retry': 'تلاش دوباره',
    'auth.home': 'بازگشت به صفحهٔ اول', 'status.connected': 'وصل', 'status.expired': 'توکن رد شد', 'status.error': 'در دسترس نیست',
    'danger.title': 'منطقهٔ خطر', 'tools.search': 'جست‌وجوی ابزار', 'tools.count': '{n} ابزار', 'tools.none': 'ابزاری با این عبارت پیدا نشد.',
    'tools.noargs': 'بدون ورودی', 'ai.claude': 'Claude', 'ai.chatgpt': 'ChatGPT', 'ai.cursor': 'Cursor', 'ai.claude_code': 'Claude Code',
    'ai.token': 'توکن شخصی', 'ai.claude.s1': 'در claude.ai به Settings ← Connectors بروید.',
    'ai.claude.s2': 'گزینهٔ «Add custom connector» را بزنید و آدرس زیر را وارد کنید.', 'ai.claude.s3': 'Connect را بزنید و در صورت درخواست با Nabux وارد شوید.',
    'ai.chatgpt.s1': 'در ChatGPT به Settings ← Apps & Connectors ← Advanced بروید و Developer mode را روشن کنید.',
    'ai.chatgpt.s2': 'در Apps & Connectors گزینهٔ Create را بزنید، نامی بدهید و آدرس زیر را وارد کنید.',
    'ai.chatgpt.s3': 'نوع احراز هویت را OAuth بگذارید و با Nabux وارد شوید.',
    'ai.cursor.s1': 'در Cursor به Settings ← MCP ← Add new global MCP server بروید.',
    'ai.cursor.s2': 'این بخش را به mcp.json اضافه و ذخیره کنید. بار اول صفحهٔ ورود باز می‌شود.',
    'ai.claude_code.s1': 'این دستور را در ترمینال اجرا کنید و سپس در Claude Code عبارت /mcp را بزنید تا وارد شوید.',
    'ai.token.text': 'برای کلاینت‌هایی که OAuth ندارند: توکن شخصی را به‌صورت هدر Authorization: Bearer بفرستید. این توکن منقضی نمی‌شود؛ مثل رمز عبور از آن محافظت کنید.',
    'ai.token.create': 'ساخت توکن شخصی', 'ai.token.once': 'همین حالا کپی کنید: این توکن فقط یک بار نمایش داده می‌شود.', 'ai.token.header': 'هدر Authorization'
  }
};

const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export const digits = (value, lang) => (lang === 'fa' ? String(value).replace(/\d/g, d => FA_DIGITS[d]) : String(value));

export function pickLang(req) {
  const q = String(req.query?.lang || '').toLowerCase();
  if (q === 'fa' || q === 'en') return q;
  const c = String(req.cookies?.[LANG_COOKIE] || '').toLowerCase();
  if (c === 'fa' || c === 'en') return c;
  const first = String(req.headers['accept-language'] || '').split(',').map(p => p.trim().split(';')[0].split('-')[0].toLowerCase())
    .find(t => t === 'fa' || t === 'en');
  return first || 'fa';
}

// ---- the page context ----------------------------------------------------------
// console: { product, productFa, color, glyph, baseUrl, host, nav, strings, nabuauthUrl, nabuauthEnabled }
export class Ctx {
  constructor(console, req, user, csrf) {
    this.console = console; this.req = req; this.user = user; this.csrfToken = csrf || '';
    this.lang = pickLang(req);
    this.dir = this.lang === 'fa' ? 'rtl' : 'ltr';
    const th = String(req.cookies?.[THEME_COOKIE] || '');
    this.theme = th === 'light' || th === 'dark' ? th : 'system';
    this.path = req.originalUrl || '/';
  }
  t(key, fmt) {
    for (const table of [this.console.strings[this.lang], KIT[this.lang], this.console.strings.en, KIT.en]) {
      if (table && key in table) {
        let text = table[key];
        for (const [k, v] of Object.entries(fmt || {})) text = text.replace(`{${k}}`, typeof v === 'number' ? digits(v, this.lang) : v);
        return text;
      }
    }
    return key;
  }
  pick(fa, en) { return this.lang === 'fa' ? fa : en; }
  text(pair) { return pair ? (pair[this.lang] || pair.en || '') : ''; }
  num(v) { return digits(v, this.lang); }
  csrfField() { return html`<input type="hidden" name="csrf" value="${this.csrfToken}">`; }
}

// ---- components -------------------------------------------------------------------
const tone = t => (TONES.has(t) ? t : 'neutral');

export function button(label, href = null, { variant = 'primary', iconName = null, size = 'md', type = 'submit', attrs: extra = {}, trailing = null } = {}) {
  const cls = `nx-btn nx-btn--${variant}${size !== 'md' ? ` nx-btn--${size}` : ''}`;
  const inner = html`${iconName ? icon(iconName) : ''}<span>${label}</span>${trailing ? icon(trailing, 16, { cls: 'nx-flip' }) : ''}`;
  return href != null ? html`<a class="${cls}" href="${href}"${attrs(extra)}>${inner}</a>`
    : html`<button class="${cls}" type="${type}"${attrs(extra)}>${inner}</button>`;
}
export const postForm = (action, ctx, inner, { confirm = null, cls = 'nx-inline' } = {}) =>
  html`<form method="post" action="${action}" class="${cls}"${attrs({ 'data-confirm': confirm })}>${ctx.csrfField()}${inner}</form>`;
export const badge = (text, t = 'neutral', dot = true) =>
  html`<span class="nx-badge nx-badge--${tone(t)}">${dot ? raw('<span class="nx-badge__dot" aria-hidden="true"></span>') : ''}${text}</span>`;
export function statusBadge(ctx, status) {
  const t = { connected: 'success', expired: 'warning', error: 'danger' }[status] || 'neutral';
  return badge(ctx.t(`status.${status}`), t);
}
export function card(body = '', { title = null, subtitle = null, actions = null, flush = false, id = null, cls = '' } = {}) {
  const head = title != null || actions != null
    ? html`<div class="nx-card__head"><div class="nx-card__heading">${title != null ? html`<h2 class="nx-card__title">${title}</h2>` : ''}${subtitle != null ? html`<p class="nx-card__sub">${subtitle}</p>` : ''}</div>${actions != null ? html`<div class="nx-card__actions">${actions}</div>` : ''}</div>`
    : '';
  return html`<section class="nx-card ${cls}"${attrs({ id })}>${head}<div class="${flush ? 'nx-card__body nx-card__body--flush' : 'nx-card__body'}">${body}</div></section>`;
}
export function stat(label, value, { hint = null, iconName = null, t = 'accent', href = null } = {}) {
  const inner = html`<div class="nx-stat__top"><p class="nx-stat__label">${label}</p>${iconName ? html`<span class="nx-stat__icon nx-tone-${tone(t)}">${icon(iconName, 16)}</span>` : ''}</div><p class="nx-stat__value">${value}</p>${hint != null ? html`<p class="nx-stat__hint">${hint}</p>` : ''}`;
  return href ? html`<a class="nx-stat nx-stat--link" href="${href}">${inner}</a>` : html`<div class="nx-stat">${inner}</div>`;
}
export const grid = (items, cols = 2, cls = '') => html`<div class="nx-grid nx-grid--${cols} ${cls}">${items}</div>`;
export const stack = (items, gap = 'md') => html`<div class="nx-stack nx-stack--${gap}">${items}</div>`;
export const emptyState = (title, text = '', { iconName = 'inbox', action = null } = {}) =>
  html`<div class="nx-empty"><span class="nx-empty__icon">${icon(iconName, 20)}</span><p class="nx-empty__title">${title}</p><p class="nx-empty__text">${text}</p>${action != null ? html`<div class="nx-empty__action">${action}</div>` : ''}</div>`;
export function table(headers, rows, { empty = null, align = [] } = {}) {
  if (!rows.length && empty != null) return empty;
  const th = headers.map((x, i) => html`<th scope="col" class="nx-al-${align[i] || 'start'}">${x}</th>`);
  const body = rows.map(row => html`<tr>${row.map((cell, i) => html`<td data-label="${typeof headers[i] === 'string' ? headers[i] : ''}" class="nx-al-${align[i] || 'start'}">${cell}</td>`)}</tr>`);
  return html`<div class="nx-table-wrap"><table class="nx-table nx-table--stack"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}
export const copyButton = (value, ctx) =>
  html`<button type="button" class="nx-copy" data-copy="${value}" data-copied="${ctx.t('copied')}" data-failed="${ctx.t('copy.failed')}" aria-label="${ctx.t('copy')}" title="${ctx.t('copy')}">${icon('copy', 15, { cls: 'nx-copy__a' })}${icon('check', 15, { cls: 'nx-copy__b' })}</button>`;
export function endpointRow(label, value, ctx, { hint = null, copy = true } = {}) {
  const shown = raw(esc(value).replace(/\//g, '/<wbr>').replace(/\/<wbr>\/<wbr>/g, '//'));
  return html`<div class="nx-field">${label != null ? html`<p class="nx-field__label">${label}</p>` : ''}<div class="nx-endpoint"><code dir="ltr">${shown}</code>${copy ? copyButton(value, ctx) : ''}</div>${hint != null ? html`<p class="nx-field__hint">${hint}</p>` : ''}</div>`;
}
function described(fid, hint, error) {
  const ids = [hint != null ? `${fid}-hint` : '', error != null ? `${fid}-err` : ''].filter(Boolean).join(' ');
  return {
    hintHtml: hint != null ? html`<p class="nx-field__hint" id="${fid}-hint">${hint}</p>` : '',
    errHtml: error != null ? html`<p class="nx-field__error" id="${fid}-err">${icon('alert', 14)}<span>${error}</span></p>` : '',
    aria: { 'aria-describedby': ids || null, 'aria-invalid': error != null ? 'true' : null }
  };
}
export function textField(name, label, { type = 'text', value = '', placeholder = '', hint = null, error = null, required = false, ltr = false, autocomplete = null, cls = '' } = {}) {
  const fid = `f-${name}`;
  const d = described(fid, hint, error);
  const val = value && type !== 'password' ? value : null;
  return html`<div class="nx-field nx-field--input"><label class="nx-field__label" for="${fid}">${label}</label><input class="nx-input ${cls}" id="${fid}" name="${name}" type="${type}"${attrs({ value: val, placeholder: placeholder || null, required, dir: ltr ? 'ltr' : null, autocomplete, ...d.aria })}>${d.errHtml}${d.hintHtml}</div>`;
}
export function selectField(name, label, options, { value = '', hint = null } = {}) {
  const fid = `f-${name}`;
  const d = described(fid, hint, null);
  return html`<div class="nx-field nx-field--select"><label class="nx-field__label" for="${fid}">${label}</label><select class="nx-select" id="${fid}" name="${name}"${attrs(d.aria)}>${options.map(([v, l]) => html`<option value="${v}"${String(v) === String(value) ? raw(' selected') : ''}>${l}</option>`)}</select>${d.hintHtml}</div>`;
}
export function textareaField(name, label, { value = '', placeholder = '', hint = null, error = null, rows = 4, ltr = false, mono = false } = {}) {
  const fid = `f-${name}`;
  const d = described(fid, hint, error);
  return html`<div class="nx-field nx-field--textarea"><label class="nx-field__label" for="${fid}">${label}</label><textarea class="nx-textarea${mono ? ' nx-textarea--mono' : ''}" id="${fid}" name="${name}"${attrs({ rows, dir: ltr ? 'ltr' : null, placeholder: placeholder || null, ...d.aria })}>${value}</textarea>${d.errHtml}${d.hintHtml}</div>`;
}
export const checkbox = (name, label, { checked = false, value = '1' } = {}) =>
  html`<label class="nx-check"><input type="checkbox" name="${name}" value="${value}"${checked ? raw(' checked') : ''}><span>${label}</span></label>`;
export const details = (summary, body, { open = false, subtle = false } = {}) => {
  const base = subtle ? 'nx-disclosure' : 'nx-details';
  return html`<details class="${base}"${open ? raw(' open') : ''}><summary>${summary}</summary><div class="${base}__body">${body}</div></details>`;
};
export const codeBlock = (text, ctx, label = '') =>
  html`<div class="nx-code"><div class="nx-code__head"><span>${label}</span>${copyButton(text, ctx)}</div><pre dir="ltr" tabindex="0"><code>${text}</code></pre></div>`;
export function steps(items, lang = 'en') {
  return html`<ol class="nx-steps">${items.map(([title, body, done], i) => html`<li class="nx-steps__item${done ? ' is-done' : ''}"><span class="nx-steps__mark" aria-hidden="true">${done ? icon('check', 14) : digits(i + 1, lang)}</span><div class="nx-steps__content"><p class="nx-steps__title">${title}</p>${body ? html`<div class="nx-steps__body">${body}</div>` : ''}</div></li>`)}</ol>`;
}
export function notice(text, { t = 'info', title = null, action = null, iconName = null } = {}) {
  const ic = iconName || { success: 'check', warning: 'alert', danger: 'alert' }[t] || 'info';
  return html`<div class="nx-notice nx-notice--${tone(t)}"${t === 'danger' ? raw(' role="alert"') : ''}><span class="nx-notice__icon">${icon(ic, 16)}</span><div class="nx-notice__main">${title != null ? html`<p class="nx-notice__title">${title}</p>` : ''}<div class="nx-notice__text">${text}</div></div>${action != null ? html`<div class="nx-notice__action">${action}</div>` : ''}</div>`;
}
export function dangerZone(ctx, items) {
  const rows = items.map(([title, text, action]) => html`<div class="nx-danger__row"><div><p class="nx-danger__title">${title}</p><p class="nx-danger__text">${text}</p></div><div class="nx-danger__action">${action}</div></div>`);
  return card(rows, { title: ctx.t('danger.title'), cls: 'nx-danger', flush: true });
}
export const kvList = pairs => html`<dl class="nx-kv">${pairs.map(([k, v]) => html`<div class="nx-kv__row"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
export function tabs(items, label = '') {
  const tl = items.map(([id, lab], n) => html`<button type="button" role="tab" class="nx-tabs__tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${n === 0 ? 'true' : 'false'}" tabindex="${n === 0 ? 0 : -1}">${lab}</button>`);
  const panels = items.map(([id, lab, content], n) => html`<div class="nx-tabs__panel" role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}"${n === 0 ? '' : raw(' data-inactive')}><h3 class="nx-tabs__fallback">${lab}</h3>${content}</div>`);
  return html`<div class="nx-tabs" data-tabs><div class="nx-tabs__list" role="tablist" aria-label="${label}">${tl}</div>${panels}</div>`;
}
export function avatar(user, size = 32) {
  if (user?.picture?.startsWith('https://')) {
    return html`<span class="nx-avatar" style="--s:${size}px"><img src="${user.picture}" alt="" width="${size}" height="${size}" referrerpolicy="no-referrer"></span>`;
  }
  const src = (user?.name || (user?.email || '').split('@')[0] || '').trim();
  const words = src.replace(/[._]/g, ' ').split(/\s+/).filter(Boolean);
  const initials = words.length >= 2 ? (words[0][0] + words[1][0]).toUpperCase() : src.slice(0, 2).toUpperCase();
  return html`<span class="nx-avatar" style="--s:${size}px" aria-hidden="true">${initials || icon('user', Math.max(12, Math.round(size * 0.5)))}</span>`;
}
export function toolsList(ctx, tools) {
  const items = tools.map(t => {
    const props = t.inputSchema?.properties || {};
    const required = new Set(t.inputSchema?.required || []);
    const keys = Object.keys(props);
    const chips = keys.length ? keys.map(k => html`<span class="nx-chip${required.has(k) ? ' is-req' : ''}">${k}${required.has(k) ? raw('<span aria-hidden=true>*</span>') : ''}</span>`)
      : html`<span class="nx-muted">${ctx.t('tools.noargs')}</span>`;
    const desc = String(t.description || '').split('\n\n')[0];
    return html`<li class="nx-tool" data-filter="${`${t.name} ${desc}`.toLowerCase()}"><div class="nx-tool__head"><code dir="ltr" class="nx-tool__name">${t.name}</code></div><p class="nx-tool__desc">${desc}</p><div class="nx-tool__args" dir="ltr">${chips}</div></li>`;
  });
  return html`<div class="nx-tools" data-tools><div class="nx-tools__bar"><label class="nx-search">${icon('search', 15)}<span class="nx-sr">${ctx.t('tools.search')}</span><input type="search" data-tool-filter placeholder="${ctx.t('tools.search')}" autocomplete="off"></label><span class="nx-muted nx-tools__count">${ctx.t('tools.count', { n: tools.length })}</span></div><ul class="nx-tools__list">${items}</ul><p class="nx-tools__none" hidden>${ctx.t('tools.none')}</p></div>`;
}
export function connectAi(ctx, { serverName, mcpUrl, tokenHtml = null }) {
  const cursorJson = JSON.stringify({ mcpServers: { [serverName]: { url: mcpUrl } } }, null, 2);
  const items = [
    ['claude', ctx.t('ai.claude'), stack([steps([[ctx.t('ai.claude.s1')], [ctx.t('ai.claude.s2')], [ctx.t('ai.claude.s3')]], ctx.lang), endpointRow(ctx.t('endpoint'), mcpUrl, ctx)])],
    ['chatgpt', ctx.t('ai.chatgpt'), stack([steps([[ctx.t('ai.chatgpt.s1')], [ctx.t('ai.chatgpt.s2')], [ctx.t('ai.chatgpt.s3')]], ctx.lang), endpointRow(ctx.t('endpoint'), mcpUrl, ctx)])],
    ['cursor', ctx.t('ai.cursor'), stack([steps([[ctx.t('ai.cursor.s1')], [ctx.t('ai.cursor.s2')]], ctx.lang), codeBlock(cursorJson, ctx, 'mcp.json')])],
    ['claude-code', ctx.t('ai.claude_code'), stack([steps([[ctx.t('ai.claude_code.s1')]], ctx.lang), codeBlock(`claude mcp add --transport http ${serverName} ${mcpUrl}`, ctx, 'Terminal')])]
  ];
  if (tokenHtml) items.push(['token', ctx.t('ai.token'), tokenHtml]);
  return tabs(items, ctx.pick('اتصال به هوش مصنوعی', 'Connect to AI'));
}

// ---- page assembly ---------------------------------------------------------------
const CSP = "default-src 'self'; img-src 'self' https: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self' https:";

function document(ctx, title, body) {
  const con = ctx.console;
  const pageTitle = title === con.product ? title : `${title} · ${con.product}`;
  const [bg, fg] = accessiblePair(con.color);
  const favicon = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="${bg}"/><g transform="translate(3.6 3.6) scale(.7)" fill="${fg}">${GLYPHS[con.glyph]}</g></svg>`);
  const themeAttr = raw((ctx.theme === 'light' || ctx.theme === 'dark' ? ` data-theme="${ctx.theme}"` : '') + ` data-theme-pref="${ctx.theme}"`);
  return html`<!doctype html><html lang="${ctx.lang}" dir="${ctx.dir}"${themeAttr} class="no-js"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle}</title><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#fcfbf8" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#070812" media="(prefers-color-scheme: dark)"><link rel="icon" href="${favicon}"><link rel="stylesheet" href="${asset('console.css')}"><script src="${asset('console.js')}"></script><style>:root{--nx-platform:${bg};--nx-platform-fg:${fg}}</style></head>${body}</html>`;
}

export function send(res, ctx, title, body, status = 200) {
  res.status(status).set({
    'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin', 'Content-Security-Policy': CSP
  }).type('html').send(String(document(ctx, title, body)));
}

const prefsHref = (ctx, q) => `/console/prefs?${q}&next=${encodeURIComponent(ctx.path.replace(/([?&])lang=[^&]*&?/, '$1').replace(/[?&]$/, ''))}`;
const langLink = (ctx, cls = 'nx-iconbtn nx-langbtn') => {
  const other = ctx.t('lang.other.code');
  return html`<a class="${cls}" href="${prefsHref(ctx, `lang=${other}`)}" data-lang-set="${other}" hreflang="${other}" lang="${other}" title="${ctx.t('lang.label')}: ${ctx.t('lang.other')}">${icon('languages', 16)}<span class="nx-langbtn__txt">${ctx.t('lang.other')}</span></a>`;
};
const themeSwitch = ctx => html`<div class="nx-seg" role="group" aria-label="${ctx.t('theme.label')}">${[['light', 'sun'], ['dark', 'moon'], ['system', 'monitor']].map(([mode, ic]) => html`<a class="nx-seg__opt" href="${prefsHref(ctx, `theme=${mode}`)}" data-theme-set="${mode}"${ctx.theme === mode ? raw(' aria-current="true"') : ''} title="${ctx.t(`theme.${mode}`)}">${icon(ic, 15)}<span class="nx-sr">${ctx.t(`theme.${mode}`)}</span></a>`)}</div>`;
const themeToggle = ctx => {
  const next = { light: 'dark', dark: 'system', system: 'light' }[ctx.theme];
  const labels = { light: ctx.t('theme.light'), dark: ctx.t('theme.dark'), system: ctx.t('theme.system') };
  return html`<a class="nx-iconbtn" href="${prefsHref(ctx, `theme=${next}`)}" data-theme-cycle data-labels="${JSON.stringify(labels)}" title="${ctx.t('theme.label')}: ${labels[ctx.theme]}" aria-label="${ctx.t('theme.label')}: ${labels[ctx.theme]}">${icon('sun', 16, { cls: 'nx-th-light' })}${icon('moon', 16, { cls: 'nx-th-dark' })}${icon('monitor', 16, { cls: 'nx-th-system' })}</a>`;
};
const brand = (ctx, href) => html`<a class="nx-brand" href="${href}">${nabuxMark(26)}<span class="nx-brand__slash" aria-hidden="true">/</span>${tile(ctx.console.color, ctx.console.glyph, 26)}<span class="nx-brand__name">${ctx.console.product}</span></a>`;
function switcher(ctx) {
  const con = ctx.console;
  const all = [...PRODUCTS, { key: 'here', name: con.product, host: con.host, color: con.color, fa: con.productFa, glyph: con.glyph, here: true }];
  const tiles = all.map(p => html`<li><a class="nx-switch__item${p.here ? ' is-here' : ''}" href="https://${p.host}/"${p.here ? raw(' aria-current=page') : ''}>${tile(p.color, p.glyph, 30)}<span class="nx-switch__txt"><span class="nx-switch__name">${ctx.lang === 'fa' && p.fa ? (p.here ? p.fa : `${p.fa} MCP`) : p.name}</span>${p.here ? html`<span class="nx-switch__here">${ctx.t('switcher.here')}</span>` : html`<span class="nx-switch__host" dir="ltr">${p.host}</span>`}</span></a></li>`);
  return html`<details class="nx-pop nx-switch" data-pop><summary class="nx-iconbtn" aria-label="${ctx.t('switcher.label')}" title="${ctx.t('switcher.label')}">${icon('grid', 16)}</summary><div class="nx-pop__panel nx-switch__panel"><p class="nx-pop__title">${ctx.t('switcher.title')}</p><ul class="nx-switch__grid">${tiles}</ul><p class="nx-pop__foot">${nabuxMark(18)}<span>${ctx.t('switcher.all')}</span></p></div></details>`;
}
function userMenu(ctx) {
  const u = ctx.user;
  if (!u) return '';
  return html`<details class="nx-pop nx-user" data-pop><summary class="nx-user__btn" aria-label="${ctx.t('user.menu')}">${avatar(u, 30)}</summary><div class="nx-pop__panel nx-user__panel"><div class="nx-user__head">${avatar(u, 36)}<div class="nx-user__id"><p class="nx-user__name">${u.name || u.email}</p>${u.email ? html`<p class="nx-user__email" dir="ltr">${u.email}</p>` : ''}</div></div><div class="nx-menu"><a class="nx-menu__item" href="${ctx.console.nabuauthUrl}/" target="_blank" rel="noopener">${icon('user', 15)}<span>${ctx.t('user.manage')}</span>${icon('external', 13, { cls: 'nx-menu__ext' })}</a><div class="nx-menu__row"><span>${ctx.t('theme.label')}</span>${themeSwitch(ctx)}</div><div class="nx-menu__row"><span>${ctx.t('lang.label')}</span>${langLink(ctx, 'nx-chipbtn')}</div><div class="nx-menu__sep"></div><form method="post" action="/auth/logout">${ctx.csrfField()}<button type="submit" class="nx-menu__item">${icon('logout', 15)}<span>${ctx.t('user.signout')}</span></button></form></div></div></details>`;
}
function sidebar(ctx, active) {
  const con = ctx.console;
  const sections = new Map();
  for (const item of con.nav) {
    const cur = item.key === active;
    if (!sections.has(item.section)) sections.set(item.section, []);
    sections.get(item.section).push(html`<li><a class="nx-nav__link${cur ? ' is-active' : ''}" href="${item.href}"${cur ? raw(' aria-current=page') : ''}>${icon(item.icon, 16)}<span>${ctx.text(item.label)}</span></a></li>`);
  }
  const groups = [...sections].map(([sec, links]) => html`<p class="nx-nav__section">${ctx.t(`nav.section.${sec}`)}</p><ul class="nx-nav__list">${links}</ul>`);
  const mcpUrl = `${con.baseUrl}/mcp`;
  return html`<aside class="nx-side" id="nx-side" aria-label="${con.product}"><div class="nx-side__inner"><div class="nx-side__head">${brand(ctx, '/dashboard')}<button type="button" class="nx-iconbtn nx-side__close" data-drawer-close aria-label="${ctx.t('menu.close')}">${icon('close', 16)}</button></div><nav class="nx-nav">${groups}</nav><div class="nx-side__endpoint"><p class="nx-side__label">${icon('plug', 13)}${ctx.t('endpoint')}</p><div class="nx-endpoint nx-endpoint--sm"><code dir="ltr">${con.host}/mcp</code>${copyButton(mcpUrl, ctx)}</div></div></div></aside>`;
}
const footer = (ctx, compact = false) => html`<footer class="nx-foot${compact ? ' nx-foot--compact' : ''}"><p>${nabuxMark(16)}<span>${ctx.t('footer.by')}</span></p><nav class="nx-foot__links"><a href="https://nabuxai.com/privacy">${ctx.t('footer.privacy')}</a><a href="https://nabuxai.com/terms">${ctx.t('footer.terms')}</a><a href="${ctx.console.nabuauthUrl}/">${ctx.t('footer.account')}</a><a href="https://nabuxai.com/">${ctx.t('footer.all')}</a></nav></footer>`;

export function appPage(ctx, { title, body, active = null, subtitle = null, actions = null, toast = null }) {
  const con = ctx.console;
  return html`<body class="nx-app"${attrs({ 'data-toast': toast })}><a class="nx-skip" href="#nx-main">${ctx.t('skip')}</a><div class="nx-layout">${sidebar(ctx, active)}<div class="nx-scrim" data-drawer-close hidden></div><div class="nx-main-col"><header class="nx-top"><button type="button" class="nx-iconbtn nx-top__menu" data-drawer-open aria-controls="nx-side" aria-expanded="false" aria-label="${ctx.t('menu.open')}">${icon('menu', 18)}</button><div class="nx-top__brand">${brand(ctx, '/dashboard')}</div><div class="nx-top__crumb"><span>${con.product}</span>${icon('chevron-right', 14, { cls: 'nx-crumb-sep' })}<b>${title}</b></div><div class="nx-top__spacer"></div><span class="nx-top__host" dir="ltr">${con.host}</span><div class="nx-top__tools">${langLink(ctx)}${themeToggle(ctx)}${switcher(ctx)}${userMenu(ctx)}</div></header><main class="nx-main" id="nx-main" tabindex="-1"><div class="nx-page"><div class="nx-page__head"><div class="nx-page__titles"><h1 class="nx-page__title">${title}</h1>${subtitle != null ? html`<p class="nx-page__sub">${subtitle}</p>` : ''}</div>${actions != null ? html`<div class="nx-page__actions">${actions}</div>` : ''}</div><div class="nx-page__body">${body}</div></div>${footer(ctx, true)}</main></div></div><div class="nx-toasts" aria-live="polite" aria-atomic="true"></div></body>`;
}

export function signinPage(ctx, { headline, tagline, features, privacy, trust, loginHref, noticeHtml = null }) {
  const con = ctx.console;
  const primary = con.nabuauthEnabled
    ? button(ctx.t('signin.cta'), loginHref, { size: 'lg', trailing: 'arrow', attrs: { 'data-primary': true } })
    : '';
  const disabled = con.nabuauthEnabled ? '' : notice(ctx.t('signin.disabled.text'), { t: 'warning', title: ctx.t('signin.disabled.title') });
  const trustList = [['shield', trust], ['lock', ctx.t('signin.trust.encrypted')], ['refresh', ctx.t('signin.trust.revoke')]]
    .map(([ic, text]) => html`<li>${icon(ic, 15)}<span>${text}</span></li>`);
  const feats = features.map(f => html`<li class="nx-feat"><span class="nx-feat__icon">${f.tile || icon(f.icon || 'check', 16)}</span><div><p class="nx-feat__title">${f.title}</p><p class="nx-feat__text">${f.text}</p></div></li>`);
  const clients = [['Claude', 'sparkles'], ['ChatGPT', 'message'], ['Cursor', 'cursor']]
    .map(([n, ic]) => html`<li class="nx-diag__client"><span class="nx-diag__mono" aria-hidden="true">${icon(ic, 12)}</span>${n}</li>`);
  const diagram = html`<div class="nx-diag" aria-hidden="true"><div class="nx-diag__glow"></div><div class="nx-diag__node">${tile(con.color, con.glyph, 52)}<span class="nx-diag__cap">${ctx.lang === 'fa' ? con.productFa : con.product}</span></div><div class="nx-diag__wire"><span></span></div><div class="nx-diag__node nx-diag__node--hub">${nabuxMark(60)}<span class="nx-diag__cap">Nabux MCP</span><span class="nx-diag__sub">${ctx.t('signin.one')}</span></div><div class="nx-diag__wire nx-diag__wire--b"><span></span></div><div class="nx-diag__node"><ul class="nx-diag__clients">${clients}</ul><span class="nx-diag__cap">${ctx.t('signin.ai')}</span></div></div>`;
  return html`<body class="nx-land"><a class="nx-skip" href="#nx-main">${ctx.t('skip')}</a><header class="nx-land__top">${brand(ctx, '/')}<div class="nx-top__spacer"></div><div class="nx-top__tools">${langLink(ctx)}${themeToggle(ctx)}${switcher(ctx)}</div></header><main id="nx-main" class="nx-land__main" tabindex="-1"><section class="nx-hero"><div class="nx-hero__copy">${noticeHtml ? html`<div class="nx-land__notice">${noticeHtml}</div>` : ''}${disabled ? html`<div class="nx-land__notice">${disabled}</div>` : ''}<p class="nx-eyebrow">${tile(con.color, con.glyph, 20)}<span>${ctx.t('signin.eyebrow')}</span></p><h1 class="nx-hero__title">${headline}</h1><p class="nx-hero__lead">${tagline}</p><div class="nx-hero__cta">${primary}<a class="nx-btn nx-btn--ghost nx-btn--lg" href="#how"><span>${ctx.t('signin.secondary')}</span></a></div><ul class="nx-trust">${trustList}</ul></div><div class="nx-hero__art">${diagram}</div></section><section class="nx-land__sec" id="connects"><h2 class="nx-land__h2">${ctx.t('signin.connects')}</h2><ul class="nx-feats">${feats}</ul></section><section class="nx-land__sec nx-land__mcp" id="how"><div><h2 class="nx-land__h2">${ctx.t('signin.mcp.title')}</h2><p class="nx-land__p">${ctx.t('signin.mcp.text')}</p></div>${steps([[ctx.t('signin.mcp.s1')], [ctx.t('signin.mcp.s2')], [ctx.t('signin.mcp.s3')]], ctx.lang)}</section><p class="nx-land__privacy">${icon('lock', 14)}<span>${privacy}</span></p></main>${footer(ctx)}<div class="nx-toasts" aria-live="polite" aria-atomic="true"></div></body>`;
}

export function messagePage(ctx, { title, message, t = 'danger', action = null }) {
  const ic = { danger: 'alert', warning: 'alert', success: 'check' }[t] || 'info';
  return html`<body class="nx-land nx-msgpage"><header class="nx-land__top">${brand(ctx, '/')}<div class="nx-top__spacer"></div><div class="nx-top__tools">${langLink(ctx)}${themeToggle(ctx)}</div></header><main id="nx-main" class="nx-msg"><div class="nx-msg__card"><span class="nx-msg__icon nx-tone-${tone(t)}">${icon(ic, 22)}</span><h1 class="nx-msg__title">${title}</h1><div class="nx-msg__text">${message}</div><div class="nx-msg__actions">${action ? button(action[0], action[1]) : ''}<a class="nx-btn nx-btn--ghost" href="/"><span>${ctx.t('auth.home')}</span></a></div></div></main>${footer(ctx)}</body>`;
}
