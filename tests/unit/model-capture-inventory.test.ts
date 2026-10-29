import { describe, expect, it } from 'vitest';
import { createCaptureInventory } from '../../loader/src/model-capture-inventory.js';
import {
  createExchangeCapture,
  type CaptureInput,
  type CaptureRow,
} from '../../loader/src/model-exchange-capture.js';
import type { ModelCaptureSetting } from '../../loader/src/model-capture-setting.js';
import type { ModelSlotName, SlotRead } from '../../loader/src/model.js';
const primaryKey = 'primary-key-secret-012345';
const reserveKey = 'reserve-key-secret-012345';
const dbPassword = 'capture-password-012345';
const taskPassword = 'task-password-012345';
function fixture() {
  let time = 1000;
  let remaining = false;
  let pruneFailure = false;
  let pruneWait: Promise<void> | undefined;
  let settingFailure = false;
  let setting: ModelCaptureSetting = { until: new Date(1000000).toISOString() };
  let reads = 0,
    passwordReads = 0,
    prunes = 0;
  const slots: Record<ModelSlotName, SlotRead> = {
    primary: {
      state: 'present',
      version: 1,
      slot: {
        kind: 'openai',
        baseUrl: 'https://primary.test',
        model: 'primary',
        key: primaryKey,
        headers: [
          { name: 'x-affinity', value: '{session}' },
          { name: 'x-short', value: 'len' },
          { name: 'x-long', value: 'long-header-secret-012345' },
        ],
      },
    },
    reserve: {
      state: 'present',
      version: 1,
      slot: { kind: 'openai', baseUrl: 'https://reserve.test', model: 'reserve', key: reserveKey },
    },
  };
  const inventory = createCaptureInventory({
    now: () => time,
    setting: {
      current: () => setting,
      refresh: async () => {
        if (settingFailure) throw new Error('settings_unavailable');
      },
    },
    readSlot: async (name) => {
      reads++;
      return slots[name];
    },
    passwords: async () => {
      passwordReads++;
      return [dbPassword, taskPassword];
    },
    prune: async () => {
      prunes++;
      if (pruneFailure) throw new Error('unavailable');
      const result = remaining;
      if (pruneWait) await pruneWait;
      return result;
    },
  });
  return {
    inventory,
    slots,
    async refresh() {
      await inventory.refresh();
      // Refresh intentionally does not await retention I/O. Let the fixture's
      // immediate prune result settle through its then/catch/finally chain.
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    set remaining(v: boolean) {
      remaining = v;
    },
    set pruneFailure(v: boolean) {
      pruneFailure = v;
    },
    set settingFailure(v: boolean) {
      settingFailure = v;
    },
    set pruneWait(v: Promise<void> | undefined) {
      pruneWait = v;
    },
    get reads() {
      return reads;
    },
    get passwordReads() {
      return passwordReads;
    },
    get prunes() {
      return prunes;
    },
    set time(v: number) {
      time = v;
    },
    set setting(v: ModelCaptureSetting) {
      setting = v;
    },
  };
}
const input: CaptureInput = {
  callId: 'call-inventory',
  attempt: 1,
  slot: 'primary',
  taskId: null,
  sessionId: 'chat-session',
  inbound: { method: 'POST', path: '/v1/chat/completions', headers: {}, body: '' },
  upstream: {
    method: 'POST',
    url: 'https://primary.test',
    headers: {
      'x-affinity': 'chat-session',
      'x-short': 'len',
      'x-long': 'long-header-secret-012345',
    },
    body: '',
  },
};
describe('production model capture inventory', () => {
  it('scrubs reserve key and BOTH DB passwords across the whole real-inventory row while preserving session/short ordinary values', async () => {
    const f = fixture();
    await f.refresh();
    const rows: CaptureRow[] = [];
    const capture = createExchangeCapture({
      now: () => 1000,
      context: (i) => f.inventory.context(i.sessionId),
      write: async (row) => {
        rows.push(row);
      },
    });
    const raw = [
      primaryKey,
      reserveKey,
      dbPassword,
      taskPassword,
      'long-header-secret-012345',
      'chat-session',
      'len',
    ].join(' ');
    const attempt = capture.begin({
      ...input,
      inbound: { ...input.inbound, body: raw },
      upstream: { ...input.upstream, body: raw },
    })!;
    attempt.response(200, { 'x-echo': reserveKey });
    attempt.chunk(Buffer.from(raw));
    attempt.finish();
    await expect.poll(() => rows.length).toBe(1);
    const stored = JSON.stringify(rows[0]);
    for (const secret of [
      primaryKey,
      reserveKey,
      dbPassword,
      taskPassword,
      'long-header-secret-012345',
    ])
      expect(stored).not.toContain(secret);
    expect(rows[0]?.sessionId).toBe('chat-session');
    expect(rows[0]?.exchange.upstream).toMatchObject({
      headers: { 'x-affinity': '[redacted len=12]', 'x-short': '[redacted len=3]' },
    });
    expect(stored).toContain('chat-session len');
    capture.close();
    f.inventory.close();
  });
  it('admits production inventory evidence with a one-character configured slot key', async () => {
    const f = fixture();
    if (f.slots.primary.state !== 'present') throw new Error('fixture_slot_absent');
    f.slots.primary.slot.key = 'e';
    await f.refresh();
    const rows: CaptureRow[] = [];
    const capture = createExchangeCapture({
      now: () => 1000,
      context: (i) => f.inventory.context(i.sessionId),
      write: async (row) => {
        rows.push(row);
      },
    });
    const attempt = capture.begin({
      ...input,
      inbound: { ...input.inbound, body: 'e' },
      upstream: { ...input.upstream, body: 'e' },
    })!;
    attempt.response(200, { 'x-key': 'e' });
    attempt.chunk(Buffer.from('e'));
    attempt.finish();
    await expect.poll(() => rows.length).toBe(1);
    expect(rows[0]!.exchange.upstream).toMatchObject({ body: '[redacted len=1]' });
    expect(rows[0]!.exchange.response).toMatchObject({ body: '[redacted len=1]' });
    expect(capture.dropped()).toEqual({});
    capture.close();
    f.inventory.close();
  });
  it('off prunes once at startup without reading the secret inventory or comparing slots', async () => {
    const f = fixture();
    f.setting = { until: null };
    await f.refresh();
    f.inventory.observeSlot('primary', f.slots.primary);
    expect(f.inventory.enabled()).toBe(false);
    expect(f.reads).toBe(0);
    expect(f.passwordReads).toBe(0);
    expect(f.prunes).toBe(1);
    f.time = 3600_000 + 1000;
    await f.refresh();
    expect(f.prunes).toBe(1);
    f.inventory.close();
  });
  it('fails capture closed for stale inventory, expiry, session mismatch and config changes', async () => {
    const f = fixture();
    await f.refresh();
    expect(f.inventory.enabled()).toBe(true);
    f.time = 61001;
    expect(f.inventory.context('chat-session')).toBeUndefined();
    await f.refresh();
    f.setting = { until: new Date(1000000).toISOString(), session: 'only-chat' };
    expect(f.inventory.context('other')).toBeUndefined();
    expect(f.inventory.context('only-chat')).toBeDefined();
    f.inventory.observeSlot('primary', { state: 'absent' });
    expect(f.inventory.context('only-chat')).toBeUndefined();
    await f.refresh();
    f.time = 1000000;
    expect(f.inventory.enabled()).toBe(false);
    f.inventory.close();
  });
  it('continues hourly retention after restart with capture off until the database is empty', async () => {
    const f = fixture();
    f.setting = { until: null };
    f.remaining = true; // Retained rows belong to a previous gateway process.
    await f.refresh();
    expect(f.prunes).toBe(1);
    f.time = 3600_000;
    await f.refresh();
    expect(f.prunes).toBe(1);
    f.time = 3600_000 + 1000;
    await f.refresh();
    expect(f.prunes).toBe(2);
    // No in-memory 24-hour horizon may stop cleanup while rows still exist.
    f.time = 25 * 3600_000;
    f.remaining = false;
    await f.refresh();
    expect(f.prunes).toBe(3);
    f.time = 26 * 3600_000;
    await f.refresh();
    expect(f.prunes).toBe(3);
    expect(f.reads).toBe(0);
    expect(f.passwordReads).toBe(0);
    f.inventory.close();
  });
  it('re-arms retention for writes that finish after an off prune found an empty table', async () => {
    const f = fixture();
    f.setting = { until: null };
    let release!: () => void;
    f.pruneWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    await f.inventory.refresh();
    expect(f.prunes).toBe(1);
    // Prune has read an empty table, but its result is still in flight.
    f.inventory.noteWrite();
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.pruneWait = undefined;
    f.time = 3600_000 + 1000;
    await f.refresh();
    expect(f.prunes).toBe(2);
    // A later write must also restart maintenance after a settled empty result.
    f.inventory.noteWrite();
    f.time = 2 * 3600_000 + 1000;
    await f.refresh();
    expect(f.prunes).toBe(3);
    f.inventory.close();
  });
  it('maintains retained evidence even if the capture setting cannot refresh', async () => {
    const f = fixture();
    f.settingFailure = true;
    f.remaining = true;
    await f.refresh();
    expect(f.prunes).toBe(1);
    f.time = 3600_000 + 1000;
    await f.refresh();
    expect(f.prunes).toBe(2);
    expect(f.inventory.enabled()).toBe(false);
    expect(f.passwordReads).toBe(0);
    f.inventory.close();
  });
  it('prunes each minute while enabled and retries failed maintenance hourly while off', async () => {
    const f = fixture();
    await f.refresh();
    expect(f.prunes).toBe(1);
    f.time = 61000;
    f.pruneFailure = true;
    await f.refresh();
    await expect.poll(() => f.prunes).toBe(2);
    f.setting = { until: null };
    f.time = 121000;
    await f.refresh();
    expect(f.prunes).toBe(3);
    f.time = 181000;
    await f.refresh();
    expect(f.prunes).toBe(3);
    f.pruneFailure = false;
    f.time = 3600_000 + 121000;
    await f.refresh();
    expect(f.prunes).toBe(4);
    f.time = 2 * 3600_000 + 121000;
    await f.refresh();
    expect(f.prunes).toBe(4);
    f.inventory.close();
  });
});
