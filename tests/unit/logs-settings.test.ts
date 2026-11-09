/**
 * The retention setting's write path (ADR-016 §5, check L08): the durable
 * desired revision in `logs.json`, the store's ConfigMap, the annotation pair
 * on the store's Deployment, and `applied` only when the Deployment, the pod
 * and the store's own `/flags` all say the new values.
 *
 * The cluster and the filesystem are stubs: this file asserts the order of the
 * writes, what a crash between two of them leaves behind, and the predicate.
 */
import { describe, expect, it } from 'vitest';
import {
  createLogsSettings,
  evaluateApplied,
  type LogsSettingsDeps,
  type LogsSettingsDocument,
} from '../../loader/src/logs-settings.js';
import {
  LOGS_SETTINGS_REVISION_ANNOTATION,
  type LogsClusterAnswer,
  type LogsSettingsCluster,
  type LogsStoreDeployment,
} from '../../loader/src/logs-settings-cluster.js';
import {
  LOGS_RETENTION_DEFAULT_MAX_BYTES,
  desiredRevisionOf,
  marginBytesOf,
  retentionLimits,
  storeFlagsOf,
  type LogsStoreFlags,
  type ObservedRetentionFlags,
} from '../../loader/src/logs-retention.js';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const VOLUME = 3 * GIB;
const LIMITS = retentionLimits(VOLUME);
const SEVEN_DAYS = { days: 7, maxBytes: LOGS_RETENTION_DEFAULT_MAX_BYTES } as const;
const DEFAULTS: LogsStoreFlags = storeFlagsOf(
  { days: 14, maxBytes: LOGS_RETENTION_DEFAULT_MAX_BYTES },
  LIMITS
);

interface Sandbox {
  deps: LogsSettingsDeps;
  /** Every call in the order it happened, reads included. */
  steps: string[];
  /** The calls that changed something. */
  writes: string[];
  document(): LogsSettingsDocument | null;
  configMap(): { flags: LogsStoreFlags; revision: string } | null;
  setConfigMap(value: { flags: LogsStoreFlags; revision: string } | null): void;
  revision(): string | null;
  /** The pod template's revision annotation, as the Deployment now carries it. */
  setRevision(value: string | null): void;
  cluster: {
    generation: number;
    observedGeneration: number;
    replicas: number;
    updatedReplicas: number;
    availableReplicas: number;
    progressDeadlineExceeded: boolean;
    podRevision: string | null;
  };
  setFlags(value: Partial<ObservedRetentionFlags> | 'unavailable'): void;
  failWith(failure: 'forbidden' | 'unavailable' | null): void;
  failConfigMapWith(failure: 'forbidden' | 'unavailable' | null): void;
  setVolume(value: number | null): void;
}

/** A filesystem-and-cluster sandbox that logs every step and every write. */
function sandbox(options: { document?: LogsSettingsDocument | null } = {}): Sandbox {
  const steps: string[] = [];
  const writes: string[] = [];
  let document: LogsSettingsDocument | null = options.document ?? null;
  let configMap: { flags: LogsStoreFlags; revision: string } | null = null;
  let revision: string | null = null;
  let failure: 'forbidden' | 'unavailable' | null = null;
  let configMapFailure: 'forbidden' | 'unavailable' | null = null;
  let volume: number | null = VOLUME;
  let flags: Partial<ObservedRetentionFlags> | 'unavailable' = {
    days: 14,
    maxBytes: LOGS_RETENTION_DEFAULT_MAX_BYTES,
    minFreeBytes: marginBytesOf(VOLUME),
  };
  const clusterState = {
    generation: 1,
    observedGeneration: 1,
    replicas: 1,
    updatedReplicas: 1,
    availableReplicas: 1,
    progressDeadlineExceeded: false,
    podRevision: null as string | null,
  };
  const fail = <T>(reason: 'forbidden' | 'unavailable'): LogsClusterAnswer<T> =>
    reason === 'forbidden' ? { state: 'forbidden' } : { state: 'unavailable' };
  const cluster: LogsSettingsCluster = {
    volumeBytes: async () => {
      steps.push('volume');
      if (failure !== null) return fail(failure);
      return { state: 'ok', value: volume };
    },
    writeConfigMap: async (nextFlags, nextRevision) => {
      steps.push('configmap');
      if (configMapFailure !== null) return fail(configMapFailure);
      const unchanged =
        configMap !== null &&
        JSON.stringify(configMap.flags) === JSON.stringify(nextFlags) &&
        configMap.revision === nextRevision;
      configMap = { flags: nextFlags, revision: nextRevision };
      if (!unchanged) writes.push('configmap');
      return { state: 'ok', value: unchanged ? 'unchanged' : 'written' };
    },
    writeDeploymentRevision: async (nextRevision) => {
      steps.push('patch');
      if (failure !== null) return fail(failure);
      if (revision === nextRevision)
        return { state: 'ok', value: { state: 'unchanged', generation: clusterState.generation } };
      revision = nextRevision;
      clusterState.podRevision = null;
      clusterState.generation += 1;
      writes.push('patch');
      return { state: 'ok', value: { state: 'patched', generation: clusterState.generation } };
    },
    observeDeployment: async (): Promise<LogsClusterAnswer<LogsStoreDeployment>> => {
      steps.push('observe');
      if (failure !== null) return fail(failure);
      return {
        state: 'ok',
        value: {
          generation: clusterState.generation,
          observedGeneration: clusterState.observedGeneration,
          replicas: clusterState.replicas,
          updatedReplicas: clusterState.updatedReplicas,
          availableReplicas: clusterState.availableReplicas,
          templateRevision: revision,
          progressDeadlineExceeded: clusterState.progressDeadlineExceeded,
          podRevisions: [clusterState.podRevision],
        },
      };
    },
  };
  const write = (_path: string, contents: string): void => {
    writes.push('document');
    document = JSON.parse(contents) as LogsSettingsDocument;
  };
  const deps: LogsSettingsDeps = {
    path: '/var/lib/loader/logs.json',
    now: () => Date.parse('2026-11-09T05:00:00.000Z'),
    logger: { warn: () => {}, info: () => {} },
    cluster,
    flags: async () => {
      steps.push('flags');
      if (flags === 'unavailable') return { state: 'unavailable' };
      return {
        state: 'ok',
        observed: {
          days: flags.days ?? null,
          maxBytes: flags.maxBytes ?? null,
          minFreeBytes: flags.minFreeBytes ?? null,
        },
      };
    },
    fs: {
      exists: async () => document !== null,
      ensureDir: async () => {},
      readFile: async () => {
        steps.push('document');
        if (document === null) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return `${JSON.stringify(document, null, 2)}\n`;
      },
      writeFileAtomic: async (path, contents) => {
        write(path, contents);
      },
      writeFileExclusive: async (path, contents) => {
        write(path, contents);
      },
      chmod: async () => {},
      rename: async () => {},
    },
  };
  return {
    deps,
    steps,
    writes,
    cluster: clusterState,
    document: () => document,
    configMap: () => configMap,
    setConfigMap: (value) => {
      configMap = value;
    },
    revision: () => revision,
    setRevision: (value) => {
      revision = value;
    },
    setFlags: (value) => {
      flags = value;
    },
    failWith: (value) => {
      failure = value;
    },
    failConfigMapWith: (value) => {
      configMapFailure = value;
    },
    setVolume: (value) => {
      volume = value;
    },
  };
}

/** The document a completed one-change write leaves on disk. */
function documentOf(days: number, maxBytes: number, applied = false): LogsSettingsDocument {
  const revision = desiredRevisionOf(1, storeFlagsOf({ days, maxBytes }, LIMITS));
  return {
    version: 1,
    days,
    maxBytes,
    desiredRevision: revision,
    appliedRevision: applied ? revision : null,
    appliedAt: applied ? '2026-11-08T04:00:00.000Z' : null,
  };
}

/**
 * The replace finished: the controller caught up with the patched generation,
 * every replica is updated and available, and the pod answers the new flags
 * under the desired revision.
 */
function settled(box: Sandbox, retention: { days: number; maxBytes: number }): void {
  box.setFlags({
    days: retention.days,
    maxBytes: retention.maxBytes,
    minFreeBytes: marginBytesOf(VOLUME),
  });
  box.cluster.podRevision = box.revision();
  box.cluster.observedGeneration = box.cluster.generation;
  box.cluster.updatedReplicas = 1;
  box.cluster.availableReplicas = 1;
}

describe('a first install boots from the defaults ConfigMap', () => {
  it('reports the defaults applied and writes nothing at all', async () => {
    const box = sandbox();
    const settings = createLogsSettings(box.deps);
    const status = await settings.status();
    expect(status).toMatchObject({
      days: 14,
      maxBytes: LOGS_RETENTION_DEFAULT_MAX_BYTES,
      desiredRevision: null,
      appliedRevision: null,
      applied: true,
      pending: null,
      fitsVolume: true,
    });
    expect(status.limits).toEqual(LIMITS);
    expect(box.writes).toEqual([]);
    expect(box.document()).toBeNull();
    expect(box.configMap()).toBeNull();
    expect(box.revision()).toBeNull();
  });

  it('is pending, not applied, while the store answers other flags', async () => {
    const box = sandbox();
    box.setFlags({ days: 30 });
    const settings = createLogsSettings(box.deps);
    expect(await settings.status()).toMatchObject({ applied: false, pending: 'mismatch' });
  });
});

describe('a retention change reaches the store', () => {
  it('writes the document, then the ConfigMap, then the annotation, and says pending', async () => {
    const box = sandbox();
    const settings = createLogsSettings(box.deps);
    const result = await settings.write(SEVEN_DAYS);
    expect(result.state).toBe('ok');
    expect(box.writes).toEqual(['document', 'configmap', 'patch']);
    const document = box.document();
    expect(document?.days).toBe(7);
    expect(document?.appliedRevision).toBeNull();
    expect(document?.desiredRevision).toBe(box.revision());
    expect(box.configMap()).toEqual({
      flags: storeFlagsOf(SEVEN_DAYS, LIMITS),
      revision: document?.desiredRevision,
    });
    // The old process still answers the old flags: pending, and honest about it.
    const status = await settings.status();
    expect(status).toMatchObject({
      days: 7,
      applied: false,
      pending: 'mismatch',
      desiredRevision: document?.desiredRevision,
      appliedRevision: null,
    });
    // Once the replace pod answers the new flags and carries the revision:
    settled(box, SEVEN_DAYS);
    const applied = await settings.status();
    expect(applied).toMatchObject({
      applied: true,
      pending: null,
      appliedRevision: document?.desiredRevision,
      appliedAt: '2026-11-09T05:00:00.000Z',
    });
    // The applied revision is durable, so a restart reads it back.
    expect(box.document()?.appliedRevision).toBe(document?.desiredRevision);
    expect(box.writes).toEqual(['document', 'configmap', 'patch', 'document']);
  });

  it('reads the status without writing once the change is proved', async () => {
    const box = sandbox();
    const settings = createLogsSettings(box.deps);
    await settings.write(SEVEN_DAYS);
    settled(box, SEVEN_DAYS);
    await settings.status();
    box.steps.length = 0;
    box.writes.length = 0;
    const status = await settings.status();
    expect(status.applied).toBe(true);
    expect(box.steps.slice(0, 4)).toEqual(['document', 'volume', 'flags', 'observe']);
    expect(box.writes).toEqual([]);
  });

  it('converges on an identical repeated PUT instead of restarting the store', async () => {
    const box = sandbox();
    const settings = createLogsSettings(box.deps);
    await settings.write(SEVEN_DAYS);
    settled(box, SEVEN_DAYS);
    await settings.status();
    const revision = box.revision();
    const writes = [...box.writes];
    const again = await settings.write(SEVEN_DAYS);
    expect(again.state).toBe('ok');
    expect(box.revision()).toBe(revision);
    // The ConfigMap and the annotation are checked, not rewritten.
    expect(box.writes.slice(writes.length)).toEqual([]);
    if (again.state !== 'ok') throw new Error('unreachable');
    expect(again.status.applied).toBe(true);
    expect(box.document()?.desiredRevision).toBe(revision);
  });

  it('applies a change back to 14 days with a new revision', async () => {
    const box = sandbox({ document: documentOf(7, LOGS_RETENTION_DEFAULT_MAX_BYTES, true) });
    box.setRevision(box.document()?.desiredRevision ?? null);
    settled(box, SEVEN_DAYS);
    const settings = createLogsSettings(box.deps);
    expect((await settings.status()).applied).toBe(true);
    const previous = box.document()?.desiredRevision;
    const result = await settings.write({
      days: 14,
      maxBytes: LOGS_RETENTION_DEFAULT_MAX_BYTES,
    });
    if (result.state !== 'ok') throw new Error('write failed');
    expect(box.document()?.desiredRevision).not.toBe(previous);
    expect(box.document()?.desiredRevision).toMatch(/^2-/);
    expect(result.status.applied).toBe(false);
    expect(result.status.pending).toBe('mismatch');
    settled(box, { days: 14, maxBytes: LOGS_RETENTION_DEFAULT_MAX_BYTES });
    await settings.status();
    expect(box.document()?.appliedRevision).toBe(box.document()?.desiredRevision);
    expect(box.document()?.appliedAt).toBe('2026-11-09T05:00:00.000Z');
  });
});

describe('a crash between the two writes converges (L08)', () => {
  it('re-bumps the annotation when the ConfigMap was written and the pod was not replaced', async () => {
    const box = sandbox({ document: documentOf(7, LOGS_RETENTION_DEFAULT_MAX_BYTES) });
    const document = box.document();
    if (document === null) throw new Error('fixture lost its document');
    // The crash left the ConfigMap behind, with the document's revision ...
    box.setConfigMap({ flags: storeFlagsOf(SEVEN_DAYS, LIMITS), revision: document.desiredRevision });
    // ... and the old pod still answering the old flags.
    box.setFlags({ days: 14 });
    const settings = createLogsSettings(box.deps);
    expect(await settings.status()).toMatchObject({ applied: false, pending: 'mismatch' });
    await settings.reconcile();
    // The ConfigMap already matched; only the annotation was missing.
    expect(box.revision()).toBe(document.desiredRevision);
    expect(box.writes).toEqual(['patch']);
    settled(box, SEVEN_DAYS);
    await settings.reconcile();
    expect(box.document()?.appliedRevision).toBe(document.desiredRevision);
    expect(box.writes).toEqual(['patch', 'document']);
  });

  it('marks applied from the same conditions when the annotation was already patched', async () => {
    // The loader died after the patch and before it observed the result.
    const box = sandbox({ document: documentOf(7, LOGS_RETENTION_DEFAULT_MAX_BYTES) });
    const document = box.document();
    if (document === null) throw new Error('fixture lost its document');
    box.setRevision(document.desiredRevision);
    settled(box, SEVEN_DAYS);
    const settings = createLogsSettings(box.deps);
    await settings.reconcile();
    // Neither the ConfigMap nor the annotation had to be written again.
    expect(box.writes).toEqual(['configmap', 'document']);
    expect(box.document()?.appliedRevision).toBe(document.desiredRevision);
    expect((await settings.status()).applied).toBe(true);
  });
});

describe('the bound the volume can never reach', () => {
  it('refuses it with both numbers and writes nothing', async () => {
    const box = sandbox();
    const settings = createLogsSettings(box.deps);
    const result = await settings.write({ days: 7, maxBytes: LIMITS.largestMaxBytes + MIB });
    expect(result).toEqual({
      state: 'above_volume',
      maxBytes: LIMITS.largestMaxBytes + MIB,
      largestMaxBytes: LIMITS.largestMaxBytes,
      volumeBytes: VOLUME,
      evictorThresholdBytes: LIMITS.evictorThresholdBytes,
    });
    expect(box.writes).toEqual([]);
    expect(box.document()).toBeNull();
  });

  it('accepts one at the largest bound that fits and one 1 MiB below it', async () => {
    for (const maxBytes of [LIMITS.largestMaxBytes, LIMITS.largestMaxBytes - MIB]) {
      const box = sandbox();
      const settings = createLogsSettings(box.deps);
      expect((await settings.write({ days: 7, maxBytes })).state).toBe('ok');
      expect(box.document()?.maxBytes).toBe(maxBytes);
    }
  });

  it('refuses a write while the volume size is unknown', async () => {
    const box = sandbox();
    box.setVolume(null);
    const settings = createLogsSettings(box.deps);
    expect(await settings.write({ days: 7, maxBytes: MIB })).toEqual({ state: 'volume_unknown' });
    expect(box.writes).toEqual([]);
    const status = await settings.status();
    expect(status.limits).toBeNull();
    expect(status.fitsVolume).toBeNull();
    expect(box.writes).toEqual([]);
  });
});

describe('the applied predicate', () => {
  const expected = {
    days: 7,
    maxBytes: LOGS_RETENTION_DEFAULT_MAX_BYTES,
    minFreeBytes: marginBytesOf(VOLUME),
  };
  const observation = (over: Partial<LogsStoreDeployment> = {}): LogsStoreDeployment => ({
    generation: 3,
    observedGeneration: 3,
    replicas: 1,
    updatedReplicas: 1,
    availableReplicas: 1,
    templateRevision: '2-abc',
    progressDeadlineExceeded: false,
    podRevisions: ['2-abc'],
    ...over,
  });
  const agreed: ObservedRetentionFlags = expected;
  const applied = (
    over: Partial<LogsStoreDeployment> = {},
    flags: ObservedRetentionFlags = agreed
  ) =>
    evaluateApplied({
      desiredRevision: '2-abc',
      observation: observation(over),
      flags: { state: 'ok', observed: flags },
      expected,
    });

  it('holds only when all four conditions agree', () => {
    expect(applied()).toEqual({ state: 'applied' });
    expect(applied({ observedGeneration: 2 })).toEqual({ state: 'pending', reason: 'mismatch' });
    expect(applied({ updatedReplicas: 0 })).toEqual({ state: 'pending', reason: 'mismatch' });
    expect(applied({ availableReplicas: 0 })).toEqual({ state: 'pending', reason: 'mismatch' });
    expect(applied({ podRevisions: ['1-old'] })).toEqual({ state: 'pending', reason: 'mismatch' });
    expect(applied({ podRevisions: [] })).toEqual({
      state: 'pending',
      reason: 'store_unavailable',
    });
    expect(applied({}, { ...agreed, days: 14 })).toEqual({ state: 'pending', reason: 'mismatch' });
    expect(applied({}, { ...agreed, maxBytes: agreed.maxBytes - 1 })).toEqual({
      state: 'pending',
      reason: 'mismatch',
    });
    expect(applied({}, { ...agreed, minFreeBytes: agreed.minFreeBytes - 1 })).toEqual({
      state: 'pending',
      reason: 'mismatch',
    });
    expect(
      evaluateApplied({
        desiredRevision: '2-abc',
        observation: observation(),
        flags: { state: 'unavailable' },
        expected,
      })
    ).toEqual({ state: 'pending', reason: 'store_unavailable' });
    expect(applied({ progressDeadlineExceeded: true })).toEqual({
      state: 'pending',
      reason: 'rollout_timeout',
    });
  });

  it('passes on a first install, when there is no revision to match', () => {
    const defaults = {
      days: 14,
      maxBytes: LOGS_RETENTION_DEFAULT_MAX_BYTES,
      minFreeBytes: marginBytesOf(VOLUME),
    };
    expect(
      evaluateApplied({
        desiredRevision: null,
        observation: observation({ templateRevision: null, podRevisions: [] }),
        flags: { state: 'ok', observed: defaults },
        expected: defaults,
      })
    ).toEqual({ state: 'applied' });
  });
});

describe('the reasons a change is still pending', () => {
  it('reports a refused read as forbidden and an unanswered one as store_unavailable', async () => {
    const box = sandbox({ document: documentOf(7, LOGS_RETENTION_DEFAULT_MAX_BYTES) });
    box.setRevision(box.document()?.desiredRevision ?? null);
    settled(box, SEVEN_DAYS);
    const settings = createLogsSettings(box.deps);
    box.failWith('forbidden');
    expect(await settings.status()).toMatchObject({ applied: false, pending: 'forbidden' });
    box.failWith('unavailable');
    expect(await settings.status()).toMatchObject({ applied: false, pending: 'store_unavailable' });
    box.failWith(null);
    box.setFlags('unavailable');
    expect(await settings.status()).toMatchObject({ applied: false, pending: 'store_unavailable' });
    expect(LOGS_SETTINGS_REVISION_ANNOTATION).toBe('lifemodel.dev/logs-settings-revision');
  });

  it('reports a refused ConfigMap write without losing the durable revision', async () => {
    const box = sandbox();
    box.failConfigMapWith('forbidden');
    const settings = createLogsSettings(box.deps);
    const result = await settings.write(SEVEN_DAYS);
    expect(result).toEqual({ state: 'forbidden' });
    expect(box.document()?.days).toBe(7);
    expect(box.revision()).toBeNull();
  });
});
