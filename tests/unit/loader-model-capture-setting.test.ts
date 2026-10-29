import { describe, expect, it, vi } from 'vitest';
import { createCachedCaptureReader, createRoleBaoClient } from '../../loader/src/model-bao.js';
import {
  activeCaptureSetting,
  isCaptureEnabled,
  MAX_CAPTURE_DURATION_MS,
  validateCaptureSetting,
  type ModelCaptureSetting,
} from '../../loader/src/model-capture-setting.js';

const now = Date.parse('2026-10-29T10:00:00.000Z');
const on = (duration = 600_000): ModelCaptureSetting => ({
  until: new Date(now + duration).toISOString(),
});
describe('time-limited capture setting', () => {
  it('is off by default, expires exactly on time and optionally matches one session', () => {
    expect(isCaptureEnabled({ until: null }, undefined, now)).toBe(false);
    expect(isCaptureEnabled(on(), undefined, now)).toBe(true);
    expect(isCaptureEnabled(on(), undefined, now + 600_000)).toBe(false);
    const scoped = { ...on(), session: 'chat-1' };
    expect(isCaptureEnabled(scoped, 'chat-1', now)).toBe(true);
    expect(isCaptureEnabled(scoped, 'chat-2', now)).toBe(false);
    expect(isCaptureEnabled(scoped, undefined, now)).toBe(false);
    expect(activeCaptureSetting(scoped, now + 600_000)).toEqual({ until: null });
  });
  it('accepts at most 24 hours and refuses malformed expiry, session and extra fields', () => {
    expect(validateCaptureSetting(on(MAX_CAPTURE_DURATION_MS), now, true)).toEqual(
      on(MAX_CAPTURE_DURATION_MS)
    );
    for (const input of [
      null,
      {},
      [],
      { until: true },
      { until: 'tomorrow' },
      on(MAX_CAPTURE_DURATION_MS + 1),
      on(0),
      { until: null, session: 'chat' },
      { ...on(), session: '' },
      { ...on(), session: 'x'.repeat(129) },
      { ...on(), session: 'chat 1' },
      { ...on(), session: 'chat\n1' },
      { ...on(), extra: true },
    ]) {
      expect(() => validateCaptureSetting(input, now, true)).toThrow('capture_setting_invalid');
    }
    expect(validateCaptureSetting(on(-1), now)).toEqual(on(-1));
  });
  it('keeps current synchronous and off until a read completes, coalesces and refreshes changes', async () => {
    let time = now;
    let release!: (value: ModelCaptureSetting) => void;
    const read = vi.fn(
      () =>
        new Promise<ModelCaptureSetting>((resolve) => {
          release = resolve;
        })
    );
    const reader = createCachedCaptureReader(read, () => time);
    expect(reader.current()).toEqual({ until: null });
    const first = reader.refresh();
    expect(reader.refresh()).toBe(first);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    release(on());
    await first;
    expect(reader.current()).toEqual(on());
    time += 30_000;
    expect(reader.current()).toEqual(on());
    const changed = reader.refresh();
    await Promise.resolve();
    release({ until: null });
    await changed;
    expect(reader.current()).toEqual({ until: null });
  });
  it('checks expiry without refresh and fails closed instead of serving stale capture on error', async () => {
    let time = now;
    const read = vi.fn().mockResolvedValue(on());
    const reader = createCachedCaptureReader(read, () => time);
    await reader.refresh();
    expect(reader.current()).toEqual(on());
    read.mockRejectedValue(new Error('private storage failure'));
    await reader.refresh();
    expect(reader.current()).toEqual({ until: null });
    read.mockResolvedValue(on());
    await reader.refresh();
    time = now + 600_000;
    expect(reader.current()).toEqual({ until: null });
    await reader.refresh();
  });
});
describe('capture setting Bao boundary', () => {
  it('uses the existing model policy subtree, maps absent/deleted to off and writes only validated values', async () => {
    let status = 404;
    let response: unknown = {};
    const requests: { path: string; method: string; body?: string }[] = [];
    const bao = createRoleBaoClient({
      address: 'http://bao.test',
      role: 'loader',
      now: () => now,
      readJwt: async () => 'JWT',
      request: async (url, method, _token, body) => {
        if (url.pathname.endsWith('/login'))
          return {
            status: 200,
            body: JSON.stringify({ auth: { client_token: 'TOKEN', lease_duration: 3600 } }),
          };
        requests.push({ path: url.pathname, method, ...(body === undefined ? {} : { body }) });
        return { status, body: JSON.stringify(response) };
      },
    });
    expect(await bao.readCapture()).toEqual({ until: null });
    status = 200;
    response = { data: { data: { ...on(), session: 'chat-1' }, metadata: { version: 1 } } };
    expect(await bao.readCapture()).toEqual({ ...on(), session: 'chat-1' });
    await bao.writeCapture(on());
    expect(requests.at(-1)).toEqual({
      path: '/v1/lifemodel/data/model/capture',
      method: 'POST',
      body: JSON.stringify({ data: on() }),
    });
    await expect(bao.writeCapture(on(MAX_CAPTURE_DURATION_MS + 1))).rejects.toThrow(
      'capture_setting_invalid'
    );
    response = { data: { data: on(), metadata: { deletion_time: 'deleted' } } };
    expect(await bao.readCapture()).toEqual({ until: null });
    response = { data: { data: { until: 'bad' } } };
    await expect(bao.readCapture()).rejects.toMatchObject({ code: 'unreachable' });
    status = 403;
    await expect(bao.readCapture()).rejects.toMatchObject({ code: 'denied' });
  });
});
