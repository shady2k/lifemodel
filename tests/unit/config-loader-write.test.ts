/**
 * The config file's write contract (lifemodel-q4x.4.1, review round 2
 * findings B and C).
 *
 * The write runs through the REQUIRED storage pipeline (AGENTS.md, Lesson 4):
 * DeferredStorage flushed through JSONStorage rooted at the config directory.
 * Its contract, as the settings interface rest on it:
 *
 * - the file is `<config dir>/agent.json`, the same file `load()` reads;
 * - deciding the outcome at ONE point: an awaited write either published and
 *   resolves with the file whole on disk, or nothing was published and it
 *   rejects - never a rejection after the rename (the old direct writer
 *   answered its directory-sync failure with a 500 "nothing written" while
 *   the file already held the new settings, on a directory the process may
 *   write but not read, mode 0300);
 * - a caller's abort signal stops the write at its publication point.
 */
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConfigLoader } from '../../src/config/config-loader.js';
import type { AgentConfigFile } from '../../src/config/config-schema.js';

const dirs: string[] = [];
let configDir = '';

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'lifemodel-config-write-'));
  dirs.push(configDir);
});

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o700).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

const FILE = (baseUrl: string): AgentConfigFile =>
  ({
    version: 1,
    identity: { name: 'Nika' },
    llm: { endpoint: { baseUrl, fastModel: 'fast', smartModel: 'smart', motorModel: 'motor' } },
  }) as AgentConfigFile;

async function readConfig(): Promise<string> {
  return await readFile(join(configDir, 'agent.json'), 'utf-8');
}

describe('the config write contract', () => {
  it('writes the config the loader reads it back from: same path, same object', async () => {
    const loader = createConfigLoader(configDir);
    await loader.writeFile(FILE('http://127.0.0.1:1234/v1'));

    const raw = await readConfig();
    expect(JSON.parse(raw)).toEqual(FILE('http://127.0.0.1:1234/v1'));

    // And the next start merges it as before: shape unchanged by the writer.
    const merged = await createConfigLoader(configDir).load();
    expect(merged.llm.endpoint.baseUrl).toBe('http://127.0.0.1:1234/v1');
    expect(merged.identity.name).toBe('Nika');
  });

  it('awaits the storage flush: the settings are on disk when the write resolves', async () => {
    const loader = createConfigLoader(configDir);
    await loader.writeFile(FILE('http://127.0.0.1:9/v1'));

    // No deferred timer: the awaited flush persisted it already.
    expect(await readConfig()).toContain('127.0.0.1:9');
  });

  it('a failure BEFORE the publication leaves the file byte for byte as it was', async () => {
    const before = '{"version":1,"identity":{"name":"Nika"}}';
    await writeFile(join(configDir, 'agent.json'), before);

    // No write permission on the directory: opening the temp file fails.
    await chmod(configDir, 0o500);
    try {
      await expect(createConfigLoader(configDir).writeFile(FILE('http://next/v1'))).rejects.toThrow();
      expect(await readConfig()).toBe(before);
      // No half save left behind.
      expect(await readdir(configDir)).toEqual(['agent.json']);
    } finally {
      await chmod(configDir, 0o700);
    }
  });

  it('a directory the process may write but not read (mode 0300) publishes and resolves', async () => {
    // Review round 2, finding C: the OLD writer opened the directory for a
    // sync AFTER the rename; in a 0300 directory that open fails with EACCES,
    // the write rejected, the settings route answered 500 and did not
    // restart - while the file already held the new settings. There is no
    // such post-publication step any more: the rename commits, the write
    // resolves, and the caller restarts onto what is really on disk.
    await writeFile(join(configDir, 'agent.json'), '{"version":1}');
    await chmod(configDir, 0o300);
    try {
      await createConfigLoader(configDir).writeFile(FILE('http://published/v1'));
      expect(JSON.parse(await readConfig())).toEqual(FILE('http://published/v1'));
    } finally {
      await chmod(configDir, 0o700);
    }
  });

  it('an aborted save refuses at its publication point and leaves the file as it was', async () => {
    const before = '{"version":1,"identity":{"name":"Nika"}}';
    await writeFile(join(configDir, 'agent.json'), before);

    const controller = new AbortController();
    controller.abort();
    await expect(
      createConfigLoader(configDir).writeFile(FILE('http://aborted/v1'), {
        signal: controller.signal,
      })
    ).rejects.toThrow();
    expect(await readConfig()).toBe(before);
    expect(await readdir(configDir)).toEqual(['agent.json']);
  });

  it('overlapping writes never publish a mix: the file is one write whole', async () => {
    const loader = createConfigLoader(configDir);
    await loader.writeFile(FILE('http://first/v1'));

    const [a, b] = await Promise.all([
      loader.writeFile(FILE('http://second/v1')),
      loader.writeFile(FILE('http://third/v1')),
    ]);
    void a;
    void b;

    const written = JSON.parse(await readConfig()) as AgentConfigFile;
    const endpoint = (written['llm'] as { endpoint: { baseUrl: string } }).endpoint;
    expect(['http://second/v1', 'http://third/v1']).toContain(endpoint.baseUrl);
  });
});
