import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { renderAttemptHeaders } from '../../loader/src/model.js';
import {
  createExchangeCapture,
  prepareCaptureSecrets,
  type CaptureInput,
  type CaptureRow,
} from '../../loader/src/model-exchange-capture.js';
const input: CaptureInput = {
  callId: 'call',
  attempt: 1,
  slot: 'primary',
  taskId: null,
  sessionId: 'chat',
  inbound: {
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { authorization: 'Bearer caller-token' },
    body: 'request',
  },
  upstream: {
    method: 'POST',
    url: 'https://example.test/v1?key=url-secret',
    headers: { authorization: 'Bearer url-secret' },
    body: 'upstream',
  },
};
describe('bounded exchange capture', () => {
  it('redacts custom headers by name without scrubbing short values or the session globally', async () => {
    const rows: CaptureRow[] = [];
    const rendered = renderAttemptHeaders(
      {
        kind: 'openai',
        baseUrl: 'https://example.test',
        model: 'example',
        headers: [
          { name: 'x-affinity', value: '{session}' },
          { name: 'x-count', value: '1' },
          { name: 'x-locale', value: 'en' },
          { name: 'x-label', value: 'len' },
          { name: 'x-secret', value: 'private-header-credential-{session}' },
        ],
      },
      'chat'
    );
    expect(rendered.secrets).toEqual(['private-header-credential-chat']);
    const customInput: CaptureInput = {
      ...input,
      inbound: {
        ...input.inbound,
        headers: { ...input.inbound.headers, ...rendered.headers },
        body: `chat 1 en len ${rendered.secrets[0]}`,
      },
      upstream: { ...input.upstream, headers: rendered.headers },
    };
    const capture = createExchangeCapture({
      context: () => ({
        setting: { until: new Date(Date.now() + 600_000).toISOString() },
        secrets: ['url-secret'],
        secretHeaders: Object.keys(rendered.headers),
      }),
      write: async (row) => {
        rows.push(row);
      },
    });
    const attempt = capture.begin(customInput, {
      secrets: rendered.secrets,
      secretHeaders: Object.keys(rendered.headers),
    })!;
    attempt.response(200, rendered.headers);
    attempt.chunk(Buffer.from(customInput.inbound.body));
    attempt.finish();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]!.sessionId).toBe('chat');
    const exchange = rows[0]!.exchange;
    for (const part of ['inbound', 'upstream', 'response']) {
      const headers = (exchange[part] as { headers: Record<string, string> }).headers;
      for (const name of Object.keys(rendered.headers))
        expect(headers[name]).toMatch(/^\[redacted len=\d+\]$/);
    }
    expect((exchange.inbound as { body: string }).body).toBe('chat 1 en len [redacted len=30]');
    expect((exchange.response as { body: string }).body).toBe('chat 1 en len [redacted len=30]');
    expect(JSON.stringify(rows)).not.toContain('private-header-credential-chat');
    capture.close();
  });

  it('always scrubs short keys and passwords, using prepared raw, JSON and URL variants', async () => {
    const rows: CaptureRow[] = [];
    const credentials = ['QZ', 'PW', 'long-secret-"\\?+.*[]()$'];
    const preparedSecrets = prepareCaptureSecrets(credentials);
    const payload = preparedSecrets.join(' / ');
    const capture = createExchangeCapture({
      context: () => ({
        setting: { until: new Date(Date.now() + 600_000).toISOString() },
        secrets: [],
        preparedSecrets,
        secretHeaders: [],
      }),
      write: async (row) => {
        rows.push(row);
      },
    });
    const attempt = capture.begin({
      ...input,
      inbound: { ...input.inbound, body: payload },
      upstream: { ...input.upstream, body: payload },
    })!;
    attempt.chunk(Buffer.from(payload));
    attempt.finish();
    await expect.poll(() => rows.length).toBe(1);
    const serialized = JSON.stringify(rows[0]);
    for (const secret of preparedSecrets) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[redacted len=2]');
    expect(rows[0]!.serialized).toBe(JSON.stringify(rows[0]!.exchange));
    capture.close();
  });

  it('serializes once per row and yields between large-inventory finalizations', async () => {
    const rows: CaptureRow[] = [];
    // Far larger than two slots' bounded custom-header inventory. Preparation is off the call path.
    const preparedSecrets = prepareCaptureSecrets(
      Array.from(
        { length: 4096 },
        (_, index) => `credential-${index.toString(16).padStart(6, '0')}-static-private-value`
      )
    );
    const body = 'data: ordinary SSE content\n\n'.repeat(38_000);
    const capture = createExchangeCapture({
      context: () => ({
        setting: { until: new Date(Date.now() + 600_000).toISOString() },
        secrets: [],
        preparedSecrets,
        secretHeaders: [],
      }),
      write: async (row) => {
        rows.push(row);
      },
    });
    const calls = Array.from(
      { length: 4 },
      () =>
        capture.begin({
          ...input,
          inbound: { ...input.inbound, body },
          upstream: { ...input.upstream, body },
        })!
    );
    for (const call of calls) call.chunk(Buffer.from(body + preparedSecrets[0]));
    // A second SSE stream can continue on each turn, rather than waiting for all four rows.
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      for (const call of calls) call.finish();
      for (let turn = 0; turn < calls.length; turn++) {
        const started = performance.now();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(performance.now() - started).toBeLessThan(250);
        expect(stringify).toHaveBeenCalledTimes(turn + 1);
      }
    } finally {
      stringify.mockRestore();
    }
    await expect.poll(() => rows.length).toBe(calls.length);
    for (const row of rows) expect(row.serialized).not.toContain(preparedSecrets[0]);
    capture.close();
  });

  it('defers body scrubbing and row assembly, retaining its active slot until finalization', async () => {
    const rows: CaptureRow[] = [];
    let bodyReads = 0;
    let time = 1_000;
    const deferredInput: CaptureInput = {
      ...input,
      inbound: {
        ...input.inbound,
        get body() {
          bodyReads++;
          return 'private-secret request';
        },
      },
    };
    const capture = createExchangeCapture({
      active: 1,
      now: () => time,
      context: () => ({
        setting: { until: new Date(100_000).toISOString() },
        secrets: ['private-secret', 'url-secret'],
        secretHeaders: [],
      }),
      write: async (row) => {
        rows.push(row);
      },
    });
    const attempt = capture.begin(deferredInput)!;
    expect(bodyReads).toBe(0);
    attempt.response(200, {});
    attempt.chunk(Buffer.from('private-secret response'));
    time = 1_250;
    attempt.finish();
    attempt.finish();
    // Finished collectors cannot mutate the evidence while the finalizer is pending.
    attempt.chunk(Buffer.from('late mutation'));
    attempt.response(500, {});
    expect(bodyReads).toBe(0);
    expect(rows).toHaveLength(0);
    expect(capture.begin(input)).toBeUndefined();
    time = 1_500;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(bodyReads).toBeGreaterThan(0);
    await expect.poll(() => rows.length).toBe(1);
    expect(JSON.stringify(rows)).not.toContain('private-secret');
    expect(JSON.stringify(rows)).not.toContain('late mutation');
    expect(rows[0]!.exchange.timing).toMatchObject({ durationMs: 250 });
    expect(rows[0]!.exchange.response).toMatchObject({ status: 200 });
    expect(capture.begin(input)).toBeDefined();
    capture.close();
  });
  it('removes a long overlapping credential prefix at the retained response boundary', async () => {
    const rows: CaptureRow[] = [];
    const secret = 'a'.repeat(4095) + 'b';
    const capture = createExchangeCapture({
      bodyBytes: 32,
      context: () => ({
        setting: { until: new Date(Date.now() + 600_000).toISOString() },
        secrets: [secret, 'url-secret'],
        secretHeaders: [],
      }),
      write: async (row) => {
        rows.push(row);
      },
    });
    const attempt = capture.begin(input)!;
    attempt.chunk(Buffer.from('x'.repeat(33) + 'a'.repeat(4095)));
    attempt.chunk(Buffer.from('b' + 'tail'.repeat(100)));
    attempt.finish();
    await expect.poll(() => rows.length).toBe(1);
    const body = (rows[0]!.exchange.response as { body: string }).body;
    expect(body).toBe('x'.repeat(32) + '\n[truncated original_bytes=4529]');
    expect(body).not.toContain('aaa');
    capture.close();
  });
  it('drops pending raw finalization after close without writing', async () => {
    const rows: CaptureRow[] = [];
    const capture = createExchangeCapture({
      context: () => ({
        setting: { until: new Date(Date.now() + 600_000).toISOString() },
        secrets: [],
        secretHeaders: [],
      }),
      write: async (row) => {
        rows.push(row);
      },
    });
    const attempt = capture.begin(input)!;
    attempt.chunk(Buffer.from('private raw content'));
    attempt.finish();
    capture.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rows).toHaveLength(0);
  });

  it('redacts before truncating, including secrets crossing chunks and the retained cap', async () => {
    const rows: CaptureRow[] = [];
    const capture = createExchangeCapture({
      bodyBytes: 32,
      context: () => ({
        setting: { until: new Date(Date.now() + 600000).toISOString() },
        secrets: ['url-secret', 'boundary-secret'],
        secretHeaders: [],
      }),
      write: async (row) => {
        rows.push(row);
      },
    });
    const attempt = capture.begin(input)!;
    attempt.response(200, { 'set-cookie': 'cookie-secret' });
    attempt.chunk(Buffer.from('x'.repeat(28) + 'boundary-'));
    attempt.chunk(Buffer.from('secret caller-token ' + 'x'.repeat(100)));
    attempt.finish();
    await expect.poll(() => rows.length).toBe(1);
    const row = JSON.stringify(rows[0]);
    expect(row).toContain('truncated original_bytes=');
    for (const secret of ['url-secret', 'boundary-secret', 'caller-token', 'cookie-secret'])
      expect(row).not.toContain(secret);
    expect((rows[0]!.exchange.response as { body: string }).body).not.toContain('boundary');
    capture.close();
  });
  it('contains synchronous context and writer throws and bounds active attempts and queued work', async () => {
    const broken = createExchangeCapture({
      context: () => {
        throw Error('bad');
      },
      write: async () => undefined,
    });
    expect(() => broken.begin(input)).not.toThrow();
    let writes = 0;
    const capture = createExchangeCapture({
      active: 1,
      queue: 1,
      context: () => ({
        setting: { until: new Date(Date.now() + 600000).toISOString() },
        secrets: [],
        secretHeaders: [],
      }),
      write: () => {
        writes++;
        throw Error('bad');
      },
    });
    const first = capture.begin(input)!;
    expect(capture.begin(input)).toBeUndefined();
    first.finish();
    expect(capture.begin(input)).toBeUndefined();
    await expect.poll(() => writes).toBe(1);
    capture.close();
  });
});
