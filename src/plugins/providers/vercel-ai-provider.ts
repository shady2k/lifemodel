/**
 * Vercel AI SDK Provider
 *
 * LLM provider implementation using the Vercel AI SDK (ai package v5).
 * Provides tool call parsing/repair, streaming support, and provider-specific message transforms.
 */

import type { Logger } from '../../types/index.js';
import type { CircuitBreaker } from '../../core/circuit-breaker.js';
import { createCircuitBreaker } from '../../core/circuit-breaker.js';
import type {
  CompletionRequest,
  CompletionResponse,
  Message,
  ToolCall,
} from '../../llm/provider.js';
import { BaseLLMProvider, LLMError } from '../../llm/provider.js';
import { resolveModelParams, resolveProviderPreferences } from './model-params.js';
import {
  isGeminiModel,
  ensureUserTurnForGemini,
  sanitizeSystemMessagesForGemini,
  addCacheControl,
} from './gemini-transforms.js';

// Vercel AI SDK imports
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { LanguageModel } from 'ai';

/**
 * JSON object type for tool arguments.
 */
type JsonObject = Record<string, unknown>;

/**
 * OpenRouter configuration for VercelAIProvider.
 */
export interface VercelAIOpenRouterConfig {
  /** API key (required for OpenRouter) */
  apiKey: string;
  /** Fast model for classification */
  fastModel?: string;
  /** Smart model for reasoning */
  smartModel?: string;
  /** Motor model for Motor Cortex tasks */
  motorModel?: string;
  /** App name for OpenRouter dashboard */
  appName?: string;
  /** Site URL for OpenRouter attribution */
  siteUrl?: string;
}

/**
 * Local OpenAI-compatible server configuration for VercelAIProvider.
 */
export interface VercelAILocalConfig {
  /** Base URL of local server (e.g., http://localhost:1234) */
  baseUrl: string;
  /** Model name to use */
  model: string;
}

/**
 * Configuration for VercelAIProvider.
 */
export type VercelAIProviderConfig = VercelAIOpenRouterConfig | VercelAILocalConfig;

/**
 * Discriminate between config types.
 */
function isOpenRouterConfig(config: VercelAIProviderConfig): config is VercelAIOpenRouterConfig {
  return 'apiKey' in config;
}

const OPENROUTER_DEFAULTS = {
  name: 'openrouter',
  defaultModel: 'anthropic/claude-3.5-haiku',
  fastModel: 'anthropic/claude-3.5-haiku',
  smartModel: 'anthropic/claude-sonnet-4',
};

const DEFAULT_TIMEOUT = 120_000; // 2 minutes
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000;
const DEFAULT_CIRCUIT_RESET_TIMEOUT = 60_000;

/**
 * Vercel AI SDK LLM provider.
 *
 * Uses Vercel AI SDK's generateText() for non-streaming completions with:
 * - Automatic tool call parsing and repair
 * - Provider-specific message transforms
 * - Our retry/circuit breaker logic (AI SDK's retry is disabled)
 */
export class VercelAIProvider extends BaseLLMProvider {
  readonly name: string;
  private readonly config: VercelAIProviderConfig;
  private readonly providerLogger?: Logger | undefined;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(config: VercelAIProviderConfig, logger?: Logger) {
    super(logger);

    this.config = config;
    this.name = isOpenRouterConfig(config) ? OPENROUTER_DEFAULTS.name : 'local';
    this.providerLogger = logger?.child({ component: 'vercel-ai-provider' });

    const circuitConfig: Parameters<typeof createCircuitBreaker>[0] = {
      name: 'vercel-ai-provider',
      maxFailures: 3,
      resetTimeout: DEFAULT_CIRCUIT_RESET_TIMEOUT,
      timeout: DEFAULT_TIMEOUT,
    };
    if (this.providerLogger) {
      circuitConfig.logger = this.providerLogger;
    }
    this.circuitBreaker = createCircuitBreaker(circuitConfig);

    this.providerLogger?.info(
      {
        provider: this.name,
        ...(isOpenRouterConfig(config)
          ? {
              fastModel: config.fastModel ?? OPENROUTER_DEFAULTS.fastModel,
              smartModel: config.smartModel ?? OPENROUTER_DEFAULTS.smartModel,
            }
          : { baseUrl: config.baseUrl, model: config.model }),
      },
      'VercelAIProvider initialized'
    );
  }

  /**
   * Check if provider is configured.
   */
  isAvailable(): boolean {
    if (isOpenRouterConfig(this.config)) {
      return Boolean(this.config.apiKey);
    }
    return Boolean(this.config.baseUrl && this.config.model);
  }

  /**
   * Get the model to use based on role or explicit model.
   */
  private getModelId(request: CompletionRequest): string {
    // Explicit model takes precedence
    if (request.model) {
      return request.model;
    }

    if (isOpenRouterConfig(this.config)) {
      // Select based on role for OpenRouter
      switch (request.role) {
        case 'fast':
          return this.config.fastModel ?? OPENROUTER_DEFAULTS.fastModel;
        case 'smart':
          return this.config.smartModel ?? OPENROUTER_DEFAULTS.smartModel;
        case 'motor':
          return this.config.motorModel ?? this.config.fastModel ?? OPENROUTER_DEFAULTS.fastModel;
        default:
          return OPENROUTER_DEFAULTS.defaultModel;
      }
    } else {
      // Local provider uses the configured model
      return this.config.model;
    }
  }

  /**
   * Get the language model instance.
   */
  private getModel(modelId: string): LanguageModel {
    if (isOpenRouterConfig(this.config)) {
      return createOpenRouter({
        apiKey: this.config.apiKey,
      })(modelId);
    } else {
      return createOpenAI({
        baseURL: this.config.baseUrl,
      })(modelId);
    }
  }

  /**
   * Generate a completion (called by BaseLLMProvider.complete with logging).
   */
  protected async doComplete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.isAvailable()) {
      throw new LLMError('VercelAIProvider not configured', this.name);
    }

    const modelId = this.getModelId(request);

    return this.circuitBreaker.execute(async () => {
      return this.executeWithRetry(async () => {
        return this.executeRequest(request, modelId);
      });
    });
  }

  /**
   * Calculate backoff delay with exponential scaling for 429 rate limits.
   */
  private calculateBackoff(attempt: number, isRateLimit: boolean): number {
    if (isRateLimit) {
      // Exponential backoff for 429: 2s, 4s, 8s, 16s...
      return 2000 * Math.pow(2, attempt);
    }
    // Linear backoff for other errors: 1s, 2s, 3s...
    return DEFAULT_RETRY_DELAY * (attempt + 1);
  }

  /**
   * Check if error is a 429 rate limit error.
   */
  private isRateLimitError(error: unknown): boolean {
    return error instanceof LLMError && error.statusCode === 429;
  }

  /**
   * Execute with retry logic.
   */
  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= DEFAULT_MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        const errorInfo = this.extractErrorInfo(error);
        const isRateLimit = this.isRateLimitError(error);

        if (error instanceof LLMError && !error.retryable) {
          this.providerLogger?.error(errorInfo, 'Non-retryable LLM error');
          throw error;
        }

        if (attempt < DEFAULT_MAX_RETRIES) {
          const backoffMs = this.calculateBackoff(attempt, isRateLimit);
          this.providerLogger?.warn(
            {
              attempt: attempt + 1,
              maxRetries: DEFAULT_MAX_RETRIES,
              backoffMs,
              backoffReason: isRateLimit ? 'rate_limit_exponential' : 'linear',
              ...errorInfo,
            },
            'Retrying after transient error'
          );
          await this.sleep(backoffMs);
        } else {
          this.providerLogger?.error(
            {
              attempts: DEFAULT_MAX_RETRIES + 1,
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
   * Convert our Message format to AI SDK CoreMessage format.
   *
   * Key differences from OpenAI format:
   * - ToolCallPart uses `input` (not `args`)
   * - ToolResultPart uses `output` (not `content`) and requires `toolName`
   */
  private convertMessages(messages: Message[]): {
    role: string;
    content: string | Record<string, unknown>[];
  }[] {
    // Build a map from tool_call_id → toolName for tool result messages
    const toolCallIdToName = new Map<string, string>();
    for (const msg of messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallIdToName.set(tc.id, tc.function.name);
        }
      }
    }

    return messages.map((msg) => {
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant with tool calls - build content array
        const parts: Record<string, unknown>[] = [];

        // Add text content if present
        if (msg.content) {
          parts.push({ type: 'text', text: msg.content });
        }

        // Add tool calls in AI SDK format (uses `input`, not `args`)
        for (const tc of msg.tool_calls) {
          let input: unknown;
          try {
            input = JSON.parse(tc.function.arguments) as JsonObject;
          } catch {
            input = { _raw: tc.function.arguments };
          }
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function.name,
            input,
          });
        }

        return {
          role: 'assistant',
          content: parts,
        };
      }

      if (msg.role === 'tool') {
        // Tool result — AI SDK requires structured `output` and `toolName`
        const toolCallId = msg.tool_call_id ?? '';
        const toolName = toolCallIdToName.get(toolCallId);
        if (!toolName) {
          this.providerLogger?.warn(
            { toolCallId },
            'Tool result has no matching tool_call — toolName will be "unknown"'
          );
        }
        // AI SDK ToolResultOutput must be { type: 'text', value } or { type: 'json', value }
        const rawContent = msg.content ?? '';
        let output: { type: string; value: unknown };
        try {
          output = { type: 'json', value: JSON.parse(rawContent) };
        } catch {
          output = { type: 'text', value: rawContent };
        }
        return {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId,
              toolName: toolName ?? 'unknown',
              output,
            },
          ],
        };
      }

      // system, user, or assistant without tool calls
      // Handle multipart content from addCacheControl (converts string → [{ type, text, cache_control }])
      const rawContent = (msg as unknown as Record<string, unknown>)['content'];
      if (Array.isArray(rawContent)) {
        // Multipart content with cache_control — propagate via providerOptions on each part
        const parts = rawContent.map((part: Record<string, unknown>) => {
          const converted: Record<string, unknown> = {
            type: part['type'],
            text: part['text'],
          };
          if (part['cache_control']) {
            converted['providerOptions'] = {
              openrouter: { cacheControl: part['cache_control'] },
            };
          }
          return converted;
        });
        return { role: msg.role, content: parts };
      }
      return {
        role: msg.role,
        content: (rawContent as string) || '',
      };
    });
  }

  /**
   * Convert tools from OpenAI format to AI SDK format.
   * The AI SDK v6 expects tools with `inputSchema` as a FUNCTION that returns JSONSchema7,
   * not a plain object. This is different from AI SDK v3.
   */
  private convertTools(tools: CompletionRequest['tools']): Record<string, unknown> | undefined {
    if (!tools || tools.length === 0) return undefined;

    const aiTools: Record<string, unknown> = {};

    for (const t of tools) {
      const fn = t.function;
      // Check if this is OpenAIChatTool (has parameters) or MinimalOpenAIChatTool
      if ('parameters' in fn) {
        const schema = fn.parameters;
        // Build AI SDK tool structure with `inputSchema` as a function
        // AI SDK v6 requires inputSchema to be a function that returns PromiseLike<JSONSchema7>
        aiTools[fn.name] = {
          description: fn.description,
          inputSchema: () => Promise.resolve(schema as JsonObject),
        };
      }
      // Minimal format - skip tools without parameters
      // They'll need to call core.tools to get the full schema
    }

    return aiTools;
  }

  /**
   * Map tool choice from our format to AI SDK format.
   */
  private mapToolChoice(
    toolChoice: CompletionRequest['toolChoice']
  ): string | { type: string; toolName?: string } {
    if (toolChoice === 'auto' || toolChoice === 'required' || toolChoice === 'none') {
      return toolChoice;
    }
    if (typeof toolChoice === 'object') {
      return {
        type: 'tool',
        toolName: toolChoice.function.name,
      };
    }
    return 'auto';
  }

  /**
   * Build provider options for OpenRouter-specific fields and response format.
   * Uses extraBody to pass response_format to the underlying API.
   */
  private buildProviderOptions(
    modelId: string,
    overrides: ReturnType<typeof resolveModelParams>,
    request: CompletionRequest
  ): { openrouter?: Record<string, unknown>; openai?: Record<string, unknown> } | undefined {
    const providerOptions: Record<string, Record<string, unknown>> = {};
    const extraBody: Record<string, unknown> = {};

    // Determine provider key (openrouter or openai)
    const providerKey = isOpenRouterConfig(this.config) ? 'openrouter' : 'openai';

    if (isOpenRouterConfig(this.config)) {
      const openrouterOptions: Record<string, unknown> = {};

      // Add provider preferences
      const providerPrefs = resolveProviderPreferences(modelId);
      if (providerPrefs) {
        openrouterOptions['provider'] = {
          order: providerPrefs.order,
          ignore: providerPrefs.ignore,
          allow_fallbacks: providerPrefs.allow_fallbacks,
          preferred_min_throughput: providerPrefs.preferred_min_throughput,
        };
      } else {
        openrouterOptions['provider'] = {
          preferred_min_throughput: { p50: 10 },
        };
      }

      // Add reasoning config
      if (overrides.reasoning === 'enable') {
        openrouterOptions['reasoning'] = { enabled: true };
      } else if (overrides.reasoning === 'disable') {
        openrouterOptions['reasoning'] = { enabled: false };
      }
      // If 'omit', don't add the field

      // Pass parallel_tool_calls via providerOptions (OpenAI-specific, not in AI SDK CallSettings)
      if (request.parallelToolCalls === false) {
        openrouterOptions['parallel_tool_calls'] = false;
      }

      providerOptions[providerKey] = openrouterOptions;
    }

    // Add responseFormat via extraBody (both OpenRouter and OpenAI-compatible)
    // Note: response_format is an OpenAI API parameter, not an AI SDK generateText parameter
    if (request.responseFormat) {
      this.providerLogger?.debug(
        {
          responseFormatType: request.responseFormat.type,
          hasJsonSchema: !!request.responseFormat.json_schema,
        },
        'Processing responseFormat for extraBody'
      );
      if (request.responseFormat.type === 'json_object') {
        extraBody['response_format'] = { type: 'json_object' };
      } else if (
        request.responseFormat.type === 'json_schema' &&
        request.responseFormat.json_schema
      ) {
        extraBody['response_format'] = {
          type: 'json_schema',
          json_schema: {
            name: request.responseFormat.json_schema.name,
            schema: request.responseFormat.json_schema.schema,
          },
        };
      }
    }

    // Add extraBody if we have any fields
    if (Object.keys(extraBody).length > 0) {
      providerOptions[providerKey] ??= {};
      providerOptions[providerKey]['extraBody'] = extraBody;
      this.providerLogger?.debug({ extraBody }, 'extraBody added to providerOptions');
    } else {
      this.providerLogger?.debug('No extraBody fields to add');
    }

    return Object.keys(providerOptions).length > 0 ? providerOptions : undefined;
  }

  /**
   * Build headers for OpenRouter app identification.
   */
  private buildHeaders(): Record<string, string> | undefined {
    if (!isOpenRouterConfig(this.config)) {
      return undefined;
    }

    const headers: Record<string, string> = {};
    if (this.config.siteUrl) {
      headers['HTTP-Referer'] = this.config.siteUrl;
    }
    if (this.config.appName) {
      headers['X-Title'] = this.config.appName;
      headers['User-Agent'] = `${this.config.appName}/1.0`;
    }

    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  /**
   * Perform the actual LLM request using AI SDK.
   */
  private async executeRequest(
    request: CompletionRequest,
    modelId: string
  ): Promise<CompletionResponse> {
    // Apply model param overrides
    const overrides = resolveModelParams(modelId);

    // Handle temperature: null means "force omit" (use provider default)
    const temperature =
      overrides.temperature === null ? undefined : (overrides.temperature ?? request.temperature);

    // Copy messages for transformation (Gemini transforms + cache control mutate in place)
    const messages: Message[] = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls && { tool_calls: m.tool_calls }),
      ...(m.tool_call_id && { tool_call_id: m.tool_call_id }),
    }));

    // Apply Gemini message transforms if needed
    // Cast through unknown since Message interface lacks index signature
    const transformable = messages as unknown as Record<string, unknown>[];
    if (isGeminiModel(modelId)) {
      ensureUserTurnForGemini(transformable);
      sanitizeSystemMessagesForGemini(transformable);
    }

    // Add cache control breakpoints
    addCacheControl(transformable, modelId);

    // Convert transformed messages to AI SDK format
    const coreMessages = this.convertMessages(messages);

    // Convert tools
    const aiTools = this.convertTools(request.tools);

    // Build tool choice
    const toolChoice = request.toolChoice ? this.mapToolChoice(request.toolChoice) : undefined;

    // Build HTTP headers for OpenRouter app identification
    const httpHeaders = this.buildHeaders();

    // Build provider options (OpenRouter-specific body fields)
    const providerOptions = this.buildProviderOptions(modelId, overrides, request);

    // Get the model
    const model = this.getModel(modelId);

    // Debug logging
    this.providerLogger?.debug(
      {
        model: modelId,
        messageCount: coreMessages.length,
        toolCount: Object.keys(aiTools ?? {}).length,
        temperature,
        toolChoice,
      },
      'AI SDK generateText request'
    );

    const startTime = Date.now();

    // Prepare generateText options (declare outside try for error logging)
    const generateOptions: Record<string, unknown> = {
      model,
      messages: coreMessages as { role: string; content: string | Record<string, unknown>[] }[],
      temperature: temperature ?? undefined,
      ...(overrides.topP !== undefined && overrides.topP !== null && { topP: overrides.topP }),
      maxOutputTokens: request.maxTokens,
      stopSequences: request.stop,
      // Disable AI SDK's built-in retry (we handle it ourselves)
      maxRetries: 0,
    };

    // Add tools if present
    if (aiTools && Object.keys(aiTools).length > 0) {
      generateOptions['tools'] = aiTools;
      // Debug: log tools to see what's being passed
      this.providerLogger?.debug(
        { toolCount: Object.keys(aiTools).length, sampleTool: Object.keys(aiTools)[0] },
        'Tools added to generateText'
      );
      if (toolChoice) {
        generateOptions['toolChoice'] = toolChoice;
      }
    }

    // Add provider options if present
    if (providerOptions) {
      generateOptions['providerOptions'] = providerOptions;
      // Debug: log providerOptions to see what's being passed
      this.providerLogger?.debug({ providerOptions }, 'Provider options added');
    }

    // Add HTTP headers (OpenRouter app identification: HTTP-Referer, X-Title)
    if (httpHeaders) {
      generateOptions['headers'] = httpHeaders;
    }

    // Add per-request timeout if specified (AI SDK has native timeout support)
    if (request.timeoutMs) {
      generateOptions['timeout'] = request.timeoutMs;
    }

    try {
      // Call generateText
      const result = await generateText(generateOptions as Parameters<typeof generateText>[0]);

      const duration = Date.now() - startTime;

      this.providerLogger?.debug(
        {
          durationMs: duration,
          textLength: result.text.length,
          toolCallsCount: result.toolCalls.length,
          finishReason: result.finishReason,
          usage: result.usage,
          hasReasoningText: !!result.reasoningText,
          reasoningPreview: result.reasoningText?.slice(0, 1000) || null,
        },
        'AI SDK generateText response'
      );

      // Map AI SDK result back to CompletionResponse
      return this.mapAIResponseToCompletion(result, modelId);
    } catch (error) {
      const duration = Date.now() - startTime;

      // Log detailed information about the failed request
      this.providerLogger?.error(
        {
          durationMs: duration,
          model: modelId,
          error: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : 'Unknown',
          // Log message count and structure to help debug schema issues
          messageCount: coreMessages.length,
          messages: coreMessages.map((m) => ({
            role: m.role,
            contentType: Array.isArray(m.content) ? 'array' : typeof m.content,
            contentPreview:
              typeof m.content === 'string'
                ? m.content.slice(0, 200)
                : Array.isArray(m.content)
                  ? `[${String(m.content.length)} parts] ${JSON.stringify(m.content).slice(0, 200)}`
                  : JSON.stringify(m.content).slice(0, 200),
          })),
          hasTools: !!(aiTools && Object.keys(aiTools).length > 0),
          toolCount: aiTools ? Object.keys(aiTools).length : 0,
          hasProviderOptions: !!providerOptions,
        },
        'AI SDK generateText failed'
      );

      // Map AI SDK errors to LLMError
      throw this.mapAIErrorToLLMError(error);
    }
  }

  /**
   * Map AI SDK response to our CompletionResponse format.
   */
  private mapAIResponseToCompletion(
    result: {
      text: string;
      reasoningText?: string | undefined;
      toolCalls?: Record<string, unknown>[];
      finishReason: string | undefined;
      usage: {
        inputTokens: number | undefined;
        outputTokens: number | undefined;
        totalTokens: number | undefined;
        reasoningTokens?: number | undefined;
      };
      response: {
        id: string;
        headers?: Record<string, string>;
      };
    },
    modelId: string
  ): CompletionResponse {
    const response: CompletionResponse = {
      content: result.text || null,
      model: modelId,
      generationId: result.response.id || undefined,
      finishReason: this.mapFinishReason(result.finishReason ?? 'error'),
    };

    // Map reasoning content if present
    if (result.reasoningText) {
      response.reasoningContent = result.reasoningText;
    }

    // Map tool calls - AI SDK tool calls have different structures
    if (result.toolCalls && result.toolCalls.length > 0) {
      response.toolCalls = result.toolCalls.map((tc): ToolCall => {
        const toolCallIdRaw = tc['toolCallId'];
        const toolNameRaw = tc['toolName'];
        const toolCallId =
          typeof toolCallIdRaw === 'string' ? toolCallIdRaw : String(toolCallIdRaw);
        const toolName = typeof toolNameRaw === 'string' ? toolNameRaw : String(toolNameRaw);
        const args = tc['input'] as JsonObject;
        return {
          id: toolCallId,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(args),
          },
        };
      });
    }

    // Map usage - AI SDK uses inputTokens/outputTokens, we need promptTokens/completionTokens
    response.usage = {
      promptTokens: result.usage.inputTokens ?? 0,
      completionTokens: result.usage.outputTokens ?? 0,
      totalTokens: result.usage.totalTokens ?? 0,
      ...(result.usage.reasoningTokens != null && {
        reasoningTokens: result.usage.reasoningTokens,
      }),
    };

    return response;
  }

  /**
   * Map AI SDK finish reason to our format.
   */
  private mapFinishReason(
    reason: string | undefined
  ): 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | undefined {
    if (!reason) {
      return 'error';
    }
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'tool-calls':
        return 'tool_calls';
      case 'length':
        return 'length';
      case 'content-filter':
        return 'content_filter';
      default:
        return 'error';
    }
  }

  /**
   * Map AI SDK error to LLMError.
   */
  private mapAIErrorToLLMError(error: unknown): LLMError {
    const message = error instanceof Error ? error.message : String(error);

    // AI SDK throws APICallError with structured statusCode — check it first
    const statusCode =
      error instanceof Error && 'statusCode' in error
        ? (error as { statusCode: number }).statusCode
        : undefined;

    if (statusCode === 429) {
      return new LLMError(`Rate limit: ${message}`, this.name, {
        statusCode: 429,
        retryable: true,
      });
    }

    if (statusCode !== undefined && statusCode >= 500) {
      return new LLMError(`Server error: ${message}`, this.name, {
        statusCode,
        retryable: true,
      });
    }

    if (statusCode === 408) {
      return new LLMError(`Request timeout: ${message}`, this.name, {
        statusCode: 408,
        retryable: true,
      });
    }

    // Fallback: string matching for errors without structured status codes
    if (message.includes('429') || message.toLowerCase().includes('rate limit')) {
      return new LLMError(`Rate limit: ${message}`, this.name, {
        statusCode: 429,
        retryable: true,
      });
    }

    // Check for timeout errors (AbortError from AbortSignal)
    if (error instanceof Error && error.name === 'AbortError') {
      return new LLMError('Request timed out', this.name, {
        retryable: true,
      });
    }

    // Check for 5xx errors in message text
    const serverErrorMatch = /(5\d{2})/.exec(message);
    if (serverErrorMatch?.[1]) {
      return new LLMError(`Server error: ${message}`, this.name, {
        statusCode: parseInt(serverErrorMatch[1], 10),
        retryable: true,
      });
    }

    // Default to non-retryable
    return new LLMError(message, this.name, {
      retryable: false,
    });
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
 * Factory function for OpenRouter config.
 */
export function createVercelAIOpenRouterProvider(
  config: VercelAIOpenRouterConfig,
  logger?: Logger
): VercelAIProvider {
  return new VercelAIProvider(config, logger);
}

/**
 * Factory function for local OpenAI-compatible config.
 */
export function createVercelAILocalProvider(
  config: VercelAILocalConfig,
  logger?: Logger
): VercelAIProvider {
  return new VercelAIProvider(config, logger);
}

/**
 * Unified factory function.
 */
export function createVercelAIProvider(
  config: VercelAIProviderConfig,
  logger?: Logger
): VercelAIProvider {
  return new VercelAIProvider(config, logger);
}
