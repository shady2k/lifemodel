import type { CompletionRequest, CompletionResponse, LLMProvider } from '../llm/provider.js';
import { LLMError } from '../llm/provider.js';

/** Stable provider reference for consumers that survive config reloads. */
export function createReloadableLLMProvider(initial: LLMProvider | null): {
  provider: LLMProvider;
  replace: (next: LLMProvider | null) => void;
} {
  let current = initial;
  const provider: LLMProvider = {
    get name() {
      return current?.name ?? 'endpoint';
    },
    isAvailable: () => current?.isAvailable() ?? false,
    complete: (request: CompletionRequest): Promise<CompletionResponse> => {
      if (!current) throw new LLMError('Model endpoint is not configured', 'endpoint');
      return current.complete(request);
    },
    getModels: async () => (current?.getModels ? await current.getModels() : []),
  };
  return {
    provider,
    replace: (next) => {
      current = next;
    },
  };
}
