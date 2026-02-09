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
  VercelAIProvider,
  createVercelAIProvider,
  createVercelAIOpenRouterProvider,
  createVercelAILocalProvider,
  type VercelAIProviderConfig,
  type VercelAIOpenRouterConfig,
  type VercelAILocalConfig,
} from '../plugins/providers/vercel-ai-provider.js';

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
