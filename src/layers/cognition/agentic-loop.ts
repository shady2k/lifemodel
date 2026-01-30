/**
 * COGNITION Agentic Loop
 *
 * Executes the think → tool → think cycle until natural conclusion using native OpenAI tool calling.
 * Handles tool execution, state updates, and escalation decisions.
 *
 * Flow (native tool calling):
 * 1. Build messages with system prompt and user context
 * 2. Call LLM with tools parameter (tool_choice: "required")
 * 3. If tool_calls returned → execute tools, add results as tool messages
 * 4. If core.final called → parse args, compile to intents, return
 * 5. Loop until core.final or limits reached
 * 6. If low confidence and safe to retry → retry with smart model
 */

import type { Logger } from '../../types/logger.js';
import type { Intent } from '../../types/intent.js';
import type { Signal } from '../../types/signal.js';
import type { AgentState } from '../../types/agent/state.js';
import type {
  ToolResult,
  LoopConfig,
  LoopState,
  Terminal,
  StructuredFact,
  ExecutedTool,
  EvidenceSource,
} from '../../types/cognition.js';
import { DEFAULT_LOOP_CONFIG, createLoopState } from '../../types/cognition.js';
import { THOUGHT_LIMITS } from '../../types/signal.js';
import type { ThoughtData } from '../../types/signal.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';
import type { OpenAIChatTool, MinimalOpenAIChatTool } from '../../llm/tool-schema.js';
import { unsanitizeToolName } from '../../llm/tool-schema.js';
import type { Message, ToolCall, ToolChoice } from '../../llm/provider.js';
import type { CoreFinalArgs } from './tools/core/index.js';

/**
 * Request for LLM completion with native tool calling.
 */
export interface ToolCompletionRequest {
  /** Conversation messages (system, user, assistant, tool) */
  messages: Message[];

  /** Tools available for the model to call (full or minimal format) */
  tools: (OpenAIChatTool | MinimalOpenAIChatTool)[];

  /** Tool choice: 'auto', 'required', or force specific tool */
  toolChoice?: ToolChoice;

  /** Whether to allow parallel tool calls (default: false for deterministic behavior) */
  parallelToolCalls?: boolean;
}

/**
 * Response from LLM with native tool calling.
 */
export interface ToolCompletionResponse {
  /** Text content (chain-of-thought, can be null if only tool_calls) */
  content: string | null;

  /** Tool calls requested by the model */
  toolCalls: ToolCall[];

  /** Finish reason */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

/**
 * Simple completion request (for non-tool-calling use cases like summarization).
 */
export interface SimpleCompletionRequest {
  /** System prompt */
  systemPrompt: string;
  /** User prompt */
  userPrompt: string;
}

/**
 * LLM interface for the agentic loop.
 */
export interface CognitionLLM {
  /**
   * Simple text completion without tools (for summarization, etc.)
   * @param request Simple request with system/user prompts
   * @param options LLM options
   */
  complete(request: SimpleCompletionRequest, options?: LLMOptions): Promise<string>;

  /**
   * Call the LLM with native tool calling support.
   * @param request Request with messages, tools, and tool choice
   * @param options LLM options including useSmart for smart model retry
   */
  completeWithTools(
    request: ToolCompletionRequest,
    options?: LLMOptions
  ): Promise<ToolCompletionResponse>;
}

export interface LLMOptions {
  maxTokens?: number;
  temperature?: number;
  /** Use smart (expensive) model instead of fast model */
  useSmart?: boolean;
}

/**
 * Agent identity for the loop.
 */
export interface AgentIdentityContext {
  name: string;
  gender?: 'female' | 'male' | 'neutral';
  values?: string[];
}

/**
 * Previous attempt context for smart retry.
 */
export interface PreviousAttempt {
  /** Tool results from first attempt (reuse, don't re-execute) */
  toolResults: ToolResult[];
  /** Executed tools with their call IDs for message reconstruction */
  executedTools: ExecutedTool[];
  /** Why we're retrying */
  reason: string;
}

/**
 * Runtime configuration for the loop.
 */
export interface RuntimeConfig {
  /** Whether smart model retry is enabled (based on system health) */
  enableSmartRetry: boolean;
}

/**
 * Context provided to the loop.
 */
export interface LoopContext {
  /** Trigger signal */
  triggerSignal: Signal;

  /** Current agent state */
  agentState: AgentState;

  /** Agent identity (name, values) */
  agentIdentity?: AgentIdentityContext | undefined;

  /** Conversation history (recent messages) */
  conversationHistory: ConversationMessage[];

  /** User model beliefs */
  userModel: Record<string, unknown>;

  /** Tick ID for batch grouping (NOT causal - use triggerSignal.id for that) */
  tickId: string;

  /** Opaque recipient identifier */
  recipientId?: string | undefined;

  /** User ID (if applicable) */
  userId?: string | undefined;

  /** Time since last message in ms (for proactive contact context) */
  timeSinceLastMessageMs?: number | undefined;

  /** Previous attempt context for smart retry */
  previousAttempt?: PreviousAttempt | undefined;

  /** Runtime config from processor */
  runtimeConfig?: RuntimeConfig | undefined;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'thought' | 'system';
  content: string;
  timestamp?: Date | undefined;
}

/**
 * Result from the agentic loop.
 */
export interface LoopResult {
  /** Whether loop completed successfully */
  success: boolean;

  /** Terminal state reached */
  terminal: Terminal;

  /** Compiled intents to execute */
  intents: Intent[];

  /** Loop state for debugging */
  state: LoopState;

  /** Error message (if failed) */
  error?: string | undefined;

  /** Whether smart model retry was used */
  usedSmartRetry?: boolean | undefined;
}

/** Confidence threshold below which smart retry is triggered */
const SMART_RETRY_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Agentic Loop implementation.
 */
export class AgenticLoop {
  private readonly logger: Logger;
  private readonly llm: CognitionLLM;
  private readonly toolRegistry: ToolRegistry;
  private readonly config: LoopConfig;

  constructor(
    logger: Logger,
    llm: CognitionLLM,
    toolRegistry: ToolRegistry,
    config: Partial<LoopConfig> = {}
  ) {
    this.logger = logger.child({ component: 'agentic-loop' });
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this.config = { ...DEFAULT_LOOP_CONFIG, ...config };
  }

  /**
   * Check if result needs deeper thinking (smart retry).
   */
  private needsDeepThinking(result: LoopResult): boolean {
    // Only respond terminal triggers retry consideration
    if (result.terminal.type !== 'respond') {
      return false; // noAction, defer - no retry needed
    }

    // Check terminal confidence (now REQUIRED field)
    if (result.terminal.confidence < SMART_RETRY_CONFIDENCE_THRESHOLD) {
      return true;
    }

    return false;
  }

  /**
   * Check if it's safe to retry (no side-effect tools executed).
   */
  private canSafelyRetry(state: LoopState): boolean {
    // CRITICAL: Only retry if no tools with side effects were executed
    return !state.executedTools.some((t) => t.hasSideEffects);
  }

  /**
   * Retry with smart model, reusing tool results from first attempt.
   */
  private async retryWithSmartModel(
    firstResult: LoopResult,
    context: LoopContext
  ): Promise<LoopResult> {
    this.logger.info(
      {
        originalConfidence:
          firstResult.terminal.type === 'respond' ? firstResult.terminal.confidence : undefined,
      },
      'Retrying with smart model due to low confidence'
    );

    // Build enriched context with first attempt info
    const enrichedContext: LoopContext = {
      ...context,
      previousAttempt: {
        toolResults: firstResult.state.toolResults,
        executedTools: firstResult.state.executedTools,
        reason: 'Low confidence, using deeper reasoning',
      },
    };

    // Run again with smart model
    return this.runInternal(enrichedContext, true);
  }

  /**
   * Run the agentic loop until completion.
   * Automatically retries with smart model if confidence is low and safe to retry.
   */
  async run(context: LoopContext): Promise<LoopResult> {
    const enableSmartRetry = context.runtimeConfig?.enableSmartRetry ?? true;
    const useSmart = context.previousAttempt !== undefined; // Use smart if this is a retry

    try {
      const result = await this.runInternal(context, useSmart);

      // Check if we need smart retry
      if (
        enableSmartRetry &&
        !useSmart && // Don't retry if already using smart
        this.needsDeepThinking(result) &&
        this.canSafelyRetry(result.state)
      ) {
        return await this.retryWithSmartModel(result, context);
      }

      return result;
    } catch (error) {
      // On fast model failure, we can ONLY retry with smart model if no side effects occurred
      // Since we threw an error, we don't have a result to check - we cannot safely retry
      // The error is thrown to the caller (processor) which will send a generic error response
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Agentic loop failed - cannot safely retry (no state to check for side effects)'
      );
      throw error;
    }
  }

  /**
   * Internal run implementation using native tool calling.
   * @param context Loop context
   * @param useSmart Whether to use smart model
   */
  private async runInternal(context: LoopContext, useSmart: boolean): Promise<LoopResult> {
    const state = createLoopState();

    this.logger.debug(
      {
        correlationId: context.tickId,
        triggerType: context.triggerSignal.type,
        useSmart,
        hasPreviousAttempt: !!context.previousAttempt,
      },
      'Agentic loop starting'
    );

    // Build initial messages
    const messages: Message[] = this.buildInitialMessages(context, useSmart);

    // If retrying, add previous tool results as messages
    if (context.previousAttempt) {
      this.addPreviousAttemptMessages(messages, context.previousAttempt, state);
    }

    // Get tools with full schemas - LLM knows exact parameters upfront
    // Uses ~3000 tokens but prevents wasted tool calls from parameter guessing
    const tools = this.toolRegistry.getToolsAsOpenAIFormat();

    while (!state.aborted) {
      // Check limits
      if (state.iteration >= this.config.maxIterations) {
        state.aborted = true;
        state.abortReason = `Max iterations reached (${String(this.config.maxIterations)})`;
        break;
      }

      if (Date.now() - state.startTime > this.config.timeoutMs) {
        state.aborted = true;
        state.abortReason = `Timeout reached (${String(this.config.timeoutMs)}ms)`;
        break;
      }

      if (state.toolCallCount >= this.config.maxToolCalls) {
        state.aborted = true;
        state.abortReason = `Max tool calls reached (${String(this.config.maxToolCalls)})`;
        break;
      }

      // Call LLM with native tool calling
      state.iteration++;
      const response = await this.llm.completeWithTools(
        {
          messages,
          tools,
          toolChoice: state.forceRespond
            ? { type: 'function', function: { name: 'core_final' } } // Force terminal
            : 'required', // Always require at least one tool call
          parallelToolCalls: false, // Sequential for determinism
        },
        {
          maxTokens: this.config.maxOutputTokens,
          useSmart,
        }
      );

      // Capture chain-of-thought if present
      if (response.content) {
        state.thoughts.push(response.content);
      }

      // No tool calls = error (model MUST use core.final with tool_choice: "required")
      if (response.toolCalls.length === 0) {
        this.logger.error({ finishReason: response.finishReason }, 'Model returned no tool calls');
        state.aborted = true;
        state.abortReason = 'Model returned no tool calls - expected core.final';
        break;
      }

      // Add assistant message with tool calls to history
      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      });

      // Process tool calls (only one at a time due to parallel_tool_calls: false)
      for (const toolCall of response.toolCalls) {
        const toolName = unsanitizeToolName(toolCall.function.name);
        let args: Record<string, unknown>;

        try {
          // Handle empty arguments string as empty object
          const argsString = toolCall.function.arguments.trim();
          args = argsString === '' ? {} : (JSON.parse(argsString) as Record<string, unknown>);
        } catch {
          this.logger.error(
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

        // Check for terminal tool - DO NOT execute, just parse and return
        if (toolName === 'core.final') {
          this.logger.debug(
            { type: args['type'], iterations: state.iteration, toolCalls: state.toolCallCount },
            'Agentic loop completed via core.final'
          );

          // Pass args directly - buildTerminalFromFinalArgs handles flat format
          return this.buildFinalResult(args as unknown as CoreFinalArgs, state, context);
        }

        // Track for smart retry
        state.executedTools.push({
          toolCallId: toolCall.id,
          name: toolName,
          args,
          hasSideEffects: this.toolRegistry.hasToolSideEffects(toolName),
        });

        // Execute non-terminal tool
        state.toolCallCount++;
        const result = await this.toolRegistry.execute({
          toolCallId: toolCall.id,
          name: toolName,
          args,
          context: this.buildToolContext(context),
        });

        state.toolResults.push(result);

        // Add tool result to message history (OpenAI format)
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result.success ? result.data : { error: result.error }),
        });
      }

      // Continue loop - LLM will see tool results in next iteration
    }

    // Aborted - throw error to trigger smart retry at run() level
    this.logger.warn(
      { reason: state.abortReason, iterations: state.iteration, useSmart },
      'Agentic loop aborted'
    );

    throw new Error(state.abortReason ?? 'Agentic loop aborted');
  }

  /**
   * Build initial messages for the conversation.
   */
  private buildInitialMessages(context: LoopContext, useSmart: boolean): Message[] {
    const systemPrompt = this.buildSystemPrompt(context, useSmart);
    const userPrompt = this.buildUserPrompt(context);

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
  }

  /**
   * Build user prompt from context (trigger, history, etc.)
   */
  private buildUserPrompt(context: LoopContext, useSmart = false): string {
    const sections: string[] = [];

    // User profile (stable facts)
    const userProfile = this.buildUserProfileSection(context);
    if (userProfile) {
      sections.push(userProfile);
    }

    // Runtime snapshot (conditional, for state-related queries)
    const runtimeSnapshot = this.buildRuntimeSnapshotSection(context, useSmart);
    if (runtimeSnapshot) {
      sections.push(runtimeSnapshot);
    }

    // Conversation history
    if (context.conversationHistory.length > 0) {
      sections.push(this.buildHistorySection(context.conversationHistory));
    }

    // Current trigger
    sections.push(this.buildTriggerSection(context.triggerSignal, context));

    return sections.join('\n\n');
  }

  /**
   * Add messages from previous attempt for smart retry.
   * Reconstructs the assistant tool_calls and tool result messages so the
   * retry model sees the full context of what was already executed.
   */
  private addPreviousAttemptMessages(
    messages: Message[],
    previousAttempt: PreviousAttempt,
    state: LoopState
  ): void {
    // Add a system note about the retry
    messages.push({
      role: 'system',
      content: `[Previous attempt with fast model - retrying with deeper reasoning. Reason: ${previousAttempt.reason}]`,
    });

    // Reconstruct tool call messages from previous attempt
    // This is critical so the retry model sees what tools were called and their results
    if (previousAttempt.executedTools.length > 0) {
      // Build tool_calls array for the assistant message
      const toolCalls: ToolCall[] = previousAttempt.executedTools.map((tool) => ({
        id: tool.toolCallId,
        type: 'function' as const,
        function: {
          name: tool.name.replace(/\./g, '_'), // Sanitize for API format
          arguments: JSON.stringify(tool.args),
        },
      }));

      // Add assistant message with tool calls
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: toolCalls,
      });

      // Add tool result messages
      for (const result of previousAttempt.toolResults) {
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: JSON.stringify(result.success ? result.data : { error: result.error }),
        });
      }
    }

    // Mark all previous tools as executed (for side effect tracking)
    for (const tool of previousAttempt.executedTools) {
      state.executedTools.push(tool);
    }
    for (const result of previousAttempt.toolResults) {
      state.toolResults.push(result);
    }
  }

  /**
   * Build tool context from loop context.
   */
  private buildToolContext(context: LoopContext): ToolContext {
    return {
      recipientId: context.recipientId ?? '',
      userId: context.userId,
      correlationId: context.tickId,
    };
  }

  /**
   * Build final result from core.final arguments.
   */
  private buildFinalResult(
    args: CoreFinalArgs,
    state: LoopState,
    context: LoopContext
  ): LoopResult {
    const terminal = this.buildTerminalFromFinalArgs(args);

    // Compile intents from tool results and terminal
    const intents = this.compileIntentsFromToolResults(terminal, context, state.toolResults);

    return {
      success: true,
      terminal,
      intents,
      state,
      usedSmartRetry: state.iteration > 1, // If we retried
    };
  }

  /**
   * Convert core.final args to Terminal type.
   * Uses flat format (all fields at root level).
   */
  private buildTerminalFromFinalArgs(args: CoreFinalArgs): Terminal {
    switch (args.type) {
      case 'respond': {
        if (!args.text) {
          throw new Error('core.final respond requires "text" field');
        }

        return {
          type: 'respond',
          text: args.text,
          conversationStatus: args.conversationStatus ?? 'active',
          confidence: args.confidence ?? 0.8,
        };
      }
      case 'no_action': {
        if (!args.reason) {
          throw new Error('core.final no_action requires "reason" field');
        }
        return {
          type: 'noAction',
          reason: args.reason,
        };
      }
      case 'defer': {
        if (!args.signalType || !args.reason || args.deferHours === undefined) {
          throw new Error(
            'core.final defer requires "signalType", "reason", and "deferHours" fields'
          );
        }

        return {
          type: 'defer',
          signalType: args.signalType,
          reason: args.reason,
          deferHours: args.deferHours,
        };
      }
      default:
        throw new Error(`Unknown terminal type: ${String(args.type)}`);
    }
  }

  /**
   * Compile intents from tool results (new method for native tool calling).
   * Includes trace metadata for log analysis.
   */
  private compileIntentsFromToolResults(
    terminal: Terminal,
    context: LoopContext,
    toolResults: ToolResult[]
  ): Intent[] {
    const intents: Intent[] = [];

    // Build base trace from context
    // tickId = batch grouping, parentSignalId = causal chain
    const baseTrace = {
      tickId: context.tickId,
      parentSignalId: context.triggerSignal.id,
    };

    // Convert tool results to intents
    for (const result of toolResults) {
      // Handle core.thought specially (complex depth logic)
      if (result.toolName === 'core.thought' && result.success) {
        const thoughtIntent = this.thoughtToolResultToIntent(result, context);
        if (thoughtIntent) {
          thoughtIntent.trace = { ...baseTrace, toolCallId: result.toolCallId };
          intents.push(thoughtIntent);
        }
        continue;
      }

      // Handle all other tools via the typed map
      const toolIntent = this.toolResultToIntent(result, context);
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

  private buildSystemPrompt(context: LoopContext, useSmart: boolean): string {
    const agentName = context.agentIdentity?.name ?? 'Life';
    const agentGender = context.agentIdentity?.gender ?? 'neutral';
    const values = context.agentIdentity?.values?.join(', ') ?? 'Be helpful and genuine';

    const genderNote =
      agentGender === 'female'
        ? 'Use feminine grammatical forms in gendered languages (e.g., Russian: "рада", "готова").'
        : agentGender === 'male'
          ? 'Use masculine grammatical forms in gendered languages (e.g., Russian: "рад", "готов").'
          : 'Use neutral grammatical forms when possible.';

    // Current time for temporal reasoning (age calculations, time-of-day awareness)
    const now = new Date();
    const currentDateTime = now.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    return `You are ${agentName} (${agentGender}). Values: ${values}
${genderNote}

Current time: ${currentDateTime}

Capabilities: think → use tools → update beliefs (with evidence) → respond

Rules:
- Plain text only (no markdown)
- Don't re-greet if already greeted
- User's name: only on first greeting or after long pauses, not every message
- Only promise what your tools can do. Memory ≠ reminders. Check "Available tools" before promising future actions.
- Set confidence below 0.6 when uncertain about complex/sensitive topics
- State access: use the Runtime Snapshot if provided; call core.state when you need precise or missing agent/user state.
- Tool schemas are provided upfront. Call tools directly with the required parameters.${
      useSmart
        ? ''
        : `
- If a response depends on agent/user state, call core.state first (unless the snapshot already answers it).`
    }

MEMORY: When user shares personal facts (birthday, name, preferences), use core.remember to save them.`;
  }

  private buildUserProfileSection(context: LoopContext): string | null {
    const { userModel } = context;

    const name = typeof userModel['name'] === 'string' ? userModel['name'].trim() : '';
    const lines: string[] = [];

    if (name.length > 0) {
      lines.push(`- name: ${name}`);
    }

    if (lines.length === 0) {
      return null;
    }

    return `## User Profile (stable facts)
${lines.join('\n')}
NOTE: Use the user's name sparingly; check conversation history first.`;
  }

  private buildRuntimeSnapshotSection(context: LoopContext, useSmart: boolean): string | null {
    if (!this.shouldIncludeRuntimeSnapshot(context, useSmart)) {
      return null;
    }

    const { agentState, userModel } = context;
    const triggerText = this.getTriggerText(context.triggerSignal);
    const scope = this.getRuntimeSnapshotScope(context, triggerText);

    const agentParts: string[] = [];
    const userParts: string[] = [];

    if (scope.includeAgentEnergy) {
      agentParts.push(`energy ${this.describeLevel(agentState.energy)}`);
    }
    if (scope.includeSocialDebt) {
      agentParts.push(`socialDebt ${this.describeLevel(agentState.socialDebt)}`);
    }
    if (scope.includeTaskPressure) {
      agentParts.push(`taskPressure ${this.describeLevel(agentState.taskPressure)}`);
    }
    if (scope.includeCuriosity) {
      agentParts.push(`curiosity ${this.describeLevel(agentState.curiosity)}`);
    }
    if (scope.includeAcquaintancePressure) {
      agentParts.push(
        `acquaintancePressure ${this.describeLevel(agentState.acquaintancePressure)}`
      );
    }

    const userEnergy = this.asNumber(userModel['energy']);
    if (scope.includeUserEnergy && userEnergy !== null) {
      userParts.push(`energy ${this.describeLevel(userEnergy)}`);
    }
    const userAvailability = this.asNumber(userModel['availability']);
    if (scope.includeUserAvailability && userAvailability !== null) {
      userParts.push(`availability ${this.describeLevel(userAvailability)}`);
    }

    if (agentParts.length === 0 && userParts.length === 0) {
      return null;
    }

    const agentChunk = agentParts.length > 0 ? `Agent: ${agentParts.join(', ')}` : '';
    const userChunk = userParts.length > 0 ? `User: ${userParts.join(', ')}` : '';
    const combined = [agentChunk, userChunk].filter((part) => part.length > 0).join('; ');

    return `## Runtime Snapshot
${combined}`;
  }

  private shouldIncludeRuntimeSnapshot(context: LoopContext, useSmart: boolean): boolean {
    const { agentState, userModel } = context;
    const triggerText = this.getTriggerText(context.triggerSignal);
    const isProactive = this.isProactiveTrigger(context.triggerSignal);
    const isStateQuery = triggerText ? this.isStateQuery(triggerText) : false;

    const agentExtreme =
      agentState.energy < 0.35 ||
      agentState.energy > 0.85 ||
      agentState.socialDebt > 0.6 ||
      agentState.taskPressure > 0.6 ||
      agentState.acquaintancePressure > 0.6;

    const userEnergy = this.asNumber(userModel['energy']);
    const userAvailability = this.asNumber(userModel['availability']);
    const userExtreme =
      (userEnergy !== null && userEnergy < 0.35) ||
      (userAvailability !== null && userAvailability < 0.35);

    if (isProactive || isStateQuery || agentExtreme || userExtreme) {
      return true;
    }

    // Cheap models benefit from more frequent state grounding (lower thresholds).
    if (!useSmart) {
      const cheapAgentExtreme =
        agentState.energy < 0.45 ||
        agentState.energy > 0.55 ||
        agentState.socialDebt > 0.45 ||
        agentState.taskPressure > 0.45;
      if (cheapAgentExtreme) return true;
    }

    return false;
  }

  private getRuntimeSnapshotScope(
    context: LoopContext,
    triggerText: string | null
  ): {
    includeAgentEnergy: boolean;
    includeSocialDebt: boolean;
    includeTaskPressure: boolean;
    includeCuriosity: boolean;
    includeAcquaintancePressure: boolean;
    includeUserEnergy: boolean;
    includeUserAvailability: boolean;
  } {
    const isProactive = this.isProactiveTrigger(context.triggerSignal);
    const isStateQuery = triggerText ? this.isStateQuery(triggerText) : false;
    const isUserStateQuery = triggerText ? this.isUserStateQuery(triggerText) : false;

    if (isStateQuery || isProactive) {
      return {
        includeAgentEnergy: true,
        includeSocialDebt: true,
        includeTaskPressure: true,
        includeCuriosity: isStateQuery,
        includeAcquaintancePressure: isProactive,
        includeUserEnergy: isUserStateQuery,
        includeUserAvailability: isUserStateQuery,
      };
    }

    const userEnergy = this.asNumber(context.userModel['energy']);
    const userAvailability = this.asNumber(context.userModel['availability']);

    return {
      includeAgentEnergy: context.agentState.energy < 0.35 || context.agentState.energy > 0.85,
      includeSocialDebt: context.agentState.socialDebt > 0.6,
      includeTaskPressure: context.agentState.taskPressure > 0.6,
      includeCuriosity: context.agentState.curiosity > 0.8,
      includeAcquaintancePressure: context.agentState.acquaintancePressure > 0.6,
      includeUserEnergy: userEnergy !== null && userEnergy < 0.35,
      includeUserAvailability: userAvailability !== null && userAvailability < 0.35,
    };
  }

  private isProactiveTrigger(signal: Signal): boolean {
    if (signal.type !== 'threshold_crossed') return false;
    const data = signal.data as Record<string, unknown> | undefined;
    const thresholdName = typeof data?.['thresholdName'] === 'string' ? data['thresholdName'] : '';
    return thresholdName.includes('proactive') || thresholdName.includes('contact_urge');
  }

  private getTriggerText(signal: Signal): string | null {
    if (signal.type !== 'user_message') return null;
    const data = signal.data as Record<string, unknown> | undefined;
    const text = typeof data?.['text'] === 'string' ? data['text'] : '';
    return text.trim().length > 0 ? text : null;
  }

  private isStateQuery(text: string): boolean {
    return this.matchesAny(text, [
      /how are you/i,
      /are you (tired|sleepy|busy|stressed|overwhelmed|okay|ok)/i,
      /\b(tired|sleepy|energy|burned out|burnt out|overwhelmed|busy|stressed)\b/i,
      /как ты/i,
      /ты (устал|устала|уставш|сонн|занят|занята|перегруж|нормально)/i,
      /силы|энерг/i,
    ]);
  }

  private isUserStateQuery(text: string): boolean {
    return this.matchesAny(text, [
      /am i (tired|ok|okay|stressed|overwhelmed)/i,
      /how am i/i,
      /do i seem/i,
      /я (устал|устала|уставш|перегруж|выспал|выспалась)/i,
      /мне (плохо|тяжело|нормально)/i,
    ]);
  }

  private matchesAny(text: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(text));
  }

  private asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private describeLevel(value: number): 'low' | 'medium' | 'high' {
    if (value <= 0.35) return 'low';
    if (value >= 0.7) return 'high';
    return 'medium';
  }

  private buildHistorySection(history: ConversationMessage[]): string {
    const formatted = history
      .map((m) => {
        if (m.role === 'system') return `[context] ${m.content}`;
        return `${m.role}: ${m.content}`;
      })
      .join('\n');

    return `## Recent Conversation\n${formatted}`;
  }

  private buildTriggerSection(signal: Signal, context: LoopContext): string {
    const data = signal.data as Record<string, unknown> | undefined;

    if (signal.type === 'user_message' && data) {
      const text = (data['text'] as string | undefined) ?? '';
      return `## Current Input\nUser message: "${text}"`;
    }

    // Handle proactive contact triggers specially
    if (signal.type === 'threshold_crossed' && data) {
      const thresholdName = data['thresholdName'] as string | undefined;
      if (thresholdName?.includes('proactive')) {
        return this.buildProactiveContactSection(context, thresholdName);
      }
    }

    return `## Current Trigger\nType: ${signal.type}\nData: ${JSON.stringify(data ?? {})}`;
  }

  /**
   * Build special section for proactive contact explaining this is NOT a response.
   */
  private buildProactiveContactSection(context: LoopContext, triggerType: string): string {
    const timeSinceMs = context.timeSinceLastMessageMs;
    let timeContext = '';

    if (timeSinceMs !== undefined) {
      const hours = Math.floor(timeSinceMs / (1000 * 60 * 60));
      const minutes = Math.floor((timeSinceMs % (1000 * 60 * 60)) / (1000 * 60));

      if (hours > 0) {
        timeContext = `${String(hours)} hour${hours > 1 ? 's' : ''}${minutes > 0 ? ` ${String(minutes)} min` : ''}`;
      } else if (minutes > 0) {
        timeContext = `${String(minutes)} minute${minutes > 1 ? 's' : ''}`;
      } else {
        timeContext = 'less than a minute';
      }
    }

    const isFollowUp = triggerType.includes('follow_up');

    // Check if this is a deferral override
    const data = context.triggerSignal.data as Record<string, unknown> | undefined;
    const isDeferralOverride = data?.['deferralOverride'] === true;

    const section = `## Proactive Contact Trigger

IMPORTANT: This is NOT a response to a user message. You are INITIATING contact.
${timeContext ? `Time since last conversation: ${timeContext}` : ''}
${isDeferralOverride ? '\n⚠️ OVERRIDE: Your earlier deferral is being reconsidered because pressure increased significantly.' : ''}

${isFollowUp ? 'Trigger: Follow-up (user did not respond to your previous message)' : 'Trigger: Internal drive to reach out (social debt accumulated)'}

Guidelines for proactive contact:
- Do NOT continue or reference the previous conversation directly
- Start FRESH with a new topic or friendly check-in
- Keep it brief and natural - one short message
- Examples: "Привет! Как дела?", "Эй, давно не общались. Как ты?", "Привет! Чем занимаешься?"
- Do NOT ask about the previous conversation topic unless it's truly unfinished business

DEFERRAL OPTION:
If you decide NOT to contact now (user might be busy, it's late, etc.), use "defer" terminal:
- Specify signalType (usually "contact_urge" for proactive contact)
- Specify deferHours (2-8 hours typically)
- Give a reason ("User seems busy", "It's late evening", etc.)
- You won't be asked again until:
  a) The deferral time passes, OR
  b) Something significant changes (value increases significantly)

Example defer terminal:
{ "type": "defer", "signalType": "contact_urge", "reason": "User seems busy right now", "deferHours": 4, "parentId": "t1" }`;

    return section;
  }

  /**
   * Typed mapping from tool results to intents.
   * Tools return validated payloads → this map converts them to Intents.
   *
   * Key design principle: Tools validate and return data, they don't mutate.
   * This map bridges the gap to CoreLoop which performs actual mutations.
   */
  private toolResultToIntent(result: ToolResult, context: LoopContext): Intent | null {
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

      // core.thought is handled separately via thoughtToolResultToIntent
      // because it has complex depth/recursion logic

      default:
        return null;
    }
  }

  /**
   * Convert core.thought tool result to EMIT_THOUGHT intent.
   */
  private thoughtToolResultToIntent(result: ToolResult, context: LoopContext): Intent | null {
    const data = result.data as { content?: string; reason?: string } | undefined;
    if (!data?.content) {
      return null;
    }

    const content = data.content;
    const dedupeKey = content.toLowerCase().slice(0, 50).replace(/\s+/g, ' ');

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
        this.logger.warn('Thought signal missing ThoughtData, rejecting thought tool');
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
      this.logger.warn(
        { depth, content: content.slice(0, 30) },
        'Thought rejected: max depth exceeded'
      );
      return null;
    }

    return {
      type: 'EMIT_THOUGHT',
      payload: {
        content,
        triggerSource,
        depth,
        rootThoughtId: rootId,
        dedupeKey,
        signalSource: 'cognition.thought',
        ...(parentId !== undefined && { parentThoughtId: parentId }),
      },
    };
  }
}

/**
 * Create an agentic loop.
 */
export function createAgenticLoop(
  logger: Logger,
  llm: CognitionLLM,
  toolRegistry: ToolRegistry,
  config?: Partial<LoopConfig>
): AgenticLoop {
  return new AgenticLoop(logger, llm, toolRegistry, config);
}
