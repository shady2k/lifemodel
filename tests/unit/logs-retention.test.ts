/**
 * The owner's retention setting, its flags and its one bound (ADR-016 §5,
 * check L08): the numbers the page accepts, the three store flags they become,
 * the durable desired revision, and the refusal of a byte bound the volume can
 * never reach.
 */
import { describe, expect, it } from 'vitest';
import {
  LOGS_RETENTION_DEFAULT_DAYS,
  LOGS_RETENTION_DEFAULT_MAX_BYTES,
  checkRetention,
  counterOf,
  desiredRevisionOf,
  flagsAgree,
  marginBytesOf,
  parseByteQuantity,
  parseKubernetesQuantity,
  parseRetentionDays,
  parseStoreFlags,
  retentionLimits,
  storeFlagsOf,
  type LogsRetentionLimits,
} from '../../loader/src/logs-retention.js';
import { evictorThresholdBytes } from '../../loader/src/logs-volume-space.js';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const VOLUME_3GIB = 3 * GIB;

function limitsOf(volumeBytes = VOLUME_3GIB): LogsRetentionLimits {
  return retentionLimits(volumeBytes);
}

describe('the retention defaults and the volume limits', () => {
  it('defaults to 14 days and 1.5 GiB, which is exactly a 3 GiB volume less its threshold', () => {
    expect(LOGS_RETENTION_DEFAULT_DAYS).toBe(14);
    expect(LOGS_RETENTION_DEFAULT_MAX_BYTES).toBe(1_610_612_736);
    const limits = limitsOf();
    expect(limits.volumeBytes).toBe(VOLUME_3GIB);
    expect(limits.evictorThresholdBytes).toBe(evictorThresholdBytes(VOLUME_3GIB));
    expect(limits.largestMaxBytes).toBe(LOGS_RETENTION_DEFAULT_MAX_BYTES);
    expect(marginBytesOf(VOLUME_3GIB)).toBe(805_306_368);
    // A 2 GiB volume keeps at most 0.75 GiB of logs (ADR-016 §5).
    expect(limitsOf(2 * GIB).largestMaxBytes).toBe(768 * MIB);
    // The margin is the same share of the volume in both.
    expect(marginBytesOf(2 * GIB)).toBe(512 * MIB);
  });

  it('accepts a bound at the largest one that fits and one 1 MiB below it', () => {
    const limits = limitsOf();
    expect(checkRetention({ days: 7, maxBytes: limits.largestMaxBytes }, limits)).toEqual({
      state: 'ok',
      value: { days: 7, maxBytes: limits.largestMaxBytes },
    });
    expect(
      checkRetention({ days: 7, maxBytes: limits.largestMaxBytes - MIB }, limits)
    ).toEqual({ state: 'ok', value: { days: 7, maxBytes: limits.largestMaxBytes - MIB } });
  });

  it('refuses a bound above volume minus the evictor threshold, with both numbers', () => {
    const limits = limitsOf();
    const above = limits.largestMaxBytes + 1;
    const refusal = checkRetention({ days: 14, maxBytes: above }, limits);
    expect(refusal).toEqual({
      state: 'above_volume',
      maxBytes: above,
      largestMaxBytes: limits.largestMaxBytes,
      volumeBytes: VOLUME_3GIB,
      evictorThresholdBytes: limits.evictorThresholdBytes,
    });
    // The largest accepted bound is volume minus the evictor's threshold; a
    // naive bound (the whole volume) is refused too.
    expect(checkRetention({ days: 14, maxBytes: VOLUME_3GIB }, limits).state).toBe('above_volume');
    // A 6 GiB volume: 1.5 GiB margin plus 768 MiB of headroom is a 2.25 GiB
    // threshold, so 3.75 GiB is the largest bound that could ever be reached.
    expect(limitsOf(6 * GIB).largestMaxBytes).toBe(6 * GIB - (GIB + GIB / 2) - 768 * MIB);
    expect(checkRetention({ days: 14, maxBytes: 5 * GIB }, limitsOf(6 * GIB)).state).toBe(
      'above_volume'
    );
    expect(
      checkRetention({ days: 14, maxBytes: limitsOf(6 * GIB).largestMaxBytes }, limitsOf(6 * GIB))
        .state
    ).toBe('ok');
  });

  it('refuses a malformed body field by field', () => {
    const limits = limitsOf();
    for (const input of [
      null,
      [],
      {},
      { days: 7 },
      { days: 0, maxBytes: MIB },
      { days: -1, maxBytes: MIB },
      { days: 1.5, maxBytes: MIB },
      { days: '7', maxBytes: MIB },
      { days: 3651, maxBytes: MIB },
      { days: 7, maxBytes: 0 },
      { days: 7, maxBytes: -MIB },
      { days: 7, maxBytes: 1.5 },
      { days: 7, maxBytes: MIB, extra: true },
    ])
      expect(checkRetention(input, limits).state, JSON.stringify(input)).toBe('invalid');
    expect(checkRetention({ days: '7', maxBytes: MIB }, limits)).toEqual({
      state: 'invalid',
      field: 'days',
    });
    expect(checkRetention({ days: 7, maxBytes: MIB, extra: true }, limits)).toEqual({
      state: 'invalid',
      field: 'body',
    });
  });
});

describe('the store flags the setting becomes (F3)', () => {
  it('writes the three prefixed keys, the margin as a share of the volume', () => {
    expect(storeFlagsOf({ days: 7, maxBytes: 1_073_741_824 }, limitsOf())).toEqual({
      retentionPeriod: '7d',
      retentionMaxDiskSpaceUsageBytes: '1073741824',
      storageMinFreeDiskSpaceBytes: '805306368',
    });
    expect(storeFlagsOf({ days: 14, maxBytes: 1_610_612_736 }, limitsOf(4 * GIB))).toEqual({
      retentionPeriod: '14d',
      retentionMaxDiskSpaceUsageBytes: '1610612736',
      storageMinFreeDiskSpaceBytes: String(GIB),
    });
  });

  it('reads back the three flags the store prints, and ignores the one it must not show', () => {
    const text = [
      '-envflag.enable="true"',
      '-partitionManageAuthKey="secret"',
      '-retention.maxDiskSpaceUsageBytes="1610612736"',
      '-retentionPeriod="14d"',
      '-storage.minFreeDiskSpaceBytes="805306368"',
      '',
    ].join('\n');
    expect(parseStoreFlags(text)).toEqual({
      days: 14,
      maxBytes: 1_610_612_736,
      minFreeBytes: 805_306_368,
    });
    // The measured 123MiB form of the same flag is the same number.
    expect(
      parseStoreFlags('-retention.maxDiskSpaceUsageBytes="123MiB"\n-retentionPeriod="3d"\n')
    ).toEqual({ days: 3, maxBytes: 123 * MIB, minFreeBytes: null });
    expect(parseStoreFlags('')).toEqual({ days: null, maxBytes: null, minFreeBytes: null });
    expect(parseStoreFlags('-retentionPeriod="forever"')).toEqual({
      days: null,
      maxBytes: null,
      minFreeBytes: null,
    });
  });

  it('agrees only when all three flags equal the desired ones', () => {
    const expected = { days: 7, maxBytes: 1_073_741_824, minFreeBytes: 805_306_368 };
    expect(flagsAgree({ ...expected }, expected)).toBe(true);
    expect(flagsAgree({ ...expected, days: 14 }, expected)).toBe(false);
    expect(flagsAgree({ ...expected, maxBytes: 1_073_741_825 }, expected)).toBe(false);
    expect(flagsAgree({ ...expected, minFreeBytes: null }, expected)).toBe(false);
  });

  it('reads a duration in days and a byte figure in either measured form', () => {
    expect(parseRetentionDays('14d')).toBe(14);
    expect(parseRetentionDays('1d')).toBe(1);
    expect(parseRetentionDays('0d')).toBeNull();
    expect(parseRetentionDays('14h')).toBeNull();
    expect(parseRetentionDays('forever')).toBeNull();
    expect(parseByteQuantity('1610612736')).toBe(1_610_612_736);
    expect(parseByteQuantity('123MiB')).toBe(123 * MIB);
    expect(parseByteQuantity('1.5GiB')).toBeNull();
    expect(parseByteQuantity('-1')).toBeNull();
    expect(parseByteQuantity('')).toBeNull();
  });
});

describe('the durable desired revision', () => {
  it('is a counter plus a hash of the effective flags, and changes with them', () => {
    const first = storeFlagsOf({ days: 14, maxBytes: 1_610_612_736 }, limitsOf());
    const changed = storeFlagsOf({ days: 7, maxBytes: 1_610_612_736 }, limitsOf());
    const revision = desiredRevisionOf(1, first);
    expect(revision).toMatch(/^1-[0-9a-z]+$/);
    expect(counterOf(revision)).toBe(1);
    expect(desiredRevisionOf(1, changed)).not.toBe(revision);
    expect(desiredRevisionOf(2, first)).not.toBe(revision);
    // The same flags on the same counter name the same revision: a repeated
    // identical write converges instead of restarting the store again.
    expect(desiredRevisionOf(1, { ...first })).toBe(revision);
    expect(counterOf('not-a-revision')).toBe(0);
  });
});

describe('the volume size the cluster reports', () => {
  it('parses the claim capacity as a Kubernetes quantity', () => {
    expect(parseKubernetesQuantity('3Gi')).toBe(VOLUME_3GIB);
    expect(parseKubernetesQuantity('512Mi')).toBe(512 * MIB);
    expect(parseKubernetesQuantity('1610612736')).toBe(1_610_612_736);
    expect(parseKubernetesQuantity('3G')).toBe(3_000_000_000);
    expect(parseKubernetesQuantity('')).toBeNull();
    expect(parseKubernetesQuantity('three')).toBeNull();
  });
});
