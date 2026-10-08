/**
 * The volume's layout, and what the loader may give away (lifemodel-q4x.2.1
 * rework 2, finding 1).
 *
 * The loader runs as root and lifemodel runs as uid 1000, so the loader gives
 * the instance's own directories to uid 1000. The defect the review found was
 * that it did so RECURSIVELY over a tree uid 1000 already owned: a directory
 * swapped for a symlink to the volume root between the listing and the
 * recursion would have handed `loader/auth.json`, `cli-token` and `panic.json`
 * to lifemodel - its password, its session secret and its panic flag.
 *
 * The rule now: only a `data/` THIS START MADE is given to lifemodel, and only
 * the directory itself. An existing tree is left exactly as it is. The test
 * runs the loader as root the only way a test can - chowning to its OWN
 * identity, which the kernel allows - and records every path that was given
 * away, which is the fact under test.
 */
import { lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createLoaderApp } from '../../loader/src/app.js';
import { hashPassword } from '../../loader/src/auth.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';
import { createLoaderState } from '../../loader/src/state.js';
import {
  createLoaderWorld,
  createRecordingFileSystem,
  lifemodelSpawn,
  scriptRepository,
  shutdownLoader,
  testLoaderApp,
  waitUntil,
  type LoaderWorld,
} from '../helpers/loader-doubles.js';

const roots: string[] = [];

afterEach(() => {
  roots.splice(0);
});

interface Rig {
  world: LoaderWorld;
  lines: RecordedLine[];
  exits: number[];
  recording: ReturnType<typeof createRecordingFileSystem>;
  app: ReturnType<typeof createLoaderApp>;
}

/** A loader over `world`, recording every identity change it makes. */
function makeApp(world: LoaderWorld): Rig {
  roots.push(world.root);
  const lines: RecordedLine[] = [];
  const exits: number[] = [];
  const recording = createRecordingFileSystem();
  const app = testLoaderApp(world, { fs: recording, lines, exits });
  return { world, lines, exits, recording, app };
}

/** The password the owner would have set through boot.<host>. */
async function setPassword(world: LoaderWorld): Promise<void> {
  const state = createLoaderState({
    fs: createNodeFileSystem(),
    config: world.config,
    logger: createRecordingLogger([]),
  });
  await state.writeAuth(await hashPassword('right'));
}

/** A volume that has been started before: the layout, and a password. */
async function existingVolume(world: LoaderWorld): Promise<void> {
  const state = createLoaderState({
    fs: createNodeFileSystem(),
    config: world.config,
    logger: createRecordingLogger([]),
  });
  await state.ensureLayout();
  await state.writeAuth(await hashPassword('right'));
}

describe('the volume the loader prepares', () => {
  it('gives a data/ it made itself to lifemodel, and only that directory', async () => {
    const world = createLoaderWorld({ privileged: true });
    scriptRepository(world);
    // A password is set and nothing else: this start makes data/ itself.
    await setPassword(world);
    const rig = makeApp(world);

    await rig.app.start();
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');

    // The directory this start made, given away as itself - not a tree walk.
    expect(rig.recording.chowns).toEqual([world.config.dataDir]);
    // The one tree that may be walked is the clone this start just made.
    expect(rig.recording.freshTrees).toEqual([world.config.repoDir]);
    expect(statSync(world.config.dataDir).isDirectory()).toBe(true);

    await shutdownLoader(world, rig.app);
  });

  it('leaves an existing data/ tree exactly as it is, symlink and all', async () => {
    const world = createLoaderWorld({ privileged: true });
    scriptRepository(world);
    await existingVolume(world);
    const state = createLoaderState({
      fs: createNodeFileSystem(),
      config: world.config,
      logger: createRecordingLogger([]),
    });
    const paths = state.paths();
    const authBefore = readFileSync(paths.auth, 'utf8');

    // What the review described: an existing data/ that is a symlink to the
    // volume root - the loader's own directory is inside it.
    const fs = createNodeFileSystem();
    await fs.remove(world.config.dataDir);
    symlinkSync(world.config.volumeRoot, world.config.dataDir);

    const rig = makeApp(world);
    await rig.app.start();
    await waitUntil(() => lifemodelSpawn(world) !== undefined, 'lifemodel is started');

    // Nothing on the volume was given to lifemodel by this start except the
    // repository the seed itself made.
    expect(rig.recording.chowns).toEqual([]);
    expect(rig.recording.freshTrees).toEqual([world.config.repoDir]);
    for (const path of [...rig.recording.chowns, ...rig.recording.freshTrees]) {
      expect(path.startsWith(`${world.config.volumeRoot}/loader`)).toBe(false);
      expect(path).not.toBe(world.config.volumeRoot);
    }
    // The loader's own files are where they were: root-only, unreadable to
    // lifemodel, and the same password record.
    expect(lstatSync(world.config.dataDir).isSymbolicLink()).toBe(true);
    expect(statSync(world.config.loaderDir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.auth).mode & 0o777).toBe(0o600);
    expect(readFileSync(paths.auth, 'utf8')).toBe(authBefore);
    expect(rig.exits).toEqual([]);

    await shutdownLoader(world, rig.app);
  });

  it("refuses a tree that is not this process's own, whatever it holds", async () => {
    // The one tree the walk may touch is a tree THIS process just made. A
    // directory that belongs to somebody else - /tmp here, root's - is refused
    // before a single entry of it is looked at: walking it is the attack the
    // review found (a uid-1000 tree whose child directory is swapped for a
    // symlink to the volume root between the listing and the recursion).
    const world = createLoaderWorld({ privileged: true });
    roots.push(world.root);
    const fs = createNodeFileSystem();
    const { uid, gid } = world.config.lifemodel;

    await expect(fs.chownFreshTree('/tmp', uid, gid)).rejects.toThrow(
      /not to this process: only a tree this process just made may be given away/
    );
  });

  it("gives a whole fresh tree away, and the tree's own directory last", async () => {
    // What the seed does to its clone. A tree with a subdirectory is the case
    // that matters: giving a directory away before its contents are walked is
    // what made the first container walk fail - the walk then found a directory
    // that was already lifemodel's and refused it (rework 2).
    const world = createLoaderWorld({ privileged: true });
    roots.push(world.root);
    const fs = createNodeFileSystem();
    const tree = join(world.root, 'fresh');
    mkdirSync(join(tree, 'sub'), { recursive: true });
    writeFileSync(join(tree, 'sub', 'a-file'), 'the clone\n');
    writeFileSync(join(tree, 'top'), 'the clone\n');
    const { uid, gid } = world.config.lifemodel;

    await expect(fs.chownFreshTree(tree, uid, gid)).resolves.toBeUndefined();

    for (const path of [tree, join(tree, 'sub'), join(tree, 'sub', 'a-file'), join(tree, 'top')]) {
      expect({ path, uid: statSync(path).uid }).toEqual({ path, uid });
    }
  });

  it('a data/ that exists as a file is a missing input: one line with the cause', async () => {
    const world = createLoaderWorld({ privileged: true });
    scriptRepository(world);
    const fs = createNodeFileSystem();
    await fs.ensureDir(world.config.volumeRoot, 0o755);
    writeFileSync(world.config.dataDir, "a file where lifemodel's data belongs\n");

    const rig = makeApp(world);
    await rig.app.start();

    expect(rig.exits).toEqual([1]);
    const errors = rig.lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('cannot prepare the volume');
    expect(errors[0]?.message).toContain(`${world.config.dataDir} exists and is not a directory`);
    expect(lifemodelSpawn(world)).toBeUndefined();
  });
});
