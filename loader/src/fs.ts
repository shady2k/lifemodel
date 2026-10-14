/** The platform loader's small filesystem boundary. */
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface FileSystem {
  exists(path: string): Promise<boolean>;
  ensureDir(path: string, mode: number): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFileAtomic(path: string, contents: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
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
    ensureDir: async (path, mode) => mkdir(path, { recursive: true, mode }).then(() => undefined),
    readFile: (path) => readFile(path, 'utf8'),
    writeFileAtomic: async (path, contents, mode) => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = join(dirname(path), `.${String(process.pid)}.${String(Date.now())}.tmp`);
      await writeFile(temporary, contents, { mode });
      await rename(temporary, path);
      await chmod(path, mode);
    },
    chmod: (path, mode) => chmod(path, mode),
  };
}
