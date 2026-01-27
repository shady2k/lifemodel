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

    // Log request start
    this.logger?.debug(
      {
        requestId,
        provider: this.name,
        role: request.role,
        model: request.model,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
        messageCount: request.messages.length,
      },
      '🤖 LLM request started'
    );

    // Log each message for debugging
    if (this.logger) {
      for (const [i, msg] of request.messages.entries()) {
        const contentPreview =
          msg.content.length > 500 ? `${msg.content.slice(0, 500)}...` : msg.content;
        this.logger.debug(
          {
            requestId,
            index: i,
            role: msg.role,
            contentLength: msg.content.length,
            content: contentPreview,
          },
          `🤖 LLM message [${String(i)}] ${msg.role}`
        );
      }
    }

    try {
      const response = await this.doComplete(request);
      const duration = Date.now() - startTime;

      // Log response
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
          responseLength: response.content.length,
          responsePreview:
            response.content.length > 200
              ? `${response.content.slice(0, 200)}...`
              : response.content,
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
