/**
 * Commitment Types
 *
 * Commitments are promises the agent makes to the user.
 * They can be explicit ("I'll remind you tomorrow") or implicit
 * (implied from conversation context).
 *
 * The commitment system enables the "holy shit, it actually cares" moment:
 * - Agent tracks what it promised
 * - Agent follows up or repairs if it misses
 */

/**
 * Status of a commitment.
 */
export type CommitmentStatus = 'active' | 'kept' | 'breached' | 'repaired' | 'cancelled';

/**
 * Source of a commitment - how it was created.
 */
export type CommitmentSource = 'explicit' | 'implicit';

/**
 * A record of a commitment the agent made.
 *
 * Stored as MemoryEntry with:
 * - type: 'fact'
 * - tags: ['commitment', `state:${status}`]
 * - metadata: { kind: 'commitment', ...fields }
 */
export interface CommitmentRecord {
  /** Unique identifier (cmt_timestamp_random) */
  id: string;

  /** Recipient the commitment was made to */
  recipientId: string;

  /** What the agent promised to do */
  text: string;

  /** Current status of the commitment */
  status: CommitmentStatus;

  /** When the commitment should be fulfilled */
  dueAt: Date;

  /** When the commitment was created */
  createdAt: Date;

  /** When the commitment was marked as kept (if applicable) */
  keptAt?: Date | undefined;

  /** When the commitment was marked as breached (if applicable) */
  breachedAt?: Date | undefined;

  /** Whether the agent explicitly said it or it was implied */
  source: CommitmentSource;

  /** Confidence that this is a real commitment (0-1) */
  confidence: number;

  /** Note about how the breach was repaired (if applicable) */
  repairNote?: string | undefined;

  /** Tick ID when commitment was created (for batch grouping) */
  tickId?: string | undefined;

  /** Parent signal ID that triggered this commitment (causal chain) */
  parentSignalId?: string | undefined;
}

/**
 * Summary of a commitment for display in prompts.
 */
export interface CommitmentSummary {
  id: string;
  text: string;
  dueAt: Date;
  isOverdue: boolean;
  source: CommitmentSource;
  confidence: number;
}

/**
 * Actions available for the commitment tool.
 */
export type CommitmentAction = 'create' | 'mark_kept' | 'mark_repaired' | 'cancel' | 'list_active';

/**
 * Result from the commitment tool.
 */
export interface CommitmentToolResult {
  success: boolean;
  action: CommitmentAction;
  commitmentId?: string | undefined;
  commitments?: CommitmentSummary[];
  total?: number | undefined;
  repairNote?: string | undefined;
  error?: string | undefined;
}
