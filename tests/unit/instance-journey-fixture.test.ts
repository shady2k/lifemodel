import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  buildInstanceJourneyScript,
  createJourneyFacade,
  JOURNEY_FIXTURE,
  type FixtureTransport,
  type JourneyFixtureConfig,
} from '../integration/helpers/instance-journey-fixture.js';

// Already-rendered legacy source: \\n produces a literal source escape.
// This minimal generic handler does not claim exact repository equivalence.
const minimalLegacyScript = `import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
const rawJournal = '/tmp/q4x32-requests.jsonl';
createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    appendFileSync(rawJournal, JSON.stringify({
      method: req.method, url: req.url, headers: req.headers, body: raw
    }) + '\\n');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
}).listen(8080, '0.0.0.0');
`;

function config(): JourneyFixtureConfig {
  return {
    syntheticOnly: true,
    tls: {
      keyPath: '/fixture/key.pem',
      certPath: '/fixture/cert.pem',
      publicCaPath: '/fixture/ca.pem',
    },
    credentials: {
      modelKey: 'fixture-model',
      telegramToken: '900001:fixture-token',
      controlKey: 'fixture-control',
    },
    ownerChatId: 123,
    phases: [
      { id: 'first', updateId: 101, triggerUser: 'trigger one', answer: 'answer one' },
      { id: 'second', updateId: 102, triggerUser: 'trigger two', answer: 'answer two' },
    ],
    holdCeilingMs: 5000,
  };
}

function parse(script: string) {
  const result = spawnSync(
    process.execPath,
    ['--check', '--input-type=module'],
    { input: script, timeout: 5000, encoding: 'utf8' },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

describe('journey builder: pure validation', () => {
  it.each([
    ['syntheticOnly', (c: JourneyFixtureConfig) => Object.assign(c, { syntheticOnly: false })],
    ['ownerChatId', (c: JourneyFixtureConfig) => { c.ownerChatId = 1.5; }],
    ['modelKey', (c: JourneyFixtureConfig) => { c.credentials.modelKey = 'real-key'; }],
    ['controlKey', (c: JourneyFixtureConfig) => { c.credentials.controlKey = 'real-key'; }],
    ['telegramToken', (c: JourneyFixtureConfig) => { c.credentials.telegramToken = '123:real'; }],
    ['empty phases', (c: JourneyFixtureConfig) => { c.phases = []; }],
    ['empty trigger', (c: JourneyFixtureConfig) => { c.phases[0].triggerUser = ''; }],
    ['empty answer', (c: JourneyFixtureConfig) => { c.phases[0].answer = ''; }],
    ['empty id', (c: JourneyFixtureConfig) => { c.phases[0].id = ''; }],
    ['zero update', (c: JourneyFixtureConfig) => { c.phases[0].updateId = 0; }],
    ['fractional update', (c: JourneyFixtureConfig) => { c.phases[0].updateId = 1.5; }],
  ])('rejects %s', (_name, mutate) => {
    const c = config();
    mutate(c);
    expect(() => buildInstanceJourneyScript(minimalLegacyScript, c)).toThrow();
  });

  it.each(['id', 'updateId', 'triggerUser', 'answer'] as const)(
    'rejects duplicate phase %s', field => {
      const c = config();
      Object.assign(c.phases[1], { [field]: c.phases[0][field] });
      expect(() => buildInstanceJourneyScript(minimalLegacyScript, c))
        .toThrow(`Phase ${field} values must be distinct`);
    },
  );

  it.each([0, -1, 1.5, 120001, NaN, Infinity])('rejects hold ceiling %s', value => {
    const c = config();
    c.holdCeilingMs = value;
    expect(() => buildInstanceJourneyScript(minimalLegacyScript, c)).toThrow();
  });

  it.each([undefined, 1, 120000])('accepts hold ceiling %s', value => {
    const c = config();
    c.holdCeilingMs = value;
    expect(() => buildInstanceJourneyScript(minimalLegacyScript, c)).not.toThrow();
  });

  it.each([
    "import { createServer } from 'node:http';",
    "import { appendFileSync } from 'node:fs';",
  ])('requires exactly one legacy import: %s', statement => {
    for (const legacy of [
      minimalLegacyScript.replace(statement, ''),
      minimalLegacyScript + '\n' + statement,
    ]) {
      expect(() => buildInstanceJourneyScript(legacy, config())).toThrow();
    }
  });

  it('preserves two-phase input history without mutating it', () => {
    const c = config();
    const before = JSON.stringify(c);
    const script = buildInstanceJourneyScript(minimalLegacyScript, c);
    expect(JSON.stringify(c)).toBe(before);
    expect(script).toContain(`const C = ${before};`);
    expect(script).toContain(`const F = ${JSON.stringify(JOURNEY_FIXTURE)};`);
    // Static generation checks only, not routing, polling or gate execution.
    expect(script).toContain('Math.min(timeout * 1000, 20000)');
    expect(script).toContain('C.holdCeilingMs ?? 110000');
  });
});

describe('generated ESM: native parse only', () => {
  it('rejects the old nested fs import and accepts the repaired source', () => {
    const repaired = buildInstanceJourneyScript(minimalLegacyScript, config());
    const broken = repaired.replace(
      'let legacyHandler;\n{',
      "let legacyHandler;\n{\nimport { appendFileSync } from 'node:fs';",
    );
    expect(broken).not.toBe(repaired);
    expect(parse(broken).status).not.toBe(0);
    const result = parse(repaired);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(['plain', 'quote " slash \\ newline\n', '${notInterpolation}`\r\n'])(
    'parses generated source with escaped phase text: %s', text => {
      const c = config();
      c.phases[0].triggerUser = text;
      c.phases[0].answer = text + ' answer';
      const result = parse(buildInstanceJourneyScript(minimalLegacyScript, c));
      expect(result.status, result.stderr).toBe(0);
    },
  );
});

describe('journey façade: isolated in-memory transport', () => {
  it('sends exact DTOs and returns parsed health, journal and control replies', async () => {
    const requests: Parameters<FixtureTransport>[0][] = [];
    const health = {
      ready: true, httpPort: 8080, tlsPort: 443,
      modelName: JOURNEY_FIXTURE.modelName, journalPath: JOURNEY_FIXTURE.journalPath,
    };
    const journal = [{ seq: 1, event: 'update.queued', phase: 'first' }];
    const replies = [health, journal, { ok: true }, { ok: true }, { ok: true }];
    const facade = createJourneyFacade(async request => {
      requests.push(request);
      return { status: 200, body: JSON.stringify(replies.shift()) };
    }, 'fixture-control');
    expect(await facade.health()).toEqual(health);
    expect(await facade.journal()).toEqual(journal);
    const commands = [
      { op: 'queue', phase: 'first' },
      { op: 'hold', phase: 'second', model: true, send: false },
      { op: 'release', phase: 'second', gate: 'model' },
    ] as const;
    for (const command of commands) expect(await facade.control(command)).toEqual({ ok: true });
    expect(requests).toEqual([
      { method: 'GET', path: JOURNEY_FIXTURE.healthPath },
      { method: 'GET', path: JOURNEY_FIXTURE.journalApiPath },
      ...commands.map(command => ({
        method: 'POST', path: JOURNEY_FIXTURE.controlPath, body: JSON.stringify(command),
      })),
    ].map(request => ({
      ...request,
      headers: { authorization: 'Bearer fixture-control', 'content-type': 'application/json' },
    })));
  });

  it.each([401, 500])('rejects status %s without exposing response secrets', async status => {
    const facade = createJourneyFacade(async () => ({
      status, body: 'private-body fixture-control',
    }), 'fixture-control');
    await expect(facade.health()).rejects.toThrow(`fixture HTTP ${status}`);
    await facade.health().catch(error => {
      expect(String(error)).not.toMatch(/private-body|fixture-control/);
    });
  });

  it('rejects malformed JSON without exposing body or control key', async () => {
    const facade = createJourneyFacade(async () => ({
      status: 200, body: 'private-body fixture-control',
    }), 'fixture-control');
    await expect(facade.journal()).rejects.toThrow('fixture returned invalid JSON');
    await facade.journal().catch(error => {
      expect(String(error)).not.toMatch(/private-body|fixture-control/);
    });
  });
});
