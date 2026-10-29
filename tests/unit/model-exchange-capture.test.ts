import { describe, expect, it } from 'vitest';
import {
  createExchangeCapture,
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
