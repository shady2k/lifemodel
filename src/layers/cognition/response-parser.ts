/**
 * Response Parser
 *
 * Parses LLM response content, handling both JSON schema and plain text.
 * Pure module — no state mutation.
 *
 * Key safety invariant: never return raw JSON or partial JSON as user-visible text.
 * If content looks like JSON but can't be properly parsed → malformed: true, text: null.
 */

import type { ConversationStatus } from '../../types/cognition.js';

/**
 * Parse LLM response content, handling both JSON schema and plain text.
 * When toolChoice is 'none', we use JSON schema with {response: string, status?: string}.
 * Returns both the response text and optional conversation status.
 *
 * Malformed detection:
 * - If content starts with '{' or '```' but can't be parsed as valid JSON → malformed: true
 * - If JSON parses but response field is missing or wrong type → malformed: true
 * - Prevents truncated/broken model output from reaching the user as raw JSON text
 */
export function parseResponseContent(content: string | null): {
  text: string | null;
  status?: ConversationStatus;
  urgent?: boolean;
  malformed?: boolean;
} {
  if (!content) {
    return { text: null };
  }

  const trimmed = content.trim();

  // Step 1: Strip code-fence wrapper if present (```json ... ```)
  let jsonStr = trimmed;
  if (jsonStr.startsWith('```')) {
    const match = /^```(?:json)?\s*([\s\S]*?)```\s*$/.exec(jsonStr);
    if (match) {
      jsonStr = match[1]?.trim() ?? jsonStr;
    } else {
      // Starts with ``` but no closing ``` — truncated code fence
      return { text: null, malformed: true };
    }
  }

  // Step 2: Try JSON.parse
  const looksLikeJson = jsonStr.startsWith('{');

  if (looksLikeJson) {
    try {
      const parsed = JSON.parse(jsonStr) as {
        response?: unknown;
        status?: string;
        urgent?: boolean;
      };

      // 2a: response must be a string
      if (typeof parsed.response !== 'string') {
        return { text: null, malformed: true };
      }

      // Validate status if provided
      const validStatuses = ['active', 'awaiting_answer', 'closed', 'idle'];
      const status =
        parsed.status && validStatuses.includes(parsed.status)
          ? (parsed.status as ConversationStatus)
          : undefined;

      // Empty response means "don't send a message" - return null for text
      const responseText = parsed.response.trim() || null;

      const urgent = parsed.urgent === true;

      return { text: responseText, ...(status ? { status } : {}), ...(urgent ? { urgent } : {}) };
    } catch {
      // 3a: Starts with '{' but JSON.parse failed → truncated/malformed JSON
      return { text: null, malformed: true };
    }
  }

  // Step 3b: Not JSON — plain text fallback (for non-JSON-schema providers)
  return { text: trimmed };
}
