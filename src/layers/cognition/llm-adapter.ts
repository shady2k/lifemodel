/**
 * LLM Adapter for Agentic Loop
 *
 * Wraps the application's LLMProvider to provide the simple interface
 * needed by the agentic loop. Provider-agnostic: works with OpenRouter,
 * local models, etc.
 */

import type { Logger } from '../../types/logger.js';
import type { CognitionLLM, LLMOptions } from './agentic-loop.js';
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
   * Complete a prompt and return the response.
   * @param prompt The prompt to complete
   * @param options LLM options including useSmart for smart model retry
   */
  async complete(prompt: string, options?: LLMOptions & { useSmart?: boolean }): Promise<string> {
    const startTime = Date.now();
    const useSmart = options?.useSmart ?? false;

    // Split prompt into system and user parts
    const { systemPrompt, userPrompt } = this.splitPrompt(prompt);

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    try {
      const request: Parameters<typeof this.provider.complete>[0] = {
        messages,
        maxTokens: options?.maxTokens ?? 2000,
        temperature: options?.temperature ?? this.config.temperature,
      };

      // Select model based on useSmart flag
      if (useSmart) {
        // Use smart model for retry
        if (this.config.smartModel) {
          request.model = this.config.smartModel;
        }
        if (this.config.smartRole) {
          request.role = this.config.smartRole;
        }
      } else {
        // Use fast model for initial attempt
        if (this.config.model) {
          request.model = this.config.model;
        }
        if (this.config.role) {
          request.role = this.config.role;
        }
      }

      const response = await this.provider.complete(request);

      const duration = Date.now() - startTime;
      this.logger.debug(
        {
          model: response.model,
          useSmart,
          promptLength: prompt.length,
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
   * Split a prompt into system and user parts.
   * Convention: Everything before "## Current" is system, rest is user.
   */
  private splitPrompt(prompt: string): { systemPrompt: string; userPrompt: string } {
    const splitIndex = prompt.indexOf('## Current State');

    if (splitIndex > 0) {
      let systemPrompt = prompt.slice(0, splitIndex).trim();
      const userPrompt = prompt.slice(splitIndex).trim();

      // Add prefix if configured
      if (this.config.systemPromptPrefix) {
        systemPrompt = this.config.systemPromptPrefix + '\n\n' + systemPrompt;
      }

      return { systemPrompt, userPrompt };
    }

    // Fallback: everything is user prompt
    return {
      systemPrompt: this.config.systemPromptPrefix ?? 'You are a helpful AI assistant.',
      userPrompt: prompt,
    };
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
