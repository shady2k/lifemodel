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
  mkdir,
  readFile,
  readdir,
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
  readFile(path: string): Promise<string>;
  /** Write `contents` to `path` whole: a temporary file, then a rename. */
  writeFileAtomic(path: string, contents: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Give a whole tree to the instance's user (the seeded repository). */
  chownRecursive(path: string, uid: number, gid: number): Promise<void>;
}

/** Give a whole tree to one identity, following directories but not symlinks. */
async function chownTree(path: string, uid: number, gid: number): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    await lchown(child, uid, gid);
    if (entry.isDirectory()) await chownTree(child, uid, gid);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function createNodeFileSystem(): FileSystem {
  return {
    exists,
    isDirectory: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
    ensureDir: async (path, mode) => {
      await mkdir(path, { recursive: true, mode });
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
    chownRecursive: async (path, uid, gid) => {
      // lchown, not chown: a symlink is given away as the symlink it is. A
      // git clone of a bundle has none today, but npm's node_modules does.
      await lchown(path, uid, gid);
      await chownTree(path, uid, gid);
    },
  };
}
