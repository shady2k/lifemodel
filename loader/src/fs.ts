/**
 * The filesystem, behind one interface (lifemodel-q4x.2.1).
 *
 * The loader writes on the volume as root - the password hash, the panic flag,
 * the built commit, the instance's repository - so every write here is
 * explicit about its mode, and a file that matters is written whole (a
 * temporary file and a rename), never half.
 */
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lchown,
  lstat,
  mkdir,
  opendir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface FileSystem {
  exists(path: string): Promise<boolean>;
  isDirectory(path: string): Promise<boolean>;
  ensureDir(path: string, mode: number): Promise<void>;
  /**
   * Create `path` as a directory when nothing is there yet, and say whether it
   * was made. An existing path is never touched: what is already on the volume
   * belongs to whoever put it there (rework 2, finding 1).
   */
  createDirIfMissing(path: string, mode: number): Promise<boolean>;
  readFile(path: string): Promise<string>;
  /** Write `contents` to `path` whole: a temporary file, then a rename. */
  writeFileAtomic(path: string, contents: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Give the path ITSELF to one identity; a symlink is given away as a link. */
  chown(path: string, uid: number, gid: number): Promise<void>;
  /**
   * Give a tree THIS PROCESS JUST CREATED to one identity. Only for a tree
   * nobody else can write yet (the fresh clone of the seed bundle); an existing
   * tree on the volume is never traversed (rework 2, finding 1).
   */
  chownFreshTree(path: string, uid: number, gid: number): Promise<void>;
}

/**
 * Give the CONTENTS of a directory to one identity, deepest first.
 *
 * Post-order on purpose: a directory is given away only after everything under
 * it already has been, so every directory is still this process's while it is
 * being walked. That is what makes the walk safe - the attack finding 1
 * described (a tree whose child directory is swapped for a symlink to the
 * volume root between the listing and the recursion) needs write access to the
 * directory being walked, and lifemodel only gets that when the walk has
 * finished with it. The walk never follows a link either: the entries come from
 * the directory's own descriptor, and each one is given away with `lchown`, so
 * a symlink stays a symlink and not what it points at.
 */
async function giveTree(path: string, uid: number, gid: number): Promise<void> {
  const directory = await opendir(path);
  for await (const entry of directory) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await giveTree(child, uid, gid);
    await lchown(child, uid, gid);
  }
}

/**
 * Give a whole tree this process JUST CREATED to one identity, the tree's own
 * directory included.
 *
 * The precondition is checked once, at the entry point: the tree must belong to
 * this process. Only a fresh clone qualifies - an existing tree on the volume
 * belongs to whoever put it there and is never walked (rework 2, finding 1).
 */
async function chownFreshTree(path: string, uid: number, gid: number): Promise<void> {
  const me = typeof process.getuid === 'function' ? process.getuid() : null;
  const root = await lstat(path);
  if (me !== null && root.uid !== me) {
    throw new Error(
      `${path} belongs to uid ${String(root.uid)}, not to this process: only a tree this process just made may be given away`
    );
  }
  await giveTree(path, uid, gid);
  // Last, so the tree is this process's for the whole walk.
  await lchown(path, uid, gid);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function createNodeFileSystem(): FileSystem {
  return {
    exists,
    isDirectory,
    ensureDir: async (path, mode) => {
      await mkdir(path, { recursive: true, mode });
    },
    createDirIfMissing: async (path, mode) => {
      try {
        await mkdir(path, { mode });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // There already: it is left exactly as it is. Only a path that is not a
        // directory at all is an error the loader says out loud.
        if (!(await isDirectory(path))) {
          throw new Error(`${path} exists and is not a directory`);
        }
        return false;
      }
    },
    readFile: (path) => readFile(path, 'utf8'),
    writeFileAtomic: async (path, contents, mode) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = join(dirname(path), `.${String(process.pid)}.${String(Date.now())}.tmp`);
      await writeFile(temporary, contents, { mode });
      await rename(temporary, path);
      await chmod(path, mode);
    },
    remove: (path) => rm(path, { recursive: true, force: true }),
    chmod: (path, mode) => chmod(path, mode),
    // lchown, not chown: a symlink is given away as the symlink it is. A git
    // clone of a bundle has none today, but npm's node_modules does.
    chown: (path, uid, gid) => lchown(path, uid, gid),
    chownFreshTree,
  };
}
