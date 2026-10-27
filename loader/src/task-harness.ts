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
  commandId: string;
  text: string;
}

export type TaskHarnessEvent =
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
}
export interface TaskSuccessorEvidence {
  /** Structured, settled tool observations followed by the last final text. */
  updates: Record<string, unknown>[];
  stopReason: 'end_turn';
}
export type TaskEndTurnReconciliation =
  | { state: 'idle' }
  | { state: 'continue'; commandIds: string[] }
  | { state: 'successor'; wait: () => Promise<TaskSuccessorEvidence | undefined> }
  | { state: 'unknown' };

/** Launcher question tools will supply this seam; no MCP dependency here. */
export interface TaskQuestionState {
  isOpen(): boolean;
  waitForChange(signal: AbortSignal): Promise<void>;
}

export interface TaskHarness {
  start(briefing: TaskBriefing): Promise<TaskHarnessResult>;
  abort(): Promise<void>;
  steer(command: TaskSteerCommand): Promise<TaskSteerDisposition>;
  wrap(): Promise<'not_supported'>;
}

/** Deterministic second implementation used by launcher and core contract tests. */
export class ScriptedTaskHarness implements TaskHarness {
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
    if (this.options.waitForAbort && !this.aborted) {
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
      !this.started ||
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
