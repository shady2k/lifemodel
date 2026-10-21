/**
 * The loader's instance CA and its storage-module leaf, for tests that need a
 * server certificate the module would be given (ADR-012 Decision 3, ADR-015
 * S-D1). It writes a throwaway CA under a temporary volume root and issues the
 * same second leaf the loader issues: in-cluster names, same CA.
 */
import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestClock } from '../../loader/src/clock.js';
import { loadConfig } from '../../loader/src/config.js';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { createPkiManager, STORAGE_MODULE_TLS_HOSTS } from '../../loader/src/pki.js';

export interface TestStorageCertificate {
  /** The instance CA, PEM: what a trusting client verifies against. */
  ca: string;
  /** The module's leaf and key, PEM. */
  cert: string;
  key: string;
  /** Issue a replacement leaf from the same CA (a renewal). */
  reissue(): Promise<{ cert: string; key: string }>;
  cleanup(): void;
}

export async function createStorageCertificate(
  hosts: readonly string[] = STORAGE_MODULE_TLS_HOSTS
): Promise<TestStorageCertificate> {
  const root = mkdtempSync(join(tmpdir(), 'lifemodel-storage-cert-'));
  let service: { ca?: string; cert?: string; key?: string } = {};
  const manager = createPkiManager({
    config: { ...loadConfig({ LIFEMODEL_NAME: 'home', LIFEMODEL_VOLUME_ROOT: root }) },
    fs: createNodeFileSystem(),
    // Anchored to the real date: the client verifying this leaf uses the
    // system clock, so a fixture dated in the past would already be expired.
    clock: createTestClock(Date.now()),
    secret: { read: async () => ({}), write: async () => undefined },
    configMap: { read: async () => null, write: async () => undefined },
    service: {
      hosts,
      secret: {
        read: async () => service,
        write: async (ca, cert, key) => {
          service = { ca, cert, key };
        },
      },
    },
  });
  await manager.bootstrap();
  if (!service.cert || !service.key || !service.ca)
    throw new Error('the test fixture issued no storage-module certificate');
  return {
    ca: service.ca,
    cert: service.cert,
    key: service.key,
    reissue: async () => {
      service = service.ca === undefined ? {} : { ca: service.ca };
      await manager.bootstrap();
      if (!service.cert || !service.key) throw new Error('the test fixture issued no leaf');
      return { cert: service.cert, key: service.key };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
