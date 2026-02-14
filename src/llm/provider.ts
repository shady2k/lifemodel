/**
 * LLM Provider interface.
 *
 * Abstracts different LLM backends (OpenRouter, local models, etc.)
 * so the agent can use any provider.
 */

import type { OpenAIChatTool, MinimalOpenAIChatTool } from './tool-schema.js';
import { logConversation } from '../core/logger.js';

/**
 * Tool call from the model (OpenAI Chat Completions format).
 * Used when the model wants to call a function.
 */
export interface ToolCall {
  /** Unique ID for this tool call (links to tool result) */
  id: string;
  /** Always 'function' for function tools */
  type: 'function';
  /** Function details */
  function: {
    /** Tool/function name */
    name: string;
    /** JSON-encoded arguments string */
    arguments: string;
  };
}

/**
 * Message in a conversation.
 * Extended to support tool calling flow.
 */
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Message content - can be null for assistant messages with only tool_calls */
  content: string | null;
  /** Tool calls made by assistant (only for role: 'assistant') */
  tool_calls?: ToolCall[];
  /** Tool call ID this message is responding to (only for role: 'tool') */
  tool_call_id?: string;
  /** Tool name for tool results (fallback when tool_calls are trimmed) */
  tool_name?: string;
}

/**
 * Model role for selecting appropriate model tier.
 */
export type ModelRole = 'fast' | 'smart' | 'motor';

/**
 * JSON Schema definition for structured output.
 */
export interface JsonSchemaDefinition {
  name: string;
  strict?: boolean;
  schema: Record<string, unknown>;
}

/**
 * Response format for structured output.
 * - 'json_object': OpenAI-style JSON mode (simple)
 * - 'json_schema': LM Studio / structured output with schema
 * - 'text': Plain text (default)
 */
export interface ResponseFormat {
  type: 'json_object' | 'json_schema' | 'text';
  json_schema?: JsonSchemaDefinition;
}

/**
 * OpenAI Chat Completions tool format.
 * Re-exported from tool-schema.ts for convenience.
 */
export type { OpenAIChatTool };

/**
 * Tool choice for controlling tool calling behavior.
 * - 'auto': Model decides whether to call tools
 * - 'none': Model won't call any tools
 * - 'required': Model must call at least one tool
 * - { type: 'function', function: { name } }: Force a specific tool
 */
export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

/**
 * Request to generate a completion.
 */
export interface CompletionRequest {
  /** Conversation messages */
  messages: Message[];

  /** Model role: 'fast' for classification, 'smart' for reasoning */
  role?: ModelRole;

  /** Explicit model to use (overrides role) */
  model?: string;

  /** Maximum tokens to generate */
  maxTokens?: number;

  /** Temperature (0-2, lower = more focused) */
  temperature?: number;

  /** Stop sequences */
  stop?: string[];

  /** Response format (e.g., { type: 'json_object' } for JSON output) */
  responseFormat?: ResponseFormat;

  /** Tools available for the model to call (native tool calling) */
  tools?: (OpenAIChatTool | MinimalOpenAIChatTool)[];

  /** Tool choice mode: 'auto', 'none', 'required', or specific tool */
  toolChoice?: ToolChoice;

  /** Whether to allow parallel tool calls (default: true, set false for strict mode) */
  parallelToolCalls?: boolean;

  /** Per-request timeout override in ms (provider uses its default if omitted) */
  timeoutMs?: number;
}

/**
 * Response from a completion request.
 */
export interface CompletionResponse {
  /** Generated text - can be null when model only returns tool_calls */
  content: string | null;

  /** Model that was used */
  model: string;

  /** Provider generation ID (e.g. OpenRouter "gen-..." for dashboard tracing) */
  generationId?: string | undefined;

  /** Tool calls requested by the model (native tool calling) */
  toolCalls?: ToolCall[];

  /** Token usage */
  usage?:
    | {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        reasoningTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      }
    | undefined;

  /** Reasoning/thinking text from models that expose chain-of-thought */
  reasoningContent?: string | undefined;

  /** Finish reason */
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | undefined;

  /** Raw finish reason from provider (e.g., AI SDK 6's rawFinishReason) */
  rawFinishReason?: string | undefined;
}

/**
 * LLM Provider interface.
 */
export interface LLMProvider {
  /** Provider name (for logging) */
  readonly name: string;

  /** Check if provider is available/configured */
  isAvailable(): boolean;

  /** Generate a completion */
  complete(request: CompletionRequest): Promise<CompletionResponse>;

  /** Get available models (optional) */
  getModels?(): Promise<string[]>;
}

/**
 * Error from LLM provider.
 */
export class LLMError extends Error {
  readonly provider: string;
  readonly statusCode?: number | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    provider: string,
    options?: { statusCode?: number; retryable?: boolean }
  ) {
    super(message);
    this.name = 'LLMError';
    this.provider = provider;
    this.statusCode = options?.statusCode;
    this.retryable = options?.retryable ?? false;
  }
}

/**
 * Logger interface for LLM providers.
 */
export interface LLMLogger {
  trace(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  child(bindings: Record<string, unknown>): LLMLogger;
}

/**
 * Base LLM provider with detailed logging.
 *
 * Provides logging wrapper around complete() calls.
 * Subclasses implement doComplete() for actual API calls.
 */
export abstract class BaseLLMProvider implements LLMProvider {
  abstract readonly name: string;
  protected readonly logger?: LLMLogger | undefined;
  private requestCounter = 0;
  /** Tracks how many messages have been logged to avoid repetition (delta logging) */
  private lastLoggedMessageCount = 0;

  constructor(logger?: LLMLogger) {
    this.logger = logger?.child({ component: 'llm' });
  }

  abstract isAvailable(): boolean;

  /**
   * Generate a completion with detailed logging.
   */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const requestId = `req_${String(++this.requestCounter)}`;
    const startTime = Date.now();

    // Log request start (summary at debug, full details at trace)
    this.logger?.debug(
      {
        requestId,
        provider: this.name,
        role: request.role,
        model: request.model,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        messageCount: request.messages.length,
        toolCount: request.tools?.length ?? 0,
        toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
      },
      '🤖 LLM request started'
    );

    // Log full tool schemas at trace level (very verbose - typically 20+ tools)
    if (request.tools && request.tools.length > 0) {
      this.logger?.trace({ requestId, tools: request.tools }, '🤖 LLM request tools');
    }

    // Log new messages: non-tool messages at debug, tool messages at trace
    if (this.logger) {
      const debugStart = this.lastLoggedMessageCount;
      const newCount = request.messages.length - debugStart;
      if (debugStart > 0 || newCount > 0) {
        this.logger.debug(
          { requestId, skipped: debugStart, newMessages: newCount },
          `🤖 LLM messages: ${String(debugStart)} history, ${String(newCount)} new`
        );
      }
      for (let i = debugStart; i < request.messages.length; i++) {
        const msg = request.messages[i];
        if (!msg) continue;
        const isToolMsg = msg.role === 'tool' || (msg.tool_calls?.length ?? 0) > 0;
        const logFn = isToolMsg
          ? this.logger.trace.bind(this.logger)
          : this.logger.debug.bind(this.logger);
        logFn(
          {
            requestId,
            index: i,
            role: msg.role,
            contentLength: msg.content?.length ?? 0,
            contentPreview: msg.content?.slice(0, 200) ?? null,
            hasToolCalls: (msg.tool_calls?.length ?? 0) > 0,
            toolCallId: msg.tool_call_id,
          },
          `🤖 LLM message [${String(i)}] ${msg.role}`
        );
      }
    }

    // Log to conversation file (delta logging - only new messages since last request)
    const totalMessages = request.messages.length;

    // Detect new tick: if the message array shrunk, it was rebuilt from scratch
    // (new tick with fresh system prompt + history). Reset delta to log everything.
    if (totalMessages < this.lastLoggedMessageCount) {
      this.lastLoggedMessageCount = 0;
    }

    const newMessageStart = this.lastLoggedMessageCount;

    // Build the entire request block as a single string, then log once.
    // This avoids repeating the pino prefix ([timestamp] [traceId]) on every message.
    const NEW = '► ';
    const INDENT = '  ';
    const lines: string[] = [];

    // Request header
    lines.push(`\n${'═'.repeat(60)}`);
    lines.push(
      `→ REQUEST [${requestId}] to ${this.name} (${request.model ?? request.role ?? 'unknown'})`
    );
    lines.push('─'.repeat(60));

    // Show context summary if there are previously logged messages
    if (newMessageStart > 0) {
      lines.push(`[...${String(newMessageStart)} messages from history — see earlier in log...]`);
    }

    // Only log NEW messages (delta logging eliminates massive repetition)
    for (let i = newMessageStart; i < totalMessages; i++) {
      const msg = request.messages[i];
      if (!msg) continue;
      const idx = String(i);
      const role = msg.role.toUpperCase();
      const content = msg.content ?? '(no content)';

      if (msg.role === 'tool') {
        // Tool result - pretty-print JSON if possible
        let formattedContent = content;
        try {
          const parsed: unknown = JSON.parse(content);
          formattedContent = JSON.stringify(parsed, null, 2)
            .split('\n')
            .join('\n' + INDENT);
        } catch {
          // Not JSON, use as-is
        }
        lines.push(
          `${NEW}[${idx}] TOOL RESULT (${msg.tool_call_id ?? 'unknown'}):\n${INDENT}${formattedContent}`
        );
      } else if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant with tool calls - pretty-print arguments
        const toolDetails = msg.tool_calls
          .map((tc) => {
            let args = tc.function.arguments;
            try {
              const parsed: unknown = JSON.parse(args);
              args = JSON.stringify(parsed, null, 2)
                .split('\n')
                .join('\n' + INDENT + INDENT);
            } catch {
              // Not JSON, use as-is
            }
            return `${INDENT}📞 ${tc.function.name}(${tc.id}):\n${INDENT}${INDENT}${args}`;
          })
          .join('\n');
        const indentedContent = content === '(no content)' ? '' : `\n${INDENT}${content}`;
        lines.push(
          `${NEW}[${idx}] ${role}:${indentedContent}\n${INDENT}Tool calls:\n${toolDetails}`
        );
      } else {
        // Regular message — extract <msg_time> into header for compact log output
        const timeMatch = /^<msg_time>(.*?)<\/msg_time>\n?/.exec(content);
        const timeLabel = timeMatch?.[1] ? ` (${timeMatch[1]})` : '';
        const cleanContent = timeMatch ? content.slice(timeMatch[0].length) : content;
        const indentedContent = cleanContent.split('\n').join('\n' + INDENT);
        lines.push(`${NEW}[${idx}] ${role}${timeLabel}:\n${INDENT}${indentedContent}`);
      }
    }

    logConversation(
      { logType: 'REQUEST', requestId, provider: this.name, model: request.model },
      lines.join('\n')
    );

    // Update the count for next request
    this.lastLoggedMessageCount = totalMessages;

    try {
      const response = await this.doComplete(request);
      const duration = Date.now() - startTime;

      // Log response with full content at debug level
      this.logger?.debug(
        {
          requestId,
          provider: this.name,
          model: response.model,
          generationId: response.generationId,
          durationMs: duration,
          finishReason: response.finishReason,
          promptTokens: response.usage?.promptTokens,
          completionTokens: response.usage?.completionTokens,
          reasoningTokens: response.usage?.reasoningTokens,
          totalTokens: response.usage?.totalTokens,
          responseLength: response.content?.length ?? 0,
          response: response.content,
          toolCalls: response.toolCalls,
        },
        '🤖 LLM response received'
      );

      // Log full response to conversation file (no truncation for debugging)
      // Format response: extract "response" field if JSON, otherwise pretty-print or show as-is
      let responseContent = response.content ?? '(no content)';
      try {
        const parsed = JSON.parse(responseContent) as Record<string, unknown>;
        if (typeof parsed['response'] === 'string') {
          // Extract the actual message from {"response": "..."} wrapper
          responseContent = parsed['response'];
        } else {
          // Other JSON - pretty-print it
          responseContent = JSON.stringify(parsed, null, 2);
        }
      } catch {
        // Not JSON, use as-is
      }
      const toolCallsDetail = response.toolCalls
        ? `\n\n  Tool calls:\n${response.toolCalls
            .map((tc) => {
              let args = tc.function.arguments;
              try {
                const parsed: unknown = JSON.parse(args);
                args = JSON.stringify(parsed, null, 2).split('\n').join('\n       ');
              } catch {
                // Not JSON, use as-is
              }
              return `  📞 ${tc.function.name}(${tc.id}):\n       ${args}`;
            })
            .join('\n')}`
        : '';
      const durationStr = String(duration);
      const tokensStr = String(response.usage?.totalTokens ?? '?');
      const reasoningStr = response.usage?.reasoningTokens
        ? `, ${String(response.usage.reasoningTokens)} reasoning`
        : '';
      const finishStr = response.finishReason ?? 'unknown';
      // Only log reasoning if it's not the AI SDK's redacted placeholder
      const reasoningDetail =
        response.reasoningContent && response.reasoningContent !== '[REDACTED]'
          ? `\n\n  💭 Reasoning:\n${response.reasoningContent}`
          : response.reasoningContent === '[REDACTED]'
            ? '\n\n  💭 Reasoning: [Not available for this model]'
            : '';
      logConversation(
        {
          logType: 'RESPONSE',
          requestId,
          model: response.model,
          finishReason: response.finishReason,
          durationMs: duration,
          tokens: response.usage?.totalTokens,
          reasoningTokens: response.usage?.reasoningTokens,
        },
        `${'─'.repeat(60)}\n← RESPONSE [${durationStr}ms, ${tokensStr} tokens${reasoningStr}, ${finishStr}]${response.generationId ? ` gen:${response.generationId}` : ''}\n${responseContent}${toolCallsDetail}${reasoningDetail}\n${'═'.repeat(60)}`
      );

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;

      this.logger?.error(
        {
          requestId,
          provider: this.name,
          durationMs: duration,
          error: error instanceof Error ? error.message : String(error),
          errorType: error instanceof LLMError ? 'LLMError' : 'Error',
          retryable: error instanceof LLMError ? error.retryable : false,
        },
        '🤖 LLM request failed'
      );

      // Log error to conversation file
      const errorDurationStr = String(duration);
      const errorMsg = error instanceof Error ? error.message : String(error);
      logConversation(
        {
          logType: 'ERROR',
          requestId,
          error: errorMsg,
          durationMs: duration,
        },
        `${'─'.repeat(60)}\n✗ ERROR [${errorDurationStr}ms]: ${errorMsg}\n${'═'.repeat(60)}`
      );

      throw error;
    }
  }

  /**
   * Perform the actual completion request.
   * Subclasses implement this method.
   */
  protected abstract doComplete(request: CompletionRequest): Promise<CompletionResponse>;
}
