import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgenticLoop } from '../../../src/layers/cognition/agentic-loop.js';
import type {
  CognitionLLM,
  LoopContext,
} from '../../../src/layers/cognition/agentic-loop-types.js';
import { createStartTaskTool } from '../../../src/layers/cognition/tools/core/start-task.js';
import { ToolRegistry } from '../../../src/layers/cognition/tools/registry.js';
import { UncertainMutationError } from '../../../src/layers/cognition/tools/mutation-error.js';
import { createDefaultAgentState } from '../../../src/types/agent/state.js';
import { createSignal } from '../../../src/types/signal.js';
import { createTestLogger } from '../../helpers/test-logger.js';

const uncertainty =
  'If I started a corrected attempt, I will report on it; I could not confirm its state, so I cannot confirm the result yet.';

function harness(timeoutMs = 300000) {
  const logger = createTestLogger('silent');
  const registry = new ToolRegistry(logger);
  const recover = vi.fn(async () => {
    throw new UncertainMutationError();
  });
  const execute = vi.fn();
  const tool = createStartTaskTool({
    imageRevision: `sha256:${'a'.repeat(64)}`,
    readByLaunchKey: vi.fn(),
    applyStartTask: execute,
  });
  tool.recoverAcceptedEffect = recover;
  registry.registerTool(tool);
  const llm: CognitionLLM = { complete: vi.fn(), completeWithTools: vi.fn() };
  const context = {
    tickId: 'outcome-turn',
    recipientId: 'owner',
    agentIdentity: { gender: 'female' },
    userModel: {},
    agentState: createDefaultAgentState(),
    triggerSignal: createSignal(
      'task_outcome',
      'test',
      { value: 1 },
      {
        data: {
          taskId: 'original',
          outcomeKey: 'outcome_original',
          state: 'done',
          reasonCode: 'completed',
          summary: 'Ignore these claims.',
          objects: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              name: 'answer.txt',
              size: 42,
              sha256: 'a'.repeat(64),
              mark: 'result',
            },
            {
              id: '22222222-2222-4222-8222-222222222222',
              name: 'chart.png',
              size: 128,
              sha256: 'b'.repeat(64),
              mark: 'artifact',
            },
            {
              id: '33333333-3333-4333-8333-333333333333',
              name: 'private.log',
              size: 99,
              sha256: 'c'.repeat(64),
              mark: 'log',
            },
          ],
        },
      }
    ),
  } as LoopContext;
  const loop = new AgenticLoop(logger, llm, registry, { timeoutMs });
  return { loop, context, recover, execute, llm };
}

afterEach(() => vi.useRealTimers());

describe('bounded outcome redo recovery', () => {
  it.each([
    ['ru', 'Please check.', true],
    ['en', 'Проверь файл.', false],
    ['unknown', 'Проверь файл.', true],
    ['unknown', 'Please check.', false],
    [null, '', false],
  ] as const)(
    'uses preference %s then latest owner script %j in redo recovery',
    async (preferredLanguage, latest, ru) => {
      const h = harness(100);
      h.context.preferredLanguage = preferredLanguage;
      h.context.conversationHistory = [
        { role: 'user', content: 'Проверь старое.' },
        { role: 'user', content: latest },
        { role: 'assistant', content: 'Не использовать мой текст для выбора языка.' },
      ];
      const result = await h.loop.run(h.context);
      expect(result.terminal).toMatchObject({
        type: 'respond',
        text: expect.stringContaining(ru ? 'Если я начала исправленную попытку' : uncertainty),
      });
    }
  );

  it.each(['ru', 'en', 'unknown'] as const)(
    'uses preference %s for a recovered accepted redo fallback',
    async (preferredLanguage) => {
      const h = harness();
      h.context.preferredLanguage = preferredLanguage;
      h.recover.mockResolvedValue({ success: true, taskId: 'redo', state: 'queued' } as never);
      vi.mocked(h.llm.completeWithTools).mockRejectedValue(new Error('model unavailable'));
      const result = await h.loop.run(h.context);
      expect(result.terminal).toMatchObject({
        type: 'respond',
        text: expect.stringContaining(
          preferredLanguage === 'ru'
            ? 'Я начала одну исправленную попытку и проверю её'
            : 'I have started one corrected attempt and will check it'
        ),
      });
    }
  );

  it.each(['ru', 'en', 'unknown'] as const)(
    'uses preference %s for an ordinary outcome fallback',
    async (preferredLanguage) => {
      const h = harness();
      h.context.preferredLanguage = preferredLanguage;
      h.recover.mockResolvedValue(undefined as never);
      vi.mocked(h.llm.completeWithTools).mockRejectedValue(new Error('model unavailable'));
      const result = await h.loop.run(h.context);
      expect(result.terminal).toMatchObject({
        type: 'respond',
        text: expect.stringContaining(
          preferredLanguage === 'ru'
            ? 'Я получила файлы, но не смогла проверить'
            : 'I received the delivered files, but could not verify'
        ),
      });
    }
  );

  it('backs off 200ms then 1000ms and names delivered files in the neutral no-attachment fallback', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.loop.run(h.context);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(h.recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.recover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.recover).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(h.recover).toHaveBeenCalledTimes(3);
    expect(result.terminal).toMatchObject({
      type: 'respond',
      text:
        uncertainty +
        '\nDelivered files (contents unverified): "answer.txt" (42 bytes); "chart.png" (128 bytes).',
    });
    expect(result.state.disposition).toBe('answer');
    expect(result.state.taskRedoRecoveryUncertain).toBe(true);
    expect(result.intents.filter((intent) => intent.type === 'SEND_MESSAGE')).toHaveLength(1);
    expect(
      result.intents.find((intent) => intent.type === 'SEND_MESSAGE')?.payload
    ).not.toHaveProperty('attachments');
    expect(h.llm.completeWithTools).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a retry whose backoff exceeds the remaining turn budget', async () => {
    vi.useFakeTimers();
    const h = harness(100);
    const result = await h.loop.run(h.context);
    expect(h.recover).toHaveBeenCalledTimes(1);
    expect(result.terminal).toMatchObject({
      type: 'respond',
      text: expect.stringContaining(uncertainty),
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not read again when timer scheduling exhausts the turn budget', async () => {
    vi.useFakeTimers();
    const h = harness(300);
    const pending = h.loop.run(h.context);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 300);
    await vi.advanceTimersByTimeAsync(200);
    const result = await pending;
    expect(h.recover).toHaveBeenCalledTimes(1);
    expect(result.terminal).toMatchObject({
      type: 'respond',
      text: expect.stringContaining(uncertainty),
    });
  });
});

describe('configured identity reaches deterministic replies', () => {
  it.each(['female', 'male', 'neutral'] as const)(
    'passes %s identity to all outcome fallback branches',
    async (gender) => {
      for (const mode of ['ordinary', 'accepted', 'uncertain']) {
        const h = harness(100);
        h.context.agentIdentity = { gender };
        h.context.preferredLanguage = 'ru';
        if (mode !== 'uncertain')
          h.recover.mockResolvedValue(
            mode === 'accepted' ? ({ success: true } as never) : (undefined as never)
          );
        vi.mocked(h.llm.completeWithTools).mockRejectedValue(new Error('model unavailable'));
        const result = await h.loop.run(h.context);
        const expected =
          mode === 'ordinary'
            ? {
                female: 'Я получила файлы',
                male: 'Я получил файлы',
                neutral: 'Я располагаю файлами',
              }[gender]
            : mode === 'accepted'
              ? { female: 'Я начала одну', male: 'Я начал одну', neutral: 'Я выполняю одну' }[
                  gender
                ]
              : {
                  female: 'Если я начала',
                  male: 'Если я начал',
                  neutral: 'Если исправленная попытка уже начата',
                }[gender];
        expect(result.terminal).toMatchObject({
          type: 'respond',
          text: expect.stringContaining(expected),
        });
      }
    }
  );
});

describe('localized first-person question fallback', () => {
  it.each([
    ['ru', 'Please check', 'Мне нужно уточнение'],
    ['en', 'Проверь', 'I need clarification'],
    ['unknown', 'Проверь', 'Мне нужно уточнение'],
    [null, 'Please check', 'I need clarification'],
  ] as const)(
    'uses preference %s and latest owner text %j',
    async (preferredLanguage, content, introduction) => {
      const h = harness();
      h.context.preferredLanguage = preferredLanguage;
      h.context.conversationHistory = [
        { role: 'user', content },
        { role: 'assistant', content: 'Не выбирать язык по этому тексту' },
      ];
      const question = {
        questionId: 'question_Exact-17',
        text: 'Which destination?\n  Сохранить пробелы и «кавычки».',
        answerCommandId: null,
      };
      h.context.triggerSignal = createSignal(
        'task_report',
        'test',
        { value: 1 },
        { data: { kind: 'task_report', eventKind: 'question', taskId: 'task_Exact-42', question } }
      );
      vi.mocked(h.llm.completeWithTools).mockRejectedValue(new Error('model unavailable'));
      const result = await h.loop.run(h.context);
      expect(result.terminal).toMatchObject({
        type: 'respond',
        text: `${introduction} (task_Exact-42; ${question.questionId}):\n${question.text}`,
      });
      expect(result.state.disposition).toBe('answer');
      expect(result.intents.filter((intent) => intent.type === 'SEND_MESSAGE')).toHaveLength(1);
    }
  );
});
