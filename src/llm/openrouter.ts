import type { Logger } from '../types/index.js';
import type { CircuitBreaker } from '../core/circuit-breaker.js';
import { createCircuitBreaker } from '../core/circuit-breaker.js';
import type { LLMProvider, CompletionRequest, CompletionResponse } from './provider.js';
import { LLMError } from './provider.js';

/**
 * OpenRouter API response types.
 */
interface OpenRouterResponse {
  id: string;
  model: string;
  choices: {
    message: {
      role: string;
      content: string;
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
 * OpenRouter provider configuration.
 */
export interface OpenRouterConfig {
  /** API key (required) */
  apiKey: string;

  /** Default model to use */
  defaultModel?: string;

  /** Base URL (default: https://openrouter.ai/api/v1) */
  baseUrl?: string;

  /** Request timeout in ms (default: 30000) */
  timeout?: number;

  /** Max retries for retryable errors (default: 2) */
  maxRetries?: number;

  /** Retry delay in ms (default: 1000) */
  retryDelay?: number;

  /** Site URL for OpenRouter ranking */
  siteUrl?: string;

  /** Site name for OpenRouter ranking */
  siteName?: string;
}

const DEFAULT_CONFIG = {
  defaultModel: 'anthropic/claude-3.5-haiku',
  baseUrl: 'https://openrouter.ai/api/v1',
  timeout: 30_000,
  maxRetries: 2,
  retryDelay: 1000,
};

/**
 * OpenRouter LLM provider.
 *
 * Provides access to multiple models via OpenRouter API.
 * Includes circuit breaker and retry logic.
 */
export class OpenRouterProvider implements LLMProvider {
  readonly name = 'openrouter';

  private readonly config: Required<
    Pick<OpenRouterConfig, 'defaultModel' | 'baseUrl' | 'timeout' | 'maxRetries' | 'retryDelay'>
  > &
    OpenRouterConfig;
  private readonly logger?: Logger | undefined;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(config: OpenRouterConfig, logger?: Logger) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger?.child({ component: 'openrouter' });

    const circuitConfig: Parameters<typeof createCircuitBreaker>[0] = {
      name: 'openrouter',
      maxFailures: 3,
      resetTimeout: 60_000, // 1 minute
      timeout: this.config.timeout,
    };
    if (this.logger) {
      circuitConfig.logger = this.logger;
    }
    this.circuitBreaker = createCircuitBreaker(circuitConfig);
  }

  /**
   * Check if provider is configured.
   */
  isAvailable(): boolean {
    return Boolean(this.config.apiKey);
  }

  /**
   * Generate a completion.
   */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.isAvailable()) {
      throw new LLMError('OpenRouter API key not configured', this.name);
    }

    const model = request.model ?? this.config.defaultModel;

    return this.circuitBreaker.execute(async () => {
      return this.executeWithRetry(async () => {
        return this.doComplete(request, model);
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
          this.logger?.warn(
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
   * Perform the actual completion request.
   */
  private async doComplete(request: CompletionRequest, model: string): Promise<CompletionResponse> {
    const url = `${this.config.baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };

    if (this.config.siteUrl) {
      headers['HTTP-Referer'] = this.config.siteUrl;
    }
    if (this.config.siteName) {
      headers['X-Title'] = this.config.siteName;
    }

    const body = {
      model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stop: request.stop,
    };

    this.logger?.debug(
      { model, messageCount: request.messages.length },
      'Sending completion request'
    );

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
          `OpenRouter API error: ${String(response.status)} - ${errorText}`,
          this.name,
          {
            statusCode: response.status,
            retryable,
          }
        );
      }

      const data = (await response.json()) as OpenRouterResponse;

      const firstChoice = data.choices[0];
      if (!firstChoice) {
        throw new LLMError('Invalid response from OpenRouter', this.name);
      }

      const result: CompletionResponse = {
        content: firstChoice.message.content,
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

      this.logger?.debug(
        {
          model: result.model,
          tokens: result.usage?.totalTokens,
          finishReason: result.finishReason,
        },
        'Completion received'
      );

      return result;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof LLMError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new LLMError('Request timed out', this.name, { retryable: true });
      }

      throw new LLMError(
        `Network error: ${error instanceof Error ? error.message : String(error)}`,
        this.name,
        { retryable: true }
      );
    }
  }

  /**
   * Map OpenRouter finish reason to our format.
   */
  private mapFinishReason(
    reason: string
  ): 'stop' | 'length' | 'content_filter' | 'error' | undefined {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
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
export function createOpenRouterProvider(
  config: OpenRouterConfig,
  logger?: Logger
): OpenRouterProvider {
  return new OpenRouterProvider(config, logger);
}
