/** Offline owner-only recovery entry point. No public admin API or cluster RBAC. */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createStorageMaintenance } from './storage-maintenance.js';
import { catalogConnectionString } from './storage-catalog.js';
import { createStorageRestoreReconciler } from './storage-restore-reconcile.js';
import { createRoleBaoClient } from './model-bao.js';
import { readCustodyRecord, parseStorageCredentials, STORAGE_BUCKET } from './storage-custody.js';
import { StorageAccessError } from './storage-access-error.js';
import {
  inventorySeaweedLayout,
  copySanitizedSeaweedTree,
  buildStorageBackupManifest,
  verifyStorageBackupArtifact,
  type StorageBackupArtifactPolicy,
  type StorageBackupMetadata,
} from './storage-backup-artifact.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const SAFE_ERRORS = new Set([
  'storage_held',
  'hold_conflict',
  'hold_pending',
  'restore_pending',
  'restore_requires_hold',
  'maintenance_unavailable',
  'restore_unavailable',
]);
const HELP = `storage-recovery commands (credentials only in module environment):
  begin EFFECT_KEY | status | release GENERATION
  release-degraded GENERATION EXACT_UNAVAILABLE_COUNT
  prepare-restore NEW_GENERATION MANIFEST_SHA256
  reconcile GENERATION MANIFEST_SHA256
  layout SOURCE POLICY_JSON
  sanitize SOURCE NEW_DESTINATION POLICY_JSON
  build ARTIFACT_ROOT METADATA_JSON POLICY_JSON
  verify ARTIFACT_ROOT POLICY_JSON
  stage ARTIFACT_ROOT NEW_DESTINATION POLICY_JSON
Output contains codes, generations and counts. Only layout emits relative names.
Failure leaves the hold in place. Restart the backend, check health, then release
only the matching backup generation. Never force-release a pending restore.
`;

type MaintenanceClient = Pick<
  ReturnType<typeof createStorageMaintenance>,
  'begin' | 'status' | 'release' | 'releaseDegraded' | 'prepareRestore' | 'close'
>;
export interface StorageRecoveryCliOptions {
  env: NodeJS.ProcessEnv;
  stdout(text: string): void | Promise<void>;
  stderr(text: string): void | Promise<void>;
  /** Test seam only; production always uses the scoped catalog configuration. */
  maintenance?: (options: { connectionString: string }) => MaintenanceClient;
}
class ArgumentsError extends Error {}
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error('missing_config');
  return value;
}
function validArguments(args: string[]): void {
  const [command, ...values] = args;
  const counts: Record<string, number> = {
    help: 0,
    begin: 1,
    status: 0,
    release: 1,
    'release-degraded': 2,
    'prepare-restore': 2,
    reconcile: 2,
    layout: 2,
    sanitize: 3,
    build: 3,
    verify: 2,
    stage: 3,
  };
  if (
    !command ||
    !Object.hasOwn(counts, command) ||
    values.length !== counts[command] ||
    values.some(
      (v) =>
        !v ||
        v.startsWith('--') ||
        Array.from(v).some((ch) => {
          const code = ch.codePointAt(0) ?? 0;
          return code < 32 || code === 127;
        })
    )
  )
    throw new ArgumentsError();
  if (command === 'begin' && !/^[A-Za-z0-9_-]{1,128}$/.test(values[0] ?? ''))
    throw new ArgumentsError();
  if (
    ['release', 'release-degraded', 'prepare-restore', 'reconcile'].includes(command) &&
    !UUID.test(values[0] ?? '')
  )
    throw new ArgumentsError();
  if (
    command === 'release-degraded' &&
    (!/^[1-9][0-9]*$/.test(values[1] ?? '') || !Number.isSafeInteger(Number(values[1])))
  )
    throw new ArgumentsError();
  if (['prepare-restore', 'reconcile'].includes(command) && !SHA.test(values[1] ?? ''))
    throw new ArgumentsError();
}
/** Never JSON-serialize a service result wholesale: future fields may be private. */
function safeStatus(value: unknown): Record<string, unknown> {
  const row = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (typeof row['generation'] === 'string' && UUID.test(row['generation']))
    result['generation'] = row['generation'];
  if (['normal', 'draining', 'held', 'reconciling'].includes(String(row['state'])))
    result['state'] = row['state'];
  if (['backup', 'restore'].includes(String(row['purpose']))) result['purpose'] = row['purpose'];
  for (const key of ['checked', 'unavailable'])
    if (typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && row[key] >= 0)
      result[key] = row[key];
  if (typeof row['complete'] === 'boolean') result['complete'] = row['complete'];
  return result;
}
async function json<T>(path: string): Promise<T> {
  const bytes = await readFile(path);
  if (bytes.length > 4 * 1024 * 1024) throw new Error('input_too_large');
  return JSON.parse(bytes.toString('utf8')) as T;
}

export async function runStorageRecoveryCli(
  args: string[],
  options: StorageRecoveryCliOptions
): Promise<number> {
  let maintenance: MaintenanceClient | undefined;
  let reconciler: ReturnType<typeof createStorageRestoreReconciler> | undefined;
  let code = 0;
  const emit = async (value: Record<string, unknown>) =>
    options.stdout(`${JSON.stringify(value)}\n`);
  try {
    validArguments(args);
    const [command, a, b, c] = args as [string, string, string, string];
    if (command === 'help') await options.stdout(HELP);
    else if (['layout', 'sanitize', 'build', 'verify', 'stage'].includes(command)) {
      const policy = await json<StorageBackupArtifactPolicy>(
        command === 'verify' || command === 'layout' ? b : c
      );
      if (command === 'layout') {
        const inventory = await inventorySeaweedLayout(a, policy);
        await emit({
          code: inventory.supported ? 'layout_supported' : 'layout_rejected',
          supported: inventory.supported,
          entries: inventory.entries.map((entry) => ({
            path: entry.path,
            type: entry.type,
            action: entry.action,
          })),
        });
        if (!inventory.supported) code = 1;
      } else if (command === 'sanitize') {
        await copySanitizedSeaweedTree(a, b, policy);
        await emit({ code: 'tree_staged' });
      } else if (command === 'build') {
        const result = await buildStorageBackupManifest(
          a,
          await json<StorageBackupMetadata>(b),
          policy
        );
        await emit({
          code: 'artifact_complete',
          manifestSha256: result.manifestSha256,
          files: result.manifest.files.length,
        });
      } else {
        const result = await verifyStorageBackupArtifact(a, policy);
        if (command === 'stage') await copySanitizedSeaweedTree(join(a, 'seaweed'), b, policy);
        await emit({
          code: command === 'stage' ? 'artifact_staged' : 'artifact_verified',
          manifestSha256: result.manifestSha256,
          files: result.manifest.files.length,
        });
      }
    } else {
      const connectionString = catalogConnectionString(
        required(options.env, 'LIFEMODEL_DB_USERNAME'),
        required(options.env, 'LIFEMODEL_DB_PASSWORD')
      );
      maintenance = (options.maintenance ?? createStorageMaintenance)({ connectionString });
      if (command === 'begin')
        await emit({
          code: 'hold_started',
          ...safeStatus(await maintenance.begin({ effectKey: a })),
        });
      else if (command === 'status')
        await emit({ code: 'maintenance_status', ...safeStatus(await maintenance.status()) });
      else if (command === 'release')
        await emit({
          code: 'hold_released',
          ...safeStatus(await maintenance.release({ generation: a })),
        });
      else if (command === 'release-degraded')
        await emit({
          code: 'hold_released',
          ...safeStatus(
            await maintenance.releaseDegraded({ generation: a, unavailable: Number(b) })
          ),
        });
      else if (command === 'prepare-restore')
        await emit({
          code: 'restore_prepared',
          ...safeStatus(await maintenance.prepareRestore({ generation: a, artifactSha256: b })),
        });
      else {
        const bao = createRoleBaoClient({
          address: required(options.env, 'LIFEMODEL_OPENBAO_ADDRESS'),
          role: 'storage-module',
        });
        reconciler = createStorageRestoreReconciler({
          connectionString,
          s3: {
            endpoint: required(options.env, 'LIFEMODEL_STORAGE_S3_ENDPOINT'),
            bucket: STORAGE_BUCKET,
            custody: {
              read: async () => parseStorageCredentials(await readCustodyRecord(bao.call)),
            },
          },
        });
        await reconciler.begin(a, b);
        await emit({ code: 'reconcile_page', ...safeStatus(await reconciler.reconcile(a)) });
      }
    }
  } catch (error) {
    code = error instanceof ArgumentsError ? 2 : 1;
    const reason =
      error instanceof ArgumentsError
        ? 'invalid_arguments'
        : error instanceof StorageAccessError && SAFE_ERRORS.has(error.code)
          ? error.code
          : 'recovery_failed';
    try {
      await options.stderr(
        `${JSON.stringify({ code: reason, recovery: 'hold_retained_check_status' })}\n`
      );
    } catch {
      /* A broken error pipe cannot be repaired by printing. */
    }
  } finally {
    try {
      await reconciler?.close();
      await maintenance?.close();
    } catch {
      code = 1;
    }
  }
  return code;
}

/** Executable and importable, without running on a test import. */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  let failed = false;
  function output(stream: NodeJS.WriteStream): (text: string) => Promise<void> {
    stream.on('error', () => {
      failed = true;
      process.exitCode = 1;
      stream.destroy();
    });
    return (text) =>
      new Promise((resolveWrite, reject) => {
        const timer = setTimeout(() => {
          failed = true;
          stream.destroy();
          reject(new Error('output_failed'));
        }, 1000);
        stream.write(text, (error) => {
          clearTimeout(timer);
          if (error || failed) reject(new Error('output_failed'));
          else resolveWrite();
        });
      });
  }
  const stdout = output(process.stdout);
  const stderr = output(process.stderr);
  const status = await runStorageRecoveryCli(process.argv.slice(2), {
    env: process.env,
    stdout,
    stderr,
  });
  process.exitCode = failed ? 1 : status;
}
