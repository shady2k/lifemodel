// The proof runner: spawned by proof-stand.mts WITH the loader-shaped proxy
// environment already in place (Node's built-in proxy support takes it at
// initialization). Runs the real proofs with the REAL grammY Bot and the
// product transport; server-level records print in the stand at the end.
import assert from 'node:assert/strict';
import http from 'node:http';
import { Bot } from 'grammy';
import PAbortController from 'abort-controller';
import { proxyFetch } from '/home/dev/.herdr/worktrees/lifemodel/feature-lifemodel-q4x-transport-fix2/src/utils/proxy-fetch.js';

const LAN = process.env['LAN'];
const proxyPort = Number(process.env['PROXY_PORT']);
const tlsPort = Number(process.env['TLS_PORT']);
const forwardPort = Number(process.env['FORWARD_PORT']);
const apiRoot = `https://${LAN}:${tlsPort}`;

// ---- PROOF N3a: the real grammY Bot over HTTPS - its node shim's POLYFILL
// ---- signal - must reach the https:// API (a polyfill signal forwarded
// ---- unchanged is refused by Node's fetch before anything leaves).
{
  const bot = new Bot('__bot_token__', { client: { fetch: proxyFetch, apiRoot } });
  const me = await bot.api.getMe();
  assert.equal(me.username, 'q4xtf2_bot'); // grammY returns the result payload
  console.error('PROOF N3a bot-getMe-https: ok (me=q4xtf2_bot)');
}

// ---- PROOF N3b: cancellation BEFORE headers, polyfill signal, on the https
// ---- branch: the request must reject, not hang.
{
  const controller = new PAbortController();
  const pending = proxyFetch(`${apiRoot}/hang-headers-never`, { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const outcome = await Promise.race([
    pending.then(
      () => 'settled',
      (error) => `rejected:${error.name ?? error.constructor.name}`
    ),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5000)),
  ]);
  if (outcome === 'hung') {
    console.error('PROOF N3b pre-header abort FAILED: hung');
    process.exit(1);
  }
  console.error(`PROOF N3b pre-header abort: ${outcome}`);
}

// ---- PROOF N3c: cancellation DURING response consumption, polyfill signal:
// ---- the body read must reject after the abort.
{
  const controller = new PAbortController();
  const res = await proxyFetch(`${apiRoot}/hang-headers`, { signal: controller.signal });
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  setTimeout(() => controller.abort(), 100);
  const outcome = await Promise.race([
    reader.read().then(
      ({ done }) => `settled:${String(done)}`,
      (error) => `rejected:${String(error.message).slice(0, 40)}`
    ),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 5000)),
  ]);
  if (outcome === 'hung') {
    console.error('PROOF N3c mid-body abort FAILED: hung');
    process.exit(1);
  }
  if (!outcome.startsWith('rejected')) {
    console.error(`PROOF N3c mid-body abort FAILED: ${outcome}`);
    process.exit(1);
  }
  console.error(`PROOF N3c mid-body abort: ${outcome}`);
}

// ---- PROOF N4: an http:// endpoint answering 307 with an https:// location
// ---- must follow the second hop over CONNECT, not as an absolute-form
// ---- https:// request (the vault's forward path refuses that with a 400).
{
  const res = await proxyFetch(`http://127.0.0.2:${forwardPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer placeholder' },
    body: JSON.stringify({ model: 'q4xtf2-model' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, `the redirected https hop failed with ${String(res.status)}`);
  assert.equal(body.model, 'q4xtf2-model');
  console.error(
    `PROOF N4 http-to-https-307: ok (status ${String(res.status)} via CONNECT on the second hop)`
  );
}

console.error('PROOF RUNNER ALL OK');
process.exit(0);
