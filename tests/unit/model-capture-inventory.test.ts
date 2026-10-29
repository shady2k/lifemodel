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
    setting: { current: () => setting, refresh: async () => undefined },
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
    },
  });
  return {
    inventory,
    slots,
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
    await f.inventory.refresh();
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
  it('off never reads inventory/password files, compares slots or prunes before any capture', async () => {
    const f = fixture();
    f.setting = { until: null };
    await f.inventory.refresh();
    f.inventory.observeSlot('primary', f.slots.primary);
    expect(f.inventory.enabled()).toBe(false);
    expect(f.reads).toBe(0);
    expect(f.passwordReads).toBe(0);
    expect(f.prunes).toBe(0);
  });
  it('fails capture closed for stale inventory, expiry, session mismatch and config changes', async () => {
    const f = fixture();
    await f.inventory.refresh();
    expect(f.inventory.enabled()).toBe(true);
    f.time = 61001;
    expect(f.inventory.context('chat-session')).toBeUndefined();
    await f.inventory.refresh();
    f.setting = { until: new Date(1000000).toISOString(), session: 'only-chat' };
    expect(f.inventory.context('other')).toBeUndefined();
    expect(f.inventory.context('only-chat')).toBeDefined();
    f.inventory.observeSlot('primary', { state: 'absent' });
    expect(f.inventory.context('only-chat')).toBeUndefined();
    await f.inventory.refresh();
    f.time = 1000000;
    expect(f.inventory.enabled()).toBe(false);
    f.inventory.close();
  });
  it('prunes slowly after off only until the last enabled retention horizon', async () => {
    const f = fixture();
    await f.inventory.refresh();
    expect(f.prunes).toBe(1);
    f.setting = { until: null };
    f.time = 61001;
    await f.inventory.refresh();
    expect(f.prunes).toBe(2);
    f.time = 120001;
    await f.inventory.refresh();
    expect(f.prunes).toBe(2);
    f.time = 3600_000 + 61001;
    await f.inventory.refresh();
    expect(f.prunes).toBe(3);
    f.time = 24 * 3600_000 + 1001;
    await f.inventory.refresh();
    expect(f.prunes).toBe(3);
    expect(f.passwordReads).toBe(1);
  });
});
