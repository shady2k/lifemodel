import type { TaskArtifactReader } from '../ports/task-artifact-download.js';
import { ARTIFACT_ID } from '../ports/task-artifact-download.js';
import type { TaskFileView, TaskRecord } from '../ports/tasks.js';
import { isTaskOutputName } from '../ports/tasks.js';
import { TASK_REPORT_NAME } from '../ports/task-output-names.mjs';

export const TASK_FILE_HEAD_BYTES = 8192;

export class TaskFileReadError extends Error {
  constructor(
    readonly code: 'invalid_file_name' | 'file_not_delivered' | 'file_not_text' | 'file_unavailable'
  ) {
    super(code);
    this.name = 'TaskFileReadError';
  }
}

/** Resolve a name only through a terminal task's sealed, owner-facing manifest. */
export async function readDeliveredTaskFile(
  task: TaskRecord,
  name: string,
  reader: TaskArtifactReader | undefined
): Promise<TaskFileView> {
  if (name !== TASK_REPORT_NAME && !isTaskOutputName(name))
    throw new TaskFileReadError('invalid_file_name');
  if (!['done', 'failed', 'stopped'].includes(task.state) || task.sealReceipt?.state !== 'sealed')
    throw new TaskFileReadError('file_not_delivered');
  const matches = task.sealReceipt.manifest.objects.filter(
    (object) => object.name === name && (object.mark === 'result' || object.mark === 'artifact')
  );
  const object = matches[0];
  if (matches.length !== 1 || !object) throw new TaskFileReadError('file_not_delivered');
  if (
    !ARTIFACT_ID.test(object.id) ||
    !Number.isSafeInteger(object.size) ||
    object.size < 0 ||
    typeof task.sealReceipt.space !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(task.sealReceipt.space)
  )
    throw new TaskFileReadError('file_unavailable');
  if (!reader) throw new TaskFileReadError('file_unavailable');
  const expected = Math.min(object.size, TASK_FILE_HEAD_BYTES);
  const signal = AbortSignal.timeout(10_000);
  try {
    const opened = await reader.openTaskArtifact(
      object.id,
      expected === 0 ? undefined : `bytes=0-${String(expected - 1)}`,
      signal,
      task.sealReceipt.space
    );
    const cancel = () => opened.body.destroy(new Error('task_file_deadline'));
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      if (
        opened.size !== object.size ||
        opened.start !== 0 ||
        opened.end !== expected - 1 ||
        opened.partial !== expected > 0
      )
        throw new TaskFileReadError('file_unavailable');
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of opened.body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        received += bytes.length;
        if (received > expected) throw new TaskFileReadError('file_unavailable');
        chunks.push(bytes);
      }
      if (received !== expected) throw new TaskFileReadError('file_unavailable');
      const truncated = object.size > expected;
      let text: string;
      try {
        // A head may end within a valid multibyte character. Streaming decode
        // omits only that incomplete suffix; malformed sequences still fail.
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks), {
          stream: truncated,
        });
      } catch {
        throw new TaskFileReadError('file_not_text');
      }
      // eslint-disable-next-line no-control-regex -- Binary/control bytes are not task prose.
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text))
        throw new TaskFileReadError('file_not_text');
      return { name, size: object.size, bytesRead: received, truncated, text };
    } finally {
      signal.removeEventListener('abort', cancel);
      opened.body.destroy();
    }
  } catch (error) {
    if (error instanceof TaskFileReadError) throw error;
    throw new TaskFileReadError('file_unavailable');
  }
}
