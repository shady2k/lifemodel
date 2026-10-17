/** Persistent platform-loader authentication state. */
import { join } from 'node:path';
import type { PasswordRecord } from './auth.js';
import type { LoaderConfig } from './config.js';
import { LoaderFatalError } from './errors.js';
import type { FileSystem } from './fs.js';
import type { LoaderLogger } from './logger.js';

const AUTH_MODE = 0o600;
const LOADER_DIR_MODE = 0o700;
export interface OnboardingRecord {
  version: 1;
  step: string;
  completedAt: string | null;
}

export interface LoaderState {
  ensureLayout(): Promise<void>;
  readAuth(): Promise<PasswordRecord | null>;
  writeAuth(record: PasswordRecord): Promise<void>;
  replaceAuth(record: PasswordRecord): Promise<void>;
  readOnboarding?(): Promise<OnboardingRecord>;
}

export interface LoaderStateDeps {
  fs: FileSystem;
  config: LoaderConfig;
  logger: LoaderLogger;
}

export function createLoaderState({ fs, config, logger }: LoaderStateDeps): LoaderState {
  const authPath = join(config.loaderDir, 'auth.json');
  const onboardingPath = join(config.loaderDir, 'onboarding.json');
  const initialOnboarding: OnboardingRecord = { version: 1, step: 'welcome', completedAt: null };
  async function readAuth(): Promise<PasswordRecord | null> {
    if (!(await fs.exists(authPath))) return null;
    let text: string;
    try {
      text = await fs.readFile(authPath);
    } catch (error) {
      throw new LoaderFatalError(`cannot read ${authPath}: ${describe(error)}`, { cause: error });
    }
    let record: unknown;
    try {
      record = JSON.parse(text) as unknown;
    } catch (error) {
      throw new LoaderFatalError(`${authPath} is not valid JSON: ${describe(error)}`, {
        cause: error,
      });
    }
    const value = record as Partial<PasswordRecord>;
    if (value.version !== 1 || typeof value.hash !== 'string' || typeof value.salt !== 'string') {
      throw new LoaderFatalError(`${authPath} does not hold a password this loader wrote`);
    }
    return value as PasswordRecord;
  }
  return {
    ensureLayout: async () => {
      try {
        await fs.ensureDir(config.volumeRoot, 0o755);
        await fs.ensureDir(config.loaderDir, LOADER_DIR_MODE);
        await fs.chmod(config.loaderDir, LOADER_DIR_MODE);
      } catch (error) {
        throw new LoaderFatalError(
          `cannot prepare the loader volume at ${config.volumeRoot}: ${describe(error)}`,
          { cause: error }
        );
      }
      logger.info(
        { volume: config.volumeRoot, loaderDir: config.loaderDir },
        'platform loader volume ready'
      );
    },
    readAuth,
    writeAuth: async (record) =>
      fs.writeFileExclusive(authPath, `${JSON.stringify(record, null, 2)}\n`, AUTH_MODE),
    replaceAuth: async (record) =>
      fs.writeFileAtomic(authPath, `${JSON.stringify(record, null, 2)}\n`, AUTH_MODE),
    readOnboarding: async () => {
      if (!(await fs.exists(onboardingPath))) {
        await fs
          .writeFileExclusive(
            onboardingPath,
            `${JSON.stringify(initialOnboarding, null, 2)}\n`,
            AUTH_MODE
          )
          .catch(async () => {
            if (!(await fs.exists(onboardingPath)))
              throw new LoaderFatalError('cannot create onboarding state');
          });
      }
      let value: unknown;
      try {
        value = JSON.parse(await fs.readFile(onboardingPath)) as unknown;
      } catch (error) {
        throw new LoaderFatalError(`cannot read onboarding state: ${describe(error)}`, {
          cause: error,
        });
      }
      const record = value as Partial<OnboardingRecord>;
      if (
        record.version !== 1 ||
        typeof record.step !== 'string' ||
        !(record.completedAt === null || typeof record.completedAt === 'string')
      )
        throw new LoaderFatalError('onboarding.json does not hold valid onboarding state');
      return record as OnboardingRecord;
    },
  };
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
