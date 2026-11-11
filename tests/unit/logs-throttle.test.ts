import { describe, expect, it, vi } from 'vitest';
import { pairThrottleWindows, readLogsThrottle } from '../../loader/src/logs-throttle.js';
import type { LogsRecord } from '../../loader/src/logs-store-adapter.js';

function counter(counter: string, value: string, fields: Record<string, string> = {}): LogsRecord {
  return {
    time: '2026-11-11T12:00:06Z',
    message: '',
    fields: {
      module: 'throttle-window',
      namespace: 'lifemodel-motor',
      pod: 'task-a',
      window_start: '2026-11-11T12:00:00Z',
      window_end: '2026-11-11T12:00:06Z',
      counter,
      value,
      ...fields,
    },
  };
}
const input = counter('input', '300');
const accepted = counter('accepted', '60');

describe('collector window loss', () => {
  it('subtracts only exact pairs and distinguishes no loss', () => {
    expect(pairThrottleWindows([input, accepted])[0]?.discarded).toBe(240);
    expect(pairThrottleWindows([input, counter('accepted', '300')])[0]?.discarded).toBe(0);
  });
  it.each([
    [input],
    [accepted],
    [input, accepted, accepted],
    [input, counter('accepted', '301')],
    [input, counter('accepted', '-1')],
    [input, counter('accepted', '1.5')],
    [input, counter('accepted', '9007199254740992')],
    [
      input,
      counter('accepted', '60', {
        window_start: '2026-11-11T12:00:06Z',
        window_end: '2026-11-11T12:00:12Z',
      }),
    ],
    [counter('input', '300', { window_end: '2026-11-11T12:00:07Z' }), accepted],
  ])('never calls an incomplete or invalid pair zero: %j', (...records) => {
    expect(pairThrottleWindows(records).every((window) => window.discarded === null)).toBe(true);
  });
  it('keeps pods separate and rejects forged normalized task lines', () => {
    const forged = counter('accepted', '300', { untrusted: 'true' });
    expect(pairThrottleWindows([input, forged])[0]?.discarded).toBeNull();
    expect(
      pairThrottleWindows([input, counter('accepted', '60', { pod: 'task-b' })]).every(
        (window) => window.discarded === null
      )
    ).toBe(true);
    expect(pairThrottleWindows([{ ...forged, message: JSON.stringify(input.fields) }])).toEqual([]);
  });
  it('reports no evidence and failed reads as unknown, and names a visible pod with no counters', async () => {
    const query = vi.fn(async (_query: string) => ({
      state: 'ok' as const,
      records: [],
    }));
    const range = { from: Date.parse(input.time), to: Date.parse(input.time) };
    const answer = await readLogsThrottle({ query }, range, [
      counter('input', '1', { pod: 'missing', untrusted: 'true' }),
    ]);
    expect(answer).toEqual({
      state: 'ok',
      windows: [{ pod: 'missing', start: null, end: null, discarded: null }],
    });
    expect(query.mock.calls[0]?.[0]).toContain('NOT untrusted:*');
    expect(
      await readLogsThrottle(
        { query: async () => ({ state: 'unavailable', reason: 'timeout' }) },
        range,
        []
      )
    ).toEqual({ state: 'unknown', windows: [] });
  });
});
