/**
 * Vitest-only ownership adapter.
 * Consumer wiring and lifecycle proofs are separate work.
 */
import { afterAll } from 'vitest';

import type { LoaderApp } from '../../loader/src/app.js';
import type { Supervisor } from '../../loader/src/supervisor.js';
import type { AgentVault } from '../../loader/src/agent-vault.js';
import {
  closeLoaderHttpOwned,
  registerLoaderHttpOwner,
} from './loader-http-ownership.js';
import {
  disposeLoaderWorlds,
  observeLoaderStop,
  registerLoaderBeginStop,
  registerLoaderCleanup,
  type LoaderAppRegistrar,
  type LoaderWorld,
} from './loader-doubles.js';

export {
  cleanupWorld,
  disposeLoaderWorlds,
  ownedLoaderRoots,
  registerLoaderCleanup,
  registerLoaderRelease,
} from './loader-doubles.js';

type InstallHook = (cleanup: () => Promise<void>) => void;

/**
 * Call once per suite. The installer registers cleanup; it must not execute it.
 * With LIFO hooks, register an independent post-cleanup assertion first.
 */
export function registerLoaderLifecycle(
  installHook: InstallHook = (cleanup) => { afterAll(cleanup, 15_000); },
  realBoundMs = 5_000
): void {
  installHook(() => disposeLoaderWorlds(realBoundMs));
}

// Ownership is keyed by each app's state, never a global current world.
const ownedApps = new WeakMap<object, LoaderWorld>();

/** Register before app.start(), including starts expected to fail. */
export function ownLoaderApp(
  world: LoaderWorld,
  app: LoaderApp,
  realBoundMs = 5_000
): LoaderApp {
  const existing = ownedApps.get(app.state);
  if (existing !== undefined) {
    if (existing !== world) throw new Error('Loader app ownership mismatch');
    registerLoaderHttpOwner(app.state, world.fixtureLifetime);
    return app;
  }

  registerLoaderHttpOwner(app.state, world.fixtureLifetime);
  registerLoaderBeginStop(world, () => {
    // shutdown sets its stop latch synchronously. Its remaining virtual
    // continuation is diagnostic only, not native settlement evidence.
    observeLoaderStop(world, app.shutdown('fixture cleanup'));
  });
  registerLoaderCleanup(
    world,
    () => closeLoaderHttpOwned(app.state, realBoundMs)
  );
  ownedApps.set(app.state, world);
  return app;
}

/**
 * A void-returning callback suitable for createRunningLoader's injection.
 * Do not pass ownLoaderApp directly: it deliberately returns the app.
 */
export function loaderAppRegistrar(realBoundMs = 5_000): LoaderAppRegistrar {
  return (world, app): void => {
    ownLoaderApp(world, app, realBoundMs);
  };
}

export function ownSupervisor(
  world: LoaderWorld,
  supervisor: Supervisor
): Supervisor {
  registerLoaderBeginStop(world, () => {
    supervisor.close();
    observeLoaderStop(world, supervisor.stop('fixture cleanup'));
  });
  return supervisor;
}

export function ownAgentVault(
  world: LoaderWorld,
  vault: AgentVault
): AgentVault {
  registerLoaderBeginStop(world, () => {
    observeLoaderStop(world, vault.stop());
  });
  return vault;
}
