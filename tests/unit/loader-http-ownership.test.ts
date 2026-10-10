// Import ownership capture before the factory. Do not add another HTTP mock.
import {
  closeLoaderHttpOwned,
  ownedLoaderHttpCount,
  registerLoaderHttpOwner,
} from '../helpers/loader-http-ownership.js';

import dns from 'node:dns';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, type LoaderConfig } from '../../loader/src/config.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createLoaderHttp } from '../../loader/src/http.js';
import { createLoaderState } from '../../loader/src/state.js';
import { FixtureLifetime } from '../helpers/loader-fixture-lifetime.js';

type Options = Parameters<typeof createLoaderHttp>[0];
type Http = ReturnType<typeof createLoaderHttp>;
type ListenResult =
  | { kind: 'listening' }
  | { kind: 'error'; error: unknown };

const BOUND_MS = 2_000;

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            'Native server operation did not settle; retain resource and root.',
          )),
          BOUND_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function unused(): never {
  throw new Error('Unused route dependency was called');
}

const supervisor: Options['supervisor'] = {
  start: unused,
  close: unused,
  stop: unused,
  status: unused,
};

const bootstrap: Options['bootstrap'] = {
  ensureReady: unused,
  status: unused,
};

const logger: Options['logger'] = {
  info: unused,
  warn: unused,
  error: unused,
};

const clock: Options['clock'] = {
  now: unused,
  sleep: unused,
};

interface NativeResource {
  http: Pick<Http, 'server'>;
  actualListenResult?: Promise<ListenResult>;
  listeningOccurred: boolean;
  closeEvents: number;
  nativeClosed: Promise<void>;
  nativeCloseResult?: Promise<void>;
}

interface OwnedFixture {
  root: string;
  lifetime?: FixtureLifetime;
  options?: Options;
  registered: boolean;
  resources: Set<NativeResource>;
}

type ConstructedFixture = OwnedFixture & {
  lifetime: FixtureLifetime;
  options: Options;
};

const fixtures = new Set<OwnedFixture>();

async function rootOwnedOptions(): Promise<ConstructedFixture> {
  const root = await mkdtemp(join(tmpdir(), 'loader-http-proof-'));
  const fixture: OwnedFixture = {
    root,
    registered: false,
    resources: new Set(),
  };
  fixtures.add(fixture);

  const lifetime = new FixtureLifetime();
  fixture.lifetime = lifetime;

  // Explicitly owned root; no untracked temporary LoaderWorld is created.
  const config: LoaderConfig = {
    ...loadConfig({
      LIFEMODEL_VOLUME_ROOT: root,
      LIFEMODEL_SEED_BUNDLE: join(root, 'seed.bundle'),
      LIFEMODEL_UPSTREAM: 'https://example.invalid/lifemodel.git',
      LIFEMODEL_HTTP_PORT: '0',
      LIFEMODEL_CADDY_BINARY: join(root, 'caddy'),
      LIFEMODEL_CADDY_CONFIG: join(root, 'Caddyfile'),
      LIFEMODEL_AGENT_VAULT_BINARY: join(root, 'agent-vault'),
      LIFEMODEL_AGENT_VAULT_STORE: join(root, 'vault'),
      LIFEMODEL_AGENT_VAULT_CA: join(root, 'vault-ca.pem'),
      LIFEMODEL_EGRESS_IPTABLES: join(root, 'iptables'),
      LIFEMODEL_EGRESS_IP6TABLES: join(root, 'ip6tables'),
      LIFEMODEL_EGRESS_IF_INET6: join(root, 'if-inet6'),
    }),
    privileged: false,
    httpPort: 0,
  };
  const state: Options['state'] = createLoaderState({
    fs: lifetime.wrapFs(createNodeFileSystem()),
    config,
    logger,
  });
  const options: Options = { state, supervisor, bootstrap, logger, clock };

  return Object.assign(fixture, { lifetime, options });
}

function register(fixture: ConstructedFixture): void {
  registerLoaderHttpOwner(fixture.options.state, fixture.lifetime);
  fixture.registered = true;
}

function capture(
  fixture: OwnedFixture,
  http: Pick<Http, 'server'>,
): NativeResource {
  let closed!: () => void;
  const nativeClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const resource: NativeResource = {
    http,
    listeningOccurred: false,
    closeEvents: 0,
    nativeClosed,
  };
  http.server.on('close', () => {
    resource.closeEvents += 1;
    closed();
  });
  fixture.resources.add(resource);
  return resource;
}

function startNativeListen(
  resource: NativeResource,
  hostname = '127.0.0.1',
): Promise<ListenResult> {
  if (resource.actualListenResult !== undefined) {
    return resource.actualListenResult;
  }

  const { server } = resource.http;
  resource.actualListenResult = new Promise<ListenResult>((resolve) => {
    const finish = (result: ListenResult): void => {
      server.off('listening', onListening);
      server.off('error', onError);
      resolve(result);
    };
    const onListening = (): void => {
      resource.listeningOccurred = true;
      finish({ kind: 'listening' });
    };
    const onError = (error: Error): void => {
      finish({ kind: 'error', error });
    };

    server.once('listening', onListening);
    server.once('error', onError);
    try {
      server.listen(0, hostname);
    } catch (error) {
      finish({ kind: 'error', error });
    }
  });
  return resource.actualListenResult;
}

/**
 * A deadline does not settle or cancel listen. Keep its promise and listeners
 * until its actual result arrives. Never close ahead of a pending listen.
 */
async function settleAndCloseNative(resource: NativeResource): Promise<void> {
  if (resource.actualListenResult !== undefined) {
    await bounded(resource.actualListenResult);
  }

  if (resource.closeEvents > 0 && !resource.http.server.listening) return;

  if (resource.nativeCloseResult === undefined) {
    resource.nativeCloseResult = new Promise<void>((resolve, reject) => {
      const { server } = resource.http;
      try {
        server.closeAllConnections();
        server.close((error?: Error) => {
          if (error !== undefined) {
            // A settled failed/absent listen owns no listening handle.
            if (
              !resource.listeningOccurred &&
              !server.listening &&
              'code' in error &&
              error.code === 'ERR_SERVER_NOT_RUNNING'
            ) {
              resolve();
            } else {
              reject(error);
            }
          } else {
            resolve();
          }
        });
      } catch (error) {
        reject(error);
      }
    });
    void resource.nativeCloseResult.catch(() => {});
  }

  await bounded(resource.nativeCloseResult);
  if (resource.listeningOccurred) await bounded(resource.nativeClosed);
  if (resource.http.server.listening) {
    throw new Error('Native server remains listening; retain resource and root.');
  }
}

afterEach(async () => {
  const failures: unknown[] = [];
  const fenceFailures = new Map<OwnedFixture, unknown>();

  for (const fixture of fixtures) {
    try {
      fixture.lifetime?.closeAdmission();
    } catch (error) {
      fenceFailures.set(fixture, error);
    }
  }

  for (const fixture of fixtures) {
    const entryFailures: unknown[] = [];
    if (fenceFailures.has(fixture)) {
      entryFailures.push(fenceFailures.get(fixture));
    }

    for (const resource of fixture.resources) {
      try {
        await settleAndCloseNative(resource);
        fixture.resources.delete(resource);
      } catch (error) {
        entryFailures.push(error);
      }
    }

    // Do not invoke the helper's close while any listen remains unresolved.
    if (fixture.resources.size === 0) {
      try {
        if (fixture.registered) {
          if (fixture.options === undefined) {
            throw new Error('Registered HTTP owner has no stored options.');
          }
          await bounded(closeLoaderHttpOwned(
            fixture.options.state,
            BOUND_MS,
          ));
        }
      } catch (error) {
        entryFailures.push(error);
      }
    }

    // Drain admitted I/O even when another resource failed cleanup.
    try {
      if (fixture.lifetime !== undefined) {
        await bounded(fixture.lifetime.drainNativeIo(BOUND_MS));
        if (fixture.lifetime.admittedCount() !== 0) {
          throw new Error(
            'Retain fixture ownership and root: I/O remains tracked.',
          );
        }
      }
    } catch (error) {
      entryFailures.push(error);
    }

    if (entryFailures.length === 0 && fixture.resources.size === 0) {
      try {
        await rm(fixture.root, { recursive: true, force: true });
        fixtures.delete(fixture);
      } catch (error) {
        entryFailures.push(error);
      }
    }

    if (entryFailures.length !== 0) {
      failures.push(new AggregateError(
        entryFailures,
        `Cleanup failed; retained fixture ${fixture.root}`,
      ));
    }
  }

  if (failures.length !== 0) {
    throw new AggregateError(failures, 'HTTP fixture cleanup failed');
  }
});

// Factory capture and native close only; no app lifecycle wiring.
describe('Loader HTTP ownership standalone proof', () => {
  it('captures a real listening server and awaits its native close', async () => {
    const fixture = await rootOwnedOptions();
    const { state } = fixture.options;
    register(fixture);
    const http = createLoaderHttp(fixture.options);
    const resource = capture(fixture, http);

    try {
      expect(ownedLoaderHttpCount(state)).toBe(1);
      const result = await bounded(startNativeListen(resource));
      if (result.kind === 'error') throw result.error;

      expect(http.server.listening).toBe(true);
      expect(http.server.address()).toMatchObject({
        address: '127.0.0.1',
      });

      const closing = closeLoaderHttpOwned(state, BOUND_MS);
      void closing.catch(() => {});

      // Native close is delegated in a later microtask.
      expect(ownedLoaderHttpCount(state)).toBe(1);

      const cachedClose = http.close();
      void cachedClose.catch(() => {});
      expect(http.close()).toBe(cachedClose);

      await bounded(closing);
      await bounded(resource.nativeClosed);
      expect(resource.closeEvents).toBe(1);
      expect(http.server.listening).toBe(false);
      expect(ownedLoaderHttpCount(state)).toBe(0);

      await bounded(closeLoaderHttpOwned(state, BOUND_MS));
      expect(http.close()).toBe(cachedClose);
      expect(resource.closeEvents).toBe(1);
      expect(ownedLoaderHttpCount(state)).toBe(0);

      expect(() => createLoaderHttp(fixture.options)).toThrow(
        'Loader HTTP creation requires a registered, open owner',
      );
    } finally {
      fixture.lifetime.closeAdmission();
    }
  }, 10_000);

  it('retains an admitted native listen until lookup and native close settle', async () => {
    const fixture = await rootOwnedOptions();
    const { state } = fixture.options;
    register(fixture);
    const http = createLoaderHttp(fixture.options);
    const resource = capture(fixture, http);
    const foreign = capture(fixture, { server: createServer() });
    const hostname = 'fixture.loopback.invalid';

    let entered!: () => void;
    const lookupEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let releaseLookup = (): void => {};

    const originalLookup = dns.lookup;
    const lookupSpy = vi.spyOn(dns, 'lookup');
    lookupSpy.mockImplementation((function (
      this: typeof dns,
      ...args: unknown[]
    ) {
      if (args[0] !== hostname) {
        return Reflect.apply(originalLookup, this, args);
      }

      const callback = args[args.length - 1] as (
        error: Error | null,
        address: string,
        family: number,
      ) => void;
      let released = false;
      releaseLookup = (): void => {
        if (released) return;
        released = true;
        callback(null, '127.0.0.1', 4);
      };
      entered();
    }) as unknown as typeof dns.lookup);

    try {
      expect(() => Reflect.apply(
        http.server.listen,
        foreign.http.server,
        [0, hostname],
      )).toThrow('Loader HTTP listen requires its owned server receiver');
      expect(foreign.http.server.listening).toBe(false);
      expect(foreign.listeningOccurred).toBe(false);
      expect(ownedLoaderHttpCount(state)).toBe(1);

      // Record the actual verdict before the first wait. The lookup hook
      // registers its idempotent release before signalling entry.
      const actualListenResult = startNativeListen(resource, hostname);
      await bounded(lookupEntered);

      expect(resource.listeningOccurred).toBe(false);
      expect(http.server.listening).toBe(false);
      expect(resource.closeEvents).toBe(0);
      expect(ownedLoaderHttpCount(state)).toBe(1);

      const closing = closeLoaderHttpOwned(state, 0);
      void closing.catch(() => {});
      await expect(bounded(closing)).rejects.toMatchObject({
        name: 'LoaderHttpCloseTimeoutError',
        message: 'Loader HTTP native close exceeded 0ms',
      });

      expect(ownedLoaderHttpCount(state)).toBe(1);
      expect(resource.listeningOccurred).toBe(false);
      expect(resource.closeEvents).toBe(0);

      releaseLookup();
      const result = await bounded(actualListenResult);
      if (result.kind === 'error') throw result.error;
      expect(resource.listeningOccurred).toBe(true);

      const fullClose = closeLoaderHttpOwned(state, BOUND_MS);
      void fullClose.catch(() => {});
      await bounded(fullClose);
      await bounded(resource.nativeClosed);

      expect(resource.closeEvents).toBe(1);
      expect(http.server.listening).toBe(false);
      expect(ownedLoaderHttpCount(state)).toBe(0);
    } finally {
      // Release synchronously before awaiting any cleanup. A failed bound
      // leaves the registry, root, and interception retained for diagnosis.
      releaseLookup();
      fixture.lifetime.closeAdmission();
      if (resource.actualListenResult !== undefined) {
        await bounded(resource.actualListenResult);
      }
      await bounded(closeLoaderHttpOwned(state, BOUND_MS));
      for (const recorded of fixture.resources) {
        await settleAndCloseNative(recorded);
      }
      lookupSpy.mockRestore();
    }
  }, 10_000);

  it('refuses unowned and closed owners before returning a server to listen', async () => {
    function refused(fixture: ConstructedFixture): void {
      let returned: Http | undefined;
      try {
        expect(() => {
          returned = createLoaderHttp(fixture.options);
          // Capture synchronously even if the refusal assertion fails.
          capture(fixture, returned);
        }).toThrow('Loader HTTP creation requires a registered, open owner');
        expect(returned).toBeUndefined();
        expect(ownedLoaderHttpCount(fixture.options.state)).toBe(0);
      } finally {
        fixture.lifetime.closeAdmission();
      }
    }

    const unowned = await rootOwnedOptions();
    refused(unowned);

    const lifetimeClosed = await rootOwnedOptions();
    register(lifetimeClosed);
    lifetimeClosed.lifetime.closeAdmission();
    refused(lifetimeClosed);

    const sealed = await rootOwnedOptions();
    register(sealed);
    try {
      await bounded(closeLoaderHttpOwned(sealed.options.state, BOUND_MS));
      refused(sealed);

      await bounded(closeLoaderHttpOwned(sealed.options.state, BOUND_MS));
      expect(ownedLoaderHttpCount(sealed.options.state)).toBe(0);
    } finally {
      sealed.lifetime.closeAdmission();
    }
  }, 10_000);
});
