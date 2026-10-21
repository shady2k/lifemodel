/** Separate process entry point: the platform storage module, built into the loader image. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRoleBaoClient } from './model-bao.js';
import { createStdoutLogger } from './logger.js';
import { catalogConnectionString, createCatalog } from './storage-catalog.js';
import {
  createCachedCustodyReader,
  readCustodyRecord,
  STORAGE_BUCKET,
  type StorageS3Credentials,
} from './storage-custody.js';
import { checkS3Bucket } from './storage-s3.js';
import { createStorageModule } from './storage-module-app.js';
import { createStorageAccess } from './storage-access.js';
import { createKubernetesStorageIdentity } from './storage-identity.js';
import { createStorageObjects } from './storage-objects.js';
import { createStorageObjectS3 } from './storage-object-s3.js';
import { createStorageSeal } from './storage-seal.js';

/** Four listeners: health, task data, trusted core control, trusted core/web read. */
const STATUS_PORT = 8081;
const TASK_PORT = 8443;
const CONTROL_PORT = 8444;
const READ_PORT = 8445;

const logger = createStdoutLogger((line) => process.stdout.write(`${line}\n`));

/** Missing configuration is a startup failure, never a silent default. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    logger.error({ code: 'missing_config', name }, 'Storage module cannot start');
    process.exit(1);
  }
  return value;
}

const baoAddress = required('LIFEMODEL_OPENBAO_ADDRESS');
const endpoint = required('LIFEMODEL_STORAGE_S3_ENDPOINT');
const bucket = required('LIFEMODEL_STORAGE_BUCKET');
// The interim login the owner chose for this module (lifemodel-653.7.8): the
// database owner's own, until lifemodel-2t5 leases it an identity.
const databaseUsername = required('LIFEMODEL_DB_USERNAME');
const databasePassword = required('LIFEMODEL_DB_PASSWORD');
const tlsDirectory = required('LIFEMODEL_STORAGE_TLS_DIR');
if (bucket !== STORAGE_BUCKET) {
  // The custody identity's actions are scoped to the bucket this build owns.
  logger.error({ code: 'unexpected_bucket' }, 'Storage module cannot start');
  process.exit(1);
}

/** The mounted leaf: `tls.crt` and `tls.key` of the Secret the loader writes. */
async function readCertificate(): Promise<{ cert: string; key: string }> {
  const [cert, key] = await Promise.all([
    readFile(join(tlsDirectory, 'tls.crt'), 'utf8'),
    readFile(join(tlsDirectory, 'tls.key'), 'utf8'),
  ]);
  return { cert, key };
}

let certificate: { cert: string; key: string };
try {
  certificate = await readCertificate();
} catch {
  // Never the path and never the file's content: the code says what to repair.
  logger.error({ code: 'certificate_unavailable' }, 'Storage module cannot start');
  process.exit(1);
}

const bao = createRoleBaoClient({ address: baoAddress, role: 'storage-module', logger });
const custody = createCachedCustodyReader(() => readCustodyRecord(bao.call));
const catalog = createCatalog({
  connectionString: catalogConnectionString(databaseUsername, databasePassword),
});
const objectS3 = createStorageObjectS3({ endpoint, bucket, custody });
const objects = createStorageObjects({
  connectionString: catalogConnectionString(databaseUsername, databasePassword),
  s3: objectS3,
});
const access = createStorageAccess({
  connectionString: catalogConnectionString(databaseUsername, databasePassword),
  identity: createKubernetesStorageIdentity(),
});
const seal = createStorageSeal({
  connectionString: catalogConnectionString(databaseUsername, databasePassword),
  s3: objectS3,
  access,
});
const app = createStorageModule({
  seal,
  objects,
  bucket,
  catalog,
  access,
  custody,
  check: (credentials: StorageS3Credentials, signal: AbortSignal) =>
    checkS3Bucket({ endpoint, bucket, credentials, signal }),
  logger,
  tls: { ...certificate, read: readCertificate },
});
app.status.listen(STATUS_PORT, '0.0.0.0');
app.task.server.listen(TASK_PORT, '0.0.0.0');
app.control.server.listen(CONTROL_PORT, '0.0.0.0');
app.read.server.listen(READ_PORT, '0.0.0.0');

let stopped = false;
function stop(): void {
  if (stopped) return;
  stopped = true;
  app.task.close();
  objectS3.close();
  void objects.close();
  void seal.close();
  app.control.close();
  app.read.close();
  app.status.closeAllConnections();
  app.status.close();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
app.status.on('error', () => {
  logger.error({ code: 'listener_failed' }, 'Storage module status listener failed');
  stop();
  process.exitCode = 1;
});
for (const listener of [app.task, app.control, app.read])
  listener.server.on('error', () => {
    logger.error({ code: 'listener_failed' }, 'Storage module TLS listener failed');
    stop();
    process.exitCode = 1;
  });
