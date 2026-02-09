/**
 * Gemini Model Transforms
 *
 * Helper functions for handling Gemini-specific message transformations.
 * These are shared between OpenRouter providers and VercelAIProvider.
 */

/**
 * Check if the resolved model is a Gemini model on OpenRouter.
 */
export function isGeminiModel(model: string): boolean {
  return model.startsWith('google/');
}

/**
 * Gemini requires the first content turn (after system_instruction) to be 'user' role.
 * OpenRouter collapses leading system messages into system_instruction, so if the
 * first non-system message is 'assistant' (autonomous triggers with tool calls),
 * Gemini rejects it. Insert a synthetic user turn to satisfy this constraint.
 */
export function ensureUserTurnForGemini(messages: Record<string, unknown>[]): void {
  const firstContentIdx = messages.findIndex((m) => m['role'] !== 'system');
  if (firstContentIdx === -1) return; // all system — OpenRouter handles this

  const firstContentMsg = messages[firstContentIdx];
  if (!firstContentMsg || firstContentMsg['role'] === 'user') return; // already valid

  messages.splice(firstContentIdx, 0, {
    role: 'user',
    content: '[autonomous processing]',
  });
}

/**
 * Gemini only supports system messages as system_instruction (leading position).
 * OpenRouter collapses leading system messages automatically, but mid-conversation
 * system messages have no Gemini equivalent and cause 500 errors.
 * Convert them to user role with a prefix to preserve instructional intent.
 */
export function sanitizeSystemMessagesForGemini(messages: Record<string, unknown>[]): void {
  // Find where the leading system block ends
  let firstNonSystemIdx = 0;
  while (
    firstNonSystemIdx < messages.length &&
    messages[firstNonSystemIdx]?.['role'] === 'system'
  ) {
    firstNonSystemIdx++;
  }

  // Convert any system messages after the leading block to user role
  for (let i = firstNonSystemIdx; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.['role'] === 'system') {
      msg['role'] = 'user';
      msg['content'] = `[System] ${String(msg['content'])}`;
    }
  }
}

/**
 * Add cache_control breakpoint for prompt caching.
 * Converts plain string content to multipart format with cache_control.
 *
 * Strategy differs by provider:
 * - Anthropic: breakpoint on last system message (caches full system prefix)
 * - Gemini: breakpoint on first user message (system_instruction loses cache_control)
 * - Others: ignored gracefully
 *
 * OpenRouter routes to the correct provider, and for Gemini uses only the last breakpoint.
 */
export function addCacheControl(messages: Record<string, unknown>[], model: string): void {
  let targetIdx: number;

  if (isGeminiModel(model)) {
    // Gemini: system messages become system_instruction and lose cache_control.
    // Put breakpoint on the first user message instead.
    targetIdx = messages.findIndex((m) => m['role'] === 'user');
  } else {
    // Anthropic/others: breakpoint on last leading system message
    targetIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]?.['role'] !== 'system') break;
      targetIdx = i;
    }
  }

  if (targetIdx === -1) return;

  const msg = messages[targetIdx];
  if (!msg) return;
  const content = msg['content'];
  if (typeof content !== 'string') return; // already multipart or null

  // Convert to multipart content with cache_control breakpoint
  msg['content'] = [
    {
      type: 'text',
      text: content,
      cache_control: { type: 'ephemeral' },
    },
  ];
}
