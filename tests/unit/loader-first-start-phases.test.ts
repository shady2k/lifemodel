/**
 * The loader's first-start phase order (ADR-010 R7-02, ADR-015 S-D1).
 *
 * Platform A creates SeaweedFS; storage-module is in D, after the stores in
 * B/C. Its authenticated readiness needs Seaweed custody and the SQL schema.
 * The Postgres credential phase copies a Secret created in C. Custody runs
 * first because it needs only the OpenBao handoff and A's identity Secret,
 * not those later stores. This test protects that first-start order; it does
 * not assert that A waits for storage-module readiness.
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
      zotCustody: { name: 'zot-custody', run: async () => {} },
    }).map((phase) => phase.name);
    expect(names.slice(0, 3)).toEqual(['storage-seaweed-custody', 'zot-custody', 'gitea-ready']);
    expect(names).not.toContain('workbench-import');
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
      // Model a later platform-C Secret that has not arrived. Custody must
      // still complete first; storage-module readiness is checked only in D.
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
        zotCustody: { name: 'zot-custody', run: async () => {} },
        postgres,
        valkey: { name: 'valkey-password', run: async () => {} },
      });
      await expect(createPlatformPhaseRunner(store)(plan)).rejects.toThrow(
        /CNPG application Secret read failed/
      );
      // Custody completed before the wait that cannot finish on a fresh install.
      expect(finished).toEqual([
        'custody-effect',
        'storage-seaweed-custody',
        'zot-custody',
        'gitea-ready',
      ]);
      expect(record).toEqual({ phase: 'cnpg-copy-core-credentials', status: 'failed' });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
