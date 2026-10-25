/** Offline workbench smoke. Inject this fixture + test cert into an existing image. */
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const fixtureRoot = process.env.SMOKE_FIXTURE_ROOT ?? '/opt/task-harness-smoke';
const ids = {
  taskId: `task_${'a'.repeat(64)}`,
  attemptId: `attempt_${'b'.repeat(64)}`,
  launchId: `launch_${'c'.repeat(64)}`,
};
const space = 'smoke_space';
const briefing = 'SMOKE-BRIEFING-PRIVATE-CANARY';
const result = 'SMOKE-RESULT-PRIVATE-CANARY';
const tokens = {
  model: 'SMOKE-MODEL-TOKEN-PRIVATE-CANARY',
  channel: 'SMOKE-CHANNEL-TOKEN-PRIVATE-CANARY',
  storage: 'SMOKE-STORAGE-TOKEN-PRIVATE-CANARY',
};
const cert = await readFile(`${fixtureRoot}/certificate.crt`);
const key = await readFile(`${fixtureRoot}/certificate.key`);
const servers = [];
const sockets = new Set();
const calls = [];
const objects = new Map();
const terminalFrames = [];
const traceFrames = [];
const violations = [];
let child;
let startWon = false;
let starts = 0;
let briefingGets = 0;
let modelCalls = 0;
let durableAtTerminal;
let stdout = '';
let stderr = '';
let deadline;

function metadata(object) {
  return {
    id: object.id,
    name: object.name,
    size: object.size,
    sha256: object.sha256,
    mark: object.mark,
  };
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
function fail(code, res) {
  violations.push(code);
  if (res) json(res, 400, { error: { message: 'smoke_protocol_failed' } });
}
async function handler(service, req, res) {
  const parts = [];
  let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > 4 * 1024 * 1024) {
      fail('request_too_large', res);
      return;
    }
    parts.push(part);
  }
  const body = Buffer.concat(parts);
  calls.push({ service, method: req.method, path: req.url });
  if (service === 'model' && req.url.startsWith('/v1/')) {
    if (req.headers['x-lifemodel-task-token'] !== tokens.model || req.headers.authorization) {
      fail('model_task_header', res);
      return;
    }
    if (!startWon) {
      fail('model_before_start', res);
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      json(res, 200, { data: [{ id: 'task' }] });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      fail('model_route', res);
      return;
    }
    modelCalls++;
    const request = JSON.parse(body.toString());
    if (!JSON.stringify(request.messages).includes(briefing)) {
      fail('model_missing_briefing', res);
      return;
    }
    if (!request.stream) {
      fail('model_missing_stream', res);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'chatcmpl-smoke', object: 'chat.completion.chunk', created: 1, model: 'task', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      );
    // Literal SSE frames, intentionally no timers or network beyond loopback.
    chunk({ role: 'assistant' });
    chunk({ content: result });
    chunk({}, 'stop');
    res.end('data: [DONE]\n\n');
    return;
  }
  if (req.headers.authorization !== `Bearer ${tokens[service]}`) {
    fail(`${service}_bearer`, res);
    return;
  }
  if (service === 'model' && req.method === 'POST' && req.url === '/task/start') {
    starts++;
    const claim = JSON.parse(body.toString());
    if (
      starts !== 1 ||
      claim.taskId !== ids.taskId ||
      claim.attemptId !== ids.attemptId ||
      claim.launchId !== ids.launchId ||
      !/^[a-f0-9-]{36}$/.test(claim.bootNonce) ||
      Object.keys(claim).length !== 4
    ) {
      fail('start_claim', res);
      return;
    }
    startWon = true;
    json(res, 200, {
      ...ids,
      start: true,
      space,
      hardStopAt: new Date(Date.now() + 120_000).toISOString(),
    });
    return;
  }
  if (service === 'channel' && req.method === 'GET' && req.url === '/task/identity') {
    json(res, 200, ids);
    return;
  }
  if (service === 'channel' && req.method === 'GET' && req.url === '/task/briefing') {
    briefingGets++;
    if (!startWon || briefingGets !== 1) {
      fail('briefing_gate', res);
      return;
    }
    json(res, 200, {
      ...ids,
      briefing,
      harness: 'opencode',
      traceId: ids.taskId,
      parentSpanId: null,
    });
    return;
  }
  // Disposable observations use their own route, not durable event ACKs or
  // storage marks. The image smoke checks transport/identity and token scrubbing.
  if (service === 'channel' && req.method === 'POST' && req.url === '/task/trace') {
    const frame = JSON.parse(body.toString());
    const span = frame.span;
    if (
      frame.taskId !== ids.taskId ||
      frame.attemptId !== ids.attemptId ||
      frame.launchId !== ids.launchId ||
      span?.traceId !== ids.taskId ||
      typeof span.spanId !== 'string' ||
      !(span.spanId === ids.launchId || span.spanId.startsWith(`${ids.launchId}_`)) ||
      !(
        span.parentSpanId === null ||
        span.parentSpanId === ids.launchId ||
        (typeof span.parentSpanId === 'string' && span.parentSpanId.startsWith(`${ids.launchId}_`))
      ) ||
      typeof span.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(span.startedAt)) ||
      ![null, 'ok', 'failed', 'suppressed'].includes(span.status)
    ) {
      fail('trace_identity', res);
      return;
    }
    if (Object.values(tokens).some((secret) => JSON.stringify(frame).includes(secret))) {
      fail('trace_token_canary', res);
      return;
    }
    traceFrames.push(frame);
    json(res, 200, { accepted: true });
    return;
  }
  if (service === 'channel' && req.method === 'POST' && req.url === '/task/events') {
    const frame = JSON.parse(body.toString());
    if (
      frame.taskId !== ids.taskId ||
      frame.attemptId !== ids.attemptId ||
      frame.direction !== 'task_to_core' ||
      !/^msg_[a-f0-9-]{36}$/.test(frame.messageId) ||
      !Number.isSafeInteger(frame.sequence)
    ) {
      fail('frame_identity', res);
      return;
    }
    if (frame.kind === 'terminal') {
      terminalFrames.push(frame);
      durableAtTerminal = [...objects.values()]
        .filter((object) => object.mark !== null)
        .map((object) => object.id);
      if (frame.payload.outcome !== 'succeeded' || terminalFrames.length !== 1) {
        fail('terminal_outcome', res);
        return;
      }
      if (
        objects.get(frame.payload.resultObjectId)?.mark !== 'result' ||
        !Array.isArray(frame.payload.artifactObjectIds) ||
        frame.payload.artifactObjectIds.some((id) => objects.get(id)?.mark !== 'artifact') ||
        Object.hasOwn(frame.payload, 'logObjectId') ||
        [...objects.values()].some((object) => object.mark === 'log' || object.name === 'log.jsonl')
      ) {
        fail('terminal_before_marks', res);
        return;
      }
    } else if (frame.kind !== 'step') {
      fail('frame_kind', res);
      return;
    }
    if (
      [briefing, result, ...Object.values(tokens)].some((secret) =>
        JSON.stringify(frame).includes(secret)
      )
    ) {
      fail('channel_canary', res);
      return;
    }
    json(res, 200, {
      taskId: frame.taskId,
      attemptId: frame.attemptId,
      direction: frame.direction,
      messageId: frame.messageId,
      sequence: frame.sequence,
      receivedAt: new Date().toISOString(),
    });
    return;
  }
  const base = `/spaces/${space}/objects`;
  if (service === 'storage' && req.method === 'PUT' && req.url.startsWith(`${base}/upload_`)) {
    const name = Buffer.from(String(req.headers['x-storage-name']), 'base64url').toString();
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (
      req.headers['x-storage-sha256'] !== sha256 ||
      req.headers['x-storage-length'] !== String(body.length)
    ) {
      fail('storage_upload_metadata', res);
      return;
    }
    const object = {
      id: `object_${objects.size + 1}`,
      name,
      size: body.length,
      sha256,
      mark: null,
      bytes: body,
    };
    objects.set(object.id, object);
    json(res, 201, metadata(object));
    return;
  }
  if (service === 'storage' && req.method === 'POST' && req.url.endsWith('/mark')) {
    const object = objects.get(req.url.slice(base.length + 1, -'/mark'.length));
    const { role } = JSON.parse(body.toString());
    if (!object || !['result', 'log', 'artifact'].includes(role)) {
      fail('storage_mark', res);
      return;
    }
    object.mark = role;
    json(res, 200, metadata(object));
    return;
  }
  if (service === 'storage' && req.method === 'GET' && req.url.startsWith(`${base}?`)) {
    json(res, 200, { objects: [...objects.values()].map(metadata), nextCursor: null });
    return;
  }
  fail(`${service}_unexpected_route`, res);
}

try {
  await mkdir('/work/home', { recursive: true });
  await mkdir('/work/tmp', { recursive: true });
  const env = {};
  for (const service of ['model', 'channel', 'storage']) {
    const prefix =
      service === 'storage' ? 'LIFEMODEL_STORAGE' : `LIFEMODEL_TASK_${service.toUpperCase()}`;
    const tokenFile = `/work/${service}.token`;
    await writeFile(tokenFile, tokens[service], { mode: 0o600 });
    const server = createServer({ cert, key }, (req, res) => {
      req.on('error', () => {});
      res.on('error', () => {});
      void handler(service, req, res).catch(() => {
        violations.push(`${service}_handler_failed`);
        res.destroy();
      });
    });
    server.on('error', () => {});
    server.on('tlsClientError', () => {});
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    env[`${prefix}_ENDPOINT`] = `https://localhost:${address.port}`;
    env[`${prefix}_TOKEN_FILE`] = tokenFile;
    env[`${prefix}_CA_FILE`] = `${fixtureRoot}/certificate.crt`;
  }
  env.LIFEMODEL_STORAGE_SPACE = space;
  assert.equal(Object.keys(env).length, 10);
  // Only the exact ten task-projected values are added to the baked image env.
  child = spawn(
    'strace',
    [
      '-f',
      '-e',
      'trace=connect',
      '-o',
      '/work/startup-connect.trace',
      '/usr/local/bin/lifemodel-task-launcher',
    ],
    {
      cwd: '/work',
      env: { ...process.env, ...env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    if (stdout.length > 128 * 1024) child.kill('SIGKILL');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 128 * 1024) child.kill('SIGKILL');
  });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  deadline = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }, 110_000);
  const exit = await exited;
  clearTimeout(deadline);
  const safeDiagnostics = stderr.split('\n').filter((line) => /^[a-z][a-z0-9_]{0,63}$/.test(line));
  assert.equal(
    exit.code,
    0,
    `launcher_exit=${exit.code} signal=${exit.signal} diagnostics=${safeDiagnostics.join(',')}`
  );
  assert.equal(starts, 1);
  assert.equal(briefingGets, 1);
  assert.equal(modelCalls, 1);
  assert.equal(terminalFrames.length, 1);
  assert.equal(objects.size, 1);
  const report = terminalFrames[0].payload;
  assert.deepEqual(report.artifactObjectIds, []);
  assert.equal(Object.hasOwn(report, 'logObjectId'), false, 'removed_log_field');
  assert.deepEqual(durableAtTerminal, [report.resultObjectId]);
  assert.equal(objects.get(report.resultObjectId).bytes.toString(), result);
  assert.ok(
    [...objects.values()].every((object) => object.mark !== 'log' && object.name !== 'log.jsonl'),
    'removed_log_object'
  );
  assert.ok(traceFrames.length > 0, 'trace_requests_observed');
  assert.ok(
    traceFrames.some((frame) => frame.span.spanId === ids.launchId),
    'trace_root_observed'
  );
  for (const secret of [briefing, result, ...Object.values(tokens)]) {
    assert.ok(!stdout.includes(secret) && !stderr.includes(secret), 'launcher_output_canary');
  }
  for (const secret of Object.values(tokens)) {
    assert.ok(!JSON.stringify(traceFrames).includes(secret), 'trace_token_canary');
  }
  assert.deepEqual(violations, []);
  const trace = await readFile('/work/startup-connect.trace', 'utf8');
  const connections = trace.split('\n').filter((line) => line.includes('connect('));
  const internet = connections.filter((line) => line.includes('AF_INET'));
  const nonLoopback = internet.filter((line) => {
    const addresses = [
      ...line.matchAll(/(?:inet_addr\("([^"]+)"\)|inet_pton\(AF_INET6, "([^"]+)")/g),
    ].map((match) => match[1] ?? match[2]);
    return (
      !addresses.length ||
      addresses.some(
        (address) =>
          address !== '::1' && !address.startsWith('127.') && !address.startsWith('::ffff:127.')
      )
    );
  });
  assert.deepEqual(nonLoopback, [], 'non_loopback_connect_attempt');
  console.log(
    JSON.stringify({
      network: 'loopback_only_connects',
      connectCalls: connections.length,
      internetConnectCalls: internet.length,
    })
  );
  console.log(
    JSON.stringify({
      smoke: 'task_launcher_image_offline_ok',
      starts,
      briefingGets,
      modelCalls,
      objects: objects.size,
      terminalReports: terminalFrames.length,
      traceRequests: traceFrames.length,
      childExit: exit.code,
      calls,
    })
  );
} catch (error) {
  console.error(
    `task_launcher_image_smoke_failed ${error instanceof Error ? error.message : 'unknown'}`
  );
  console.error(
    JSON.stringify({
      starts,
      briefingGets,
      modelCalls,
      objects: objects.size,
      terminalReports: terminalFrames.length,
      traceRequests: traceFrames.length,
      violations,
      calls,
    })
  );
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
}
