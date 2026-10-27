import type { TaskHarnessName } from './task-harness-names.js';
import type { TaskCommand, TaskCommandStatus, TaskQuestion } from './task-channel.js';
/** Core task authority. Deliberately not exposed through PluginPrimitives. */
export type TaskState =
  | 'queued'
  | 'starting'
  | 'running'
  | 'wrapping-up'
  | 'done'
  | 'failed'
  | 'stopped';
export type TaskTerminalState = Extract<TaskState, 'done' | 'failed' | 'stopped'>;
export type TaskAccessMode = 'active' | 'wrapping' | 'revoked';

export interface TaskProfile {
  readonly id: string;
  readonly revision: string;
  readonly timeoutSeconds: number;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
}

export interface AcceptTask {
  /** Deciding turn's committed effect key, reused verbatim on replay. */
  readonly launchKey: string;
  readonly briefing: string;
  readonly profile: TaskProfile;
  readonly imageRevision: string;
  /** Causal context is captured only on first acceptance, never replaced on replay. */
  readonly traceId?: string;
  readonly parentSpanId?: string | null;
}

export interface TaskAccessIntent {
  readonly taskId: string;
  readonly attemptId: string;
  readonly launchId: string;
  readonly revision: string;
  readonly mode: TaskAccessMode;
  readonly softDueAt: Date;
  readonly hardStopAt: Date;
}

/** Durable storage allocation response; replay must preserve every receipt field. */
export interface TaskAllocationReceipt {
  readonly id: string;
  readonly space: string;
  readonly effectKey: string;
}

/** Immutable retained metadata from the storage module's seal manifest. */
export interface TaskManifestObject {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly mark: string;
  readonly contentType?: string;
}
export interface TaskSealRequest {
  readonly space: string;
  readonly effectKey: string;
  readonly expectedRevision: string;
  readonly intentRevision: string;
  readonly outcome: 'completed' | 'failed' | 'stopped';
  /** Candidate version when this exact request was prepared. */
  readonly candidateRevision: string;
}
export interface TaskSealReceipt {
  readonly id: string;
  readonly space: string;
  readonly effectKey: string;
  readonly revision: string;
  readonly outcome: TaskSealRequest['outcome'];
  readonly state: 'sealed';
  readonly reason: string | null;
  readonly manifest: {
    readonly id: string;
    readonly version: 1;
    readonly sha256: string;
    readonly objects: readonly TaskManifestObject[];
    readonly excluded?: readonly (TaskManifestObject & { readonly reason: string })[];
  };
}
export interface TaskFinalizationCandidate {
  readonly state: TaskTerminalState;
  readonly reasonCode: string;
  readonly summary: string;
}
/** Durable logical event; delivery is at-least-once, deduplicated by outcomeKey. */
export interface TaskOutcomeEvent {
  readonly taskId: string;
  readonly outcomeKey: string;
  readonly state: TaskTerminalState;
  readonly reasonCode: string;
  readonly summary: string;
  readonly objects: readonly TaskManifestObject[];
}

export interface TaskRecord {
  readonly id: string;
  readonly traceId: string;
  readonly parentSpanId: string | null;
  readonly launchKey: string;
  readonly briefing: string;
  readonly profile: TaskProfile;
  readonly settingsRevision: number;
  readonly harness: TaskHarnessName;
  readonly imageRevision: string;
  readonly wrapGraceSeconds: number;
  readonly acceptedOrder: string;
  readonly urgent: boolean;
  readonly state: TaskState;
  readonly terminalCandidate: TaskTerminalState | null;
  readonly terminalReasonCode: string | null;
  readonly finalizationPending: boolean;
  readonly terminalSummary: string | null;
  readonly candidateRevision: string;
  readonly finalizationFailureCode: string | null;
  readonly terminationConfirmedAt: Date | null;
  readonly sealRequest: TaskSealRequest | null;
  readonly sealReceipt: TaskSealReceipt | null;
  readonly acceptedAt: Date;
  readonly updatedAt: Date;
  readonly startedAt: Date | null;
  readonly terminalAt: Date | null;
  readonly attemptId: string;
  readonly launchId: string;
  readonly jobName: string;
  readonly jobUid: string | null;
  readonly templateHash: string | null;
  readonly allocationReceipt: TaskAllocationReceipt | null;
  readonly cleanupPending: boolean;
  readonly softStopRequestedAt: Date | null;
  readonly podUid: string | null;
  readonly tombstonedAt: Date | null;
  readonly slotReserved: boolean;
}

export type TaskRegistryErrorCode =
  | 'workbench_unavailable'
  | 'invalid_input'
  | 'launch_key_conflict'
  | 'not_found'
  | 'invalid_transition'
  | 'intent_conflict'
  | 'storage_error';
export class TaskRegistryError extends Error {
  constructor(
    readonly taskId: string,
    readonly code: TaskRegistryErrorCode
  ) {
    super(`TaskRegistryError: ${taskId} ${code}`);
    this.name = 'TaskRegistryError';
  }
}

export interface TaskAcceptanceService {
  accept(request: AcceptTask): Promise<TaskRecord>;
  read(taskId: string): Promise<TaskRecord | null>;
  /** Recover an already accepted deciding-turn effect without resubmitting its payload. */
  readByLaunchKey(launchKey: string): Promise<TaskRecord | null>;
  list(): Promise<readonly TaskRecord[]>;
}

export interface TaskView extends TaskRecord {
  readonly commands: readonly TaskCommandStatus[];
  readonly question: TaskQuestion | null;
}
export interface TaskService extends TaskAcceptanceService {
  read(taskId: string): Promise<TaskView | null>;
  readCommand(commandId: string): Promise<TaskCommandStatus | null>;
  steer(taskId: string, commandId: string, text: string): Promise<TaskCommand>;
  answer(taskId: string, commandId: string, questionId: string, text: string): Promise<TaskCommand>;
}

/** Trusted lifecycle writer, not a cognition/plugin tool surface. */
export interface TaskRegistry extends TaskAcceptanceService {
  /** Bounded launch/cleanup work page, ordered by immutable accepted order. */
  listLaunchWork(afterOrder?: string, limit?: number): Promise<readonly TaskRecord[]>;
  /** Includes terminal mailbox rows even after signalled_at; cursor is accepted order. */
  listFinalizationWork(afterOrder?: string, limit?: number): Promise<readonly TaskRecord[]>;
  /** Under the mailbox append's task lock, a stored semantic report wins over
   * the proposed compute candidate; an explicit Stop keeps precedence.
   * Candidate + irreversible launch tombstone + canonical revocation commit together. */
  beginFinalization(
    taskId: string,
    launchId: string,
    candidate: TaskFinalizationCandidate
  ): Promise<TaskRecord>;
  /** Caller has observed exact-UID Pod termination/absence, not merely Job completion. */
  confirmComputeTerminated(taskId: string, launchId: string): Promise<TaskRecord>;
  /** Saves the current storage revision and exact keyed request before HTTP. */
  prepareSeal(taskId: string, launchId: string): Promise<TaskRecord>;
  /** Explicit refusal only: missing_result/checksum_mismatch downgrade; revision_conflict
   * retries the same outcome only after proving storage has no frozen operation. */
  abandonSeal(
    taskId: string,
    launchId: string,
    candidateRevision: string,
    reasonCode: string
  ): Promise<TaskRecord>;
  recordSealReceipt(
    taskId: string,
    launchId: string,
    candidateRevision: string,
    receipt: TaskSealReceipt
  ): Promise<TaskRecord>;
  /** Recover only the exact prepared key's immutable module-catalog receipt, if present. */
  recoverSealReceipt(
    taskId: string,
    launchId: string,
    candidateRevision: string
  ): Promise<TaskRecord>;
  /** Requires a receipt, revoked intent and termination; atomically inserts one immutable outbox event. */
  commitFinalization(
    taskId: string,
    launchId: string,
    candidateRevision: string
  ): Promise<TaskOutcomeEvent>;
  setFinalizationPending(taskId: string, launchId: string, code: string): Promise<void>;
  listOutcomeWork(limit?: number): Promise<readonly TaskOutcomeEvent[]>;
  markOutcomeSignalled(outcomeKey: string): Promise<void>;
  /** Fenced exact deterministic-name lookup for orphan reconciliation. */
  readByJobName(jobName: string): Promise<TaskRecord | null>;
  /** Locks the shared admission row; reserves one FIFO task. */
  admitNext(): Promise<TaskRecord | null>;
  /** Persist the exact keyed storage receipt before any Job CREATE. */
  recordAllocation(
    taskId: string,
    launchId: string,
    receipt: TaskAllocationReceipt
  ): Promise<TaskRecord>;
  /** Bind one exact UID/template pair. Never authorizes a tombstoned launch. */
  bindJob(
    taskId: string,
    launchId: string,
    jobUid: string,
    templateHash: string
  ): Promise<TaskRecord>;
  /** Adopt an observed exact UID only for cleanup after tombstone, never execution. */
  bindCleanupJob(
    taskId: string,
    launchId: string,
    jobUid: string,
    templateHash: string
  ): Promise<TaskRecord>;
  /** Irreversible launch stop; re-arms cleanup and clears old termination proof. */
  tombstoneLaunch(taskId: string, launchId: string): Promise<TaskRecord>;
  /** Caller must confirm exact-UID termination/absence; never releases the slot. */
  completeLaunchCleanup(taskId: string, launchId: string): Promise<void>;
  /** Durable request only. Does not claim complete D4 Stop/deadline enforcement. */
  recordSoftStop(taskId: string, launchId: string): Promise<void>;
  /** Caller must have confirmed compute termination, not just a terminal report. */
  releaseSlot(taskId: string): Promise<void>;
  /** Persist observed Job.status.startTime before gateway verified binding. */
  initializeAccessIntent(taskId: string, jobStartedAt: Date): Promise<TaskAccessIntent>;
  readAccessIntent(taskId: string): Promise<TaskAccessIntent | null>;
  advanceAccessIntent(
    taskId: string,
    change: {
      readonly mode: TaskAccessMode;
      readonly softDueAt: Date;
      readonly hardStopAt: Date;
    }
  ): Promise<TaskAccessIntent>;
}
