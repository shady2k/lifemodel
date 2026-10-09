/**
 * Where the loader is and what it drives (lifemodel-q4x.2.1).
 *
 * The defaults are the contract with the image: one volume at
 * /var/lib/lifemodel, the seed bundle the image carries at
 * /opt/lifemodel/seed.bundle, the loader's own port 7000 on loopback. Every
 * one of them is overridable through the environment so a test (or a person)
 * can place the same program elsewhere.
 */
import { join } from 'node:path';

import { LoaderFatalError } from './errors.js';

/** The unprivileged identity lifemodel runs as in the image. */
export interface LifemodelIdentity {
  uid: number;
  gid: number;
}

/** How long the loader waits between two starts of a lifemodel that keeps dying. */
export interface RestartPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  /** A run at least this long counts as healthy: the delay goes back to the start. */
  healthyRunMs: number;
}

export interface CaddyConfig {
  /** The Caddy binary the image carries. */
  binary: string;
  /** Its configuration: host routing and the forward_auth to the loader. */
  config: string;
  /** How long Caddy may take to leave before it is killed. */
  stopWaitMs: number;
}

/**
 * Agent Vault (lifemodel-q4x.3.1, decisions 4 and 12): the trusted layer that
 * holds the keys, started by the loader beside Caddy and stopped after
 * lifemodel.
 */
export interface AgentVaultConfig {
  /** The Agent Vault binary the image carries, pinned by version at build time. */
  binary: string;
  /**
   * The store: Agent Vault's `HOME`, so its database, its CA and the CLI's own
   * session land in `<storeDir>/.agent-vault/`. Root-only (0700): decision 4
   * protects a passwordless store by the directory's permissions.
   */
  storeDir: string;
  /** The transparent proxy's root CA, written where lifemodel can READ it. */
  caPath: string;
  /** Its management interface and API, behind `vault.<host>`. */
  apiPort: number;
  /** The transparent proxy lifemodel's traffic leaves through. */
  proxyPort: number;
  /** The vault the loader creates for lifemodel. */
  vaultName: string;
  /** The agent the loader creates in it; its token is lifemodel's proxy credential. */
  agentName: string;
  /** The instance owner account the loader registers; its password stays root-only. */
  ownerEmail: string;
  /** How long Agent Vault may take to answer `/health` before the loader gives up. */
  startWaitMs: number;
  /** How long Agent Vault may take to leave before it is killed. */
  stopWaitMs: number;
}

/**
 * The kernel rule that confines lifemodel's egress (lifemodel-q4x.3.2, story
 * S5): uid 1000 reaches loopback and nothing else, installed by the loader
 * before lifemodel starts. The chain is the loader's own, so a start replaces
 * what an earlier one left instead of stacking on it.
 */
export interface EgressConfig {
  /** The iptables the image carries; a container without it is a missing input. */
  binary: string;
  /** The chain the loader owns and fills with the one rule. */
  chain: string;
  /**
   * The container's embedded resolver (Docker answers names at 127.0.0.11):
   * the DNS port of it is one of the loopback services uid 1000 may still
   * reach. Empty switches the resolver's two rules off - a container without
   * its own resolver resolves nothing locally at all.
   */
  resolver: string;
}

export interface LoaderConfig {
  /** The volume: everything the instance owns. */
  volumeRoot: string;
  /** The instance's git repository (owner lifemodel). */
  repoDir: string;
  /** lifemodel's DATA_PATH (owner lifemodel). */
  dataDir: string;
  /** The loader's own root-only directory (0700). */
  loaderDir: string;
  /** The `git bundle` of the code the image carries. */
  seedBundle: string;
  /** The upstream the instance merges from later. */
  upstreamUrl: string;
  /** The loader's own HTTP port, on loopback. */
  httpPort: number;
  /** The identity lifemodel (and its build) runs as. */
  lifemodel: LifemodelIdentity;
  /** The built entry point inside the instance's repository. */
  lifemodelEntry: string;
  /** The front door the loader owns: Caddy, the only web entrance. */
  caddy: CaddyConfig;
  /** Agent Vault: the keys, the proxy and the vault lifemodel uses. */
  agentVault: AgentVaultConfig;
  /** The rule that confines lifemodel's egress to the proxy. */
  egress: EgressConfig;
  /** How long lifemodel's drain may take before the loader gives up on it. */
  drainWaitMs: number;
  /**
   * The room a stop keeps after SIGKILL for the kernel to reap a child (lifemodel
   * or Caddy); the drain gets what is left of the budget less this.
   */
  killWaitMs: number;
  /**
   * The whole stop, from the first SIGTERM to the last child gone: lifemodel's
   * drain and Caddy's exit share this one deadline, and the documented
   * `--stop-timeout 120` leaves room for it (rework 2, finding 10).
   */
  stopBudgetMs: number;
  /** A build (npm ci && npm run build) may take minutes; this is its ceiling. */
  buildTimeoutMs: number;
  restart: RestartPolicy;
  /** True when the loader runs as root and can therefore chown and setuid. */
  privileged: boolean;
}

const DEFAULTS = {
  volumeRoot: '/var/lib/lifemodel',
  seedBundle: '/opt/lifemodel/seed.bundle',
  upstreamUrl: 'https://github.com/shady2k/lifemodel.git',
  httpPort: 7000,
  uid: 1000,
  gid: 1000,
  caddyBinary: '/usr/bin/caddy',
  caddyConfig: '/etc/lifemodel/Caddyfile',
  caddyStopWaitMs: 10_000,
  agentVaultBinary: '/usr/local/bin/agent-vault',
  agentVaultStartWaitMs: 15_000,
  agentVaultStopWaitMs: 10_000,
  egressBinary: 'iptables',
  egressChain: 'LIFEMODEL_EGRESS',
  egressResolver: '127.0.0.11',
  agentVaultApiPort: 14_321,
  agentVaultProxyPort: 14_322,
  drainWaitMs: 95_000,
  killWaitMs: 5_000,
  stopBudgetMs: 110_000,
  buildTimeoutMs: 20 * 60_000,
  restart: { initialDelayMs: 1_000, maxDelayMs: 30_000, healthyRunMs: 60_000 },
} as const;

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new LoaderFatalError(`${name} must be a whole number, got "${raw}"`);
  }
  return value;
}

/** The loader's configuration, from the environment and the contract's defaults. */
export function loadConfig(env: NodeJS.ProcessEnv): LoaderConfig {
  const volumeRoot = env['LIFEMODEL_VOLUME_ROOT'] ?? DEFAULTS.volumeRoot;
  return {
    volumeRoot,
    repoDir: join(volumeRoot, 'repo'),
    dataDir: join(volumeRoot, 'data'),
    loaderDir: join(volumeRoot, 'loader'),
    seedBundle: env['LIFEMODEL_SEED_BUNDLE'] ?? DEFAULTS.seedBundle,
    upstreamUrl: env['LIFEMODEL_UPSTREAM'] ?? DEFAULTS.upstreamUrl,
    httpPort: readInt(env, 'LIFEMODEL_HTTP_PORT', DEFAULTS.httpPort),
    lifemodel: {
      uid: readInt(env, 'LIFEMODEL_UID', DEFAULTS.uid),
      gid: readInt(env, 'LIFEMODEL_GID', DEFAULTS.gid),
    },
    lifemodelEntry: join(volumeRoot, 'repo', 'dist', 'index.js'),
    caddy: {
      binary: env['LIFEMODEL_CADDY_BINARY'] ?? DEFAULTS.caddyBinary,
      config: env['LIFEMODEL_CADDY_CONFIG'] ?? DEFAULTS.caddyConfig,
      stopWaitMs: readInt(env, 'LIFEMODEL_CADDY_STOP_WAIT_MS', DEFAULTS.caddyStopWaitMs),
    },
    agentVault: {
      binary: env['LIFEMODEL_AGENT_VAULT_BINARY'] ?? DEFAULTS.agentVaultBinary,
      storeDir: env['LIFEMODEL_AGENT_VAULT_STORE'] ?? join(volumeRoot, 'vault'),
      caPath: env['LIFEMODEL_AGENT_VAULT_CA'] ?? join(volumeRoot, 'vault-ca.pem'),
      apiPort: readInt(env, 'LIFEMODEL_AGENT_VAULT_API_PORT', DEFAULTS.agentVaultApiPort),
      proxyPort: readInt(env, 'LIFEMODEL_AGENT_VAULT_PROXY_PORT', DEFAULTS.agentVaultProxyPort),
      vaultName: env['LIFEMODEL_AGENT_VAULT_NAME'] ?? 'lifemodel',
      agentName: env['LIFEMODEL_AGENT_AGENT_NAME'] ?? 'lifemodel',
      ownerEmail: env['LIFEMODEL_AGENT_VAULT_OWNER_EMAIL'] ?? 'owner@lifemodel.local',
      startWaitMs: readInt(
        env,
        'LIFEMODEL_AGENT_VAULT_START_WAIT_MS',
        DEFAULTS.agentVaultStartWaitMs
      ),
      stopWaitMs: readInt(env, 'LIFEMODEL_AGENT_VAULT_STOP_WAIT_MS', DEFAULTS.agentVaultStopWaitMs),
    },
    egress: {
      binary: env['LIFEMODEL_EGRESS_IPTABLES'] ?? DEFAULTS.egressBinary,
      chain: env['LIFEMODEL_EGRESS_CHAIN'] ?? DEFAULTS.egressChain,
      resolver: env['LIFEMODEL_EGRESS_RESOLVER'] ?? DEFAULTS.egressResolver,
    },
    drainWaitMs: readInt(env, 'LIFEMODEL_DRAIN_WAIT_MS', DEFAULTS.drainWaitMs),
    killWaitMs: readInt(env, 'LIFEMODEL_KILL_WAIT_MS', DEFAULTS.killWaitMs),
    stopBudgetMs: readInt(env, 'LIFEMODEL_STOP_BUDGET_MS', DEFAULTS.stopBudgetMs),
    buildTimeoutMs: readInt(env, 'LIFEMODEL_BUILD_TIMEOUT_MS', DEFAULTS.buildTimeoutMs),
    restart: DEFAULTS.restart,
    privileged: typeof process.getuid === 'function' && process.getuid() === 0,
  };
}
