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
      collector_start: '2026-11-11T11:59:59Z',
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
      state: 'unknown',
      windows: [
        { namespace: 'lifemodel-motor', pod: 'missing', start: null, end: null, discarded: null },
      ],
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

describe('incomplete collector lifetimes and missing windows', () => {
  it('reports a missing process start as unknown', () => {
    const missing = { ...input, fields: { ...input.fields } };
    delete missing.fields['collector_start'];
    expect(pairThrottleWindows([missing, accepted])[0]?.discarded).toBeNull();
  });

  it('does not report a partial startup window as exact loss', () => {
    const fields = { collector_start: '2026-11-11T12:00:02Z' };
    expect(
      pairThrottleWindows([counter('input', '300', fields), counter('accepted', '60', fields)])[0]
        ?.discarded
    ).toBeNull();
  });
  it('does not pair counters from different collector processes', () => {
    expect(
      pairThrottleWindows([
        input,
        counter('accepted', '60', { collector_start: '2026-11-11T11:59:58Z' }),
      ])[0]?.discarded
    ).toBeNull();
  });
  it('shows a whole missing pair between evidenced windows as unknown', async () => {
    const later = {
      collector_start: '2026-11-11T12:00:17Z',
      window_start: '2026-11-11T12:00:18Z',
      window_end: '2026-11-11T12:00:24Z',
    };
    const records = [
      input,
      accepted,
      counter('input', '300', later),
      counter('accepted', '60', later),
    ];
    const result = await readLogsThrottle(
      { query: async () => ({ state: 'ok', records }) },
      { from: Date.parse(input.time), to: Date.parse('2026-11-11T12:00:24Z') },
      []
    );
    expect(result.state).toBe('unknown');
    expect(result.windows).toContainEqual({
      namespace: 'lifemodel-motor',
      pod: 'task-a',
      start: '2026-11-11T12:00:06.000Z',
      end: '2026-11-11T12:00:18.000Z',
      discarded: null,
    });
    expect(result.windows.filter((window) => window.discarded === 240)).toHaveLength(2);
  });
  it('keeps gap work bounded even for very distant observations', () => {
    const later = {
      collector_start: '2036-11-11T11:59:59Z',
      window_start: '2036-11-11T12:00:00Z',
      window_end: '2036-11-11T12:00:06Z',
    };
    const windows = pairThrottleWindows([
      input,
      accepted,
      counter('input', '300', later),
      counter('accepted', '60', later),
    ]);
    expect(windows).toHaveLength(3);
    expect(windows[2]?.discarded).toBeNull();
  });
});

describe('all untrusted namespace identities', () => {
  it('keeps a visible empty untrusted identity unknown without counters', async () => {
    const answer = await readLogsThrottle(
      { query: async () => ({ state: 'ok', records: [] }) },
      { from: 0, to: 6000 },
      [counter('input', '1', { namespace: '', pod: '', untrusted: 'true' })]
    );
    expect(answer).toEqual({
      state: 'unknown',
      windows: [{ namespace: '', pod: '', start: null, end: null, discarded: null }],
    });
  });

  it('does not mix equal pod names from different namespaces', () => {
    const records = [input, counter('accepted', '60', { namespace: 'other' })];
    expect(pairThrottleWindows(records)).toHaveLength(2);
    expect(pairThrottleWindows(records).every((window) => window.discarded === null)).toBe(true);
    expect(
      pairThrottleWindows([
        counter('input', '3', { namespace: '', pod: '' }),
        counter('accepted', '3', { namespace: '', pod: '' }),
      ])
    ).toMatchObject([{ namespace: '', pod: '', discarded: 0 }]);
  });
  it('does not turn same-process idle windows into unknown loss for a 10-second writer', async () => {
    const records = [
      counter('input', '1'),
      counter('accepted', '1'),
      counter('input', '1', {
        window_start: '2026-11-11T12:00:12Z',
        window_end: '2026-11-11T12:00:18Z',
      }),
      counter('accepted', '1', {
        window_start: '2026-11-11T12:00:12Z',
        window_end: '2026-11-11T12:00:18Z',
      }),
    ];
    const answer = await readLogsThrottle(
      { query: async () => ({ state: 'ok', records }) },
      { from: 0, to: Date.parse('2026-11-11T12:01:00Z') },
      []
    );
    expect(answer.state).toBe('ok');
    expect(answer.windows).toHaveLength(2);
    expect(answer.windows.every((window) => window.discarded === 0)).toBe(true);
  });
  it('reports a visible untrusted pod without counters in any namespace as unknown', async () => {
    const answer = await readLogsThrottle(
      { query: async () => ({ state: 'ok', records: [] }) },
      { from: 0, to: 6000 },
      [counter('input', '1', { namespace: 'external', untrusted: 'true' })]
    );
    expect(answer).toMatchObject({
      state: 'unknown',
      windows: [{ namespace: 'external', pod: 'task-a', discarded: null }],
    });
  });
});
