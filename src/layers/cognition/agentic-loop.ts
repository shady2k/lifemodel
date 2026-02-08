/**
 * COGNITION Agentic Loop
 *
 * Orchestration layer that wires all modules together.
 * Executes the think → tool → think cycle until natural conclusion using native OpenAI tool calling.
 *
 * Flow (Codex-style natural termination):
 * 1. Build messages with system prompt and user context
 * 2. Call LLM with tools parameter (tool_choice: "auto")
 * 3. If tool_calls returned → execute tools, add results as tool messages
 * 4. If no tool calls → natural completion, compile to intents, return
 * 5. Loop until no tool calls or limits reached
 * 6. If low confidence and safe to retry → retry with smart model
 */

import type { Logger } from '../../types/logger.js';
import type { LoopConfig, LoopState, Terminal } from '../../types/cognition.js';
import { DEFAULT_LOOP_CONFIG, createLoopState } from '../../types/cognition.js';
import type { ToolRegistry } from './tools/registry.js';
import type { Message } from '../../llm/provider.js';

// Types — re-exported for backward compatibility (7+ external importers)
export type {
  ToolCompletionRequest,
  ToolCompletionResponse,
  SimpleCompletionRequest,
  CognitionLLM,
  LLMOptions,
  AgentIdentityContext,
  PreviousAttempt,
  RuntimeConfig,
  LoopContext,
  ConversationToolCall,
  ConversationMessage,
  LoopResult,
  LoopCallbacks,
  PromptBuilders,
  ToolExecutionOutcome,
} from './agentic-loop-types.js';

import type { CognitionLLM, LoopContext, LoopCallbacks, LoopResult } from './agentic-loop-types.js';

// Sub-modules
import { parseResponseContent } from './response-parser.js';
import {
  compileIntentsFromToolResults,
  toolResultToIntent,
  buildFinalResultFromNaturalCompletion,
} from './intent-compiler.js';
import {
  buildRequest,
  filterToolsForContext,
  maybeSetProactiveToolBudget,
} from './loop-orchestrator.js';
import { executeToolCalls } from './tool-executor.js';
import { buildInitialMessages, buildToolContext } from './messages/index.js';
import { addPreviousAttemptMessages } from './messages/retry-builder.js';
import { validateToolCallPairs } from './messages/tool-call-validators.js';
import { buildSystemPrompt } from './prompts/system-prompt.js';
import { buildTriggerPrompt } from './prompts/trigger-prompt.js';
import { getTraceContext } from '../../core/trace-context.js';

/**
 * Agentic Loop implementation.
 */
export class AgenticLoop {
  private readonly logger: Logger;
  private readonly llm: CognitionLLM;
  private readonly toolRegistry: ToolRegistry;
  private readonly config: LoopConfig;
  private readonly callbacks: LoopCallbacks | undefined;

  constructor(
    logger: Logger,
    llm: CognitionLLM,
    toolRegistry: ToolRegistry,
    config: Partial<LoopConfig> = {},
    callbacks?: LoopCallbacks
  ) {
    this.logger = logger.child({ component: 'agentic-loop' });
    this.llm = llm;
    this.toolRegistry = toolRegistry;
    this.config = { ...DEFAULT_LOOP_CONFIG, ...config };
    this.callbacks = callbacks;
  }

  /**
   * Run the agentic loop until completion.
   *
   * Smart model escalation is EXPLICIT only - via core.escalate tool.
   * We trust the LLM to know when it needs deeper reasoning.
   */
  async run(context: LoopContext): Promise<LoopResult> {
    const useSmart = context.previousAttempt !== undefined;

    try {
      return await this.runInternal(context, useSmart);
    } catch (error) {
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Agentic loop failed'
      );
      throw error;
    }
  }

  /**
   * Internal run implementation using native tool calling.
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
    const promptBuilders = { buildSystemPrompt, buildTriggerPrompt };
    let messages: Message[] = buildInitialMessages(context, useSmart, promptBuilders);

    // If retrying, add previous tool results as messages
    if (context.previousAttempt) {
      addPreviousAttemptMessages(messages, context.previousAttempt, state);
    }

    // Validate tool_call/result pair integrity (safety net for history slicing bugs)
    messages = validateToolCallPairs(messages, this.logger);

    // Get tools with full schemas
    const allTools = this.toolRegistry.getToolsAsOpenAIFormat();

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

      state.iteration++;

      // Handle forceRespond with attempt limit to prevent dead-end
      if (state.forceRespond) {
        if (!state.everForcedRespond) {
          state.everForcedRespond = true;
        }

        if (state.forceRespondAttempts >= 3) {
          this.logger.warn(
            { attempts: state.forceRespondAttempts, iteration: state.iteration },
            'Model refused to respond after forced attempts - terminating with noAction'
          );
          const terminal: Terminal = {
            type: 'noAction',
            reason: 'Model refused to generate response after multiple forced attempts',
          };
          const intents = compileIntentsFromToolResults(terminal, context, state, this.logger);
          return { success: true, terminal, intents, state };
        } else {
          state.forceRespondAttempts++;
          if (state.forceRespondAttempts >= 2) {
            messages.push({
              role: 'system',
              content: 'CRITICAL: You must generate a response NOW. No more tool calls.',
            });
          }
        }
      }

      // Set tool budgets for autonomous triggers
      maybeSetProactiveToolBudget(state, context, this.logger);

      // Filter tools based on context
      const filteredTools = filterToolsForContext(allTools, context, useSmart);

      // Build request
      const request = buildRequest(messages, filteredTools, state.forceRespond === true);

      const response = await this.llm.completeWithTools(request, {
        maxTokens: this.config.maxOutputTokens,
        useSmart,
      });

      // Capture chain-of-thought if present (cleaned from JSON wrapper)
      if (response.content) {
        const parsed = parseResponseContent(response.content);
        if (parsed.text) {
          state.thoughts.push(parsed.text);
        }
      }

      // Detect truncated responses due to token limit
      if (response.finishReason === 'length') {
        this.logger.warn(
          { iterations: state.iteration, toolCallsCount: response.toolCalls.length },
          'Response truncated due to token limit - marking low confidence for potential retry'
        );

        if (!state.everForcedRespond) {
          state.everForcedRespond = true;
        }

        if (response.toolCalls.length === 0 && context.triggerSignal.type === 'user_message') {
          this.logger.debug('Truncated response with no tools for user message, forcing retry');
          state.forceRespond = true;
          continue;
        }
      }

      // No tool calls = natural completion (Codex-style termination)
      if (response.toolCalls.length === 0) {
        const result = this.handleNaturalCompletion(response.content, state, context);
        if (result === null) {
          // forceRespond was set — continue loop
          continue;
        }

        // Before returning, check for pending user messages that arrived mid-loop.
        // If found, deliver the current response and absorb the new messages into this loop
        // to avoid spawning a redundant COGNITION run.
        // Gate on recipientId + onImmediateIntent to ensure the response can actually be delivered;
        // otherwise fall through to normal return (message will spawn its own COGNITION run).
        if (
          result.terminal.type === 'respond' &&
          result.terminal.text &&
          context.drainPendingUserMessages &&
          context.recipientId &&
          this.callbacks?.onImmediateIntent
        ) {
          const pendingMessages = context.drainPendingUserMessages();
          if (pendingMessages.length > 0) {
            // Deliver current response immediately
            this.callbacks.onImmediateIntent({
              type: 'SEND_MESSAGE',
              payload: {
                recipientId: context.recipientId,
                text: result.terminal.text,
                conversationStatus: result.terminal.conversationStatus,
              },
            });

            // Add as assistant context for the next iteration
            messages.push({ role: 'assistant', content: result.terminal.text });

            // Inject pending user messages
            for (const signal of pendingMessages) {
              const text = (signal.data as { text: string }).text;
              messages.push({ role: 'user', content: text });
              this.logger.debug(
                { text: text.slice(0, 50) },
                'Absorbed pending user message at natural completion'
              );
            }

            state.forceRespond = false;
            state.forceRespondAttempts = 0;
            continue;
          }
        }

        return result;
      }

      // Execute tool calls
      const outcome = await executeToolCalls({
        toolCalls: response.toolCalls,
        responseContent: response.content,
        messages,
        state,
        context,
        callbacks: this.callbacks,
        toolRegistry: this.toolRegistry,
        logger: this.logger,
        toolResultToIntent,
        buildToolContext,
        onEscalate: (s, ctx, reason) => ({
          ...ctx,
          previousAttempt: {
            toolResults: [...s.toolResults],
            executedTools: [...s.executedTools],
            reason,
          },
        }),
        compileIntents: (terminal, ctx, s) =>
          compileIntentsFromToolResults(terminal, ctx, s, this.logger),
      });

      switch (outcome.type) {
        case 'escalate':
          // Restart with smart model using enriched context
          return this.runInternal(outcome.enrichedContext, true);

        case 'defer':
          return outcome.result;

        case 'continue':
          // Continue — inject mid-loop user messages
          break;
      }

      // Mid-loop user message injection
      const pendingMessages = context.drainPendingUserMessages?.() ?? [];
      for (const signal of pendingMessages) {
        const text = (signal.data as { text: string }).text;
        messages.push({ role: 'user', content: text });
        this.logger.debug({ text: text.slice(0, 50) }, 'Injected mid-loop user message');
      }
    }

    // Aborted - throw error to trigger smart retry at run() level
    this.logger.warn(
      { reason: state.abortReason, iterations: state.iteration, useSmart },
      'Agentic loop aborted'
    );

    throw new Error(state.abortReason ?? 'Agentic loop aborted');
  }

  /**
   * Handle natural completion (no tool calls).
   * Returns null when forceRespond is set (caller should continue loop).
   */
  private handleNaturalCompletion(
    content: string | null,
    state: LoopState,
    context: LoopContext
  ): LoopResult | null {
    const parsed = parseResponseContent(content);
    const messageText = parsed.text;

    // Plain-text response: model skipped JSON format but returned usable text.
    // Accept it — retrying with json_schema can produce worse results on models
    // that don't support structured output (e.g. GLM-4.7 on some providers).
    if (
      messageText &&
      content &&
      !content.trim().startsWith('{') &&
      !content.trim().startsWith('```')
    ) {
      this.logger.info(
        {
          contentLength: content.length,
          contentPreview: content.slice(0, 100),
        },
        'Accepted plain-text response (model skipped JSON format)'
      );
    }

    // Malformed response (truncated JSON, missing response field, etc.)
    if (parsed.malformed) {
      if (!state.malformedRetried) {
        state.malformedRetried = true;
        this.logger.warn(
          {
            contentLength: content?.length ?? 0,
            contentPreview: content?.slice(0, 100),
            triggerType: context.triggerSignal.type,
          },
          'Malformed LLM response detected — retrying'
        );
        state.forceRespond = true;
        return null; // Retry via existing forceRespond machinery
      }

      // Already retried — give up
      this.logger.error(
        {
          contentLength: content?.length ?? 0,
          rawContent: content,
          triggerType: context.triggerSignal.type,
        },
        'Malformed LLM response persists after retry'
      );

      if (context.triggerSignal.type !== 'user_message') {
        // Proactive trigger — silent abort
        const terminal: Terminal = {
          type: 'noAction',
          reason: 'Malformed LLM response after retry',
        };
        const intents = compileIntentsFromToolResults(terminal, context, state, this.logger);
        return { success: true, terminal, intents, state };
      }

      // User message — return error with trace context for log lookup
      const trace = getTraceContext();
      const traceRef = trace
        ? `${trace.traceId.slice(0, 8)}:${trace.spanId ?? 'unknown'}`
        : 'unknown';
      const terminal: Terminal = {
        type: 'respond',
        text: `Sorry, I had trouble processing that. Could you try again? (trace: ${traceRef})`,
        conversationStatus: 'active',
        confidence: 0.3,
      };
      const intents = compileIntentsFromToolResults(terminal, context, state, this.logger);
      return { success: true, terminal, intents, state };
    }

    // Store conversation status from response if provided
    if (parsed.status) {
      state.conversationStatus = parsed.status;
    }

    // Edge case: user message but no response text
    if (!messageText && context.triggerSignal.type === 'user_message') {
      this.logger.debug('No response text for user message, forcing response');
      state.forceRespond = true;
      return null; // Signal caller to continue loop
    }

    // Log for proactive triggers with no action
    if (!messageText && context.triggerSignal.type !== 'user_message') {
      const isExpectedNoAction =
        context.triggerSignal.type === 'thought' ||
        context.triggerSignal.type === 'message_reaction';
      if (isExpectedNoAction) {
        this.logger.debug(
          { triggerType: context.triggerSignal.type },
          'Trigger completed without user message (expected for this type)'
        );
      } else {
        this.logger.warn(
          { triggerType: context.triggerSignal.type },
          'Proactive trigger completed with no action - verify this is expected'
        );
      }
    }

    // Thought trigger response routing
    let effectiveMessageText = messageText;
    if (context.triggerSignal.type === 'thought' && messageText) {
      if (parsed.urgent) {
        this.logger.info(
          { textLength: messageText.length },
          'Thought loop: urgent response — sending to user'
        );
      } else {
        this.logger.info(
          { textLength: messageText.length, textPreview: messageText.slice(0, 80) },
          'Thought loop: non-urgent response — saving as intention'
        );
        if (this.callbacks?.onImmediateIntent) {
          this.callbacks.onImmediateIntent({
            type: 'SAVE_TO_MEMORY',
            payload: {
              type: 'intention',
              content: messageText,
              tags: ['thought_insight'],
            },
          });
        }
        effectiveMessageText = null;
      }
    }

    this.logger.debug(
      { iterations: state.iteration, toolCalls: state.toolCallCount, status: parsed.status },
      'Agentic loop completed naturally (no tool calls)'
    );

    return buildFinalResultFromNaturalCompletion(effectiveMessageText, state, context, this.logger);
  }
}

/**
 * Create an agentic loop.
 */
export function createAgenticLoop(
  logger: Logger,
  llm: CognitionLLM,
  toolRegistry: ToolRegistry,
  config?: Partial<LoopConfig>,
  callbacks?: LoopCallbacks
): AgenticLoop {
  return new AgenticLoop(logger, llm, toolRegistry, config, callbacks);
}
