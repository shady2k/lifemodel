/**
 * Desire Types
 *
 * Desires represent what the agent wants to do or learn about the user.
 * They drive proactive behavior through wanting, not guilt.
 *
 * Unlike social debt (which is guilt-driven), desires create positive
 * motivation to engage: "I want to learn about their new job" vs
 * "I should message them because it's been too long."
 */

/**
 * Status of a desire.
 */
export type DesireStatus = 'active' | 'satisfied' | 'stale' | 'dropped';

/**
 * Source of a desire - how it was created.
 */
export type DesireSource = 'user_signal' | 'self_inference' | 'commitment_followup';

/**
 * A record of a desire the agent has.
 *
 * Stored as MemoryEntry with:
 * - type: 'fact'
 * - tags: ['desire', `state:${status}`]
 * - metadata: { kind: 'desire', ...fields }
 */
export interface DesireRecord {
  /** Unique identifier (des_timestamp_random) */
  id: string;

  /** What the agent wants to do/learn */
  want: string;

  /** Intensity of the desire (0-1) */
  intensity: number;

  /** Current status of the desire */
  status: DesireStatus;

  /** How this desire was created */
  source: DesireSource;

  /** Who this desire relates to */
  recipientId: string;

  /** When the desire was created */
  createdAt: Date;

  /** Evidence/context for why this desire exists */
  evidence: string;

  /** Tick ID when desire was created (for batch grouping) */
  tickId?: string | undefined;

  /** Parent signal ID that triggered this desire (causal chain) */
  parentSignalId?: string | undefined;
}

/**
 * Summary of a desire for display in prompts.
 */
export interface DesireSummary {
  id: string;
  want: string;
  intensity: number;
  source: DesireSource;
  evidence: string;
}

/**
 * Actions available for the desire tool.
 */
export type DesireAction = 'create' | 'adjust' | 'resolve' | 'list_active';

/**
 * Result from the desire tool.
 */
export interface DesireToolResult {
  success: boolean;
  action: DesireAction;
  desireId?: string | undefined;
  desires?: DesireSummary[];
  total?: number | undefined;
  error?: string | undefined;
}
