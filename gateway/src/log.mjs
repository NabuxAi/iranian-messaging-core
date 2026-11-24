// One-line JSON logs. Never a token, code, cookie, query string or message
// body: the access log prints the path only, with account keys and session
// ids cut down to their prefix.
let sink = line => process.stdout.write(line + '\n');
export const setLogSink = fn => { sink = fn; };

export function log(event, fields = {}) {
  sink(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

export function redactPath(p) {
  return String(p || '').split('?')[0]
    .replace(/(irm_[a-z]+_)[a-z0-9]+/gi, '$1…')
    .replace(/(\/internal\/v1\/connect\/)(?!methods|start)[^/]+/, '$1…')
    .replace(/(\/oauth\/consent\/)[^/]+/, '$1…')
    .slice(0, 200);
}

export function accessLog(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number((process.hrtime.bigint() - started) / 1000000n);
    log('http', { method: req.method, path: redactPath(req.originalUrl), status: res.statusCode, ms });
  });
  next();
}
