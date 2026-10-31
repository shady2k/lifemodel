import { describe, expect, it, vi } from 'vitest';
import { createCachedCaptureReader, createRoleBaoClient } from '../../loader/src/model-bao.js';
import {
  activeCaptureSetting,
  captureSettingFromRequest,
  isCaptureEnabled,
  MAX_CAPTURE_DURATION_MS,
  validateCaptureSetting,
  validateCaptureSettingResponse,
  type ModelCaptureSetting,
} from '../../loader/src/model-capture-setting.js';

const now = Date.parse('2026-10-29T10:00:00.000Z');
const on = (duration = 600_000): ModelCaptureSetting => ({
  until: new Date(now + duration).toISOString(),
});
describe('capture setting', () => {
  it('represents until disabled explicitly in requests, stored values and responses, with the same session filter', () => {
    for (const session of [undefined, 'chat-1']) {
      const scope = session === undefined ? {} : { session };
      const value = { mode: 'until-disabled', ...scope } as const;
      expect(captureSettingFromRequest({ mode: 'until-disabled', ...scope }, now)).toEqual(value);
      expect(validateCaptureSetting(value, now, true)).toEqual(value);
      expect(validateCaptureSetting(value, now + 30 * MAX_CAPTURE_DURATION_MS)).toEqual(value);
      expect(validateCaptureSettingResponse(value)).toEqual(value);
      expect(activeCaptureSetting(value, now + 30 * MAX_CAPTURE_DURATION_MS)).toEqual(value);
      expect(isCaptureEnabled(value, session, now + 30 * MAX_CAPTURE_DURATION_MS)).toBe(true);
    }
    const scoped = { mode: 'until-disabled', session: 'chat-1' } as const;
    expect(isCaptureEnabled(scoped, 'chat-2', now)).toBe(false);
    expect(isCaptureEnabled(scoped, undefined, now)).toBe(false);
  });
  it('refuses malformed indefinite requests and stored/response variants', () => {
    for (const input of [
      { mode: 'until-disabled', durationMs: null },
      { mode: 'until-disabled', durationMs: 600_000 },
      { mode: 'until-disabled', until: null },
      { mode: 'until-disabled', extra: true },
      { mode: 'until-disabled', session: '' },
      { mode: 'until-disabled', session: 'bad session' },
      { mode: 'until-disabled', session: 'x'.repeat(129) },
      { mode: 'forever' },
      { mode: true },
      { durationMs: 'until-disabled' },
    ])
      expect(() => captureSettingFromRequest(input, now)).toThrow('capture_setting_invalid');
    for (const input of [
      { until: 'forever' },
      { until: 'until_disabled' },
      { mode: 'until-disabled', durationMs: null },
      { mode: 'until-disabled', until: null },
      { mode: 'until-disabled', until: new Date(now + 600_000).toISOString() },
      { until: 'until-disabled' },
      { mode: 'until-disabled', session: '' },
      { mode: 'until-disabled', session: 'bad session' },
      { mode: 'until-disabled', session: 'x'.repeat(129) },
      { mode: 'forever' },
    ]) {
      expect(() => validateCaptureSetting(input, now)).toThrow('capture_setting_invalid');
      expect(() => validateCaptureSetting(input, now, true)).toThrow('capture_setting_invalid');
      expect(() => validateCaptureSettingResponse(input)).toThrow('capture_setting_invalid');
    }
  });
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
  it('derives expiry only from server time and accepts an explicit off request', () => {
    expect(captureSettingFromRequest({ durationMs: MAX_CAPTURE_DURATION_MS }, now)).toEqual(
      on(MAX_CAPTURE_DURATION_MS)
    );
    expect(captureSettingFromRequest({ durationMs: 600_000, session: 'chat-1' }, now)).toEqual({
      ...on(),
      session: 'chat-1',
    });
    expect(captureSettingFromRequest({ durationMs: null }, now)).toEqual({ until: null });
  });
  it('refuses unbounded durations, client timestamps and malformed request fields', () => {
    for (const input of [
      null,
      [],
      {},
      { durationMs: undefined },
      { durationMs: true },
      { durationMs: '600000' },
      { durationMs: 0 },
      { durationMs: -1 },
      { durationMs: 0.5 },
      { durationMs: NaN },
      { durationMs: Infinity },
      { durationMs: MAX_CAPTURE_DURATION_MS + 1 },
      { durationMs: null, session: 'chat-1' },
      { durationMs: 600_000, session: '' },
      { durationMs: 600_000, session: 'bad session' },
      { durationMs: 600_000, session: 'x'.repeat(129) },
      { durationMs: 600_000, extra: true },
      { durationMs: 600_000, until: on().until },
      on(),
      { until: null },
    ]) {
      expect(() => captureSettingFromRequest(input, now)).toThrow('capture_setting_invalid');
    }
  });
  it('validates server responses without applying the browser clock to the 24h ceiling', () => {
    const response = { ...on(MAX_CAPTURE_DURATION_MS), session: 'chat-1' };
    expect(() => validateCaptureSetting(response, now - 60_000)).toThrow('capture_setting_invalid');
    expect(validateCaptureSettingResponse(response)).toEqual(response);
    for (const invalid of [
      { until: 'bad' },
      { until: null, session: 'chat-1' },
      { ...response, extra: true },
    ])
      expect(() => validateCaptureSettingResponse(invalid)).toThrow('capture_setting_invalid');
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
    const indefinite = { mode: 'until-disabled', session: 'chat-1' } as const;
    response = { data: { data: indefinite, metadata: { version: 2 } } };
    expect(await bao.readCapture()).toEqual(indefinite);
    await bao.writeCapture(indefinite);
    expect(JSON.parse(requests.at(-1)!.body!)).toEqual({ data: indefinite });
    response = { data: { data: { ...indefinite, durationMs: null } } };
    await expect(bao.readCapture()).rejects.toMatchObject({ code: 'unreachable' });
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
