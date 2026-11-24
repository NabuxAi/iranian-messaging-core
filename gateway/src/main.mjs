#!/usr/bin/env node
// Entry point: node src/main.mjs (the Docker image runs this).
import { createApp, VERSION } from './app.mjs';
import { loadConfig, validateConfig } from './config.mjs';
import { log } from './log.mjs';

const config = loadConfig();
validateConfig(config);
const { app, messengers } = createApp(config);
const server = app.listen(config.port, config.host, () => {
  log('start', { version: VERSION, port: config.port, base_url: config.baseUrl, messengers: messengers.map(m => m.id),
    nabuauth: Boolean(config.nabuauth.clientId && config.nabuauth.clientSecret), internal_api: Boolean(config.internalToken) });
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
