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
function callReference(id: string, generation: number): string {
  return `call_${createHash('sha256')
    .update(`${id}\0${String(generation)}`)
    .digest('hex')}`;
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
  let lastTextHasMessageId = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tools = new Map<
    string,
    {
      generation: number;
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
    // Partial-text flushes may split a credential; keep its whole trailing run.
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
        emit(`tool:${id}\0${String(tool.generation)}:error`, {
          role: 'tool',
          text: '',
          tool: {
            callRef: callReference(id, tool.generation),
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
          const content = record(update['content']);
          if (content['type'] !== 'text' || typeof content['text'] !== 'string') return;
          const id = update['messageId'];
          const identified = typeof id === 'string' && id.length > 0;
          if (identified) {
            // An ID-less tail may continue in the next identified chunk.
            if (messageId !== undefined && id !== messageId) flush(lastTextHasMessageId);
            messageId = id;
          }
          if (content['text']) lastTextHasMessageId = identified;
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
          const id = update['toolCallId'];
          const known = typeof id === 'string' ? tools.get(id) : undefined;
          const restarted =
            known !== undefined &&
            known.status !== 'running' &&
            (['pending', 'in_progress', 'running'].includes(update['status'] as string) ||
              update['sessionUpdate'] === 'tool_call');
          // Only new work completes assistant text. Executor patches can arrive mid-word.
          const fresh = typeof id === 'string' && id.length > 0 && (!known || restarted);
          flush(fresh);
          if (typeof id !== 'string' || !id) return;
          const generation = restarted ? known.generation + 1 : (known?.generation ?? 0);
          const previous = restarted ? undefined : known;
          if (!known && tools.size >= 1024) tools.delete(tools.keys().next().value ?? '');
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
            generation,
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
              callRef: callReference(id, generation),
              name,
              input,
              status,
              outputTail,
            },
          } satisfies Omit<TaskTranscriptEntry, 'id' | 'time'>;
          if (shouldEmit) emit(`tool:${id}\0${String(generation)}:${status}`, entry);
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
