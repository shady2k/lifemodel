/**
 * What the loader keeps on the volume (lifemodel-q4x.2.1, stories S1, S6, S7).
 *
 * Four small files in the loader's own directory, which is root-only (0700)
 * and lives on the volume, so it survives `docker rm -f` and a restart of the
 * Docker daemon:
 *
 *   auth.json    the owner's password digest and the session secret
 *   panic.json   present means panic: lifemodel is stopped and not started
 *   cli-token    what `docker exec <c> lifemodel ...` proves it is root with
 *   state.json   which commit was built, so a start does not rebuild
 *
 * lifemodel runs as uid 1000 and can read none of them.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { PasswordRecord } from './auth.js';
import type { LoaderConfig } from './config.js';
import { LoaderFatalError } from './errors.js';
import type { FileSystem } from './fs.js';
import type { LoaderLogger } from './logger.js';

const AUTH_MODE = 0o600;
const LOADER_DIR_MODE = 0o700;
const VOLUME_DIR_MODE = 0o755;

interface LoaderStateFile {
  version: 1;
  builtCommit: string | null;
  updatedAt: string;
}

interface PanicFile {
  at: string;
  reason: string;
}

export interface LoaderState {
  /** Create the volume's layout and make it reachable for the instance's user. */
  ensureLayout(): Promise<void>;
  readAuth(): Promise<PasswordRecord | null>;
  writeAuth(record: PasswordRecord): Promise<void>;
  isPanicSet(): Promise<boolean>;
  panicReason(): Promise<string | null>;
  setPanic(reason: string): Promise<void>;
  clearPanic(): Promise<void>;
  /** The token the command line proves itself with; created on first need. */
  ensureCliToken(): Promise<string>;
  readCliToken(): Promise<string | null>;
  readBuiltCommit(): Promise<string | null>;
  writeBuiltCommit(commit: string): Promise<void>;
  paths(): { auth: string; panic: string; cliToken: string; state: string };
}

export interface LoaderStateDeps {
  fs: FileSystem;
  config: LoaderConfig;
  logger: LoaderLogger;
}

export function createLoaderState({ fs, config, logger }: LoaderStateDeps): LoaderState {
  const authPath = join(config.loaderDir, 'auth.json');
  const panicPath = join(config.loaderDir, 'panic.json');
  const cliTokenPath = join(config.loaderDir, 'cli-token');
  const statePath = join(config.loaderDir, 'state.json');

  /** A read that distinguishes "not there yet" from "there and unreadable". */
  async function readText(path: string): Promise<string | null> {
    if (!(await fs.exists(path))) return null;
    try {
      return await fs.readFile(path);
    } catch (error) {
      throw new LoaderFatalError(`cannot read ${path}: ${describe(error)}`, { cause: error });
    }
  }

  function parseJson(path: string, text: string): unknown {
    try {
      const value: unknown = JSON.parse(text);
      return value;
    } catch (error) {
      throw new LoaderFatalError(`${path} is not valid JSON: ${describe(error)}`, { cause: error });
    }
  }

  const ensureCliToken = async (): Promise<string> => {
    const existing = await readText(cliTokenPath);
    if (existing !== null && existing.trim() !== '') return existing.trim();
    const token = randomBytes(32).toString('base64url');
    await fs.writeFileAtomic(cliTokenPath, `${token}\n`, AUTH_MODE);
    return token;
  };

  return {
    paths: () => ({ auth: authPath, panic: panicPath, cliToken: cliTokenPath, state: statePath }),

    ensureLayout: async () => {
      let madeDataDir = false;
      try {
        await fs.ensureDir(config.volumeRoot, VOLUME_DIR_MODE);
        await fs.ensureDir(config.loaderDir, LOADER_DIR_MODE);
        await fs.chmod(config.loaderDir, LOADER_DIR_MODE);
        madeDataDir = await fs.createDirIfMissing(config.dataDir, VOLUME_DIR_MODE);
      } catch (error) {
        throw new LoaderFatalError(
          `cannot prepare the volume at ${config.volumeRoot}: ${describe(error)}`,
          { cause: error }
        );
      }
      if (madeDataDir && config.privileged) {
        // ONLY a data/ this start made is given to the instance's user, and only
        // the directory itself: an existing tree on the volume belongs to
        // whoever put it there and is left exactly as it is. Traversing one to
        // chown it is what let a uid-1000 tree hand the loader's own files to
        // lifemodel (rework 2, finding 1).
        try {
          await fs.chown(config.dataDir, config.lifemodel.uid, config.lifemodel.gid);
        } catch (error) {
          throw new LoaderFatalError(
            `cannot give ${config.dataDir} to uid ${String(config.lifemodel.uid)}: ${describe(error)}`,
            { cause: error }
          );
        }
      }
      // The command line needs the token before lifemodel ever starts.
      await ensureCliToken();
      logger.info(
        { volume: config.volumeRoot, loaderDir: config.loaderDir, madeDataDir },
        'volume ready'
      );
    },

    readAuth: async () => {
      const text = await readText(authPath);
      if (text === null) return null;
      const record = parseJson(authPath, text) as PasswordRecord;
      if (
        record.version !== 1 ||
        typeof record.hash !== 'string' ||
        typeof record.salt !== 'string'
      ) {
        throw new LoaderFatalError(`${authPath} does not hold a password this loader wrote`);
      }
      return record;
    },

    writeAuth: async (record) => {
      await fs.writeFileAtomic(authPath, `${JSON.stringify(record, null, 2)}\n`, AUTH_MODE);
    },

    isPanicSet: async () => fs.exists(panicPath),

    panicReason: async () => {
      const text = await readText(panicPath);
      if (text === null) return null;
      return (parseJson(panicPath, text) as PanicFile).reason;
    },

    setPanic: async (reason) => {
      const content: PanicFile = { at: new Date().toISOString(), reason };
      await fs.writeFileAtomic(panicPath, `${JSON.stringify(content, null, 2)}\n`, AUTH_MODE);
    },

    clearPanic: async () => {
      await fs.remove(panicPath);
    },

    ensureCliToken,

    readCliToken: async () => {
      const text = await readText(cliTokenPath);
      return text === null ? null : text.trim();
    },

    readBuiltCommit: async () => {
      const text = await readText(statePath);
      if (text === null) return null;
      return (parseJson(statePath, text) as LoaderStateFile).builtCommit;
    },

    writeBuiltCommit: async (commit) => {
      const content: LoaderStateFile = {
        version: 1,
        builtCommit: commit,
        updatedAt: new Date().toISOString(),
      };
      await fs.writeFileAtomic(statePath, `${JSON.stringify(content, null, 2)}\n`, AUTH_MODE);
    },
  };
}

/** One line's worth of an error, for a log line that has to stay one line. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
