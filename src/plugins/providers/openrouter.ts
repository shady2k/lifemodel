import type { Logger } from '../../types/index.js';
import type { CompletionRequest } from '../../llm/provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { OpenAICompatibleConfig } from './openai-compatible.js';
import { resolveModelParams, resolveProviderPreferences } from './model-params.js';
import {
  isGeminiModel,
  ensureUserTurnForGemini,
  sanitizeSystemMessagesForGemini,
  addCacheControl,
} from './gemini-transforms.js';

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

    // Apply provider routing preferences: global throughput floor + per-model overrides
    const providerPrefs = resolveProviderPreferences(model);
    const globalFloor = { preferred_min_throughput: { p50: 10 } };
    body['provider'] = providerPrefs ? { ...globalFloor, ...providerPrefs } : globalFloor;

    if (isGeminiModel(model)) {
      ensureUserTurnForGemini(messages);
      sanitizeSystemMessagesForGemini(messages);
    }

    // Add cache_control after all message transforms are done
    addCacheControl(messages, model);

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
