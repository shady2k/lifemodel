import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/llm/provider.js';
import { compileTranscript, OPENROUTER_POLICY } from '../../src/plugins/providers/transcript-compiler.js';

// Helper to create messages
const user = (content: string, contentParts?: Message['contentParts']): Message => ({
  role: 'user',
  content,
  ...(contentParts && { contentParts }),
});

describe('transcript-compiler contentParts protection', () => {
  it('does not merge a contentParts message with a preceding user message', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      user('previous message'),
      user('photo caption', [
        { type: 'text', text: 'photo caption' },
        { type: 'image', image: 'base64data', mediaType: 'image/jpeg' },
      ]),
    ];

    // OpenRouter policy enables mergeConsecutiveRoles
    const result = compileTranscript(messages, OPENROUTER_POLICY);

    // The two user messages should NOT be merged
    const userMessages = result.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]!.content).toBe('previous message');
    expect(userMessages[1]!.content).toBe('photo caption');
    expect((userMessages[1] as any).contentParts).toBeDefined();
  });

  it('does not merge a following user message into a contentParts message', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      user('photo caption', [
        { type: 'text', text: 'photo caption' },
        { type: 'image', image: 'base64data', mediaType: 'image/jpeg' },
      ]),
      user('follow-up text'),
    ];

    const result = compileTranscript(messages, OPENROUTER_POLICY);

    const userMessages = result.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]!.content).toBe('photo caption');
    expect(userMessages[1]!.content).toBe('follow-up text');
  });

  it('still merges regular consecutive user messages without contentParts', () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      user('first'),
      user('second'),
    ];

    const result = compileTranscript(messages, OPENROUTER_POLICY);

    const userMessages = result.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.content).toContain('first');
    expect(userMessages[0]!.content).toContain('second');
  });
});
