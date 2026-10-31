import { describe, expect, it, vi } from 'vitest';
import { executeToolCalls } from '../../src/layers/cognition/tool-executor.js';
import { filterToolsForContext } from '../../src/layers/cognition/loop-orchestrator.js';
import { buildSystemPrompt } from '../../src/layers/cognition/prompts/system-prompt.js';
import { buildTriggerPrompt } from '../../src/layers/cognition/prompts/trigger-prompt.js';
import { buildActiveDesiresSection } from '../../src/layers/cognition/prompts/context-sections.js';
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

// Split assembled prose, not source lines: one paragraph can contain conflicting sentences.
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

const actNowPattern =
  /act (?:now|on it|at once)|just act|do (?:it|them) now|without asking|(?:don't|do not) ask|no confirmation|don't need permission|start(?: a clear request)? at once|(?:things you can do|explore it) right now/i;

const reviewedActNowSentences = {
  system: [
    'When you notice something you genuinely want to learn, explore, or do — act on it, with an agreed plan first for background work whose deliverable is unclear.',
    "You don't need permission to be curious; background work with an unclear deliverable needs an agreed plan, as described below.",
    'If a user mentions something interesting, you can explore it right now with your tools, with an agreed plan first for background work whose deliverable is unclear.',
    'INITIATIVE: When you know what the owner wants delivered from the request or conversation, you act at once; background work with an unclear deliverable needs an agreed plan first.',
    '«Сохрани все простые числа меньше 500 в primes500.txt в фоне.» supplies the range, form and file for the background work, so you start at once; an unclear deliverable would need an agreed plan first.',
    'Once the owner agrees to your proposed plan for background work with an unclear deliverable, that plan is the request and you start it without asking again.',
    'For things you can do RIGHT NOW, you act using the same judgment as INITIATIVE: background work with an unclear deliverable starts with an agreed plan.',
    "The same distinction between a clear request and an unclear deliverable applies to my background work: I start a clear request at once, and agree a concrete plan first when the request or conversation leaves what to deliver or its form open, because a wrong guess wastes the owner's time.",
    'Once the owner agrees to that plan for background work with an unclear deliverable, it becomes the request; I start it without asking again.',
  ],
  startTask: [
    'When the request or conversation makes what to deliver and in what form clear, I start at once; asking for an obvious confirmation adds friction.',
    'Once the owner agrees to my proposed plan for background work with an unclear deliverable, that plan is the request and I start it without asking again.',
  ],
};

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

  it.each([
    'ownership',
    'read trust',
    'briefing',
    'expectedOutputs',
    'outcome',
    'refusal',
  ] as const)(
    'explains the system-written report and a separate summary work file in %s',
    async (surface) => {
      const h = harness('user_message');
      const prompt = buildSystemPrompt(h.context, false);
      const reportParagraphs = prompt
        .split('\n')
        .filter((line) => line.includes('task-report.txt'));
      // Both system mentions need their own explanation, not a distant disclaimer.
      expect(reportParagraphs).toHaveLength(2);
      const advertised = h.registry
        .getToolsAsOpenAIFormat()
        .find((tool) => tool.function.name === 'core_startTask')!;
      const refusal = await h.tool.execute(
        { briefing: 'Save the work file.', profile: 'small', expectedOutputs: ['task-report.txt'] },
        h.toolContext()
      );
      expect(refusal).toMatchObject({ success: false, code: 'reserved_output_name' });
      const surfaces = {
        ownership: reportParagraphs[0]!,
        'read trust': reportParagraphs[1]!,
        briefing: advertised.function.parameters.properties['briefing'].description,
        expectedOutputs: advertised.function.parameters.properties['expectedOutputs'].description,
        outcome: buildTriggerPrompt(harness().context)
          .split('\n')
          .filter((line) => line.includes('task-report.txt'))
          .join('\n'),
        refusal: (refusal as { message: string }).message,
      };
      const text = surfaces[surface];
      // Meaning pins, not whole-sentence snapshots: who writes what, why and how to recover.
      expect(text).toContain('task-report.txt');
      expect(text).toMatch(
        /system saves the work's final message (?:as task-report\.txt|under that name) beside the delivered files/i
      );
      expect(text).toMatch(/work does not write this file/);
      expect(text).toMatch(/Asking the work to write it makes the run fail/);
      expect(text).toMatch(
        /work's own claim about what it did.*checked against the delivered files/
      );
      expect(text).toMatch(
        /owner wants a summary file.*work file.*summary\.txt.*briefing and expectedOutputs/
      );
      expect(text).not.toContain('reserved for my report');
      expect(h.applyStartTask).not.toHaveBeenCalled();
    }
  );

  it('puts the background-work judgment and its reasons beside INITIATIVE for user messages', () => {
    const prompt = buildSystemPrompt(harness('user_message').context, false);
    const instructions = prompt.split('<instructions>')[1]!.split('</instructions>')[0]!;
    const initiative = instructions.split('INITIATIVE:')[1]!.split('RESOURCEFULNESS:')[0]!;
    const resourcefulness = instructions.split('RESOURCEFULNESS:')[1]!.split('IMPORTANT:')[0]!;
    expect(initiative).toMatch(/know what the owner wants delivered.*act at once/);
    expect(initiative).toMatch(/obviously.*friction/);
    expect(initiative).toMatch(/Background work runs out of sight.*takes time.*files/);
    expect(initiative).toMatch(/unclear.*propose a concrete plan.*ask for agreement/s);
    expect(initiative).toMatch(/wrong guess.*wasted run.*redo/);
    expect(initiative).toContain('«Сделай мне в фоне отчёт по простым числам.»');
    expect(initiative).toContain('«Сохрани все простые числа меньше 500 в primes500.txt в фоне.»');
    expect(resourcefulness).toMatch(/tools to find facts.*search the web.*check memory/);
    expect(resourcefulness).toMatch(/choices about an unclear deliverable for background work/);
    expect(resourcefulness).toMatch(/search can supply facts but cannot decide.*owner wants/);
    expect(resourcefulness).toMatch(/reminders, notes and food logging can proceed/);
    expect(instructions.indexOf('INITIATIVE:')).toBeLessThan(instructions.indexOf('IMPORTANT:'));
    expect(instructions.indexOf('RESOURCEFULNESS:')).toBeLessThan(
      instructions.indexOf('IMPORTANT:')
    );
    for (const section of [
      initiative,
      resourcefulness,
      prompt.split('<desire_rules>')[1]!.split('</desire_rules>')[0]!,
    ]) {
      expect(section).not.toMatch(/\bI (?:act|use|consider|try|first propose|can do)\b/);
    }
  });

  it('distinguishes a proposed plan from a misleading promise in the final response', () => {
    const prompt = buildSystemPrompt(harness('user_message').context, false);
    expect(prompt).toMatch(/owner relies on your final response.*not started.*false picture/);
    expect(prompt).toMatch(
      /proposed plan offered for agreement is a question, not a claim.*started/
    );
    expect(prompt).toMatch(/honest about.*not having begun/);
    expect(prompt).not.toMatch(/Never promise future actions|either do them now/);
  });

  it('explains why tool-free action claims are false but asking before acting is different', () => {
    const prompt = buildSystemPrompt(harness('user_message').context, false);
    expect(prompt).toMatch(/Text alone performs no action.*happen through tool calls/);
    expect(prompt).toMatch(/Claiming an action happened without.*tool call is false/);
    expect(prompt).toMatch(/IDs, results and statuses.*actual output/);
    expect(prompt).toMatch(
      /Asking the owner to agree a plan before acting is different.*proposal.*not started/
    );
    expect(prompt).not.toMatch(
      /NEVER describe performing actions|without a tool call means NOTHING/
    );
  });

  it('treats agreement to the proposed background-work plan as the request, not another question', () => {
    const h = harness('user_message');
    const prompt = buildSystemPrompt(h.context, false);
    for (const text of [
      prompt.split('INITIATIVE:')[1]!.split('RESOURCEFULNESS:')[0]!,
      prompt.split('<work_ownership>')[1]!.split('</work_ownership>')[0]!,
      h.tool.description,
    ]) {
      expect(text).toMatch(
        /Once the owner agrees.*plan.*(?:is|becomes) the request.*start it without asking again/
      );
    }
  });

  it('qualifies every reviewed act-now sentence, including the advertised startTask description', () => {
    const h = harness('user_message');
    const description = h.registry
      .getToolsAsOpenAIFormat()
      .find((tool) => tool.function.name === 'core_startTask')!.function.description;
    const surfaces = { system: buildSystemPrompt(h.context, false), startTask: description };
    for (const surface of ['system', 'startTask'] as const) {
      const sentences = splitSentences(surfaces[surface]);
      const actionStatements = sentences.filter((sentence) => actNowPattern.test(sentence));
      // This exact list is deliberately reviewed by a human, not derived from the prompt.
      expect(actionStatements).toEqual(reviewedActNowSentences[surface]);
      for (const statement of reviewedActNowSentences[surface]) {
        const index = sentences.indexOf(statement);
        expect(index).toBeGreaterThanOrEqual(0);
        const localContext = sentences.slice(index, index + 2).join(' ');
        expect(localContext).toMatch(/background work/i);
        expect(localContext).toMatch(
          /unclear deliverable|deliverable is unclear|leaves what to deliver or its form open/i
        );
        expect(localContext).toMatch(
          /agreed plan|agree a concrete plan|needs agreement|owner agrees/i
        );
      }
    }
  });

  it.each([
    'Act now.',
    'Just act.',
    'Do it now.',
    'Start without asking.',
    "Don't ask.",
    'Do not ask for confirmation.',
    'No confirmation is needed.',
    'Either do them now or stop.',
  ])('recognizes a new action instruction within a paragraph: %s', (sentence) => {
    const sentences = splitSentences(
      `Background work with an unclear deliverable needs an agreed plan. ${sentence} Another sentence.`
    );
    expect(sentences.filter((part) => actNowPattern.test(part))).toEqual([sentence]);
  });

  it('keeps active desires within the same background-work agreement boundary', () => {
    const context = harness('user_message').context;
    context.activeDesires = [
      {
        id: 'des_test',
        want: 'Explore primes',
        intensity: 0.8,
        source: 'self_inference',
        evidence: 'Curiosity',
      },
    ];
    const section = buildActiveDesiresSection(context)!;
    expect(section).toContain('Explore primes');
    expect(section).toMatch(
      /act on one.*background work with an unclear deliverable needs an agreed plan first/i
    );
    expect(section).toMatch(/Internal concepts.*motivation, not the message the owner needs/);
    expect(section).not.toMatch(/just act/i);
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
    expect(description).toMatch(/what to deliver and in what form clear.*start at once/);
    expect(description).toMatch(/obvious confirmation adds friction/);
    expect(description).toMatch(/Background work runs out of sight.*takes time.*files/);
    expect(description).toMatch(
      /unclear deliverable needs agreement.*propose a concrete plan.*ask/
    );
    expect(description).toMatch(/wrong guess.*wasted run.*redo/);
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
    expect(message).not.toMatch(/I own the result|ownership/i);
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
