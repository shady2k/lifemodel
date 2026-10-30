/** Pod-local harness port. Raw provider/session APIs never cross this boundary. */
export interface TaskBriefing {
  text: string;
  model: string;
  /** Accepted task deadline, from TaskAccessIntent, never a fresh per-turn budget. */
  softDueAt?: string;
}

export interface TaskHarnessTraceSpan {
  spanId: string;
  /** Null binds the span to the launcher's task root. */
  parentSpanId: string | null;
  component: string;
  startedAt: string;
  endedAt: string | null;
  status: null | 'ok' | 'failed' | 'suppressed';
  attrs: Record<string, unknown>;
}

/** Trace callbacks are best effort and must never gate protocol or outcome. */
export function emitTaskTrace(
  sink: TaskHarnessEventSink | undefined,
  span: TaskHarnessTraceSpan
): void {
  void Promise.resolve()
    .then(() => sink?.({ type: 'trace', span }))
    .catch(() => undefined);
}

export type TaskSteerDisposition = 'accepted' | 'rejected' | 'uncertain';
export interface TaskSteerCommand {
  kind?: 'steer' | 'answer';
  commandId: string;
  text: string;
}

export interface TaskTranscriptEntry {
  id: string;
  role: 'assistant' | 'tool' | 'steer' | 'answer' | 'user-briefing';
  time: string;
  text: string;
  tool: {
    name: string;
    input?: string;
    status: 'running' | 'completed' | 'error';
    outputTail: string;
  } | null;
}
export interface TaskTranscriptMapper {
  update(value: unknown): void;
  /** End-of-session also records calls that never left pending. */
  flush(ended?: boolean): void;
}
export type TaskHarnessEvent =
  | { type: 'transcript'; entry: TaskTranscriptEntry }
  | { type: 'step'; text: string }
  | { type: 'tool'; name: string; status: 'running' | 'completed' | 'error' }
  | { type: 'error'; code: string }
  | {
      type: 'receipt';
      commandId: string;
      disposition: 'inserted' | 'deferred-to-next-turn' | 'failed' | 'uncertain';
    }
  | { type: 'trace'; span: TaskHarnessTraceSpan };

export interface TaskHarnessResult {
  outcome: 'succeeded' | 'failed' | 'aborted';
  result: string;
  reasonCode?: string;
  /** Culprit span, when recorded; required_tool_failed names its exact tool. */
  failureSpanId?: string;
}

export type TaskHarnessEventSink = (event: TaskHarnessEvent) => void | Promise<void>;

/** Native reconciliation stays behind the registry adapter. No raw native data. */
export interface TaskEndTurnInput {
  workDirectory: string;
  sessionId: string;
  commandIds: string[];
  signal: AbortSignal;
  /** Positive insertion receipts observed before this barrier. */
  insertedCommandIds?: string[];
  /** IDs already given one plain continuation, never resent. */
  continuedCommandIds?: string[];
}
export interface TaskSuccessorControl {
  /** Close synchronously, then settle journal admissions and return their IDs. */
  closeIntake(): Promise<string[]>;
  reopenIntake(): void;
}
export type TaskSuccessorUpdate =
  | { kind: 'inserted'; commandId: string; text: string; insertedAt?: string }
  | { kind: 'reset' }
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      id: string;
      status: 'in_progress' | 'completed' | 'failed';
      name?: string;
      input?: unknown;
      output?: unknown;
    };
export interface TaskSuccessorEvidence {
  /** Adapter-neutral, ordered observations; no native protocol shapes. */
  updates: TaskSuccessorUpdate[];
  stopReason: 'end_turn';
}
export type TaskEndTurnReconciliation =
  | { state: 'idle'; insertedCommandIds?: string[]; insertedAt?: Record<string, string> }
  | {
      state: 'continue';
      commandIds: string[];
      insertedCommandIds?: string[];
      insertedAt?: Record<string, string>;
    }
  | {
      state: 'successor';
      wait: (control: TaskSuccessorControl) => Promise<TaskSuccessorEvidence | undefined>;
    }
  | { state: 'unknown' };

/** Launcher question tools supply this seam; no MCP dependency here.
 * isOpen is a synchronous level check for one outstanding question.
 * waitForChange subscribes to changes after registration, resolves on a change
 * or abort, and releases listeners on abort. It must not spin on an unchanged
 * level. The answer dispatcher closes the local question only after its text
 * was admitted; a committed core answer alone is not native delivery.
 */
export interface TaskQuestionState {
  isOpen(): boolean;
  waitForChange(signal: AbortSignal): Promise<void>;
}

export interface TaskHarness {
  /** Resolves only after the brief is written and native steering is installed.
   * If execution ends before opening intake this stays pending; the launcher
   * cancels its wait when execution ends. It is not a promise of obedience.
   */
  readonly intakeReady: Promise<void>;
  start(briefing: TaskBriefing): Promise<TaskHarnessResult>;
  abort(): Promise<void>;
  steer(command: TaskSteerCommand): Promise<TaskSteerDisposition>;
  wrap(): Promise<'not_supported'>;
}

/** Deterministic second implementation used by launcher and core contract tests. */
export class ScriptedTaskHarness implements TaskHarness {
  private readonly intake: PromiseWithResolvers<void> = Promise.withResolvers();
  readonly intakeReady = this.intake.promise;
  private intakeOpen = false;
  private started = false;
  private aborted = false;
  private release: (() => void) | undefined;
  private readonly commands = new Map<string, string>();

  constructor(
    private readonly options: {
      onEvent?: TaskHarnessEventSink;
      events?: TaskHarnessEvent[];
      terminal?: TaskHarnessResult;
      waitForAbort?: boolean;
      beforeIntake?: Promise<void>;
    } = {}
  ) {}

  async start(_briefing: TaskBriefing): Promise<TaskHarnessResult> {
    if (this.started) throw new Error('harness_already_started');
    this.started = true;
    for (const event of this.options.events ?? [{ type: 'step', text: 'Running task' }]) {
      if (this.aborted) break;
      if (event.type === 'trace') emitTaskTrace(this.options.onEvent, event.span);
      else await this.options.onEvent?.(event);
    }
    await this.options.beforeIntake;
    if (this.options.waitForAbort && !this.aborted) {
      this.intakeOpen = true;
      this.intake.resolve();
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return this.aborted
      ? { outcome: 'aborted', result: '', reasonCode: 'aborted' }
      : (this.options.terminal ?? { outcome: 'succeeded', result: 'Task completed.' });
  }

  abort(): Promise<void> {
    this.aborted = true;
    this.release?.();
    return Promise.resolve();
  }

  steer(command: TaskSteerCommand): Promise<TaskSteerDisposition> {
    if (
      !this.intakeOpen ||
      this.aborted ||
      !this.options.waitForAbort ||
      !command.commandId ||
      !command.text.trim()
    )
      return Promise.resolve('rejected');
    const previous = this.commands.get(command.commandId);
    if (previous !== undefined)
      return Promise.resolve(previous === command.text ? 'accepted' : 'rejected');
    this.commands.set(command.commandId, command.text);
    void Promise.resolve()
      .then(() =>
        this.options.onEvent?.({
          type: 'transcript',
          entry: {
            id: `inserted_${command.commandId}`,
            role: command.kind ?? 'steer',
            time: new Date().toISOString(),
            text: command.text.slice(0, 1000),
            tool: null,
          },
        })
      )
      .catch(() => undefined);
    void Promise.resolve()
      .then(() =>
        this.options.onEvent?.({
          type: 'receipt',
          commandId: command.commandId,
          disposition: 'inserted',
        })
      )
      .catch(() => undefined);
    return Promise.resolve('accepted');
  }
  wrap(): Promise<'not_supported'> {
    return Promise.resolve('not_supported');
  }
}
