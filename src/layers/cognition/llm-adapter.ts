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
  /** Model to use for cognition (fast/cheap model) */
  model?: string;

  /** Model role for provider selection ('fast' for cheap quick calls) */
  role?: ModelRole;

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
   */
  async complete(prompt: string, options?: LLMOptions): Promise<string> {
    const startTime = Date.now();

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

      // Only add model or role if defined
      if (this.config.model) {
        request.model = this.config.model;
      }
      if (this.config.role) {
        request.role = this.config.role;
      }

      const response = await this.provider.complete(request);

      const duration = Date.now() - startTime;
      this.logger.debug(
        {
          model: response.model,
          promptLength: prompt.length,
          responseLength: response.content.length,
          duration,
          usage: response.usage,
        },
        'LLM completion done'
      );

      return response.content;
    } catch (error) {
      this.logger.error({ error }, 'LLM completion failed');
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
