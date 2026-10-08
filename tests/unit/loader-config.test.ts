/**
 * The numbers the image and the loader agree on (lifemodel-q4x.2.1).
 *
 * Two tasks build to one contract, so the contract is a test: the volume, the
 * seed bundle, the ports, the identity lifemodel runs as and the drain the
 * loader waits for.
 */
import { describe, expect, it } from 'vitest';

import { SESSION_COOKIE_NAME } from '../../loader/src/auth.js';
import { loadConfig } from '../../loader/src/config.js';

describe('the contract with the image', () => {
  it('has the volume, the ports, the identity and the drain the image is built to', () => {
    const config = loadConfig({});

    expect(config.volumeRoot).toBe('/var/lib/lifemodel');
    expect(config.repoDir).toBe('/var/lib/lifemodel/repo');
    expect(config.dataDir).toBe('/var/lib/lifemodel/data');
    expect(config.loaderDir).toBe('/var/lib/lifemodel/loader');
    expect(config.seedBundle).toBe('/opt/lifemodel/seed.bundle');
    expect(config.upstreamUrl).toBe('https://github.com/shady2k/lifemodel.git');
    expect(config.httpPort).toBe(7000);
    expect(config.lifemodel).toEqual({ uid: 1000, gid: 1000 });
    expect(config.lifemodelEntry).toBe('/var/lib/lifemodel/repo/dist/index.js');
    // lifemodel's own drain is 90 s; the whole stop - that drain and Caddy's
    // exit together - shares one deadline, inside the documented 120 s stop.
    expect(config.drainWaitMs).toBe(95_000);
    expect(config.stopBudgetMs).toBe(110_000);
    expect(config.stopBudgetMs).toBeGreaterThan(config.drainWaitMs);
    expect(config.caddy).toEqual({
      binary: '/usr/bin/caddy',
      config: '/etc/lifemodel/Caddyfile',
      stopWaitMs: 10_000,
    });
    // Agent Vault: the binary the image pins, the store and the CA on the
    // volume, the two loopback ports, and the vault and agent it makes for
    // lifemodel (lifemodel-q4x.3.1, decision 12).
    expect(config.agentVault).toEqual({
      binary: '/usr/local/bin/agent-vault',
      storeDir: '/var/lib/lifemodel/vault',
      caPath: '/var/lib/lifemodel/vault-ca.pem',
      apiPort: 14_321,
      proxyPort: 14_322,
      vaultName: 'lifemodel',
      agentName: 'lifemodel',
      ownerEmail: 'owner@lifemodel.local',
      startWaitMs: 15_000,
      stopWaitMs: 10_000,
    });
    // The rule that confines lifemodel's egress (lifemodel-q4x.3.2): the
    // binary the image carries and the loader's own chain in the filter table.
    expect(config.egress).toEqual({ binary: 'iptables', chain: 'LIFEMODEL_EGRESS' });
    expect(SESSION_COOKIE_NAME).toBe('lm_session');
    // A test is not root; the image's loader is, and that is what sets this.
    expect(config.privileged).toBe(false);
  });

  it('can be placed elsewhere through the environment, and refuses a nonsense number', () => {
    const moved = loadConfig({
      LIFEMODEL_VOLUME_ROOT: '/tmp/elsewhere',
      LIFEMODEL_SEED_BUNDLE: '/tmp/seed.bundle',
      LIFEMODEL_HTTP_PORT: '7100',
      LIFEMODEL_UID: '1234',
      LIFEMODEL_GID: '1235',
      LIFEMODEL_DRAIN_WAIT_MS: '5000',
      LIFEMODEL_STOP_BUDGET_MS: '6000',
    });

    expect(moved.volumeRoot).toBe('/tmp/elsewhere');
    expect(moved.repoDir).toBe('/tmp/elsewhere/repo');
    expect(moved.lifemodelEntry).toBe('/tmp/elsewhere/repo/dist/index.js');
    expect(moved.seedBundle).toBe('/tmp/seed.bundle');
    expect(moved.httpPort).toBe(7100);
    expect(moved.lifemodel).toEqual({ uid: 1234, gid: 1235 });
    expect(moved.drainWaitMs).toBe(5000);
    expect(moved.stopBudgetMs).toBe(6000);

    expect(() => loadConfig({ LIFEMODEL_HTTP_PORT: 'soon' })).toThrow(
      /LIFEMODEL_HTTP_PORT must be a whole number/
    );
  });
});
