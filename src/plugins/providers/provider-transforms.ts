/**
 * Provider Transforms
 *
 * Helper functions for handling provider-specific message transformations.
 * These are shared between OpenRouter providers and VercelAIProvider.
 *
 * Note: Gemini-specific message structure normalization (user turn requirement,
 * system message conversion) has been moved to transcript-compiler.ts.
 */

import { resolveModelParams } from './model-params.js';

/**
 * Check if the model is a Gemini model.
 * Uses word boundary matching to catch various naming conventions:
 * - google/gemini-2.0-flash
 * - gemini-2.0-flash-exp
 * - deepseek/deepseek-r1-distill-llama-70b (NOT matched)
 */
export function isGeminiModel(model: string): boolean {
  return /\bgemini\b/i.test(model);
}

/**
 * Add cache_control breakpoint for prompt caching.
 * Converts plain string content to multipart format with cache_control.
 *
 * Strategy differs by provider:
 * - Anthropic: breakpoint on last system message (caches full system prefix)
 * - Gemini: breakpoint on first user message (system_instruction loses cache_control)
 * - Models without cache support: skipped entirely
 *
 * OpenRouter routes to the correct provider, and for Gemini uses only the last breakpoint.
 */
export function addCacheControl(messages: Record<string, unknown>[], model: string): void {
  // Check if this model supports prompt caching using the model params configuration
  const params = resolveModelParams(model);
  if (params.supportsCacheControl === false) {
    return; // Skip cache control for models that don't support it
  }

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
