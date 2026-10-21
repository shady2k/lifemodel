/** No production clock or GC timers: IPC drives one bounded real retention tick. */
import { readFile, writeFile, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createStorageRetentionSettings } from '../../loader/src/storage-retention-settings.js';
import { createStorageModule } from '../../loader/src/storage-module-app.js';
import { createStorageAccess } from '../../loader/src/storage-access.js';
import { createKubernetesStorageIdentity } from '../../loader/src/storage-identity.js';
import { createCatalog } from '../../loader/src/storage-catalog.js';
import { createStorageObjects } from '../../loader/src/storage-objects.js';
import { createStorageUploadOwner } from '../../loader/src/storage-upload-owner.js';
import { createStorageObjectS3 } from '../../loader/src/storage-object-s3.js';
import { createStorageSeal } from '../../loader/src/storage-seal.js';
import { createStorageRetention } from '../../loader/src/storage-retention.js';
import { createRecordingLogger } from '../../loader/src/logger.js';

const configFile = process.argv[2];
if (!configFile) throw Error('retention child config required');
const config = JSON.parse(await readFile(configFile, 'utf8'));
let now = config.now as number;
let settings = config.settings as {
  retention: '90d' | 'forever';
  warningLeadDays: number;
  revision: number;
};
const logs: Parameters<typeof createRecordingLogger>[0] = [];
const logger = createRecordingLogger(logs);
const settingsPath = `${configFile}.settings`;
await writeFile(
  settingsPath,
  JSON.stringify({
    version: 1,
    revision: settings.revision,
    values: {
      'storage.retention': settings.retention,
      'storage.warningLeadDays': settings.warningLeadDays,
    },
  })
);
const settingsReader = createStorageRetentionSettings({ path: settingsPath, logger });
let ownerTime = 0;
const access = createStorageAccess({
  connectionString: config.connectionString,
  identity: createKubernetesStorageIdentity(config.identity),
});
const s3 = createStorageObjectS3({
  endpoint: config.endpoint,
  bucket: 'task-output',
  custody: { read: async () => config.credentials },
  logger,
  timeoutMs: 10_000,
});
const owner = createStorageUploadOwner({
  connectionString: config.connectionString,
  now: () => performance.now() + ownerTime,
});
await owner.ready();
const objects = createStorageObjects({
  connectionString: config.connectionString,
  s3,
  owner,
  timeoutMs: 10_000,
});
const retention = createStorageRetention({
  connectionString: config.connectionString,
  s3,
  owner,
  settings: settingsReader,
  now: () => now,
  logger,
});
const seal = createStorageSeal({
  connectionString: config.connectionString,
  s3,
  access,
  retention,
  logger,
  now: () => now,
});
const app = createStorageModule({
  bucket: 'task-output',
  access,
  objects,
  seal,
  retention,
  catalog: createCatalog({ connectionString: config.connectionString }),
  custody: { read: async () => config.credentials },
  check: async () => ({ ok: true }),
  health: { cacheMs: 0 },
  logger,
  tls: { ...config.certificate, read: async () => config.certificate },
});
const ports: Record<string, number> = {};
for (const name of ['task', 'control', 'read'] as const) {
  await new Promise<void>((resolve) => app[name].server.listen(0, '127.0.0.1', resolve));
  const address = app[name].server.address();
  if (!address || typeof address === 'string') throw Error('retention child listener failed');
  ports[name] = address.port;
}
process.on('message', (message: any) => {
  void (async () => {
    if (message.command === 'clock') {
      now = message.value.now;
      settings = message.value.settings;
      await writeFile(
        settingsPath,
        JSON.stringify({
          version: 1,
          revision: settings.revision,
          values: {
            'storage.retention': settings.retention,
            'storage.warningLeadDays': settings.warningLeadDays,
          },
        })
      );
    } else if (message.command === 'projection') {
      if (message.value === null) await rm(settingsPath, { force: true });
      else
        await writeFile(
          settingsPath,
          message.value === 'invalid'
            ? '{'
            : JSON.stringify({
                version: 1,
                revision: message.value.revision,
                values: {
                  'storage.retention': message.value.retention,
                  'storage.warningLeadDays': message.value.warningLeadDays,
                },
              })
        );
    } else if (message.command === 'ownerClock') ownerTime = message.value;
    else if (message.command === 'readiness') {
      const result = (await app.health.evaluate()).status === 200;
      process.send?.({ id: message.id, result });
      return;
    } else if (message.command === 'logs') {
      process.send?.({ id: message.id, result: logs });
      return;
    } else if (message.command === 'tick') await retention.runOnce();
    else throw Error('unknown test command');
    process.send?.({ id: message.id, result: null });
  })().catch(() => process.send?.({ id: message.id, error: 'tick_failed' }));
});
process.send?.({ ready: ports });
