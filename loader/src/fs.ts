/** The platform loader's small filesystem boundary. */
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
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
      const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, 'wx', mode);
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, path);
        await chmod(path, mode);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
    chmod: (path, mode) => chmod(path, mode),
  };
}
