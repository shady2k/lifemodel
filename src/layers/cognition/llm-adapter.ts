/**
 * LLM Adapter for Agentic Loop
 *
 * Wraps LLM providers to provide the simple interface needed by the agentic loop.
 * Provider-agnostic: works with OpenRouter, local models, etc.
 */

import type { Logger } from '../../types/logger.js';
import type { CognitionLLM, LLMOptions } from './agentic-loop.js';

/**
 * Generic LLM provider interface.
 */
export interface LLMProvider {
  complete(messages: LLMMessage[], options?: ProviderOptions): Promise<string>;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderOptions {
  maxTokens?: number;
  temperature?: number;
  model?: string;
}

/**
 * Configuration for the LLM adapter.
 */
export interface LLMAdapterConfig {
  /** Model to use for cognition (fast/cheap model) */
  model: string;

  /** Temperature for generation */
  temperature: number;

  /** System prompt prefix */
  systemPromptPrefix?: string;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: LLMAdapterConfig = {
  model: 'anthropic/claude-3-haiku',
  temperature: 0.3,
};

/**
 * LLM Adapter implementation.
 */
export class LLMAdapter implements CognitionLLM {
  private readonly provider: LLMProvider;
  private readonly config: LLMAdapterConfig;
  private readonly logger: Logger;

  constructor(provider: LLMProvider, logger: Logger, config: Partial<LLMAdapterConfig> = {}) {
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

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    try {
      const response = await this.provider.complete(messages, {
        maxTokens: options?.maxTokens ?? 2000,
        temperature: options?.temperature ?? this.config.temperature,
        model: this.config.model,
      });

      const duration = Date.now() - startTime;
      this.logger.debug(
        {
          model: this.config.model,
          promptLength: prompt.length,
          responseLength: response.length,
          duration,
        },
        'LLM completion done'
      );

      return response;
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
   * Get current model.
   */
  getModel(): string {
    return this.config.model;
  }
}

/**
 * Create an LLM adapter.
 */
export function createLLMAdapter(
  provider: LLMProvider,
  logger: Logger,
  config?: Partial<LLMAdapterConfig>
): LLMAdapter {
  return new LLMAdapter(provider, logger, config);
}

/**
 * Mock LLM provider for testing.
 */
export class MockLLMProvider implements LLMProvider {
  private responses: string[] = [];
  private responseIndex = 0;

  /**
   * Add a response to return.
   */
  addResponse(response: string): void {
    this.responses.push(response);
  }

  /**
   * Complete with mock response.
   */
  complete(_messages: LLMMessage[], _options?: ProviderOptions): Promise<string> {
    const response = this.responses[this.responseIndex];
    if (response !== undefined) {
      this.responseIndex++;
      return Promise.resolve(response);
    }

    // Default response
    return Promise.resolve(
      JSON.stringify({
        steps: [{ type: 'think', id: 't1', parentId: 'trigger', content: 'Processing...' }],
        terminal: { type: 'noAction', reason: 'No mock response', parentId: 't1' },
      })
    );
  }

  /**
   * Reset mock state.
   */
  reset(): void {
    this.responses = [];
    this.responseIndex = 0;
  }
}
