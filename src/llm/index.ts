export type {
  LLMProvider,
  LLMLogger,
  Message,
  CompletionRequest,
  CompletionResponse,
  ModelRole,
} from './provider.js';
export { LLMError, BaseLLMProvider } from './provider.js';

// Providers (from plugins)
export {
  OpenRouterProvider,
  createOpenRouterProvider,
  type OpenRouterConfig,
} from '../plugins/providers/openrouter.js';

export {
  OpenAICompatibleProvider,
  createOpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from '../plugins/providers/openai-compatible.js';

export { MultiProvider, createMultiProvider, type MultiProviderConfig } from './multi-provider.js';

export {
  MessageComposer,
  createMessageComposer,
  type CompositionContext,
  type CompositionResult,
  type ClassificationContext,
  type ClassificationResult,
  type UserStateContext,
} from './composer.js';
