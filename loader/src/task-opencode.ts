import type { TaskEndTurnInput, TaskEndTurnReconciliation } from './task-harness.js';
/** OpenCode v2 configuration only. The protocol client is generic ACP. */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { connect } from 'node:net';

export function configureAgent(input: {
  workDirectory: string;
  configFile: string;
  relayBaseURL: string;
}): NodeJS.ProcessEnv {
  return {
    OPENCODE_CONFIG: input.configFile,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: 'lifemodel/task',
      plugins: ['-opencode.browser', '/etc/lifemodel/steering-plugin'],
      providers: {
        lifemodel: {
          name: 'Task gateway',
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: input.relayBaseURL, apiKey: 'task-relay' },
          models: {
            task: {
              name: 'Task',
              capabilities: { tools: true, input: ['text'], output: ['text'] },
              limit: { context: 128000, output: 16000 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
    }),
    LIFEMODEL_STEER_SOCKET: join(input.workDirectory, '.launcher/steer.sock'),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_FILEWATCHER: 'true',
    OPENCODE_DISABLE_FFF: 'true',
    XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'] ?? '/etc/lifemodel/xdg',
    XDG_CACHE_HOME: join(input.workDirectory, 'home/.cache'),
    XDG_DATA_HOME: join(input.workDirectory, 'home/.local/share'),
    XDG_STATE_HOME: join(input.workDirectory, 'home/.local/state'),
  };
}

/** v2's completed shell call may still carry a failed process exit. */
export function toolOutputFailed(output: unknown, input?: unknown): boolean {
  // Background commands do not carry their eventual exit in the prompt's ACP
  // terminal. Record uncertainty as failed tool evidence. The generic ACP
  // classifier decides whether later agent work recovered that observation.
  if (
    input &&
    typeof input === 'object' &&
    (input as Record<string, unknown>)['background'] === true
  )
    return true;
  if (!output || typeof output !== 'object') return false;
  const metadata = (output as Record<string, unknown>)['metadata'];
  if (!metadata || typeof metadata !== 'object') return false;
  const value = metadata as Record<string, unknown>;
  return (
    (Object.hasOwn(value, 'exit') && value['exit'] !== 0) ||
    Boolean(value['signal']) ||
    Boolean(value['timeout']) ||
    value['status'] === 'running'
  );
}

// Stable IDs make native ambiguity nonfatal. Journal I/O remains fatal.
export const failOnUncertain = false;

/** Native identity is stable per command, including after an ambiguous ACK. */
export function nativeMessageId(commandId: string): string {
  return `msg_${createHash('sha256').update(commandId).digest('hex')}`;
}

/** A socket failure can follow native admission, so it is never a rejection. */
export async function admit(input: {
  workDirectory: string;
  sessionId: string;
  commandId: string;
  text: string;
}): Promise<'accepted' | 'rejected' | 'uncertain'> {
  if (!input.sessionId || !input.commandId || !input.text.trim()) return 'rejected';
  const id = nativeMessageId(input.commandId);
  return new Promise((resolve) => {
    const socket = connect(join(input.workDirectory, '.launcher/steer.sock'));
    let buffer = '';
    let done = false;
    const finish = (result: 'accepted' | 'uncertain') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish('uncertain');
    }, 5000);
    socket.once('error', () => {
      finish('uncertain');
    });
    socket.once('close', () => {
      finish('uncertain');
    });
    socket.once('connect', () =>
      socket.write(
        JSON.stringify({
          op: 'steer',
          sessionID: input.sessionId,
          id,
          text: input.text,
        }) + '\n'
      )
    );
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > 1048576) {
        finish('uncertain');
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const result = JSON.parse(buffer.slice(0, end)) as { ok?: boolean; data?: { id?: string } };
        finish(result.ok === true && result.data?.id === id ? 'accepted' : 'uncertain');
      } catch {
        finish('uncertain');
      }
    });
  });
}

/** Observe delivery independently of admission; missing evidence is not insertion. */
export async function observeInsertion(input: {
  workDirectory: string;
  commandId: string;
  signal: AbortSignal;
}): Promise<boolean> {
  const id = nativeMessageId(input.commandId);
  // Bounded best-effort observation with backoff; no native sends here.
  for (let pass = 0; pass < 12 && !input.signal.aborted; pass++) {
    const inserted = await new Promise<boolean>((resolve) => {
      const socket = connect(join(input.workDirectory, '.launcher/steer.sock'));
      let buffer = '';
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        input.signal.removeEventListener('abort', cancel);
        socket.destroy();
        resolve(value);
      };
      const cancel = () => {
        finish(false);
      };
      const timer = setTimeout(cancel, 1000);
      input.signal.addEventListener('abort', cancel, { once: true });
      socket.once('error', cancel);
      socket.once('close', cancel);
      socket.once('connect', () => socket.write(JSON.stringify({ op: 'disposition', id }) + '\n'));
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        if (Buffer.byteLength(buffer) > 1048576) {
          finish(false);
          return;
        }
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, end)) as {
            ok?: boolean;
            data?: { id?: string; status?: string };
          };
          finish(
            response.ok === true && response.data?.id === id && response.data.status === 'inserted'
          );
        } catch {
          finish(false);
        }
      });
      if (input.signal.aborted) cancel();
    });
    if (inserted) return true;
    if (input.signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.min(100 * 2 ** pass, 5000));
      function done() {
        clearTimeout(timer);
        input.signal.removeEventListener('abort', done);
        resolve();
      }
      input.signal.addEventListener('abort', done, { once: true });
      if (input.signal.aborted) done();
    });
  }
  return false;
}

/** Reconcile every admitted stable ID after intake has closed. */
export async function reconcileEndTurn(
  input: TaskEndTurnInput
): Promise<TaskEndTurnReconciliation> {
  const pending: string[] = [];
  for (const commandId of input.commandIds) {
    const id = nativeMessageId(commandId);
    const status = await new Promise<string>((resolve) => {
      const socket = connect(join(input.workDirectory, '.launcher/steer.sock'));
      let buffer = '';
      let done = false;
      const finish = (value: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        input.signal.removeEventListener('abort', cancel);
        socket.destroy();
        resolve(value);
      };
      const cancel = () => {
        finish('unknown');
      };
      const timer = setTimeout(cancel, 5000);
      input.signal.addEventListener('abort', cancel, { once: true });
      socket.setEncoding('utf8');
      socket.once('error', cancel);
      socket.once('close', cancel);
      socket.once('connect', () => socket.write(JSON.stringify({ op: 'disposition', id }) + '\n'));
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1048576) {
          cancel();
          return;
        }
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        try {
          const reply = JSON.parse(buffer.slice(0, end)) as {
            ok?: boolean;
            data?: { id?: string; status?: string };
          };
          finish(
            reply.ok === true && reply.data?.id === id
              ? (reply.data.status ?? 'unknown')
              : 'unknown'
          );
        } catch {
          cancel();
        }
      });
      if (input.signal.aborted) cancel();
    });
    if (status === 'pending') {
      if (input.continuedCommandIds?.includes(commandId)) return { state: 'unknown' };
      pending.push(commandId);
    } else if (status !== 'inserted') return { state: 'unknown' };
  }
  return pending.length ? { state: 'continue', commandIds: pending } : { state: 'idle' };
}
