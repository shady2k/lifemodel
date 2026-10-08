/**
 * The front door (lifemodel-q4x.2.1, decision 13, story S2).
 *
 * Caddy is the only web entrance, and the login page must work while
 * lifemodel is stopped, panicked or being built - so the loader owns Caddy
 * and keeps it up independently of lifemodel.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  caddySpawn,
  createLoaderWorld,
  createRunningLoader,
  lifemodelSpawn,
  scriptRepository,
  settle,
  shutdownLoader,
  waitUntil,
} from '../helpers/loader-doubles.js';

const roots: string[] = [];

afterEach(() => {
  roots.splice(0);
});

describe('caddy, the front door the loader owns', () => {
  it('is opened before lifemodel starts, with the image paths', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);

    const { app } = await createRunningLoader(world);
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');

    expect(world.launcher.spawns.map((spawn) => spawn.command)).toEqual([
      world.config.caddy.binary,
      'node',
    ]);
    const caddy = caddySpawn(world);
    expect(caddy?.args).toEqual([
      'run',
      '--config',
      world.config.caddy.config,
      '--adapter',
      'caddyfile',
    ]);
    expect(caddy?.options.cwd).toBe(world.config.volumeRoot);
    expect(caddy?.options.uid).toBeUndefined(); // root, as the trusted layer
    await shutdownLoader(world, app);
  });

  it('stays up when panic stops lifemodel', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app } = await createRunningLoader(world);
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');

    await app.state.setPanic('a test');
    const stopping = app.supervisor.stop('panic');
    await settle();
    lifemodelSpawn(world)?.child.exit(0, null);
    await stopping;

    expect(lifemodelSpawn(world)?.child.signals).toEqual(['SIGTERM']);
    expect(caddySpawn(world)?.child.signals).toEqual([]); // the login page is still served
    expect(app.frontDoor.status().running).toBe(true);

    await app.state.clearPanic();
    await shutdownLoader(world, app);
  });

  it('is started again after a backoff when it dies', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app } = await createRunningLoader(world);

    caddySpawn(world)?.child.exit(1, null);
    await settle();
    expect(world.clock.sleeps).toEqual([1_000]);
    world.clock.resolveAll();
    await settle();

    expect(
      world.launcher.spawns.filter((s) => s.command === world.config.caddy.binary)
    ).toHaveLength(2);
    expect(app.frontDoor.status().restarts).toBe(1);

    await shutdownLoader(world, app);
  });

  it('a missing caddy is a missing input: one line with the cause, then a non-zero exit', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const missing = { ...world.config.caddy, binary: `${world.root}/no-caddy-here` };
    world.config = { ...world.config, caddy: missing };

    const { app, lines, exits } = await createRunningLoader(world);
    await waitUntil(() => exits.length > 0, 'the loader left');

    expect(exits).toEqual([1]);
    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain(missing.binary);
    expect(errors[0]?.message).toContain('front door is missing');
    expect(lifemodelSpawn(world)).toBeUndefined();
  });

  it('stops inside the ONE deadline of the whole stop (rework 2, finding 10)', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app } = await createRunningLoader(world);
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');

    const leaving = app.shutdown('SIGTERM');
    await waitUntil(
      () => lifemodelSpawn(world)?.child.signals.length === 1,
      'lifemodel is asked to stop'
    );
    // Four of the stop's six seconds pass while lifemodel drains; what is left
    // of the same deadline, less the room kept for SIGKILL (1 s), is what
    // Caddy gets - not its own wait.
    world.clock.advance(4_500);
    lifemodelSpawn(world)?.child.exit(0, null);
    await waitUntil(() => caddySpawn(world)?.child.signals.length === 1, 'caddy is asked to stop');

    // The loader's own server close (bounded by the kill room), the drain,
    // then Caddy's share.
    expect(world.clock.sleeps).toEqual([1_000, world.config.drainWaitMs, 500]);
    caddySpawn(world)?.child.exit(0, null);

    expect(await leaving).toBe(0);
  });

  it('gives up on a Caddy that is not reaped after SIGKILL at the deadline (rework 3)', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app, lines } = await createRunningLoader(world);
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');

    const leaving = app.shutdown('SIGTERM');
    await waitUntil(
      () => lifemodelSpawn(world)?.child.signals.length === 1,
      'lifemodel is asked to stop'
    );
    lifemodelSpawn(world)?.child.exit(0, null);
    await waitUntil(() => caddySpawn(world)?.child.signals.length === 1, 'caddy is asked to stop');
    world.clock.resolveAll(); // Caddy's wait runs out: SIGKILL
    await waitUntil(() => caddySpawn(world)?.child.signals.length === 2, 'caddy is killed');
    world.clock.resolveAll(); // and it is still not reaped at the deadline

    expect(await leaving).toBe(1);
    expect(caddySpawn(world)?.child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    const pending = lines.find((line) => line.message.startsWith('the stop deadline ran out'));
    expect(pending?.message).toContain('caddy (not reaped after SIGKILL)');
  });

  it('is stopped last: lifemodel drains first, the front door closes after', async () => {
    const world = createLoaderWorld();
    roots.push(world.root);
    scriptRepository(world);
    const { app } = await createRunningLoader(world);
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');

    const leaving = app.shutdown('SIGTERM');
    await waitUntil(
      () => lifemodelSpawn(world)?.child.signals.length === 1,
      'lifemodel is asked to stop'
    );
    expect(caddySpawn(world)?.child.signals).toEqual([]);
    lifemodelSpawn(world)?.child.exit(0, null);

    await waitUntil(() => caddySpawn(world)?.child.signals.length === 1, 'caddy is asked to stop');
    caddySpawn(world)?.child.exit(0, null);

    expect(await leaving).toBe(0);
    expect(caddySpawn(world)?.child.signals).toEqual(['SIGTERM']);
  });
});
