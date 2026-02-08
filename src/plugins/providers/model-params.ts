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
