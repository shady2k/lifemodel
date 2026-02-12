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

export interface ParseOptions {
  /** Allow plain-text (non-JSON) responses. Default: true.
   *  Set to false for proactive triggers where prompt leakage is likely. */
  allowPlainText?: boolean;
}

/**
 * Parse LLM response content, handling both JSON schema and plain text.
 * When toolChoice is 'none', we use JSON schema with {response: string, status?: string}.
 * Returns both the response text and optional conversation status.
 *
 * Malformed detection:
 * - If content starts with '{' or '```' but can't be parsed as valid JSON → malformed: true
 * - If JSON parses but response field is missing or wrong type → malformed: true
 * - If allowPlainText is false and content is not JSON → malformed: true
 * - Prevents truncated/broken model output from reaching the user as raw JSON text
 */
export function parseResponseContent(
  content: string | null,
  options?: ParseOptions
): {
  text: string | null;
  status?: ConversationStatus;
  urgent?: boolean;
  malformed?: boolean;
} {
  if (!content) {
    return { text: null };
  }

  const trimmed = content.trim();
  const stripLeadingTimestamp = (text: string): string =>
    text
      .replace(/^(?:<msg_time>[^<]*<\/msg_time>\s*)+/, '') // XML-style timestamps
      .replace(
        /^(?:\[(?:(?:yesterday\s+)?(?:[01]?\d|2[0-3]):[0-5]\d|[A-Z][a-z]{2}\s+\d{1,2},\s*(?:[01]?\d|2[0-3]):[0-5]\d)\]\s*)+/,
        ''
      ) // Legacy [HH:MM], [yesterday HH:MM], [Feb 4, HH:MM]
      .trimStart();

  // Step 0: Strip leading timestamps BEFORE structural detection.
  // Weak models (GLM) prepend <msg_time> tags even when json_schema is enforced,
  // which defeats the code-fence and JSON-start checks below.
  let jsonStr = stripLeadingTimestamp(trimmed);

  // Step 1: Strip code-fence wrapper if present (```json ... ```)
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
  // Check for JSON at start OR at end (models sometimes output text, then JSON)
  let looksLikeJson = jsonStr.startsWith('{');
  let jsonCandidate = jsonStr;

  // If content doesn't start with '{', check if it ends with a JSON object
  // This handles models that output thinking/rationale as text, then JSON
  if (!looksLikeJson && jsonStr.includes('\n')) {
    // Find the last occurrence of '{' and try to parse from there
    const lastBraceIndex = jsonStr.lastIndexOf('{');
    if (lastBraceIndex > 0) {
      const potentialJson = jsonStr.slice(lastBraceIndex);
      // Quick validation: must end with '}' and have balanced braces
      if (potentialJson.endsWith('}')) {
        let braceCount = 0;
        let inString = false;
        let escapeNext = false;
        for (const char of potentialJson) {
          if (escapeNext) {
            escapeNext = false;
            continue;
          }
          if (char === '\\') {
            escapeNext = true;
            continue;
          }
          if (char === '"') {
            inString = !inString;
            continue;
          }
          if (!inString) {
            if (char === '{') braceCount++;
            if (char === '}') braceCount--;
          }
        }
        // If braces are balanced (should end at 0), try parsing
        if (braceCount === 0) {
          jsonCandidate = potentialJson;
          looksLikeJson = true;
        }
      }
    }
  }

  if (looksLikeJson) {
    try {
      const parsed = JSON.parse(jsonCandidate) as {
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
      const responseText = parsed.response.trim();
      const cleanedText = stripLeadingTimestamp(responseText).trim();
      const finalText = cleanedText || null;

      const urgent = parsed.urgent === true;

      return { text: finalText, ...(status ? { status } : {}), ...(urgent ? { urgent } : {}) };
    } catch {
      // 3a: Starts with '{' but JSON.parse failed → truncated/malformed JSON
      return { text: null, malformed: true };
    }
  }

  // Step 3b: Not JSON — plain text fallback
  // Only allowed for user_message triggers; proactive triggers require JSON
  // to prevent prompt leakage (model echoing instructions as plain text).
  if (options?.allowPlainText === false) {
    return { text: null, malformed: true };
  }

  // Detect tool-call-like XML — model tried to invoke tools as text (e.g., tools were stripped)
  // Covers: our <core.tool> format, GLM-native <tool_call>, and generic <function_call>/<tool_use>
  if (
    /^<core\.\w+[\s>]/m.test(trimmed) ||
    /<core\.\w+>[\s\S]*?<\/core\.\w+>/m.test(trimmed) ||
    /<tool_call>|<function_call>|<tool_use>/m.test(trimmed)
  ) {
    return { text: null, malformed: true };
  }

  return { text: stripLeadingTimestamp(trimmed) };
}
