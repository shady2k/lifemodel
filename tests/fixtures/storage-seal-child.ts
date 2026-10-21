/** Real module process: only IPC startup plumbing, no seal step hooks. */
import { readFile } from 'node:fs/promises';
import { createStorageModule } from '../../loader/src/storage-module-app.js';
import { createStorageAccess } from '../../loader/src/storage-access.js';
import { createKubernetesStorageIdentity } from '../../loader/src/storage-identity.js';
import { createCatalog } from '../../loader/src/storage-catalog.js';
import { createStorageObjects } from '../../loader/src/storage-objects.js';
import { createStorageObjectS3 } from '../../loader/src/storage-object-s3.js';
import { createStorageSeal } from '../../loader/src/storage-seal.js';
import { createRecordingLogger } from '../../loader/src/logger.js';

const configFile = process.argv[2];
if (!configFile) throw Error('seal child config required');
const config = JSON.parse(await readFile(configFile, 'utf8'));
const access = createStorageAccess({
  connectionString: config.connectionString,
  identity: createKubernetesStorageIdentity(config.identity),
});
const s3 = createStorageObjectS3({
  endpoint: config.endpoint,
  bucket: 'task-output',
  custody: { read: async () => config.credentials },
  timeoutMs: 10_000,
});
const objects = createStorageObjects({
  connectionString: config.connectionString,
  s3,
  timeoutMs: 10_000,
});
const seal = createStorageSeal({ connectionString: config.connectionString, s3, access });
const app = createStorageModule({
  bucket: 'task-output',
  access,
  objects,
  seal,
  catalog: createCatalog({ connectionString: config.connectionString }),
  custody: { read: async () => config.credentials },
  check: async () => ({ ok: true }),
  logger: createRecordingLogger([]),
  tls: { ...config.certificate, read: async () => config.certificate },
});
const ports: Record<string, number> = {};
for (const name of ['task', 'control', 'read'] as const) {
  await new Promise<void>((resolve) => app[name].server.listen(0, '127.0.0.1', resolve));
  const address = app[name].server.address();
  if (!address || typeof address === 'string') throw Error('child listener failed');
  ports[name] = address.port;
}
process.send?.({ ready: ports });
