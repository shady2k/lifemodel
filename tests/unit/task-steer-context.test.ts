import { describe, expect, it } from 'vitest';
import { executeToolCalls } from '../../src/layers/cognition/tool-executor.js';
import { addPreviousAttemptMessages } from '../../src/layers/cognition/messages/retry-builder.js';
import { ToolRegistry } from '../../src/layers/cognition/tools/registry.js';
import type { ToolContext } from '../../src/layers/cognition/tools/types.js';
import type { LoopContext } from '../../src/layers/cognition/agentic-loop-types.js';
import { createLoopState } from '../../src/types/cognition.js';
import { createUserMessageSignal } from '../../src/types/signal.js';
import { createTestLogger } from '../helpers/test-logger.js';

describe('task steering context isolation', () => {
  it('passes a separate identity map only to core.steerTask, including recovery', async () => {
    const logger = createTestLogger();
    const registry = new ToolRegistry(logger);
    const state = createLoopState();
    const seen: { name: string; phase: string; context: ToolContext | undefined }[] = [];
    for (const name of ['core.steerTask', 'test.observer']) {
      registry.registerTool({
        name,
        description: 'context probe',
        parameters: [],
        validate: () => ({ success: true }),
        recoverAcceptedEffect: async (context) => {
          seen.push({ name, phase: 'recover', context });
          return undefined;
        },
        execute: async (_args, context) => {
          seen.push({ name, phase: 'execute', context });
          context?.taskSteerCounts?.set('taskSteer:task', 1);
          return { success: true };
        },
      });
    }
    const context = {
      triggerSignal: createUserMessageSignal({
        text: 'guide',
        channel: 'test',
        recipientId: 'owner',
      }),
    } as LoopContext;
    await executeToolCalls({
      toolCalls: ['core.steerTask', 'test.observer'].map((name, i) => ({
        id: String(i),
        type: 'function',
        function: { name, arguments: '{}' },
      })),
      responseContent: null,
      messages: [],
      state,
      context,
      callbacks: undefined,
      toolRegistry: registry,
      logger,
      toolResultToIntent: () => null,
      buildToolContext: () => ({}),
      onEscalate: () => context,
      compileIntents: () => [],
    });
    expect(seen.map(({ name, phase }) => [name, phase])).toEqual([
      ['core.steerTask', 'recover'],
      ['core.steerTask', 'execute'],
      ['test.observer', 'recover'],
      ['test.observer', 'execute'],
    ]);
    for (const probe of seen) {
      if (probe.name === 'core.steerTask') {
        expect(probe.context?.taskSteerCounts).toBe(state.taskSteerCounts);
        expect(probe.context?.taskSteerCounts).not.toBe(state.toolCallCounts);
      } else expect(probe.context).not.toHaveProperty('taskSteerCounts');
    }
    expect([...state.taskSteerCounts]).toEqual([['taskSteer:task', 1]]);
    expect([...state.toolCallCounts]).toEqual([
      ['core.steerTask', 1],
      ['test.observer', 1],
    ]);
  });

  it('restores steer identity without restoring unrelated call limits on escalation', () => {
    const state = createLoopState();
    addPreviousAttemptMessages(
      [],
      {
        reason: 'deeper reasoning',
        executedTools: [],
        toolResults: [],
        taskSteerCounts: [['taskSteer:task', 2]],
      },
      state
    );
    expect([...state.taskSteerCounts]).toEqual([['taskSteer:task', 2]]);
    expect(state.toolCallCounts.size).toBe(0);
  });
});
