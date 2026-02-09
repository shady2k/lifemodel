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
  /** Upstream provider name (OpenRouter-specific, e.g. "Google AI Studio") */
  provider?: string;
  /** Can be undefined/empty on malformed responses from upstream providers */
  choices?: {
    index?: number;
    message: {
      role: string;
      content: string | null;
      /** For "thinking" models that separate reasoning from final answer */
      reasoning_content?: string;
      /** OpenRouter reasoning field (alternative to reasoning_content) */
      reasoning?: string;
      /** Tool calls requested by the model */
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** Cost in USD (OpenRouter) */
    cost?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
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

  /** Motor model for Motor Cortex sub-agent tasks */
  motorModel?: string;

  /** Optional API key */
  apiKey?: string;

  /** Provider name for logging (default: 'openai-compatible') */
  name?: string;

  /** App name for API tracking (shows in provider dashboards like OpenRouter) */
  appName?: string;

  /** Site URL for API tracking */
  siteUrl?: string;

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
  timeout: 120_000, // 2 minutes - LLM calls can be slow
  maxRetries: 3,
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
        motorModel: this.config.motorModel,
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
      case 'motor':
        return this.config.motorModel ?? this.config.fastModel ?? this.config.defaultModel;
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
   * Calculate backoff delay with exponential scaling for 429 rate limits.
   * Rate limits need longer recovery time than other transient errors.
   */
  protected calculateBackoff(attempt: number, isRateLimit: boolean): number {
    if (isRateLimit) {
      // Exponential backoff for 429: 2s, 4s, 8s, 16s...
      // Starting at 2 seconds to give upstream providers time to recover
      return 2000 * Math.pow(2, attempt);
    }
    // Linear backoff for other errors: 1s, 2s, 3s...
    return this.config.retryDelay * (attempt + 1);
  }

  /**
   * Check if error is a 429 rate limit error.
   */
  protected isRateLimitError(error: unknown): boolean {
    return error instanceof LLMError && error.statusCode === 429;
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

        // Extract error details for logging
        const errorInfo = this.extractErrorInfo(error);
        const isRateLimit = this.isRateLimitError(error);

        if (error instanceof LLMError && !error.retryable) {
          this.providerLogger?.error(errorInfo, 'Non-retryable LLM error');
          throw error;
        }

        if (attempt < this.config.maxRetries) {
          const backoffMs = this.calculateBackoff(attempt, isRateLimit);
          this.providerLogger?.warn(
            {
              attempt: attempt + 1,
              maxRetries: this.config.maxRetries,
              backoffMs,
              backoffReason: isRateLimit ? 'rate_limit_exponential' : 'linear',
              ...errorInfo,
            },
            'Retrying after transient error'
          );
          await this.sleep(backoffMs);
        } else {
          // Final attempt failed - this is the "All retry attempts exhausted" case
          this.providerLogger?.error(
            {
              attempts: this.config.maxRetries + 1,
              ...errorInfo,
            },
            'All retry attempts exhausted'
          );
        }
      }
    }

    throw lastError ?? new Error('Unknown error');
  }

  /**
   * Extract error information for logging.
   */
  private extractErrorInfo(error: unknown): Record<string, unknown> {
    if (error instanceof LLMError) {
      return {
        errorType: 'LLMError',
        message: error.message,
        statusCode: error.statusCode,
        retryable: error.retryable,
      };
    }
    if (error instanceof Error) {
      return {
        errorType: error.name,
        message: error.message,
      };
    }
    return {
      errorType: 'unknown',
      message: String(error),
    };
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

    // Reasoning mode (for models like Grok, o1, DeepSeek-R1 that support it)
    // OpenRouter uses { reasoning: { enabled: true/false } }
    // Setting enabled: false disables chain-of-thought, dramatically reducing tokens/latency
    if (this.config.enableThinking === false) {
      body['reasoning'] = { enabled: false };
    } else if (this.config.enableThinking === true) {
      body['reasoning'] = { enabled: true };
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

    // Debug-level logging (without tools array to reduce noise)
    this.providerLogger?.debug(
      {
        url,
        model,
        messageCount: request.messages.length,
        toolCount: request.tools?.length ?? 0,
        // Log key headers for debugging (excluding full Authorization for security)
        headers: {
          'Content-Type': headers['Content-Type'],
          Authorization: headers['Authorization'] ? 'Bearer ***' : undefined,
          ...(headers['User-Agent'] && { 'User-Agent': headers['User-Agent'] }),
          ...(headers['X-Title'] && { 'X-Title': headers['X-Title'] }),
          ...(headers['HTTP-Referer'] && { 'HTTP-Referer': headers['HTTP-Referer'] }),
        },
        // requestBody without tools
        requestBody: {
          ...body,
          tools: undefined,
        },
      },
      'OpenAI request'
    );

    // Trace-level logging includes full request body with tools
    this.providerLogger?.trace(
      {
        url,
        model,
        messageCount: request.messages.length,
        toolCount: request.tools?.length ?? 0,
        requestBody: body,
      },
      'Full OpenAI request body (with tools)'
    );

    const timeout = request.timeoutMs ?? this.config.timeout;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeout);

    // Track timing: request start, first byte (TTFB), complete
    const requestStartTime = Date.now();
    let firstByteTime: number | undefined;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Headers received (fetch resolves when headers are available)
      firstByteTime = Date.now();
      // NOTE: Do NOT clearTimeout here — keep the overall deadline active
      // during body reading. The upstream provider may stall or terminate
      // the connection mid-body (e.g., proxy timeout). Without this guard,
      // response.json() can hang indefinitely until the remote side closes.

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
      clearTimeout(timeoutId);
      const parsed = this.parseResponse(data);

      // Calculate and log timing metrics
      const totalDuration = Date.now() - requestStartTime;
      // Time to headers (fetch resolves when headers are available, not first body byte)
      // firstByteTime is guaranteed to be set here (we set it after fetch resolved)
      const timeToHeadersMs = firstByteTime - requestStartTime;
      const generationTime = totalDuration - timeToHeadersMs;

      // Calculate tokens per second (completion only)
      const completionTokens = parsed.usage?.completionTokens ?? 0;
      const tps =
        generationTime > 0 && completionTokens > 0
          ? Math.round((completionTokens / generationTime) * 1000)
          : undefined;

      // Log detailed timing metrics
      this.providerLogger?.debug(
        {
          generationId: parsed.generationId,
          provider: data.provider,
          totalDurationMs: totalDuration,
          timeToHeadersMs,
          generationMs: generationTime,
          tps,
          completionTokens,
          reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
          promptTokens: parsed.usage?.promptTokens,
          cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
          cost: data.usage?.cost,
        },
        'LLM timing breakdown'
      );

      return parsed;
    } catch (error) {
      clearTimeout(timeoutId);

      // Log timing metrics even on failure for debugging
      const totalDuration = Date.now() - requestStartTime;
      const timeToHeadersMs = (firstByteTime ?? requestStartTime) - requestStartTime;
      this.providerLogger?.warn(
        {
          totalDurationMs: totalDuration,
          timeToHeadersMs: firstByteTime ? timeToHeadersMs : undefined,
          error: error instanceof Error ? error.message : String(error),
        },
        'LLM request failed with timing data'
      );

      if (error instanceof LLMError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        // Timeouts are always retryable — transient network/provider delays resolve on retry
        throw new LLMError('Request timed out', this.name, {
          retryable: true,
        });
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
    // OpenRouter can return HTTP 200 with an error object in the body
    // (e.g. upstream provider 500s wrapped as {"error": {"message": "...", "code": 500}})
    const bodyError = (data as unknown as Record<string, unknown>)['error'] as
      | { message?: string; code?: number }
      | undefined;
    if (bodyError && !data.choices?.length) {
      const code = bodyError.code ?? 0;
      const message = bodyError.message ?? 'Unknown error';
      this.providerLogger?.warn(
        { generationId: data.id, provider: data.provider, errorCode: code, errorMessage: message },
        'Provider returned error in response body'
      );
      throw new LLMError(`${this.name} upstream error: ${String(code)} - ${message}`, this.name, {
        statusCode: code,
        retryable: code >= 500 || code === 429,
      });
    }

    const firstChoice = data.choices?.[0];
    if (!firstChoice) {
      // Log the raw response to help debug why there are no choices
      // Common causes: content filtering, model overload, malformed request
      this.providerLogger?.error(
        {
          generationId: data.id,
          provider: data.provider,
          responseKeys: Object.keys(data),
          choicesLength: data.choices?.length ?? 0,
          model: data.model,
          rawPreview: JSON.stringify(data).slice(0, 500),
        },
        'No choices in API response - logging raw response for debugging'
      );
      throw new LLMError(`Invalid response from ${this.name}: no choices in response`, this.name);
    }

    // For "thinking" models: reasoning text may be in `reasoning_content` (DeepSeek)
    // or `reasoning` (OpenRouter/GLM-4.7)
    const reasoningText =
      firstChoice.message.reasoning_content ?? firstChoice.message.reasoning ?? undefined;

    // If content is empty but reasoning exists, use reasoning as fallback
    let content = firstChoice.message.content;
    if (!content && reasoningText) {
      this.providerLogger?.warn(
        { finishReason: firstChoice.finish_reason },
        'Using reasoning text as fallback (content was empty)'
      );
      content = reasoningText;
    }

    const result: CompletionResponse = {
      content,
      model: data.model,
      generationId: data.id,
      // Preserve reasoning text when model provides it alongside content
      ...(reasoningText && content !== reasoningText && { reasoningContent: reasoningText }),
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
      const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens;
      result.usage = {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
        ...(reasoningTokens != null && { reasoningTokens }),
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
