import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platformSettings } from '../../loader/src/settings/platform.js';
import {
  createPlatformSettingsReader,
  PLATFORM_SETTINGS_FILE,
  platformSettingSpecs,
  validatePlatformValue,
} from '../../src/config/platform-settings.js';
import { createTestLogger } from '../helpers/test-logger.js';

const channelDefaults = {
  'tasks.channel.maxFrameBytes': 65_536,
  'tasks.channel.maxUnackedFrames': 16,
  'tasks.channel.maxUnackedBytes': 1_048_576,
  'tasks.channel.maxBufferedBytes': 4_194_304,
  'tasks.channel.ackTimeoutMs': 5_000,
  'tasks.channel.workers': 2,
  'tasks.channel.sqlConnections': 2,
} as const;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('bounded task channel platform settings', () => {
  it.each(Object.entries(channelDefaults))(
    'declares %s as an owner-controlled finite integer, capped at the tested default',
    (key, value) => {
      expect(platformSettings.get(key)).toMatchObject({
        key,
        section: 'tasks',
        control: 'number',
        dataClass: 'publicConfig',
        default: value,
        integer: true,
        min: 1,
        max: value,
        authority: 'owner',
        apply: 'nextAdmission',
      });
      expect(platformSettingSpecs.find((spec) => spec.key === key)).toMatchObject({
        kind: 'number',
        default: value,
        integer: true,
        min: 1,
        max: value,
      });
      for (const valid of [1, value]) {
        expect(platformSettings.validate(key, valid)).toEqual({ ok: true, value: valid });
        expect(validatePlatformValue(key, valid)).toEqual({ ok: true, value: valid });
      }
      for (const invalid of [
        undefined,
        null,
        false,
        String(value),
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        expect(platformSettings.validate(key, invalid)).toMatchObject({
          ok: false,
          reasonCode: 'wrong_type',
        });
        expect(validatePlatformValue(key, invalid)).toMatchObject({
          ok: false,
          reasonCode: 'wrong_type',
        });
      }
      for (const validate of [
        (raw: unknown) => platformSettings.validate(key, raw),
        (raw: unknown) => validatePlatformValue(key, raw),
      ]) {
        expect(validate(0)).toMatchObject({
          ok: false,
          reasonCode: 'below_minimum',
          limit: 1,
        });
        expect(validate(value + 1)).toMatchObject({
          ok: false,
          reasonCode: 'above_maximum',
          limit: value,
        });
      }
    }
  );

  it('defaults every channel limit when the projection omits the new keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-channel-settings-'));
    roots.push(dir);
    writeFileSync(
      join(dir, PLATFORM_SETTINGS_FILE),
      JSON.stringify({ version: 1, revision: 3, values: { 'tasks.concurrency': 3 } })
    );
    const reader = createPlatformSettingsReader({ dir, logger: createTestLogger('silent') });
    expect(await reader.read()).toMatchObject({ revision: 3, values: channelDefaults });
  });

  it('reads lower channel limits and falls back from an invalid projection per key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-channel-settings-'));
    roots.push(dir);
    const file = join(dir, PLATFORM_SETTINGS_FILE);
    const values = Object.fromEntries(Object.keys(channelDefaults).map((key) => [key, 1]));
    writeFileSync(file, JSON.stringify({ version: 1, revision: 4, values }));
    const reader = createPlatformSettingsReader({ dir, logger: createTestLogger('silent') });
    expect(await reader.read()).toMatchObject({ revision: 4, values });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        revision: 5,
        values: Object.fromEntries(Object.keys(channelDefaults).map((key) => [key, 1.5])),
      })
    );
    expect(await reader.read()).toMatchObject({ revision: 5, values: channelDefaults });
  });
});
