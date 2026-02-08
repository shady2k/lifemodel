/**
 * Agentic Loop Types
 *
 * All shared interfaces/types for the agentic loop.
 * No runtime dependencies — safe to import from any module.
 */

import type { Intent } from '../../types/intent.js';
import type { Signal } from '../../types/signal.js';
import type { AgentState } from '../../types/agent/state.js';
import type { FullSoulState } from '../../storage/soul-provider.js';
import type { ToolResult, LoopState, Terminal, ExecutedTool } from '../../types/cognition.js';
import type { CompletedAction } from '../../storage/conversation-manager.js';
import type { MemoryEntry } from './tools/registry.js';
import type { OpenAIChatTool, MinimalOpenAIChatTool } from '../../llm/tool-schema.js';
import type { Message, ToolCall, ToolChoice, ResponseFormat } from '../../llm/provider.js';

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

  /** Response format (JSON mode for structured output when toolChoice is 'none') */
  responseFormat?: ResponseFormat;
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
  /** Fast model's response text (if any) - shown to smart model to avoid regenerating */
  responseText?: string;
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

  /** Completed actions from previous sessions (to prevent re-execution) */
  completedActions?: CompletedAction[] | undefined;

  /** Recent thoughts for context priming (internal context) */
  recentThoughts?: MemoryEntry[] | undefined;

  /** Pending intentions (insights from thought processing to weave into conversation) */
  pendingIntentions?: MemoryEntry[] | undefined;

  /** Soul state for identity awareness (who I am, what I care about) */
  soulState?: FullSoulState | undefined;

  /** Behavioral rules learned from user feedback (for prompt injection) */
  behaviorRules?: MemoryEntry[] | undefined;

  /** Current conversation status (for thought processing context) */
  conversationStatus?: string | undefined;

  /** Callback to drain pending user messages for mid-loop injection */
  drainPendingUserMessages: (() => Signal[]) | undefined;
}

/**
 * Tool call in conversation history (mirrors OpenAI format).
 */
export interface ConversationToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Conversation message supporting full OpenAI format.
 */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string | null;
  timestamp?: Date | undefined;
  /** Tool calls made by assistant (only for role: 'assistant') */
  tool_calls?: ConversationToolCall[];
  /** Tool call ID this message is responding to (only for role: 'tool') */
  tool_call_id?: string;
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

/**
 * Callbacks for immediate intent processing during loop execution.
 * Some intents (REMEMBER, SET_INTEREST) should be applied immediately
 * so subsequent tool calls in the same loop can see the data.
 */
export interface LoopCallbacks {
  /**
   * Called when an intent should be applied immediately during loop execution.
   * Used for REMEMBER and SET_INTEREST so data is visible to subsequent tools.
   */
  onImmediateIntent?: (intent: Intent) => void;

  /**
   * Called when a side-effect plugin tool completes successfully.
   * Records the action so the LLM won't re-execute it in subsequent sessions.
   */
  onCompletedAction?: (recipientId: string, tool: string, summary: string) => void;
}

/**
 * Prompt builders interface for dependency inversion.
 * Used by history-builder to avoid depending on prompts/ directly.
 */
export interface PromptBuilders {
  buildSystemPrompt(context: LoopContext, useSmart: boolean): string;
  buildTriggerPrompt(context: LoopContext, useSmart: boolean): string;
}

/**
 * Discriminated union for tool executor return type.
 * Preserves loop control flow without the tool executor knowing about the loop.
 */
export type ToolExecutionOutcome =
  | { type: 'continue'; messages: Message[] }
  | { type: 'escalate'; enrichedContext: LoopContext }
  | { type: 'defer'; result: LoopResult };
