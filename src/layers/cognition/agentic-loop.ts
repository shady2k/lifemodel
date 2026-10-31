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

import { renderReplyQuote } from './prompts/reply-quote.js';
import type { Logger } from '../../types/logger.js';
import type { LoopConfig, LoopState, Terminal } from '../../types/cognition.js';
import { DEFAULT_LOOP_CONFIG, createLoopState } from '../../types/cognition.js';
import type { ToolRegistry } from './tools/registry.js';
import { type Message, LLMError } from '../../llm/provider.js';

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

import type {
  CognitionLLM,
  LLMOptions,
  LoopContext,
  LoopCallbacks,
  LoopResult,
} from './agentic-loop-types.js';
import type { SignalType } from '../../types/signal.js';

// Sub-modules
import { parseResponseContent, type ParseOptions } from './response-parser.js';
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
import {
  taskOutcomeFallback,
  taskOutcomeLanguage,
  taskOutcomeRedoFallback,
  validateTaskOutcome,
} from '../../ports/task-outcome.js';
import { UncertainMutationError } from './tools/mutation-error.js';
import { createToolResult } from './tools/types.js';

/**
 * Resolve per-request LLM timeout based on trigger type.
 *
 * Low-priority triggers fail fast — the pressure system re-triggers naturally.
 * User messages keep the full timeout since someone is actively waiting.
 */
function getTimeoutForTrigger(triggerType: SignalType): number | undefined {
  switch (triggerType) {
    case 'user_message':
      return undefined; // Use provider default (180s)
    case 'message_reaction':
      return 120_000; // Low priority but local models need more time
    case 'contact_urge':
    case 'thought':
    case 'plugin_event':
      return 120_000; // Background processing, pressure re-triggers
    default:
      return 120_000; // Safe default for any other proactive trigger
  }
}

/**
 * Whether the given trigger type should allow plain-text (non-JSON) LLM responses.
 *
 * - user_message: someone is waiting — always accept plain text
 * - motor_result: reporting task results to the user — accept plain text
 * - proactive triggers (contact_urge, thought, etc.): reject plain text to
 *   prevent prompt leakage from weaker models
 */
function shouldAllowPlainText(triggerType: SignalType): boolean {
  return (
    triggerType === 'user_message' ||
    triggerType === 'motor_result' ||
    triggerType === 'task_outcome'
  );
}

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
    const state = createLoopState();

    try {
      if (context.triggerSignal.type === 'task_outcome') {
        const event = validateTaskOutcome(context.triggerSignal.data);
        const tool = this.toolRegistry.getTools().find((entry) => entry.name === 'core.startTask');
        if (!event.redoOf && tool?.recoverAcceptedEffect) {
          const toolContext = buildToolContext(context);
          toolContext.taskOutcome = { taskId: event.taskId, redoAllowed: true };
          let receipt: unknown;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              receipt = await tool.recoverAcceptedEffect(toolContext);
              break;
            } catch (error) {
              if (!(error instanceof UncertainMutationError)) throw error;
              const backoffMs = [200, 1000][attempt];
              if (
                backoffMs === undefined ||
                Date.now() - state.startTime + backoffMs >= this.config.timeoutMs
              ) {
                // This is a failed read, not a new mutation. Complete the
                // outcome honestly rather than exhausting the bus retry budget.
                state.taskRedoRecoveryUncertain = true;
                return this.outcomeFallback(context, state);
              }
              await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
              if (Date.now() - state.startTime >= this.config.timeoutMs) {
                state.taskRedoRecoveryUncertain = true;
                return this.outcomeFallback(context, state);
              }
            }
          }
          if ((receipt as { success?: boolean } | undefined)?.success === true) {
            // A reply-commit crash must not let a regenerated model deny or
            // duplicate the accepted redo, even when it calls no tools at all.
            const toolCallId = 'recovered-outcome-redo';
            state.executedTools.push({
              toolCallId,
              name: 'core.startTask',
              args: { redoOf: event.taskId },
              hasSideEffects: true,
            });
            state.toolResults.push(createToolResult(toolCallId, 'core.startTask', true, receipt));
            return this.outcomeFallback(context, state);
          }
        }
      }
      const result = await this.runInternal(context, useSmart, state);
      if (this.needsQuestionRelay(context, result.state, result))
        return this.questionFallback(context, result.state);
      if (
        context.triggerSignal.type === 'task_outcome' &&
        (result.terminal.type !== 'respond' ||
          !result.terminal.text.trim() ||
          result.state.disposition === 'error')
      )
        return this.outcomeFallback(context, result.state);
      return result;
    } catch (error) {
      // An accepted redo may exist. Never commit an unverified refusal over it.
      if (error instanceof UncertainMutationError) throw error;
      // Model retries/limits exhausted: the trusted outcome still owes a reply.
      // Sending this deterministic reply is a successful answer, not silence.
      if (context.triggerSignal.type === 'task_outcome')
        return this.outcomeFallback(context, state);
      if (this.needsQuestionRelay(context, state)) return this.questionFallback(context, state);
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Agentic loop failed'
      );
      throw error;
    }
  }

  private outcomeFallback(context: LoopContext, state: LoopState): LoopResult {
    const event = validateTaskOutcome(context.triggerSignal.data);
    const commandTexts = new Map<string, string>();
    for (const tool of state.executedTools) {
      if (
        tool.name !== 'core.steerTask' ||
        tool.args['action'] !== 'read' ||
        tool.args['taskId'] !== event.taskId
      )
        continue;
      const result = state.toolResults.find(
        (entry) => entry.toolCallId === tool.toolCallId && entry.success
      );
      const data = result?.data as
        | { success?: boolean; task?: { id?: string; commands?: unknown } }
        | undefined;
      if (
        data?.success !== true ||
        data.task?.id !== event.taskId ||
        !Array.isArray(data.task.commands)
      )
        continue;
      for (const command of data.task.commands as { commandId?: unknown; text?: unknown }[]) {
        if (typeof command.commandId === 'string' && typeof command.text === 'string')
          commandTexts.set(command.commandId, command.text);
      }
    }
    const acceptedRedo = state.executedTools.some(
      (tool) =>
        tool.name === 'core.startTask' &&
        tool.args['redoOf'] === event.taskId &&
        state.toolResults.some(
          (result) =>
            result.toolCallId === tool.toolCallId &&
            result.success &&
            (result.data as { success?: boolean } | undefined)?.success === true
        )
    );
    const latestOwnerMessage =
      context.conversationHistory?.findLast((message) => message.role === 'user')?.content ?? '';
    const language = taskOutcomeLanguage(context.preferredLanguage, latestOwnerMessage);
    state.disposition = 'answer';
    return buildFinalResultFromNaturalCompletion(
      state.taskRedoRecoveryUncertain || acceptedRedo
        ? taskOutcomeRedoFallback(
            event,
            state.taskRedoRecoveryUncertain === true,
            language,
            context.agentIdentity?.gender
          )
        : taskOutcomeFallback(event, commandTexts, language, context.agentIdentity?.gender),
      state,
      context,
      this.logger
    );
  }

  /** A question may finish quietly only after a correlated answer or owner relay. */
  private needsQuestionRelay(context: LoopContext, state: LoopState, result?: LoopResult): boolean {
    const report = context.triggerSignal.data;
    if (
      context.triggerSignal.type !== 'task_report' ||
      report?.kind !== 'task_report' ||
      report.eventKind !== 'question' ||
      !report.question
    )
      return false;
    const question = report.question;
    if (
      result?.terminal.type === 'respond' &&
      result.terminal.text.trim() &&
      state.disposition !== 'error'
    )
      return false;
    const answered = state.executedTools.some((tool) => {
      if (
        tool.name !== 'core.steerTask' ||
        tool.args['action'] !== 'answer' ||
        tool.args['taskId'] !== report.taskId ||
        tool.args['questionId'] !== question.questionId
      )
        return false;
      return state.toolResults.some((entry) => {
        const receipt = entry.data as Record<string, unknown> | undefined;
        return (
          entry.toolCallId === tool.toolCallId &&
          entry.success &&
          receipt?.['success'] === true &&
          receipt['state'] === 'queued' &&
          receipt['taskId'] === report.taskId &&
          typeof receipt['commandId'] === 'string'
        );
      });
    });
    // A core.say send is only provisional until this turn succeeds. On the
    // exception/error path its send would be withdrawn, unlike a queued task
    // answer that already committed in the task service.
    const relayed =
      result !== undefined &&
      state.disposition !== 'error' &&
      state.toolResults.some((entry) => {
        const text = (entry.data as { delivered_text?: unknown } | undefined)?.delivered_text;
        return (
          entry.toolName === 'core.say' &&
          entry.success &&
          typeof text === 'string' &&
          text.includes(question.questionId) &&
          text.includes(question.text)
        );
      });
    return !answered && !relayed;
  }

  private questionFallback(context: LoopContext, state: LoopState): LoopResult {
    const report = context.triggerSignal.data;
    if (report?.kind !== 'task_report' || !report.question)
      throw new Error('Task question fallback requires a normalized question');
    const latestOwnerMessage =
      context.conversationHistory?.findLast((message) => message.role === 'user')?.content ?? '';
    const language = taskOutcomeLanguage(context.preferredLanguage, latestOwnerMessage);
    const reference = `(${report.taskId}; ${report.question.questionId})`;
    state.disposition = 'answer';
    return buildFinalResultFromNaturalCompletion(
      `${language === 'ru' ? 'Мне нужно уточнение' : 'I need clarification'} ${reference}:\n${report.question.text}`,
      state,
      context,
      this.logger
    );
  }

  /**
   * Internal run implementation using native tool calling.
   */
  private async runInternal(
    context: LoopContext,
    useSmart: boolean,
    state = createLoopState()
  ): Promise<LoopResult> {
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

    // Send full tool schemas — models need them to call tools correctly on first attempt.
    // Lazy schemas (ADR-004 Option 1) were reverted: see docs/adr/004-prompt-token-optimization.md.
    const allTools = this.toolRegistry.getToolsAsOpenAIFormat();
    // One status read + up to 16 output reads, optional transcript/redo, then reply.
    // Keep the existing timeout/tool-call bounds; other triggers keep their budget.
    const maxIterations =
      context.triggerSignal.type === 'task_outcome'
        ? Math.max(this.config.maxIterations, 24)
        : this.config.maxIterations;

    let verificationRetries = 0;
    while (!state.aborted) {
      // Check limits
      if (state.iteration >= maxIterations) {
        state.aborted = true;
        state.abortReason = `Max iterations reached (${String(maxIterations)})`;
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
          const requiresResponse =
            context.triggerSignal.type === 'user_message' ||
            context.triggerSignal.type === 'motor_result' ||
            context.triggerSignal.type === 'task_outcome';

          if (requiresResponse && context.recipientId) {
            this.logger.warn(
              { attempts: state.forceRespondAttempts, iteration: state.iteration },
              'Model refused to respond after forced attempts — sending error to user'
            );
            // A forced refusal is an ERROR turn: it must not settle the log
            // entries of the message it failed to answer (finding 4).
            state.disposition = 'error';
            const terminal: Terminal = {
              type: 'respond',
              text: 'Извини, произошла техническая ошибка. Попробуй ещё раз через минуту.',
              conversationStatus: 'active',
              confidence: 0.3,
            };
            const intents = compileIntentsFromToolResults(terminal, context, state, this.logger);
            return { success: true, terminal, intents, state };
          }

          // Proactive trigger or no recipient — silent noAction
          this.logger.warn(
            { attempts: state.forceRespondAttempts, iteration: state.iteration },
            'Model refused to respond after forced attempts - terminating with noAction'
          );
          state.disposition = 'error';
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

      // Inject diagnostic for malformed retry — show the model its failed response
      // and explain what format is expected, so it can self-correct.
      if (state.malformedContent) {
        messages.push(
          { role: 'assistant', content: state.malformedContent },
          {
            role: 'system',
            content:
              'Your previous response was invalid. You MUST respond with JSON: {"response": "your message"} — not plain text. Rewrite your response in the correct format.',
          }
        );
        delete state.malformedContent;
      }

      // Set tool budgets for autonomous triggers
      maybeSetProactiveToolBudget(state, context, this.logger);

      // Filter tools based on context
      const filteredTools = filterToolsForContext(allTools, context, useSmart);

      // Build request
      // The turn's conversation is named to the platform's model gateway, so a
      // slot's `{session}` header carries this conversation's own id.
      const request = buildRequest(
        messages,
        filteredTools,
        state.forceRespond === true,
        context.recipientId
      );

      const triggerTimeout = getTimeoutForTrigger(context.triggerSignal.type);
      const llmOptions: LLMOptions = {
        maxTokens: this.config.maxOutputTokens,
        useSmart,
        ...(triggerTimeout !== undefined && { timeoutMs: triggerTimeout }),
      };

      let response: Awaited<ReturnType<typeof this.llm.completeWithTools>>;
      try {
        response = await this.llm.completeWithTools(request, llmOptions);
      } catch (error) {
        if (error instanceof LLMError) {
          const errorMeta = {
            provider: error.provider,
            statusCode: error.statusCode,
            ...(error.upstreamProvider && { upstreamProvider: error.upstreamProvider }),
          };

          // Hard provider error (HTTP 500, timeout, etc.) — escalate to smart model
          if (error.retryable && !useSmart) {
            useSmart = true;
            state.providerErrorRetried = false;
            // Reset iteration so the smart model gets a full budget
            state.iteration = 0;
            this.logger.warn(errorMeta, 'Hard provider error — escalating to smart model');
            messages = buildInitialMessages(context, useSmart, promptBuilders);
            if (context.previousAttempt) {
              addPreviousAttemptMessages(messages, context.previousAttempt, state);
            }
            messages = validateToolCallPairs(messages, this.logger);
            continue;
          }

          // Non-retryable error (401, 403, etc.) — retry once (meta-provider may route differently)
          if (!error.retryable) {
            if (!state.nonRetryableErrorRetried) {
              state.nonRetryableErrorRetried = true;
              this.logger.warn(
                errorMeta,
                'Non-retryable provider error — retrying once (upstream re-routing)'
              );
              continue;
            }
            // Already retried once — escalate to smart model if not already
            if (!useSmart) {
              useSmart = true;
              state.nonRetryableErrorRetried = false;
              state.iteration = 0;
              this.logger.warn(
                errorMeta,
                'Non-retryable error persists — escalating to smart model'
              );
              messages = buildInitialMessages(context, useSmart, promptBuilders);
              if (context.previousAttempt) {
                addPreviousAttemptMessages(messages, context.previousAttempt, state);
              }
              messages = validateToolCallPairs(messages, this.logger);
              continue;
            }
          }
        }
        throw error;
      }

      // Capture chain-of-thought if present (cleaned from JSON wrapper)
      // Use same allowPlainText policy to avoid capturing leaked prompt text as thoughts
      if (response.content) {
        const allowPlainText = shouldAllowPlainText(context.triggerSignal.type);
        const parsed = parseResponseContent(response.content, { allowPlainText });
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

        if (
          context.triggerSignal.type === 'task_outcome' ||
          (response.toolCalls.length === 0 && context.triggerSignal.type === 'user_message')
        ) {
          this.logger.debug('Truncated reply is incomplete, forcing bounded retry');
          state.forceRespond = true;
          continue;
        }
      }

      // Provider error — retry WITH tools (don't strip them via forceRespond)
      if (response.finishReason === 'error' && response.toolCalls.length === 0) {
        if (!state.providerErrorRetried) {
          state.providerErrorRetried = true;
          this.logger.warn(
            { iteration: state.iteration, finishReason: response.finishReason },
            'Provider error with no output — retrying with tools'
          );
          continue; // Retry same loop iteration, tools still available
        }
        // Already retried once with same model — escalate to smart model if not already
        if (!useSmart) {
          useSmart = true;
          state.providerErrorRetried = false; // Allow one retry on smart model too
          this.logger.warn(
            { iteration: state.iteration },
            'Provider error persists — escalating to smart model'
          );
          messages = buildInitialMessages(context, useSmart, promptBuilders);
          if (context.previousAttempt) {
            addPreviousAttemptMessages(messages, context.previousAttempt, state);
          }
          messages = validateToolCallPairs(messages, this.logger);
          continue;
        }
        // Smart model also failed — fall through to handleNaturalCompletion,
        // which must not classify the empty result as a deliberate no-reply
        // (finding 4: a provider error never settles a log entry).
        state.disposition = 'error';
        this.logger.error(
          { iteration: state.iteration },
          'Provider error persists after smart escalation'
        );
      }

      // No tool calls = natural completion (Codex-style termination)
      if (response.toolCalls.length === 0) {
        if (context.triggerSignal.type === 'task_outcome') {
          const event = validateTaskOutcome(context.triggerSignal.data);
          const acceptedRedo = state.executedTools.some(
            (tool) =>
              tool.name === 'core.startTask' &&
              tool.args['redoOf'] === event.taskId &&
              state.toolResults.some(
                (result) =>
                  result.toolCallId === tool.toolCallId &&
                  result.success &&
                  (result.data as { success?: boolean } | undefined)?.success === true
              )
          );
          const unread =
            event.state === 'done' && !acceptedRedo
              ? (event.expectedOutputs ?? []).filter(
                  (name) =>
                    !state.executedTools.some(
                      (tool) =>
                        tool.name === 'core.steerTask' &&
                        tool.args['action'] === 'read' &&
                        tool.args['taskId'] === event.taskId &&
                        tool.args['view'] === 'file' &&
                        tool.args['name'] === name &&
                        state.toolResults.some((result) => {
                          const data = result.data as
                            | {
                                success?: boolean;
                                code?: string;
                                taskId?: string;
                                file?: { name?: string; text?: unknown };
                              }
                            | undefined;
                          return (
                            result.toolCallId === tool.toolCallId &&
                            result.success &&
                            ((data?.success === true &&
                              data.taskId === event.taskId &&
                              data.file?.name === name &&
                              typeof data.file.text === 'string') ||
                              (data?.success === false &&
                                data.code === 'file_not_text' &&
                                event.objects.filter(
                                  (object) =>
                                    object.name === name &&
                                    (object.mark === 'result' || object.mark === 'artifact')
                                ).length === 1))
                          );
                        })
                    )
                )
              : [];
          if (unread.length) {
            if (verificationRetries++ >= 2) return this.outcomeFallback(context, state);
            messages.push({ role: 'assistant', content: response.content });
            messages.push({
              role: 'system',
              content: `Verification required before a final reply: open these expected files with core.steerTask(action="read", view="file") and compare their contents with the owner's request: ${JSON.stringify(unread)}. If verification fails, accept one corrected linked redo or explain honestly that the result is unverified. Do not claim success without reading.`,
            });
            continue;
          }
        }
        const result = this.handleNaturalCompletion(response.content, state, context);
        if (result === null) {
          // Check if handleNaturalCompletion is requesting smart model escalation
          if (state.malformedEscalationRequested && !useSmart) {
            // Escalate to smart model — keep existing messages (they contain
            // in-loop tool calls/results that would be lost if we rebuilt).
            state.malformedEscalationRequested = false;
            state.malformedRetried = false; // Allow retry on smart model
            delete state.malformedContent;
            state.iteration = 0; // Reset budget for smart model
            useSmart = true;
            this.logger.warn(
              { triggerType: context.triggerSignal.type, toolCallCount: state.toolCallCount },
              'Malformed response persists — escalating to smart model'
            );
          } else if (state.malformedEscalationRequested && useSmart) {
            // Smart model also can't produce valid JSON — give up
            state.malformedEscalationRequested = false;
            this.logger.error(
              { triggerType: context.triggerSignal.type },
              'Malformed response persists after smart model escalation'
            );

            if (context.triggerSignal.type !== 'user_message') {
              state.disposition = 'error';
              const terminal: Terminal = {
                type: 'noAction',
                reason: 'Malformed LLM response after smart escalation',
              };
              const intents = compileIntentsFromToolResults(terminal, context, state, this.logger);
              return { success: true, terminal, intents, state };
            }

            const trace = getTraceContext();
            const traceRef = trace
              ? `${trace.traceId.slice(0, 8)}:${trace.spanId ?? 'unknown'}`
              : 'unknown';
            state.disposition = 'error';
            const terminal: Terminal = {
              type: 'respond',
              text: `Извини, произошла ошибка. Давай повторим? (trace: ${traceRef})`,
              conversationStatus: 'active',
              confidence: 0.3,
            };
            const intents = compileIntentsFromToolResults(terminal, context, state, this.logger);
            return { success: true, terminal, intents, state };
          }
          continue;
        }

        // Before returning, check for pending user messages that arrived mid-loop.
        // If found, deliver the current response and absorb the new messages into this loop
        // to avoid spawning a redundant COGNITION run.
        // Gate on recipientId + onImmediateIntent to ensure the response can actually be delivered;
        // otherwise fall through to normal return (message will spawn its own COGNITION run).
        if (
          context.triggerSignal.type === 'user_message' &&
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
              const data = signal.data as { text: string; replyTo?: unknown };
              const text = data.text;
              const quote = renderReplyQuote(data.replyTo);
              messages.push({
                role: 'user',
                content: `${quote ? `${quote}\n` : ''}<user_input>${text}</user_input>`,
              });
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
            taskSteerCounts: [...s.taskSteerCounts],
            toolResults: [...s.toolResults],
            executedTools: [...s.executedTools],
            reason,
          },
        }),
        compileIntents: (terminal, ctx, s) =>
          compileIntentsFromToolResults(terminal, ctx, s, this.logger),
      });

      if (state.taskRedoRecoveryUncertain) return this.outcomeFallback(context, state);

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

      // Mid-loop user message injection — only for user_message triggers.
      // For thought/proactive triggers, user messages should be processed in their own tick
      // with full tool access and no proactive budget constraint.
      if (context.triggerSignal.type === 'user_message') {
        const pendingMessages = context.drainPendingUserMessages?.() ?? [];
        for (const signal of pendingMessages) {
          const data = signal.data as { text: string; replyTo?: unknown };
          const text = data.text;
          const quote = renderReplyQuote(data.replyTo);
          messages.push({
            role: 'user',
            content: `${quote ? `${quote}\n` : ''}<user_input>${text}</user_input>`,
          });
          this.logger.debug({ text: text.slice(0, 50) }, 'Injected mid-loop user message');
        }
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
    // Allow plain text for user-facing triggers (user_message, motor_result).
    // Proactive triggers require JSON to prevent prompt leakage — weaker models
    // sometimes echo system instructions as plain text instead of responding.
    //
    // Exception: if the model already made tool calls in this tick, plain text is
    // almost certainly a legitimate response (the model did real work but forgot
    // the JSON wrapper). Salvage it instead of discarding.
    const didRealWork = state.toolCallCount > 0;
    const allowPlainText = shouldAllowPlainText(context.triggerSignal.type) || didRealWork;
    const parseOpts: ParseOptions = { allowPlainText };
    const parsed = parseResponseContent(content, parseOpts);
    const messageText = parsed.text;

    // Log plain-text acceptance for monitoring
    if (
      messageText &&
      content &&
      !content.trim().startsWith('{') &&
      !content.trim().startsWith('```')
    ) {
      this.logger.info(
        {
          contentLength: content.length,
          ...(didRealWork && { salvaged: true, toolCallCount: state.toolCallCount }),
        },
        didRealWork
          ? 'Salvaged plain-text response from model that made tool calls'
          : 'Accepted plain-text response (model skipped JSON format)'
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
          'Malformed LLM response detected — retrying with tools'
        );
        // Inject the failed response + diagnostic so the model can self-correct.
        // Without this, the model has no idea why it's being retried.
        if (content) {
          state.malformedContent = content;
        }
        // Retry WITH tools (don't strip them via forceRespond).
        // The model may have intended a tool call (e.g. core.defer) but emitted
        // plain text instead. Stripping tools on retry forces a {"response":...}
        // which always sends a message — wrong for proactive triggers.
        return null;
      }

      // Already retried with same model — request smart escalation via runInternal
      this.logger.warn(
        {
          contentLength: content?.length ?? 0,
          contentPreview: content?.slice(0, 100),
          triggerType: context.triggerSignal.type,
        },
        'Malformed LLM response persists after retry — requesting smart escalation'
      );
      state.malformedEscalationRequested = true;
      return null;
    }

    // Store conversation status from response if provided
    if (parsed.status) {
      state.conversationStatus = parsed.status;
    }

    // Edge case: user message or motor_result but no response text.
    // If core.say already delivered a message to the user during this turn,
    // an empty final response is valid — the user already got their answer
    // (e.g. "extracting transcript..." before a background motor run).
    const requiresResponse =
      context.triggerSignal.type === 'user_message' ||
      context.triggerSignal.type === 'motor_result' ||
      context.triggerSignal.type === 'task_outcome';
    const saySent =
      context.triggerSignal.type !== 'task_outcome' &&
      state.toolResults.some(
        (result) =>
          result.toolName === 'core.say' &&
          result.success &&
          typeof (result.data as { delivered_text?: unknown } | undefined)?.delivered_text ===
            'string'
      );
    if (!messageText && requiresResponse) {
      if (saySent) {
        this.logger.debug(
          'Empty response after core.say — accepting (user already received a message)'
        );
        // Fall through to build a valid noAction terminal. The user DID get
        // an answer (core.say sent it during this turn), so this is an
        // `answer` disposition, not a no-reply: it still needs its send to
        // have been delivered (finding 4).
        state.disposition = 'answer';
        const terminal: Terminal = {
          type: 'noAction',
          reason: 'Response already delivered via core.say',
        };
        const intents = compileIntentsFromToolResults(terminal, context, state, this.logger);
        return { success: true, terminal, intents, state };
      }
      // First retry WITH tools (the model may have glitched and needs another chance
      // to call tools). Only strip tools via forceRespond on the second failure —
      // stripping tools on a factual question guarantees hallucination.
      if (!state.emptyResponseRetried) {
        state.emptyResponseRetried = true;
        this.logger.debug('No response text for motor/user trigger, retrying with tools');
        return null; // retry with tools intact
      }
      this.logger.debug('No response text after retry with tools, forcing response');
      state.forceRespond = true;
      return null; // Signal caller to continue loop
    }

    // Log for proactive triggers with no action
    if (!messageText && context.triggerSignal.type !== 'user_message') {
      const isExpectedNoAction =
        context.triggerSignal.type === 'thought' ||
        context.triggerSignal.type === 'message_reaction' ||
        context.triggerSignal.type === 'plugin_event';
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

    // Fallback notification for motor_result with no response text
    let effectiveMessageText = messageText;
    if (!messageText && context.triggerSignal.type === 'motor_result') {
      const data = context.triggerSignal.data as
        | { status?: string; runId?: string; result?: { summary?: string } }
        | undefined;
      const runId = data?.runId ?? 'unknown';
      const status = data?.status ?? 'unknown';

      if (status === 'failed') {
        effectiveMessageText = `Background task (${runId}) failed. Use core.task(action:"status") for details.`;
      } else if (status === 'completed') {
        const summary = data?.result?.summary;
        effectiveMessageText = summary
          ? `Task ${runId} completed: ${summary.slice(0, 300)}`
          : `Background task (${runId}) completed.`;
      } else if (status === 'awaiting_input') {
        effectiveMessageText = `Background task (${runId}) needs your input. Use core.task(action:"status") for details.`;
      } else if (status === 'awaiting_approval') {
        effectiveMessageText = `Background task (${runId}) needs your approval. Use core.task(action:"status") for details.`;
      }
    }

    // Thought trigger response routing
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
