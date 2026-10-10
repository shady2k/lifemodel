/**
 * External synthetic fixture only. No I/O occurs when this module is imported.
 * Root supplies the unchanged legacy STUB_SCRIPT and mounts existing TLS files.
 * Private key: fixture only, read-only. Public CA: instance system trust before
 * Vault starts. Preserve the instance's client-to-Vault CA configuration.
 */
export const JOURNEY_FIXTURE = {
  httpPort: 8080,
  tlsPort: 443,
  aliases: ['q4x32-stub.local', 'portal-model.local', 'api.telegram.org'],
  legacyJournalPath: '/tmp/q4x32-requests.jsonl',
  journalPath: '/tmp/instance-journey.jsonl',
  controlPath: '/__journey/control',
  healthPath: '/__journey/health',
  journalApiPath: '/__journey/journal',
  modelName: 'portal-proof-model',
  telegramPlaceholder: '__telegram_token__',
} as const;

export interface JourneyPhase {
  id: string;
  updateId: number;
  triggerUser: string;
  answer: string;
}
export interface JourneyFixtureConfig {
  syntheticOnly: true;
  tls: { keyPath: string; certPath: string; publicCaPath: string };
  credentials: {
    modelKey: string;
    telegramToken: string;
    controlKey: string;
  };
  ownerChatId: number;
  phases: JourneyPhase[];
  holdCeilingMs?: number;
}
export type JourneyCommand =
  | { op: 'queue'; phase: string }
  | { op: 'hold'; phase: string; model: boolean; send: boolean }
  | { op: 'release'; phase: string; gate: 'model' | 'send' };
export interface JourneyEvent {
  seq: number;
  event: string;
  phase?: string;
  requestId?: number;
  [key: string]: unknown;
}
export interface JourneyHealth {
  ready: boolean;
  httpPort: number;
  tlsPort: number;
  modelName: string;
  journalPath: string;
}
export type FixtureTransport = (request: {
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; body: string }>;

/** Root supplies an isolated control transport, not the instance's proxy. */
export function createJourneyFacade(transport: FixtureTransport, controlKey: string) {
  async function call<T>(path: string, command?: JourneyCommand): Promise<T> {
    const reply = await transport({
      method: command ? 'POST' : 'GET', path,
      headers: {
        authorization: `Bearer ${controlKey}`,
        'content-type': 'application/json',
      },
      ...(command ? { body: JSON.stringify(command) } : {}),
    });
    if (reply.status !== 200) throw new Error(`fixture HTTP ${reply.status}`);
    try {
      return JSON.parse(reply.body) as T;
    } catch {
      throw new Error('fixture returned invalid JSON');
    }
  }
  return {
    health: () => call<JourneyHealth>(JOURNEY_FIXTURE.healthPath),
    journal: () => call<JourneyEvent[]>(JOURNEY_FIXTURE.journalApiPath),
    control: (command: JourneyCommand) =>
      call<{ ok: true }>(JOURNEY_FIXTURE.controlPath, command),
  };
}

export function buildInstanceJourneyScript(
  legacyStubScript: string,
  config: JourneyFixtureConfig,
): string {
  const c = config;
  if (c.syntheticOnly !== true ||
      !Number.isSafeInteger(c.ownerChatId) ||
      !c.credentials.modelKey.startsWith('fixture-') ||
      !c.credentials.controlKey.startsWith('fixture-') ||
      !/^\d+:fixture-[A-Za-z0-9_-]+$/.test(c.credentials.telegramToken) ||
      !c.phases.length ||
      c.phases.some(p => !p.id || !p.triggerUser || !p.answer ||
        !Number.isSafeInteger(p.updateId) || p.updateId < 1)) {
    throw new Error('Invalid synthetic fixture configuration');
  }
  for (const field of ['id', 'updateId', 'triggerUser', 'answer'] as const) {
    if (new Set(c.phases.map(p => p[field])).size !== c.phases.length) {
      throw new Error(`Phase ${field} values must be distinct`);
    }
  }
  if (c.holdCeilingMs !== undefined &&
      (!Number.isInteger(c.holdCeilingMs) ||
       c.holdCeilingMs < 1 || c.holdCeilingMs > 120_000)) {
    throw new Error('Hold ceiling must be 1..120000 ms');
  }
  const oldImport = "import { createServer } from 'node:http';";
  if (legacyStubScript.split(oldImport).length !== 2) {
    throw new Error('Expected the supplied legacy HTTP import');
  }
  // Capture the original handler without opening its listener. Its journal
  // and response code remain unchanged, including their original escaping.
  const oldFsImport = "import { appendFileSync } from 'node:fs';";
  if (legacyStubScript.split(oldFsImport).length !== 2) {
    throw new Error('Expected the supplied legacy filesystem import');
  }
  const legacy = legacyStubScript.replace(oldFsImport, '').replace(
    oldImport,
    `const createServer = handler => {
      legacyHandler = handler;
      return { listen() {} };
    };`,
  );
  return String.raw`import { createServer as httpServer } from 'node:http';
import { createServer as tlsServer } from 'node:https';
import { appendFileSync, readFileSync, openSync, writeSync, fsyncSync } from 'node:fs';
const C = ${JSON.stringify(c)};
const F = ${JSON.stringify(JOURNEY_FIXTURE)};
let legacyHandler;
{
${legacy}
}
const fd = openSync(F.journalPath, 'a', 0o600);
const events = [];
let seq = 0, requestId = 0, messageId = 0, httpReady = false, tlsReady = false;
const phases = new Map(C.phases.map(p => [p.id, {
  ...p, queued: false, holdModel: false, holdSend: false
}]));
const updates = [];
const polls = new Set();
const holds = new Set();
const secrets = Object.values(C.credentials);
function redact(value) {
  if (typeof value === 'string') {
    for (const secret of secrets) {
      value = value.split(secret).join('[redacted]');
      value = value.split(encodeURIComponent(secret)).join('[redacted]');
    }
    return value.replace(/\/bot[^/]+/g, '/bot[redacted]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,redact(v)]));
  return value;
}
function record(event, fields = {}) {
  const entry = redact({ seq: ++seq, event, ...fields });
  const bytes = Buffer.from(JSON.stringify(entry) + '\n');
  let n = 0;
  while (n < bytes.length) n += writeSync(fd, bytes, n, bytes.length - n);
  fsyncSync(fd);
  events.push(entry);
}
function reply(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
function fail(res, status = 400) {
  reply(res, status, { ok: false, description: 'fixture request rejected' });
}
function telegram(res, result) { reply(res, 200, { ok: true, result }); }
function fields(req, url, raw) {
  const query = Object.fromEntries(url.searchParams);
  if (!raw) return query;
  const body = String(req.headers['content-type'] || '').includes('application/json')
    ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
  return { ...query, ...body };
}
function gate(req, res, p, kind, id, send) {
  if (!(kind === 'model' ? p.holdModel : p.holdSend)) return send();
  const h = { p, kind, release: null };
  let done = false;
  function finish(reason) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    holds.delete(h);
    res.off('close', closed);
    record(kind + '.' + reason, { phase: p.id, requestId: id });
    if (reason === 'released') send();
    else fail(res, 504);
  }
  const closed = () => finish('aborted');
  const timer = setTimeout(() => finish('expired'), C.holdCeilingMs ?? 110000);
  h.release = () => finish('released');
  holds.add(h);
  res.once('close', closed);
  record(kind + '.held', { phase: p.id, requestId: id });
}
function poll(req, res, data, id) {
  const offset = Number(data.offset ?? 0);
  const timeout = Number(data.timeout ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isFinite(timeout) || timeout < 0) return fail(res);
  // poll is reached only after the real Telegram token and host checks.
  record('telegram.poll.request', {
    requestId: id, offset, authenticated: true
  });
  for (let i = updates.length - 1; i >= 0; --i)
    if (updates[i].update_id < offset) updates.splice(i, 1);
  let done = false, timer;
  const p = { wake };
  function finish(result, aborted = false) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    polls.delete(p);
    res.off('close', closed);
    record(aborted ? 'telegram.poll.aborted' : 'telegram.poll.response',
      { requestId: id, updateIds: result.map(u => u.update_id) });
    if (!aborted) telegram(res, result);
  }
  function wake() {
    const available = updates.filter(u => u.update_id >= offset);
    if (available.length) finish(available);
  }
  const closed = () => finish([], true);
  res.once('close', closed);
  polls.add(p);
  timer = setTimeout(() => finish([]), Math.min(timeout * 1000, 20000));
  wake();
}
function control(req, res, url, raw) {
  if (req.headers.authorization !== 'Bearer ' + C.credentials.controlKey)
    return fail(res, 403);
  if (req.method === 'GET' && url.pathname === F.healthPath)
    return reply(res, 200, { ready: httpReady && tlsReady,
      httpPort: F.httpPort, tlsPort: F.tlsPort,
      modelName: F.modelName, journalPath: F.journalPath });
  if (req.method === 'GET' && url.pathname === F.journalApiPath)
    return reply(res, 200, events);
  if (req.method !== 'POST' || url.pathname !== F.controlPath) return fail(res, 404);
  const cmd = JSON.parse(raw), p = phases.get(cmd.phase);
  if (!p) return fail(res);
  if (cmd.op === 'hold') {
    if (typeof cmd.model !== 'boolean' || typeof cmd.send !== 'boolean' ||
        [...holds].some(h => h.p === p)) return fail(res, 409);
    p.holdModel = cmd.model; p.holdSend = cmd.send;
  } else if (cmd.op === 'release' && ['model','send'].includes(cmd.gate)) {
    if (cmd.gate === 'model') p.holdModel = false; else p.holdSend = false;
    for (const h of [...holds]) if (h.p === p && h.kind === cmd.gate) h.release();
  } else if (cmd.op === 'queue') {
    if (p.queued) return fail(res, 409);
    p.queued = true;
    updates.push({ update_id: p.updateId, message: {
      message_id: p.updateId, date: Math.floor(Date.now()/1000),
      from: { id: C.ownerChatId, is_bot: false, first_name: 'Fixture' },
      chat: { id: C.ownerChatId, type: 'private', first_name: 'Fixture' },
      text: p.triggerUser
    } });
    updates.sort((a,b) => a.update_id - b.update_id);
    record('update.queued', { phase: p.id, updateId: p.updateId });
    for (const pending of [...polls]) pending.wake();
  } else return fail(res);
  reply(res, 200, { ok: true });
}
async function handle(req, res, secure) {
  try {
    const url = new URL(req.url, 'http://fixture.invalid');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1048576) return fail(res, 413);
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!secure && url.pathname.startsWith('/__journey/'))
      return control(req, res, url, raw);
    const data = fields(req, url, raw);
    const host = String(req.headers.host || '');
    const hostname = host.split(':')[0].toLowerCase();
    // Only original synthetic probe inputs reach the unchanged raw journal.
    const oldAuth = req.headers.authorization;
    const oldBot = req.headers['x-q4x32-bot'];
    const legacyModel = url.pathname === '/v1/chat/completions' &&
      (raw === '{}' || (data.model === 'q4x32-stub' &&
        Array.isArray(data.messages) && data.messages.length === 0 &&
        Object.keys(data).every(k => ['model','messages'].includes(k))));
    const legacyBot = url.pathname === '/bot/q4x32-made-up-bot-token-0002/sendMessage' &&
      raw === 'chat_id=1&text=hello';
    if (!secure && hostname === 'q4x32-stub.local' &&
        (legacyModel || legacyBot) &&
        [undefined,'Bearer q4x32-made-up-model-key-0001'].includes(oldAuth) &&
        [undefined,'q4x32-made-up-bot-token-0002'].includes(oldBot) &&
        !req.headers['proxy-authorization']) {
      // The stream was consumed above; replay only its original data/end events.
      const replay = Object.create(req);
      replay.on = (name, fn) => {
        if (name === 'data') fn(Buffer.from(raw));
        if (name === 'end') fn();
        return replay;
      };
      return legacyHandler(replay, res);
    }
    const id = ++requestId;
    if (!secure && hostname === 'portal-model.local' &&
        url.pathname === '/v1/chat/completions') {
      const newestUser = Array.isArray(data.messages)
        ? data.messages.findLast(m => m && m.role === 'user') : undefined;
      const content = newestUser?.content;
      const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content
          .filter(part => part && part.type === 'text' &&
            typeof part.text === 'string')
          .map(part => part.text).join('') : '';
      // buildTriggerPrompt appends the current trigger LAST.
      // History and memory must never license a phase by substring.
      const finalInput = [...text.matchAll(
        /<user_input>([\s\S]*?)<\/user_input>/g
      )].at(-1);
      const currentInput = finalInput &&
        text.slice(finalInput.index + finalInput[0].length).trim() === ''
        ? finalInput[1] : undefined;
      const matched = [...phases.values()].filter(p =>
        currentInput !== undefined && currentInput === p.triggerUser);
      const p = matched.length === 1 ? matched[0] : undefined;
      const expectedNativeS8field = !!p &&
        currentInput === p.triggerUser &&
        text.endsWith('<user_input>' + p.triggerUser + '</user_input>');
      const authorizationMatch = oldAuth === 'Bearer ' + C.credentials.modelKey;
      record('model.request', { requestId: id, phase: p?.id,
        actualHost: host, model: data.model, authorizationMatch,
        expectedNativeS8field });
      if (!authorizationMatch) return fail(res, 401);
      if (req.method !== 'POST' || data.model !== F.modelName || !p ||
          !p.queued || data.stream === true) return fail(res);
      return gate(req, res, p, 'model', id, () => {
        if (res.destroyed || res.writableEnded) {
          record('model.response.aborted', { phase: p.id, requestId: id });
          return;
        }
        let completed = false;
        res.once('finish', () => {
          completed = true;
          record('model.response', { phase: p.id, requestId: id });
        });
        res.once('close', () => {
          if (!completed) record('model.response.aborted', { phase: p.id, requestId: id });
        });
        reply(res, 200, { id: 'chatcmpl-fixture-' + id, object: 'chat.completion',
          created: Math.floor(Date.now()/1000), model: F.modelName,
          choices: [{ index: 0, message: { role: 'assistant', content: p.answer },
            finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      });
    }
    const path = decodeURIComponent(url.pathname);
    const match = /^\/bot([^/]+)\/(getMe|deleteWebhook|getUpdates|sendMessage)$/.exec(path);
    const tokenMatch = !!match && match[1] === C.credentials.telegramToken;
    record('telegram.request', { requestId: id, actualHost: host,
      method: match?.[2] ?? 'unknown', tokenMatch });
    if (!secure || hostname !== 'api.telegram.org' || !tokenMatch)
      return fail(res, 401);
    if (match[2] === 'getMe') return telegram(res, {
      id: 900001, is_bot: true, first_name: 'Fixture',
      username: 'synthetic_fixture_bot', can_join_groups: true,
      can_read_all_group_messages: false, supports_inline_queries: false
    });
    if (match[2] === 'deleteWebhook') return telegram(res, true);
    if (match[2] === 'getUpdates') return poll(req, res, data, id);
    const p = [...phases.values()].find(p => p.answer === data.text && p.queued);
    const chatMatch = String(data.chat_id) === String(C.ownerChatId);
    record('telegram.send.request', { requestId: id, phase: p?.id,
      chatMatch, text: data.text });
    if (!p || !chatMatch) return fail(res);
    return gate(req, res, p, 'send', id, () => {
      const result = { message_id: ++messageId, date: Math.floor(Date.now()/1000),
        from: { id: 900001, is_bot: true, first_name: 'Fixture' },
        chat: { id: C.ownerChatId, type: 'private', first_name: 'Fixture' },
        text: p.answer };
      res.once('finish', () => record('telegram.send.ack',
        { phase: p.id, requestId: id, messageId: result.message_id }));
      telegram(res, result);
    });
  } catch { fail(res); }
}
httpServer((req,res) => void handle(req,res,false))
  .listen(F.httpPort, '0.0.0.0', () => {
    httpReady = true;
    console.log('q4x32 stub listening on 8080');
  });
tlsServer({ key: readFileSync(C.tls.keyPath), cert: readFileSync(C.tls.certPath),
  minVersion: 'TLSv1.2' }, (req,res) => void handle(req,res,true))
  .listen(F.tlsPort, '0.0.0.0', () => {
    tlsReady = true;
    console.log('journey TLS fixture listening on 443');
  });
`;
}
