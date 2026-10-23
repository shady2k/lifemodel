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

export interface TaskRecord {
  readonly id: string;
  readonly launchKey: string;
  readonly briefing: string;
  readonly profile: TaskProfile;
  readonly settingsRevision: number;
  readonly harness: 'opencode' | 'prime-agent';
  readonly imageRevision: string;
  readonly wrapGraceSeconds: number;
  readonly acceptedOrder: string;
  readonly urgent: boolean;
  readonly state: TaskState;
  readonly terminalCandidate: TaskTerminalState | null;
  readonly terminalReasonCode: string | null;
  readonly finalizationPending: boolean;
  readonly acceptedAt: Date;
  readonly updatedAt: Date;
  readonly startedAt: Date | null;
  readonly terminalAt: Date | null;
  readonly attemptId: string;
  readonly launchId: string;
  readonly jobName: string;
  readonly jobUid: string | null;
  readonly podUid: string | null;
  readonly tombstonedAt: Date | null;
  readonly slotReserved: boolean;
}

export type TaskRegistryErrorCode =
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

export interface TaskService {
  accept(request: AcceptTask): Promise<TaskRecord>;
  read(taskId: string): Promise<TaskRecord | null>;
  list(): Promise<readonly TaskRecord[]>;
}

/** Trusted lifecycle writer, not a cognition/plugin tool surface. */
export interface TaskRegistry extends TaskService {
  /** Locks the shared admission row; reserves one FIFO task. */
  admitNext(): Promise<TaskRecord | null>;
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
