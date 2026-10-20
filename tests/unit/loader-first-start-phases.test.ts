/**
 * The loader's first-start phase order (ADR-010 R7-02, ADR-015 S-D1).
 *
 * Platform A waits for the storage module to become ready, and the module is
 * ready only after Seaweed custody exists. The Postgres credential phase
 * copies a Secret that CloudNativePG creates in platform C, and C waits for
 * B, which waits for A. So custody has to finish before any phase that waits
 * on a later platform step, or a fresh installation deadlocks.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { platformFirstStartPhases } from '../../loader/src/app.js';
import { createKubernetesPostgresSecretPhase } from '../../loader/src/postgres.js';
import {
  createPlatformPhaseRunner,
  type PlatformPhaseRecord,
  type PlatformPhaseStore,
} from '../../loader/src/platform-bootstrap.js';

describe('the loader first-start phase order', () => {
  it('puts Seaweed custody first, before any phase that waits on platform B or C', () => {
    const names = platformFirstStartPhases({
      gitea: [{ name: 'gitea-ready', run: async () => {} }],
      storageCustody: { name: 'storage-seaweed-custody', run: async () => {} },
    }).map((phase) => phase.name);
    expect(names[0]).toBe('storage-seaweed-custody');
    // The two phases whose source Secret only exists once a later platform
    // step has run (lifemodel-state is platform C).
    for (const waiting of ['cnpg-copy-core-credentials', 'valkey-password'])
      expect(names.indexOf(waiting)).toBeGreaterThan(0);
  });

  it('finishes Seaweed custody on a fresh installation where the CNPG Secret never appears', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lifemodel-phase-order-'));
    try {
      const tokenFile = join(directory, 'token');
      writeFileSync(tokenFile, 'sa-token\n');
      const finished: string[] = [];
      let record: PlatformPhaseRecord | null = null;
      const store: PlatformPhaseStore = {
        read: async () => record,
        write: async (next) => {
          if (next.status === 'complete') finished.push(next.phase);
          record = next;
        },
      };
      // The platform-C Secret is absent for as long as platform A is not
      // ready, and platform A cannot be ready before custody exists.
      const postgres = createKubernetesPostgresSecretPhase({
        tokenFile,
        caFile: join(directory, 'absent-ca.crt'),
        request: async (url) =>
          url.pathname.endsWith('/secrets/lifemodel-app')
            ? { status: 404, body: '{"message":"not found"}' }
            : { status: 500, body: '{}' },
      });
      const plan = platformFirstStartPhases({
        gitea: [{ name: 'gitea-ready', run: async () => {} }],
        storageCustody: {
          name: 'storage-seaweed-custody',
          run: async () => {
            finished.push('custody-effect');
          },
        },
        postgres,
        valkey: { name: 'valkey-password', run: async () => {} },
      });
      await expect(createPlatformPhaseRunner(store)(plan)).rejects.toThrow(
        /CNPG application Secret read failed/
      );
      // Custody completed before the wait that cannot finish on a fresh install.
      expect(finished).toEqual(['custody-effect', 'storage-seaweed-custody', 'gitea-ready']);
      expect(record).toEqual({ phase: 'cnpg-copy-core-credentials', status: 'failed' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
