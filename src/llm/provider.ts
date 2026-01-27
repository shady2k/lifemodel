/**
 * LLM Provider interface.
 *
 * Abstracts different LLM backends (OpenRouter, local models, etc.)
 * so the agent can use any provider.
 */

/**
 * Message in a conversation.
 */
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Model role for selecting appropriate model tier.
 */
export type ModelRole = 'fast' | 'smart';

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
}

/**
 * Response from a completion request.
 */
export interface CompletionResponse {
  /** Generated text */
  content: string;

  /** Model that was used */
  model: string;

  /** Token usage */
  usage?:
    | {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      }
    | undefined;

  /** Finish reason */
  finishReason?: 'stop' | 'length' | 'content_filter' | 'error' | undefined;
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
