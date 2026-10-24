import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestStores, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestLogger } from '../helpers/test-logger.js';
import {
  startInstance,
  waitFor,
  type CoreLoopInstance,
} from '../helpers/core-loop-drain-harness.js';
import { RealCognitionFacade } from '../helpers/core-loop-real-cognition.js';
import { createSnapshotStore } from '../../src/storage/snapshot-store.js';
import { createBusSignalStream, type BusSnapshot } from '../../src/core/bus-stream.js';
import { createPostgresTaskRegistry } from '../../src/storage/postgres-task-registry.js';
import { createPlatformSettingsReader } from '../../src/config/platform-settings.js';
import { createStartTaskTool } from '../../src/layers/cognition/tools/core/start-task.js';
import { createSignal, createUserMessageSignal } from '../../src/types/signal.js';
import { setPrimaryRecipientId } from '../../src/core/globals.js';
import type { TaskOutcomeEvent } from '../../src/ports/tasks.js';
import { createFakeTaskExecutor } from '../../src/core/fake-task-executor.js';
import { createTaskFinalizer } from '../../src/core/task-finalize.js';
import { createTaskLaunchReconciler } from '../../src/core/task-launch.js';
import { createStorageControlClient } from '../../src/core/storage-control-client.js';
import { createFinalizerStorage } from '../helpers/finalizer-storage.js';
import { ConversationManager } from '../../src/storage/conversation-manager.js';
import { PostgresStorage } from '../../src/storage/postgres-storage.js';
import { applyCommittedOutboundEvents } from '../../src/core/message-streams.js';
import { ThresholdEngine } from '../../src/layers/aggregation/threshold-engine.js';
import { createAgent } from '../../src/core/agent.js';
import { createMetrics } from '../../src/core/metrics.js';
import { RecipientRegistry } from '../../src/core/recipient-registry.js';

const imageRevision = `sha256:${'a'.repeat(64)}`;
const startScript = [
  {
    toolCalls: [
      {
        name: 'core.startTask',
        args: { briefing: 'Research and save the answer.', profile: 'small' },
      },
    ],
  },
  { content: 'Started. I will reply when it is done.' },
];
const object = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'answer.txt',
  size: 42,
  sha256: 'a'.repeat(64),
  mark: 'result',
};

describe('task conversation replies (real Postgres and Valkey)', () => {
  let stores: TestStores;
  const instances: CoreLoopInstance[] = [];
  const logger = createTestLogger();
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
  });
  beforeEach(async () => {
    await stores.postgres.query('TRUNCATE core.tasks CASCADE');
  });
  afterEach(async () => {
    for (const instance of instances.splice(0)) await instance.coreLoop.stop();
    setPrimaryRecipientId(undefined);
  });
  afterAll(async () => {
    await stores.postgres.end();
    await stores.redis.quit();
  });

  async function boot(prefix: string, script = startScript, crashBeforeAnswerCommit = false) {
    const snapshot = createSnapshotStore(stores.redis, { keyPrefix: prefix });
    const bus = createBusSignalStream(stores.redis, prefix);
    snapshot.register(bus);
    const epoch = await snapshot.takeEpoch();
    await stores.postgres.query(
      'INSERT INTO core.active_holder VALUES(true,$1) ON CONFLICT(id) DO UPDATE SET epoch=$1',
      [epoch]
    );
    const registry = createPostgresTaskRegistry({
      pool: stores.postgres,
      epoch,
      settings: createPlatformSettingsReader({ logger, dir: '/missing-task-reply-settings' }),
      imageRevision,
    });
    const instance = await startInstance('', {
      cognitionMode: 'real-scripted',
      script,
      busSignalStream: bus,
      initialBusOffset: (await snapshot.read())?.sections['busOffset'] as BusSnapshot | undefined,
      commitSnapshot: async (tick, outbox) => {
        if (crashBeforeAnswerCommit && outbox.length > 0)
          throw new Error('crash before answer CAS');
        await snapshot.commitOwners(epoch, tick, outbox);
      },
    });
    instance.coreLoop.setTaskService(registry);
    instances.push(instance);
    setPrimaryRecipientId(instance.recipientId);
    const cognition = instance.cognition as unknown as RealCognitionFacade;
    cognition.processor.getToolRegistry().registerTool(
      createStartTaskTool({
        applyStartTask: (intent) => instance.coreLoop.applyStartTask(intent),
        imageRevision,
      })
    );
    const events = async () =>
      (await stores.redis.xrange(`${prefix}outbound`, '-', '+')).map(
        ([, fields]) =>
          JSON.parse(fields[fields.indexOf('event') + 1]!) as {
            eventId: string;
            payload: { text: string; attachments?: unknown[] };
          }
      );
    return { ...instance, snapshot, bus, registry, cognition, events };
  }
  function outcome(taskId: string, outcomeKey: string, state: TaskOutcomeEvent['state'] = 'done') {
    return createSignal(
      'task_outcome',
      'task.finalizer',
      { value: 1 },
      {
        data: {
          kind: 'task_outcome',
          taskId,
          outcomeKey,
          state,
          reasonCode: state === 'done' ? 'completed' : 'timeout',
          summary: state === 'done' ? 'The answer is 42.' : 'The task ran out of time.',
          objects: [object],
        },
      }
    );
  }
  it('answers at once with one queued task, then binds a result to one outcome reply, including duplicate relay and restart', async () => {
    const prefix = `task-reply:${randomUUID()}:`;
    const first = await boot(prefix, [...startScript, { content: 'The answer is 42.' }]);
    first.coreLoop.pushSignal(
      createUserMessageSignal({
        text: 'Do long research',
        recipientId: first.recipientId,
        channel: 'test',
        updateId: randomUUID(),
      })
    );
    await expect.poll(async () => (await first.events()).length).toBe(1);
    const tasks = await first.registry.list();
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.launchKey).toBe(
      `task|${first.recipientId}|${first.cognition.calls[0]!.context.tickId}|0`
    );
    expect(task.state).toBe('queued');
    const storage = await createFinalizerStorage(stores.postgres);
    const control = createStorageControlClient(storage);
    const executor = createFakeTaskExecutor();
    const launcher = createTaskLaunchReconciler({
      registry: first.registry,
      executor,
      storage: control,
      logger,
    });
    const finalizer = createTaskFinalizer({
      registry: first.registry,
      executor,
      storage: control,
      logger,
      bus: first.bus,
      mailbox: { readTerminal: async () => null },
    });
    try {
      // Compute remains fake; actual launch, seal, terminal outbox and relay run.
      expect(await launcher.runOnce()).toBe(true);
      await storage.mark(object);
      await first.registry.beginFinalization(task!.id, task!.launchId, {
        state: 'done',
        reasonCode: 'completed',
        summary: 'The answer is 42.',
      });
      expect(await finalizer.resync()).toBe(true);
      expect(executor.calls.filter((call) => call.operation === 'ensureStarted')).toHaveLength(1);
    } finally {
      await launcher.stop();
      await finalizer.stop();
      control.close();
      await storage.close();
    }
    const signal = outcome(task!.id, `outcome_${task!.launchId}`);
    await expect.poll(async () => (await first.events()).length).toBe(2);
    const reply = (await first.events())[1]!;
    expect(reply.payload).toMatchObject({
      text: 'The answer is 42.',
      attachments: [
        {
          artifactId: object.id,
          name: object.name,
          size: object.size,
          contentType: 'application/octet-stream',
        },
      ],
    });
    expect(reply.eventId).not.toBe((await first.events())[0]!.eventId);
    await first.coreLoop.fenceForTest();
    const beforeRestart = await first.snapshot.read();
    expect(beforeRestart?.sections['busOffset']).toEqual(first.bus.exportSnapshot());
    expect(Object.values(first.bus.exportSnapshot().entries)).toEqual([]);
    const restarted = await boot(prefix, [{ content: 'Still here.' }]);
    expect(restarted.bus.exportSnapshot()).toEqual(beforeRestart?.sections['busOffset']);
    const receipt = await restarted.bus.append({ ...signal, id: randomUUID() });
    expect(
      (await restarted.bus.readAfter('0-0', 100)).filter((e) => e.signal.type === 'task_outcome')
    ).toHaveLength(1);
    expect(receipt).toMatch(/^\d+-\d+$/);
    expect(await restarted.events()).toHaveLength(2);
    expect(restarted.cognition.calls).toHaveLength(0);
    const conversation = new ConversationManager(new PostgresStorage(stores.postgres), logger);
    await applyCommittedOutboundEvents(
      stores.redis,
      conversation,
      `${prefix}pg-applied`,
      `${prefix}outbound`
    );
    const history = await conversation.getFullHistory(first.recipientId);
    const bound = history.filter(
      (message) =>
        message.role === 'assistant' &&
        message.attachments?.some((item) => item.artifactId === object.id)
    );
    expect(bound).toHaveLength(1);
    expect(bound[0]!.content).toBe('The answer is 42.');
    // Applying the committed rows trims outbound; verify the actual boundary.
    expect(await restarted.events()).toEqual([]);
    // Durable admission receipt survives both bus and outbound trimming.
    await restarted.bus.trimBefore('9999999999999999-0');
    await restarted.bus.append({ ...signal, id: randomUUID() });
    expect(await restarted.bus.readAfter('0-0', 100)).toEqual([]);
    // Observe a subsequent committed turn, not a timer or a tick count: the
    // duplicate must not consume a model turn or recreate an attached reply.
    const followUp = createUserMessageSignal({
      text: 'Are you still here?',
      recipientId: restarted.recipientId,
      channel: 'test',
      updateId: randomUUID(),
    });
    restarted.coreLoop.pushSignal(followUp);
    await expect.poll(async () => (await restarted.events()).length).toBe(1);
    expect(
      restarted.cognition.calls.map((call) =>
        call.context.triggerSignals.map((entry) => ({
          id: entry.id,
          type: entry.type,
        }))
      )
    ).toEqual([[{ id: followUp.id, type: 'user_message' }]]);
    expect((await restarted.events())[0]!.payload).toMatchObject({ text: 'Still here.' });
    expect((await restarted.events())[0]!.payload.attachments).toBeUndefined();
  });
  it('reuses the deciding turn effect after a crash before commit: one task and one immediate reply', async () => {
    const prefix = `task-reply-crash:${randomUUID()}:`;
    const first = await boot(prefix, startScript, true);
    first.coreLoop.pushSignal(
      createUserMessageSignal({
        text: 'Do long research',
        recipientId: first.recipientId,
        channel: 'test',
        updateId: randomUUID(),
      })
    );
    await waitFor(() => first.coreLoop.stopReport().loopStopped, 'failed answer CAS');
    expect(await first.events()).toHaveLength(0);
    const turn = first.cognition.calls[0]!.context.tickId;
    const before = await first.registry.list();
    expect(before).toHaveLength(1);
    expect(before[0]!.launchKey).toBe(`task|${first.recipientId}|${turn}|0`);
    const restarted = await boot(prefix);
    await expect.poll(async () => (await restarted.events()).length).toBe(1);
    expect(restarted.cognition.calls[0]!.context.tickId).toBe(turn);
    const after = await restarted.registry.list();
    expect(after).toHaveLength(1);
    expect(after[0]!.launchKey).toBe(`task|${first.recipientId}|${turn}|0`);
    expect(after.map((t) => t.id)).toEqual(before.map((t) => t.id));
  });
  it('replays an outcome turn after a crash before the reply commit with the same attachment and one event', async () => {
    const prefix = `task-outcome-crash:${randomUUID()}:`;
    const script = [{ content: 'The answer is 42.' }];
    const first = await boot(prefix, script, true);
    const signal = outcome('task_outcome_crash', 'outcome_crash');
    first.coreLoop.pushSignal(signal);
    await waitFor(() => first.coreLoop.stopReport().loopStopped, 'outcome answer CAS failed');
    const turn = first.cognition.calls[0]!.context.tickId;
    expect(await first.events()).toHaveLength(0);
    const restarted = await boot(prefix, script);
    await expect.poll(async () => (await restarted.events()).length).toBe(1);
    expect(restarted.cognition.calls[0]!.context.tickId).toBe(turn);
    expect((await restarted.events())[0]!.payload.attachments).toHaveLength(1);
  });
  it('reports two outcomes from the same batch in separate turns, without losing the second', async () => {
    const prefix = `task-outcome-batch:${randomUUID()}:`;
    const instance = await boot(prefix, [{ content: 'First done.' }, { content: 'Second done.' }]);
    await Promise.all([
      instance.bus.append(outcome('task_1', 'outcome_1')),
      instance.bus.append(outcome('task_2', 'outcome_2')),
    ]);
    await expect.poll(async () => (await instance.events()).length).toBe(2);
    expect(instance.cognition.calls.map((call) => call.context.triggerSignals.length)).toEqual([
      1, 1,
    ]);
    expect(instance.cognition.calls.map((call) => call.context.triggerSignals[0]!.id)).toEqual([
      'outcome_1',
      'outcome_2',
    ]);
  });
  it('answers owner input first in a mixed batch and keeps the task outcome for its attached reply', async () => {
    const prefix = `task-mixed-batch:${randomUUID()}:`;
    const bus = createBusSignalStream(stores.redis, prefix);
    const recipientId = new RecipientRegistry().getOrCreate('test', 'chat-42');
    const message = createUserMessageSignal({
      text: 'How are you?',
      recipientId,
      channel: 'test',
      updateId: randomUUID(),
    });
    // Queue both before start, outcome first: priority must follow the real
    // threshold decision, not arrival order or the harness's wake-all double.
    await bus.append(outcome('task_mixed', 'outcome_mixed'));
    await bus.append(message);
    const instance = await boot(prefix, [
      { content: 'I am here.' },
      { content: 'The answer is 42.' },
    ]);
    const engine = new ThresholdEngine(logger);
    instance.aggregation.process = async (signals, state) => {
      instance.aggregation.batches.push([...signals]);
      const wake = await engine.evaluate(
        signals,
        [],
        state as Parameters<typeof engine.evaluate>[2]
      );
      return {
        wakeCognition: wake.shouldWake,
        wakeReason: wake.reason ?? 'test',
        aggregates: [],
        triggerSignals: wake.triggerSignals,
        intents: [],
      };
    };
    await expect.poll(async () => (await instance.events()).length).toBe(2);
    expect(instance.aggregation.batches[0]!.map((signal) => signal.type)).toEqual([
      'task_outcome',
      'user_message',
    ]);
    expect(
      instance.cognition.calls.map((call) => call.context.triggerSignals.map((signal) => signal.id))
    ).toEqual([[message.id], ['outcome_mixed']]);
    const replies = await instance.events();
    expect(replies[0]!.payload).toMatchObject({ text: 'I am here.' });
    expect(replies[0]!.payload.attachments).toBeUndefined();
    expect(replies[1]!.payload).toMatchObject({
      text: 'The answer is 42.',
      attachments: [{ artifactId: object.id }],
    });
  });
  it('wakes for one task outcome even below the energy gate', async () => {
    const engine = new ThresholdEngine(logger);
    const agent = createAgent({ logger, metrics: createMetrics() });
    const signals = [outcome('task_1', 'outcome_1'), outcome('task_2', 'outcome_2')];
    const wake = await engine.evaluate(signals, [], { ...agent.getState(), energy: 0 });
    expect(wake).toMatchObject({
      shouldWake: true,
      trigger: 'task_outcome',
      triggerSignals: [signals[0]],
    });
  });
  it('refuses missing outcome fields and unknown profiles without creating work', async () => {
    const prefix = `task-reply-invalid:${randomUUID()}:`;
    const instance = await boot(prefix);
    const signal = outcome('task_invalid', 'outcome_invalid');
    await expect(
      instance.bus.append({ ...signal, data: { ...signal.data, reasonCode: undefined } } as never)
    ).rejects.toThrow('Invalid task outcome');
    const tool = createStartTaskTool({
      applyStartTask: (intent) => instance.coreLoop.applyStartTask(intent),
      imageRevision,
    });
    expect(
      await tool.execute(
        { briefing: 'test', profile: 'unknown' },
        {
          recipientId: instance.recipientId,
          correlationId: randomUUID(),
          triggerType: 'user_message',
        }
      )
    ).toEqual({ success: false, code: 'unknown_profile' });
    expect(await instance.bus.readAfter('0-0', 10)).toEqual([]);
  });
  it('propagates uncertain acceptance past the tool registry instead of letting a normal reply complete it', async () => {
    const prefix = `task-accept-unknown:${randomUUID()}:`;
    const instance = await boot(prefix);
    let committedId: string | undefined;
    const tool = createStartTaskTool({
      imageRevision,
      applyStartTask: async (intent) => {
        committedId = (await instance.coreLoop.applyStartTask(intent)).id;
        throw new Error('lost commit reply');
      },
    });
    instance.cognition.processor.getToolRegistry().registerTool(tool);
    await expect(
      instance.cognition.processor.getToolRegistry().execute({
        toolCallId: 'unstable-model-id',
        name: 'core.startTask',
        args: { briefing: 'test lost reply', profile: 'small' },
        context: {
          recipientId: instance.recipientId,
          correlationId: 'deciding-turn',
          triggerType: 'user_message',
        },
      })
    ).rejects.toThrow('Durable mutation outcome uncertain');
    const replay = createStartTaskTool({
      imageRevision,
      applyStartTask: (intent) => instance.coreLoop.applyStartTask(intent),
    });
    expect(
      await replay.execute(
        { briefing: 'test lost reply', profile: 'small' },
        {
          recipientId: instance.recipientId,
          correlationId: 'deciding-turn',
          triggerType: 'user_message',
        }
      )
    ).toMatchObject({ success: true, taskId: committedId });
    expect(await instance.registry.list()).toHaveLength(1);
  });
  it('keeps all 21 results in bounded attachment continuations and does not strand unpresentable metadata', async () => {
    const prefix = `task-reply-many:${randomUUID()}:`;
    const instance = await boot(prefix, [
      { content: 'All files are ready.' },
      { content: 'The work ended.' },
    ]);
    const signal = outcome('task_many', 'outcome_many');
    const objects = Array.from({ length: 21 }, () => ({ ...object, id: randomUUID() }));
    await instance.bus.append({ ...signal, data: { ...signal.data, objects } } as never);
    await expect.poll(async () => (await instance.events()).length).toBe(2);
    const pages = await instance.events();
    expect(pages.map((page) => page.payload.attachments?.length)).toEqual([20, 1]);
    expect(
      pages
        .flatMap((page) => page.payload.attachments)
        .map((entry) => (entry as { artifactId: string }).artifactId)
    ).toEqual(objects.map((entry) => entry.id));
    await instance.bus.append({
      ...signal,
      data: {
        ...signal.data,
        outcomeKey: 'outcome_bad_metadata',
        objects: [{ ...object, name: 'я'.repeat(1000) }],
      },
    } as never);
    await expect.poll(async () => (await instance.events()).length).toBe(3);
    expect((await instance.events())[2]!.payload).toMatchObject({
      text: expect.stringContaining('could not be attached'),
    });
    expect((await instance.events())[2]!.payload.attachments).toBeUndefined();
  });
  it('refuses a model-requested intermediate message on outcomes and attaches the final reply', async () => {
    const instance = await boot(`task-no-teaser:${randomUUID()}:`, [
      { toolCalls: [{ name: 'core.say', args: { text: 'unattached teaser' } }] },
      { content: 'The answer is 42.' },
    ]);
    instance.coreLoop.pushSignal(outcome('task_no_teaser', 'outcome_no_teaser'));
    await expect.poll(async () => (await instance.events()).length).toBe(1);
    expect((await instance.events())[0]!.payload).toMatchObject({
      text: 'The answer is 42.',
      attachments: [{ artifactId: object.id }],
    });
  });
  it.each(['failed', 'stopped'] as const)(
    'reports %s honestly without presenting partial objects as a result',
    async (state) => {
      const prefix = `task-reply-failure:${randomUUID()}:`;
      const instance = await boot(prefix, [
        { content: 'The task ran out of time. No completed result is available.' },
      ]);
      instance.coreLoop.pushSignal(outcome('task_failed', 'outcome_failed', state));
      await expect.poll(async () => (await instance.events()).length).toBe(1);
      expect((await instance.events())[0]!.payload).toMatchObject({
        text: expect.stringContaining('ran out of time'),
      });
      expect((await instance.events())[0]!.payload.attachments).toBeUndefined();
      expect(
        instance.cognition.provider.requests[0]!.messages.map((m) => m.content).join(' ')
      ).toContain('timeout');
    }
  );
});
