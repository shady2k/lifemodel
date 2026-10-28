/**
 * OpenAI-compatible request effort values; absence leaves the endpoint default.
 * Kept local to the independent loader build; the core's matching contract is
 * src/config/reasoning-effort.ts. The UI imports this dependency-free module.
 */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORTS.some((effort) => effort === value);
}
