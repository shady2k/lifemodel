/**
 * OpenAI-compatible request effort values; absence leaves the endpoint default.
 * The loader has the same small contract in loader/src/reasoning-effort.ts:
 * its independently built image cannot import the core's runtime modules.
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORTS.some((effort) => effort === value);
}
