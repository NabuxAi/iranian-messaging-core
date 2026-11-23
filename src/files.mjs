// Loads a file the agent wants to send. Local files are only read from inside
// NABU_MESSAGING_FILE_ROOT, so a prompt cannot make the server upload ~/.ssh.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = Number(process.env.NABU_MESSAGING_MAX_FILE_BYTES || 50 * 1024 * 1024);

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain', '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

export function mimeFor(name) {
  return MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

export async function loadFile({ filePath, fileUrl }, fetcher = fetch) {
  if (Boolean(filePath) === Boolean(fileUrl)) throw new Error('GIVE_EXACTLY_ONE_OF_FILEPATH_OR_FILEURL');
  if (fileUrl) return loadUrl(fileUrl, fetcher);
  return loadLocal(filePath);
}

async function loadLocal(filePath) {
  const root = process.env.NABU_MESSAGING_FILE_ROOT;
  if (!root) throw new Error('LOCAL_FILES_DISABLED_SET_NABU_MESSAGING_FILE_ROOT');
  const base = path.resolve(root);
  const full = path.resolve(base, filePath);
  const rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('FILE_OUTSIDE_ALLOWED_ROOT');
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw new Error('FILE_NOT_FOUND');
  if (info.size > MAX_BYTES) throw new Error('FILE_TOO_LARGE');
  const name = path.basename(full);
  return { bytes: await readFile(full), name, mime: mimeFor(name) };
}

async function loadUrl(fileUrl, fetcher) {
  let url;
  try { url = new URL(fileUrl); } catch { throw new Error('INVALID_FILE_URL'); }
  if (url.protocol !== 'https:') throw new Error('FILE_URL_MUST_BE_HTTPS');
  const response = await fetcher(url.href, { redirect: 'follow' });
  if (!response.ok) throw new Error('FILE_DOWNLOAD_FAILED_' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error('FILE_TOO_LARGE');
  const name = decodeURIComponent(url.pathname.split('/').pop() || 'file');
  return { bytes, name, mime: response.headers?.get?.('content-type')?.split(';')[0] || mimeFor(name) };
}
