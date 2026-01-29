/**
 * LLM Port - Hexagonal Architecture
 *
 * Defines interfaces for LLM (Large Language Model) providers.
 * LLM adapters implement this port to provide different backends
 * (OpenAI, OpenRouter, local models, etc.).
 *
 * Key features:
 * - Role-based model selection (fast vs smart)
 * - Structured output support (JSON schemas)
 * - Tool calling support
 * - Embedding support (for vector search)
 */

/**
 * Message in a conversation.
 */
export interface LLMMessage {
  /** Message role */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Message content */
  content: string;
  /** Tool call ID (for tool responses) */
  toolCallId?: string;
  /** Tool calls made by assistant */
  toolCalls?: LLMToolCall[];
}

/**
 * Tool call made by the model.
 */
export interface LLMToolCall {
  /** Unique call ID */
  id: string;
  /** Tool name */
  name: string;
  /** Tool arguments (JSON string) */
  arguments: string;
}

/**
 * Tool definition for the model.
 */
export interface LLMTool {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** JSON schema for parameters */
  parameters: Record<string, unknown>;
}

/**
 * Model role for selecting appropriate model tier.
 * - 'fast': Quick classification, simple decisions (cheaper)
 * - 'smart': Complex reasoning, multi-step tasks (expensive)
 */
export type LLMModelRole = 'fast' | 'smart';

/**
 * JSON Schema definition for structured output.
 */
export interface LLMJsonSchema {
  /** Schema name */
  name: string;
  /** Whether to enforce strict schema adherence */
  strict?: boolean;
  /** The JSON schema definition */
  schema: Record<string, unknown>;
}

/**
 * Response format specification.
 */
export interface LLMResponseFormat {
  /** Output type */
  type: 'text' | 'json_object' | 'json_schema';
  /** Schema for structured JSON output */
  jsonSchema?: LLMJsonSchema;
}

/**
 * Request to generate a completion.
 */
export interface LLMCompletionRequest {
  /** Conversation messages */
  messages: LLMMessage[];
  /** Model role: 'fast' or 'smart' */
  role?: LLMModelRole;
  /** Explicit model to use (overrides role) */
  model?: string;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Temperature (0-2, lower = more focused) */
  temperature?: number;
  /** Stop sequences */
  stop?: string[];
  /** Response format */
  responseFormat?: LLMResponseFormat;
  /** Available tools */
  tools?: LLMTool[];
  /** Tool choice strategy */
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
}

/**
 * Token usage information.
 */
export interface LLMTokenUsage {
  /** Tokens in the prompt */
  promptTokens: number;
  /** Tokens in the completion */
  completionTokens: number;
  /** Total tokens */
  totalTokens: number;
}

/**
 * Response from a completion request.
 */
export interface LLMCompletionResponse {
  /** Generated text content */
  content: string;
  /** Model that was used */
  model: string;
  /** Token usage */
  usage?: LLMTokenUsage;
  /** Finish reason */
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  /** Tool calls (if any) */
  toolCalls?: LLMToolCall[];
}

/**
 * ILLM - Primary LLM port.
 */
export interface ILLM {
  /** Provider name (for logging/debugging) */
  readonly name: string;

  /**
   * Check if provider is available and configured.
   */
  isAvailable(): boolean;

  /**
   * Generate a completion.
   */
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResponse>;

  /**
   * Get available models (optional).
   */
  getModels?(): Promise<string[]>;

  /**
   * Get current rate limit status (optional).
   */
  getRateLimitStatus?(): { remaining: number; resetAt: Date } | null;
}

/**
 * Embedding request.
 */
export interface EmbeddingRequest {
  /** Text to embed */
  text: string | string[];
  /** Model to use (optional) */
  model?: string;
}

/**
 * Embedding response.
 */
export interface EmbeddingResponse {
  /** Embedding vectors */
  embeddings: number[][];
  /** Model used */
  model: string;
  /** Token usage */
  usage?: { totalTokens: number };
}

/**
 * IEmbedding - Port for text embeddings (vector search).
 */
export interface IEmbedding {
  /** Provider name */
  readonly name: string;

  /**
   * Check if provider is available.
   */
  isAvailable(): boolean;

  /**
   * Generate embeddings for text.
   */
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;

  /**
   * Get embedding dimension.
   */
  getDimension(): number;
}

/**
 * LLM error with provider context.
 */
export class LLMPortError extends Error {
  readonly provider: string;
  readonly statusCode: number | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    provider: string,
    options?: { statusCode?: number; retryable?: boolean }
  ) {
    super(message);
    this.name = 'LLMPortError';
    this.provider = provider;
    this.statusCode = options?.statusCode;
    this.retryable = options?.retryable ?? false;
  }
}
