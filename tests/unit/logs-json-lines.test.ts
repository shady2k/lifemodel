/**
 * The loggers a cluster module writes with, and what the collector receives
 * (ADR-016 §9 points 1 and 2, check L02).
 *
 * A cluster record must be one JSON line with its own level, and the module
 * comes from the pod's label, never from a fixed `component` field. The VRL
 * half of L02 runs on the host (`scripts/check-logs-vrl.mjs`): the isolated
 * boundary has no Docker socket, so the pinned Vector binary cannot run here.
 * This file pins the input that check feeds it, through the real loggers:
 *
 *   node --import tsx tests/fixtures/logs-vrl/real-logger-lines.ts <mode>
 *
 * writes one record per level and nothing else.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigLoader } from '../../src/config/config-loader.js';

const SEED = join(process.cwd(), 'tests', 'fixtures', 'logs-vrl', 'real-logger-lines.ts');
const LOADER_MAIN = join(process.cwd(), 'loader', 'src', 'main.ts');
const TSX_IMPORT = ['--import', 'tsx'];

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of ['LOG_PRETTY']) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

/** The real configuration loader with no settings document: the defaults. */
function defaultConfig(): ConfigLoader {
  return new ConfigLoader({
    read: async () => null,
    write: async () => undefined,
  });
}

function seed(mode: string) {
  const result = spawnSync(process.execPath, [...TSX_IMPORT, SEED, mode], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return result.stdout;
}

function plan(): { level: string; message: string }[] {
  return (JSON.parse(seed('plan')) as { records: { level: string; message: string }[] }).records;
}

function lines(mode: string): string[] {
  const output = seed(mode).split('\n');
  if (output.at(-1) === '') output.pop();
  return output;
}

describe('one JSON record per line, with its level (ADR-016 §9 points 1 and 2)', () => {
  it('leaves pretty output off unless someone sets it', async () => {
    const config = await defaultConfig().load();
    expect(config.logging.pretty).toBe(false);
  });

  it('takes pretty output as an explicit development choice', async () => {
    process.env['LOG_PRETTY'] = 'true';
    expect((await defaultConfig().load()).logging.pretty).toBe(true);
    process.env['LOG_PRETTY'] = 'false';
    expect((await defaultConfig().load()).logging.pretty).toBe(false);
    process.env['LOG_PRETTY'] = 'yes';
    await expect(defaultConfig().load()).rejects.toThrow(
      'LOG_PRETTY must be exactly true or false'
    );
  });

  it('the core logger writes one JSON line per record', () => {
    const records = plan();
    const written = lines('core');
    // One formatter line per record: a pretty formatter would split a record
    // over several lines and the collector would store several records.
    expect(written).toHaveLength(records.length);
    // pino's own numbers, in the seed's order: info, warn, error.
    const pinoNumbers = [30, 40, 50];
    written.forEach((line, index) => {
      const record = JSON.parse(line) as { level: number; msg: string };
      expect(record.msg).toBe(records[index]?.message);
      expect(record.level).toBe(pinoNumbers[index]);
    });
  });

  it('the loader image logger writes one JSON line per record and names no module', () => {
    const records = plan();
    const written = lines('loader');
    expect(written).toHaveLength(records.length);
    written.forEach((line, index) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record['level']).toBe(records[index]?.level);
      expect(record['msg']).toBe(records[index]?.message);
      // The pod's label names the module (§2): a `component` would claim one.
      expect(record).not.toHaveProperty('component');
    });
  });

  it('the loader fatal record is one JSON line, at error, without component', () => {
    const result = spawnSync(process.execPath, [...TSX_IMPORT, LOADER_MAIN], {
      cwd: process.cwd(),
      encoding: 'utf8',
      // An invalid configuration: the one line is written before anything is up.
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
    });
    expect(result.status).toBe(1);
    const written = result.stderr.split('\n').filter((line) => line.trim() !== '');
    expect(written).toHaveLength(1);
    const fatal = JSON.parse(written[0] ?? '') as Record<string, unknown>;
    expect(fatal['level']).toBe('error');
    expect(fatal['msg']).toEqual(expect.any(String));
    expect(fatal).not.toHaveProperty('component');
  });

  it('pretty output set explicitly still prints pretty text', () => {
    const records = plan();
    const written = lines('core-pretty');
    expect(written).toHaveLength(records.length);
    written.forEach((line, index) => {
      expect(line).toContain('\u001b[');
      expect(line).toContain(records[index]?.message);
      expect(() => JSON.parse(line) as unknown).toThrow();
    });
  });
});
