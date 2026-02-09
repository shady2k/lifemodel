/**
 * LLM Adapter for Agentic Loop
 *
 * Wraps the application's LLMProvider to provide the interface
 * needed by the agentic loop. Provider-agnostic: works with OpenRouter,
 * local models, etc.
 *
 * Key features:
 * - Native tool calling via `completeWithTools()`
 * - Fast/smart model selection
 * - Automatic tool_calls parsing from provider response
 */

import type { Logger } from '../../types/logger.js';
import type {
  CognitionLLM,
  LLMOptions,
  SimpleCompletionRequest,
  ToolCompletionRequest,
  ToolCompletionResponse,
} from './agentic-loop.js';
import type { Message } from '../../llm/provider.js';
import type { LLMProvider as AppLLMProvider, ModelRole } from '../../llm/provider.js';

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
 * to provide the CognitionLLM interface for the agentic loop.
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
   * Simple text completion without tools.
   * Used for summarization, classification, and other non-agentic tasks.
   *
   * @param request Simple request with system/user prompts
   * @param options LLM options
   */
  async complete(request: SimpleCompletionRequest, options?: LLMOptions): Promise<string> {
    const startTime = Date.now();
    const useSmart = options?.useSmart ?? false;

    const messages: Message[] = [
      { role: 'system', content: request.systemPrompt },
      { role: 'user', content: request.userPrompt },
    ];

    try {
      const completionRequest: Parameters<typeof this.provider.complete>[0] = {
        messages,
        maxTokens: options?.maxTokens ?? 5000,
        temperature: options?.temperature ?? this.config.temperature,
        ...(options?.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      };

      // Select model based on useSmart flag
      if (useSmart) {
        if (this.config.smartModel) {
          completionRequest.model = this.config.smartModel;
        }
        if (this.config.smartRole) {
          completionRequest.role = this.config.smartRole;
        }
      } else {
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
          responseLength: response.content?.length ?? 0,
          duration,
        },
        'LLM simple completion done'
      );

      return response.content ?? '';
    } catch (error) {
      this.logger.error({ error, useSmart }, 'LLM simple completion failed');
      throw error;
    }
  }

  /**
   * Complete a request with native tool calling support.
   *
   * @param request Request with messages, tools, and tool choice
   * @param options LLM options including useSmart for smart model retry
   */
  async completeWithTools(
    request: ToolCompletionRequest,
    options?: LLMOptions
  ): Promise<ToolCompletionResponse> {
    const startTime = Date.now();
    const useSmart = options?.useSmart ?? false;

    try {
      const completionRequest: Parameters<typeof this.provider.complete>[0] = {
        messages: request.messages,
        maxTokens: options?.maxTokens ?? 5000,
        temperature: options?.temperature ?? this.config.temperature,
        tools: request.tools,
        toolChoice: request.toolChoice ?? 'required', // Default to required for agentic loop
        parallelToolCalls: request.parallelToolCalls ?? false, // Default to sequential for determinism
        ...(options?.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
      };

      // Add responseFormat conditionally (only when defined, for JSON mode)
      if (request.responseFormat !== undefined) {
        completionRequest.responseFormat = request.responseFormat;
      }

      // Select model based on useSmart flag
      if (useSmart) {
        if (this.config.smartModel) {
          completionRequest.model = this.config.smartModel;
        }
        if (this.config.smartRole) {
          completionRequest.role = this.config.smartRole;
        }
      } else {
        if (this.config.model) {
          completionRequest.model = this.config.model;
        }
        if (this.config.role) {
          completionRequest.role = this.config.role;
        }
      }

      // Estimate input tokens (rough: ~4 chars per token for English/mixed content)
      const requestPayload = JSON.stringify({
        messages: completionRequest.messages,
        tools: completionRequest.tools,
      });
      const estimatedInputTokens = Math.ceil(requestPayload.length / 4);

      const response = await this.provider.complete(completionRequest);

      const duration = Date.now() - startTime;
      this.logger.debug(
        {
          model: response.model,
          useSmart,
          messageCount: request.messages.length,
          toolCount: request.tools.length,
          estimatedInputTokens,
          responseContentLength: response.content?.length ?? 0,
          toolCallCount: response.toolCalls?.length ?? 0,
          finishReason: response.finishReason,
          duration,
          usage: response.usage,
        },
        'LLM completion with tools done'
      );

      // Map to ToolCompletionResponse
      return {
        content: response.content,
        toolCalls: response.toolCalls ?? [],
        finishReason: this.mapFinishReason(response.finishReason),
      };
    } catch (error) {
      this.logger.error({ error, useSmart }, 'LLM completion with tools failed');
      throw error;
    }
  }

  /**
   * Map provider finish reason to our expected values.
   */
  private mapFinishReason(reason: string | undefined): 'stop' | 'tool_calls' | 'length' | 'error' {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'tool_calls':
        return 'tool_calls';
      case 'length':
        return 'length';
      default:
        return 'error';
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
