// One place for every outbound call to a messenger API: fixed timeout,
// JSON or multipart bodies, and errors that never echo the bot token.
const TIMEOUT_MS = Number(process.env.NABU_MESSAGING_TIMEOUT_MS || 15000);

export class ProviderError extends Error {
  constructor(code, detail) {
    super(code);
    this.detail = detail;
  }
}

export async function callApi(url, { json, form, method = 'POST', headers = {} } = {}, fetcher = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const init = { method, headers: { ...headers }, signal: controller.signal };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (form !== undefined) {
    init.body = form;
  }
  try {
    const response = await fetcher(url, init);
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      throw new ProviderError('PROVIDER_HTTP_ERROR_' + response.status, describe(body));
    }
    return body;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error?.name === 'AbortError') throw new ProviderError('PROVIDER_TIMEOUT');
    // Only the error code: a raw message can contain the URL, and with it the token.
    throw new ProviderError('PROVIDER_UNREACHABLE', error?.cause?.code || error?.code || error?.name);
  } finally {
    clearTimeout(timer);
  }
}

// Short, token-free summary of an error body for the agent to act on.
function describe(body) {
  if (!body || typeof body !== 'object') return undefined;
  const text = body.description || body.message || body.error || body.status_det || body.status;
  return text ? String(text).slice(0, 300) : undefined;
}

export function formFrom(fields, file) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  if (file) form.append(file.field, new Blob([file.bytes], { type: file.mime }), file.name);
  return form;
}
