import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestLogger } from '../helpers/test-logger.js';
import { createFinalizerStorage } from '../helpers/finalizer-storage.js';
import { createPlatformSettingsReader } from '../../src/config/platform-settings.js';
import { createPostgresTaskRegistry } from '../../src/storage/postgres-task-registry.js';
import { createPostgresTaskMailbox } from '../../src/storage/postgres-task-mailbox.js';
import { createBusSignalStream } from '../../src/core/bus-stream.js';
import { createTaskChannelReplay } from '../../src/core/task-channel-replay.js';
import {
  createFakeTaskExecutor,
  type FakeTaskExecutor,
} from '../../src/core/fake-task-executor.js';
import { createTaskLaunchReconciler, allocationEffectKey } from '../../src/core/task-launch.js';
import { createStorageControlClient } from '../../src/core/storage-control-client.js';
import { createTaskFinalizer } from '../../src/core/task-finalize.js';
import type { TaskRegistry, TaskRecord, TaskManifestObject } from '../../src/ports/tasks.js';
import type {
  TaskChannelFrame,
  TaskChannelProof,
  TaskTerminalReport,
} from '../../src/ports/task-channel.js';
import type { TaskExecutor, TaskLaunch } from '../../src/core/task-executor.js';

// Only external compute and the storage service are simulated. Each takeover
// replaces the actual fenced registry/mailbox/launch/finalizer/Valkey bus objects.
// The fake external services survive, just as Jobs and storage survive the core.
describe('task restart finalization (real Postgres and Valkey, TLS storage)', () => {
  let stores: TestStores;
  let storage: Awaited<ReturnType<typeof createFinalizerStorage>>;
  let executor: FakeTaskExecutor;
  let epoch: number;
  let prefix: string;
  let expectedEnsureCalls: number;
  let originalDataPath: string | undefined;
  let registry: TaskRegistry;
  let mailbox: ReturnType<typeof createPostgresTaskMailbox>;
  let bus: ReturnType<typeof createBusSignalStream>;
  const logger = createTestLogger();
  const settings = createPlatformSettingsReader({ logger, dir: '/missing-finalizer-settings' });
  const stops: (() => void | Promise<void>)[] = [];
  const result: TaskManifestObject = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'answer.txt',
    size: 42,
    sha256: 'a'.repeat(64),
    mark: 'result',
    contentType: 'text/plain',
  };
  const log: TaskManifestObject = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'task.log',
    size: 15,
    sha256: 'b'.repeat(64),
    mark: 'log',
    contentType: 'text/plain',
  };
  beforeAll(async () => {
    originalDataPath = process.env.DATA_PATH;
    process.env.DATA_PATH = '/proc/lifemodel-task-restart-readonly';
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    storage = await createFinalizerStorage(stores.postgres);
  });
  async function dispose() {
    for (const stop of stops.splice(0).reverse()) await stop();
    mailbox?.stop();
  }
  async function takeover() {
    await dispose();
    epoch++;
    await stores.postgres.query(
      'INSERT INTO core.active_holder VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET epoch=$1',
      [epoch]
    );
    registry = createPostgresTaskRegistry({ pool: stores.postgres, epoch, settings });
    mailbox = createPostgresTaskMailbox({ pool: stores.postgres, epoch });
    bus = createBusSignalStream(stores.redis, prefix);
  }
  beforeEach(async () => {
    await stores.postgres.query(
      'TRUNCATE core.tasks CASCADE; TRUNCATE task_access.start_claims,task_access.projections,task_access.intents'
    );
    await storage.reset();
    executor = createFakeTaskExecutor();
    prefix = `task-finalize:${randomUUID()}:`;
    epoch = 0;
    expectedEnsureCalls = 1;
    await takeover();
  });
  afterEach(dispose);
  afterAll(async () => {
    if (originalDataPath === undefined) delete process.env.DATA_PATH;
    else process.env.DATA_PATH = originalDataPath;
    await storage.close();
    await Promise.all([stores.postgres.end(), stores.redis.quit()]);
  });
  function control() {
    const client = createStorageControlClient({ ...storage, requestTimeoutMs: 2000 });
    stops.push(client.close);
    return client;
  }
  function launcher() {
    const component = createTaskLaunchReconciler({
      registry,
      executor,
      storage: control(),
      logger,
      onTerminal: async (taskId, reasonCode) => {
        await finalizer().finalize(taskId, reasonCode);
      },
    });
    stops.push(() => component.stop());
    return component;
  }
  function finalizer(r = registry, exec: TaskExecutor = executor) {
    const component = createTaskFinalizer({
      registry: r,
      mailbox,
      executor: exec,
      storage: control(),
      bus,
      logger,
    });
    stops.push(() => component.stop());
    return component;
  }
  async function accept(): Promise<TaskRecord> {
    return registry.accept({
      launchKey: 'restart-key',
      briefing: 'private finalizer briefing canary',
      profile: {
        id: 'small',
        revision: '1',
        timeoutSeconds: 600,
        cpuMillis: 500,
        memoryBytes: 536870912,
      },
      imageRevision: `sha256:${'a'.repeat(64)}`,
    });
  }
  const launch = (task: TaskRecord): TaskLaunch => ({
    task,
    spaceId: task.allocationReceipt?.space ?? 'space_1',
    workbenchImage: `ghcr.io/shady2k/lifemodel-workbench@${task.imageRevision}`,
  });
  async function running(taskId: string): Promise<TaskChannelProof> {
    const task = (await registry.read(taskId))!;
    executor.setObservation(task.jobName, { phase: 'running', startedAt: new Date() });
    const observation = (await executor.observe(launch(task)))!;
    const intent = await registry.initializeAccessIntent(task.id, observation.startedAt!);
    const podUid = 'pod-finalizer';
    await stores.postgres.query('UPDATE core.task_launches SET pod_uid=$2 WHERE task_id=$1', [
      task.id,
      podUid,
    ]);
    // Model the gateway's won binding, including its public running transition.
    await stores.postgres.query("UPDATE core.tasks SET state='running' WHERE id=$1", [task.id]);
    await stores.postgres.query(
      `INSERT INTO task_access.start_claims(launch_id,task_id,attempt_id,pod_uid,job_uid,boot_nonce,job_started_at,soft_due_at,hard_stop_at) VALUES($1,$2,$3,$4,$5,'abcdefghijklmnop',$6,$7,$8)`,
      [
        task.launchId,
        task.id,
        task.attemptId,
        podUid,
        task.jobUid,
        observation.startedAt,
        intent.softDueAt,
        intent.hardStopAt,
      ]
    );
    await stores.postgres.query(
      `INSERT INTO task_access.projections(task_id,attempt_id,launch_id,job_uid,pod_uid,pod_name,job_name,space_id,access_revision,intent_revision,mode,soft_due_at,hard_stop_at) VALUES($1,$2,$3,$4,$5,$5,$6,$7,0,0,'active',$8,$9)`,
      [
        task.id,
        task.attemptId,
        task.launchId,
        task.jobUid,
        podUid,
        task.jobName,
        task.allocationReceipt!.space,
        intent.softDueAt,
        intent.hardStopAt,
      ]
    );
    return {
      podUid,
      podName: podUid,
      jobUid: task.jobUid!,
      jobName: task.jobName,
      launchLabel: task.launchId.slice(7, 65),
      templateHash: task.templateHash!,
      startedAt: observation.startedAt!.toISOString(),
    };
  }
  async function startTask() {
    const task = await accept();
    expect(await launcher().runOnce()).toBe(true);
    const proof = await running(task.id);
    return { task: (await registry.read(task.id))!, proof };
  }
  function report(
    task: TaskRecord,
    payload: TaskTerminalReport = {
      outcome: 'succeeded',
      summary: 'Finished task',
      resultObjectId: result.id,
      logObjectId: log.id,
      artifactObjectIds: [],
    }
  ): TaskChannelFrame {
    return {
      taskId: task.id,
      attemptId: task.attemptId,
      direction: 'task_to_core',
      sequence: 20,
      messageId: 'terminal-report',
      kind: 'terminal',
      payload,
    };
  }
  async function outcomes(taskId: string) {
    return (
      await stores.postgres.query(
        'SELECT outcome_key,event FROM core.task_outcomes WHERE task_id=$1',
        [taskId]
      )
    ).rows;
  }
  async function assertFinished(task: TaskRecord, state = 'done') {
    const stored = (await registry.read(task.id))!;
    expect(stored).toMatchObject({
      state,
      finalizationPending: false,
      slotReserved: false,
      cleanupPending: false,
    });
    expect(stored.terminalAt).toBeInstanceOf(Date);
    expect(stored.sealReceipt?.state).toBe('sealed');
    expect((await registry.readAccessIntent(task.id))?.mode).toBe('revoked');
    expect(await executor.observe(launch(stored))).toBeNull();
    const rows = await outcomes(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].event).toMatchObject({
      taskId: task.id,
      outcomeKey: rows[0].outcome_key,
      state,
    });
    expect(
      new Set(
        (await bus.readAfter('0-0', 100))
          .filter(({ signal }) => signal.type === 'task_outcome')
          .map(({ signal }) => (signal.data as { outcomeKey: string }).outcomeKey)
      )
    ).toEqual(new Set([rows[0].outcome_key]));
    expect(storage.seals.size).toBe(1);
    // Reconciliation cannot create a second execution after finalization.
    expect(await launcher().resync()).toBe(true);
    expect(executor.calls.filter((call) => call.operation === 'ensureStarted')).toHaveLength(
      expectedEnsureCalls
    );
    expect(stored.jobUid).toBe('fake-1');
    return stored;
  }
  function crashRegistry(method: 'recordSealReceipt' | 'commitFinalization') {
    let reached = 0;
    const proxy = new Proxy(registry, {
      get(target, property) {
        if (property === method)
          return async (...args: unknown[]) => {
            reached++;
            // seal response exists, but was never saved by this core. Conversely
            // the terminal/outbox transaction really commits before reply loss.
            if (method === 'commitFinalization') await Reflect.apply(target[method], target, args);
            throw new Error('simulated core death');
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return { proxy, reached: () => reached };
  }
  const boundaries = [
    'slot reserve',
    'storage allocate',
    'create response',
    'mailbox ACK',
    'mark ACK',
    'seal response',
    'terminal outbox commit',
    'Job delete',
  ] as const;
  it.each(boundaries)(
    'restarts after %s: keeps ACKs, one launch, one sealed outcome',
    async (boundary) => {
      let task = await accept();
      await registry.admitNext();
      if (boundary === 'slot reserve') await takeover();
      if (boundary === 'storage allocate') {
        await control().allocate({
          taskId: task.id,
          launchId: task.launchId,
          effectKey: allocationEffectKey(task),
          retentionRevision: String(task.settingsRevision),
        });
        expect((await registry.read(task.id))!.allocationReceipt).toBeNull();
        await takeover();
      }
      if (boundary === 'create response') {
        expectedEnsureCalls = 2;
        const receipt = await control().allocate({
          taskId: task.id,
          launchId: task.launchId,
          effectKey: allocationEffectKey(task),
          retentionRevision: String(task.settingsRevision),
        });
        task = await registry.recordAllocation(task.id, task.launchId, receipt);
        await executor.ensureStarted(launch(task));
        expect((await registry.read(task.id))!.jobUid).toBeNull();
        await takeover();
      }
      expect(await launcher().runOnce()).toBe(true);
      const proof = await running(task.id);
      task = (await registry.read(task.id))!;
      const step: TaskChannelFrame = {
        ...report(task),
        messageId: 'acknowledged-step',
        sequence: 1,
        kind: 'step',
        payload: { line: 'Kept progress' },
      };
      const ack = await mailbox.append(step, proof);
      if (boundary === 'mailbox ACK') {
        // Receipt is committed, then the process dies before the sender sees ACK.
        await takeover();
        expect(await mailbox.append(step, proof)).toEqual(ack);
      }
      if (boundary === 'mark ACK') {
        storage.loseNextMarkReply();
        await expect(storage.mark(result)).rejects.toBeInstanceOf(Error);
        expect(storage.marks.get(result.id)).toEqual(result);
        await takeover();
      }
      await storage.mark(result);
      await storage.mark(log);
      const terminalAck = await mailbox.append(report(task), proof);
      let crash: ReturnType<typeof crashRegistry> | undefined;
      if (boundary === 'seal response' || boundary === 'terminal outbox commit') {
        crash = crashRegistry(
          boundary === 'seal response' ? 'recordSealReceipt' : 'commitFinalization'
        );
        await finalizer(crash.proxy).runOnce();
        expect(crash.reached()).toBe(1);
        expect(storage.seals.size).toBe(1);
        expect(await outcomes(task.id)).toHaveLength(boundary === 'seal response' ? 0 : 1);
      } else if (boundary === 'Job delete') {
        let deleted = 0;
        const crashExecutor = new Proxy(executor, {
          get(target, property) {
            if (property === 'deleteNow')
              return async (...args: Parameters<TaskExecutor['deleteNow']>) => {
                await target.deleteNow(...args);
                deleted++;
                throw new Error('lost delete response');
              };
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        await finalizer(registry, crashExecutor).runOnce();
        expect(deleted).toBe(1);
        expect(await executor.observe(launch(task))).toBeNull();
        expect(await outcomes(task.id)).toHaveLength(0);
      }
      await takeover();
      expect((await mailbox.readTerminal(task.id, task.attemptId))?.ack).toEqual(terminalAck);
      expect(
        (await mailbox.listUnsignalled()).find((row) => row.frame.messageId === step.messageId)?.ack
      ).toEqual(ack);
      expect(await finalizer().runOnce()).toBe(true);
      const finished = await assertFinished(task);
      expect(finished.sealReceipt!.manifest.objects).toEqual([result, log]);
      const event = (await outcomes(task.id))[0].event;
      expect(event).toMatchObject({ summary: 'Finished task', objects: [result, log] });
      // Repeat through genuinely replaced components, not a cached Promise.
      await takeover();
      expect(await finalizer().runOnce()).toBe(true);
      expect(await finalizer().finalize(task.id, 'late_job_failure')).toBe(true);
      expect(await registry.read(task.id)).toMatchObject({
        state: finished.state,
        terminalReasonCode: finished.terminalReasonCode,
        terminalAt: finished.terminalAt,
        sealReceipt: finished.sealReceipt,
      });
      expect(await outcomes(task.id)).toHaveLength(1);
    }
  );

  it.each(['failed', 'aborted'] as const)(
    'seals semantic %s with retained partial output and one reason',
    async (outcome) => {
      const { task, proof } = await startTask();
      await storage.mark(log);
      await mailbox.append(
        report(task, {
          outcome,
          summary: 'Partial task output',
          resultObjectId: null,
          logObjectId: log.id,
          artifactObjectIds: [],
          ...(outcome === 'failed' ? { reasonCode: 'provider_error' } : {}),
        } as TaskTerminalReport),
        proof
      );
      expect(await finalizer().runOnce()).toBe(true);
      const stored = await assertFinished(task, outcome === 'aborted' ? 'stopped' : 'failed');
      if (outcome === 'failed') {
        expect(stored.terminalReasonCode).toBe('provider_error');
        expect((await outcomes(task.id))[0].event.reasonCode).toBe('provider_error');
      }
      expect(stored.sealReceipt!.outcome).toBe(outcome === 'aborted' ? 'stopped' : 'failed');
      expect(stored.sealReceipt!.manifest.objects).toEqual([log]);
    }
  );
  it('a succeeded Job with no semantic terminal report is failed, never done', async () => {
    const { task } = await startTask();
    await storage.mark(result);
    executor.setObservation(task.jobName, { phase: 'succeeded' });
    expect(await launcher().runOnce()).toBe(true);
    const stored = await assertFinished(task, 'failed');
    expect(stored.terminalReasonCode).toBe('semantic_report_missing');
    expect(stored.sealReceipt!.outcome).toBe('failed');
  });
  it('semantic success without a sealed marked result downgrades to failed under a new seal key', async () => {
    const { task, proof } = await startTask();
    await storage.mark(log);
    await mailbox.append(report(task), proof);
    await finalizer().runOnce();
    await finalizer().runOnce();
    const stored = await assertFinished(task, 'failed');
    expect(stored.terminalReasonCode).toBe('missing_result');
    const attempts = storage.calls.filter((call) => call.path === '/seal');
    expect(attempts.map((call) => call.body.outcome)).toEqual(['completed', 'failed']);
    expect(new Set(attempts.map((call) => call.body.effectKey)).size).toBe(2);
  });
  it('retries a module revoke revision conflict with a new seal key while preserving semantic success', async () => {
    const { task, proof } = await startTask();
    await storage.mark(result);
    await mailbox.append(report(task), proof);
    storage.revokeBeforeNextSeal();
    expect(await finalizer().runOnce()).toBe(false);
    expect(await outcomes(task.id)).toHaveLength(0);
    expect(storage.seals.size).toBe(0);
    const pending = (await registry.read(task.id))!;
    expect(pending).toMatchObject({
      state: 'running',
      terminalCandidate: 'done',
      terminalReasonCode: 'completed',
      terminalSummary: 'Finished task',
      finalizationPending: true,
    });
    expect(
      (
        await stores.postgres.query(
          'SELECT mode,access_revision::text FROM storage.spaces WHERE id=$1',
          ['space_1']
        )
      ).rows
    ).toEqual([{ mode: 'revoked', access_revision: '1' }]);
    await takeover();
    expect(await finalizer().runOnce()).toBe(true);
    const done = await assertFinished(task);
    expect(done.terminalReasonCode).toBe('completed');
    expect(done.sealReceipt!.outcome).toBe('completed');
    const calls = storage.calls.filter((call) => call.path === '/seal');
    expect(calls.map((call) => call.body.outcome)).toEqual(['completed', 'completed']);
    expect(calls.map((call) => call.body.expectedRevision)).toEqual(['0', '1']);
    expect(new Set(calls.map((call) => call.body.effectKey)).size).toBe(2);
  });
  it('a frozen checksum failure recovers with a new failed seal key and explicit excluded metadata', async () => {
    const { task, proof } = await startTask();
    await storage.mark(result);
    await storage.mark(log);
    storage.setChecksumMismatch(true);
    await mailbox.append(report(task), proof);
    expect(await finalizer().runOnce()).toBe(false);
    expect(await outcomes(task.id)).toHaveLength(0);
    expect(await registry.read(task.id)).toMatchObject({
      state: 'running',
      terminalCandidate: 'failed',
      finalizationPending: true,
    });
    await takeover();
    expect(await finalizer().runOnce()).toBe(true);
    const failed = await assertFinished(task, 'failed');
    expect(failed.terminalReasonCode).toBe('checksum_mismatch');
    expect(failed.sealReceipt!.revision).toBe('1');
    expect(failed.sealReceipt!.manifest.objects).toEqual([log]);
    expect(failed.sealReceipt!.manifest.excluded).toEqual([
      { ...result, reason: 'checksum_mismatch' },
    ]);
    const calls = storage.calls.filter((call) => call.path === '/seal');
    expect(calls.map((call) => call.body.outcome)).toEqual(['completed', 'failed']);
    expect(calls.map((call) => call.body.expectedRevision)).toEqual(['0', '1']);
    expect(new Set(calls.map((call) => call.body.effectKey)).size).toBe(2);
  });
  it('missing compute is failed with retained marked partial output, without a new Job', async () => {
    const { task } = await startTask();
    await storage.mark(log);
    executor.loseJob(task.jobName);
    expect(await launcher().runOnce()).toBe(true);
    const stored = await assertFinished(task, 'failed');
    expect(stored.terminalReasonCode).toBe('compute_missing');
    expect(stored.sealReceipt!.manifest.objects).toEqual([log]);
  });
  it('storage outage leaves nonterminal pending, stops compute, and only releases after confirmed termination', async () => {
    const { task, proof } = await startTask();
    await storage.mark(result);
    await mailbox.append(report(task), proof);
    storage.setUnavailable(true);
    executor.setTerminationPending(task.jobUid!, true);
    await finalizer().runOnce();
    expect(await executor.observe(launch(task))).toBeNull();
    expect(await registry.read(task.id)).toMatchObject({
      terminalCandidate: 'done',
      finalizationPending: true,
      slotReserved: true,
      terminalAt: null,
    });
    expect(await outcomes(task.id)).toHaveLength(0);
    expect(storage.calls.filter((call) => call.path === '/seal')).toHaveLength(0);
    executor.setTerminationPending(task.jobUid!, false);
    await finalizer().runOnce();
    expect(await registry.read(task.id)).toMatchObject({
      terminalCandidate: 'done',
      finalizationPending: true,
      slotReserved: false,
      terminalAt: null,
    });
    expect(await outcomes(task.id)).toHaveLength(0);
    await takeover();
    storage.setUnavailable(false);
    expect(await finalizer().runOnce()).toBe(true);
    await assertFinished(task);
  });
  it('startup scans a terminal row even after its Signal was admitted, completed and removed', async () => {
    const { task, proof } = await startTask();
    await storage.mark(result);
    await mailbox.append(report(task), proof);
    const replay = createTaskChannelReplay({ mailbox, bus, logger });
    await replay.start();
    await replay.stop(Date.now() + 1000);
    const entries = await bus.readAfter('0-0', 10);
    expect(entries).toHaveLength(1);
    bus.ensureOwned(entries[0]!.id, 'admitted-turn');
    bus.markCompleted([entries[0]!.id]);
    await stores.redis.set(`${prefix}saved-bus`, JSON.stringify(bus.exportSnapshot()));
    await stores.redis.xdel(`${prefix}bus`, entries[0]!.id);
    expect(await mailbox.listUnsignalled()).toEqual([]);
    await takeover();
    bus.hydrateSnapshot(JSON.parse((await stores.redis.get(`${prefix}saved-bus`))!));
    expect(await bus.readAfter(bus.committedOffset(), 10)).toEqual([]);
    const component = finalizer();
    component.start();
    await expect.poll(async () => (await registry.read(task.id))?.state).toBe('done');
    await component.stop();
    expect(await outcomes(task.id)).toHaveLength(1);
  });
  it('replayed terminal Signals and forced late failure cannot mutate a committed terminal outcome', async () => {
    const { task, proof } = await startTask();
    await storage.mark(result);
    await mailbox.append(report(task), proof);
    const replay = createTaskChannelReplay({ mailbox, bus, logger });
    await replay.start();
    await replay.stop(Date.now() + 1000);
    const signal = (await bus.readAfter('0-0', 10))[0]!.signal;
    const first = finalizer();
    await first.consumeSignal(signal);
    expect(await first.resync()).toBe(true);
    const before = await assertFinished(task);
    const event = await outcomes(task.id);
    await takeover();
    const restarted = finalizer();
    await restarted.consumeSignal(signal);
    await restarted.finalize(task.id, 'late_runtime_failure');
    await restarted.resync();
    expect(await registry.read(task.id)).toMatchObject({
      state: before.state,
      terminalReasonCode: before.terminalReasonCode,
      terminalAt: before.terminalAt,
      sealReceipt: before.sealReceipt,
    });
    expect(await outcomes(task.id)).toEqual(event);
    expect(storage.seals.size).toBe(1);
  });
  it('hard Stop overrides an uncommitted success even when storage already sealed completed', async () => {
    const { task, proof } = await startTask();
    await storage.mark(result);
    await mailbox.append(report(task), proof);
    let receiptSaved = false;
    const racing = new Proxy(registry, {
      get(target, property) {
        if (property === 'recordSealReceipt')
          return async (...args: Parameters<TaskRegistry['recordSealReceipt']>) => {
            const saved = await target.recordSealReceipt(...args);
            receiptSaved = true;
            // Stop wins between receipt persistence and the terminal transaction.
            await target.beginFinalization(task.id, task.launchId, {
              state: 'stopped',
              reasonCode: 'owner_stop',
              summary: 'Stopped by owner',
            });
            return saved;
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    expect(await finalizer(racing).runOnce()).toBe(false);
    expect(receiptSaved).toBe(true);
    expect(await outcomes(task.id)).toHaveLength(0);
    expect(await registry.read(task.id)).toMatchObject({
      state: 'running',
      terminalCandidate: 'stopped',
    });
    await takeover();
    expect(await finalizer().runOnce()).toBe(true);
    const stopped = await assertFinished(task, 'stopped');
    expect(stopped.terminalReasonCode).toBe('owner_stop');
    expect(stopped.sealReceipt!.outcome).toBe('completed');
    expect(storage.seals.size).toBe(1);
  });
  it('stop cancels its registry SQL blocked on a task lock without closing another pool client', async () => {
    const { task, proof } = await startTask();
    await storage.mark(result);
    await mailbox.append(report(task), proof);
    const cancelled = new AbortController();
    const ownRegistry = createPostgresTaskRegistry({
      pool: stores.postgres,
      epoch,
      settings,
      signal: cancelled.signal,
    });
    // Enter finalization first so the blocked operation belongs to this
    // registry, not readTerminal on the separately cancellable mailbox.
    await ownRegistry.beginFinalization(task.id, task.launchId, {
      state: 'done',
      reasonCode: 'completed',
      summary: 'Finished task',
    });
    const component = createTaskFinalizer({
      registry: ownRegistry,
      mailbox,
      executor,
      storage: control(),
      bus,
      logger,
      cancelRegistry: () => cancelled.abort(),
    });
    stops.push(() => component.stop());
    const locker = await stores.postgres.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM core.tasks WHERE id=$1 FOR UPDATE', [task.id]);
      const pass = component.runOnce();
      const blocked = async () =>
        (
          await stores.postgres.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%core.tasks%' AND pid<>pg_backend_pid()`
          )
        ).rows[0].n;
      await expect.poll(blocked).toBe(1);
      await component.stop(Date.now() + 1000);
      expect(await pass).toBe(false);
      await expect.poll(blocked).toBe(0);
      expect((await locker.query('SELECT 42 AS n')).rows[0].n).toBe(42);
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
    }
    expect(await outcomes(task.id)).toHaveLength(0);
    expect(await finalizer().runOnce()).toBe(true);
    await assertFinished(task);
  });
});
