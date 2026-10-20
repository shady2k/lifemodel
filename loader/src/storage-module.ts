/** Separate process entry point: the platform storage module, built into the loader image. */
import { createRoleBaoClient } from './model-bao.js';
import { createStdoutLogger } from './logger.js';
import {
  createCachedCustodyReader,
  readCustodyRecord,
  STORAGE_BUCKET,
  type StorageS3Credentials,
} from './storage-custody.js';
import { checkS3Bucket } from './storage-s3.js';
import { createStorageModule } from './storage-module-app.js';

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
if (bucket !== STORAGE_BUCKET) {
  // The custody identity's actions are scoped to the bucket this build owns.
  logger.error({ code: 'unexpected_bucket' }, 'Storage module cannot start');
  process.exit(1);
}

const bao = createRoleBaoClient({ address: baoAddress, role: 'storage-module', logger });
const custody = createCachedCustodyReader(() => readCustodyRecord(bao.call));
const app = createStorageModule({
  bucket,
  custody,
  check: (credentials: StorageS3Credentials, signal: AbortSignal) =>
    checkS3Bucket({ endpoint, bucket, credentials, signal }),
  logger,
});
app.status.listen(8081, '0.0.0.0');

function stop(): void {
  app.status.closeAllConnections();
  app.status.close();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
app.status.on('error', () => {
  logger.error({ code: 'listener_failed' }, 'Storage module listener failed');
  stop();
  process.exitCode = 1;
});
