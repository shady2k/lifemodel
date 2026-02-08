/**
 * Tool Executor
 *
 * Handles tool call execution within the agentic loop.
 * Primary LoopState mutator during the main loop.
 * Also mutated by: retry-builder.ts (initialization), loop-orchestrator.ts (proactive budget),
 * and agentic-loop.ts (loop control fields).
 *
 * Responsibilities:
 * - JSON args parsing
 * - Validation against tool schemas
 * - Per-tool call limits (maxCallsPerTurn)
 * - Proactive budget decrement
 * - Repeated/identical call detection
 * - Immediate intent application for REMEMBER/SET_INTEREST
 * - core.escalate, core.defer, core.say, core.thought interception
 */

import type { Logger } from '../../types/logger.js';
import type { Intent } from '../../types/intent.js';
import type { ToolResult, LoopState, Terminal } from '../../types/cognition.js';
import { MAX_REPEATED_FAILED_CALLS, MAX_REPEATED_IDENTICAL_CALLS } from '../../types/cognition.js';
import { unsanitizeToolName } from '../../llm/tool-schema.js';
import type { Message, ToolCall } from '../../llm/provider.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';
import type { LoopContext, LoopCallbacks, ToolExecutionOutcome } from './agentic-loop-types.js';

/**
 * Tools whose intents should be applied immediately during loop execution.
 * This allows subsequent tools in the same loop to see the data.
 * - core.remember: User facts should be immediately queryable
 * - core.setInterest: Topic interests should be immediately visible
 */
export const IMMEDIATE_INTENT_TOOLS = ['core.remember', 'core.setInterest'] as const;

/**
 * Create a signature for a tool call to detect repeated identical calls.
 * Filters out null values to normalize different ways LLMs pass "not provided".
 */
export function getCallSignature(toolName: string, args: Record<string, unknown>): string {
  // Filter out null/undefined values - LLMs may pass them differently
  const normalizedArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== null && value !== undefined) {
      normalizedArgs[key] = value;
    }
  }

  // Sort keys for consistent ordering
  const sortedKeys = Object.keys(normalizedArgs).sort();
  const sortedArgs: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sortedArgs[key] = normalizedArgs[key];
  }

  return `${toolName}:${JSON.stringify(sortedArgs)}`;
}

export interface ExecuteToolCallsParams {
  toolCalls: ToolCall[];
  /** Chain-of-thought content from the LLM response (preserved in assistant message) */
  responseContent: string | null;
  messages: Message[];
  state: LoopState;
  context: LoopContext;
  callbacks: LoopCallbacks | undefined;
  toolRegistry: ToolRegistry;
  logger: Logger;
  toolResultToIntent: (result: ToolResult, context: LoopContext) => Intent | null;
  buildToolContext: (context: LoopContext) => ToolContext;
  /** Called when core.escalate is intercepted — returns enriched LoopContext for restart */
  onEscalate: (state: LoopState, context: LoopContext, reason: string) => LoopContext;
  /** Called to compile intents from tool results (for defer terminal) */
  compileIntents: (terminal: Terminal, context: LoopContext, state: LoopState) => Intent[];
}

/**
 * Execute a batch of tool calls from the LLM response.
 *
 * Returns a discriminated union to preserve loop control flow:
 * - 'continue': processed tool calls, loop should continue
 * - 'escalate': core.escalate intercepted, restart with smart model
 * - 'defer': core.defer intercepted, terminal
 */
export async function executeToolCalls(
  params: ExecuteToolCallsParams
): Promise<ToolExecutionOutcome> {
  const {
    toolCalls,
    responseContent,
    messages,
    state,
    context,
    callbacks,
    toolRegistry,
    logger,
    toolResultToIntent,
    buildToolContext: buildCtx,
    onEscalate,
    compileIntents,
  } = params;

  // Sort tool calls to ensure core.escalate is processed LAST within the batch
  // This ensures other tools complete before escalation restarts the loop
  const sortedToolCalls = [...toolCalls].sort((a, b) => {
    const aName = unsanitizeToolName(a.function.name);
    const bName = unsanitizeToolName(b.function.name);
    // core.escalate should be last (highest sort value)
    if (aName === 'core.escalate') return 1;
    if (bName === 'core.escalate') return -1;
    return 0;
  });

  // Add assistant message with tool calls to history
  // This keeps tool call/result pairs atomic (CLAUDE.md Lesson #2)
  messages.push({
    role: 'assistant',
    content: responseContent,
    tool_calls: toolCalls,
  });

  // Process tool calls (only one at a time due to parallel_tool_calls: false)
  for (const toolCall of sortedToolCalls) {
    const toolName = unsanitizeToolName(toolCall.function.name);
    let args: Record<string, unknown>;

    try {
      // Handle empty arguments string as empty object
      const argsString = toolCall.function.arguments.trim();
      args = argsString === '' ? {} : (JSON.parse(argsString) as Record<string, unknown>);
    } catch {
      logger.error(
        { toolName, arguments: toolCall.function.arguments },
        'Failed to parse tool arguments'
      );
      // Count toward tool call limit to prevent infinite loops on malformed JSON
      state.toolCallCount++;
      // Add helpful error - tell LLM to get schema first
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          error:
            'Invalid arguments. Call core.tools({ action: "describe", name: "' +
            toolName +
            '" }) to get the required parameters.',
        }),
      });
      continue;
    }

    // Validate args against tool schema before execution
    const tool = toolRegistry.getTools().find((t) => t.name === toolName);
    if (tool) {
      const validation = tool.validate(args);
      if (!validation.success) {
        const outcome = processToolValidationFailure(
          toolCall,
          toolName,
          args,
          validation.error,
          state,
          messages,
          logger
        );
        if (outcome) return outcome;
        continue;
      }
    }

    // ── Per-tool call limit (maxCallsPerTurn) ──
    const currentCallCount = (state.toolCallCounts.get(toolName) ?? 0) + 1;
    state.toolCallCounts.set(toolName, currentCallCount);
    const maxCalls = toolRegistry.getMaxCallsPerTurn(toolName);
    if (maxCalls !== undefined && currentCallCount > maxCalls) {
      logger.warn(
        { tool: toolName, count: currentCallCount, max: maxCalls },
        'Tool per-turn call limit exceeded'
      );
      state.toolCallCount++;
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          success: false,
          error: `${toolName} limit reached (max ${String(maxCalls)} per turn). Use the results you already have.`,
        }),
      });

      // Count limit violations toward proactive budget (LLM "spent" an action)
      if (state.proactiveToolBudget !== undefined) {
        state.proactiveToolBudget--;
        if (state.proactiveToolBudget <= 0) {
          state.forceRespond = true;
        }
      }

      // Global safety valve: force respond after cumulative limit violations
      state.limitViolationCount++;
      if (state.limitViolationCount >= 3) {
        state.forceRespond = true;
        logger.warn(
          { violations: state.limitViolationCount },
          'Multiple tool limits exceeded — forcing response'
        );
      }

      continue;
    }

    // Intercept core.escalate - restart with smart model
    if (toolName === 'core.escalate') {
      const reason =
        typeof args['reason'] === 'string' && args['reason']
          ? args['reason']
          : 'LLM requested deeper reasoning';
      logger.info({ reason }, 'Escalating to smart model');

      // Build enriched context for the caller to restart with
      const enrichedContext = onEscalate(state, context, reason);
      return { type: 'escalate', enrichedContext };
    }

    // Intercept core.defer - TERMINAL, ends loop with DeferTerminal
    if (toolName === 'core.defer') {
      const signalType = args['signalType'] as string;
      const reason = args['reason'] as string;
      const deferHours = args['deferHours'] as number;

      logger.info({ signalType, reason, deferHours }, 'Deferring via core.defer');

      const terminal: Terminal = {
        type: 'defer',
        signalType,
        reason,
        deferHours,
      };

      const intents = compileIntents(terminal, context, state);
      return { type: 'defer', result: { success: true, terminal, intents, state } };
    }

    // Intercept core.say - send intermediate message, continue loop
    if (toolName === 'core.say') {
      const text = typeof args['text'] === 'string' ? args['text'].trim() : '';
      state.toolCallCount++;

      if (!text) {
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ success: false, error: 'Text cannot be empty' }),
        });
        continue;
      }

      // Send immediately via callback
      if (callbacks?.onImmediateIntent && context.recipientId) {
        callbacks.onImmediateIntent({
          type: 'SEND_MESSAGE',
          payload: {
            recipientId: context.recipientId,
            text,
            conversationStatus: 'active',
          },
        });
      }

      // Track for smart retry so escalation knows a message was already sent
      state.executedTools.push({
        toolCallId: toolCall.id,
        name: toolName,
        args,
        hasSideEffects: true,
      });
      state.toolResults.push({
        toolCallId: toolCall.id,
        toolName,
        resultId: `${toolCall.id}-result`,
        success: true,
        data: {
          success: true,
          delivered_text: text,
          note: 'ALREADY DELIVERED to user. Your final response must NOT repeat or paraphrase this text. Continue from where this message left off.',
        },
      });

      logger.debug(
        { textLength: text.length, sayCount: state.toolCallCounts.get('core.say') ?? 0 },
        'Intermediate message sent via core.say'
      );

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          success: true,
          delivered_text: text,
          note: 'ALREADY DELIVERED to user. Your final response must NOT repeat or paraphrase this text. Continue from where this message left off.',
        }),
      });
      continue;
    }

    // Intercept core.thought - execute tool and batch valid thoughts for later processing
    if (toolName === 'core.thought') {
      state.toolCallCount++;

      // Execute the tool — it validates content
      const thoughtResult = await toolRegistry.execute({
        toolCallId: toolCall.id,
        name: toolName,
        args,
        context: buildCtx(context),
      });

      const resultData = thoughtResult.data as Record<string, unknown> | undefined;
      if (resultData?.['success'] === true && typeof resultData['content'] === 'string') {
        state.collectedThoughts.push(resultData['content']);
      }

      // Track for smart retry so thoughts survive escalation
      state.executedTools.push({
        toolCallId: toolCall.id,
        name: toolName,
        args,
        hasSideEffects: false,
      });
      state.toolResults.push(thoughtResult);

      // Return the tool's actual response (success or rejection)
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(
          resultData ?? { success: false, error: 'Thought processing failed' }
        ),
      });
      continue;
    }

    // Track for smart retry
    state.executedTools.push({
      toolCallId: toolCall.id,
      name: toolName,
      args,
      hasSideEffects: toolRegistry.hasToolSideEffects(toolName),
    });

    // Execute non-terminal tool
    state.toolCallCount++;
    const result = await toolRegistry.execute({
      toolCallId: toolCall.id,
      name: toolName,
      args,
      context: buildCtx(context),
    });

    state.toolResults.push(result);

    // Decrement proactive tool budget and force respond when exhausted
    if (state.proactiveToolBudget !== undefined) {
      state.proactiveToolBudget--;
      if (state.proactiveToolBudget <= 0) {
        logger.info(
          { toolCallCount: state.toolCallCount },
          'Proactive tool budget exhausted, forcing response'
        );
        state.forceRespond = true;
      }
    }

    // Apply REMEMBER and SET_INTEREST intents immediately so subsequent tools can see the data
    applyImmediateIntentIfNeeded(result, toolName, context, callbacks, toolResultToIntent, logger);

    // Record completed side-effect plugin tool calls to prevent re-execution
    if (
      result.success &&
      toolRegistry.hasToolSideEffects(toolName) &&
      callbacks?.onCompletedAction &&
      context.recipientId
    ) {
      const summary = summarizeToolCall(
        toolName,
        args,
        result.data as Record<string, unknown> | undefined
      );
      callbacks.onCompletedAction(context.recipientId, toolName, summary);
    }

    // Track ALL identical tool calls to detect loops (successful or failed)
    const callSig = getCallSignature(toolName, args);
    const identicalCount = (state.identicalCallCounts.get(callSig) ?? 0) + 1;
    state.identicalCallCounts.set(callSig, identicalCount);

    if (identicalCount >= MAX_REPEATED_IDENTICAL_CALLS) {
      const outcome = processRepeatedIdenticalCall(
        toolCall,
        toolName,
        args,
        result,
        identicalCount,
        state,
        messages,
        logger
      );
      if (outcome) return outcome;
      continue; // Skip normal result handling
    }

    // Track repeated failed tool calls to detect loops
    if (!result.success) {
      const outcome = processRepeatedFailure(
        toolCall,
        toolName,
        args,
        result,
        state,
        messages,
        logger
      );
      if (outcome) return outcome;
    } else {
      // Success - add result to message history (OpenAI format)
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result.data),
      });
    }
  }

  return { type: 'continue', messages };
}

function processToolValidationFailure(
  toolCall: ToolCall,
  toolName: string,
  args: Record<string, unknown>,
  error: string,
  state: LoopState,
  messages: Message[],
  logger: Logger
): ToolExecutionOutcome | null {
  // Track repeated failed calls to detect loops
  const callSig = getCallSignature(toolName, args);
  const failCount = (state.failedCallCounts.get(callSig) ?? 0) + 1;
  state.failedCallCounts.set(callSig, failCount);

  const isRepeatedFailure = failCount >= MAX_REPEATED_FAILED_CALLS;

  logger.warn(
    { tool: toolName, error, failCount, isRepeatedFailure },
    isRepeatedFailure
      ? 'Tool validation failed repeatedly - forcing response'
      : 'Tool validation failed, sending error to LLM for retry'
  );

  // Count toward tool call limit to prevent infinite loops
  state.toolCallCount++;

  // Build structured error following ChatGPT best practices
  const errorContent = {
    success: false,
    error: {
      type: 'validation_error',
      message: error,
      retryable: !isRepeatedFailure,
    },
    hint: isRepeatedFailure
      ? {
          notes: [
            `STOP: This exact call has failed ${String(failCount)} times.`,
            'Do NOT retry with same parameters.',
            'Respond to the user or ask for missing information.',
          ],
        }
      : {
          notes: ['Check parameter types and required fields.'],
        },
  };

  // Add error as tool result so LLM can retry (or stop if repeated)
  messages.push({
    role: 'tool',
    tool_call_id: toolCall.id,
    content: JSON.stringify(errorContent),
  });

  state.toolResults.push({
    toolCallId: toolCall.id,
    toolName,
    resultId: `${toolCall.id}-validation-error`,
    success: false,
    error,
  });

  // Force LLM to respond on next iteration if repeated failures
  if (isRepeatedFailure) {
    state.forceRespond = true;
  }

  return null; // continue processing remaining tool calls
}

function processRepeatedIdenticalCall(
  toolCall: ToolCall,
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
  identicalCount: number,
  state: LoopState,
  messages: Message[],
  logger: Logger
): ToolExecutionOutcome | null {
  // First occurrence (count=2): warn but let LLM continue with tools
  // Subsequent (count>=3): force response
  const shouldForceRespond = identicalCount > MAX_REPEATED_IDENTICAL_CALLS;

  logger.warn(
    { tool: toolName, params: args, identicalCount, forceRespond: shouldForceRespond },
    shouldForceRespond
      ? 'Identical tool call repeated - forcing response'
      : 'Identical tool call detected - warning LLM'
  );

  // Add warning to the response
  const loopWarning = {
    ...(result.data as Record<string, unknown>),
    _identicalCallWarning: {
      count: identicalCount,
      message: `You already called ${toolName} with these parameters. The result is the same.`,
      action: shouldForceRespond
        ? 'STOP. Respond to the user directly NOW.'
        : 'Use the result above. Call a different tool or respond to the user.',
    },
  };

  messages.push({
    role: 'tool',
    tool_call_id: toolCall.id,
    content: JSON.stringify(loopWarning),
  });

  if (shouldForceRespond) {
    state.forceRespond = true;
  }

  return null; // continue processing remaining tool calls (already added message)
}

function processRepeatedFailure(
  toolCall: ToolCall,
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
  state: LoopState,
  messages: Message[],
  logger: Logger
): ToolExecutionOutcome | null {
  const callSig = getCallSignature(toolName, args);
  const failCount = (state.failedCallCounts.get(callSig) ?? 0) + 1;
  state.failedCallCounts.set(callSig, failCount);

  const isRepeatedFailure = failCount >= MAX_REPEATED_FAILED_CALLS;

  if (isRepeatedFailure) {
    logger.warn(
      { tool: toolName, error: result.error, failCount },
      'Tool execution failed repeatedly - forcing response'
    );
    state.forceRespond = true;
  }

  // Pass through the tool's error response (which may already be structured)
  // but add repeated-failure hints if needed
  const toolErrorData = result.data ?? { error: result.error };
  const errorContent = isRepeatedFailure
    ? {
        ...toolErrorData,
        _repeatWarning: {
          failCount,
          message: `STOP: This exact call has failed ${String(failCount)} times.`,
          action: 'Do NOT retry. Respond to the user directly.',
        },
      }
    : toolErrorData;

  messages.push({
    role: 'tool',
    tool_call_id: toolCall.id,
    content: JSON.stringify(errorContent),
  });

  return null; // continue processing remaining tool calls
}

/**
 * Build a human-readable summary of a tool call for the completed actions ledger.
 * Uses tool-specific formatting for known plugins, with a generic fallback.
 */
export function summarizeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  resultData: Record<string, unknown> | undefined
): string {
  const action = typeof args['action'] === 'string' ? args['action'] : '';

  // Plugin-specific summaries
  if (toolName.startsWith('plugin_calories') || toolName.includes('calories')) {
    return summarizeCaloriesTool(action, args, resultData);
  }

  // Generic fallback: toolName.action(key identifiers from args)
  const keyArgs = Object.entries(args)
    .filter(([k, v]) => k !== 'action' && v !== null && v !== undefined)
    .map(([k, v]) => {
      if (typeof v === 'string') return `${k}="${v.slice(0, 40)}"`;
      if (typeof v === 'number') return `${k}=${String(v)}`;
      return `${k}=...`;
    })
    .slice(0, 3)
    .join(', ');

  const actionPart = action ? `.${action}` : '';
  return `${toolName}${actionPart}(${keyArgs})`;
}

function summarizeCaloriesTool(
  action: string,
  args: Record<string, unknown>,
  resultData: Record<string, unknown> | undefined
): string {
  if (action === 'log' || action === 'quick_log') {
    const rawEntries = args['entries'];
    const entries = Array.isArray(rawEntries)
      ? (rawEntries as Record<string, unknown>[])
      : undefined;
    const foodNames =
      entries
        ?.map((e) => {
          const name = typeof e['name'] === 'string' ? e['name'] : '?';
          const portion = typeof e['portion'] === 'string' ? ` ${e['portion']}` : '';
          return `"${name}"${portion}`;
        })
        .join(', ') ?? '?';

    const rawTotal = resultData?.['totalCalories'] ?? resultData?.['total_calories'];
    const totalCal =
      typeof rawTotal === 'number' || typeof rawTotal === 'string' ? rawTotal : undefined;
    const calStr = totalCal != null ? ` → total: ${String(totalCal)} kcal` : '';
    return `calories.${action}: ${foodNames}${calStr}`;
  }

  if (action === 'delete') {
    const rawId = args['id'] ?? args['entryId'];
    const id = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : '?';
    return `calories.delete: entry ${String(id)}`;
  }

  return `calories.${action || 'unknown'}`;
}

function applyImmediateIntentIfNeeded(
  result: ToolResult,
  toolName: string,
  context: LoopContext,
  callbacks: LoopCallbacks | undefined,
  toolResultToIntent: (result: ToolResult, context: LoopContext) => Intent | null,
  logger: Logger
): void {
  if (!result.success || !callbacks?.onImmediateIntent) return;
  if (!IMMEDIATE_INTENT_TOOLS.includes(toolName as (typeof IMMEDIATE_INTENT_TOOLS)[number])) return;

  // Check semantic success (result.data.success) not just execution success (result.success)
  // Tools like core.remember can execute successfully but return { success: false, error: "..." }
  // when validation fails (e.g., wrong source type for user facts)
  const data = result.data as Record<string, unknown> | undefined;
  if (data?.['success'] === false) {
    // Operation failed - no intent to apply, this is expected behavior
    logger.debug(
      { tool: toolName, error: data['error'] },
      'Tool operation failed, skipping intent conversion'
    );
    return;
  }

  const intent = toolResultToIntent(result, context);
  if (intent) {
    // Add trace for debugging
    intent.trace = {
      tickId: context.tickId,
      parentSignalId: context.triggerSignal.id,
      toolCallId: result.toolCallId,
    };
    callbacks.onImmediateIntent(intent);
    result.immediatelyApplied = true;
    logger.debug(
      { tool: toolName, intentType: intent.type },
      'Intent applied immediately for visibility to subsequent tools'
    );
  } else {
    // This is unexpected - execution and operation succeeded but we couldn't convert
    logger.warn(
      { tool: toolName, resultData: result.data },
      'Failed to convert tool result to intent for immediate processing'
    );
  }
}
