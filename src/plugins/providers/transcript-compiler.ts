/**
 * Transcript Compiler
 *
 * Normalizes message arrays for provider-specific wire formats.
 * Local models (LM Studio) fail with 400 Bad Request when they receive
 * consecutive same-role messages. OpenRouter silently normalizes this.
 * This compiler provides a single pipeline to handle all provider constraints.
 *
 * Architecture:
 *   history-builder.ts (semantic transcript — source of truth)
 *         ↓
 *   transcript-compiler.ts (structural normalization — provider-adjacent)
 *         ↓
 *   addCacheControl() (provider metadata)
 *         ↓
 *   convertMessages() → generateText() (wire format + transport)
 */

import type { Logger } from '../../types/index.js';
import type { Message } from '../../llm/provider.js';
import type { VercelAIProviderConfig } from './vercel-ai-provider.js';
import { isGeminiModel } from './provider-transforms.js';

/**
 * Declarative policy for transcript compilation.
 * Different providers have different constraints on message structure.
 */
export interface TranscriptPolicy {
  /** Policy name for telemetry */
  name: string;
  /** Merge consecutive messages with the same role */
  mergeConsecutiveRoles: boolean;
  /** Max system messages allowed at the start (excess merged) */
  maxLeadingSystemMessages: number;
  /** Require first non-system message to be 'user' (insert synthetic if needed) */
  requireLeadingUserTurn: boolean;
  /** Convert mid-conversation system messages to user role with [System] prefix */
  convertMidSystemToUser: boolean;
}

/**
 * Strict policy for local providers (LM Studio, etc.)
 * These providers reject consecutive same-role messages.
 */
export const STRICT_POLICY: TranscriptPolicy = {
  name: 'strict',
  mergeConsecutiveRoles: true,
  maxLeadingSystemMessages: 1,
  requireLeadingUserTurn: false,
  convertMidSystemToUser: false,
};

/**
 * OpenRouter policy — let OpenRouter handle normalization.
 * OpenRouter silently merges consecutive same-role messages before forwarding.
 */
export const OPENROUTER_POLICY: TranscriptPolicy = {
  name: 'openrouter',
  mergeConsecutiveRoles: false,
  maxLeadingSystemMessages: Infinity,
  requireLeadingUserTurn: false,
  convertMidSystemToUser: false,
};

/**
 * Gemini policy — handles Gemini-specific constraints.
 * - Requires first content turn to be 'user' role
 * - System messages only supported as system_instruction (leading position)
 */
export const GEMINI_POLICY: TranscriptPolicy = {
  name: 'gemini',
  mergeConsecutiveRoles: false,
  maxLeadingSystemMessages: Infinity,
  requireLeadingUserTurn: true,
  convertMidSystemToUser: true,
};

/**
 * Internal working type for the compiler.
 * The _noMerge flag prevents a message from being merged with adjacent messages.
 */
type CompilerMessage = Message & { _noMerge?: boolean };

/**
 * Telemetry data for logging.
 */
interface CompileTelemetry {
  policyName: string;
  beforeCount: number;
  afterCount: number;
  mergedSystemCount: number;
  mergedConsecutiveCount: number;
  convertedSystemCount: number;
  insertedUserTurn: boolean;
}

/**
 * Compile a transcript according to provider policy.
 *
 * Transform pipeline (order matters):
 * 1. Merge leading system messages (if exceeds max)
 * 2. Convert mid-conversation system → user (if policy requires)
 * 3. Insert synthetic user turn (if policy requires and first content is assistant)
 * 4. Merge consecutive same-role messages (if policy requires)
 *
 * @param messages - Input message array
 * @param policy - Compilation policy to apply
 * @param logger - Optional logger for telemetry
 * @returns Normalized message array
 * @throws Error if atomicity assertions fail (tool call pairing)
 */
export function compileTranscript(
  messages: Message[],
  policy: TranscriptPolicy,
  logger?: Logger
): Message[] {
  const telemetry: CompileTelemetry = {
    policyName: policy.name,
    beforeCount: messages.length,
    afterCount: 0,
    mergedSystemCount: 0,
    mergedConsecutiveCount: 0,
    convertedSystemCount: 0,
    insertedUserTurn: false,
  };

  // Work with mutable internal type
  let result: CompilerMessage[] = messages.map((m) => ({ ...m }));

  // Step 1: Merge leading system messages if exceeds max
  result = mergeLeadingSystemMessages(result, policy, telemetry);

  // Step 2: Convert mid-conversation system → user
  result = convertMidSystemToUser(result, policy, telemetry);

  // Step 3: Insert synthetic user turn if required
  result = insertSyntheticUserTurn(result, policy, telemetry);

  // Step 4: Merge consecutive same-role messages
  result = mergeConsecutiveRoles(result, policy, telemetry);

  // Post-compile assertions
  assertToolCallPairing(result, logger);

  // Strip _noMerge flags and update telemetry
  const output: Message[] = result.map(({ _noMerge, ...msg }) => msg);
  telemetry.afterCount = output.length;

  // Log telemetry
  logger?.debug(telemetry, 'Transcript compiled');

  return output;
}

/**
 * Merge leading system messages if count exceeds max.
 */
function mergeLeadingSystemMessages(
  messages: CompilerMessage[],
  policy: TranscriptPolicy,
  telemetry: CompileTelemetry
): CompilerMessage[] {
  if (policy.maxLeadingSystemMessages === Infinity) {
    return messages;
  }

  // Count leading system messages
  let systemCount = 0;
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemCount++;
    } else {
      break;
    }
  }

  if (systemCount <= policy.maxLeadingSystemMessages) {
    return messages;
  }

  // Keep first (max - 1) system messages, merge the rest into one.
  // This guarantees exactly maxLeadingSystemMessages system messages
  // without relying on the consecutive-role merge step.
  const keepCount = policy.maxLeadingSystemMessages;
  const kept = messages.slice(0, keepCount - 1);
  const toMerge = messages.slice(keepCount - 1, systemCount);
  const mergedContent = toMerge
    .map((m) => m.content ?? '')
    .filter((c) => c.length > 0)
    .join('\n\n');

  const result: CompilerMessage[] = [
    ...kept,
    { role: 'system', content: mergedContent || null },
    ...messages.slice(systemCount),
  ];

  telemetry.mergedSystemCount = systemCount - keepCount;
  return result;
}

/**
 * Convert mid-conversation system messages to user role.
 */
function convertMidSystemToUser(
  messages: CompilerMessage[],
  policy: TranscriptPolicy,
  telemetry: CompileTelemetry
): CompilerMessage[] {
  if (!policy.convertMidSystemToUser) {
    return messages;
  }

  // Find where the leading system block ends
  let firstNonSystemIdx = 0;
  while (firstNonSystemIdx < messages.length && messages[firstNonSystemIdx]?.role === 'system') {
    firstNonSystemIdx++;
  }

  // Convert any system messages after the leading block
  let converted = 0;
  const result = messages.map((msg, idx) => {
    if (idx >= firstNonSystemIdx && msg.role === 'system') {
      converted++;
      return {
        role: 'user' as const,
        content: `[System] ${msg.content ?? ''}`,
        _noMerge: true,
      };
    }
    return msg;
  });

  telemetry.convertedSystemCount = converted;
  return result;
}

/**
 * Insert synthetic user turn if first non-system message is assistant.
 */
function insertSyntheticUserTurn(
  messages: CompilerMessage[],
  policy: TranscriptPolicy,
  telemetry: CompileTelemetry
): CompilerMessage[] {
  if (!policy.requireLeadingUserTurn) {
    return messages;
  }

  // Find first non-system message
  const firstContentIdx = messages.findIndex((m) => m.role !== 'system');
  if (firstContentIdx === -1) {
    return messages; // All system — nothing to do
  }

  const firstContentMsg = messages[firstContentIdx];
  if (!firstContentMsg || firstContentMsg.role === 'user') {
    return messages; // Already valid
  }

  // Insert synthetic user turn
  const synthetic: CompilerMessage = {
    role: 'user',
    content: '[autonomous processing]',
  };

  const result = [
    ...messages.slice(0, firstContentIdx),
    synthetic,
    ...messages.slice(firstContentIdx),
  ];

  telemetry.insertedUserTurn = true;
  return result;
}

/**
 * Merge consecutive messages with the same role.
 * Skip messages with: tool_calls, tool_call_id, _noMerge, or null content.
 */
function mergeConsecutiveRoles(
  messages: CompilerMessage[],
  policy: TranscriptPolicy,
  telemetry: CompileTelemetry
): CompilerMessage[] {
  if (!policy.mergeConsecutiveRoles) {
    return messages;
  }

  if (messages.length === 0) {
    return messages;
  }

  const result: CompilerMessage[] = [];
  let mergedCount = 0;

  for (const msg of messages) {
    // Check if this message can be merged
    // Empty tool_calls arrays are treated as absent (not blocking)
    const canMerge =
      (!msg.tool_calls || msg.tool_calls.length === 0) &&
      !msg.tool_call_id &&
      !msg._noMerge &&
      msg.content !== null;

    const prev = result[result.length - 1];

    // Check if we can merge with previous message
    if (
      canMerge &&
      prev &&
      prev.role === msg.role &&
      (!prev.tool_calls || prev.tool_calls.length === 0) &&
      !prev.tool_call_id &&
      !prev._noMerge &&
      prev.content !== null
    ) {
      // Merge: append content with double newline
      prev.content = `${prev.content}\n\n${msg.content ?? ''}`;
      mergedCount++;
    } else {
      // Cannot merge: append as new message
      result.push({ ...msg });
    }
  }

  telemetry.mergedConsecutiveCount = mergedCount;
  return result;
}

/**
 * Assert tool call pairing constraints.
 * - No duplicate tool_call.id values across assistant messages (throws — data corruption)
 * - Orphan tool results (tool_call_id without matching tool_calls) are logged as warnings
 *   but not thrown — trimmed conversation histories legitimately produce these
 */
function assertToolCallPairing(messages: CompilerMessage[], logger?: Logger): void {
  const seenToolCallIds = new Set<string>();
  const toolResultIds = new Map<string, number>(); // id -> count

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (seenToolCallIds.has(tc.id)) {
          throw new Error(`Duplicate tool_call.id found: ${tc.id}`);
        }
        seenToolCallIds.add(tc.id);
      }
    }

    if (msg.role === 'tool' && msg.tool_call_id) {
      const count = toolResultIds.get(msg.tool_call_id) ?? 0;
      toolResultIds.set(msg.tool_call_id, count + 1);
    }
  }

  // Warn (don't throw) on orphan tool results — trimmed histories can legitimately have these
  for (const [id] of toolResultIds) {
    if (!seenToolCallIds.has(id)) {
      logger?.warn(
        { orphanToolCallId: id },
        'Tool result references tool_call_id not in transcript (trimmed history?)'
      );
    }
  }
}

/**
 * Resolve the appropriate transcript policy based on config and model.
 *
 * @param config - Provider configuration
 * @param modelId - Model identifier
 * @returns Appropriate transcript policy
 */
export function resolveTranscriptPolicy(
  config: VercelAIProviderConfig,
  modelId: string
): TranscriptPolicy {
  // Check if this is an OpenRouter config
  const isOpenRouter = 'apiKey' in config;

  if (!isOpenRouter) {
    // Local providers need strict normalization
    return STRICT_POLICY;
  }

  // OpenRouter with Gemini model needs Gemini policy
  if (isGeminiModel(modelId)) {
    return GEMINI_POLICY;
  }

  // OpenRouter handles normalization for other models
  return OPENROUTER_POLICY;
}
