import type { Logger } from '../types/index.js';
import type { LLMProvider, CompletionRequest, CompletionResponse, ModelRole } from './provider.js';
import { LLMError } from './provider.js';

/**
 * Configuration for MultiProvider.
 */
export interface MultiProviderConfig {
  /** Provider for fast/classification tasks */
  fast?: LLMProvider | undefined;

  /** Provider for smart/reasoning tasks */
  smart?: LLMProvider | undefined;

  /** Provider for Motor Cortex sub-agent tasks */
  motor?: LLMProvider | undefined;

  /** Default provider when role not specified */
  default?: LLMProvider | undefined;
}

/**
 * Multi-provider that routes requests to different providers based on role.
 *
 * This allows using different backends for different purposes:
 * - Fast local model (LM Studio, Ollama) for classification
 * - Smart cloud model (OpenRouter, Claude) for reasoning
 */
export class MultiProvider implements LLMProvider {
  readonly name = 'multi';

  private readonly providers: MultiProviderConfig;
  private readonly logger?: Logger | undefined;

  constructor(config: MultiProviderConfig, logger?: Logger) {
    this.providers = config;
    this.logger = logger?.child({ component: 'multi-provider' });

    // Log configured providers
    const configured: string[] = [];
    if (config.fast) configured.push(`fast: ${config.fast.name}`);
    if (config.smart) configured.push(`smart: ${config.smart.name}`);
    if (config.default) configured.push(`default: ${config.default.name}`);

    this.logger?.info({ providers: configured }, 'MultiProvider initialized');
  }

  /**
   * Check if at least one provider is available.
   */
  isAvailable(): boolean {
    const fastAvailable = this.providers.fast?.isAvailable() === true;
    const smartAvailable = this.providers.smart?.isAvailable() === true;
    const defaultAvailable = this.providers.default?.isAvailable() === true;
    return fastAvailable || smartAvailable || defaultAvailable;
  }

  /**
   * Get the provider for a given role.
   */
  private getProvider(role: ModelRole | undefined): LLMProvider | undefined {
    switch (role) {
      case 'fast':
        return this.providers.fast ?? this.providers.default;
      case 'smart':
        return this.providers.smart ?? this.providers.default;
      case 'motor':
        return this.providers.motor ?? this.providers.fast ?? this.providers.default;
      default:
        return this.providers.default ?? this.providers.fast ?? this.providers.smart;
    }
  }

  /**
   * Generate a completion by routing to the appropriate provider.
   */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const provider = this.getProvider(request.role);

    if (!provider) {
      throw new LLMError(
        `No provider configured for role: ${request.role ?? 'default'}`,
        this.name
      );
    }

    if (!provider.isAvailable()) {
      throw new LLMError(`Provider ${provider.name} is not available`, this.name);
    }

    this.logger?.debug(
      { role: request.role, provider: provider.name },
      'Routing request to provider'
    );

    return provider.complete(request);
  }

  /**
   * Get provider for a specific role (for direct access if needed).
   */
  getProviderForRole(role: ModelRole): LLMProvider | undefined {
    return this.getProvider(role);
  }

  /**
   * Check if a specific role has an available provider.
   */
  isRoleAvailable(role: ModelRole): boolean {
    const provider = this.getProvider(role);
    return provider?.isAvailable() ?? false;
  }
}

/**
 * Factory function.
 */
export function createMultiProvider(config: MultiProviderConfig, logger?: Logger): MultiProvider {
  return new MultiProvider(config, logger);
}
