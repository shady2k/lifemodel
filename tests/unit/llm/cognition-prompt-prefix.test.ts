/** Audit the real prompt → history → adapter → SDK → raw HTTP request path. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSystemPrompt } from '../../../src/layers/cognition/prompts/system-prompt.js';
import { buildTriggerPrompt } from '../../../src/layers/cognition/prompts/trigger-prompt.js';
import { buildInitialMessages } from '../../../src/layers/cognition/messages/history-builder.js';
import { addPreviousAttemptMessages } from '../../../src/layers/cognition/messages/retry-builder.js';
import { ToolRegistry } from '../../../src/layers/cognition/tools/registry.js';
import type { Tool } from '../../../src/layers/cognition/tools/types.js';
import type { LoopContext } from '../../../src/layers/cognition/agentic-loop-types.js';
import { createLLMAdapter } from '../../../src/layers/cognition/llm-adapter.js';
import { VercelAIProvider } from '../../../src/plugins/providers/vercel-ai-provider.js';
import type { OpenAIChatTool } from '../../../src/llm/tool-schema.js';
import { proxyFetch } from '../../../src/utils/proxy-fetch.js';
import { createDefaultAgentState } from '../../../src/types/agent/state.js';
import { createDefaultSoulState } from '../../../src/types/agent/soul.js';
import type { FullSoulState } from '../../../src/storage/soul-provider.js';
import { createSignal } from '../../../src/types/signal.js';
import { createLoopState } from '../../../src/types/cognition.js';
import { createTestLogger } from '../../helpers/test-logger.js';

// Keep the AI SDK real. Capture only its final HTTP transport, after raw schema repair.
vi.mock('../../../src/utils/proxy-fetch.js', () => ({ proxyFetch: vi.fn() }));

const builders = { buildSystemPrompt, buildTriggerPrompt };
const logger = createTestLogger('silent');

function context(version: number): LoopContext {
  const soul = createDefaultSoulState();
  soul.selfModel.narrative.currentStory = `Soul story ${version}`;
  return {
    triggerSignal: createSignal(
      'user_message',
      'sense.web',
      { value: 1 },
      {
        data: { text: `How are you? turn ${version}` },
      }
    ),
    agentState: { ...createDefaultAgentState(), energy: version === 1 ? 0.2 : 0.9 },
    agentIdentity: { name: 'Life', gender: 'female' },
    conversationHistory: [
      {
        role: 'user',
        content: `Old question ${version}`,
        timestamp: new Date('2026-10-28T10:00:00Z'),
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: `call_${version}`,
            type: 'function',
            function: { name: 'read_state', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: `{"energy":${version}}`, tool_call_id: `call_${version}` },
      {
        role: 'assistant',
        content: `Old answer ${version}`,
        timestamp: new Date('2026-10-28T10:01:00Z'),
      },
    ],
    userModel: { defaultTimezone: version === 1 ? 'UTC' : 'Europe/Moscow' },
    // Only fields consumed by prompt building are needed from the full soul provider.
    soulState: soul as FullSoulState,
    runningTasks: {
      tasks: [
        {
          id: `task_${version}`,
          harness: 'test',
          state: 'running',
          briefing: `Work ${version}`,
          question: null,
        },
      ],
      omitted: false,
    },
    tickId: `tick_${version}`,
    recipientId: 'recipient_test',
    drainPendingUserMessages: undefined,
  };
}

function tool(name: string): Tool {
  return {
    name,
    description: `Read ${name}`,
    parameters: [],
    validate: () => ({ success: true, data: {} }),
    execute: async () => ({}),
  };
}

function nativeTool(name: string): OpenAIChatTool {
  return {
    type: 'function',
    function: {
      name,
      description: `Read ${name}`,
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  };
}

interface WireBody {
  messages: {
    role: string;
    content: string | null;
    tool_call_id?: string;
    tool_calls?: { id: string }[];
  }[];
  tools: OpenAIChatTool[];
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('cognition cacheable prefix', () => {
  it('keeps all instructions identical across time, state, timezone and fast/smart roles', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-29T10:00:00Z'));
    const first = context(1);
    const prefix = buildSystemPrompt(first, false);
    const firstTrigger = buildTriggerPrompt(first, false);
    vi.setSystemTime(new Date('2026-10-30T12:15:00Z'));
    const second = context(2);
    expect(
      buildSystemPrompt(
        { ...first, agentState: second.agentState, soulState: second.soulState },
        false
      )
    ).toBe(prefix);
    expect(buildSystemPrompt(second, true)).toBe(prefix);
    expect(prefix.length).toBeGreaterThan(10000);
    for (const tag of [
      'instructions',
      'memory_rules',
      'skill_rules',
      'task_outcome_policy',
      'output_format',
    ]) {
      expect(prefix).toContain(`<${tag}>`);
    }
    expect(prefix).toContain('is the authoritative present moment');
    expect(prefix).toContain("timezone attribute of <current_time> is the user's timezone");
    expect(prefix).not.toMatch(
      /<current_time timezone=|2026|tick_|task_1|Soul story|<runtime_snapshot>|UTC|Europe\/Moscow/
    );
    expect(firstTrigger).toContain('<current_time timezone="UTC">');
    expect(firstTrigger).toContain('October 29, 2026');
    const secondTrigger = buildTriggerPrompt(second, true);
    expect(secondTrigger).toContain('<current_time timezone="Europe/Moscow">');
    expect(secondTrigger).toContain('October 30, 2026');
    expect(firstTrigger).toContain('<model_instructions>');
    expect(secondTrigger).not.toContain('<model_instructions>');
    expect(secondTrigger).toContain('Soul story 2');
    expect(secondTrigger).toContain('<runtime_snapshot>');
    expect(secondTrigger).toContain('"id":"task_2"');
  });

  it('sorts full and lazy tool definitions independently of registration and reload order', () => {
    const first = new ToolRegistry(logger);
    const second = new ToolRegistry(logger);
    for (const name of ['plugin_zeta', 'plugin_alpha', 'plugin_Beta'])
      first.registerTool(tool(name));
    for (const name of ['plugin_Beta', 'plugin_alpha', 'plugin_zeta'])
      second.registerTool(tool(name));
    second.unregisterTool('core.memory');
    second.registerTool(first.getTools().find((entry) => entry.name === 'core.memory')!);
    expect(second.getToolsAsOpenAIFormat()).toEqual(first.getToolsAsOpenAIFormat());
    expect(second.getToolsWithLazySchema()).toEqual(first.getToolsWithLazySchema());
    const names = first.getToolsAsOpenAIFormat().map((entry) => entry.function.name);
    expect(names).toEqual([...names].sort());
    expect(names).not.toContain('core_tools');
  });

  it.each([
    ['user_message', true],
    ['thought', true],
    ['plugin_event', true],
    ['user_message', false],
    ['thought', false],
    ['plugin_event', false],
  ] as const)(
    'preserves the prefix on the actual %s request wire (history: %s)',
    async (triggerType, hasHistory) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const requests: WireBody[] = [];
      vi.mocked(proxyFetch).mockImplementation(async (_input, init) => {
        requests.push(JSON.parse(init?.body as string) as WireBody);
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1,
            model: 'test-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{"response":"ok"}' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      });
      const provider = new VercelAIProvider(
        { baseUrl: 'http://model.test/v1', fastModel: 'test-model', smartModel: 'test-model' },
        logger
      );
      const adapter = createLLMAdapter(provider, logger);
      const tools = [nativeTool('zebra'), nativeTool('read_state'), nativeTool('Alpha')];
      const originalOrder = tools.map((entry) => entry.function.name);
      const prefix = buildSystemPrompt(context(1), false);

      for (const version of [1, 2]) {
        vi.setSystemTime(new Date(`2026-10-${version === 1 ? '29' : '30'}T12:15:00Z`));
        const turn = context(version);
        if (!hasHistory) turn.conversationHistory = [];
        turn.triggerSignal = { ...turn.triggerSignal, type: triggerType };
        const messages = buildInitialMessages(turn, false, builders);
        expect(messages[0]).toEqual({ role: 'system', content: prefix });
        await adapter.completeWithTools({
          messages,
          tools: version === 1 ? tools : [...tools].reverse(),
          toolChoice: 'auto',
        });
        // Another request in the same turn appends only after the existing prefix.
        if (version === 1) {
          const round = [
            ...messages,
            {
              role: 'assistant' as const,
              content: null,
              tool_calls: [
                {
                  id: 'round_call',
                  type: 'function' as const,
                  function: { name: 'read_state', arguments: '{}' },
                },
              ],
            },
            { role: 'tool' as const, content: '{"energy":0.2}', tool_call_id: 'round_call' },
          ];
          await adapter.completeWithTools({ messages: round, tools, toolChoice: 'auto' });
          const retry = buildInitialMessages(turn, true, builders);
          addPreviousAttemptMessages(
            retry,
            {
              reason: 'Need deeper reasoning',
              executedTools: [
                { toolCallId: 'retry_call', name: 'read_state', args: {}, hasSideEffects: false },
              ],
              toolResults: [
                {
                  toolCallId: 'retry_call',
                  toolName: 'read_state',
                  resultId: 'retry_result',
                  success: true,
                  data: { energy: 0.2 },
                },
              ],
            },
            createLoopState()
          );
          await adapter.completeWithTools(
            { messages: retry, tools, toolChoice: 'auto' },
            { useSmart: true }
          );
        }
      }

      expect(requests).toHaveLength(4);
      for (const request of requests) {
        expect(request.messages[0]).toEqual({ role: 'system', content: prefix });
        expect(request.tools.map((entry) => entry.function.name)).toEqual([
          'Alpha',
          'read_state',
          'zebra',
        ]);
        expect(request.tools).toEqual(requests[0]!.tools);
        if (hasHistory) {
          expect(request.messages[1]?.content).toContain('Old question');
          expect(
            request.messages.some((entry) => entry.tool_calls?.[0]?.id.startsWith('call_'))
          ).toBe(true);
          expect(request.messages.some((entry) => entry.tool_call_id?.startsWith('call_'))).toBe(
            true
          );
        }
      }
      expect(JSON.stringify(requests[0]!.messages.slice(1))).toContain('Soul story 1');
      const last = JSON.stringify(requests[3]!.messages.slice(1));
      expect(last).toContain('Soul story 2');
      expect(last).toContain('<current_time timezone=');
      expect(last).toContain('October 30, 2026');
      expect(last).toContain('<runtime_snapshot>');
      expect(last).toContain('task_2');
      for (const [requestIndex, callId] of [
        [1, 'round_call'],
        [2, 'retry_call'],
      ] as const) {
        const messages = requests[requestIndex]!.messages;
        const callIndex = messages.findIndex((entry) =>
          entry.tool_calls?.some((call) => call.id === callId)
        );
        expect(callIndex).toBeGreaterThan(0);
        expect(messages[callIndex + 1]?.tool_call_id).toBe(callId);
      }
      expect(JSON.stringify(requests[2]!.messages.slice(1))).toContain('Need deeper reasoning');
      expect(tools.map((entry) => entry.function.name)).toEqual(originalOrder);
    }
  );
});
