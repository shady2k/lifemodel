/**
 * lifemodel's process as the loader holds it (lifemodel-q4x.2.1, stories S1,
 * S6, S8).
 *
 * The criterion: "panic set -> start refused (and normally starts); resume
 * clears; SIGTERM waits for the child's exit". The child is a double, so the
 * tests decide when it dies - and the drain is a clock a test drives, so
 * nothing here waits on a real 95 seconds.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createLoaderApp } from '../../loader/src/app.js';
import { hashPassword } from '../../loader/src/auth.js';
import { createLoaderState } from '../../loader/src/state.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import { createSupervisor, type Supervisor } from '../../loader/src/supervisor.js';
import {
  caddySpawn,
  createLoaderWorld,
  lifemodelSpawn,
  scriptRepository,
  settle,
  waitUntil,
  type LoaderWorld,
} from '../helpers/loader-doubles.js';

const roots: string[] = [];

afterEach(() => {
  roots.splice(0);
});

interface Rig {
  supervisor: Supervisor;
  world: LoaderWorld;
  lines: RecordedLine[];
  panic: { set: boolean };
}

function makeSupervisor(world: LoaderWorld): Rig {
  roots.push(world.root);
  const lines: RecordedLine[] = [];
  const panic = { set: false };
  const supervisor = createSupervisor({
    launcher: world.launcher,
    logger: createRecordingLogger(lines),
    clock: world.clock,
    config: world.config,
    isPanicSet: () => Promise.resolve(panic.set),
  });
  return { supervisor, world, lines, panic };
}

function errorLines(lines: RecordedLine[]): RecordedLine[] {
  return lines.filter((line) => line.level === 'error');
}

describe('panic', () => {
  it('refuses to start while panic is set, starts again once it is cleared', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world, panic } = rig;

    expect(await supervisor.start()).toEqual({ started: true, reason: 'started' });
    expect(world.launcher.spawns).toHaveLength(1);

    panic.set = true;
    const stopping = supervisor.stop('panic');
    await settle();
    world.launcher.spawns[0]?.child.exit(0, null);
    await stopping;
    expect(world.launcher.spawns[0]?.child.signals).toEqual(['SIGTERM']);

    expect(await supervisor.start()).toEqual({ started: false, reason: 'panic' });
    expect(world.launcher.spawns).toHaveLength(1);
    expect(rig.lines.some((line) => line.message.includes('panic is set'))).toBe(true);

    panic.set = false; // `lifemodel resume`
    expect(await supervisor.start()).toEqual({ started: true, reason: 'started' });
    expect(world.launcher.spawns).toHaveLength(2);
    expect(supervisor.status().state).toBe('running');
  });

  it('does not bring a lifemodel that died back while panic is set', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world, panic } = rig;
    await supervisor.start();
    panic.set = true;

    world.launcher.spawns[0]?.child.exit(1, null);
    await settle();
    world.clock.resolveAll();
    await settle();

    expect(world.launcher.spawns).toHaveLength(1);
    expect(rig.lines.some((line) => line.message.includes('not restarted: panic is set'))).toBe(
      true
    );
  });
});

describe('a lifemodel that dies on its own', () => {
  it('is started again after a backoff that grows, and the backoff resets after a healthy run', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world } = rig;
    await supervisor.start();

    // Two deaths in a row, neither of them a healthy run.
    world.launcher.spawns[0]?.child.exit(1, null);
    await settle();
    world.clock.resolveAll();
    await settle();
    expect(world.clock.sleeps).toEqual([1_000]);
    expect(world.launcher.spawns).toHaveLength(2);

    world.launcher.spawns[1]?.child.exit(1, null);
    await settle();
    world.clock.resolveAll();
    await settle();
    expect(world.clock.sleeps).toEqual([1_000, 2_000]);
    expect(world.launcher.spawns).toHaveLength(3);

    // The third run was healthy (longer than the healthy mark): back to the start.
    world.clock.advance(120_000);
    world.launcher.spawns[2]?.child.exit(1, null);
    await settle();
    world.clock.resolveAll();
    await settle();
    expect(world.clock.sleeps).toEqual([1_000, 2_000, 1_000]);
    expect(world.launcher.spawns).toHaveLength(4);
    expect(supervisor.status().restarts).toBe(3);
    expect(supervisor.status().lastExit?.code).toBe(1);
  });

  it('a stop drops the restart that was already scheduled', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world } = rig;
    await supervisor.start();

    world.launcher.spawns[0]?.child.exit(1, null);
    await settle();
    expect(world.clock.pending()).toBe(1); // the backoff is waiting

    await supervisor.stop('panic');
    world.clock.resolveAll();
    await settle();

    expect(world.launcher.spawns).toHaveLength(1);
    expect(supervisor.status().state).toBe('stopped');
  });
});

describe('the drain', () => {
  it('forwards SIGTERM and waits for lifemodel to leave by itself', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world } = rig;
    await supervisor.start();
    const child = world.launcher.spawns[0]?.child;

    const stopping = supervisor.stop('shutdown');
    await settle();
    expect(child?.signals).toEqual(['SIGTERM']);
    // lifemodel drains (its own 90 s of work) and leaves.
    child?.exit(0, null);
    const outcome = await stopping;

    expect(outcome).toEqual({ stopped: true, drainTimedOut: false });
    expect(child?.signals).toEqual(['SIGTERM']); // never killed
    expect(supervisor.status().lastExit).toMatchObject({ code: 0, signal: null });
    expect(errorLines(rig.lines)).toEqual([]);
  });

  it('waits no longer than the budget the caller has left (rework 2, finding 10)', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world } = rig;
    await supervisor.start();

    const stopping = supervisor.stop('shutdown', 3_000);
    await settle();

    // The stop's own deadline wins over lifemodel's 95 s drain.
    expect(world.clock.sleeps).toEqual([3_000]);
    world.clock.resolveAll();
    await settle();
    world.launcher.spawns[0]?.child.exit(null, 'SIGKILL');

    expect(await stopping).toEqual({ stopped: true, drainTimedOut: true });
    const errors = errorLines(rig.lines);
    expect(errors[0]?.message).toContain('3000 ms drain');
  });

  it('waits exactly the drain the contract gives lifemodel', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world } = rig;
    await supervisor.start();

    const stopping = supervisor.stop('shutdown');
    await settle();
    // The wait is lifemodel's own 95 s against its 90 s drain: the child here
    // never leaves, so the test drives the clock to its deadline.
    expect(world.clock.sleeps).toEqual([world.config.drainWaitMs]);
    world.clock.resolveAll();
    await settle();
    world.launcher.spawns[0]?.child.exit(null, 'SIGKILL');

    expect(await stopping).toEqual({ stopped: true, drainTimedOut: true });
    expect(world.launcher.spawns[0]?.child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    const errors = errorLines(rig.lines);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('did not exit within its');
    expect(errors[0]?.message).toContain(String(world.config.drainWaitMs));
  });
});

describe('docker stop, end to end through the loader', () => {
  async function startedApp(world: LoaderWorld) {
    scriptRepository(world);
    const fs = createNodeFileSystem();
    const state = createLoaderState({
      fs,
      config: world.config,
      logger: createRecordingLogger([]),
    });
    await state.ensureLayout();
    await state.writeAuth(await hashPassword('right'));
    const lines: RecordedLine[] = [];
    const exits: number[] = [];
    const app = createLoaderApp({
      config: world.config,
      fs,
      runner: world.runner,
      launcher: world.launcher,
      logger: createRecordingLogger(lines),
      clock: world.clock,
      exit: (code) => exits.push(code),
    });
    roots.push(world.root);
    await app.start();
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');
    return { app, lines, exits };
  }

  it('leaves with 0 when lifemodel finished its drain', async () => {
    const world = createLoaderWorld();
    const { app, exits } = await startedApp(world);
    const child = lifemodelSpawn(world)?.child;

    const leaving = app.shutdown('SIGTERM');
    await settle();
    child?.exit(0, null);
    await settle();
    caddySpawn(world)?.child.exit(0, null);

    expect(await leaving).toBe(0);
    expect(child?.signals).toEqual(['SIGTERM']);
    expect(exits).toEqual([]); // the loader itself decided the code, it did not fail
  });

  it('leaves with a non-zero code and one line when the drain ran out', async () => {
    const world = createLoaderWorld();
    const { app, lines } = await startedApp(world);
    const child = lifemodelSpawn(world)?.child;

    const leaving = app.shutdown('SIGTERM');
    await settle();
    world.clock.resolveAll();
    await settle();
    child?.exit(null, 'SIGKILL');
    await settle();
    caddySpawn(world)?.child.exit(0, null);
    const code = await leaving;

    expect(code).toBe(1);
    const errors = errorLines(lines);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('did not exit within its');
    expect(errors[0]?.message).toContain('it is killed');
  });
});
