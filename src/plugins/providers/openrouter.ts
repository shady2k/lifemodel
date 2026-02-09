import type { Logger } from '../../types/index.js';
import type { CompletionRequest } from '../../llm/provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { OpenAICompatibleConfig } from './openai-compatible.js';
import { resolveModelParams, resolveProviderPreferences } from './model-params.js';

/**
 * OpenRouter-specific provider configuration.
 * Extends base OpenAI-compatible config with OpenRouter-specific options.
 * Note: defaultModel, fastModel, smartModel have sensible defaults for OpenRouter.
 *
 * App identification uses inherited appName/siteUrl from base config.
 */
export interface OpenRouterConfig extends Omit<
  OpenAICompatibleConfig,
  'baseUrl' | 'name' | 'defaultModel'
> {
  /** API key (required for OpenRouter) */
  apiKey: string;

  /** Default model (optional, defaults to claude-3.5-haiku) */
  defaultModel?: string;
}

const OPENROUTER_DEFAULTS = {
  baseUrl: 'https://openrouter.ai/api',
  name: 'openrouter',
  defaultModel: 'anthropic/claude-3.5-haiku',
  fastModel: 'anthropic/claude-3.5-haiku',
  smartModel: 'anthropic/claude-sonnet-4',
};

/**
 * OpenRouter LLM provider.
 *
 * Extends OpenAICompatibleProvider with OpenRouter-specific headers
 * for ranking and attribution. Uses inherited appName/siteUrl from base config.
 */
export class OpenRouterProvider extends OpenAICompatibleProvider {
  constructor(config: OpenRouterConfig, logger?: Logger) {
    // Build base config with OpenRouter defaults
    // Only include defined properties to satisfy exactOptionalPropertyTypes
    const baseConfig: OpenAICompatibleConfig = {
      baseUrl: OPENROUTER_DEFAULTS.baseUrl,
      name: OPENROUTER_DEFAULTS.name,
      defaultModel: config.defaultModel ?? OPENROUTER_DEFAULTS.defaultModel,
      fastModel: config.fastModel ?? OPENROUTER_DEFAULTS.fastModel,
      smartModel: config.smartModel ?? OPENROUTER_DEFAULTS.smartModel,
      apiKey: config.apiKey,
    };

    // Only add optional properties if they are defined
    if (config.motorModel !== undefined) {
      baseConfig.motorModel = config.motorModel;
    }
    if (config.timeout !== undefined) {
      baseConfig.timeout = config.timeout;
    }
    if (config.maxRetries !== undefined) {
      baseConfig.maxRetries = config.maxRetries;
    }
    if (config.retryDelay !== undefined) {
      baseConfig.retryDelay = config.retryDelay;
    }
    if (config.circuitResetTimeout !== undefined) {
      baseConfig.circuitResetTimeout = config.circuitResetTimeout;
    }
    if (config.enableThinking !== undefined) {
      baseConfig.enableThinking = config.enableThinking;
    }
    if (config.appName !== undefined) {
      baseConfig.appName = config.appName;
    }
    if (config.siteUrl !== undefined) {
      baseConfig.siteUrl = config.siteUrl;
    }

    super(baseConfig, logger);
  }

  /**
   * Override to add OpenRouter-specific headers.
   * Maps appName → X-Title and siteUrl → HTTP-Referer for OpenRouter ranking.
   */
  protected override buildHeaders(): Record<string, string> {
    const headers = super.buildHeaders();

    // OpenRouter-specific headers for ranking (using inherited config)
    if (this.config.siteUrl) {
      headers['HTTP-Referer'] = this.config.siteUrl;
    }
    if (this.config.appName) {
      headers['X-Title'] = this.config.appName;
    }

    // Set User-Agent for app identification in OpenRouter dashboard
    // This is the primary way OpenRouter identifies your app
    const appName = this.config.appName ?? 'Unknown';
    headers['User-Agent'] = `${appName}/1.0`;

    return headers;
  }

  /**
   * Override to apply model-specific params, prompt caching, and Gemini sanitization.
   */
  protected override buildRequestBody(
    request: CompletionRequest,
    model: string
  ): Record<string, unknown> {
    const body = super.buildRequestBody(request, model);
    const messages = body['messages'] as Record<string, unknown>[];

    // Apply per-model parameter overrides (temperature, reasoning, etc.)
    this.applyModelParamOverrides(body, model);

    // Apply per-model provider routing preferences
    const providerPrefs = resolveProviderPreferences(model);
    if (providerPrefs) {
      body['provider'] = providerPrefs;
    }

    if (this.isGeminiModel(model)) {
      this.ensureUserTurnForGemini(messages);
      this.sanitizeSystemMessagesForGemini(messages);
    }

    // Add cache_control after all message transforms are done
    this.addCacheControl(messages, model);

    return body;
  }

  /**
   * Apply model-family-specific parameter overrides.
   * Post-processes the request body built by the base class.
   */
  private applyModelParamOverrides(body: Record<string, unknown>, model: string): void {
    const overrides = resolveModelParams(model);

    // Temperature: number → force set, null → delete (use provider default)
    if (overrides.temperature === null) {
      delete body['temperature'];
    } else if (typeof overrides.temperature === 'number') {
      body['temperature'] = overrides.temperature;
    }

    // Top-p: number → force set, null → delete
    if (overrides.topP === null) {
      delete body['top_p'];
    } else if (typeof overrides.topP === 'number') {
      body['top_p'] = overrides.topP;
    }

    // Reasoning: 'omit' → remove field, 'enable'/'disable' → explicit
    if (overrides.reasoning === 'omit') {
      delete body['reasoning'];
    } else if (overrides.reasoning === 'enable') {
      body['reasoning'] = { enabled: true };
    } else if (overrides.reasoning === 'disable') {
      body['reasoning'] = { enabled: false };
    }
  }

  /**
   * Add cache_control breakpoint for prompt caching.
   * Converts plain string content to multipart format with cache_control.
   *
   * Strategy differs by provider:
   * - Anthropic: breakpoint on last system message (caches full system prefix)
   * - Gemini: breakpoint on first user message (system_instruction loses cache_control)
   * - Others: ignored gracefully
   *
   * OpenRouter routes to the correct provider, and for Gemini uses only the last breakpoint.
   */
  private addCacheControl(messages: Record<string, unknown>[], model: string): void {
    let targetIdx: number;

    if (this.isGeminiModel(model)) {
      // Gemini: system messages become system_instruction and lose cache_control.
      // Put breakpoint on the first user message instead.
      targetIdx = messages.findIndex((m) => m['role'] === 'user');
    } else {
      // Anthropic/others: breakpoint on last leading system message
      targetIdx = -1;
      for (let i = 0; i < messages.length; i++) {
        if (messages[i]?.['role'] !== 'system') break;
        targetIdx = i;
      }
    }

    if (targetIdx === -1) return;

    const msg = messages[targetIdx];
    if (!msg) return;
    const content = msg['content'];
    if (typeof content !== 'string') return; // already multipart or null

    // Convert to multipart content with cache_control breakpoint
    msg['content'] = [
      {
        type: 'text',
        text: content,
        cache_control: { type: 'ephemeral' },
      },
    ];
  }

  /**
   * Check if the resolved model is a Gemini model on OpenRouter.
   */
  private isGeminiModel(model: string): boolean {
    return model.startsWith('google/');
  }

  /**
   * Gemini requires the first content turn (after system_instruction) to be 'user' role.
   * OpenRouter collapses leading system messages into system_instruction, so if the
   * first non-system message is 'assistant' (autonomous triggers with tool calls),
   * Gemini rejects it. Insert a synthetic user turn to satisfy this constraint.
   */
  private ensureUserTurnForGemini(messages: Record<string, unknown>[]): void {
    const firstContentIdx = messages.findIndex((m) => m['role'] !== 'system');
    if (firstContentIdx === -1) return; // all system — OpenRouter handles this

    const firstContentMsg = messages[firstContentIdx];
    if (!firstContentMsg || firstContentMsg['role'] === 'user') return; // already valid

    messages.splice(firstContentIdx, 0, {
      role: 'user',
      content: '[autonomous processing]',
    });
  }

  /**
   * Gemini only supports system messages as system_instruction (leading position).
   * OpenRouter collapses leading system messages automatically, but mid-conversation
   * system messages have no Gemini equivalent and cause 500 errors.
   * Convert them to user role with a prefix to preserve instructional intent.
   */
  private sanitizeSystemMessagesForGemini(messages: Record<string, unknown>[]): void {
    // Find where the leading system block ends
    let firstNonSystemIdx = 0;
    while (
      firstNonSystemIdx < messages.length &&
      messages[firstNonSystemIdx]?.['role'] === 'system'
    ) {
      firstNonSystemIdx++;
    }

    // Convert any system messages after the leading block to user role
    for (let i = firstNonSystemIdx; i < messages.length; i++) {
      const msg = messages[i];
      if (msg?.['role'] === 'system') {
        msg['role'] = 'user';
        msg['content'] = `[System] ${String(msg['content'])}`;
      }
    }
  }

  /**
   * Override API URL - OpenRouter doesn't need /v1 prefix.
   */
  protected override getApiUrl(): string {
    return `${this.config.baseUrl}/v1/chat/completions`;
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
