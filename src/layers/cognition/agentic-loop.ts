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
  StructuredFact,
} from '../../types/cognition.js';
import {
  DEFAULT_LOOP_CONFIG,
  createLoopState,
  COGNITION_SCHEMA_VERSION,
  validateTerminal,
} from '../../types/cognition.js';
import { THOUGHT_LIMITS } from '../../types/signal.js';
import type { ThoughtData } from '../../types/signal.js';
import type { ToolRegistry } from './tools/registry.js';
import type { ToolContext } from './tools/types.js';
import type { OpenAIChatTool } from '../../llm/tool-schema.js';
import { unsanitizeToolName } from '../../llm/tool-schema.js';
import type { ResponseFormat, JsonSchemaDefinition } from '../../llm/provider.js';

/**
 * JSON Schema for CognitionOutput structured output.
 *
 * Used with response_format.json_schema to guide LLM output format.
 * This schema provides structure guidance; strict validation of terminal
 * types and required fields happens at parse time via validateTerminal().
 *
 * Note: strict is false for multi-provider compatibility. Some providers
 * don't support strict mode or complex oneOf schemas. Runtime validation
 * in parseOutput() catches any missing required fields.
 */
export const COGNITION_OUTPUT_SCHEMA: JsonSchemaDefinition = {
  name: 'cognition_output',
  strict: false, // Rely on runtime validation for type-specific required fields
  schema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['think', 'tool'] },
            id: { type: 'string' },
            // parentId removed - system auto-assigns based on position
            // think step fields
            content: { type: 'string' },
            // tool step fields
            name: { type: 'string' },
            args: { type: 'object', additionalProperties: true },
          },
          required: ['type', 'id'],
        },
      },
      terminal: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['respond', 'noAction', 'defer', 'needsToolResult'] },
          // respond fields
          text: { type: 'string' },
          // parentId removed - system auto-assigns (last step or trigger signal)
          conversationStatus: {
            type: 'string',
            enum: ['active', 'awaiting_answer', 'closed', 'idle'],
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          // noAction/defer fields
          reason: { type: 'string' },
          // defer fields
          signalType: { type: 'string' },
          deferHours: { type: 'number', minimum: 0 },
          // needsToolResult fields
          stepId: { type: 'string' },
        },
        required: ['type'],
      },
    },
    required: ['steps', 'terminal'],
  },
};

/**
 * Structured request for the LLM.
 * Separates system prompt (stable/cacheable) from user prompt (dynamic).
 * Includes native tools and response format for structured output.
 */
export interface StructuredRequest {
  /** System prompt - stable, cacheable instructions */
  systemPrompt: string;

  /** User prompt - dynamic per-request content */
  userPrompt: string;

  /** Native tools available for the model to call */
  tools?: OpenAIChatTool[];

  /** Response format for structured output */
  responseFormat?: ResponseFormat;
}

/**
 * LLM interface for the agentic loop.
 */
export interface CognitionLLM {
  /**
   * Call the LLM with a structured request and get output.
   * @param request Structured request with system/user prompts, tools, response format
   * @param options LLM options including useSmart for smart model retry
   */
  complete(request: StructuredRequest, options?: LLMOptions): Promise<string>;
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

      // Build structured request
      const request = this.buildRequest(context, state, toolResults, useSmart);

      // Call LLM (use smart model if specified)
      state.iteration++;
      const rawOutput = await this.llm.complete(request, {
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
          // Use internal (unsanitized) name for registry lookup
          const internalName = unsanitizeToolName(toolStep.name);
          state.executedTools.push({
            stepId: toolStep.id,
            name: internalName,
            args: toolStep.args,
            hasSideEffects: this.toolRegistry.hasToolSideEffects(internalName),
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
          // Use internal (unsanitized) name for registry lookup
          const internalPendingName = unsanitizeToolName(pendingTool.name);
          state.executedTools.push({
            stepId: pendingTool.id,
            name: internalPendingName,
            args: pendingTool.args,
            hasSideEffects: this.toolRegistry.hasToolSideEffects(internalPendingName),
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
   * Build structured request for LLM.
   *
   * Separates system prompt (stable) from user prompt (dynamic) to optimize caching.
   * Includes native tools and structured output schema.
   */
  private buildRequest(
    context: LoopContext,
    state: LoopState,
    toolResults: ToolResult[],
    useSmart: boolean
  ): StructuredRequest {
    // System prompt (stable, cacheable)
    const systemPrompt = this.buildSystemPrompt(context, useSmart);

    // User prompt sections (dynamic per-request)
    const userSections: string[] = [];

    // User profile (stable facts)
    const userProfile = this.buildUserProfileSection(context);
    if (userProfile) {
      userSections.push(userProfile);
    }

    // Runtime snapshot (conditional, 1-line)
    const runtimeSnapshot = this.buildRuntimeSnapshotSection(context, useSmart);
    if (runtimeSnapshot) {
      userSections.push(runtimeSnapshot);
    }

    // Conversation history
    if (context.conversationHistory.length > 0) {
      userSections.push(this.buildHistorySection(context.conversationHistory));
    }

    // Previous steps (if continuing)
    if (state.allSteps.length > 0) {
      userSections.push(this.buildPreviousStepsSection(state.allSteps, toolResults));
    }

    // Current trigger
    userSections.push(this.buildTriggerSection(context.triggerSignal, context));

    // Force respond instruction (if tool already executed but LLM keeps asking)
    if (state.forceRespond) {
      userSections.push(this.buildForceRespondSection());
    }

    // Output format instructions (JSON format only, no tool docs)
    userSections.push(this.buildOutputFormat());

    return {
      systemPrompt,
      userPrompt: userSections.join('\n\n'),
      tools: this.toolRegistry.getToolsAsOpenAIFormat(),
      responseFormat: {
        type: 'json_schema',
        json_schema: COGNITION_OUTPUT_SCHEMA,
      },
    };
  }

  /**
   * Build force respond section.
   */
  private buildForceRespondSection(): string {
    return `## IMPORTANT
The tool has already been executed and the result is shown above in Previous Steps.
You MUST now provide a response to the user. Do NOT request the tool again.
Use terminal type "respond" with your answer based on the tool result.`;
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

    return `You are ${agentName} (${agentGender}). Values: ${values}
${genderNote}

Capabilities: think → use tools → update beliefs (with evidence) → respond

Rules:
- Plain text only (no markdown)
- Don't re-greet if already greeted
- User's name: only on first greeting or after long pauses, not every message
- Only promise what your tools can do. Memory ≠ reminders. Check "Available tools" before promising future actions.
- Set confidence below 0.6 when uncertain about complex/sensitive topics
- State access: use the Runtime Snapshot if provided; call core.state when you need precise or missing agent/user state.${
      useSmart
        ? ''
        : `
- If a response depends on agent/user state, call core.state first (unless the snapshot already answers it).
- Invalid JSON will be rejected; respond with valid JSON only.`
    }`;
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

  private buildPreviousStepsSection(steps: Step[], toolResults: ToolResult[]): string {
    const lines: string[] = ['## Previous Steps (already executed, do not repeat)'];

    for (const step of steps) {
      if (step.type === 'think') {
        lines.push(`[think] ${step.content}`);
      } else {
        // step.type === 'tool' (TypeScript narrowing)
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
    // Tool documentation removed - tools are now passed natively via the `tools` parameter
    // The LLM will see full tool schemas in the API request

    return `## Output Format

Respond with valid JSON. Only two step types allowed:
- "think": Chain-of-thought reasoning (observable, no side effects)
- "tool": ALL mutations via tools (tracked, with feedback)

{
  "steps": [
    { "type": "think", "id": "t1", "content": "reasoning..." },
    { "type": "tool", "id": "tool1", "name": "<tool_name>", "args": { ... } }
  ],
  "terminal": { "type": "respond", "text": "...", "conversationStatus": "...", "confidence": 0.85 }
}

Terminal types:
- "respond": Send message to user. ALL fields REQUIRED:
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
- "noAction": Internal processing complete, no user contact needed (tools still execute)
- "defer": Don't act now, reconsider in deferHours - works for any signal type
- "needsToolResult": Waiting for tool to complete

IMPORTANT: If you include any tool step, use "needsToolResult" terminal to wait for the result before responding.

Tool names are provided in the tools parameter. Use the EXACT tool name as shown (e.g., "core_memory", "core_time").
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

      // Validate steps and auto-assign parentId based on position
      const validatedSteps = this.validateSteps(parsed.steps ?? [], triggerSignalId);
      if (validatedSteps === null) {
        // Validation failed, will trigger smart retry
        return null;
      }

      // Cross-validate: if terminal is needsToolResult, verify stepId exists in validated steps
      if (parsed.terminal.type === 'needsToolResult') {
        const stepId = parsed.terminal.stepId;
        const stepExists = validatedSteps.some((s) => s.id === stepId && s.type === 'tool');
        if (!stepExists) {
          this.logger.warn(
            { stepId, validStepIds: validatedSteps.map((s) => s.id) },
            'needsToolResult references non-existent tool step, will retry with smart model'
          );
          return null;
        }
      }

      return {
        schemaVersion: COGNITION_SCHEMA_VERSION,
        correlationId,
        triggerSignalId,
        steps: validatedSteps,
        terminal: parsed.terminal,
      };
    } catch (error) {
      this.logger.error({ error, raw: raw.slice(0, 500) }, 'Failed to parse LLM output');
      return null;
    }
  }

  /**
   * Validate steps have required fields based on their type.
   * Auto-assigns parentId based on position (system knows the chain).
   *
   * - think steps: must have id and content (string)
   * - tool steps: must have id, name (string) and args (object)
   *
   * @param steps Raw steps from LLM
   * @param triggerSignalId The signal that triggered this cognition cycle
   * @returns Validated steps array or null if validation fails
   */
  private validateSteps(steps: unknown[], triggerSignalId: string): Step[] | null {
    const validated: Step[] = [];

    for (const step of steps) {
      if (typeof step !== 'object' || step === null) {
        this.logger.warn({ step }, 'Step is not an object, skipping');
        continue;
      }

      const s = step as Record<string, unknown>;

      // All steps must have id
      if (typeof s['id'] !== 'string') {
        this.logger.warn({ step }, 'Step missing id, skipping');
        continue;
      }

      // Auto-assign parentId: first step → trigger signal, others → previous step
      const lastValidated = validated[validated.length - 1];
      const parentId = lastValidated ? lastValidated.id : triggerSignalId;

      if (s['type'] === 'think') {
        // Think steps must have content (can be empty string)
        if (typeof s['content'] !== 'string') {
          this.logger.warn({ step }, 'Think step missing content, adding empty');
          s['content'] = '';
        }
        validated.push({
          type: 'think',
          id: s['id'],
          parentId,
          content: s['content'] as string,
        });
      } else if (s['type'] === 'tool') {
        // Tool steps must have name and args
        if (typeof s['name'] !== 'string') {
          this.logger.warn({ step }, 'Tool step missing name, will retry with smart model');
          return null; // Critical error - trigger smart retry
        }
        if (typeof s['args'] !== 'object' || s['args'] === null) {
          this.logger.warn({ step }, 'Tool step missing args, defaulting to empty object');
          s['args'] = {};
        }
        validated.push({
          type: 'tool',
          id: s['id'],
          parentId,
          name: s['name'],
          args: s['args'] as Record<string, unknown>,
        });
      } else {
        this.logger.warn({ stepType: s['type'] }, 'Unknown step type, skipping');
        continue;
      }
    }

    return validated;
  }

  /**
   * Execute a tool step.
   *
   * Note: Tool names from the LLM may be sanitized (underscores instead of dots)
   * because some API providers don't accept dots in tool names.
   * We unsanitize before looking up in the registry.
   */
  private async executeTool(step: ToolStep, context: LoopContext): Promise<ToolResult> {
    const toolContext: ToolContext = {
      recipientId: context.recipientId ?? '',
      userId: context.userId,
      correlationId: context.correlationId,
    };

    // Unsanitize tool name: LLM returns "core_memory" but registry has "core.memory"
    const internalToolName = unsanitizeToolName(step.name);

    return this.toolRegistry.execute({
      stepId: step.id,
      name: internalToolName,
      args: step.args,
      context: toolContext,
    });
  }

  /**
   * Check which steps need escalation due to low confidence.
   *
   * With the two-element architecture, policy checks are done in the tools
   * themselves. The tools return errors for policy violations, allowing
   * the LLM to self-correct. Escalation is now triggered by:
   * 1. Low confidence in the terminal "respond"
   * 2. Tool policy violation errors (LLM can retry with corrected args)
   */
  private checkEscalation(_steps: Step[]): Step[] {
    // With tool-based mutations, policy enforcement happens in tools.
    // Tools return errors that the LLM can use to self-correct.
    // Escalation is triggered by low terminal confidence, not step-level checks.
    return [];
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
      case 'core.user': {
        // core.user update → UPDATE_USER_MODEL intent
        if (data['action'] !== 'update') return null;
        return {
          type: 'UPDATE_USER_MODEL',
          payload: {
            recipientId: context.recipientId,
            field: data['field'] as string,
            value: data['value'],
            confidence: data['confidence'] as number,
            source: data['source'] as string,
            evidence: data['evidence'] as string | undefined,
          },
        };
      }

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
            scheduleId: result.stepId,
          },
        };
      }

      case 'core.memory': {
        // core.memory saveFact → SAVE_TO_MEMORY intent
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

      // core.thought is handled separately via thoughtToolResultToIntent
      // because it has complex depth/recursion logic

      default:
        return null;
    }
  }

  /**
   * Compile tool results to intents.
   *
   * With the two-element architecture, all mutations go through tools.
   * This method converts successful tool results into CoreLoop intents.
   */
  private compileIntents(
    _steps: Step[],
    terminal: Terminal,
    context: LoopContext,
    toolResults: ToolResult[]
  ): Intent[] {
    const intents: Intent[] = [];

    // Convert tool results to intents
    for (const result of toolResults) {
      // Handle core.thought specially (complex depth logic)
      if (result.toolName === 'core.thought' && result.success) {
        const thoughtIntent = this.thoughtToolResultToIntent(result, context);
        if (thoughtIntent) {
          intents.push(thoughtIntent);
        }
        continue;
      }

      // Handle all other tools via the typed map
      const toolIntent = this.toolResultToIntent(result, context);
      if (toolIntent) {
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
