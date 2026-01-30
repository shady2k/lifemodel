import type { Logger } from '../../types/index.js';
import type { CircuitBreaker } from '../../core/circuit-breaker.js';
import { createCircuitBreaker } from '../../core/circuit-breaker.js';
import type { CompletionRequest, CompletionResponse } from '../../llm/provider.js';
import { BaseLLMProvider, LLMError } from '../../llm/provider.js';

/**
 * OpenAI-compatible API response types.
 */
interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
      /** For "thinking" models that separate reasoning from final answer */
      reasoning_content?: string;
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI-compatible provider configuration.
 *
 * Works with any server that implements the OpenAI API format:
 * - LM Studio
 * - Ollama (with OpenAI compatibility)
 * - LocalAI
 * - vLLM
 * - text-generation-webui
 * - Any other OpenAI-compatible server
 */
export interface OpenAICompatibleConfig {
  /** Base URL of the server (e.g., http://localhost:1234) */
  baseUrl: string;

  /** Model to use (required for most servers) */
  model: string;

  /** Optional API key (some servers require it) */
  apiKey?: string;

  /** Provider name for logging (default: 'openai-compatible') */
  name?: string;

  /** Request timeout in ms (default: 60000 for local models) */
  timeout?: number;

  /** Max retries for retryable errors (default: 1) */
  maxRetries?: number;

  /** Retry delay in ms (default: 500) */
  retryDelay?: number;

  /** Enable thinking/reasoning mode for models that support it (default: true) */
  enableThinking?: boolean;
}

const DEFAULT_CONFIG = {
  name: 'openai-compatible',
  timeout: 60_000, // Local models can be slower
  maxRetries: 1,
  retryDelay: 500,
  enableThinking: false, // Disabled by default for fast cognition (saves tokens)
};

/**
 * OpenAI-compatible LLM provider.
 *
 * Provides access to any server that implements the OpenAI chat completions API.
 * Includes circuit breaker and retry logic.
 */
export class OpenAICompatibleProvider extends BaseLLMProvider {
  readonly name: string;

  private readonly config: Required<
    Pick<OpenAICompatibleConfig, 'baseUrl' | 'model' | 'timeout' | 'maxRetries' | 'retryDelay'>
  > &
    OpenAICompatibleConfig;
  private readonly providerLogger?: Logger | undefined;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(config: OpenAICompatibleConfig, logger?: Logger) {
    super(logger);
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.name = this.config.name ?? 'openai-compatible';
    this.providerLogger = logger?.child({ component: this.name });

    const circuitConfig: Parameters<typeof createCircuitBreaker>[0] = {
      name: this.name,
      maxFailures: 3,
      resetTimeout: 30_000, // 30 seconds for local
      timeout: this.config.timeout,
    };
    if (this.providerLogger) {
      circuitConfig.logger = this.providerLogger;
    }
    this.circuitBreaker = createCircuitBreaker(circuitConfig);

    this.providerLogger?.info(
      { baseUrl: this.config.baseUrl, model: this.config.model },
      `${this.name} provider initialized`
    );
  }

  /**
   * Check if provider is configured.
   */
  isAvailable(): boolean {
    return Boolean(this.config.baseUrl && this.config.model);
  }

  /**
   * Generate a completion (called by BaseLLMProvider.complete with logging).
   */
  protected async doComplete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.isAvailable()) {
      throw new LLMError(`${this.name} not configured (missing baseUrl or model)`, this.name);
    }

    // Use explicit model from request or configured model
    const model = request.model ?? this.config.model;

    return this.circuitBreaker.execute(async () => {
      return this.executeWithRetry(async () => {
        return this.executeRequest(request, model);
      });
    });
  }

  /**
   * Execute with retry logic.
   */
  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof LLMError && !error.retryable) {
          throw error;
        }

        if (attempt < this.config.maxRetries) {
          this.providerLogger?.warn(
            { attempt: attempt + 1, maxRetries: this.config.maxRetries },
            'Retrying after error'
          );
          await this.sleep(this.config.retryDelay * (attempt + 1));
        }
      }
    }

    throw lastError ?? new Error('Unknown error');
  }

  /**
   * Perform the actual HTTP request to the OpenAI-compatible API.
   */
  private async executeRequest(
    request: CompletionRequest,
    model: string
  ): Promise<CompletionResponse> {
    // Normalize baseUrl (remove trailing slash)
    const baseUrl = this.config.baseUrl.replace(/\/$/, '');
    const url = `${baseUrl}/v1/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add API key if provided
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stop: request.stop,
    };

    // Disable thinking/reasoning mode if configured (LM Studio, etc.)
    if (this.config.enableThinking === false) {
      body['enable_thinking'] = false;
    }

    // Add native tools if provided
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools;
      body['tool_choice'] = request.toolChoice ?? 'auto';
    }

    // Add response_format if specified (for JSON mode)
    if (request.responseFormat) {
      if (request.responseFormat.type === 'json_schema' && request.responseFormat.json_schema) {
        body['response_format'] = {
          type: 'json_schema',
          json_schema: request.responseFormat.json_schema,
        };
      } else {
        body['response_format'] = { type: request.responseFormat.type };
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.config.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        const retryable = response.status >= 500 || response.status === 429;

        throw new LLMError(
          `${this.name} API error: ${String(response.status)} - ${errorText}`,
          this.name,
          {
            statusCode: response.status,
            retryable,
          }
        );
      }

      const data = (await response.json()) as OpenAIResponse;

      const firstChoice = data.choices[0];
      if (!firstChoice) {
        throw new LLMError(`Invalid response from ${this.name}`, this.name);
      }

      // For "thinking" models: if content is empty but reasoning_content exists,
      // use reasoning_content as fallback (the model spent all tokens on reasoning)
      let content = firstChoice.message.content;
      if (!content && firstChoice.message.reasoning_content) {
        this.providerLogger?.warn(
          { finishReason: firstChoice.finish_reason },
          'Using reasoning_content as fallback (content was empty)'
        );
        content = firstChoice.message.reasoning_content;
      }

      const result: CompletionResponse = {
        content,
        model: data.model,
      };

      const finishReason = this.mapFinishReason(firstChoice.finish_reason);
      if (finishReason) {
        result.finishReason = finishReason;
      }

      if (data.usage) {
        result.usage = {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        };
      }

      return result;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof LLMError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new LLMError('Request timed out', this.name, { retryable: true });
      }

      // Connection refused or network error - server might be down
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isConnectionError =
        errorMessage.includes('ECONNREFUSED') || errorMessage.includes('fetch failed');

      throw new LLMError(`Network error: ${errorMessage}`, this.name, {
        retryable: !isConnectionError, // Don't retry if server is down
      });
    }
  }

  /**
   * Map finish reason to our format.
   */
  private mapFinishReason(
    reason: string
  ): 'stop' | 'length' | 'content_filter' | 'error' | undefined {
    switch (reason) {
      case 'stop':
      case 'eos': // Some local models use this
        return 'stop';
      case 'length':
      case 'max_tokens':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return undefined;
    }
  }

  /**
   * Sleep for the specified duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get circuit breaker stats.
   */
  getCircuitStats(): ReturnType<CircuitBreaker['getStats']> {
    return this.circuitBreaker.getStats();
  }
}

/**
 * Factory function.
 */
export function createOpenAICompatibleProvider(
  config: OpenAICompatibleConfig,
  logger?: Logger
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider(config, logger);
}
