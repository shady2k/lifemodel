import { describe, expect, it } from 'vitest';
import type { LoopContext } from '../../src/layers/cognition/agentic-loop-types.js';
import type { TaskContextEntry } from '../../src/ports/tasks.js';
import { TASK_CONTEXT_LIMITS } from '../../src/ports/tasks.js';
import { buildRunningTasksSection } from '../../src/layers/cognition/prompts/running-tasks.js';
import { buildTriggerPrompt } from '../../src/layers/cognition/prompts/trigger-prompt.js';
import { createSignal } from '../../src/types/signal.js';

const entry: TaskContextEntry = {
  id: 'task_1',
  harness: 'test',
  state: 'running',
  briefing: 'Find primes',
  question: null,
};
const context = (runningTasks: readonly TaskContextEntry[] = []) =>
  ({
    runningTasks,
    agentState: {
      energy: 0.5,
      socialDebt: 0,
      taskPressure: 0,
      curiosity: 0,
      acquaintancePressure: 0,
    },
    userModel: {},
    conversationHistory: [],
    triggerSignal: createSignal('thought', 'test', { value: 1 }, { data: {} }),
  }) as LoopContext;

describe('running task prompt data budget', () => {
  it('omits an empty snapshot', () => {
    expect(buildRunningTasksSection(context())).toBeNull();
    expect(buildRunningTasksSection({} as LoopContext)).toBeNull();
    expect(buildTriggerPrompt(context())).not.toContain('<running_tasks>');
  });

  it.each(['user_message', 'thought', 'plugin_event', 'contact_urge'] as const)(
    'includes task context on %s, not only task questions',
    (type) => {
      const ctx = context([entry]);
      ctx.triggerSignal = createSignal(type, 'test', { value: 1 }, { data: {} });
      expect(buildTriggerPrompt(ctx)).toContain('"id":"task_1"');
    }
  );

  it('bounds count, each field, and expanded JSON/XML while preserving valid data', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      ...entry,
      id: `task_${i}`,
      briefing: 'B'.repeat(5000),
      question: { questionId: `question_${i}`, text: 'Q'.repeat(5000) },
    }));
    const section = buildRunningTasksSection(context(many))!;
    const data = JSON.parse(
      section.match(/<untrusted_running_tasks>(.*?)<\/untrusted_running_tasks>/s)![1]!
    );
    expect(data).toHaveLength(TASK_CONTEXT_LIMITS.count);
    expect(data[0].briefing).toHaveLength(TASK_CONTEXT_LIMITS.briefing);
    expect(data[0].question.text).toHaveLength(TASK_CONTEXT_LIMITS.question);
    const expanded = buildRunningTasksSection(
      context(
        many.map((task) => ({
          ...task,
          briefing: '<'.repeat(5000),
          question: { questionId: 'q', text: '\u0001'.repeat(5000) },
        }))
      )
    )!;
    const encoded = expanded.match(
      /<untrusted_running_tasks>(.*?)<\/untrusted_running_tasks>/s
    )![1]!;
    expect(encoded.length).toBeLessThanOrEqual(TASK_CONTEXT_LIMITS.rendered);
    expect(JSON.parse(encoded)).toHaveLength(3);
    expect(expanded).not.toContain('"briefing":"<');
  });
});
