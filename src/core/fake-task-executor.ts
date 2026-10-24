/** A second, in-memory executor for caller contract checks; never registry authority. */
import { createHash } from 'node:crypto';
import type {
  TaskExecutor,
  TaskLaunch,
  TaskJobObservation,
  TaskSoftStopIntent,
} from './task-executor.js';
import { TaskExecutorError } from './task-executor.js';

export class FakeTaskExecutor implements TaskExecutor {
  private readonly jobs = new Map<
    string,
    { launch: TaskLaunch; observation: TaskJobObservation }
  >();
  private sequence = 0;
  private readonly terminating = new Set<string>();
  private readonly cleaning = new Set<string>();
  readonly calls: { operation: string; taskId: string; launchId: string }[] = [];

  private record(operation: string, launch: TaskLaunch, signal?: AbortSignal): void {
    if (signal?.aborted) throw new TaskExecutorError('aborted');
    this.calls.push({ operation, taskId: launch.task.id, launchId: launch.task.launchId });
  }
  ensureStarted(launch: TaskLaunch, signal?: AbortSignal): Promise<TaskJobObservation> {
    return Promise.resolve().then((): TaskJobObservation => {
      this.record('ensureStarted', launch, signal);
      if (launch.task.tombstonedAt || ['done', 'failed', 'stopped'].includes(launch.task.state))
        throw new TaskExecutorError('invalid_launch');
      const existing = this.match(launch);
      if (existing) return structuredClone(existing);
      if (launch.task.jobUid) throw new TaskExecutorError('bound_job_missing');
      const observation: TaskJobObservation = {
        taskId: launch.task.id,
        launchId: launch.task.launchId,
        jobName: launch.task.jobName,
        jobUid: `fake-${String(++this.sequence)}`,
        resourceVersion: String(this.sequence),
        templateHash: this.hash(launch),
        startedAt: null,
        phase: 'pending',
      };
      this.jobs.set(launch.task.jobName, { launch: structuredClone(launch), observation });
      return structuredClone(observation);
    });
  }
  private hash(launch: TaskLaunch): string {
    const { task } = launch;
    return createHash('sha256')
      .update(
        JSON.stringify({
          taskId: task.id,
          launchId: task.launchId,
          image: launch.workbenchImage,
          spaceId: launch.spaceId,
          profile: task.profile,
          wrapGraceSeconds: task.wrapGraceSeconds,
        })
      )
      .digest('hex');
  }
  private match(launch: TaskLaunch): TaskJobObservation | null {
    const job = this.jobs.get(launch.task.jobName);
    if (!job) return null;
    if (
      job.observation.taskId !== launch.task.id ||
      job.observation.launchId !== launch.task.launchId ||
      (launch.task.jobUid && launch.task.jobUid !== job.observation.jobUid)
    )
      throw new TaskExecutorError('identity_mismatch');
    if (this.hash(launch) !== this.hash(job.launch))
      throw new TaskExecutorError('template_mismatch');
    return job.observation;
  }
  observe(launch: TaskLaunch, signal?: AbortSignal): Promise<TaskJobObservation | null> {
    return Promise.resolve().then((): TaskJobObservation | null => {
      this.record('observe', launch, signal);
      const found = this.match(launch);
      return found ? structuredClone(found) : null;
    });
  }
  requestSoftStop(launch: TaskLaunch, signal?: AbortSignal): Promise<TaskSoftStopIntent> {
    return Promise.resolve().then((): TaskSoftStopIntent => {
      this.record('requestSoftStop', launch, signal);
      return { taskId: launch.task.id, launchId: launch.task.launchId, intent: 'soft-stop' };
    });
  }
  deleteNow(launch: TaskLaunch, signal?: AbortSignal): Promise<void> {
    return Promise.resolve().then(() => {
      this.record('deleteNow', launch, signal);
      if (!launch.task.jobUid) throw new TaskExecutorError('identity_mismatch');
      if (this.match(launch)) this.jobs.delete(launch.task.jobName);
    });
  }
  confirmTerminated(launch: TaskLaunch, signal?: AbortSignal): Promise<boolean> {
    return Promise.resolve().then(() => {
      this.record('confirmTerminated', launch, signal);
      return (
        !this.match(launch) && (!launch.task.jobUid || !this.terminating.has(launch.task.jobUid))
      );
    });
  }
  confirmCleanup(launch: TaskLaunch, signal?: AbortSignal): Promise<boolean> {
    return Promise.resolve().then(() => {
      this.record('confirmCleanup', launch, signal);
      return (
        !this.match(launch) &&
        (!launch.task.jobUid ||
          (!this.terminating.has(launch.task.jobUid) && !this.cleaning.has(launch.task.jobUid)))
      );
    });
  }
  /** Script delayed Pod termination or ephemeral claim GC, independently of Job loss. */
  setTerminationPending(jobUid: string, pending: boolean): void {
    if (pending) this.terminating.add(jobUid);
    else this.terminating.delete(jobUid);
  }
  setCleanupPending(jobUid: string, pending: boolean): void {
    if (pending) this.cleaning.add(jobUid);
    else this.cleaning.delete(jobUid);
  }
  /** Script external progress/loss without teaching production callers another backend. */
  setObservation(
    jobName: string,
    change: Pick<Partial<TaskJobObservation>, 'phase' | 'startedAt' | 'failureReason'>
  ): void {
    const job = this.jobs.get(jobName);
    if (!job) throw new TaskExecutorError('bound_job_missing');
    job.observation = { ...job.observation, ...change, resourceVersion: String(++this.sequence) };
  }
  loseJob(jobName: string): void {
    this.jobs.delete(jobName);
  }
  close(): void {
    this.jobs.clear();
    this.terminating.clear();
    this.cleaning.clear();
  }
}
export function createFakeTaskExecutor(): FakeTaskExecutor {
  return new FakeTaskExecutor();
}
