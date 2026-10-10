import { clearTimeout, setTimeout } from 'node:timers';
import { vi } from 'vitest';
import type { LoaderHttp } from '../../loader/src/http.js';

type Lifetime = { isClosed(): boolean };
type Owner = { lifetime: Lifetime; admissionClosed: boolean };
type NativeListenVerdict =
  | { kind: 'listening' }
  | { kind: 'error'; error: unknown };
type Resource = {
  http: LoaderHttp;
  listens: Promise<NativeListenVerdict>[];
  closeRequested: boolean;
  nativeClosePromise?: Promise<void>;
  closed: boolean;
};

const ownership = vi.hoisted(() => ({
  owners: new WeakMap<object, Owner>(),
  resources: new WeakMap<object, Resource[]>(),
}));

function ownershipError(message: string): Error {
  const error = new Error(message);
  error.name = 'LoaderHttpOwnershipError';
  return error;
}

/** Reserve before delegating; verdict promises never reject. */
function reserveNativeListenVerdict(
  server: LoaderHttp['server'],
  resource: Resource,
): { syncNativeListenThrow(error: unknown): void } {
  let resolve!: (verdict: NativeListenVerdict) => void;
  const verdict = new Promise<NativeListenVerdict>((done) => {
    resolve = done;
  });
  resource.listens.push(verdict);

  let settled = false;
  function settle(result: NativeListenVerdict): void {
    if (settled) return;
    settled = true;
    server.removeListener('listening', onListening);
    server.removeListener('error', onError);
    resolve(result);
  }
  function onListening(): void {
    settle({ kind: 'listening' });
  }
  function onError(error: unknown): void {
    settle({ kind: 'error', error });
  }

  // Observe before caller callbacks, without replacing native handlers.
  server.prependOnceListener('listening', onListening);
  server.prependOnceListener('error', onError);

  return {
    syncNativeListenThrow(error: unknown): void {
      settle({ kind: 'error', error });
    },
  };
}

vi.mock('../../loader/src/http.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../loader/src/http.js')>();

  return {
    ...actual,
    createLoaderHttp: (options: Parameters<typeof actual.createLoaderHttp>[0]) => {
      const owner = ownership.owners.get(options.state);
      if (!owner || owner.admissionClosed || owner.lifetime.isClosed()) {
        throw ownershipError(
          'Loader HTTP creation requires a registered, open owner',
        );
      }

      // Capture the real factory object and its native methods.
      const http = actual.createLoaderHttp(options);
      const nativeListen = http.server.listen;
      const nativeClose = http.close.bind(http);
      const resource: Resource = {
        http,
        listens: [],
        closeRequested: false,
        closed: false,
      };
      ownership.resources.get(options.state)!.push(resource);

      // Forward all overloads unchanged, including receiver and return value.
      http.server.listen = function (
        this: LoaderHttp['server'],
        ...args: unknown[]
      ) {
        if (this !== http.server) {
          throw ownershipError('Loader HTTP listen requires its owned server receiver');
        }
        if (
          owner.admissionClosed ||
          owner.lifetime.isClosed() ||
          resource.closeRequested
        ) {
          throw ownershipError('Loader HTTP listen admission is closed');
        }

        const reservation = reserveNativeListenVerdict(this, resource);
        try {
          return Reflect.apply(nativeListen, this, args);
        } catch (error) {
          reservation.syncNativeListenThrow(error);
          throw error;
        }
      } as LoaderHttp['server']['listen'];

      http.close = () => {
        // Seal synchronously, even though native close starts in a continuation.
        resource.closeRequested = true;
        if (!resource.nativeClosePromise) {
          const admitted = resource.listens.slice();
          resource.nativeClosePromise = Promise.all(admitted)
            .then(() => nativeClose())
            .then(() => {
              // The real close promise resolves only from its native callback.
              resource.closed = true;
            });
          // An app may abandon its shutdown promise.
          void resource.nativeClosePromise.catch(() => {});
        }
        return resource.nativeClosePromise;
      };
      return http;
    },
  };
});

/** Register once, before app.start(); a closed state cannot be reused. */
export function registerLoaderHttpOwner(
  state: object,
  lifetime: Lifetime,
): void {
  const existing = ownership.owners.get(state);
  if (existing) {
    if (
      existing.lifetime === lifetime &&
      !existing.admissionClosed &&
      !lifetime.isClosed()
    ) {
      return;
    }
    throw new Error('Loader HTTP owner is already registered or closed');
  }
  if (lifetime.isClosed()) {
    throw new Error('Cannot register a closed Loader HTTP owner');
  }
  ownership.owners.set(state, { lifetime, admissionClosed: false });
  ownership.resources.set(state, []);
}

/**
 * Seal factory/listen admission, then bound listen verdicts plus native close.
 * Timeout does not cancel closure or release pending resource ownership.
 */
export async function closeLoaderHttpOwned(
  state: object,
  timeoutMs: number,
): Promise<void> {
  const owner = ownership.owners.get(state);
  if (!owner) {
    throw new Error('Loader HTTP owner is not registered');
  }
  owner.admissionClosed = true;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new RangeError('timeoutMs must be between 0 and 2147483647');
  }

  const resources = ownership.resources.get(state)!;
  if (resources.length === 0) return;

  // Real timers remain independent of Vitest fake clocks.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `Loader HTTP native close exceeded ${timeoutMs}ms`,
      );
      error.name = 'LoaderHttpCloseTimeoutError';
      reject(error);
    }, timeoutMs);
  });

  try {
    const closing = Promise.all(resources.map(({ http }) => http.close()));
    await Promise.race([closing, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Resources whose final native close callback has not completed. */
export function ownedLoaderHttpCount(state: object): number {
  return (ownership.resources.get(state) ?? []).filter(
    (resource) => !resource.closed,
  ).length;
}
