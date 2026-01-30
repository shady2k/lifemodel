/**
 * LLM Provider interface.
 *
 * Abstracts different LLM backends (OpenRouter, local models, etc.)
 * so the agent can use any provider.
 */

import type { OpenAIChatTool, MinimalOpenAIChatTool } from './tool-schema.js';

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
}

/**
 * Model role for selecting appropriate model tier.
 */
export type ModelRole = 'fast' | 'smart';

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
}

/**
 * Response from a completion request.
 */
export interface CompletionResponse {
  /** Generated text - can be null when model only returns tool_calls */
  content: string | null;

  /** Model that was used */
  model: string;

  /** Tool calls requested by the model (native tool calling) */
  toolCalls?: ToolCall[];

  /** Token usage */
  usage?:
    | {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      }
    | undefined;

  /** Finish reason */
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | undefined;
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

    // Log request start with full details
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
        tools: request.tools, // Full tool schemas for debugging
      },
      '🤖 LLM request started'
    );

    // Log each message for debugging (full content for debugging)
    if (this.logger) {
      for (const [i, msg] of request.messages.entries()) {
        this.logger.debug(
          {
            requestId,
            index: i,
            role: msg.role,
            contentLength: msg.content?.length ?? 0,
            content: msg.content,
            toolCalls: msg.tool_calls,
            toolCallId: msg.tool_call_id,
          },
          `🤖 LLM message [${String(i)}] ${msg.role}`
        );
      }
    }

    try {
      const response = await this.doComplete(request);
      const duration = Date.now() - startTime;

      // Log response (full content for debugging)
      this.logger?.debug(
        {
          requestId,
          provider: this.name,
          model: response.model,
          durationMs: duration,
          finishReason: response.finishReason,
          promptTokens: response.usage?.promptTokens,
          completionTokens: response.usage?.completionTokens,
          totalTokens: response.usage?.totalTokens,
          responseLength: response.content?.length ?? 0,
          response: response.content,
          toolCalls: response.toolCalls,
        },
        '🤖 LLM response received'
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

      throw error;
    }
  }

  /**
   * Perform the actual completion request.
   * Subclasses implement this method.
   */
  protected abstract doComplete(request: CompletionRequest): Promise<CompletionResponse>;
}
