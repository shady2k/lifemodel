/** ACP session excerpt capture. Native naming/output differences belong to adapters. */
import { createHash } from 'node:crypto';
import { transcriptSlice } from '../../src/ports/task-transcript-bounds.mjs';
import type {
  TaskHarnessEventSink,
  TaskTranscriptEntry,
  TaskTranscriptMapper,
} from './task-harness.js';
type Json = Record<string, unknown>;
const record = (v: unknown): Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
export function transcriptText(value: string, bytes = 4000, tail = false): string {
  return transcriptSlice(value, bytes, tail).text;
}
export function createAcpTranscriptMapper(
  sink: TaskHarnessEventSink | undefined,
  mapping: { name(tool: Json): string; output(tool: Json): string; failed?(tool: Json): boolean }
): TaskTranscriptMapper {
  let pending = '';
  let chunk = 0;
  let messageId: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tools = new Map<
    string,
    { name: string; status: 'running' | 'completed' | 'error'; outputTail: string }
  >();
  const seen = new Set<string>();
  const emit = (key: string, entry: Omit<TaskTranscriptEntry, 'id' | 'time'>) => {
    if (seen.size >= 1024) seen.delete(seen.values().next().value ?? '');
    const id = `entry_${createHash('sha256').update(key).digest('hex')}`;
    if (seen.has(id)) return;
    const value = { ...entry, id, time: new Date().toISOString() };
    seen.add(id);
    void Promise.resolve()
      .then(() => sink?.({ type: 'transcript', entry: value }))
      .catch(() => undefined);
  };
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    emit(`assistant:${String(chunk++)}`, {
      role: 'assistant',
      text: transcriptText(pending),
      tool: null,
    });
    pending = '';
  };
  return {
    flush,
    update(value) {
      try {
        const update = record(value);
        if (update['sessionUpdate'] === 'agent_message_chunk') {
          if (update['messageId'] !== undefined && update['messageId'] !== messageId) flush();
          messageId = update['messageId'];
          const content = record(update['content']);
          if (content['type'] !== 'text' || typeof content['text'] !== 'string') return;
          let rest = content['text'];
          while (rest) {
            let part = transcriptSlice(rest, 4000 - Buffer.byteLength(pending));
            if (!part.consumed) {
              if (pending) {
                flush();
                continue;
              }
              // Even malformed UTF-16 must consume original code units.
              const point = rest.codePointAt(0);
              const units = point !== undefined && point > 0xffff ? 2 : 1;
              part = { text: Buffer.from(rest.slice(0, units)).toString('utf8'), consumed: units };
            }
            pending += part.text;
            rest = rest.slice(part.consumed);
            if (Buffer.byteLength(pending) >= 3997) flush();
          }
          if (pending && !timer) {
            timer = setTimeout(flush, 250);
            timer.unref();
          }
        } else if (['tool_call', 'tool_call_update'].includes(update['sessionUpdate'] as string)) {
          flush();
          const id = update['toolCallId'];
          if (typeof id !== 'string') return;
          const previous = tools.get(id);
          if (!previous && tools.size >= 1024) tools.delete(tools.keys().next().value ?? '');
          const hasName = ['name', 'title', 'kind'].some((key) => typeof update[key] === 'string');
          const name = transcriptText(
            hasName ? mapping.name(update) : (previous?.name ?? mapping.name(update)),
            128
          );
          const status =
            update['status'] == null
              ? (previous?.status ?? 'running')
              : update['status'] === 'failed' || mapping.failed?.(update)
                ? 'error'
                : update['status'] === 'completed'
                  ? 'completed'
                  : 'running';
          const outputTail = transcriptText(
            mapping.output(update) || previous?.outputTail || '',
            2000,
            true
          );
          tools.set(id, { name, status, outputTail });
          const entry = {
            role: 'tool' as const,
            text: '',
            tool: {
              name,
              status,
              outputTail,
            },
          } satisfies Omit<TaskTranscriptEntry, 'id' | 'time'>;
          if (previous?.status !== status) emit(`tool:${id}:${status}`, entry);
        }
      } catch {
        /* Capture cannot fail a task. */
      }
    },
  };
}
export function acpToolOutput(tool: Json): string {
  const output = tool['rawOutput'];
  if (typeof output === 'string') return output;
  const raw = record(output);
  const metadata = record(raw['metadata']);
  const text = raw['output'] ?? raw['text'] ?? metadata['output'];
  if (typeof text === 'string') return text;
  const content = Array.isArray(output)
    ? output
    : Array.isArray(tool['content'])
      ? tool['content']
      : [];
  return content
    .slice(-16)
    .map((item) => {
      const part = record(item);
      const nested = record(part['content']);
      return nested['text'] ?? part['text'] ?? '';
    })
    .filter((v) => typeof v === 'string')
    .join('\n');
}
