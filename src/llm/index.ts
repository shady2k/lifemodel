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
  createVercelAIEndpointProvider,
  type VercelAIProviderConfig,
  type VercelAIEndpointConfig,
} from '../plugins/providers/vercel-ai-provider.js';

export {
  MessageComposer,
  createMessageComposer,
  type CompositionContext,
  type CompositionResult,
  type ClassificationContext,
  type ClassificationResult,
  type UserStateContext,
} from './composer.js';
