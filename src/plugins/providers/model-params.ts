/**
 * Model Parameter Overrides
 *
 * Built-in per-model-family parameter adjustments for OpenRouter.
 * Different models need different temperature, reasoning, and response_format settings.
 * Uses substring matching on model IDs (e.g., "glm-4.7", "claude", "google/").
 *
 * Unknown models get no overrides — the request passes through as-is.
 */

export type ReasoningMode = 'omit' | 'enable' | 'disable';

/** OpenRouter provider routing preferences (per-model). */
export interface ProviderPreferences {
  /** Preferred providers in priority order */
  order?: string[];
  /** Providers to never use */
  ignore?: string[];
  /** Fall back to other providers if preferred ones are unavailable (default: true) */
  allow_fallback?: boolean;
}

export interface ModelParamOverrides {
  /** number → force set; null → force omit (use provider default); undefined → leave as-is */
  temperature?: number | null;
  topP?: number | null;
  /** 'omit' → don't send reasoning field; 'enable'/'disable' → explicit */
  reasoning?: ReasoningMode;
}

interface ModelParamRule {
  match: string;
  params: ModelParamOverrides;
  /** OpenRouter provider routing for this model family */
  provider?: ProviderPreferences;
}

/**
 * Built-in rules for known model families.
 * Based on model documentation and OpenCode's empirical findings.
 */
const BUILTIN_RULES: ModelParamRule[] = [
  // GLM-4.7: temp 1.0 per official docs, thinking enabled by default (don't touch reasoning)
  { match: 'glm-4.7', params: { temperature: 1.0, reasoning: 'omit' } },
  { match: 'glm-4.6', params: { temperature: 1.0, reasoning: 'omit' } },
  // Claude: let provider choose temperature, no reasoning field
  { match: 'claude', params: { temperature: null, reasoning: 'omit' } },
  // Gemini: temp 1.0, top_p 0.95 per OpenCode findings
  { match: 'google/', params: { temperature: 1.0, topP: 0.95 } },
  // DeepSeek: temp 1.0, top_p 0.95 per official docs; pin to DeepInfra — AtlasCloud/Google mangle tool calls
  {
    match: 'deepseek',
    params: { temperature: 1.0, topP: 0.95 },
    provider: { order: ['DeepInfra'], allow_fallback: true },
  },
  // Qwen: temp 0.55 per OpenCode findings
  { match: 'qwen', params: { temperature: 0.55 } },
];

/**
 * Resolve parameter overrides for a given model ID.
 * First matching rule wins. Returns empty object for unknown models.
 */
export function resolveModelParams(model: string): ModelParamOverrides {
  const id = model.toLowerCase();
  for (const rule of BUILTIN_RULES) {
    if (id.includes(rule.match.toLowerCase())) {
      return rule.params;
    }
  }
  return {};
}

/**
 * Resolve provider routing preferences for a given model ID.
 * Returns undefined for models without provider preferences.
 */
export function resolveProviderPreferences(model: string): ProviderPreferences | undefined {
  const id = model.toLowerCase();
  for (const rule of BUILTIN_RULES) {
    if (id.includes(rule.match.toLowerCase())) {
      return rule.provider;
    }
  }
  return undefined;
}
