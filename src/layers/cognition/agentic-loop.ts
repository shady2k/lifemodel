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
 * 5. If respond/escalate/noAction → compile to intents, return
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
   */
  complete(prompt: string, options?: LLMOptions): Promise<string>;
}

export interface LLMOptions {
  maxTokens?: number;
  temperature?: number;
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

  /** Chat ID (if applicable) */
  chatId?: string | undefined;

  /** User ID (if applicable) */
  userId?: string | undefined;

  /** Time since last message in ms (for proactive contact context) */
  timeSinceLastMessageMs?: number | undefined;
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
}

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
   * Run the agentic loop until completion.
   */
  async run(context: LoopContext): Promise<LoopResult> {
    const state = createLoopState();
    const toolResults: ToolResult[] = [];
    const pendingEscalation: Step[] = [];

    this.logger.debug(
      {
        correlationId: context.correlationId,
        triggerType: context.triggerSignal.type,
      },
      'Agentic loop starting'
    );

    try {
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

        // Call LLM
        state.iteration++;
        const rawOutput = await this.llm.complete(prompt, {
          maxTokens: this.config.maxOutputTokens,
        });

        // Parse output
        const output = this.parseOutput(rawOutput, context.correlationId, context.triggerSignal.id);
        if (!output) {
          state.aborted = true;
          state.abortReason = 'Failed to parse LLM output';
          break;
        }

        // Add steps to state (deduplicate by id to prevent double processing)
        const existingIds = new Set(state.allSteps.map((s) => s.id));
        const newSteps = output.steps.filter((s) => !existingIds.has(s.id));
        state.allSteps.push(...newSteps);

        // Check for steps needing escalation
        const escalationSteps = this.checkEscalation(output.steps);
        pendingEscalation.push(...escalationSteps);

        // Handle terminal state
        if (output.terminal.type === 'needsToolResult') {
          // Execute tools and continue - search ALL steps, not just current iteration
          const needsResultTerminal = output.terminal;
          const toolStep = state.allSteps.find(
            (s): s is ToolStep => s.type === 'tool' && s.id === needsResultTerminal.stepId
          );

          if (toolStep) {
            // Check if tool was already executed
            const existingResult = toolResults.find((r) => r.stepId === toolStep.id);
            if (existingResult) {
              // LLM is stuck - add explicit instruction to respond
              this.logger.debug(
                { stepId: toolStep.id, tool: toolStep.name },
                'Tool already executed, adding explicit instruction'
              );
              state.forceRespond = true;
              continue;
            }

            state.toolCallCount++;
            const result = await this.executeTool(toolStep, context);
            toolResults.push(result);
            state.toolResults.push(result);
          }

          continue;
        }

        // Terminal states: respond, escalate, noAction
        this.logger.debug(
          {
            terminal: output.terminal.type,
            iterations: state.iteration,
            toolCalls: state.toolCallCount,
            steps: state.allSteps.length,
          },
          'Agentic loop completed'
        );

        // Compile intents
        const intents = this.compileIntents(state.allSteps, output.terminal, context);

        return {
          success: true,
          terminal: output.terminal,
          steps: state.allSteps,
          intents,
          pendingEscalation,
          state,
        };
      }

      // Aborted
      this.logger.warn(
        { reason: state.abortReason, iterations: state.iteration },
        'Agentic loop aborted'
      );

      // On timeout or loop, escalate to SMART layer instead of failing silently
      if (context.chatId && (state.abortReason?.includes('Timeout') || state.forceRespond)) {
        this.logger.info(
          { chatId: context.chatId, reason: state.abortReason },
          'COGNITION failed, escalating to SMART layer'
        );
        return {
          success: false,
          terminal: {
            type: 'escalate',
            reason: state.abortReason ?? 'COGNITION timeout/loop',
            parentId: 'loop',
          },
          steps: state.allSteps,
          intents: [],
          pendingEscalation,
          state,
          error: state.abortReason,
        };
      }

      // Create fallback response for parse failures
      const fallbackIntents: Intent[] = [];
      if (context.chatId && state.abortReason?.includes('parse')) {
        this.logger.info(
          { chatId: context.chatId },
          'Sending fallback response due to parse failure'
        );
        fallbackIntents.push({
          type: 'SEND_MESSAGE',
          payload: {
            text: 'Извини, у меня возникли технические проблемы. Можешь повторить?',
            target: context.chatId,
            channel: 'telegram',
          },
        });
      }

      return {
        success: false,
        terminal: { type: 'noAction', reason: state.abortReason ?? 'Aborted', parentId: 'loop' },
        steps: state.allSteps,
        intents: fallbackIntents,
        pendingEscalation,
        state,
        error: state.abortReason,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error({ error: errorMessage }, 'Agentic loop error');

      // Create fallback response if we have a chat to respond to
      const errorFallbackIntents: Intent[] = [];
      if (context.chatId) {
        this.logger.info({ chatId: context.chatId }, 'Sending fallback response due to error');
        errorFallbackIntents.push({
          type: 'SEND_MESSAGE',
          payload: {
            text: 'Извини, что-то пошло не так. Попробуй ещё раз.',
            target: context.chatId,
            channel: 'telegram',
          },
        });
      }

      return {
        success: false,
        terminal: { type: 'noAction', reason: errorMessage, parentId: 'loop' },
        steps: state.allSteps,
        intents: errorFallbackIntents,
        pendingEscalation,
        state,
        error: errorMessage,
      };
    }
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

Capabilities: think → use tools → update beliefs (with evidence) → respond/escalate

Rules:
- Plain text only (no markdown)
- Don't re-greet if already greeted
- User's name: only on first greeting or after long pauses, not every message
- Only promise what your tools can do. Memory ≠ reminders. Check "Available tools" before promising future actions.
- Escalate complex/sensitive topics to SMART`;
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
        const result = toolResults.find((r) => r.stepId === step.id);
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
    { "type": "tool", "id": "tool1", "parentId": "t1", "name": "searchMemory", "args": { "query": "..." } },
    { "type": "updateUser", "id": "u1", "parentId": "t1", "field": "mood", "value": "happy", "confidence": 0.8, "source": "inferred" },
    { "type": "updateAgent", "id": "a1", "parentId": "t1", "field": "socialDebt", "operation": "delta", "value": -0.1, "confidence": 0.9, "reason": "had conversation" },
    { "type": "saveFact", "id": "f1", "parentId": "t1", "fact": { "subject": "user", "predicate": "name", "object": "Shady", "source": "user_quote", "evidence": "said 'I'm Shady'", "confidence": 0.95, "tags": ["identity"] } },
    { "type": "schedule", "id": "s1", "parentId": "t1", "delayMs": 3600000, "event": { "type": "followUp", "context": { "topic": "interview" } } },
    { "type": "emitThought", "id": "th1", "parentId": "t1", "content": "User mentioned being stressed - follow up later" }
  ],
  "terminal": { "type": "respond", "text": "Hello!", "parentId": "t1" }
  // OR: { "type": "needsToolResult", "stepId": "tool1" }
  // OR: { "type": "escalate", "reason": "complex question", "parentId": "t1" }
  // OR: { "type": "noAction", "reason": "nothing to do", "parentId": "t1" }
  // OR: { "type": "defer", "signalType": "contact_urge", "reason": "User seems busy", "deferHours": 4, "parentId": "t1" }
}

Terminal types:
- "respond": Send a message to user
- "noAction": Do nothing (for non-proactive triggers)
- "defer": Don't act now, reconsider in deferHours - works for any signal type
- "escalate": Need deeper reasoning from SMART layer
- "needsToolResult": Waiting for tool to complete

Step type "emitThought": Queue an internal thought for later processing.
- Use ONLY when a concrete future action is needed (not just "monitor" or "watch for")
- When processing a thought trigger and choosing noAction, do NOT emit another thought - end the chain
- Prefer ACTION over more thinking - if no action needed, just stop

Available tools: ${this.toolRegistry.getToolNames().join(', ') || '(none)'}`;
  }

  /**
   * Parse LLM output to CognitionOutput.
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
      chatId: context.chatId,
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
   * Compile steps to intents.
   */
  private compileIntents(steps: Step[], terminal: Terminal, context: LoopContext): Intent[] {
    const intents: Intent[] = [];

    for (const step of steps) {
      const intent = this.stepToIntent(step, context);
      if (intent) {
        intents.push(intent);
      }
    }

    // Add response intent if terminal is respond
    if (terminal.type === 'respond' && context.chatId) {
      intents.push({
        type: 'SEND_MESSAGE',
        payload: {
          text: terminal.text,
          target: context.chatId,
          channel: 'telegram', // TODO: get from context
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
              chatId: context.chatId,
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
            chatId: context.chatId,
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

      case 'emitThought': {
        const dedupeKey = step.content.toLowerCase().slice(0, 50).replace(/\s+/g, ' ');

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
            this.logger.warn('Thought signal missing ThoughtData, rejecting emitThought');
            return null;
          }
        } else {
          // Not triggered by thought - this is a root thought from conversation/other
          // LLM-provided parentThought is ignored for security
          depth = 0;
          rootId = `thought_${step.id}`;
          parentId = undefined;
          triggerSource = context.triggerSignal.type === 'user_message' ? 'conversation' : 'memory';
        }

        // Validate depth limit
        if (depth > THOUGHT_LIMITS.MAX_DEPTH) {
          this.logger.warn(
            { depth, content: step.content.slice(0, 30) },
            'Thought rejected: max depth exceeded'
          );
          return null;
        }

        return {
          type: 'EMIT_THOUGHT',
          payload: {
            content: step.content,
            triggerSource,
            depth,
            rootThoughtId: rootId,
            dedupeKey,
            signalSource: 'cognition.thought',
            ...(parentId !== undefined && { parentThoughtId: parentId }),
          },
        };
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
