import { describe, expect, it } from 'vitest';
import { Script, createContext } from 'node:vm';
import * as crypto from 'node:crypto';
import {
  InstanceStableSnapshot,
  STABLE_SNAPSHOT_SCRIPT,
} from '../integration/helpers/instance-stable-snapshot.js';

const base = '/var/lib/lifemodel/';
const receiptPath = 'data/state/core/inbound_log.json';
const secret = 'fixture-private-value-never-print';
const head = 'a'.repeat(40);
interface Item {
  bytes: Buffer;
  uid: number;
  gid: number;
  mode: number;
  kind: 'file' | 'directory' | 'symlink';
}
function receipt() {
  return {
    version: 2, savedAt: '2026-10-10T08:00:00.000Z', nextSeq: 5,
    recentKeys: ['old-key', '220001', '220002'],
    recipients: {
      chat: { committedThrough: 1, committedBeyond: [3] },
      other: { committedThrough: 0, committedBeyond: [] },
    },
    entries: [{
      seq: 2, key: '220001', recipientId: 'chat',
      routing: { channel: 'telegram', destination: '4242' },
      signal: {
        id: 'signal-1', type: 'user_message', source: 'sense.telegram',
        timestamp: { __date: '2026-10-10T08:00:00.000Z' },
        priority: 1, metrics: { value: 1, confidence: 1 },
        data: {
          kind: 'user_message', updateId: '220001', recipientId: 'chat', channel: 'telegram',
          text: secret, encodedAt: { __date: '2026-10-10T08:00:00.000Z' },
          pendingPhoto: { fileId: secret },
        },
        extraSignal: [secret, { nested: true }],
      },
      extraEntry: secret,
    }],
    extraEnvelope: { durable: secret },
  };
}
function fixture() {
  const files = new Map<string, Item>();
  const put = (
    path: string, content: unknown, uid: number, mode: number,
    kind: Item['kind'] = 'file',
  ) => files.set(base + path, {
    bytes: Buffer.from(typeof content === 'string' ? content : JSON.stringify(content)),
    uid, gid: uid, mode, kind,
  });
  for (const path of ['repo', 'data']) put(path, '', 1000, 0o755, 'directory');
  for (const path of ['loader', 'vault']) put(path, '', 0, 0o700, 'directory');
  put('repo/package.json', { name: secret }, 1000, 0o644);
  put('data/config/agent.json', { endpoint: secret }, 1000, 0o644);
  put('loader/auth.json', {
    version: 1, algorithm: 'scrypt', salt: Buffer.alloc(16, 1).toString('base64'), hash: Buffer.alloc(32, 2).toString('base64'),
    cost: { N: 32768, r: 8, p: 1, keylen: 32 },
    sessionSecret: Buffer.alloc(32, 3).toString('base64'), createdAt: '2026-10-10T08:00:00.000Z',
  }, 0, 0o600);
  put('loader/cli-token', secret + '\n', 0, 0o600);
  put('loader/vault-owner.json', {
    version: 1, email: 'owner@lifemodel.local', password: secret,
  }, 0, 0o600);
  put('loader/vault-proxy.json', {
    version: 1, vault: 'lifemodel', agent: 'lifemodel', token: secret,
  }, 0, 0o600);
  put('vault-ca.pem', secret, 0, 0o644);
  put('loader/state.json', {
    version: 1, builtCommit: head, updatedAt: '2026-10-10T08:00:00.000Z', extra: secret,
  }, 0, 0o600);
  put('loader/panic.json', {
    at: '2026-10-10T08:00:00.000Z', reason: secret, extra: secret,
  }, 0, 0o600);
  put(receiptPath, receipt(), 1000, 0o644);
  return { files, put };
}
function execute(f: ReturnType<typeof fixture>) {
  let stdout = '';
  let stderr = '';
  const processDouble = {
    argv: ['node', head], exitCode: 0,
    stdout: { write: (s: string) => { stdout += s; } },
    stderr: { write: (s: string) => { stderr += s; } },
  };
  const get = (path: string) => {
    const item = f.files.get(path);
    if (!item) throw Object.assign(new Error(secret), { code: 'ENOENT' });
    return item;
  };
  const fsDouble = {
    readFileSync: (path: string) => Buffer.from(get(path).bytes),
    lstatSync: (path: string) => {
      const item = get(path);
      return {
        uid: item.uid, gid: item.gid, mode: item.mode, size: item.bytes.length,
        isFile: () => item.kind === 'file',
        isDirectory: () => item.kind === 'directory',
      };
    },
  };
  const context = createContext({
    Buffer, process: processDouble,
    require: (name: string) => {
      if (name === 'node:fs') return fsDouble;
      if (name === 'node:crypto') return crypto;
      throw new Error('Unexpected require');
    },
  });
  expect('__name' in context).toBe(false);
  new Script(STABLE_SNAPSHOT_SCRIPT).runInContext(context, { timeout: 1000 });
  expect((stdout + stderr).includes(secret)).toBe(false);
  expect(Buffer.byteLength(stdout + stderr)).toBeLessThanOrEqual(16 * 1024);
  return { stdout, stderr, code: processDouble.exitCode };
}
function rejected(f: ReturnType<typeof fixture>) {
  expect(execute(f)).toEqual({
    stdout: '', stderr: 'Stable OCI snapshot failed', code: 1,
  });
}
describe('standalone stable snapshot script with mock filesystem', () => {
  it('executes the emitted string and validates hash-only output', () => {
    const result = execute(fixture());
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const v = new InstanceStableSnapshot().stableFingerprint(result.stdout);
    expect(v.inboundReceipt.entryCount).toBe(1);
    expect(v.loaderBuiltCommit).toBe(head);
    expect(v.cliToken.sha256).toBe(
      crypto.createHash('sha256').update(secret + '\n').digest('hex'));
    expect(v.panic.present).toBe(true);
  });
  it('rejects malformed durable receipts', () => {
    for (const raw of [
      '{', JSON.stringify({ ...receipt(), version: 1 }),
      JSON.stringify({ ...receipt(), recipients: [] }),
      JSON.stringify({ ...receipt(), nextSeq: 2 }),
      JSON.stringify({
        ...receipt(), recipients: { chat: { committedThrough: 1, committedBeyond: [3, 3] } },
      }),
      JSON.stringify({
        ...receipt(), entries: [{
          ...receipt().entries[0],
          signal: { id: 's', type: 'user_message', data: { updateId: 220001 } },
        }],
      }),
    ]) {
      const f = fixture();
      f.put(receiptPath, raw, 1000, 0o644);
      rejected(f);
    }
  });
  it('rejects unsafe modes, wrong UID/GID and symlinks', () => {
    for (const path of ['repo', 'data', 'loader', 'vault', 'loader/auth.json', receiptPath]) {
      for (const patch of [{ mode: 0o777 }, { uid: 42 }, { gid: 42 },
        { mode: 0o4644 }, { kind: 'symlink' as const }]) {
        const f = fixture();
        Object.assign(f.files.get(base + path)!, patch);
        rejected(f);
      }
    }
  });
  it('excludes only volatile timestamps and retains durable receipt fields', () => {
    const original = execute(fixture()).stdout;
    const f = fixture();
    f.put(receiptPath, { ...receipt(), savedAt: '2026-10-10T08:01:00.000Z' }, 1000, 0o644);
    expect(execute(f).stdout).toBe(original);
    f.put(receiptPath, { ...receipt(), recentKeys: ['different-key'] }, 1000, 0o644);
    expect(execute(f).stdout === original).toBe(false);
    const state = fixture();
    state.put('loader/state.json', {
      version: 1, builtCommit: head, updatedAt: '2026-10-10T08:01:00.000Z', extra: secret,
    }, 0, 0o600);
    expect(execute(state).stdout).toBe(original);
    state.put('loader/panic.json', { at: '2026-10-10T08:01:00.000Z', reason: secret, extra: secret }, 0, 0o600);
    expect(execute(state).stdout === original).toBe(false);
  });
});

const durableChanges: Array<[string, (r: ReturnType<typeof receipt>) => void]> = [
  ['seq', r => { r.entries[0].seq = 4; }],
  ['key', r => { r.entries[0].key = '220010'; }],
  ['recipient', r => { r.entries[0].recipientId = 'other'; }],
  ['routing', r => { r.entries[0].routing.destination = '4243'; }],
  ['signal identity', r => { r.entries[0].signal.id = 'signal-2'; }],
  ['encoded timestamp', r => { r.entries[0].signal.timestamp.__date = '2026-10-10T08:00:01.000Z'; }],
  ['metrics', r => { r.entries[0].signal.metrics.value = 0.5; }],
  ['data', r => { r.entries[0].signal.data.text = 'changed fixture text'; }],
  ['nextSeq', r => { r.nextSeq = 6; }],
  ['dedup', r => { r.recentKeys.push('new-key'); }],
  ['offset through', r => { r.recipients.chat.committedThrough = 2; }],
  ['offset holes', r => { r.recipients.chat.committedBeyond = [4]; }],
];
it.each(durableChanges)('fingerprints durable receipt %s', (_label, mutate) => {
  const original = execute(fixture()).stdout;
  const f = fixture(); const r = receipt(); mutate(r);
  f.put(receiptPath, r, 1000, 0o644);
  const result = execute(f);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toBe(original);
});
it.each(['repo/package.json', 'data/config/agent.json', 'loader/auth.json',
  'loader/cli-token', 'loader/vault-owner.json', 'loader/vault-proxy.json', 'vault-ca.pem'])
  ('fingerprints actual stable bytes %s', path => {
    const original = execute(fixture()).stdout;
    const f = fixture(); const item = f.files.get(base + path)!;
    item.bytes = Buffer.concat([item.bytes, Buffer.from('changed fixture bytes')]);
    const result = execute(f); expect(result.code).toBe(0);
    expect(result.stdout).not.toBe(original);
  });
it('validates state version and fingerprints a different built commit', () => {
  const original = execute(fixture()).stdout;
  const f = fixture();
  f.put('loader/state.json', { version: 1, builtCommit: 'b'.repeat(40),
    updatedAt: '2026-10-10T08:00:00.000Z', extra: secret }, 0, 0o600);
  expect(execute(f).stdout).not.toBe(original);
  f.put('loader/state.json', { version: 2, builtCommit: head }, 0, 0o600);
  rejected(f);
});
const arrayMutations: Array<[string, (r: any) => void]> = [
  ['entry', r => { r.entries = [[]]; }],
  ['signal', r => { r.entries[0].signal = []; }],
  ['data', r => { r.entries[0].signal.data = []; }],
  ['routing', r => { r.entries[0].routing = []; }],
  ['progress', r => { r.recipients.chat = []; }],
  ['entries', r => { r.entries = {}; }],
  ['dedup', r => { r.recentKeys = ['ok', 1]; }],
  ['offsets', r => { r.recipients.chat.committedBeyond = {}; }],
];
it.each(arrayMutations)('rejects malformed nested %s', (_label, mutate) => {
  const f = fixture(); const r = receipt(); mutate(r);
  f.put(receiptPath, r, 1000, 0o644); rejected(f);
});
