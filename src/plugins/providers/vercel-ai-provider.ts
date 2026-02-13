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
  /** Reasoning content extracted from local provider responses via custom fetch */
  private lastReasoningContent: string | null = null;

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
   * Create a fetch wrapper that intercepts Chat Completions responses
   * to extract reasoning_content from local models (e.g., LM Studio with thinking enabled).
   * The @ai-sdk/openai chat model doesn't parse this field, so we capture it here.
   */
  private createReasoningAwareFetch(): typeof globalThis.fetch {
    return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const response = await globalThis.fetch(input, init);
      if (!response.ok) return response;

      // Clone to read body without consuming the original
      const cloned = response.clone();
      try {
        const json = (await cloned.json()) as Record<string, unknown>;
        const choices = json['choices'] as Record<string, unknown>[] | undefined;
        const message = choices?.[0]?.['message'] as Record<string, unknown> | undefined;
        const reasoning = message?.['reasoning_content'];
        this.lastReasoningContent =
          typeof reasoning === 'string' && reasoning.length > 0 ? reasoning : null;
      } catch {
        this.lastReasoningContent = null;
      }
      return response;
    };
  }

  /**
   * Get the language model instance.
   *
   * Local providers use .chat() targeting /v1/chat/completions — the officially
   * recommended path for gpt-oss on LM Studio. LM Studio handles Harmony format
   * parsing internally on this endpoint. addCacheControl is skipped separately
   * to avoid multipart system messages that @ai-sdk/openai rejects.
   */
  private getModel(modelId: string, request?: CompletionRequest): LanguageModel {
    if (isOpenRouterConfig(this.config)) {
      return createOpenRouter({
        apiKey: this.config.apiKey,
      })(modelId, {
        ...(request?.parallelToolCalls === false && { parallelToolCalls: false }),
      });
    } else {
      return createOpenAI({
        baseURL: this.config.baseUrl,
        apiKey: 'no-key-required',
        fetch: this.createReasoningAwareFetch(),
      }).chat(modelId);
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
        const toolName = toolCallIdToName.get(toolCallId) ?? msg.tool_name;
        if (!toolName) {
          this.providerLogger?.warn(
            { toolCallId },
            'Tool result has no matching tool_call and no tool_name fallback'
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
      // Handle multipart content from addCacheControl
      // MUTATION BOUNDARY: addCacheControl mutates content from string → Array.
      // This cast acknowledges the mutation; the actual type safety happens at the
      // call site in executeRequest where we cast back to Message[].
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
              [isOpenRouterConfig(this.config) ? 'openrouter' : 'openai']: {
                cacheControl: part['cache_control'],
              },
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
        continue;
      }
      // Minimal format - register with a permissive schema so the tool is visible
      aiTools[fn.name] = {
        description: fn.description,
        inputSchema: () =>
          Promise.resolve({
            type: 'object',
            additionalProperties: true,
          } as JsonObject),
      };
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

    if (request.parallelToolCalls === false) {
      providerOptions[providerKey] ??= {};
      providerOptions[providerKey]['parallel_tool_calls'] = false;
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

    // Add cache control breakpoints (mutates content from string → Array)
    // Only for OpenRouter — local providers use /v1/responses which handles multipart correctly
    if (isOpenRouterConfig(this.config)) {
      addCacheControl(transformable, modelId);
    }

    // Cast back to Message[] at the mutation boundary
    // addCacheControl mutates the content field from string to Array, which is
    // incompatible with the Message type. We acknowledge this boundary here and
    // let convertMessages handle the actual array content via its own narrow cast.
    const mutatedMessages = messages;

    // Convert transformed messages to AI SDK format
    const coreMessages = this.convertMessages(mutatedMessages);

    // Convert tools
    const aiTools = this.convertTools(request.tools);

    // Build tool choice
    const toolChoice = request.toolChoice ? this.mapToolChoice(request.toolChoice) : undefined;

    // Build HTTP headers for OpenRouter app identification
    const httpHeaders = this.buildHeaders();

    // Build provider options (OpenRouter-specific body fields)
    const providerOptions = this.buildProviderOptions(modelId, overrides, request);

    // Get the model (pass request so parallelToolCalls reaches the model constructor)
    const model = this.getModel(modelId, request);

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

    // Debug: log tools if present
    if (aiTools && Object.keys(aiTools).length > 0) {
      this.providerLogger?.debug(
        { toolCount: Object.keys(aiTools).length, sampleTool: Object.keys(aiTools)[0] },
        'Tools added to generateText'
      );
    }

    // Debug: log provider options if present
    if (providerOptions) {
      this.providerLogger?.debug({ providerOptions }, 'Provider options added');
    }

    // Prepare generateText options with proper typing
    // All conditional properties are included at declaration time for type safety
    const hasTools = aiTools && Object.keys(aiTools).length > 0;

    // Build options with all properties at once to avoid union types
    // Using conditional spreading ensures undefined values are not included
    // (required by exactOptionalPropertyTypes: true)
    // Note: Using Record<string, unknown> for base type due to complex AI SDK types
    // with conditional spreading. The type is validated at call site with 'as' cast.
    const generateOptions: Record<string, unknown> = {
      model,
      // Cast coreMessages to ModelMessage[] - convertMessages produces valid messages
      messages: coreMessages,
      ...(temperature !== undefined && { temperature }),
      ...(overrides.topP !== undefined && overrides.topP !== null && { topP: overrides.topP }),
      ...(request.maxTokens !== undefined && { maxOutputTokens: request.maxTokens }),
      ...(request.stop && { stopSequences: request.stop }),
      // Disable AI SDK's built-in retry (we handle it ourselves)
      maxRetries: 0,
      // Step-finished callback for lean debug logging (fires even for single-step calls)
      onStepFinish: (
        _step: Readonly<{
          toolCalls: readonly { toolName: string; toolCallId: string; args: unknown }[];
          text: string | undefined;
          finishReason: string | undefined;
          usage: {
            promptTokens: number;
            completionTokens: number;
            totalTokens: number;
          };
          warnings: readonly { code: string; message: string }[] | undefined;
        }>
      ) => {
        // Log lean summary - stepType, finishReason, and usage counts
        // Do NOT log request/response bodies (can be very large for tool-heavy prompts)
        this.providerLogger?.debug(
          {
            finishReason: _step.finishReason,
            usage: _step.usage,
            hasToolCalls: _step.toolCalls.length > 0,
          },
          'AI SDK step finished'
        );
      },
      ...(providerOptions && { providerOptions }),
      ...(httpHeaders && { headers: httpHeaders }),
      ...(request.timeoutMs && { timeout: request.timeoutMs }),
      // Add tools and repair callback if tools are present
      ...(hasTools && {
        tools: aiTools,
        ...(toolChoice && { toolChoice }),
        // Tool call repair callback for wrong casing (e.g., Core_Memory → core_memory)
        experimental_repairToolCall: async (
          failed: Readonly<{
            toolCall: { toolName: string; toolCallId: string; args: unknown };
            error: { cause: unknown };
            // AI SDK 6 signature: inputSchema({ toolName }) → PromiseLike<JSONSchema7>
            inputSchema: (options: { toolName: string }) => PromiseLike<Record<string, unknown>>;
          }>
        ) => {
          const { toolName } = failed.toolCall;
          const lower = toolName.toLowerCase();

          // Only repair if casing differs (e.g., "Core_Memory" → "core_memory")
          if (lower !== toolName) {
            // Verify the lowercased name matches a known tool via SDK schema lookup
            try {
              await failed.inputSchema({ toolName: lower });
              // If we get here, the tool exists — repair the name
              this.providerLogger?.info(
                { original: toolName, repaired: lower },
                'Repaired tool call name casing'
              );
              return { ...failed.toolCall, toolName: lower };
            } catch {
              // Schema lookup threw — tool doesn't exist with this name
            }
          }

          // Can't repair — return null to let normal error handling take over
          return null;
        },
      }),
    };

    try {
      // Call generateText with type validation
      const result = await generateText(generateOptions as Parameters<typeof generateText>[0]);

      // Capture reasoning from local provider's custom fetch if SDK didn't extract it
      const interceptedReasoning = this.lastReasoningContent;
      this.lastReasoningContent = null;

      const duration = Date.now() - startTime;

      const hasReasoningText = !!(result.reasoningText || interceptedReasoning);
      const reasoningPreview =
        (result.reasoningText || interceptedReasoning)?.slice(0, 1000) || null;

      this.providerLogger?.debug(
        {
          durationMs: duration,
          textLength: result.text.length,
          toolCallsCount: (result.toolCalls as { length: number } | undefined)?.length ?? 0,
          finishReason: result.finishReason,
          usage: result.usage,
          hasReasoningText,
          reasoningPreview,
        },
        'AI SDK generateText response'
      );

      // Map AI SDK result back to CompletionResponse, with intercepted reasoning as fallback
      const response = this.mapAIResponseToCompletion(result, modelId, interceptedReasoning);

      // Strip Harmony protocol tokens from local provider responses.
      // LM Studio bug: gpt-oss models leak <|channel|>final <|constrain|>JSON<|message|>
      // when tools are present and the model responds with constrained JSON output.
      if (!isOpenRouterConfig(this.config) && response.content) {
        response.content = this.stripHarmonyTokens(response.content);
      }

      return response;
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
      rawFinishReason?: string | undefined;
      usage: {
        inputTokens: number | undefined;
        outputTokens: number | undefined;
        totalTokens: number | undefined;
        reasoningTokens?: number | undefined;
        inputTokenDetails?: {
          cacheReadTokens?: number | undefined;
          cacheWriteTokens?: number | undefined;
        };
      };
      response: {
        id: string;
        headers?: Record<string, string>;
      };
    },
    modelId: string,
    interceptedReasoning?: string | null
  ): CompletionResponse {
    const response: CompletionResponse = {
      content: result.text || null,
      model: modelId,
      generationId: result.response.id || undefined,
      finishReason: this.mapFinishReason(result.finishReason ?? 'error'),
    };

    // Map reasoning content: prefer SDK-native, fall back to intercepted from custom fetch
    const reasoningText = result.reasoningText || interceptedReasoning;
    if (reasoningText) {
      response.reasoningContent = reasoningText;
    }

    // Map raw finish reason if present (provider-specific finish reason from AI SDK 6)
    if (result.rawFinishReason) {
      response.rawFinishReason = result.rawFinishReason;
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
      // Map cache tokens from inputTokenDetails if present (AI SDK 6 feature)
      ...(result.usage.inputTokenDetails?.cacheReadTokens != null && {
        cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens,
      }),
      ...(result.usage.inputTokenDetails?.cacheWriteTokens != null && {
        cacheWriteTokens: result.usage.inputTokenDetails.cacheWriteTokens,
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

    // Default to non-retryable — preserve statusCode if available for debugging
    return new LLMError(message, this.name, {
      ...(statusCode !== undefined && { statusCode }),
      retryable: false,
    });
  }

  /**
   * Strip Harmony protocol tokens from model output.
   * Known LM Studio/TensorRT-LLM bug: gpt-oss models leak Harmony tokens when
   * tools are present and the model responds with constrained output.
   * See: https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/942
   *
   * Format: <|channel|>final <|constrain|>JSON<|message|>{actual content}
   * Extract content after the last <|message|> token.
   */
  private stripHarmonyTokens(content: string): string {
    const messageIdx = content.lastIndexOf('<|message|>');
    if (messageIdx !== -1) {
      return content.slice(messageIdx + '<|message|>'.length);
    }
    // Strip standalone channel/constrain tokens if <|message|> is absent
    return content.replace(/<\|(?:channel|constrain|return|call)\|>\S*/g, '').trim();
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
