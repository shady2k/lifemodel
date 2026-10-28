/** Bounded ACP-to-port trace mapping. It never participates in task decisions. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { TaskModelRequest } from './task-model-relay.js';
import {
  emitTaskTrace,
  type TaskHarnessEventSink,
  type TaskHarnessResult,
  type TaskHarnessTraceSpan,
} from './task-harness.js';

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
const text = (value: unknown, tail = false): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const bytes = Buffer.from(value);
  if (bytes.length <= 4000) return value;
  // Drop partial UTF-8 boundary bytes rather than add a replacement character.
  const bounded = tail ? bytes.subarray(-4000) : bytes.subarray(0, 4000);
  return bounded.toString('utf8').replace(tail ? /^\uFFFD+/ : /\uFFFD+$/, '');
};
interface ToolTrace {
  spanId: string;
  startedAt: string;
  startedMono: number;
  endedAt: string | null;
  durationMs: number;
  failed: boolean;
  span: TaskHarnessTraceSpan | undefined;
}

export class AcpTaskTrace {
  private readonly modelId = randomUUID();
  private readonly tools = new Map<string, ToolTrace>();
  private modelStartedAt: string | undefined;
  private modelStartedMono = 0;
  private model = '';
  private requestFailureId: string | undefined;
  private modelEndedAt: string | null = null;
  private modelAttrs: Json = {};
  private usage: Json = {};
  constructor(private readonly sink?: TaskHarnessEventSink) {}

  private safely(action: () => void): void {
    try {
      action();
    } catch {
      // Observability is disposable; even a mapping error cannot fail ACP.
    }
  }
  begin(model: string): void {
    this.safely(() => {
      if (this.modelStartedAt) {
        if (!this.model) this.model = text(model) ?? '';
        return;
      }
      this.model = text(model) ?? '';
      this.modelStartedAt = new Date().toISOString();
      this.modelStartedMono = performance.now();
      this.emitModel(null, null, {});
    });
  }
  reportUsage(value: unknown): void {
    this.safely(() => {
      const usage = record(value);
      // ACP usage/cost reports vary by host. Preserve only finite numeric data.
      for (const key of [
        'inputTokens',
        'outputTokens',
        'totalTokens',
        'cachedReadTokens',
        'cachedWriteTokens',
        'thoughtTokens',
        'used',
        'size',
      ]) {
        const count = usage[key];
        if (typeof count === 'number' && Number.isFinite(count)) this.usage[key] = count;
      }
      const cost = record(usage['cost']);
      if (typeof cost['amount'] === 'number' && Number.isFinite(cost['amount']))
        this.usage['costAmount'] = cost['amount'];
    });
  }
  tool(id: string, tool: Json, outputFailed: boolean): void {
    this.safely(() => {
      this.begin('');
      let entry = this.tools.get(id);
      if (!entry) {
        if (this.tools.size >= 10000) return;
        entry = {
          spanId: randomUUID(),
          startedAt: new Date().toISOString(),
          startedMono: performance.now(),
          endedAt: null,
          durationMs: 0,
          failed: false,
          span: undefined,
        };
        this.tools.set(id, entry);
      }
      const hostStatus = tool['status'];
      const pending = hostStatus === 'pending' || hostStatus === 'in_progress';
      entry.failed ||= outputFailed || (!pending && hostStatus !== 'completed');
      if (!entry.endedAt) entry.durationMs = Math.max(0, performance.now() - entry.startedMono);
      if (!pending) entry.endedAt ??= new Date().toISOString();
      else entry.endedAt = null;
      const input = record(tool['rawInput']);
      const output = tool['rawOutput'];
      const outputRecord = record(output);
      const metadata = record(outputRecord['metadata']);
      const rawExit = metadata['exit'] ?? outputRecord['exitCode'] ?? outputRecord['exit'];
      const content = Array.isArray(tool['content']) ? tool['content'] : [];
      const chunks = content.flatMap((item: unknown) => {
        const block = record(item);
        const nested = record(block['content']);
        const value = nested['text'] ?? block['text'];
        return typeof value === 'string' ? [value.slice(-4000)] : [];
      });
      const outputTail = text(
        typeof output === 'string'
          ? output
          : (outputRecord['output'] ??
              outputRecord['text'] ??
              metadata['output'] ??
              chunks.join('\n')),
        true
      );
      const span: TaskHarnessTraceSpan = {
        spanId: entry.spanId,
        parentSpanId: this.modelId,
        component: 'task.tool',
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        status: pending ? null : entry.failed ? 'failed' : 'ok',
        attrs: {
          toolCallId: text(id) ?? '',
          ...(typeof tool['kind'] === 'string' ? { kind: text(tool['kind']) } : {}),
          ...(typeof tool['title'] === 'string' ? { title: text(tool['title']) } : {}),
          ...(typeof input['command'] === 'string' ? { command: text(input['command']) } : {}),
          hostStatus: text(hostStatus) ?? 'unknown',
          ...(typeof rawExit === 'number' && Number.isFinite(rawExit) ? { exitCode: rawExit } : {}),
          durationMs: entry.durationMs,
          ...(outputTail ? { outputTail } : {}),
        },
      };
      entry.span = span;
      emitTaskTrace(this.sink, span);
    });
  }
  request(request: TaskModelRequest): void {
    this.safely(() => {
      this.requestFailureId = undefined;
      if (!request.failed) return;
      this.begin('');
      const spanId = randomUUID();
      this.requestFailureId = spanId;
      const { startedAt, endedAt, failed: _failed, ...attrs } = request;
      emitTaskTrace(this.sink, {
        spanId,
        parentSpanId: this.modelId,
        component: 'task.model.request',
        startedAt,
        endedAt,
        status: 'failed',
        attrs: { ...attrs, severity: 'warn' },
      });
    });
  }
  providerFailureSpanId(): string | undefined {
    return this.requestFailureId;
  }
  promptError(): void {
    this.safely(() => {
      if (this.requestFailureId) return;
      const now = new Date().toISOString();
      this.request({
        startedAt: now,
        endedAt: now,
        durationMs: 0,
        attempt: 0,
        method: 'ACP',
        path: 'session/prompt',
        status: null,
        failed: true,
        reasonCode: 'acp_prompt_error',
        errorExcerpt: '',
      });
    });
  }
  failModel(reasonCode: string): void {
    this.safely(() => {
      if (!this.modelStartedAt) return;
      this.emitModel(this.modelEndedAt ?? new Date().toISOString(), 'failed', {
        ...this.modelAttrs,
        reasonCode,
      });
    });
  }
  modelSpanId(): string | undefined {
    return this.modelStartedAt ? this.modelId : undefined;
  }
  toolSpanId(id: string): string | undefined {
    return this.tools.get(id)?.spanId;
  }
  finish(
    result: TaskHarnessResult,
    response: Json,
    finalText: string,
    providerFailed: boolean
  ): void {
    this.safely(() => {
      if (!this.modelStartedAt) return;
      this.reportUsage(response['usage']);
      const endedAt = new Date().toISOString();
      // A finished prompt owns no running tools. Reconcile interrupted calls so
      // the reader sees a failed call, not a permanently open trace.
      for (const entry of this.tools.values()) {
        if (entry.endedAt || !entry.span) continue;
        entry.endedAt = endedAt;
        emitTaskTrace(this.sink, {
          ...entry.span,
          endedAt,
          status: result.outcome === 'aborted' ? 'suppressed' : 'failed',
          attrs: {
            ...entry.span.attrs,
            durationMs: Math.max(0, performance.now() - entry.startedMono),
            reasonCode: 'unsettled_tool',
          },
        });
      }
      this.emitModel(
        endedAt,
        result.outcome === 'aborted'
          ? 'suppressed'
          : !providerFailed &&
              response['stopReason'] === 'end_turn' &&
              (result.outcome === 'succeeded' || result.reasonCode === 'required_tool_failed')
            ? 'ok'
            : 'failed',
        { stopReason: text(response['stopReason']) ?? 'unknown' }
      );
      if (finalText.trim())
        emitTaskTrace(this.sink, {
          spanId: randomUUID(),
          parentSpanId: this.modelId,
          component: 'task.completion',
          startedAt: endedAt,
          endedAt,
          status: 'ok',
          attrs: { finalText: text(finalText.trim()) },
        });
    });
  }
  private emitModel(
    endedAt: string | null,
    status: TaskHarnessTraceSpan['status'],
    attrs: Json
  ): void {
    if (!this.modelStartedAt) return;
    this.modelEndedAt = endedAt;
    this.modelAttrs = attrs;
    emitTaskTrace(this.sink, {
      spanId: this.modelId,
      parentSpanId: null,
      component: 'task.model',
      startedAt: this.modelStartedAt,
      endedAt,
      status,
      attrs: {
        model: this.model,
        ...attrs,
        durationMs: Math.max(0, performance.now() - this.modelStartedMono),
        ...this.usage,
      },
    });
  }
}
