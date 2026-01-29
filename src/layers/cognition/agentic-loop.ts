/**
 * COGNITION Agentic Loop
 *
 * Executes the think → tool → think cycle until natural conclusion.
 * Handles tool execution, state updates, and escalation decisions.
 *
 * Flow:
 * 1. Build prompt with context
 * 2. Call LLM, get CognitionOutput
 * 3. Execute any tool calls
 * 4. If needsToolResult → inject results, go to step 2
 * 5. If respond/noAction/defer → compile to intents, return
 * 6. If low confidence and safe to retry → retry with smart model
 */

import type { Logger } from '../../types/logger.js';
import type { Intent } from '../../types/intent.js';
import type { Signal } from '../../types/signal.js';
import type { AgentState } from '../../types/agent/state.js';
import type {
  CognitionOutput,
  Step,
  ToolStep,
  ToolResult,
  LoopConfig,
  LoopState,
  Terminal,
} from '../../types/cognition.js';
import {
  DEFAULT_LOOP_CONFIG,
  createLoopState,
  getFieldPolicy,
  COGNITION_SCHEMA_VERSION,
  validateTerminal,
} from '../../types/cognition.js';
import { THOUGHT_LIMITS } from '../../types/signal.js';
import type { ThoughtData } from '../../types/signal.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';

/**
 * LLM interface for the agentic loop.
 */
export interface CognitionLLM {
  /**
   * Call the LLM with a prompt and get structured output.
   * @param prompt The prompt to complete
   * @param options LLM options including useSmart for smart model retry
   */
  complete(prompt: string, options?: LLMOptions): Promise<string>;
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
  /** Steps from first attempt */
  steps: Step[];
  /** Tool results from first attempt (reuse, don't re-execute) */
  toolResults: ToolResult[];
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

  /** Correlation ID */
  correlationId: string;

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

  /** All steps taken */
  steps: Step[];

  /** Compiled intents to execute */
  intents: Intent[];

  /** Steps that need escalation review (low confidence) */
  pendingEscalation: Step[];

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
      return false; // noAction, defer, needsToolResult - no retry needed
    }

    // Check terminal confidence (now REQUIRED field)
    if (result.terminal.confidence < SMART_RETRY_CONFIDENCE_THRESHOLD) {
      return true;
    }

    // Check for pending low-confidence updates
    if (result.pendingEscalation.length > 0) {
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
        pendingEscalation: firstResult.pendingEscalation.length,
      },
      'Retrying with smart model due to low confidence'
    );

    // Build enriched context with first attempt info
    const enrichedContext: LoopContext = {
      ...context,
      previousAttempt: {
        steps: firstResult.steps,
        toolResults: firstResult.state.toolResults,
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
   * Internal run implementation.
   * @param context Loop context
   * @param useSmart Whether to use smart model
   */
  private async runInternal(context: LoopContext, useSmart: boolean): Promise<LoopResult> {
    const state = createLoopState();
    const toolResults: ToolResult[] = [];
    const pendingEscalation: Step[] = [];

    this.logger.debug(
      {
        correlationId: context.correlationId,
        triggerType: context.triggerSignal.type,
        useSmart,
        hasPreviousAttempt: !!context.previousAttempt,
      },
      'Agentic loop starting'
    );

    // If retrying, pre-populate steps and tool results from previous attempt
    // This allows the smart model to see what the fast model tried
    if (context.previousAttempt) {
      // Add previous steps so they appear in the prompt
      state.allSteps.push(...context.previousAttempt.steps);

      // Add previous tool results (will be shown to LLM)
      toolResults.push(...context.previousAttempt.toolResults);
      state.toolResults.push(...context.previousAttempt.toolResults);

      // Mark all previous tools as executed (they won't be re-run)
      for (const result of context.previousAttempt.toolResults) {
        state.executedTools.push({
          stepId: result.stepId,
          name: result.toolName,
          args: {}, // Args not available from ToolResult, but not needed for tracking
          hasSideEffects: this.toolRegistry.hasToolSideEffects(result.toolName),
        });
      }
    }

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

      // Build prompt
      const prompt = this.buildPrompt(context, state, toolResults);

      // Call LLM (use smart model if specified)
      state.iteration++;
      const rawOutput = await this.llm.complete(prompt, {
        maxTokens: this.config.maxOutputTokens,
        useSmart,
      });

      // Parse output
      const output = this.parseOutput(rawOutput, context.correlationId, context.triggerSignal.id);
      if (!output) {
        state.aborted = true;
        state.abortReason = 'Failed to parse LLM output';
        break;
      }

      // Track ALL executed tools by composite key (stepId:toolName) to handle ID reuse
      // LLM sometimes reuses step IDs across different tools
      // Note: We track all executions (success+failure) because the deduplication logic
      // filters by (stepId:toolName) only, not args. Allowing "retries" would just
      // re-execute the same args repeatedly. True retry would need args-aware identity.
      const executedToolKeys = new Set(toolResults.map((r) => `${r.stepId}:${r.toolName}`));

      // Add steps to state (deduplicate by composite key for tools, by id for others)
      // This allows different tools with same stepId to coexist
      const existingStepKeys = new Set(
        state.allSteps.map((s) => (s.type === 'tool' ? `${s.id}:${s.name}` : s.id))
      );
      const newSteps = output.steps.filter((s) => {
        const key = s.type === 'tool' ? `${s.id}:${s.name}` : s.id;
        return !existingStepKeys.has(key);
      });
      state.allSteps.push(...newSteps);

      // Check for steps needing escalation
      const escalationSteps = this.checkEscalation(output.steps);
      pendingEscalation.push(...escalationSteps);

      // Find all pending tool steps (tools that haven't been executed yet)
      const pendingToolSteps = state.allSteps.filter(
        (s): s is ToolStep => s.type === 'tool' && !executedToolKeys.has(`${s.id}:${s.name}`)
      );

      // Handle terminal state
      if (output.terminal.type === 'needsToolResult') {
        // Find the PENDING tool with this stepId (first one not yet executed)
        const needsResultTerminal = output.terminal;
        const toolStep = pendingToolSteps.find((s) => s.id === needsResultTerminal.stepId);

        if (toolStep) {
          // Tool is pending - execute it
          state.toolCallCount++;
          const result = await this.executeTool(toolStep, context);
          toolResults.push(result);
          state.toolResults.push(result);

          // Track executed tool with side effects info
          state.executedTools.push({
            stepId: toolStep.id,
            name: toolStep.name,
            args: toolStep.args,
            hasSideEffects: this.toolRegistry.hasToolSideEffects(toolStep.name),
          });
        } else {
          // No pending tool with this stepId - might be already executed or doesn't exist
          // Force LLM to respond instead of looping
          this.logger.debug(
            { stepId: needsResultTerminal.stepId },
            'No pending tool found for stepId, forcing response'
          );
          state.forceRespond = true;
        }

        continue;
      }

      // For non-needsToolResult terminals: execute any pending tools first
      // This handles the case where LLM returns tool steps with respond/noAction terminal
      if (pendingToolSteps.length > 0) {
        const pendingTool = pendingToolSteps[0];
        if (pendingTool) {
          this.logger.warn(
            {
              terminal: output.terminal.type,
              pendingTools: pendingToolSteps.map((t) => t.name),
              executing: pendingTool.name,
            },
            'LLM returned terminal with pending tools - executing tools first'
          );

          state.toolCallCount++;
          const result = await this.executeTool(pendingTool, context);
          toolResults.push(result);
          state.toolResults.push(result);

          // Track executed tool with side effects info
          state.executedTools.push({
            stepId: pendingTool.id,
            name: pendingTool.name,
            args: pendingTool.args,
            hasSideEffects: this.toolRegistry.hasToolSideEffects(pendingTool.name),
          });

          // Continue loop so LLM can see tool result and provide proper response
          continue;
        }
      }

      // Terminal states: respond, noAction, defer (only when no pending tools)
      this.logger.debug(
        {
          terminal: output.terminal.type,
          iterations: state.iteration,
          toolCalls: state.toolCallCount,
          steps: state.allSteps.length,
        },
        'Agentic loop completed'
      );

      // Compile intents (from steps and tool results)
      const intents = this.compileIntents(
        state.allSteps,
        output.terminal,
        context,
        state.toolResults
      );

      return {
        success: true,
        terminal: output.terminal,
        steps: state.allSteps,
        intents,
        pendingEscalation,
        state,
        usedSmartRetry: useSmart,
      };
    }

    // Aborted - throw error to trigger smart retry at run() level
    this.logger.warn(
      { reason: state.abortReason, iterations: state.iteration, useSmart },
      'Agentic loop aborted'
    );

    // Throw error to let run() handle retry logic
    throw new Error(state.abortReason ?? 'Agentic loop aborted');
  }

  /**
   * Build prompt for LLM.
   */
  private buildPrompt(context: LoopContext, state: LoopState, toolResults: ToolResult[]): string {
    const sections: string[] = [];

    // System instruction (includes agent identity)
    sections.push(this.buildSystemPrompt(context));

    // Current state
    sections.push(this.buildStateSection(context));

    // Conversation history
    if (context.conversationHistory.length > 0) {
      sections.push(this.buildHistorySection(context.conversationHistory));
    }

    // Previous steps (if continuing)
    if (state.allSteps.length > 0) {
      sections.push(this.buildPreviousStepsSection(state.allSteps, toolResults));
    }

    // Current trigger
    sections.push(this.buildTriggerSection(context.triggerSignal, context));

    // Force respond instruction (if tool already executed but LLM keeps asking)
    if (state.forceRespond) {
      sections.push(`## IMPORTANT
The tool has already been executed and the result is shown above in Previous Steps.
You MUST now provide a response to the user. Do NOT request the tool again.
Use terminal type "respond" with your answer based on the tool result.`);
    }

    // Output format
    sections.push(this.buildOutputFormat());

    return sections.join('\n\n');
  }

  private buildSystemPrompt(context: LoopContext): string {
    const agentName = context.agentIdentity?.name ?? 'Life';
    const agentGender = context.agentIdentity?.gender ?? 'neutral';
    const values = context.agentIdentity?.values?.join(', ') ?? 'Be helpful and genuine';

    const genderNote =
      agentGender === 'female'
        ? 'Use feminine grammatical forms in gendered languages (e.g., Russian: "рада", "готова").'
        : agentGender === 'male'
          ? 'Use masculine grammatical forms in gendered languages (e.g., Russian: "рад", "готов").'
          : 'Use neutral grammatical forms when possible.';

    return `You are ${agentName} (${agentGender}). Values: ${values}
${genderNote}

Capabilities: think → use tools → update beliefs (with evidence) → respond

Rules:
- Plain text only (no markdown)
- Don't re-greet if already greeted
- User's name: only on first greeting or after long pauses, not every message
- Only promise what your tools can do. Memory ≠ reminders. Check "Available tools" before promising future actions.
- Set confidence below 0.6 when uncertain about complex/sensitive topics`;
  }

  private buildStateSection(context: LoopContext): string {
    const { agentState, userModel } = context;

    // Format user model values with explanations
    const formatUserModelValue = (value: unknown): string => {
      if (value === null || value === undefined) return 'unknown';
      if (typeof value === 'number') {
        // Convert 0-1 values to percentages
        return `${(value * 100).toFixed(0)}%`;
      }
      if (typeof value === 'string') return value;
      return 'unknown';
    };

    const userModelLines = [
      `- name: ${formatUserModelValue(userModel['name'])}`,
      `- energy: ${formatUserModelValue(userModel['energy'])} (estimated user energy level)`,
      `- availability: ${formatUserModelValue(userModel['availability'])} (how available user seems)`,
      `- mood: ${formatUserModelValue(userModel['mood'])} (detected from messages)`,
    ];

    return `## Current State

Agent:
- Energy: ${(agentState.energy * 100).toFixed(0)}%
- Social Debt: ${(agentState.socialDebt * 100).toFixed(0)}%
- Task Pressure: ${(agentState.taskPressure * 100).toFixed(0)}%
- Curiosity: ${(agentState.curiosity * 100).toFixed(0)}%

User Model (your beliefs about the user):
${userModelLines.join('\n')}
NOTE: Do NOT use the user's name in every message. Check conversation history first.`;
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

  private buildPreviousStepsSection(steps: Step[], toolResults: ToolResult[]): string {
    const lines: string[] = ['## Previous Steps (already executed, do not repeat)'];

    for (const step of steps) {
      if (step.type === 'think') {
        lines.push(`[think] ${step.content}`);
      } else if (step.type === 'tool') {
        // Match by both stepId AND toolName to handle ID reuse
        const result = toolResults.find((r) => r.stepId === step.id && r.toolName === step.name);
        if (result) {
          // Tool was executed - show as completed with clear instruction
          if (result.success) {
            lines.push(`[tool:${step.name}] RESULT: ${JSON.stringify(result.data)}`);
            lines.push(
              `  ↳ Tool executed successfully. Use this result to formulate your response. Do NOT call this tool again.`
            );
          } else {
            lines.push(`[tool:${step.name}] FAILED: ${result.error ?? 'Unknown error'}`);
            lines.push(
              `  ↳ Tool failed. Respond to user without this information or try a different approach.`
            );
          }
        } else {
          // Tool pending (shouldn't happen normally)
          lines.push(`[tool:${step.name}] PENDING args=${JSON.stringify(step.args)}`);
        }
      }
    }

    return lines.join('\n');
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

  private buildOutputFormat(): string {
    return `## Output Format

Respond with valid JSON:

{
  "steps": [
    { "type": "think", "id": "t1", "parentId": "<signal_id or previous_step_id>", "content": "..." },
    { "type": "tool", "id": "tool1", "parentId": "t1", "name": "core.memory", "args": { "action": "search", "query": "..." } },
    { "type": "updateUser", "id": "u1", "parentId": "t1", "field": "mood", "value": "happy", "confidence": 0.8, "source": "inferred" },
    { "type": "updateAgent", "id": "a1", "parentId": "t1", "field": "socialDebt", "operation": "delta", "value": -0.1, "confidence": 0.9, "reason": "had conversation" },
    { "type": "saveFact", "id": "f1", "parentId": "t1", "fact": { "subject": "user", "predicate": "name", "object": "Shady", "source": "user_quote", "evidence": "said 'I'm Shady'", "confidence": 0.95, "tags": ["identity"] } },
    { "type": "schedule", "id": "s1", "parentId": "t1", "delayMs": 3600000, "event": { "type": "followUp", "context": { "topic": "interview" } } }
  ],
  "terminal": { "type": "respond", "text": "Hello!", "parentId": "t1", "conversationStatus": "awaiting_answer", "confidence": 0.85 }
  // OR: { "type": "needsToolResult", "stepId": "tool1" }
  // OR: { "type": "noAction", "reason": "nothing to do", "parentId": "t1" }
  // OR: { "type": "defer", "signalType": "contact_urge", "reason": "User seems busy", "deferHours": 4, "parentId": "t1" }
}

Terminal types:
- "respond": Send message. ALL fields REQUIRED:
  - text: The message to send
  - conversationStatus: One of:
    - "active": Mid-conversation, expect quick reply
    - "awaiting_answer": Asked a question, waiting for response
    - "closed": Said goodbye or user is busy - don't follow up
    - "idle": Statement made, no question asked, OK to reach out later
  - confidence: 0-1 (how confident you are in this response)
    - 0.8-1.0: High confidence, proceed normally
    - 0.6-0.8: Moderate confidence, acceptable
    - Below 0.6: Uncertain - system will use deeper reasoning
- "noAction": Do nothing (for internal triggers with nothing to do)
- "defer": Don't act now, reconsider in deferHours - works for any signal type
- "needsToolResult": Waiting for tool to complete

IMPORTANT: If you include any tool step, use "needsToolResult" terminal to wait for the result before responding.

## Available Tools
${this.toolRegistry.getToolCards().join('\n') || '(none)'}

IMPORTANT: Tool cards above show only brief descriptions. Before using a plugin.* tool for the first time, get its full schema:
{ "type": "tool", "id": "help1", "parentId": "t1", "name": "core.tools", "args": { "action": "describe", "name": "plugin.reminder" } }
Use the EXACT tool name from the cards (e.g., "core.memory", "plugin.reminder", not "memory").
If a tool returns an error with a "schema" field, use that schema to correct your parameters.`;
  }

  /**
   * Parse LLM output to CognitionOutput.
   * Throws on validation failure (caller should catch and retry with smart model).
   */
  private parseOutput(
    raw: string,
    correlationId: string,
    triggerSignalId: string
  ): CognitionOutput | null {
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = raw;
      const jsonMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
      if (jsonMatch?.[1]) {
        jsonStr = jsonMatch[1];
      }

      const parsed = JSON.parse(jsonStr.trim()) as {
        steps?: Step[];
        terminal?: Terminal;
      };

      // Validate required fields
      if (!parsed.terminal) {
        this.logger.error({ raw: raw.slice(0, 500) }, 'LLM output missing terminal');
        return null;
      }

      // Validate terminal has required fields based on type
      try {
        validateTerminal(parsed.terminal);
      } catch (validationError) {
        this.logger.warn(
          {
            error:
              validationError instanceof Error ? validationError.message : String(validationError),
            terminalType: (parsed.terminal as unknown as Record<string, unknown>)['type'],
            terminal: parsed.terminal,
          },
          'Terminal validation failed, will retry with smart model'
        );
        // Return null to trigger smart retry
        return null;
      }

      return {
        schemaVersion: COGNITION_SCHEMA_VERSION,
        correlationId,
        triggerSignalId,
        steps: parsed.steps ?? [],
        terminal: parsed.terminal,
      };
    } catch (error) {
      this.logger.error({ error, raw: raw.slice(0, 500) }, 'Failed to parse LLM output');
      return null;
    }
  }

  /**
   * Execute a tool step.
   */
  private async executeTool(step: ToolStep, context: LoopContext): Promise<ToolResult> {
    const toolContext: ToolContext = {
      recipientId: context.recipientId ?? '',
      userId: context.userId,
      correlationId: context.correlationId,
    };

    return this.toolRegistry.execute({
      stepId: step.id,
      name: step.name,
      args: step.args,
      context: toolContext,
    });
  }

  /**
   * Check which steps need escalation due to low confidence.
   */
  private checkEscalation(steps: Step[]): Step[] {
    const needsEscalation: Step[] = [];

    for (const step of steps) {
      if (step.type === 'updateUser') {
        const policy = getFieldPolicy(`user.${step.field}`);
        if (step.confidence < policy.minConfidence && policy.escalateIfUncertain) {
          needsEscalation.push(step);
        }
      } else if (step.type === 'updateAgent') {
        const policy = getFieldPolicy(`agent.${step.field}`);
        if (step.confidence < policy.minConfidence) {
          needsEscalation.push(step);
        }
      }
    }

    return needsEscalation;
  }

  /**
   * Compile steps and tool results to intents.
   */
  private compileIntents(
    steps: Step[],
    terminal: Terminal,
    context: LoopContext,
    toolResults: ToolResult[]
  ): Intent[] {
    const intents: Intent[] = [];

    for (const step of steps) {
      const intent = this.stepToIntent(step, context);
      if (intent) {
        intents.push(intent);
      }
    }

    // Handle core.thought tool results → EMIT_THOUGHT intents
    for (const result of toolResults) {
      if (result.toolName === 'core.thought' && result.success) {
        const thoughtIntent = this.thoughtToolResultToIntent(result, context);
        if (thoughtIntent) {
          intents.push(thoughtIntent);
        }
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
      });
    }

    return intents;
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
      rootId = `thought_${result.stepId}`;
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

  /**
   * Convert a step to an intent.
   */
  private stepToIntent(step: Step, context: LoopContext): Intent | null {
    switch (step.type) {
      case 'updateUser': {
        const policy = getFieldPolicy(`user.${step.field}`);
        if (step.confidence >= policy.minConfidence) {
          const intent: Intent = {
            type: 'UPDATE_USER_MODEL',
            payload: {
              recipientId: context.recipientId,
              field: step.field,
              value: step.value,
              confidence: step.confidence,
              source: step.source,
              evidence: step.evidence,
            },
          };
          return intent;
        }
        return null;
      }

      case 'updateAgent': {
        const policy = getFieldPolicy(`agent.${step.field}`);
        if (step.confidence >= policy.minConfidence) {
          let value = step.value;

          if (step.operation === 'delta') {
            // Check maxDelta for delta operations only
            if (policy.maxDelta && Math.abs(value) > policy.maxDelta) {
              this.logger.warn(
                { field: step.field, value, maxDelta: policy.maxDelta },
                'Delta value exceeds maxDelta, clamping'
              );
              value = Math.sign(value) * policy.maxDelta;
            }
          } else {
            // For 'set' operations, clamp to valid range [0, 1]
            value = Math.max(0, Math.min(1, value));
          }

          return {
            type: 'UPDATE_STATE',
            payload: {
              key: step.field,
              value,
              delta: step.operation === 'delta',
            },
          };
        }
        return null;
      }

      case 'saveFact': {
        const saveIntent: Intent = {
          type: 'SAVE_TO_MEMORY',
          payload: {
            type: 'fact',
            recipientId: context.recipientId,
            fact: step.fact,
          },
        };
        return saveIntent;
      }

      case 'schedule': {
        const scheduleIntent: Intent = {
          type: 'SCHEDULE_EVENT',
          payload: {
            event: {
              source: 'cognition',
              type: step.event.type,
              priority: 50,
              payload: step.event.context,
            },
            delay: step.delayMs,
            scheduleId: step.id,
          },
        };
        return scheduleIntent;
      }

      case 'think':
      case 'tool':
        // These don't produce intents directly
        return null;

      default:
        return null;
    }
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
