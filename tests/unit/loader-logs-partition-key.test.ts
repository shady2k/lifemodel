/**
 * The partition key at the loader's first start (ADR-016 §5).
 *
 * The store reads the key as a file argument and the evictor as a
 * `secretKeyRef`, so a store that starts with the empty value answers every
 * partition call without `authKey`. The loader writes one random key, never
 * replaces a key that is there, and proves the store runs it by a pod of the
 * new template that is available - never by reading the key out of the store.
 * The key is not in a log line, an answer or an error message.
 */
import { describe, expect, it } from 'vitest';
import {
  LOGS_PARTITION_KEY_BYTES,
  createLogsPartitionKeyBootstrap,
} from '../../loader/src/logs-partition-key.js';
import {
  LOGS_PARTITION_KEY_REVISION_ANNOTATION,
  type LogsClusterAnswer,
  type LogsPartitionKey,
  type LogsStoreDeployment,
} from '../../loader/src/logs-settings-cluster.js';
import { createRecordingLogger, type RecordedLine } from '../../loader/src/logger.js';

/** A deterministic stand-in for crypto randomness, distinct per call size. */
const deterministic = (bytes: number): Buffer =>
  Buffer.alloc(bytes, bytes === LOGS_PARTITION_KEY_BYTES ? 7 : 0xab);
const KEY = deterministic(LOGS_PARTITION_KEY_BYTES).toString('base64url');
const REVISION = `1-${'ab'.repeat(8)}`;

interface SecretState {
  value: string | null;
  revision: string | null;
}

interface StoreState {
  templateRevision: string | null;
  podRevisions: (string | null)[];
  generation: number;
  observedGeneration: number;
  replicas: number;
  updatedReplicas: number;
  availableReplicas: number;
}

type Failure = 'forbidden' | 'unavailable';

interface Box {
  calls: string[];
  lines: RecordedLine[];
  secret: SecretState | null;
  written: { value: string | null; revision: string } | null;
  patched: string | null;
  store: StoreState;
  failRead: Failure | null;
  failWrite: Failure | null;
  failPatch: Failure | null;
  run: () => Promise<void>;
}

function box(options: { secret?: SecretState | null } = {}): Box {
  const failed = (reason: Failure): { state: Failure } =>
    reason === 'forbidden' ? { state: 'forbidden' } : { state: 'unavailable' };
  const state: Box = {
    calls: [],
    lines: [],
    // An empty Secret is what the store's step creates: the bar this check starts from.
    secret:
      options.secret === undefined
        ? { value: null, revision: null }
        : structuredClone(options.secret),
    written: null,
    patched: null,
    store: {
      templateRevision: null,
      podRevisions: [null],
      generation: 1,
      observedGeneration: 1,
      replicas: 1,
      updatedReplicas: 1,
      availableReplicas: 1,
    },
    failRead: null,
    failWrite: null,
    failPatch: null,
    run: async () => {},
  };
  const cluster = {
    readPartitionKey: async (): Promise<LogsClusterAnswer<LogsPartitionKey>> => {
      state.calls.push('read');
      if (state.failRead !== null) return failed(state.failRead);
      return {
        state: 'ok',
        value:
          state.secret === null
            ? { present: false, value: null, revision: null }
            : { present: true, ...state.secret },
      };
    },
    writePartitionKey: async (
      value: string | null,
      revision: string
    ): Promise<LogsClusterAnswer<'written'>> => {
      state.calls.push(value === null ? 'annotate' : 'write');
      if (state.failWrite !== null) return failed(state.failWrite);
      state.secret = { value: value ?? state.secret?.value ?? null, revision };
      state.written = { value, revision };
      return { state: 'ok', value: 'written' };
    },
    writeDeploymentKeyRevision: async (
      revision: string
    ): Promise<LogsClusterAnswer<{ state: 'unchanged' | 'patched'; generation: number }>> => {
      state.calls.push('patch');
      if (state.failPatch !== null) return failed(state.failPatch);
      if (state.store.templateRevision === revision)
        return { state: 'ok', value: { state: 'unchanged', generation: state.store.generation } };
      state.patched = revision;
      state.store.templateRevision = revision;
      state.store.podRevisions = [];
      state.store.generation += 1;
      // The controller catches up with the patch: what is left is the pod.
      state.store.observedGeneration = state.store.generation;
      return { state: 'ok', value: { state: 'patched', generation: state.store.generation } };
    },
    observeDeployment: async (): Promise<LogsClusterAnswer<LogsStoreDeployment>> => {
      state.calls.push('observe');
      return {
        state: 'ok',
        value: {
          generation: state.store.generation,
          observedGeneration: state.store.observedGeneration,
          replicas: state.store.replicas,
          updatedReplicas: state.store.updatedReplicas,
          availableReplicas: state.store.availableReplicas,
          templateRevision: null,
          progressDeadlineExceeded: false,
          podRevisions: [],
          templateKeyRevision: state.store.templateRevision,
          podKeyRevisions: [...state.store.podRevisions],
        },
      };
    },
  };
  state.run = async () => {
    await createLogsPartitionKeyBootstrap({
      cluster,
      logger: createRecordingLogger(state.lines),
      random: deterministic,
    }).run();
  };
  return state;
}

function expectNothingLeaked(boxed: { lines: RecordedLine[] }, key: string): void {
  const text = JSON.stringify(boxed.lines);
  expect(text).not.toContain(key);
  expect(text).not.toContain(Buffer.from(key, 'utf8').toString('base64'));
}

describe('an empty partition key at first start', () => {
  it('writes one random key and requests the store restart through the revision path', async () => {
    const boxed = box();
    await boxed.run();
    expect(boxed.calls).toEqual(['read', 'write', 'observe', 'patch']);
    // One token of at least 32 random bytes, and no whitespace the store would
    // read as two tokens.
    expect(boxed.written?.value).toBe(KEY);
    expect(KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(KEY, 'base64url')).toHaveLength(LOGS_PARTITION_KEY_BYTES);
    // The restart carries a revision that changes once per key written: never
    // the key and never a hash of it.
    const revision = boxed.written?.revision ?? '';
    expect(revision).toBe(REVISION);
    expect(boxed.patched).toBe(revision);
    expect(revision).not.toContain(KEY);
    expect(revision).not.toContain(deterministic(LOGS_PARTITION_KEY_BYTES).toString('hex'));
    expectNothingLeaked(boxed, KEY);
  });

  it('does not settle until an available pod carries the key revision', async () => {
    const boxed = box();
    await boxed.run();
    // The patch left the store mid-rollout: the template carries the key
    // revision, no pod does yet.
    expect(boxed.store.podRevisions).toEqual([]);
    boxed.calls.length = 0;
    boxed.patched = null;
    await boxed.run();
    expect(boxed.calls).toEqual(['read', 'observe', 'patch']);
    expect(boxed.patched).toBeNull();
    boxed.store.podRevisions = [REVISION];
    boxed.calls.length = 0;
    await boxed.run();
    expect(boxed.calls).toEqual(['read', 'observe']);
  });
});

describe('a key that is already there', () => {
  it('is never replaced and never restarts a store that runs it', async () => {
    const boxed = box({ secret: { value: 'operator-written-key', revision: REVISION } });
    boxed.store.templateRevision = REVISION;
    boxed.store.podRevisions = [REVISION];
    await boxed.run();
    expect(boxed.calls).toEqual(['read', 'observe']);
    expect(boxed.written).toBeNull();
    expect(boxed.patched).toBeNull();
  });

  it('gets its revision and a restart when the store still runs the empty key', async () => {
    // An operator wrote the value by hand: nothing proves the store read it.
    const boxed = box({ secret: { value: 'operator-written-key', revision: null } });
    await boxed.run();
    expect(boxed.calls).toEqual(['read', 'annotate', 'observe', 'patch']);
    // Only the revision is written; the value is untouched.
    expect(boxed.written).toEqual({ value: null, revision: REVISION });
    expect(boxed.secret?.value).toBe('operator-written-key');
  });
});

describe('a crash between the Secret write and the restart', () => {
  it('converges on the next bootstrap: the same revision is requested again', async () => {
    const boxed = box();
    boxed.failPatch = 'forbidden';
    await boxed.run();
    // The Secret holds the key; the store still runs the empty one.
    expect(boxed.secret).toEqual({ value: KEY, revision: REVISION });
    expect(boxed.store.templateRevision).toBeNull();
    expect(boxed.store.podRevisions).toEqual([null]);
    expect(boxed.lines.map((line) => line.level)).toContain('warn');
    expectNothingLeaked(boxed, KEY);
    // The next attempt writes no second key and asks for the restart again.
    boxed.failPatch = null;
    boxed.calls.length = 0;
    await boxed.run();
    expect(boxed.calls).toEqual(['read', 'observe', 'patch']);
    expect(boxed.patched).toBe(REVISION);
    boxed.store.podRevisions = [REVISION];
    boxed.calls.length = 0;
    await boxed.run();
    expect(boxed.calls).toEqual(['read', 'observe']);
  });
});

describe('what the check does when it cannot read the objects', () => {
  it('reports a refused Secret read and writes nothing', async () => {
    const boxed = box({ secret: { value: null, revision: null } });
    boxed.failRead = 'forbidden';
    await boxed.run();
    expect(boxed.calls).toEqual(['read']);
    expect(boxed.written).toBeNull();
    expect(boxed.lines).toEqual([
      {
        level: 'warn',
        fields: { code: 'forbidden' },
        message: 'the log store partition key cannot be read yet',
      },
    ]);
  });

  it('says nothing at all before the store step has created the Secret', async () => {
    const boxed = box({ secret: null });
    await boxed.run();
    expect(boxed.calls).toEqual(['read']);
    expect(boxed.written).toBeNull();
    expect(boxed.patched).toBeNull();
    expect(boxed.lines).toEqual([]);
  });

  it('keeps the written key and retries the restart when the store cannot be observed', async () => {
    const cluster = {
      readPartitionKey: async () => ({
        state: 'ok' as const,
        value: { present: true, value: null, revision: null },
      }),
      writePartitionKey: async () => ({ state: 'ok' as const, value: 'written' as const }),
      writeDeploymentKeyRevision: async () => ({
        state: 'ok' as const,
        value: { state: 'patched' as const, generation: 3 },
      }),
      observeDeployment: async () => ({ state: 'unavailable' as const }),
    };
    const lines: RecordedLine[] = [];
    await createLogsPartitionKeyBootstrap({
      cluster,
      logger: createRecordingLogger(lines),
      random: deterministic,
    }).run();
    expect(lines).toEqual([
      {
        level: 'info',
        fields: { revision: REVISION },
        message: 'wrote the log store partition key',
      },
      {
        level: 'warn',
        fields: { code: 'unavailable' },
        message: 'the log store cannot be observed yet',
      },
    ]);
    expectNothingLeaked({ lines }, KEY);
  });
});

describe('the annotation the restart is proved by', () => {
  it('is named once, beside the settings revision and never equal to it', () => {
    expect(LOGS_PARTITION_KEY_REVISION_ANNOTATION).toBe(
      'lifemodel.dev/logs-partition-key-revision'
    );
  });
});
