/** Pure module. Importing it performs no native I/O. */
export interface StableMetadata {
  uid: number;
  gid: number;
  mode: number;
}
export interface StableFileFingerprint extends StableMetadata {
  sha256: string;
}
export interface StableInstanceFingerprint {
  repoHead: string;
  repoDirectory: StableMetadata;
  dataDirectory: StableMetadata;
  loaderDirectory: StableMetadata;
  vaultDirectory: StableMetadata;
  trackedPackageJson: StableFileFingerprint;
  agentConfig: StableFileFingerprint;
  loaderAuth: StableFileFingerprint;
  cliToken: StableFileFingerprint;
  vaultOwner: StableFileFingerprint;
  vaultProxy: StableFileFingerprint;
  vaultCa: StableFileFingerprint;
  loaderBuiltCommit: string;
  loaderState: { version: 1; file: StableFileFingerprint };
  panic: { present: boolean; file: StableFileFingerprint | null };
  inboundReceipt: {
    present: boolean;
    file: StableFileFingerprint | null;
    entryCount: number;
  };
}

/** Reject unsafe permissions and unexpected public fields. */
export class InstanceStableSnapshot {
  stableFingerprint(raw: string): StableInstanceFingerprint {
    if (Buffer.byteLength(raw) > 16 * 1024) {
      throw new Error('Stable snapshot exceeded its bound');
    }
    try {
      const object = (v: unknown): v is Record<string, unknown> =>
        v !== null && typeof v === 'object' && !Array.isArray(v);
      const keys = (v: unknown, names: string[]): v is Record<string, unknown> =>
        object(v) &&
        Object.keys(v).sort().join(',') === [...names].sort().join(',');
      const hex = (v: unknown, length: number): boolean =>
        typeof v === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(v);
      const meta = (
        v: unknown, uid: number, mode: number, hash = false,
      ): boolean =>
        keys(v, hash ? ['uid', 'gid', 'mode', 'sha256'] : ['uid', 'gid', 'mode']) &&
        v.uid === uid && v.gid === uid && v.mode === mode &&
        (!hash || hex(v.sha256, 64));
      const optional = (v: unknown, uid: number, mode: number): boolean =>
        keys(v, ['present', 'file']) && typeof v.present === 'boolean' &&
        (v.present ? meta(v.file, uid, mode, true) : v.file === null);
      const v: unknown = JSON.parse(raw);
      if (!keys(v, [
        'repoHead', 'repoDirectory', 'dataDirectory', 'loaderDirectory',
        'vaultDirectory', 'trackedPackageJson', 'agentConfig', 'loaderAuth',
        'cliToken', 'vaultOwner', 'vaultProxy', 'vaultCa', 'loaderBuiltCommit',
        'loaderState', 'panic', 'inboundReceipt',
      ]) ||
          !hex(v.repoHead, 40) || !hex(v.loaderBuiltCommit, 40) ||
          !meta(v.repoDirectory, 1000, 0o755) ||
          !meta(v.dataDirectory, 1000, 0o755) ||
          !meta(v.loaderDirectory, 0, 0o700) ||
          !meta(v.vaultDirectory, 0, 0o700) ||
          !meta(v.trackedPackageJson, 1000, 0o644, true) ||
          !meta(v.agentConfig, 1000, 0o644, true) ||
          !meta(v.loaderAuth, 0, 0o600, true) ||
          !meta(v.cliToken, 0, 0o600, true) ||
          !meta(v.vaultOwner, 0, 0o600, true) ||
          !meta(v.vaultProxy, 0, 0o600, true) ||
          !meta(v.vaultCa, 0, 0o644, true) ||
          !keys(v.loaderState, ['version', 'file']) ||
          v.loaderState.version !== 1 ||
          !meta(v.loaderState.file, 0, 0o600, true) ||
          !optional(v.panic, 0, 0o600) ||
          !keys(v.inboundReceipt, ['present', 'file', 'entryCount']) ||
          typeof v.inboundReceipt.present !== 'boolean' ||
          typeof v.inboundReceipt.entryCount !== 'number' ||
          !Number.isSafeInteger(v.inboundReceipt.entryCount) ||
          v.inboundReceipt.entryCount < 0 ||
          !(v.inboundReceipt.present
            ? meta(v.inboundReceipt.file, 1000, 0o644, true)
            : v.inboundReceipt.file === null && v.inboundReceipt.entryCount === 0)) {
        throw new Error();
      }
      return v as unknown as StableInstanceFingerprint;
    } catch {
      throw new Error('Stable snapshot has an invalid public fingerprint');
    }
  }
}

/**
 * Literal standalone CommonJS script for node -e SCRIPT HEAD.
 * Only hashes and public metadata leave the OCI.
 * Receipt excludes savedAt only; state excludes updatedAt only.
 * Panic includes at/reason and every extra durable field.
 */
export const STABLE_SNAPSHOT_SCRIPT = String.raw`
'use strict';
const { readFileSync, lstatSync } = require('node:fs');
const { createHash } = require('node:crypto');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const seq = (v, min) => Number.isSafeInteger(v) && v >= min;
const encodedJson = (v, depth = 0) => {
  if (depth > 100) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(x => encodedJson(x, depth + 1));
  return object(v) && Object.values(v).every(x => encodedJson(x, depth + 1));
};
const parseReceipt = raw => {
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error();
  const v = JSON.parse(raw);
  if (!object(v) || !encodedJson(v) || v.version !== 2 ||
      typeof v.savedAt !== 'string' || !seq(v.nextSeq, 1) ||
      !Array.isArray(v.recentKeys) ||
      !v.recentKeys.every(k => typeof k === 'string') ||
      !object(v.recipients) || !Array.isArray(v.entries)) throw new Error();
  for (const p of Object.values(v.recipients)) {
    if (!object(p) || !seq(p.committedThrough, 0) ||
        p.committedThrough >= v.nextSeq || !Array.isArray(p.committedBeyond) ||
        !p.committedBeyond.every(n =>
          seq(n, 1) && n > p.committedThrough && n < v.nextSeq) ||
        new Set(p.committedBeyond).size !== p.committedBeyond.length) {
      throw new Error();
    }
  }
  const seenSeq = new Set();
  const seenKeys = new Set();
  for (const e of v.entries) {
    if (!object(e) || !seq(e.seq, 1) || e.seq >= v.nextSeq ||
        typeof e.key !== 'string' || typeof e.recipientId !== 'string' ||
        !object(e.signal) || typeof e.signal.id !== 'string' ||
        typeof e.signal.type !== 'string' || !object(e.signal.data) ||
        !(e.routing === null || (object(e.routing) &&
          typeof e.routing.channel === 'string' &&
          typeof e.routing.destination === 'string'))) throw new Error();
    for (const name of ['updateId', 'recipientId', 'channel', 'text']) {
      if (Object.prototype.hasOwnProperty.call(e.signal.data, name) &&
          typeof e.signal.data[name] !== 'string') throw new Error();
    }
    if (seenSeq.has(e.seq) || seenKeys.has(e.key)) throw new Error();
    seenSeq.add(e.seq);
    seenKeys.add(e.key);
  }
  return v;
};
const sha = v => createHash('sha256').update(v).digest('hex');
const canonical = (v, depth = 0) => {
  if (depth > 100) throw new Error();
  if (v === null || typeof v === 'string' || typeof v === 'boolean' ||
      (typeof v === 'number' && Number.isFinite(v))) return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '[' + v.map(x => canonical(x, depth + 1)).join(',') + ']';
  }
  if (!object(v)) throw new Error();
  return '{' + Object.keys(v).sort().map(k =>
    JSON.stringify(k) + ':' + canonical(v[k], depth + 1)).join(',') + '}';
};
const metadata = (path, uid, mode, directory = false) => {
  const s = lstatSync(path);
  if (!(directory ? s.isDirectory() : s.isFile()) ||
      s.uid !== uid || s.gid !== uid || (s.mode & 0o7777) !== mode ||
      (!directory && (!Number.isSafeInteger(s.size) || s.size < 0 ||
        s.size > 4 * 1024 * 1024))) throw new Error();
  return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 };
};
const load = (path, uid, mode) => {
  const info = metadata(path, uid, mode);
  const bytes = readFileSync(path);
  if (bytes.length > 4 * 1024 * 1024) throw new Error();
  return { info, bytes };
};
const optional = (path, uid, mode) => {
  try { lstatSync(path); }
  catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new Error();
  }
  return load(path, uid, mode);
};
const fingerprint = r => ({ ...r.info, sha256: sha(r.bytes) });
const durable = (r, v, excluded = []) => {
  if (!object(v)) throw new Error();
  const content = Object.fromEntries(
    Object.entries(v).filter(([k]) => !excluded.includes(k)));
  return { ...r.info, sha256: sha(canonical(content)) };
};
const json = r => JSON.parse(r.bytes.toString('utf8'));
try {
  const head = process.argv[1];
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) throw new Error();
  const repoDirectory = metadata('/var/lib/lifemodel/repo', 1000, 0o755, true);
  const dataDirectory = metadata('/var/lib/lifemodel/data', 1000, 0o755, true);
  const loaderDirectory = metadata('/var/lib/lifemodel/loader', 0, 0o700, true);
  const vaultDirectory = metadata('/var/lib/lifemodel/vault', 0, 0o700, true);
  const stateRecord = load('/var/lib/lifemodel/loader/state.json', 0, 0o600);
  const state = json(stateRecord);
  if (!object(state) || state.version !== 1 ||
      typeof state.builtCommit !== 'string' ||
      !/^[0-9a-f]{40}$/.test(state.builtCommit) ||
      typeof state.updatedAt !== 'string') throw new Error();
  const token = load('/var/lib/lifemodel/loader/cli-token', 0, 0o600);
  if (token.bytes.toString('utf8').trim() === '') throw new Error();
  const panicRecord = optional('/var/lib/lifemodel/loader/panic.json', 0, 0o600);
  let panicFile = null;
  if (panicRecord !== null) {
    const panic = json(panicRecord);
    if (!object(panic) || typeof panic.at !== 'string' || panic.at === '' ||
        typeof panic.reason !== 'string') throw new Error();
    panicFile = durable(panicRecord, panic);
  }
  const receiptRecord = optional(
    '/var/lib/lifemodel/data/state/core/inbound_log.json', 1000, 0o644);
  let receiptFile = null;
  let entryCount = 0;
  if (receiptRecord !== null) {
    const receipt = parseReceipt(receiptRecord.bytes.toString('utf8'));
    entryCount = receipt.entries.length;
    receiptFile = durable(receiptRecord, receipt, ['savedAt']);
  }
  const result = {
    repoHead: head, repoDirectory, dataDirectory, loaderDirectory, vaultDirectory,
    trackedPackageJson: fingerprint(
      load('/var/lib/lifemodel/repo/package.json', 1000, 0o644)),
    agentConfig: fingerprint(
      load('/var/lib/lifemodel/data/config/agent.json', 1000, 0o644)),
    loaderAuth: fingerprint(
      load('/var/lib/lifemodel/loader/auth.json', 0, 0o600)),
    cliToken: fingerprint(token),
    vaultOwner: fingerprint(
      load('/var/lib/lifemodel/loader/vault-owner.json', 0, 0o600)),
    vaultProxy: fingerprint(
      load('/var/lib/lifemodel/loader/vault-proxy.json', 0, 0o600)),
    vaultCa: fingerprint(load('/var/lib/lifemodel/vault-ca.pem', 0, 0o644)),
    loaderBuiltCommit: state.builtCommit,
    loaderState: { version: state.version,
      file: durable(stateRecord, state, ['updatedAt']) },
    panic: { present: panicRecord !== null, file: panicFile },
    inboundReceipt: { present: receiptRecord !== null, file: receiptFile,
      entryCount },
  };
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > 16 * 1024) throw new Error();
  process.stdout.write(output);
} catch {
  process.stderr.write('Stable OCI snapshot failed');
  process.exitCode = 1;
}
`;
