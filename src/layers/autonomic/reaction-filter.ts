/**
 * ReactionSignalFilter - transforms message reactions into thought signals.
 *
 * Part of the "digital human" philosophy: reactions are non-verbal feedback
 * (like a nod or smile) that triggers reflection. The filter does NOT
 * pre-classify sentiment (no hardcoded "positive" vs "negative" lists).
 * Instead, COGNITION (the LLM) naturally interprets emoji meaning in context.
 *
 * Signal flow:
 * ```
 * Telegram → message_reaction signal → CoreLoop (enrich) → AUTONOMIC (→ thought) → COGNITION
 * ```
 *
 * The thought content is self-explanatory:
 * - "User reacted 👍 to my message: 'Here's an interesting article about local AI models...'"
 *
 * COGNITION naturally understands:
 * - What the emoji means (👍 = positive, 👎 = negative)
 * - What topic it relates to (from the message preview)
 * - What tools to use (core.setInterest, core.remember, or just acknowledge)
 */

import type { SignalFilter, FilterContext } from './filter-registry.js';
import type { Signal, MessageReactionData, SignalType } from '../../types/signal.js';
import { createThoughtSignal } from '../../types/signal.js';

/**
 * ReactionSignalFilter implementation.
 *
 * Transforms message_reaction signals into thought signals for COGNITION processing.
 * This is a synchronous transformation - the signal has already been enriched
 * with message preview by CoreLoop before reaching this filter.
 */
export class ReactionSignalFilter implements SignalFilter {
  readonly id = 'reaction-filter';
  readonly description = 'Transforms message reactions into thought signals';
  readonly handles: SignalType[] = ['message_reaction'];

  /**
   * Process reaction signals and transform them into thoughts.
   *
   * @param signals Incoming message_reaction signals (already enriched with preview)
   * @param _context Filter context (unused - we don't need user model for this)
   * @returns Thought signals for COGNITION
   */
  process(signals: Signal[], _context: FilterContext): Signal[] {
    const result: Signal[] = [];

    for (const signal of signals) {
      const data = signal.data as MessageReactionData;

      // Format thought content - LLM interprets emoji sentiment naturally
      // No pre-classification needed (👍 = positive, 👎 = negative, etc.)
      const preview = data.reactedMessagePreview ?? '[message not found]';
      const thoughtContent = `User reacted ${data.emoji} to my message: "${preview}"`;

      // Transform to thought signal
      // The thought will be processed by COGNITION which has access to:
      // - core.setInterest() to adjust topic weights
      // - core.remember() to store observations
      // - sendMessage to optionally acknowledge
      const thoughtSignal = createThoughtSignal({
        content: thoughtContent,
        triggerSource: 'plugin', // From external input (reaction)
        depth: 0, // Root thought (not a chain)
        rootThoughtId: `reaction_${signal.id}`,
      });

      result.push(thoughtSignal);
    }

    return result;
  }
}

/**
 * Create a ReactionSignalFilter instance.
 */
export function createReactionSignalFilter(): ReactionSignalFilter {
  return new ReactionSignalFilter();
}
