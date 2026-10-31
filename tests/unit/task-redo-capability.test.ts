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
  it('refuses the reserved report name without consuming maxCallsPerTurn', async () => {
    const h = harness('user_message');
    const input = { briefing: 'Save the work file.', profile: 'small' };
    await h.call({ ...input, expectedOutputs: ['task-report.txt'] });
    expect(h.messages.at(-1)?.content).toContain('reserved_output_name');
    expect(h.applyStartTask).not.toHaveBeenCalled();
    expect(h.state.toolCallCounts.get('core.startTask') ?? 0).toBe(0);
    await h.call({ ...input, expectedOutputs: ['result.txt'] });
    expect(h.applyStartTask).toHaveBeenCalledTimes(1);
    expect(h.state.toolCallCounts.get('core.startTask')).toBe(1);
  });

  it('puts the background-work judgment and its reasons beside INITIATIVE for user messages', () => {
    const h = harness('user_message');
    const prompt = buildSystemPrompt(h.context, false);
    const instructions = prompt.split('<instructions>')[1]!.split('</instructions>')[0]!;
    const initiative = instructions.split('INITIATIVE:')[1]!.split('\n')[0]!;
    const resourcefulness = instructions.split('RESOURCEFULNESS:')[1]!.split('\n')[0]!;
    expect(initiative).toContain(
      'When I know what the owner wants delivered from the request or conversation, I act at once'
    );
    expect(initiative).toContain('"yes, obviously" adds friction rather than understanding');
    expect(initiative).toContain(
      'Background work runs out of sight, takes time and comes back as files'
    );
    expect(initiative).toContain(
      'what to deliver and in what form is unclear or has several reasonable readings'
    );
    expect(initiative).toContain(
      'I first propose a concrete plan (what, range, form, files) and ask for agreement'
    );
    expect(initiative).toContain('a wrong guess costs the owner a wasted run and a redo');
    expect(initiative).toContain(
      '«Сделай мне в фоне отчёт по простым числам.» leaves the range and form open'
    );
    expect(initiative).toContain(
      '«Сохрани все простые числа меньше 500 в primes500.txt в фоне.» supplies the range, form and file, so I start at once'
    );
    expect(resourcefulness).toContain('I use my tools to find facts I need');
    expect(resourcefulness).toContain('choices about an unclear deliverable');
    expect(resourcefulness).toContain(
      'a search can supply facts but cannot decide what result the owner wants'
    );
    expect(instructions.indexOf('INITIATIVE:')).toBeLessThan(instructions.indexOf('IMPORTANT:'));
    expect(instructions.indexOf('RESOURCEFULNESS:')).toBeLessThan(
      instructions.indexOf('IMPORTANT:')
    );
  });

  it('has no unqualified instruction to act without asking in the assembled user_message system prompt', () => {
    const prompt = buildSystemPrompt(harness('user_message').context, false);
    expect(prompt).not.toMatch(
      /do not ask for confirmation|Ask the user ONLY|Exhaust ALL available tools/
    );
    // Inspect every action-without-asking statement in the assembled text, not a source slice.
    const actionStatements = prompt
      .split('\n')
      .filter((line) =>
        /act on it|act at once|start(?: a clear request)? at once|just act|just do them|things (?:I|you) can do RIGHT NOW|(?:do not|don't) (?:need|ask)|without (?:asking|confirmation|permission)/i.test(
          line
        )
      );
    expect(actionStatements.length).toBeGreaterThanOrEqual(4);
    for (const statement of actionStatements) {
      expect(statement).toMatch(/background work/i);
      expect(statement).toMatch(/unclear deliverable|what to deliver and in what form is unclear/i);
      expect(statement).toMatch(/agreed plan|agree a concrete plan|ask for agreement/i);
    }
  });

  it('explains ownership, plan versus result and accepted starts without forbidden-phrase lists', () => {
    const h = harness('user_message');
    const prompt = buildSystemPrompt(h.context, false);
    const ownership = prompt.split('<work_ownership>')[1]!.split('</work_ownership>')[0]!;
    expect(ownership).toContain('The work I delegate is my own work, and I answer for its result');
    expect(ownership).toContain(
      'what I started, what I checked, what did not work and what I am redoing'
    );
    expect(ownership).toContain(
      'The owner relies on my account to know what is ready and what still needs work'
    );
    expect(ownership).toContain('A plan is not a result');
    expect(ownership).toContain('the owner acts on what I say is already true');
    expect(ownership).toContain(
      'Saying I started is accurate only after core.startTask returned accepted in this turn'
    );
    expect(ownership).toContain('a refusal leaves the work unstarted');
    expect(ownership).toContain('agree a concrete plan first');
    expect(ownership).toContain("a wrong guess wastes the owner's time");
    expect(ownership).toContain(
      'task-report.txt is reserved for my report, separate from the expected work outputs'
    );
    for (const text of [prompt, h.tool.description, buildTriggerPrompt(harness().context)]) {
      expect(text).not.toMatch(/never [«"](?:задача|the task)|not "the task"|Say «готово»/);
      expect(text).not.toContain('задача завершилась');
      expect(text).not.toContain('задача остановилась');
    }
  });

  it('describes my background work and the agreement boundary with reasons in the advertised tool', () => {
    const h = harness('user_message');
    const description = h.registry
      .getToolsAsOpenAIFormat()
      .find((tool) => tool.function.name === 'core_startTask')!.function.description;
    expect(description).toContain('I own the result of the work I delegate');
    expect(description).toContain(
      'When the request or conversation makes what to deliver and in what form clear, I start at once'
    );
    expect(description).toContain('asking for an obvious confirmation adds friction');
    expect(description).toContain(
      'Background work runs out of sight, takes time and comes back as files'
    );
    expect(description).toContain(
      'I first propose a concrete plan (what, range, form, files) and ask'
    );
    expect(description).toContain('a wrong guess costs the owner a wasted run and a redo');
    expect(description).toContain('«Сделай мне в фоне отчёт по простым числам.»');
    expect(description).toContain('«Сохрани все простые числа меньше 500 в primes500.txt в фоне.»');
    expect(description).toContain(
      'what I started, what I checked, what did not work and what I am redoing'
    );
    expect(description).toContain(
      'Saying I started is accurate only after this tool returns accepted in this turn'
    );
    expect(description).toContain('the owner acts on what I say is already true');
    expect(description).toContain('A plan is not a result');
    expect(description).toContain('I check the delivered files before I report a result');
  });

  it('reports my accepted start in first person with the later verification still outstanding', async () => {
    const h = harness('user_message');
    const input = {
      briefing: 'Save primes500.txt.',
      profile: 'small',
      expectedOutputs: ['primes500.txt'],
    };
    const result = await h.tool.execute(input, h.toolContext());
    expect(h.applyStartTask).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ success: true, taskId: accepted.id, state: 'queued' });
    const message = (result as { message: string }).message;
    expect(message).toContain('I have started the work in the background in this turn');
    expect(message).toContain('I own the result');
    expect(message).toContain('The outcome comes later');
    expect(message).toContain(
      "I will check the delivered files against the owner's request before I report a result"
    );
    expect(message).not.toMatch(/Accepted in background|the task was accepted|You may now say/);
    h.readByLaunchKey.mockResolvedValue({ ...accepted, redoOf: undefined });
    expect(await h.tool.recoverAcceptedEffect!(h.toolContext())).toEqual(result);
    h.applyStartTask.mockRejectedValue(new TaskRegistryError('refused', 'invalid_input'));
    expect(await h.tool.execute(input, h.toolContext())).toEqual({
      success: false,
      code: 'invalid_input',
    });
  });

  it('keeps outcome ownership grounded in verification and untrusted claims', () => {
    const prompt = buildTriggerPrompt(harness().context);
    expect(prompt).toContain('I answer for its result because the work I delegate is my own');
    expect(prompt).toContain("I verify before replying in the owner's language");
    expect(prompt).toContain('what I checked, what did not work and what I am redoing');
    for (const text of [buildSystemPrompt(harness().context, false), prompt]) {
      expect(text).toContain('task-report.txt and transcript');
      expect(text).toMatch(/claims/i);
      expect(text).toContain('view="file"');
      expect(text).not.toContain('result.txt');
    }
  });

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
