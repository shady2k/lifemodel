import { describe, expect, it, vi } from 'vitest';
import { executeToolCalls } from '../../src/layers/cognition/tool-executor.js';
import { filterToolsForContext } from '../../src/layers/cognition/loop-orchestrator.js';
import { buildSystemPrompt } from '../../src/layers/cognition/prompts/system-prompt.js';
import { buildTriggerPrompt } from '../../src/layers/cognition/prompts/trigger-prompt.js';
import { createDefaultAgentState } from '../../src/types/agent/state.js';
import { createStartTaskTool } from '../../src/layers/cognition/tools/core/start-task.js';
import { ToolRegistry } from '../../src/layers/cognition/tools/registry.js';
import { UncertainMutationError } from '../../src/layers/cognition/tools/mutation-error.js';
import type { ToolContext } from '../../src/layers/cognition/tools/types.js';
import type { LoopContext } from '../../src/layers/cognition/agentic-loop-types.js';
import type { Message } from '../../src/llm/provider.js';
import type { StartTaskIntent } from '../../src/types/intent.js';
import { createLoopState } from '../../src/types/cognition.js';
import { createSignal } from '../../src/types/signal.js';
import { TaskRegistryError, type TaskRecord } from '../../src/ports/tasks.js';
import { createTestLogger } from '../helpers/test-logger.js';

const imageRevision = `sha256:${'a'.repeat(64)}`;
const originalId = 'original-task';
const accepted = { id: 'accepted-redo', state: 'queued', redoOf: originalId } as TaskRecord;
const args = { briefing: 'Correct the result.', profile: 'small', redoOf: originalId };

function harness(type: 'task_outcome' | 'user_message' | 'thought' = 'task_outcome') {
  const logger = createTestLogger('silent');
  const registry = new ToolRegistry(logger);
  const readByLaunchKey = vi.fn<() => Promise<TaskRecord | null>>(async () => null);
  const applyStartTask = vi.fn(async (_intent: StartTaskIntent) => accepted);
  const tool = createStartTaskTool({ imageRevision, readByLaunchKey, applyStartTask });
  registry.registerTool(tool);
  const context = {
    userModel: {},
    agentState: createDefaultAgentState(),
    triggerSignal: createSignal(
      type,
      'test',
      { value: 1 },
      {
        data: {
          taskId: originalId,
          outcomeKey: 'outcome_original',
          state: 'failed',
          reasonCode: 'expected_outputs_missing',
          summary: 'Expected file missing.',
          objects: [],
        },
      }
    ),
  } as LoopContext;
  const toolContext = (): ToolContext => ({
    triggerType: type,
    recipientId: 'owner',
    correlationId: 'deciding-turn',
  });
  const state = createLoopState();
  const messages: Message[] = [];
  let callId = 0;
  const call = (input: Record<string, unknown> | string) =>
    executeToolCalls({
      toolCalls: [
        {
          id: `call-${String(++callId)}`,
          type: 'function',
          function: {
            name: 'core.startTask',
            arguments: typeof input === 'string' ? input : JSON.stringify(input),
          },
        },
      ],
      responseContent: null,
      messages,
      state,
      context,
      callbacks: undefined,
      toolRegistry: registry,
      logger,
      toolResultToIntent: () => null,
      buildToolContext: toolContext,
      onEscalate: () => context,
      compileIntents: () => [],
    });
  return {
    tool,
    registry,
    context,
    toolContext,
    state,
    messages,
    call,
    readByLaunchKey,
    applyStartTask,
  };
}

describe('startTask redo capability and effect budget', () => {
  it('keeps tool, system and outcome instructions aligned with inherited output contracts', () => {
    const h = harness();
    const prompts = [buildSystemPrompt(h.context, false), buildTriggerPrompt(h.context)];
    for (const prompt of prompts) {
      expect(prompt).toContain('omit expectedOutputs or repeat the original names in any order');
      expect(prompt).toContain('never change or weaken them');
      expect(prompt).toContain('file_not_text');
      expect(prompt).toContain('cannot inspect its binary contents');
    }
    expect(h.tool.description).not.toContain('redoOf');
    const outcomeTool = filterToolsForContext(
      h.registry.getToolsAsOpenAIFormat(),
      h.context,
      false
    )[0]!;
    expect(outcomeTool.function.description).toContain('It inherits the original expected files');
    expect(outcomeTool.function.description).toContain(
      'omit expectedOutputs or repeat the original names in any order'
    );
  });
  it('advertises redoOf only for this exact original outcome', () => {
    const h = harness();
    const general = h.registry
      .getToolsAsOpenAIFormat()
      .find((t) => t.function.name === 'core_startTask')!;
    expect(general.function.parameters.properties).not.toHaveProperty('redoOf');
    expect(general.function.description).not.toContain('redoOf');
    const outcome = filterToolsForContext([general], h.context, false)[0]!;
    expect(outcome.function).toMatchObject({
      parameters: {
        properties: { redoOf: { enum: [originalId] } },
        required: ['briefing', 'profile', 'redoOf'],
      },
    });
  });

  it.each(['user_message', 'thought'] as const)(
    'rejects an injected redoOf on %s before replay lookup or writing',
    async (type) => {
      const h = harness(type);
      h.readByLaunchKey.mockResolvedValue(accepted);
      await h.call(args);
      expect(h.messages.at(-1)?.content).toContain('redo_not_allowed');
      expect(h.readByLaunchKey).not.toHaveBeenCalled();
      expect(h.applyStartTask).not.toHaveBeenCalled();
      expect(h.state.toolCallCounts.get('core.startTask')).toBeUndefined();
      expect(await h.tool.execute(args, h.toolContext())).toEqual({
        success: false,
        code: 'redo_not_allowed',
      });
      expect(h.applyStartTask).not.toHaveBeenCalled();
      expect(await h.tool.recoverAcceptedEffect!(h.toolContext())).toBeUndefined();
    }
  );

  it('rejects a fresh wrong original ID but allows a corrected exact-ID call in the same turn', async () => {
    const h = harness();
    await h.call({ ...args, redoOf: 'other-original' });
    expect(h.applyStartTask).not.toHaveBeenCalled();
    expect(h.messages.at(-1)?.content).toContain('task_outcome_requires_final_reply');
    await h.call(args);
    expect(h.applyStartTask).toHaveBeenCalledTimes(1);
    expect(h.state.toolCallCounts.get('core.startTask')).toBe(1);
  });

  it('rejects direct execution without the trusted outcome capability even with an outcome trigger', async () => {
    const h = harness();
    expect(await h.tool.execute(args, h.toolContext())).toEqual({
      success: false,
      code: 'redo_not_allowed',
    });
    expect(
      await h.tool.execute(args, {
        ...h.toolContext(),
        taskOutcome: { taskId: 'other-task', redoAllowed: true },
      })
    ).toEqual({ success: false, code: 'redo_not_allowed' });
    expect(h.applyStartTask).not.toHaveBeenCalled();
  });

  it('lets validation and invalid_input refusals retry correctly without spending the one effect slot', async () => {
    const h = harness();
    h.applyStartTask.mockImplementation(async (intent) => {
      if (intent.payload.expectedOutputs?.includes('changed.txt'))
        throw new TaskRegistryError('redo', 'invalid_input');
      return accepted;
    });
    await h.call({ profile: 'small', redoOf: originalId });
    expect(h.applyStartTask).not.toHaveBeenCalled();
    await h.call({ ...args, expectedOutputs: ['changed.txt'] });
    expect(h.messages.at(-1)?.content).toContain('invalid_input');
    expect(h.state.toolCallCounts.get('core.startTask') ?? 0).toBe(0);
    await h.call({ ...args, expectedOutputs: ['second.txt', 'first.txt'] });
    expect(h.applyStartTask).toHaveBeenCalledTimes(2);
    expect(h.messages.at(-1)?.content).toContain('accepted-redo');
    expect(h.state.toolCallCounts.get('core.startTask')).toBe(1);
    await h.call(args);
    expect(h.applyStartTask).toHaveBeenCalledTimes(2);
    expect(h.messages.at(-1)?.content).toContain('limit reached');
  });

  it('stops an outcome redo on uncertain in-loop recovery without executing the start', async () => {
    const h = harness();
    const execute = vi.spyOn(h.registry, 'execute');
    h.readByLaunchKey.mockRejectedValue(new Error('transient read failure'));

    const outcome = await h.call(args);

    expect(outcome).toEqual({ type: 'continue', messages: h.messages });
    expect(h.state.taskRedoRecoveryUncertain).toBe(true);
    expect(h.readByLaunchKey).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(h.applyStartTask).not.toHaveBeenCalled();
    expect(h.state.executedTools).toEqual([]);
    expect(h.state.toolResults).toEqual([]);
    expect(h.state.toolCallCounts.get('core.startTask')).toBeUndefined();
  });

  it.each(['user_message', 'thought'] as const)(
    'rethrows uncertain recovery unchanged outside an outcome on %s',
    async (type) => {
      const h = harness(type);
      const error = new UncertainMutationError();
      h.tool.recoverAcceptedEffect = vi.fn(async () => {
        throw error;
      });

      await expect(h.call({ briefing: args.briefing, profile: args.profile })).rejects.toBe(error);

      expect(h.state.taskRedoRecoveryUncertain).not.toBe(true);
      expect(h.applyStartTask).not.toHaveBeenCalled();
    }
  );

  it('rethrows other outcome recovery errors unchanged', async () => {
    const h = harness();
    const error = new Error('unexpected recovery failure');
    h.tool.recoverAcceptedEffect = vi.fn(async () => {
      throw error;
    });

    await expect(h.call(args)).rejects.toBe(error);

    expect(h.state.taskRedoRecoveryUncertain).not.toBe(true);
    expect(h.applyStartTask).not.toHaveBeenCalled();
  });

  it('keeps the reserved slot when execution may have written before a storage failure', async () => {
    const h = harness();
    h.applyStartTask.mockRejectedValue(new TaskRegistryError('redo', 'storage_error'));
    await expect(h.call(args)).rejects.toBeInstanceOf(UncertainMutationError);
    expect(h.state.taskRedoRecoveryUncertain).not.toBe(true);
    expect(h.readByLaunchKey).toHaveBeenCalledTimes(1);
    expect(h.applyStartTask).toHaveBeenCalledTimes(1);
    expect(h.state.toolCallCounts.get('core.startTask')).toBe(1);
    await h.call(args);
    expect(h.applyStartTask).toHaveBeenCalledTimes(1);
    expect(h.messages.at(-1)?.content).toContain('limit reached');
  });

  it.each(['malformed-json', { redoOf: 'regenerated-wrong-id' }])(
    'recovers only a stored redo belonging to this trusted outcome before payload validation: %j',
    async (input) => {
      const h = harness();
      h.readByLaunchKey.mockResolvedValue(accepted);
      await h.call(input);
      expect(h.messages.at(-1)?.content).toContain('accepted-redo');
      expect(h.applyStartTask).not.toHaveBeenCalled();
      const wrong = harness();
      wrong.readByLaunchKey.mockResolvedValue({ ...accepted, redoOf: 'other-original' });
      await wrong.call(input);
      expect(wrong.messages.at(-1)?.content).not.toContain('accepted-redo');
      expect(wrong.applyStartTask).not.toHaveBeenCalled();
    }
  );
});
