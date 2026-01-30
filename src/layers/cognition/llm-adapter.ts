/**
 * LLM Adapter for Agentic Loop
 *
 * Wraps the application's LLMProvider to provide the simple interface
 * needed by the agentic loop. Provider-agnostic: works with OpenRouter,
 * local models, etc.
 *
 * Key features:
 * - Native tool calling via `tools` parameter
 * - Structured outputs via `responseFormat.json_schema`
 * - No prompt splitting - accepts structured requests directly
 */

import type { Logger } from '../../types/logger.js';
import type { CognitionLLM, LLMOptions, StructuredRequest } from './agentic-loop.js';
import type { LLMProvider as AppLLMProvider, Message, ModelRole } from '../../llm/provider.js';

/**
 * Configuration for the LLM adapter.
 */
export interface LLMAdapterConfig {
  /** Model to use for fast cognition (cheap/quick model) */
  model?: string;

  /** Model role for provider selection ('fast' for cheap quick calls) */
  role?: ModelRole;

  /** Model to use for smart retry (expensive/powerful model) */
  smartModel?: string;

  /** Model role for smart retry ('smart' for powerful model) */
  smartRole?: ModelRole;

  /** Temperature for generation */
  temperature: number;

  /** System prompt prefix */
  systemPromptPrefix?: string;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: LLMAdapterConfig = {
  role: 'fast', // Use fast/cheap model for COGNITION layer
  smartRole: 'smart', // Use smart/powerful model for retries
  temperature: 0.3,
};

/**
 * LLM Adapter implementation.
 *
 * Wraps the application's LLMProvider (which uses CompletionRequest/Response)
 * to provide the simpler CognitionLLM interface for the agentic loop.
 */
export class LLMAdapter implements CognitionLLM {
  private readonly provider: AppLLMProvider;
  private readonly config: LLMAdapterConfig;
  private readonly logger: Logger;

  constructor(provider: AppLLMProvider, logger: Logger, config: Partial<LLMAdapterConfig> = {}) {
    this.provider = provider;
    this.logger = logger.child({ component: 'llm-adapter' });
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Complete a structured request and return the response.
   *
   * @param request Structured request with system/user prompts, tools, and response format
   * @param options LLM options including useSmart for smart model retry
   */
  async complete(request: StructuredRequest, options?: LLMOptions): Promise<string> {
    const startTime = Date.now();
    const useSmart = options?.useSmart ?? false;

    // Build system prompt with optional prefix
    let systemPrompt = request.systemPrompt;
    if (this.config.systemPromptPrefix) {
      systemPrompt = this.config.systemPromptPrefix + '\n\n' + systemPrompt;
    }

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: request.userPrompt },
    ];

    try {
      const completionRequest: Parameters<typeof this.provider.complete>[0] = {
        messages,
        maxTokens: options?.maxTokens ?? 2000,
        temperature: options?.temperature ?? this.config.temperature,
      };

      // Add tools if provided (native tool calling)
      if (request.tools && request.tools.length > 0) {
        completionRequest.tools = request.tools;
      }

      // Add response format if provided (structured output)
      if (request.responseFormat) {
        completionRequest.responseFormat = request.responseFormat;
      }

      // Select model based on useSmart flag
      if (useSmart) {
        // Use smart model for retry
        if (this.config.smartModel) {
          completionRequest.model = this.config.smartModel;
        }
        if (this.config.smartRole) {
          completionRequest.role = this.config.smartRole;
        }
      } else {
        // Use fast model for initial attempt
        if (this.config.model) {
          completionRequest.model = this.config.model;
        }
        if (this.config.role) {
          completionRequest.role = this.config.role;
        }
      }

      const response = await this.provider.complete(completionRequest);

      const duration = Date.now() - startTime;
      this.logger.debug(
        {
          model: response.model,
          useSmart,
          systemPromptLength: systemPrompt.length,
          userPromptLength: request.userPrompt.length,
          toolCount: request.tools?.length ?? 0,
          responseLength: response.content.length,
          duration,
          usage: response.usage,
        },
        'LLM completion done'
      );

      return response.content;
    } catch (error) {
      this.logger.error({ error, useSmart }, 'LLM completion failed');
      throw error;
    }
  }

  /**
   * Update configuration.
   */
  setConfig(config: Partial<LLMAdapterConfig>): void {
    Object.assign(this.config, config);
  }

  /**
   * Get current model or role.
   */
  getModel(): string | undefined {
    return this.config.model ?? (this.config.role ? `role:${this.config.role}` : undefined);
  }
}

/**
 * Create an LLM adapter.
 */
export function createLLMAdapter(
  provider: AppLLMProvider,
  logger: Logger,
  config?: Partial<LLMAdapterConfig>
): LLMAdapter {
  return new LLMAdapter(provider, logger, config);
}

/**
 * Re-export the AppLLMProvider type for convenience.
 */
export type { AppLLMProvider as LLMProviderType };
