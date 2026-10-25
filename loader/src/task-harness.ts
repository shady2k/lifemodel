/** Pod-local harness port. Raw provider/session APIs never cross this boundary. */
export interface TaskBriefing {
  text: string;
  model: string;
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

export type TaskHarnessEvent =
  | { type: 'step'; text: string }
  | { type: 'tool'; name: string; status: 'running' | 'completed' | 'error' }
  | { type: 'error'; code: string }
  | { type: 'trace'; span: TaskHarnessTraceSpan };

export interface TaskHarnessResult {
  outcome: 'succeeded' | 'failed' | 'aborted';
  result: string;
  reasonCode?: string;
  /** Culprit span, when recorded; required_tool_failed names its exact tool. */
  failureSpanId?: string;
}

export type TaskHarnessEventSink = (event: TaskHarnessEvent) => void | Promise<void>;

export interface TaskHarness {
  start(briefing: TaskBriefing): Promise<TaskHarnessResult>;
  abort(): Promise<void>;
  steer(text: string): Promise<'not_supported'>;
  wrap(): Promise<'not_supported'>;
}

/** Deterministic second implementation used by launcher and core contract tests. */
export class ScriptedTaskHarness implements TaskHarness {
  private started = false;
  private aborted = false;
  private release: (() => void) | undefined;

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

  steer(_text: string): Promise<'not_supported'> {
    return Promise.resolve('not_supported');
  }
  wrap(): Promise<'not_supported'> {
    return Promise.resolve('not_supported');
  }
}
