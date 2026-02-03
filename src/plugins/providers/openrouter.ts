import type { Logger } from '../../types/index.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { OpenAICompatibleConfig } from './openai-compatible.js';

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
  timeout: 30_000,
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
      timeout: config.timeout ?? OPENROUTER_DEFAULTS.timeout,
      apiKey: config.apiKey,
    };

    // Only add optional properties if they are defined
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

    return headers;
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
