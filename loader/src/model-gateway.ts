/** Separate process entry point, built into the platform loader image. */
import {
  createRoleBaoClient,
  createCachedSlotReader,
  createCachedCaptureReader,
} from './model-bao.js';
import { createExchangeCapture } from './model-exchange-capture.js';
import { createExchangeStore } from './model-exchange-store.js';
import { renderAttemptHeaders, type ModelSlot } from './model.js';
import { createModelGateway } from './model-gateway-app.js';
import { createStdoutLogger } from './logger.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogConnectionString } from './storage-catalog.js';
import { createTaskKubernetesIdentity } from './task-kubernetes-identity.js';
import { createTaskIdentity } from './task-identity.js';
import { createTaskModelGateway } from './task-model-gateway.js';

const logger = createStdoutLogger((line) => process.stdout.write(`${line}\n`));
const address = process.env['LIFEMODEL_OPENBAO_ADDRESS'];
if (!address) {
  logger.error({ code: 'missing_bao_address' }, 'Model gateway cannot start');
  process.exit(1);
}
const bao = createRoleBaoClient({ address, role: 'model-gateway', logger });
const slots = createCachedSlotReader(bao.readSlot);
const captureSetting = createCachedCaptureReader(bao.readCapture);
let captureSecrets:
  | { values: string[]; headers: string[]; slots: ModelSlot[]; refreshed: number }
  | undefined;
const captureCredentials = async () => {
  const [username, password] = await Promise.all([
    readFile(
      process.env['LIFEMODEL_CAPTURE_DB_USERNAME_FILE'] ??
        '/opt/lifemodel/capture-database/username',
      'utf8'
    ),
    readFile(
      process.env['LIFEMODEL_CAPTURE_DB_PASSWORD_FILE'] ??
        '/opt/lifemodel/capture-database/password',
      'utf8'
    ),
  ]);
  if (!username || !password) throw new Error('capture_credentials_unavailable');
  return { username, password };
};
const captureStore = createExchangeStore(async () => {
  const { username, password } = await captureCredentials();
  return catalogConnectionString(username, password);
});
let refreshingCapture = false;
async function refreshCapture(): Promise<void> {
  if (refreshingCapture) return;
  refreshingCapture = true;
  captureSecrets = undefined;
  try {
    await captureSetting.refresh();
    const configured = await Promise.all(
      ['primary', 'reserve'].map(async (name) => {
        const slot = await bao.readSlot(name as 'primary' | 'reserve');
        return slot.state === 'present' ? slot.slot : undefined;
      })
    );
    const [{ password }, identityPassword] = await Promise.all([
      captureCredentials(),
      readFile(
        process.env['LIFEMODEL_DB_PASSWORD_FILE'] ?? '/opt/lifemodel/database/password',
        'utf8'
      ),
    ]);
    const present = configured.filter((slot): slot is ModelSlot => slot !== undefined);
    captureSecrets = {
      values: [
        password,
        identityPassword,
        ...present.flatMap((slot) => [
          slot.key ?? '',
          ...(slot.headers ?? []).map((header) => header.value.split('{session}').join('')),
        ]),
      ],
      headers: present.flatMap((slot) => (slot.headers ?? []).map((header) => header.name)),
      slots: present,
      refreshed: Date.now(),
    };
  } catch {
    captureSecrets = undefined;
  } finally {
    refreshingCapture = false;
  }
}
const capture = createExchangeCapture({
  context: (input) =>
    captureSecrets && Date.now() - captureSecrets.refreshed < 60_000
      ? {
          setting: captureSetting.current(),
          secrets: [
            ...captureSecrets.values,
            ...captureSecrets.slots.flatMap((slot) =>
              Object.values(renderAttemptHeaders(slot, input.sessionId ?? '').headers)
            ),
          ],
          secretHeaders: captureSecrets.headers,
        }
      : undefined,
  write: (row) => captureStore.write(row),
});
void refreshCapture();
const captureRefresh = setInterval(() => {
  void refreshCapture();
}, 30_000);
captureRefresh.unref();
// Retention also runs while capture is off; unavailable storage is never a gateway failure.
let pruning = false;
const pruneCapture = () => {
  if (pruning) return;
  pruning = true;
  void captureStore
    .prune()
    .catch(() => undefined)
    .finally(() => {
      pruning = false;
    });
};
pruneCapture();
const capturePrune = setInterval(pruneCapture, 60_000);
capturePrune.unref();
const app = createModelGateway({
  slots: {
    ...slots,
    read: async (name) => {
      const value = await slots.read(name);
      if (
        captureSecrets &&
        value.state === 'present' &&
        !captureSecrets.slots.some((slot) => JSON.stringify(slot) === JSON.stringify(value.slot))
      ) {
        captureSecrets = undefined;
        void refreshCapture();
      }
      return value;
    },
  },
  logger,
  capture,
});
const tlsDirectory = process.env['LIFEMODEL_TASK_MODEL_TLS_DIR'] ?? '';
if (!tlsDirectory) {
  logger.error({ code: 'missing_task_tls' }, 'Model gateway cannot start');
  process.exit(1);
}
async function readCertificate() {
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
  logger.error({ code: 'certificate_unavailable' }, 'Model gateway cannot start');
  process.exit(1);
}
const identity = createTaskKubernetesIdentity();
const access = createTaskIdentity({
  identity,
  connectionString: async (signal) => {
    // Optional projected directory appears after C. Never wait for SQL in A,
    // and never cache an absent/old credential across a request or rotation.
    const [username, password] = await Promise.all([
      readFile(process.env['LIFEMODEL_DB_USERNAME_FILE'] ?? '/opt/lifemodel/database/username', {
        encoding: 'utf8',
        signal,
      }),
      readFile(process.env['LIFEMODEL_DB_PASSWORD_FILE'] ?? '/opt/lifemodel/database/password', {
        encoding: 'utf8',
        signal,
      }),
    ]);
    if (!username || !password) throw new Error('credentials_unavailable');
    return catalogConnectionString(username, password);
  },
});
const task = createTaskModelGateway({
  gateway: app,
  access,
  logger,
  tls: { ...certificate, read: readCertificate },
});
app.api.listen(8080, '0.0.0.0');
task.server.listen(8446, '0.0.0.0');
app.status.listen(8081, '0.0.0.0');
function stop(): void {
  clearInterval(captureRefresh);
  clearInterval(capturePrune);
  capture.close();
  void captureStore.close().catch(() => undefined);
  task.close();
  app.close();
  identity.close();
  void access.close().catch(() => {
    logger.error({ code: 'task_close_failed' }, 'Model gateway pool shutdown failed');
    process.exitCode = 1;
  });
  app.api.closeAllConnections();
  app.status.closeAllConnections();
  app.api.close();
  app.status.close();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
for (const server of [app.api, app.status, task.server])
  server.on('error', () => {
    logger.error({ code: 'listener_failed' }, 'Model gateway listener failed');
    stop();
    process.exitCode = 1;
  });
