/** Bounded, untrusted Kubernetes termination evidence; never task authority. */
import { createHash } from 'node:crypto';
import type { TaskRecord } from '../ports/tasks.js';
import type { TraceWriter } from '../ports/observability.js';
import { scrubTraceRecord } from '../storage/postgres-trace-store.js';

type JsonObject = Record<string, unknown>;
function bag(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}
function text(value: unknown, bytes: number): string {
  if (typeof value !== 'string') return '';
  // Normalize terminal controls, including bidi overrides, before storing text.
  // eslint-disable-next-line no-control-regex -- Strip untrusted terminal controls.
  let bounded = Buffer.from(value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' '))
    .subarray(0, bytes)
    .toString('utf8');
  while (Buffer.byteLength(bounded) > bytes) bounded = bounded.slice(0, -1);
  return bounded;
}
function timestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length > 64) return fallback;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
}

export function recordTaskPodTermination(
  task: TaskRecord,
  pod: JsonObject,
  traces?: Pick<TraceWriter, 'enqueue'>
): void {
  if (!traces) return;
  const metadata = bag(pod['metadata']);
  const status = bag(pod['status']);
  const containers = status['containerStatuses'];
  if (!Array.isArray(containers)) return;
  // The controlled Job has one task container. Never retain sidecar output.
  const container: unknown = containers.find((value: unknown) => bag(value)['name'] === 'task');
  const terminated = bag(bag(bag(container)['state'])['terminated']);
  if (!Object.keys(terminated).length) return;
  const now = new Date().toISOString();
  const endedAt = timestamp(terminated['finishedAt'], now);
  const exitCode = Number.isSafeInteger(terminated['exitCode']) ? terminated['exitCode'] : null;
  const record = scrubTraceRecord({
    kind: 'span',
    span: {
      traceId: task.traceId,
      spanId: `${task.launchId}_pod_${createHash('sha256').update(String(metadata['uid'])).digest('hex').slice(0, 16)}`,
      parentSpanId: task.launchId,
      component: 'task.pod',
      startedAt: timestamp(terminated['startedAt'], endedAt),
      endedAt,
      status: exitCode === 0 && status['phase'] !== 'Failed' ? 'ok' : 'failed',
      attrs: {
        taskId: task.id,
        launchId: task.launchId,
        podUid: text(metadata['uid'], 128),
        exitCode,
        reason: text(terminated['reason'], 128),
        // Scrub before the final bound, so truncation cannot split a credential
        // assignment into an unrecognized fragment. Never read command logs.
        terminationMessage: text(terminated['message'], 4096),
        untrusted: true,
      },
    },
  });
  if (record.kind === 'span')
    record.span.attrs['terminationMessage'] = text(record.span.attrs['terminationMessage'], 2048);
  traces.enqueue(record);
}
