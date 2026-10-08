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

    expect(outcome).toEqual({ stopped: true, drainTimedOut: false, pending: null });
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

    // The stop's own deadline wins over lifemodel's 95 s drain, and it keeps
    // the room SIGKILL needs to be reaped (killWaitMs, 1 s here).
    expect(world.clock.sleeps).toEqual([2_000]);
    world.clock.resolveAll();
    await settle();
    world.launcher.spawns[0]?.child.exit(null, 'SIGKILL');

    expect(await stopping).toEqual({ stopped: true, drainTimedOut: true, pending: null });
    const errors = errorLines(rig.lines);
    expect(errors[0]?.message).toContain('2000 ms drain');
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

    expect(await stopping).toEqual({ stopped: true, drainTimedOut: true, pending: null });
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

describe('a stop that meets a start in flight (rework 3, review round 2 finding 1)', () => {
  it('spawns nothing when the stop arrives while the panic flag is being read', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    const lines: RecordedLine[] = [];
    let answerPanic: (set: boolean) => void = () => undefined;
    const supervisor = createSupervisor({
      launcher: world.launcher,
      logger: createRecordingLogger(lines),
      clock: world.clock,
      config: world.config,
      isPanicSet: () =>
        new Promise<boolean>((resolve) => {
          answerPanic = resolve;
        }),
    });

    const starting = supervisor.start();
    await settle();
    const stopping = supervisor.stop('shutdown');
    await settle();
    answerPanic(false);

    expect(await starting).toEqual({ started: false, reason: 'stopping' });
    expect(await stopping).toEqual({ stopped: true, drainTimedOut: false, pending: null });
    expect(world.launcher.spawns).toHaveLength(0);
    expect(supervisor.status().state).toBe('stopped');
  });

  it('drains the child of a spawn the OS had not confirmed yet when the stop arrived', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world } = rig;
    world.launcher.holdSpawns();

    const starting = supervisor.start();
    await settle();
    expect(world.launcher.spawns).toHaveLength(1);
    const child = world.launcher.spawns[0]?.child;

    const stopping = supervisor.stop('shutdown');
    await settle();
    child?.confirmSpawn();
    await starting;
    await settle();
    // The stop found the child the start made and gave it its drain.
    expect(child?.signals).toEqual(['SIGTERM']);
    child?.exit(0, null);

    expect(await stopping).toEqual({ stopped: true, drainTimedOut: false, pending: null });
    expect(supervisor.status().state).toBe('stopped');
    world.clock.resolveAll();
    await settle();
    expect(world.launcher.spawns).toHaveLength(1);
  });

  it('starts nothing once the loader is closing, not even the restart of a death', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world } = rig;
    await supervisor.start();

    supervisor.close();
    world.launcher.spawns[0]?.child.exit(1, null);
    await settle();
    world.clock.resolveAll();
    await settle();

    expect(world.launcher.spawns).toHaveLength(1);
    expect(await supervisor.start()).toEqual({ started: false, reason: 'stopping' });
    expect(world.launcher.spawns).toHaveLength(1);
  });
});

describe('the wait after SIGKILL (rework 3, review round 2 finding 2)', () => {
  it('ends at the budget when the child is not reaped, and says so', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world } = rig;
    await supervisor.start();

    const stopping = supervisor.stop('shutdown', 3_000);
    await settle();
    world.clock.resolveAll(); // the drain runs out
    await settle();
    world.clock.resolveAll(); // and so does the room kept for SIGKILL
    await settle();

    expect(await stopping).toEqual({
      stopped: false,
      drainTimedOut: true,
      pending: 'lifemodel (not reaped after SIGKILL by the stop deadline)',
    });
    expect(world.launcher.spawns[0]?.child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(errorLines(rig.lines).map((line) => line.message)).toContain(
      'lifemodel had not exited after SIGKILL when the stop deadline ran out'
    );
  });

  it('logs an exit the loader asked for at info, and one nobody asked for at warn', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world } = rig;
    await supervisor.start();
    const stopping = supervisor.stop('panic');
    await settle();
    world.launcher.spawns[0]?.child.exit(0, null);
    await stopping;
    const asked = rig.lines.find((line) => line.message === 'lifemodel exited (code 0)');
    expect(asked?.level).toBe('info');

    await supervisor.start();
    world.launcher.spawns[1]?.child.exit(1, null);
    await settle();
    const unasked = rig.lines.find((line) => line.message === 'lifemodel exited (code 1)');
    expect(unasked?.level).toBe('warn');
  });

  it('makes the loader leave with 1 and one line naming what is still pending', async () => {
    const world = createLoaderWorld();
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
    const app = createLoaderApp({
      config: world.config,
      fs,
      runner: world.runner,
      launcher: world.launcher,
      logger: createRecordingLogger(lines),
      clock: world.clock,
      exit: () => undefined,
    });
    roots.push(world.root);
    await app.start();
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');

    const leaving = app.shutdown('SIGTERM');
    await settle();
    // lifemodel never leaves, not even after SIGKILL; Caddy does.
    world.clock.resolveAll();
    await settle();
    world.clock.resolveAll();
    await settle();
    caddySpawn(world)?.child.exit(0, null);

    expect(await leaving).toBe(1);
    const pending = errorLines(lines).find((line) =>
      line.message.startsWith('the loader is leaving with work still pending')
    );
    expect(pending?.message).toContain('lifemodel (not reaped after SIGKILL by the stop deadline)');
    expect(pending?.message).not.toContain('caddy');
  });
});

describe('a start the stop cannot wait for (rework 3, review rounds 3 and 4)', () => {
  it('gives up on a spawn whose verdict never comes: the start settles as failed and a late spawn is killed', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world } = rig;
    world.launcher.holdSpawns();

    const starting = supervisor.start();
    await settle();
    const child = world.launcher.spawns[0]?.child;
    const stopping = supervisor.stop('shutdown', 3_000);
    await settle();
    // The wait for the start is the stop's own cap (the kill room, 1 s here),
    // not its whole deadline.
    expect(world.clock.sleeps).toEqual([1_000]);
    world.clock.resolveAll();

    expect(await stopping).toEqual({
      stopped: false,
      drainTimedOut: false,
      pending: "lifemodel's start (unconfirmed after 1000 ms, given up)",
    });
    // The start settled at once, as a failure with its reason: nothing waits
    // on the verdict, and status says why.
    expect(await starting).toEqual({ started: false, reason: 'failed' });
    expect(supervisor.status().state).toBe('failed');
    expect(supervisor.status().lastError).toContain('did not confirm the start');
    expect(child?.signals).toEqual(['SIGKILL']);
    // The verdict arrives after all: the child is killed again, never owned.
    child?.confirmSpawn();
    await settle();
    expect(child?.signals).toEqual(['SIGKILL', 'SIGKILL']);
    expect(supervisor.status().state).toBe('failed');
    expect(errorLines(rig.lines).map((line) => line.message)).toContain(
      'lifemodel was spawned after its start was given up: it is killed'
    );
  });

  it('lets a resume after a given-up start make a fresh one that runs', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world, panic } = rig;
    world.launcher.holdSpawns();
    void supervisor.start();
    await settle();
    panic.set = true;
    const stopping = supervisor.stop('panic');
    await settle();
    world.clock.resolveAll();
    await stopping;

    panic.set = false; // `lifemodel resume`
    const resuming = supervisor.start();
    await settle();
    expect(world.launcher.spawns).toHaveLength(2);
    world.launcher.spawns[1]?.child.confirmSpawn();
    expect(await resuming).toEqual({ started: true, reason: 'started' });
    expect(supervisor.status().state).toBe('running');
  });

  it('gives up on a panic read that never answers, and spawns nothing', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    const lines: RecordedLine[] = [];
    const supervisor = createSupervisor({
      launcher: world.launcher,
      logger: createRecordingLogger(lines),
      clock: world.clock,
      config: world.config,
      isPanicSet: () => new Promise<boolean>(() => undefined),
    });

    const starting = supervisor.start();
    await settle();
    const stopping = supervisor.stop('panic');
    await settle();
    world.clock.resolveAll();
    expect((await stopping).pending).toContain('given up');
    expect(await starting).toEqual({ started: false, reason: 'stopping' });
    expect(world.launcher.spawns).toHaveLength(0);
  });
});

describe('a resume during a panic drain (rework 3, review round 3 finding 2)', () => {
  it('waits for the drain and then starts lifemodel, because panic was cleared', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world, panic } = rig;
    await supervisor.start();

    panic.set = true;
    const stopping = supervisor.stop('panic');
    await settle();
    expect(world.launcher.spawns[0]?.child.signals).toEqual(['SIGTERM']);

    panic.set = false; // `lifemodel resume` while the old lifemodel still drains
    const resuming = supervisor.start();
    await settle();
    expect(world.launcher.spawns).toHaveLength(1); // nothing until the drain ends

    world.launcher.spawns[0]?.child.exit(0, null);
    await stopping;
    expect(await resuming).toEqual({ started: true, reason: 'started' });
    expect(world.launcher.spawns).toHaveLength(2);
    expect(supervisor.status().state).toBe('running');
  });

  it('starts nothing when panic is still set once the drain ends', async () => {
    const rig = makeSupervisor(createLoaderWorld());
    const { supervisor, world, panic } = rig;
    await supervisor.start();
    panic.set = true;
    const stopping = supervisor.stop('panic');
    await settle();
    const waiting = supervisor.start();
    world.launcher.spawns[0]?.child.exit(0, null);
    await stopping;
    expect(await waiting).toEqual({ started: false, reason: 'panic' });
    expect(world.launcher.spawns).toHaveLength(1);
  });
});
