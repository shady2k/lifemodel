/**
 * Intent Compiler
 *
 * Converts tool results into Intents for the CoreLoop to execute.
 * Pure module — read-only access to state, no mutation.
 */

import type { Logger } from '../../types/logger.js';
import type { Intent } from '../../types/intent.js';
import type {
  ToolResult,
  LoopState,
  Terminal,
  StructuredFact,
  EvidenceSource,
} from '../../types/cognition.js';
import { THOUGHT_LIMITS } from '../../types/signal.js';
import type { ThoughtData } from '../../types/signal.js';
import type { LoopContext, LoopResult } from './agentic-loop-types.js';

/**
 * Compile intents from tool results.
 * Includes trace metadata for log analysis and tool call data for conversation history.
 */
export function compileIntentsFromToolResults(
  terminal: Terminal,
  context: LoopContext,
  state: LoopState,
  logger: Logger
): Intent[] {
  const intents: Intent[] = [];
  const toolResults = state.toolResults;

  // Build base trace from context
  // tickId = batch grouping, parentSignalId = causal chain
  const baseTrace = {
    tickId: context.tickId,
    parentSignalId: context.triggerSignal.id,
  };

  // Emit a single merged thought from all collected thoughts (batched during loop)
  if (state.collectedThoughts.length > 0) {
    const mergedContent = state.collectedThoughts.join(' | ');
    const mergedResult: ToolResult = {
      toolCallId: 'batched-thought',
      toolName: 'core.thought',
      resultId: 'batched-thought',
      success: true,
      data: { content: mergedContent },
    };
    const thoughtIntent = thoughtToolResultToIntent(mergedResult, context, logger);
    if (thoughtIntent) {
      thoughtIntent.trace = { ...baseTrace, toolCallId: 'batched-thought' };
      intents.push(thoughtIntent);
    }
  }

  // Convert tool results to intents
  for (const result of toolResults) {
    // Skip results whose intents were already applied immediately during loop execution
    // (REMEMBER and SET_INTEREST are applied immediately for visibility to subsequent tools)
    if (result.immediatelyApplied) {
      continue;
    }

    // core.thought is handled above via collectedThoughts batch — skip individual results
    if (result.toolName === 'core.thought') {
      continue;
    }

    // Handle all other tools via the typed map
    const toolIntent = toolResultToIntent(result, context);
    if (toolIntent) {
      toolIntent.trace = { ...baseTrace, toolCallId: result.toolCallId };
      intents.push(toolIntent);
    }
  }

  // Add response intent if terminal is respond
  if (terminal.type === 'respond' && context.recipientId) {
    intents.push({
      type: 'SEND_MESSAGE',
      payload: {
        recipientId: context.recipientId,
        text: terminal.text,
        conversationStatus: terminal.conversationStatus,
      },
      trace: baseTrace,
    });

    logger.debug(
      {
        recipientId: context.recipientId,
        textLength: terminal.text.length,
        conversationStatus: terminal.conversationStatus,
      },
      'SEND_MESSAGE intent created'
    );
  } else if (terminal.type === 'respond') {
    // Response generated but cannot be routed - log for debugging
    const reason = !context.recipientId ? 'recipientId missing from LoopContext' : 'unknown reason';
    logger.warn(
      {
        textLength: terminal.text.length,
        textPreview: terminal.text.slice(0, 100),
        triggerType: context.triggerSignal.type,
        reason,
      },
      'Response generated but SEND_MESSAGE intent NOT created - message will not be delivered'
    );
  }

  // Add deferral intent if terminal is defer
  if (terminal.type === 'defer') {
    const deferMs = terminal.deferHours * 60 * 60 * 1000;

    intents.push({
      type: 'DEFER_SIGNAL',
      payload: {
        signalType: terminal.signalType,
        deferMs,
        reason: terminal.reason,
      },
      trace: baseTrace,
    });
  }

  return intents;
}

/**
 * Typed mapping from tool results to intents.
 * Tools return validated payloads → this map converts them to Intents.
 *
 * Key design principle: Tools validate and return data, they don't mutate.
 * This map bridges the gap to CoreLoop which performs actual mutations.
 */
export function toolResultToIntent(result: ToolResult, context: LoopContext): Intent | null {
  // Skip failed tools - they don't produce intents
  if (!result.success) {
    return null;
  }

  const data = result.data as Record<string, unknown> | undefined;
  if (!data) {
    return null;
  }

  switch (result.toolName) {
    case 'core.agent': {
      // core.agent update → UPDATE_STATE intent
      if (data['action'] !== 'update') return null;
      return {
        type: 'UPDATE_STATE',
        payload: {
          key: data['field'] as string,
          value: data['value'] as number,
          delta: data['operation'] === 'delta',
        },
      };
    }

    case 'core.schedule': {
      // core.schedule create → SCHEDULE_EVENT intent
      if (data['action'] !== 'create') return null;
      return {
        type: 'SCHEDULE_EVENT',
        payload: {
          event: {
            source: 'cognition',
            type: data['eventType'] as string,
            priority: 50,
            payload: data['eventContext'] as Record<string, unknown>,
          },
          delay: data['delayMs'] as number,
          scheduleId: result.toolCallId,
        },
      };
    }

    case 'core.memory': {
      // core.memory saveFact → SAVE_TO_MEMORY intent (deprecated - use core.remember)
      if (data['action'] !== 'saveFact') return null; // search/save handled differently
      return {
        type: 'SAVE_TO_MEMORY',
        payload: {
          type: 'fact',
          recipientId: context.recipientId,
          fact: data['fact'] as StructuredFact,
        },
      };
    }

    case 'core.remember': {
      // core.remember → REMEMBER intent
      if (data['action'] !== 'remember') return null;
      return {
        type: 'REMEMBER',
        payload: {
          subject: data['subject'] as string,
          attribute: data['attribute'] as string,
          value: data['value'] as string,
          confidence: data['confidence'] as number,
          source: data['source'] as EvidenceSource,
          evidence: data['evidence'] as string | undefined,
          isUserFact: data['isUserFact'] as boolean,
          recipientId: context.recipientId,
        },
      };
    }

    case 'core.setInterest': {
      // core.setInterest → SET_INTEREST intent
      if (data['action'] !== 'setInterest') return null;
      return {
        type: 'SET_INTEREST',
        payload: {
          topic: data['topic'] as string,
          intensity: data['intensity'] as
            | 'strong_positive'
            | 'weak_positive'
            | 'weak_negative'
            | 'strong_negative',
          urgent: data['urgent'] as boolean,
          source: data['source'] as EvidenceSource,
          recipientId: context.recipientId,
        },
      };
    }

    // core.thought is handled separately via thoughtToolResultToIntent
    // because it has complex depth/recursion logic

    default:
      return null;
  }
}

/**
 * Convert core.thought tool result to EMIT_THOUGHT intent.
 */
export function thoughtToolResultToIntent(
  result: ToolResult,
  context: LoopContext,
  logger: Logger
): Intent | null {
  const data = result.data as { content?: string; reason?: string } | undefined;
  if (!data?.content) {
    return null;
  }

  const content = data.content;

  // SECURITY: Derive depth from actual trigger signal, not LLM-provided data
  // This prevents the LLM from resetting depth to 0 to bypass recursion limits
  let depth: number;
  let rootId: string;
  let parentId: string | undefined;
  let triggerSource: 'conversation' | 'memory' | 'thought';

  if (context.triggerSignal.type === 'thought') {
    // Processing a thought signal - MUST increment from trigger's depth
    const triggerData = context.triggerSignal.data as ThoughtData | undefined;
    if (triggerData) {
      depth = triggerData.depth + 1;
      rootId = triggerData.rootThoughtId;
      parentId = context.triggerSignal.id;
      triggerSource = 'thought';
    } else {
      // Malformed thought signal - reject
      logger.warn('Thought signal missing ThoughtData, rejecting thought tool');
      return null;
    }
  } else {
    // Not triggered by thought - this is a root thought from conversation/other
    depth = 0;
    rootId = `thought_${result.toolCallId}`;
    parentId = undefined;
    triggerSource = context.triggerSignal.type === 'user_message' ? 'conversation' : 'memory';
  }

  // Validate depth limit
  if (depth > THOUGHT_LIMITS.MAX_DEPTH) {
    logger.warn({ depth, content: content.slice(0, 30) }, 'Thought rejected: max depth exceeded');
    return null;
  }

  return {
    type: 'EMIT_THOUGHT',
    payload: {
      content,
      triggerSource,
      depth,
      rootThoughtId: rootId,
      signalSource: 'cognition.thought',
      ...(parentId !== undefined && { parentThoughtId: parentId }),
      ...(context.recipientId !== undefined && { recipientId: context.recipientId }),
    },
  };
}

/**
 * Calculate confidence based on loop state.
 * Low iteration count and no forceRespond suggests higher confidence.
 */
export function calculateConfidence(state: LoopState): number {
  // Base confidence
  let confidence = 0.8;

  // Reduce confidence if we ever had to force respond (indicates difficulty)
  // This persists even after forceRespond is cleared to track prior difficulty
  if (state.everForcedRespond) {
    confidence -= 0.2;
  }

  // Reduce confidence if many iterations (indicates uncertainty)
  if (state.iteration > 3) {
    confidence -= 0.1;
  }

  return Math.max(0.1, Math.min(1.0, confidence));
}

/**
 * Build final result from natural completion (no tool calls).
 * This implements Codex-style termination where the LLM naturally stops calling tools.
 */
export function buildFinalResultFromNaturalCompletion(
  messageText: string | null,
  state: LoopState,
  context: LoopContext,
  logger: Logger
): LoopResult {
  // messageText is already clean (parsed from JSON by parseResponseContent)
  const terminal: Terminal = messageText
    ? {
        type: 'respond',
        text: messageText,
        conversationStatus: state.conversationStatus ?? 'active',
        confidence: calculateConfidence(state),
      }
    : {
        type: 'noAction',
        reason: 'No response needed',
      };

  const intents = compileIntentsFromToolResults(terminal, context, state, logger);
  return { success: true, terminal, intents, state };
}
