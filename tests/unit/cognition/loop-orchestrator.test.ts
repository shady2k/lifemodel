/**
 * Loop Orchestrator Tests
 *
 * Tests for tool filtering based on trigger context.
 */

import { describe, it, expect } from 'vitest';
import { filterToolsForContext } from '../../../src/layers/cognition/loop-orchestrator.js';
import type { LoopContext } from '../../../src/layers/cognition/agentic-loop-types.js';
import type { Signal } from '../../../src/types/signal.js';
import type { OpenAIChatTool } from '../../../src/llm/tool-schema.js';

function makeContext(triggerType: string, triggerData?: Record<string, unknown>): LoopContext {
  return {
    tickId: 'test-tick',
    triggerSignal: {
      type: triggerType,
      source: 'test',
      value: 1,
      data: triggerData,
    } as Signal,
    conversationHistory: [],
    userModel: {},
    memoryFacts: [],
    activeInterests: [],
    userTimeContext: { localTime: new Date(), timezone: 'UTC', isWeekend: false },
    pressure: { urgency: 0, socialDebt: 0, lastContactHours: 0 },
  } as LoopContext;
}

function makeTool(name: string): OpenAIChatTool {
  return {
    type: 'function',
    function: {
      name,
      description: `Tool ${name}`,
      parameters: { type: 'object', properties: {} },
    },
  };
}

describe('filterToolsForContext', () => {
  describe('core.task filtering on motor_result', () => {
    it('filters core.task for awaiting_input motor_result', () => {
      const tools = [makeTool('core.task'), makeTool('core.memory'), makeTool('core.say')];
      const context = makeContext('motor_result', { status: 'awaiting_input' });

      const filtered = filterToolsForContext(tools, context, false);

      expect(filtered.map((t) => t.function.name)).not.toContain('core.task');
      expect(filtered.map((t) => t.function.name)).toContain('core.memory');
      expect(filtered.map((t) => t.function.name)).toContain('core.say');
    });

    it('filters core.task for awaiting_approval motor_result', () => {
      const tools = [makeTool('core.task'), makeTool('core.memory')];
      const context = makeContext('motor_result', { status: 'awaiting_approval' });

      const filtered = filterToolsForContext(tools, context, false);

      expect(filtered.map((t) => t.function.name)).not.toContain('core.task');
    });

    it('keeps core.task for completed motor_result', () => {
      const tools = [makeTool('core.task'), makeTool('core.memory')];
      const context = makeContext('motor_result', { status: 'completed' });

      const filtered = filterToolsForContext(tools, context, false);

      expect(filtered.map((t) => t.function.name)).toContain('core.task');
    });

    it('keeps core.task for failed motor_result', () => {
      const tools = [makeTool('core.task')];
      const context = makeContext('motor_result', { status: 'failed' });

      const filtered = filterToolsForContext(tools, context, false);

      expect(filtered.map((t) => t.function.name)).toContain('core.task');
    });

    it('keeps core.task for user_message', () => {
      const tools = [makeTool('core.task')];
      const context = makeContext('user_message');

      const filtered = filterToolsForContext(tools, context, false);

      expect(filtered.map((t) => t.function.name)).toContain('core.task');
    });
  });

  describe('thought trigger filtering', () => {
    it('filters core.thought, core.say, core.state, core.agent for thought trigger', () => {
      const tools = [
        makeTool('core.thought'),
        makeTool('core.say'),
        makeTool('core.state'),
        makeTool('core.agent'),
        makeTool('core.memory'),
        makeTool('core.remember'),
      ];
      const context = makeContext('thought');

      const filtered = filterToolsForContext(tools, context, false);

      expect(filtered.map((t) => t.function.name)).not.toContain('core.thought');
      expect(filtered.map((t) => t.function.name)).not.toContain('core.say');
      expect(filtered.map((t) => t.function.name)).not.toContain('core.state');
      expect(filtered.map((t) => t.function.name)).not.toContain('core.agent');
      expect(filtered.map((t) => t.function.name)).toContain('core.memory');
      expect(filtered.map((t) => t.function.name)).toContain('core.remember');
    });
  });

  describe('escalation filtering', () => {
    it('filters core.escalate when already using smart model', () => {
      const tools = [makeTool('core.escalate'), makeTool('core.memory')];
      const context = makeContext('user_message');

      const filtered = filterToolsForContext(tools, context, true); // useSmart = true

      expect(filtered.map((t) => t.function.name)).not.toContain('core.escalate');
      expect(filtered.map((t) => t.function.name)).toContain('core.memory');
    });

    it('keeps core.escalate when using fast model', () => {
      const tools = [makeTool('core.escalate')];
      const context = makeContext('user_message');

      const filtered = filterToolsForContext(tools, context, false); // useSmart = false

      expect(filtered.map((t) => t.function.name)).toContain('core.escalate');
    });
  });
});
