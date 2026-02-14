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
  allow_fallbacks?: boolean;
  /** Deprioritize providers below this throughput (tokens/sec) at given percentiles */
  preferred_min_throughput?: Record<string, number>;
}

export interface ModelParamOverrides {
  /** number → force set; null → force omit (use provider default); undefined → leave as-is */
  temperature?: number | null;
  topP?: number | null;
  /** 'omit' → don't send reasoning field; 'enable'/'disable' → explicit */
  reasoning?: ReasoningMode;
  /** Whether this model supports OpenAI-style prompt caching (default: true for OpenAI-compatible) */
  supportsCacheControl?: boolean;
  /**
   * Whether this model supports OpenAI strict tool schemas.
   * Strict mode: ALL fields in required, optional fields use nullable types (type: ['T', 'null'])
   * Non-strict: Only truly required fields in required, plain types
   * Default: false (safer for non-OpenAI models like GLM, DeepSeek, Qwen, etc.)
   */
  supportsStrictToolSchema?: boolean;
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
  // OpenAI models: support strict tool schemas
  { match: 'openai/', params: { supportsStrictToolSchema: true } },
  { match: 'gpt-4', params: { supportsStrictToolSchema: true } },
  { match: 'gpt-4o', params: { supportsStrictToolSchema: true } },
  { match: 'gpt-3.5', params: { supportsStrictToolSchema: true } },
  { match: 'o1-', params: { supportsStrictToolSchema: true } },
  { match: 'o3-', params: { supportsStrictToolSchema: true } },
  { match: 'o4-', params: { supportsStrictToolSchema: true } },

  // GLM-4.7: temp 1.0 per official docs, thinking enabled by default — let it think
  // Disabling thinking degrades tool call quality (mangled JSON args, retry loops)
  // GLM doesn't support OpenAI-style prompt caching or strict tool schemas
  {
    match: 'glm-4.7',
    params: {
      temperature: 1.0,
      reasoning: 'omit',
      supportsCacheControl: false,
      supportsStrictToolSchema: false,
    },
    // Prefer fastest providers (Cerebras: 158 tok/s, DeepInfra: 0.57s latency)
    // Full ranking: https://openrouter.ai/models/z-ai/glm-4.7
    provider: {
      order: ['Cerebras', 'DeepInfra', 'Together', 'Google Vertex'],
      allow_fallbacks: true,
      // Require 30+ tok/s for responsive agent behavior
      preferred_min_throughput: { p50: 30 },
    },
  },
  {
    match: 'glm-4.6',
    params: {
      temperature: 1.0,
      reasoning: 'omit',
      supportsCacheControl: false,
      supportsStrictToolSchema: false,
    },
  },
  // Claude: let provider choose temperature, no reasoning field, supports strict schemas
  {
    match: 'claude',
    params: { temperature: null, reasoning: 'omit', supportsStrictToolSchema: true },
  },
  // Gemini: temp 1.0, top_p 0.95 per docs; pin to Google AI Studio — Vertex returns null/failures
  // Gemini doesn't support strict tool schemas (uses different format)
  {
    match: 'google/',
    params: { temperature: 1.0, topP: 0.95, supportsStrictToolSchema: false },
    provider: { order: ['Google AI Studio'], allow_fallbacks: true },
  },
  // DeepSeek: temp 1.0, top_p 0.95 per official docs; pin to DeepInfra — AtlasCloud/Google mangle tool calls
  // DeepSeek doesn't support prompt caching or strict schemas
  {
    match: 'deepseek',
    params: {
      temperature: 1.0,
      topP: 0.95,
      supportsCacheControl: false,
      supportsStrictToolSchema: false,
    },
    provider: { order: ['DeepInfra'], allow_fallbacks: true },
  },
  // Grok (xAI): doesn't support prompt caching or strict schemas
  { match: 'grok', params: { supportsCacheControl: false, supportsStrictToolSchema: false } },
  { match: 'x-ai/', params: { supportsCacheControl: false, supportsStrictToolSchema: false } },
  // Qwen: temp 0.55 per OpenCode findings, doesn't support prompt caching or strict schemas
  {
    match: 'qwen',
    params: { temperature: 0.55, supportsCacheControl: false, supportsStrictToolSchema: false },
  },
  // StepFun: reasoning is mandatory, cannot be disabled, doesn't support prompt caching or strict schemas
  {
    match: 'stepfun',
    params: { reasoning: 'omit', supportsCacheControl: false, supportsStrictToolSchema: false },
  },
  // MiniMax: reasoning is mandatory, cannot be disabled, doesn't support prompt caching or strict schemas
  {
    match: 'minimax',
    params: { reasoning: 'omit', supportsCacheControl: false, supportsStrictToolSchema: false },
  },
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
