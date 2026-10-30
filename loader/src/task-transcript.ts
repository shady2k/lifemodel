/** ACP session excerpt capture. Native naming/output differences belong to adapters. */
import { createHash } from 'node:crypto';
import {
  transcriptSlice,
  transcriptRunSlice,
  transcriptRawTail,
} from '../../src/ports/task-transcript-bounds.mjs';
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
/** Native IDs stay private; all status rows derive the same bounded reference. */
function callReference(id: string): string {
  return `call_${createHash('sha256').update(id).digest('hex')}`;
}
export function createAcpTranscriptMapper(
  sink: TaskHarnessEventSink | undefined,
  mapping: {
    name(tool: Json): string;
    input?(tool: Json): string;
    output(tool: Json): string;
    failed?(tool: Json): boolean;
  }
): TaskTranscriptMapper {
  let pending = '';
  let droppingRun = false;
  let pendingAt: string | undefined;
  let chunk = 0;
  let messageId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tools = new Map<
    string,
    {
      name: string;
      input: string;
      status: 'running' | 'completed' | 'error';
      outputTail: string;
      runningEmitted: boolean;
      emitted: boolean;
    }
  >();
  const seen = new Set<string>();
  const emit = (
    key: string,
    entry: Omit<TaskTranscriptEntry, 'id' | 'time'>,
    time = new Date().toISOString()
  ) => {
    if (seen.size >= 1024) seen.delete(seen.values().next().value ?? '');
    const id = `entry_${createHash('sha256').update(key).digest('hex')}`;
    if (seen.has(id)) return;
    const value = { ...entry, id, time };
    seen.add(id);
    void Promise.resolve()
      .then(() => sink?.({ type: 'transcript', entry: value }))
      .catch(() => undefined);
  };
  const flush = (ended = false, full = false) => {
    clearTimeout(timer);
    timer = undefined;
    if (ended) droppingRun = false;
    if (!pending) return;
    // Size/idle flushes may split a credential; complete message/tool boundaries do not.
    const trailing = ended ? '' : (/\S+$/u.exec(pending)?.[0] ?? '');
    let text = pending.slice(0, pending.length - trailing.length);
    pending = trailing;
    if (Buffer.byteLength(pending) >= 3997 || (full && !text)) {
      text += '…';
      pending = '';
      droppingRun = true;
    }
    if (text)
      emit(`assistant:${String(chunk++)}`, { role: 'assistant', text, tool: null }, pendingAt);
    if (!pending) pendingAt = undefined;
  };
  return {
    completeText() {
      flush(true);
    },
    flush(ended = false) {
      flush(ended);
      if (!ended) return;
      for (const [id, tool] of tools) {
        if (tool.emitted && tool.status !== 'running') continue;
        tool.status = 'error';
        tool.emitted = true;
        emit(`tool:${id}:error`, {
          role: 'tool',
          text: '',
          tool: {
            callRef: callReference(id),
            name: tool.name,
            input: tool.input,
            status: 'error',
            outputTail: tool.outputTail,
          },
        });
      }
    },
    update(value) {
      try {
        const update = record(value);
        if (update['sessionUpdate'] === 'agent_message_chunk') {
          const id = update['messageId'];
          if (typeof id === 'string' && id) {
            if (messageId !== undefined && id !== messageId) flush(true);
            messageId = id;
          }
          const content = record(update['content']);
          if (content['type'] !== 'text' || typeof content['text'] !== 'string') return;
          let rest = content['text'];
          while (rest) {
            if (droppingRun) {
              const whitespace = rest.search(/\s/u);
              if (whitespace < 0) break;
              rest = rest.slice(whitespace);
              droppingRun = false;
            }
            let part = transcriptSlice(rest, 4000 - Buffer.byteLength(pending));
            if (!part.consumed) {
              if (pending) {
                flush(false, true);
                continue;
              }
              // Even malformed UTF-16 must consume original code units.
              const point = rest.codePointAt(0);
              const units = point !== undefined && point > 0xffff ? 2 : 1;
              part = { text: Buffer.from(rest.slice(0, units)).toString('utf8'), consumed: units };
            }
            pendingAt ??= new Date().toISOString();
            pending += part.text;
            rest = rest.slice(part.consumed);
            if (Buffer.byteLength(pending) >= 3997) flush();
          }
          clearTimeout(timer);
          if (pending) {
            timer = setTimeout(() => {
              flush();
            }, 2000);
            timer.unref();
          }
        } else if (['tool_call', 'tool_call_update'].includes(update['sessionUpdate'] as string)) {
          flush(true);
          const id = update['toolCallId'];
          if (typeof id !== 'string') return;
          const previous = tools.get(id);
          if (!previous && tools.size >= 1024) tools.delete(tools.keys().next().value ?? '');
          const name =
            previous?.name && previous.name !== 'tool'
              ? previous.name
              : transcriptText(mapping.name(update), 128);
          // Preserve whole credentials for the channel scrubber, within its raw queue budget.
          const input = transcriptRunSlice(mapping.input?.(update) || previous?.input || '', 4000);
          const status =
            update['status'] == null
              ? (previous?.status ?? 'running')
              : update['status'] === 'failed' || mapping.failed?.(update)
                ? 'error'
                : update['status'] === 'completed'
                  ? 'completed'
                  : 'running';
          const outputTail = transcriptRawTail(
            mapping.output(update) || previous?.outputTail || '',
            4000
          );
          const shouldEmit =
            update['status'] !== 'pending' &&
            (previous?.status !== status || (status === 'running' && !previous?.runningEmitted));
          tools.set(id, {
            name,
            input,
            status,
            outputTail,
            emitted: previous?.emitted === true || shouldEmit,
            runningEmitted:
              previous?.runningEmitted === true || (shouldEmit && status === 'running'),
          });
          const entry = {
            role: 'tool' as const,
            text: '',
            tool: {
              callRef: callReference(id),
              name,
              input,
              status,
              outputTail,
            },
          } satisfies Omit<TaskTranscriptEntry, 'id' | 'time'>;
          if (shouldEmit) emit(`tool:${id}:${status}`, entry);
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
