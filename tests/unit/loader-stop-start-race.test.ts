/**
 * A stop that arrives while a start is still working - the app-level race
 * (lifemodel-q4x.3.2 review finding 7).
 *
 * The one deadline is the stop's. A start held INSIDE a step (here: the seed
 * bundle's existence check, the startup's first hold) must see the stop's
 * latch at the fences of the startup and make NOTHING further - no front
 * door, no vault, no egress, no interface - and when the startup never
 * settles, the stop names the unresolved work in one line and leaves with 1
 * rather than reporting success with a start still going.
 */
import { describe, expect, it } from 'vitest';

import { createLoaderApp, type LoaderApp } from '../../loader/src/app.js';
import { createNodeFileSystem, type FileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import {
  caddySpawn,
  createLoaderWorld,
  lifemodelSpawn,
  scriptAgentVault,
  vaultSpawn,
  waitUntil,
} from '../helpers/loader-doubles.js';

interface Rig {
  app: LoaderApp;
  found: ReturnType<typeof createLoaderWorld>;
  lines: RecordedLine[];
  exits: number[];
  release(): void;
}

/**
 * A loader: the startup is held at the seed bundle's existence check (its
 * first step), and the test releases it whenever it must.
 */
function rig(): Rig {
  const found = createLoaderWorld();
  scriptAgentVault(found);
  const inner = createNodeFileSystem();
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fs = {
    ...inner,
    exists: (path: string) =>
      path === found.config.seedBundle ? gate.then(() => true) : inner.exists(path),
  };
  const lines: RecordedLine[] = [];
  const exits: number[] = [];
  const app = createLoaderApp({
    config: found.config,
    fs,
    runner: found.runner,
    launcher: found.launcher,
    logger: createRecordingLogger(lines),
    clock: found.clock,
    exit: (code) => exits.push(code),
    agentVaultProbe: () => Promise.resolve(true),
  });
  return { app, found, lines, exits, release: () => release?.() };
}

describe('a stop that arrives while a start is still working', () => {
  it('fences the start: it makes nothing further, and the stop answers with the truth', async () => {
    const { app, found, lines, exits, release } = rig();
    const coming = app.start(); // NOT awaited: the start is the work being raced.

    const stopping = app.shutdown('test'); // the stop arrives while the start is held
    // Nothing existed to stop: the stop runs out of steps and races the
    // startup in flight (the sleeps: the server share, then the race).
    await waitUntil(
      () => found.clock.sleeps.length >= 2,
      'the stop is waiting for the startup in flight, under its deadline'
    );
    release();
    const answer = await stopping;

    expect(answer).toBe(0);
    // The released start made NOTHING beyond the stop: no front door, no
    // vault child, no kernel rule, no interface, no lifemodel - and the
    // loader never left with a fatal either.
    expect(caddySpawn(found)).toBeUndefined();
    expect(vaultSpawn(found)).toBeUndefined();
    expect(found.runner.lines().some((line) => line.includes('-A LIFEMODEL_EGRESS'))).toBe(false);
    expect(lifemodelSpawn(found)).toBeUndefined();
    expect(exits).toEqual([]);
    expect(lines.some((line) => line.message.includes('the loader is up'))).toBe(false);
    await coming; // the start's own promise settles
  });

  it('a start held past the deadline is reported, and the stop leaves with 1', async () => {
    const { app, found, lines, exits } = rig(); // never released
    const coming = app.start();

    const stopping = app.shutdown('test');
    await waitUntil(
      () => found.clock.sleeps.length >= 2,
      'the stop is waiting for the startup in flight, under its deadline'
    );
    // The startup never settles: the stop's race with it loses, the
    // unresolved work is named in one line, and the stop leaves with 1
    // rather than a success that hides a start still going.
    found.clock.resolveAll();
    const answer = await stopping;
    expect(answer).toBe(1);
    expect(
      lines.some((line) =>
        line.message.includes('startup was still in flight when the stop deadline ran out')
      )
    ).toBe(true);
    expect(caddySpawn(found)).toBeUndefined();
    expect(vaultSpawn(found)).toBeUndefined();
    expect(exits).toEqual([]);
    void coming; // the start's own promise stays held; the stop went past it
  });
});
