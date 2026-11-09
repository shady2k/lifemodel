/**
 * The owner's retention setting, the store flags it becomes and the one bound
 * the volume can reach (ADR-016 §5, check L08).
 *
 * `logs.retention` is two numbers the owner sets; the store reads three flags,
 * because the margin it keeps for its merges is not an owner setting but a
 * share of the volume. This file is the whole arithmetic: the defaults, the
 * largest byte bound that fits (`volume − evictor threshold`, from
 * `logs-volume-space.ts`), the flag text, the durable desired revision (a
 * counter plus a hash of the effective flags) and the read-back comparison
 * against the store's own `/flags`.
 *
 * Nothing here talks to a cluster, a file or an HTTP endpoint.
 */
import { createHash } from 'node:crypto';
import { LOGS_VOLUME_MARGIN_SHARE, evictorThresholdBytes } from './logs-volume-space.js';

/** ADR-016 §5: 14 days and 1.5 GiB, which is exactly a 3 GiB volume less its threshold. */
export const LOGS_RETENTION_DEFAULT_DAYS = 14;
export const LOGS_RETENTION_DEFAULT_MAX_BYTES = 1_610_612_736;

/** A year and a half short of a decade: a day count a partition layout can hold. */
export const LOGS_RETENTION_MAX_DAYS = 3650;

const MIB = 1024 * 1024;
const BINARY_SUFFIXES: Readonly<Record<string, number>> = {
  Ki: 1024,
  Mi: MIB,
  Gi: 1024 * MIB,
  Ti: 1024 * 1024 * MIB,
  KiB: 1024,
  MiB: MIB,
  GiB: 1024 * MIB,
  TiB: 1024 * 1024 * MIB,
};
const DECIMAL_SUFFIXES: Readonly<Record<string, number>> = {
  K: 1000,
  M: 1000 * 1000,
  G: 1000 * 1000 * 1000,
  T: 1000 * 1000 * 1000 * 1000,
  k: 1000,
};

/** The owner's two numbers. */
export interface LogsRetention {
  readonly days: number;
  readonly maxBytes: number;
}

/** What the volume allows: its size, the evictor's threshold and the largest reachable bound. */
export interface LogsRetentionLimits {
  readonly volumeBytes: number;
  readonly evictorThresholdBytes: number;
  /** `volume − threshold`: a larger byte bound could never be reached. */
  readonly largestMaxBytes: number;
}

/** The margin the store keeps inside the volume for its merges (25 %). */
export function marginBytesOf(volumeBytes: number): number {
  return Math.ceil(volumeBytes * LOGS_VOLUME_MARGIN_SHARE);
}

export function retentionLimits(volumeBytes: number): LogsRetentionLimits {
  const threshold = evictorThresholdBytes(volumeBytes);
  return {
    volumeBytes,
    evictorThresholdBytes: threshold,
    largestMaxBytes: volumeBytes - threshold,
  };
}

/** A body the page may send, or the reason it may not. */
export type LogsRetentionCheck =
  | { readonly state: 'ok'; readonly value: LogsRetention }
  | { readonly state: 'invalid'; readonly field: 'body' | 'days' | 'maxBytes' }
  | {
      readonly state: 'above_volume';
      readonly maxBytes: number;
      readonly largestMaxBytes: number;
      readonly volumeBytes: number;
      readonly evictorThresholdBytes: number;
    };

function isCount(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * The body is exactly the two numbers. A bound above `volume − threshold` is
 * refused with both figures: the evictor removes a day before such a bound
 * could ever be reached, so accepting it would promise something it cannot do.
 */
export function checkRetention(input: unknown, limits: LogsRetentionLimits): LogsRetentionCheck {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    return { state: 'invalid', field: 'body' };
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('days') || !keys.includes('maxBytes'))
    return { state: 'invalid', field: 'body' };
  const body = input as Record<string, unknown>;
  const days = body['days'];
  if (!isCount(days, 1, LOGS_RETENTION_MAX_DAYS)) return { state: 'invalid', field: 'days' };
  const maxBytes = body['maxBytes'];
  if (!isCount(maxBytes, 1, Number.MAX_SAFE_INTEGER))
    return { state: 'invalid', field: 'maxBytes' };
  if (maxBytes > limits.largestMaxBytes)
    return {
      state: 'above_volume',
      maxBytes,
      largestMaxBytes: limits.largestMaxBytes,
      volumeBytes: limits.volumeBytes,
      evictorThresholdBytes: limits.evictorThresholdBytes,
    };
  return { state: 'ok', value: { days, maxBytes } };
}

/** The three ConfigMap keys the store reads through `-envflag.prefix=VL_`. */
export interface LogsStoreFlags {
  readonly retentionPeriod: string;
  readonly retentionMaxDiskSpaceUsageBytes: string;
  readonly storageMinFreeDiskSpaceBytes: string;
}

export function storeFlagsOf(
  retention: LogsRetention,
  limits: LogsRetentionLimits
): LogsStoreFlags {
  return {
    retentionPeriod: `${String(retention.days)}d`,
    retentionMaxDiskSpaceUsageBytes: String(retention.maxBytes),
    storageMinFreeDiskSpaceBytes: String(marginBytesOf(limits.volumeBytes)),
  };
}

/** What the flags say once read back from the store, or null where unreadable. */
export interface ObservedRetentionFlags {
  readonly days: number | null;
  readonly maxBytes: number | null;
  readonly minFreeBytes: number | null;
}

/** The store's own flags answer, read through the adapter's `GET /flags`. */
export type LogsRetentionFlagsRead =
  | { readonly state: 'ok'; readonly observed: ObservedRetentionFlags }
  | { readonly state: 'unavailable' };

/** The values the desired flags must read back as. */
export interface RetentionFlagValues {
  readonly days: number;
  readonly maxBytes: number;
  readonly minFreeBytes: number;
}

export function flagValuesOf(
  retention: LogsRetention,
  limits: LogsRetentionLimits
): RetentionFlagValues {
  return {
    days: retention.days,
    maxBytes: retention.maxBytes,
    minFreeBytes: marginBytesOf(limits.volumeBytes),
  };
}

/** The three retention flags exactly as the store printed them. */
export interface LogsStoreFlagText {
  readonly retentionPeriod: string | null;
  readonly retentionMaxDiskSpaceUsageBytes: string | null;
  readonly storageMinFreeDiskSpaceBytes: string | null;
}

/**
 * The store's three flags as the numbers they mean. A value it did not print,
 * or printed in a form this loader does not read, stays null so the comparison
 * cannot pass by accident.
 */
export function observedFlagsOf(text: LogsStoreFlagText): ObservedRetentionFlags {
  return {
    days: text.retentionPeriod === null ? null : parseRetentionDays(text.retentionPeriod),
    maxBytes:
      text.retentionMaxDiskSpaceUsageBytes === null
        ? null
        : parseByteQuantity(text.retentionMaxDiskSpaceUsageBytes),
    minFreeBytes:
      text.storageMinFreeDiskSpaceBytes === null
        ? null
        : parseByteQuantity(text.storageMinFreeDiskSpaceBytes),
  };
}

export function flagsAgree(
  observed: ObservedRetentionFlags,
  expected: RetentionFlagValues
): boolean {
  return (
    observed.days === expected.days &&
    observed.maxBytes === expected.maxBytes &&
    observed.minFreeBytes === expected.minFreeBytes
  );
}

/** `14d` as 14 days; the setting always writes that one form. */
export function parseRetentionDays(text: string): number | null {
  const match = /^(\d{1,4})d$/.exec(text.trim());
  if (match === null) return null;
  const days = Number(match[1]);
  return Number.isSafeInteger(days) && days > 0 ? days : null;
}

/** A byte figure the store prints: plain bytes, or the binary/decimal suffix forms it accepts. */
export function parseByteQuantity(text: string): number | null {
  const value = text.trim();
  const match = /^(\d+)([A-Za-z]*)$/.exec(value);
  if (match === null) return null;
  const digits = Number(match[1]);
  if (!Number.isSafeInteger(digits)) return null;
  const suffix = match[2] ?? '';
  if (suffix === '') return digits;
  const binary = BINARY_SUFFIXES[suffix];
  if (binary !== undefined) return digits * binary;
  const decimal = DECIMAL_SUFFIXES[suffix];
  if (decimal !== undefined) return digits * decimal;
  return null;
}

/** `3Gi` as the claim reports its capacity. */
export function parseKubernetesQuantity(text: string): number | null {
  if (text.trim() === '') return null;
  return parseByteQuantity(text);
}

/** The revision string a desired setting is named by: the counter, a dash, the flags' hash. */
export function desiredRevisionOf(counter: number, flags: LogsStoreFlags): string {
  const hash = createHash('sha256')
    .update(
      `${flags.retentionPeriod}|${flags.retentionMaxDiskSpaceUsageBytes}|${flags.storageMinFreeDiskSpaceBytes}`
    )
    .digest('hex')
    .slice(0, 12);
  return `${String(counter)}-${hash}`;
}

/** The counter a revision string carries; 0 for anything this loader did not write. */
export function counterOf(revision: string): number {
  const match = /^(\d{1,9})-/.exec(revision);
  return match === null ? 0 : Number(match[1]);
}
