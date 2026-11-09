/**
 * The log store's partition key at first start (ADR-016 §5).
 *
 * The store reads the key as a file (`-partitionManageAuthKey=file://`) and the
 * evictor as a `secretKeyRef`; no other workload holds it. The artifact
 * declares the Secret empty, so a store that starts before a key exists
 * requires no `authKey` and answers every partition call - which is the state
 * this check ends.
 *
 * It runs in front of the loader's first-start phase plan, on every bootstrap
 * attempt:
 * - an empty or keyless Secret gets one random key of 32 bytes, base64url so
 *   the store reads it as one token, written together with its revision;
 * - a key that is already there is never replaced;
 * - the restart is the retention setting's own revision path: both annotation
 *   maps of the store's Deployment carry `lifemodel.dev/logs-partition-key-revision`,
 *   a value that changes once per key written and is never the key or a hash of
 *   it. The settings revision value is not reused or overwritten;
 * - the store is proved to run the key only by an available pod of the patched
 *   template that carries that annotation. The key is never read back out of
 *   the store, and it reaches no log line, answer or error message.
 *
 * Nothing here is fatal: a refusal is one warning, and the next attempt reads
 * the same durable state again. A crash between the Secret write and the
 * restart leaves the revision in the Secret and no pod carrying it, so the
 * restart is simply requested again.
 */
import { randomBytes } from 'node:crypto';
import { counterOf } from './logs-retention.js';
import type { LoaderLogger } from './logger.js';
import type {
  LogsPartitionKey,
  LogsSettingsCluster,
  LogsStoreDeployment,
} from './logs-settings-cluster.js';

/** The floor is 32 bytes of crypto randomness; base64url makes it 43 characters. */
export const LOGS_PARTITION_KEY_BYTES = 32;
const REVISION_RANDOM_BYTES = 8;

/** The four objects and verbs this check uses, and nothing else. */
export type LogsPartitionKeyCluster = Pick<
  LogsSettingsCluster,
  'readPartitionKey' | 'writePartitionKey' | 'writeDeploymentKeyRevision' | 'observeDeployment'
>;

export interface LogsPartitionKeyBootstrap {
  run(): Promise<void>;
}

export interface LogsPartitionKeyOptions {
  readonly cluster: LogsPartitionKeyCluster;
  readonly logger: Pick<LoaderLogger, 'info' | 'warn'>;
  /** Override for tests; production is `crypto.randomBytes`. */
  readonly random?: (bytes: number) => Buffer;
}

/** One token the store reads whole: base64url has no padding and no separator. */
export function partitionKeyOf(random: (bytes: number) => Buffer): string {
  return random(LOGS_PARTITION_KEY_BYTES).toString('base64url');
}

/** A new revision per key written: a counter plus randomness, never a hash of the key. */
export function nextKeyRevision(
  previous: string | null,
  random: (bytes: number) => Buffer
): string {
  return `${String(counterOf(previous ?? '') + 1)}-${random(REVISION_RANDOM_BYTES).toString('hex')}`;
}

/**
 * The proof (ADR-016 §5): the controller caught up with the patched template,
 * every replica is updated and available, and the pod that answers carries the
 * key's revision.
 */
export function storeRunsKey(observation: LogsStoreDeployment, revision: string): boolean {
  return (
    observation.observedGeneration === observation.generation &&
    observation.updatedReplicas >= observation.replicas &&
    observation.availableReplicas >= observation.replicas &&
    observation.templateKeyRevision === revision &&
    observation.podKeyRevisions.includes(revision)
  );
}

export function createLogsPartitionKeyBootstrap(
  options: LogsPartitionKeyOptions
): LogsPartitionKeyBootstrap {
  const { cluster, logger } = options;
  const random = options.random ?? ((bytes: number) => randomBytes(bytes));

  /** Writes what the Secret is missing; answers the revision the restart needs, or null. */
  async function ensureKey(secret: LogsPartitionKey): Promise<string | null> {
    if (secret.value === null) {
      const revision = nextKeyRevision(secret.revision, random);
      const written = await cluster.writePartitionKey(partitionKeyOf(random), revision);
      if (written.state !== 'ok') {
        logger.warn({ code: written.state }, 'the log store partition key was not written');
        return null;
      }
      logger.info({ revision }, 'wrote the log store partition key');
      return revision;
    }
    if (secret.revision !== null) return secret.revision;
    // A key written by hand: the store may still run the empty one, so it gets
    // the revision the restart below is proved by. The value is never replaced.
    const revision = nextKeyRevision(null, random);
    const written = await cluster.writePartitionKey(null, revision);
    if (written.state !== 'ok') {
      logger.warn({ code: written.state }, 'the log store partition key revision was not written');
      return null;
    }
    logger.info({ revision }, 'gave the log store partition key its revision');
    return revision;
  }

  async function check(): Promise<void> {
    const secret = await cluster.readPartitionKey();
    if (secret.state !== 'ok') {
      logger.warn({ code: secret.state }, 'the log store partition key cannot be read yet');
      return;
    }
    // The store's step creates the Secret; before it there is nothing to write
    // into and no store that could read a key.
    if (!secret.value.present) return;
    const revision = await ensureKey(secret.value);
    if (revision === null) return;
    const observation = await cluster.observeDeployment();
    if (observation.state !== 'ok') {
      logger.warn({ code: observation.state }, 'the log store cannot be observed yet');
      return;
    }
    if (storeRunsKey(observation.value, revision)) return;
    const patched = await cluster.writeDeploymentKeyRevision(revision);
    if (patched.state !== 'ok') {
      logger.warn({ code: patched.state }, 'the log store partition key revision was not applied');
      return;
    }
    if (patched.value.state === 'patched')
      logger.info(
        { revision, generation: patched.value.generation },
        'the log store will replace its pod for the partition key'
      );
  }

  return {
    run: async () => {
      try {
        await check();
      } catch (error) {
        // The error's name only: a message built elsewhere is not worth the risk
        // of carrying the key into the log.
        logger.warn(
          { code: error instanceof Error ? error.name : 'unexpected' },
          'the log store partition key check did not finish'
        );
      }
    },
  };
}
