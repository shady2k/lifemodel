/**
 * The owner's retention setting, its durable desired revision and the answer
 * the page reads (ADR-016 §5, check L08).
 *
 * A change is written in three steps, in this order: `logs.json` with the new
 * `desiredRevision` (a counter plus a hash of the effective flags), then the
 * store's ConfigMap, then the revision annotation on the store's Deployment,
 * whose `Recreate` strategy replaces the store's single pod. A crash between
 * two of them loses nothing: `reconcile()` reads `logs.json` again, writes the
 * ConfigMap only when it differs, bumps the annotation only when it differs,
 * and every read of the status proves the result from the same conditions.
 *
 * `applied` is not a stored wish: it holds only while the Deployment's
 * `observedGeneration` has caught up with the patched generation, every replica
 * is updated and available, a pod carries the desired revision, and the
 * store's own `/flags` answer the desired values. Until then the status carries
 * one reason (`store_unavailable`, `rollout_timeout`, `forbidden`, `mismatch`).
 */
import type { FileSystem } from './fs.js';
import type { LoaderLogger } from './logger.js';
import type { LogsSettingsCluster, LogsStoreDeployment } from './logs-settings-cluster.js';
import {
  LOGS_RETENTION_DEFAULT_DAYS,
  LOGS_RETENTION_DEFAULT_MAX_BYTES,
  checkRetention,
  counterOf,
  desiredRevisionOf,
  flagValuesOf,
  flagsAgree,
  retentionLimits,
  storeFlagsOf,
  type LogsRetention,
  type LogsRetentionFlagsRead,
  type LogsRetentionLimits,
  type RetentionFlagValues,
} from './logs-retention.js';

export const LOGS_SETTINGS_DOCUMENT_VERSION = 1;
const DOCUMENT_MODE = 0o600;

/** The durable document at `/var/lib/loader/logs.json`. */
export interface LogsSettingsDocument {
  readonly version: 1;
  readonly days: number;
  readonly maxBytes: number;
  /** The counter plus the flags' hash this loader wants the store to run. */
  readonly desiredRevision: string;
  /** The revision the store was last proved to run, and when. */
  readonly appliedRevision: string | null;
  readonly appliedAt: string | null;
}

/** Why a change the owner made is not proved on the store yet. */
export type LogsSettingsPendingReason =
  | 'store_unavailable'
  | 'rollout_timeout'
  | 'forbidden'
  | 'mismatch';

export interface LogsSettingsStatus {
  readonly days: number;
  readonly maxBytes: number;
  readonly desiredRevision: string | null;
  readonly appliedRevision: string | null;
  readonly appliedAt: string | null;
  readonly applied: boolean;
  readonly pending: LogsSettingsPendingReason | null;
  readonly limits: LogsRetentionLimits | null;
  /** `maxBytes` above what this volume can ever reach (ADR-016 §5 alarm). */
  readonly fitsVolume: boolean | null;
}

export type LogsSettingsWriteResult =
  | { readonly state: 'ok'; readonly status: LogsSettingsStatus }
  | { readonly state: 'invalid'; readonly field: 'body' | 'days' | 'maxBytes' }
  | {
      readonly state: 'above_volume';
      readonly maxBytes: number;
      readonly largestMaxBytes: number;
      readonly volumeBytes: number;
      readonly evictorThresholdBytes: number;
    }
  | { readonly state: 'volume_unknown' }
  | { readonly state: 'forbidden' }
  | { readonly state: 'unavailable' };

export interface LogsSettingsDeps {
  readonly fs: FileSystem;
  /** `/var/lib/loader/logs.json`. */
  readonly path: string;
  readonly logger: Pick<LoaderLogger, 'info' | 'warn'>;
  readonly now: () => number;
  readonly cluster: LogsSettingsCluster;
  readonly flags: () => Promise<LogsRetentionFlagsRead>;
}

export interface LogsSettings {
  status(): Promise<LogsSettingsStatus>;
  write(input: unknown): Promise<LogsSettingsWriteResult>;
  reconcile(): Promise<void>;
}

type AppliedEvaluation =
  | { readonly state: 'applied' }
  | { readonly state: 'pending'; readonly reason: LogsSettingsPendingReason };

/**
 * The applied predicate (ADR-016 §5): four independent conditions, and the
 * first one that does not hold names the reason. A rollout the Deployment
 * itself gave up is `rollout_timeout`; a store that does not answer is
 * `store_unavailable`; anything readable that disagrees is `mismatch`.
 */
export function evaluateApplied(args: {
  readonly desiredRevision: string | null;
  readonly observation: LogsStoreDeployment;
  readonly flags: LogsRetentionFlagsRead;
  readonly expected: RetentionFlagValues;
}): AppliedEvaluation {
  const { desiredRevision, observation, flags, expected } = args;
  if (observation.progressDeadlineExceeded) return { state: 'pending', reason: 'rollout_timeout' };
  if (observation.observedGeneration !== observation.generation)
    return { state: 'pending', reason: 'mismatch' };
  if (
    observation.updatedReplicas < observation.replicas ||
    observation.availableReplicas < observation.replicas
  )
    return { state: 'pending', reason: 'mismatch' };
  if (desiredRevision !== null) {
    if (observation.podRevisions.length === 0)
      return { state: 'pending', reason: 'store_unavailable' };
    if (!observation.podRevisions.includes(desiredRevision))
      return { state: 'pending', reason: 'mismatch' };
  }
  if (flags.state !== 'ok') return { state: 'pending', reason: 'store_unavailable' };
  if (!flagsAgree(flags.observed, expected)) return { state: 'pending', reason: 'mismatch' };
  return { state: 'applied' };
}

function documentOf(value: unknown): LogsSettingsDocument | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const { version, days, maxBytes, desiredRevision, appliedRevision, appliedAt } = body;
  if (version !== LOGS_SETTINGS_DOCUMENT_VERSION) return null;
  if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1) return null;
  if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;
  if (typeof desiredRevision !== 'string' || counterOf(desiredRevision) === 0) return null;
  if (appliedRevision !== null && typeof appliedRevision !== 'string') return null;
  if (appliedAt !== null && typeof appliedAt !== 'string') return null;
  return {
    version: LOGS_SETTINGS_DOCUMENT_VERSION,
    days,
    maxBytes,
    desiredRevision,
    appliedRevision: typeof appliedRevision === 'string' ? appliedRevision : null,
    appliedAt: typeof appliedAt === 'string' ? appliedAt : null,
  };
}

export function createLogsSettings(deps: LogsSettingsDeps): LogsSettings {
  // One write at a time: a status read that records `applied` must never
  // overwrite a newer document, and two writes must not interleave their steps.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function readDocument(): Promise<LogsSettingsDocument | null> {
    try {
      if (!(await deps.fs.exists(deps.path))) return null;
      const document = documentOf(JSON.parse(await deps.fs.readFile(deps.path)) as unknown);
      if (document === null)
        deps.logger.warn(
          { code: 'invalid_document' },
          'logs settings document is not one this loader wrote'
        );
      return document;
    } catch (error) {
      deps.logger.warn(
        { code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' },
        'logs settings document is unreadable; the defaults apply'
      );
      return null;
    }
  }

  function writeDocument(document: LogsSettingsDocument): Promise<void> {
    return deps.fs.writeFileAtomic(
      deps.path,
      `${JSON.stringify(document, null, 2)}\n`,
      DOCUMENT_MODE
    );
  }

  /**
   * Records the revision the store was just proved to run, once, and answers
   * the time it holds. A document that changed meanwhile is left alone: the
   * newer change has its own proof to wait for.
   */
  async function recordApplied(desiredRevision: string): Promise<string | null> {
    return serial(async () => {
      const current = await readDocument();
      if (current?.desiredRevision !== desiredRevision) return null;
      if (current.appliedRevision === desiredRevision) return current.appliedAt;
      const appliedAt = new Date(deps.now()).toISOString();
      await writeDocument({ ...current, appliedRevision: desiredRevision, appliedAt });
      return appliedAt;
    });
  }

  async function limitsNow(): Promise<
    { state: 'ok'; limits: LogsRetentionLimits | null } | { state: 'forbidden' | 'unavailable' }
  > {
    const volume = await deps.cluster.volumeBytes();
    if (volume.state !== 'ok') return { state: volume.state };
    return { state: 'ok', limits: volume.value === null ? null : retentionLimits(volume.value) };
  }

  async function status(): Promise<LogsSettingsStatus> {
    const document = await readDocument();
    const retention: LogsRetention =
      document === null
        ? { days: LOGS_RETENTION_DEFAULT_DAYS, maxBytes: LOGS_RETENTION_DEFAULT_MAX_BYTES }
        : { days: document.days, maxBytes: document.maxBytes };
    const limits = await limitsNow();
    const flags = await deps.flags();
    const observation = await deps.cluster.observeDeployment();
    const base = {
      days: retention.days,
      maxBytes: retention.maxBytes,
      desiredRevision: document?.desiredRevision ?? null,
      appliedRevision: document?.appliedRevision ?? null,
      appliedAt: document?.appliedAt ?? null,
      limits: limits.state === 'ok' ? limits.limits : null,
      fitsVolume:
        limits.state === 'ok' && limits.limits !== null
          ? retention.maxBytes <= limits.limits.largestMaxBytes
          : null,
    };
    const pendingReason = (): LogsSettingsPendingReason | null => {
      if (observation.state === 'ok' && limits.state === 'ok' && limits.limits !== null) {
        const evaluated = evaluateApplied({
          desiredRevision: base.desiredRevision,
          observation: observation.value,
          flags,
          expected: flagValuesOf(retention, limits.limits),
        });
        return evaluated.state === 'applied' ? null : evaluated.reason;
      }
      // A refused read names its own reason; anything unreadable - the claim's
      // capacity included, since the margin is a share of it - leaves the
      // store's state unknown rather than guessed.
      if (limits.state === 'forbidden' || observation.state === 'forbidden') return 'forbidden';
      return 'store_unavailable';
    };
    const pending = pendingReason();
    if (pending !== null || document === null)
      return { ...base, applied: pending === null, pending };
    const appliedAt = await recordApplied(document.desiredRevision);
    return {
      ...base,
      appliedRevision: document.desiredRevision,
      appliedAt: appliedAt ?? base.appliedAt,
      applied: true,
      pending: null,
    };
  }

  /**
   * One validated change: document, ConfigMap, annotation, in that order. It
   * answers only whether the writes happened; the status is read afterwards,
   * outside the write queue, because reading it may record `applied` itself.
   */
  async function applyWrite(input: unknown): Promise<
    | { readonly state: 'written' }
    | { readonly state: 'invalid'; readonly field: 'body' | 'days' | 'maxBytes' }
    | {
        readonly state: 'above_volume';
        readonly maxBytes: number;
        readonly largestMaxBytes: number;
        readonly volumeBytes: number;
        readonly evictorThresholdBytes: number;
      }
    | { readonly state: 'volume_unknown' }
    | { readonly state: 'forbidden' }
    | { readonly state: 'unavailable' }
  > {
    const document = await readDocument();
    const limits = await limitsNow();
    if (limits.state !== 'ok') return { state: limits.state };
    if (limits.limits === null) return { state: 'volume_unknown' };
    const checked = checkRetention(input, limits.limits);
    if (checked.state !== 'ok') return checked;
    const flags = storeFlagsOf(checked.value, limits.limits);
    const current =
      document === null
        ? null
        : storeFlagsOf({ days: document.days, maxBytes: document.maxBytes }, limits.limits);
    // The same effective flags keep the same revision: a remembered restart is
    // not a change, and an identical repeated PUT rewrites nothing.
    const next: LogsSettingsDocument =
      document !== null && JSON.stringify(current) === JSON.stringify(flags)
        ? document
        : {
            version: LOGS_SETTINGS_DOCUMENT_VERSION,
            days: checked.value.days,
            maxBytes: checked.value.maxBytes,
            desiredRevision: desiredRevisionOf(
              document === null ? 1 : counterOf(document.desiredRevision) + 1,
              flags
            ),
            appliedRevision: document?.appliedRevision ?? null,
            appliedAt: document?.appliedAt ?? null,
          };
    if (next !== document) await writeDocument(next);
    const written = await deps.cluster.writeConfigMap(flags, next.desiredRevision);
    if (written.state !== 'ok') return { state: written.state };
    const patched = await deps.cluster.writeDeploymentRevision(next.desiredRevision);
    if (patched.state !== 'ok') return { state: patched.state };
    return { state: 'written' };
  }

  async function reconcileWrites(): Promise<void> {
    const document = await readDocument();
    // Nothing was ever asked for: the defaults ConfigMap is what the store runs.
    if (document === null) return;
    const limits = await limitsNow();
    if (limits.state !== 'ok' || limits.limits === null) {
      deps.logger.warn(
        { code: limits.state === 'ok' ? 'volume_unknown' : limits.state },
        'the log store settings cannot be reconciled yet'
      );
      return;
    }
    const flags = storeFlagsOf({ days: document.days, maxBytes: document.maxBytes }, limits.limits);
    const written = await deps.cluster.writeConfigMap(flags, document.desiredRevision);
    if (written.state !== 'ok') {
      deps.logger.warn({ code: written.state }, 'the log store settings ConfigMap was not written');
      return;
    }
    const patched = await deps.cluster.writeDeploymentRevision(document.desiredRevision);
    if (patched.state !== 'ok') {
      deps.logger.warn(
        { code: patched.state },
        'the log store revision was not applied to its Deployment'
      );
      return;
    }
    if (patched.value.state === 'patched')
      deps.logger.info(
        { revision: document.desiredRevision, generation: patched.value.generation },
        'the log store will replace its pod for the new retention settings'
      );
  }

  return {
    status,
    async write(input) {
      const result = await serial(() => applyWrite(input));
      if (result.state !== 'written') return result;
      return { state: 'ok', status: await status() };
    },
    reconcile: async () => {
      await serial(reconcileWrites);
      // The same predicate as any page read, so a crash after the annotation
      // is marked applied when - and only when - the store proves it.
      await status();
    },
  };
}
