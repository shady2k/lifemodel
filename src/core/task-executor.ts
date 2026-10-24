/** Infrastructure port only. Registry, allocation and tombstone checks belong to its caller. */
import type { TaskRecord } from '../ports/tasks.js';

export interface TaskLaunch {
  readonly task: TaskRecord;
  readonly spaceId: string;
  readonly workbenchImage: string;
}

export interface TaskJobObservation {
  readonly taskId: string;
  readonly launchId: string;
  readonly jobName: string;
  readonly jobUid: string;
  readonly resourceVersion: string;
  readonly templateHash: string;
  readonly startedAt: Date | null;
  readonly phase: 'pending' | 'running' | 'succeeded' | 'failed' | 'deleting';
  /** Runtime failure evidence only; never a semantic task outcome. */
  readonly failureReason?: 'compute_missing' | 'pod_failed';
}

export interface TaskSoftStopIntent {
  readonly taskId: string;
  readonly launchId: string;
  readonly intent: 'soft-stop';
}

export interface TaskExecutor {
  ensureStarted(launch: TaskLaunch, signal?: AbortSignal): Promise<TaskJobObservation>;
  observe(launch: TaskLaunch, signal?: AbortSignal): Promise<TaskJobObservation | null>;
  /** Intent only: the durable control caller owns wrapping and deadline enforcement. */
  requestSoftStop(launch: TaskLaunch, signal?: AbortSignal): Promise<TaskSoftStopIntent>;
  /** Caller must persist irreversible cleanup intent before invoking this operation. */
  deleteNow(launch: TaskLaunch, signal?: AbortSignal): Promise<void>;
  /** Job absence alone is insufficient: exact-UID-owned Pods must no longer run. */
  confirmTerminated(launch: TaskLaunch, signal?: AbortSignal): Promise<boolean>;
  /** Separate from compute: also wait for Pod and generic ephemeral claim removal. */
  confirmCleanup(launch: TaskLaunch, signal?: AbortSignal): Promise<boolean>;
}

export type TaskExecutorErrorCode =
  | 'invalid_launch'
  | 'identity_mismatch'
  | 'template_mismatch'
  | 'bound_job_missing'
  | 'api_error'
  | 'transport_error'
  | 'aborted';

/** Never retains API bodies, tokens, URLs, private task input or transport causes. */
export class TaskExecutorError extends Error {
  constructor(readonly code: TaskExecutorErrorCode) {
    super(`TaskExecutorError: ${code}`);
    this.name = 'TaskExecutorError';
  }
}
