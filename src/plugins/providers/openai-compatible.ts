import type { Logger } from '../../types/index.js';
import type { CircuitBreaker } from '../../core/circuit-breaker.js';
import { createCircuitBreaker } from '../../core/circuit-breaker.js';
import type { CompletionRequest, CompletionResponse, ToolCall } from '../../llm/provider.js';
import { BaseLLMProvider, LLMError } from '../../llm/provider.js';

/**
 * OpenAI-compatible API response types.
 */
interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIResponse {
  id: string;
  object?: string;
  created?: number;
  model: string;
  choices: {
    index?: number;
    message: {
      role: string;
      content: string | null;
      /** For "thinking" models that separate reasoning from final answer */
      reasoning_content?: string;
      /** Tool calls requested by the model */
      tool_calls?: OpenAIToolCall[];
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
 * Base configuration for any server that implements the OpenAI API format:
 * - OpenRouter
 * - LM Studio
 * - Ollama (with OpenAI compatibility)
 * - LocalAI
 * - vLLM
 * - text-generation-webui
 * - Any other OpenAI-compatible server
 */
export interface OpenAICompatibleConfig {
  /** Base URL of the server (e.g., http://localhost:1234 or https://openrouter.ai/api) */
  baseUrl: string;

  /** Default model to use when role not specified */
  defaultModel: string;

  /** Fast model for classification, yes/no, emotion detection (cheap) */
  fastModel?: string;

  /** Smart model for composition, reasoning (expensive) */
  smartModel?: string;

  /** Optional API key */
  apiKey?: string;

  /** Provider name for logging (default: 'openai-compatible') */
  name?: string;

  /** Request timeout in ms (default: 60000) */
  timeout?: number;

  /** Max retries for retryable errors (default: 2) */
  maxRetries?: number;

  /** Retry delay in ms (default: 1000) */
  retryDelay?: number;

  /** Circuit breaker reset timeout in ms (default: 60000) */
  circuitResetTimeout?: number;

  /** Enable thinking/reasoning mode for models that support it (default: false) */
  enableThinking?: boolean;
}

const DEFAULT_CONFIG = {
  name: 'openai-compatible',
  timeout: 60_000,
  maxRetries: 2,
  retryDelay: 1000,
  circuitResetTimeout: 60_000,
  enableThinking: false,
};

/**
 * OpenAI-compatible LLM provider.
 *
 * Base class for all providers that implement the OpenAI chat completions API.
 * Handles:
 * - Fast/smart model selection
 * - Native tool calling (tool_calls parsing)
 * - Response format (JSON mode, JSON schema)
 * - Circuit breaker and retry logic
 *
 * Extend this class for provider-specific customizations (headers, defaults).
 */
export class OpenAICompatibleProvider extends BaseLLMProvider {
  readonly name: string;

  protected readonly config: Required<
    Pick<
      OpenAICompatibleConfig,
      'baseUrl' | 'defaultModel' | 'timeout' | 'maxRetries' | 'retryDelay' | 'circuitResetTimeout'
    >
  > &
    OpenAICompatibleConfig;
  protected readonly providerLogger?: Logger | undefined;
  protected readonly circuitBreaker: CircuitBreaker;

  constructor(config: OpenAICompatibleConfig, logger?: Logger) {
    super(logger);
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.name = this.config.name ?? 'openai-compatible';
    this.providerLogger = logger?.child({ component: this.name });

    const circuitConfig: Parameters<typeof createCircuitBreaker>[0] = {
      name: this.name,
      maxFailures: 3,
      resetTimeout: this.config.circuitResetTimeout,
      timeout: this.config.timeout,
    };
    if (this.providerLogger) {
      circuitConfig.logger = this.providerLogger;
    }
    this.circuitBreaker = createCircuitBreaker(circuitConfig);

    this.providerLogger?.info(
      {
        baseUrl: this.config.baseUrl,
        defaultModel: this.config.defaultModel,
        fastModel: this.config.fastModel,
        smartModel: this.config.smartModel,
      },
      `${this.name} provider initialized`
    );
  }

  /**
   * Check if provider is configured.
   */
  isAvailable(): boolean {
    return Boolean(this.config.baseUrl && this.config.defaultModel);
  }

  /**
   * Get the model to use based on role or explicit model.
   */
  protected getModel(request: CompletionRequest): string {
    // Explicit model takes precedence
    if (request.model) {
      return request.model;
    }

    // Select based on role
    switch (request.role) {
      case 'fast':
        return this.config.fastModel ?? this.config.defaultModel;
      case 'smart':
        return this.config.smartModel ?? this.config.defaultModel;
      default:
        return this.config.defaultModel;
    }
  }

  /**
   * Generate a completion (called by BaseLLMProvider.complete with logging).
   */
  protected async doComplete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.isAvailable()) {
      throw new LLMError(
        `${this.name} not configured (missing baseUrl or defaultModel)`,
        this.name
      );
    }

    const model = this.getModel(request);

    return this.circuitBreaker.execute(async () => {
      return this.executeWithRetry(async () => {
        return this.executeRequest(request, model);
      });
    });
  }

  /**
   * Execute with retry logic.
   */
  protected async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
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
   * Build the API endpoint URL.
   * Override in subclasses if needed.
   */
  protected getApiUrl(): string {
    const baseUrl = this.config.baseUrl.replace(/\/$/, '');
    return `${baseUrl}/v1/chat/completions`;
  }

  /**
   * Build request headers.
   * Override in subclasses to add provider-specific headers.
   */
  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }

  /**
   * Build the request body.
   * Override in subclasses to add provider-specific fields.
   */
  protected buildRequestBody(request: CompletionRequest, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map((m) => {
        const msg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        // Include tool_calls for assistant messages
        if (m.tool_calls && m.tool_calls.length > 0) {
          msg['tool_calls'] = m.tool_calls;
        }
        // Include tool_call_id for tool result messages
        if (m.tool_call_id) {
          msg['tool_call_id'] = m.tool_call_id;
        }
        return msg;
      }),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stop: request.stop,
    };

    // Thinking mode (for models that support it)
    if (this.config.enableThinking === false) {
      body['enable_thinking'] = false;
    }

    // Add native tools if provided
    if (request.tools && request.tools.length > 0) {
      body['tools'] = request.tools;
      body['tool_choice'] = request.toolChoice ?? 'auto';
      // Disable parallel tool calls for deterministic behavior and strict mode compatibility
      body['parallel_tool_calls'] = request.parallelToolCalls ?? false;
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

    return body;
  }

  /**
   * Perform the actual HTTP request to the OpenAI-compatible API.
   */
  protected async executeRequest(
    request: CompletionRequest,
    model: string
  ): Promise<CompletionResponse> {
    const url = this.getApiUrl();
    const headers = this.buildHeaders();
    const body = this.buildRequestBody(request, model);

    // Trace-level logging of full request body for debugging
    // This helps diagnose issues with tool_calls not appearing in history
    this.providerLogger?.debug(
      {
        url,
        model,
        messageCount: request.messages.length,
        toolCount: request.tools?.length ?? 0,
        requestBody: body,
      },
      'Full OpenAI request body'
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
          `${this.name} API error: ${String(response.status)} - ${errorText}`,
          this.name,
          {
            statusCode: response.status,
            retryable,
          }
        );
      }

      const data = (await response.json()) as OpenAIResponse;
      return this.parseResponse(data);
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
        retryable: !isConnectionError,
      });
    }
  }

  /**
   * Parse the API response into our format.
   */
  protected parseResponse(data: OpenAIResponse): CompletionResponse {
    const firstChoice = data.choices[0];
    if (!firstChoice) {
      throw new LLMError(`Invalid response from ${this.name}`, this.name);
    }

    // For "thinking" models: if content is empty but reasoning_content exists,
    // use reasoning_content as fallback
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

    // Parse tool_calls if present (native tool calling)
    if (firstChoice.message.tool_calls && firstChoice.message.tool_calls.length > 0) {
      result.toolCalls = firstChoice.message.tool_calls.map(
        (tc): ToolCall => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments,
          },
        })
      );
    }

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
  }

  /**
   * Map finish reason to our format.
   */
  protected mapFinishReason(
    reason: string
  ): 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | undefined {
    switch (reason) {
      case 'stop':
      case 'eos': // Some local models use this
        return 'stop';
      case 'tool_calls':
        return 'tool_calls';
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
  protected sleep(ms: number): Promise<void> {
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
