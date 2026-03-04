import { describe, it, expect } from 'vitest';
import { buildInitialMessages } from '../../../src/layers/cognition/messages/history-builder.js';
import type { LoopContext, PromptBuilders } from '../../../src/layers/cognition/agentic-loop-types.js';
import type { Signal } from '../../../src/types/index.js';
import type { ContentPart } from '../../../src/llm/provider.js';

function makeContext(overrides?: Partial<LoopContext>): LoopContext {
  return {
    tickId: 'test-tick',
    triggerSignal: {
      type: 'user_message',
      source: 'test',
      value: 1,
      data: { kind: 'user_message', text: 'hello', recipientId: 'r1', channel: 'telegram' },
    } as Signal,
    agentState: {
      energy: 1,
      socialDebt: 0,
      taskPressure: 0,
      curiosity: 0,
      acquaintancePressure: 0,
    },
    conversationHistory: [],
    userModel: {},
    memoryFacts: [],
    activeInterests: [],
    userTimeContext: { localTime: new Date(), timezone: 'UTC', isWeekend: false },
    pressure: { urgency: 0, socialDebt: 0, lastContactHours: 0 },
    drainPendingUserMessages: undefined,
    ...overrides,
  } as LoopContext;
}

const stubPromptBuilders: PromptBuilders = {
  buildSystemPrompt: () => 'system prompt',
  buildTriggerPrompt: (ctx) => {
    const data = ctx.triggerSignal.data as { text?: string } | undefined;
    return `<user_input>${data?.text ?? 'hello'}</user_input>`;
  },
};

describe('buildInitialMessages with photo support', () => {
  it('sets contentParts when trigger signal has images', () => {
    const context = makeContext({
      triggerSignal: {
        type: 'user_message',
        source: 'test',
        value: 1,
        data: {
          kind: 'user_message',
          text: 'Look at this',
          recipientId: 'r1',
          channel: 'telegram',
          images: [{ data: 'base64data', mediaType: 'image/jpeg' }],
        },
      } as Signal,
    });

    const messages = buildInitialMessages(context, false, stubPromptBuilders);
    const triggerMsg = messages[messages.length - 1]!;

    // Should have contentParts with text + image
    expect(triggerMsg.contentParts).toBeDefined();
    expect(triggerMsg.contentParts).toHaveLength(2);
    expect(triggerMsg.contentParts![0]).toEqual({
      type: 'text',
      text: '<user_input>Look at this</user_input>',
    });
    expect(triggerMsg.contentParts![1]).toEqual({
      type: 'image',
      image: 'base64data',
      mediaType: 'image/jpeg',
    });

    // content should still be text for logging/transcript
    expect(triggerMsg.role).toBe('user');
    expect(typeof triggerMsg.content).toBe('string');
  });

  it('does not set contentParts when trigger has no images', () => {
    const context = makeContext(); // Default: no images
    const messages = buildInitialMessages(context, false, stubPromptBuilders);
    const triggerMsg = messages[messages.length - 1]!;

    expect(triggerMsg.contentParts).toBeUndefined();
    expect(triggerMsg.role).toBe('user');
    expect(typeof triggerMsg.content).toBe('string');
  });

  it('does not set contentParts for non-user triggers even with images in signal', () => {
    const context = makeContext({
      triggerSignal: {
        type: 'thought',
        source: 'test',
        value: 1,
        data: {
          kind: 'thought',
          content: 'thinking...',
          images: [{ data: 'base64data', mediaType: 'image/jpeg' }],
        },
      } as Signal,
    });

    const messages = buildInitialMessages(context, false, stubPromptBuilders);
    const triggerMsg = messages[messages.length - 1]!;

    expect(triggerMsg.contentParts).toBeUndefined();
  });

  it('handles multiple images', () => {
    const context = makeContext({
      triggerSignal: {
        type: 'user_message',
        source: 'test',
        value: 1,
        data: {
          kind: 'user_message',
          text: 'Two photos',
          recipientId: 'r1',
          channel: 'telegram',
          images: [
            { data: 'img1', mediaType: 'image/jpeg' },
            { data: 'img2', mediaType: 'image/png' },
          ],
        },
      } as Signal,
    });

    const messages = buildInitialMessages(context, false, stubPromptBuilders);
    const triggerMsg = messages[messages.length - 1]!;

    expect(triggerMsg.contentParts).toHaveLength(3); // 1 text + 2 images
    expect(triggerMsg.contentParts![1]).toEqual({
      type: 'image',
      image: 'img1',
      mediaType: 'image/jpeg',
    });
    expect(triggerMsg.contentParts![2]).toEqual({
      type: 'image',
      image: 'img2',
      mediaType: 'image/png',
    });
  });
});
