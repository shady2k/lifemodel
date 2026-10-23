/** OpenCode 1.19.4 loopback HTTP/SSE adapter.
 * Source contract: packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/session.ts,
 * handlers/event.ts and packages/schema/src/v1/session.ts at tag v1.19.4.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createTaskModelRelay } from './task-model-relay.js';
import { TASK_PROCESS_SUPERVISOR } from './task-process.js';
import type {
  TaskBriefing,
  TaskHarness,
  TaskHarnessEventSink,
  TaskHarnessResult,
} from './task-harness.js';

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};

/** Inspect durable session messages, not a process exit code or step-finish event.
 * Conservative policy: any failed tool in this single turn remains required.
 * A later prose apology does not resolve it. Shell nonzero exits are represented
 * by OpenCode as completed tools with metadata.exit, so inspect that too.
 */
export function openCodeSemanticResult(
  messages: unknown,
  providerFailed = false
): TaskHarnessResult {
  const failed = (reasonCode: string): TaskHarnessResult => ({
    outcome: 'failed',
    result: '',
    reasonCode,
  });
  if (!Array.isArray(messages)) return failed('harness_protocol_error');
  let final: Json | undefined;
  let result = '';
  for (const raw of messages) {
    const message = record(raw);
    const info = record(message['info']);
    if (info['role'] !== 'assistant') continue;
    if (info['error']) {
      return record(info['error'])['name'] === 'MessageAbortedError'
        ? { outcome: 'aborted', result: '', reasonCode: 'aborted' }
        : failed('provider_error');
    }
    const parts = Array.isArray(message['parts']) ? message['parts'] : [];
    for (const rawPart of parts) {
      const part = record(rawPart);
      if (part['type'] !== 'tool') continue;
      const state = record(part['state']);
      const metadata = record(state['metadata']);
      if (
        state['status'] !== 'completed' ||
        (Object.hasOwn(metadata, 'exit') && metadata['exit'] !== 0)
      ) {
        return failed('required_tool_failed');
      }
    }
    final = info;
    result = parts
      .map(record)
      .filter((part) => part['type'] === 'text' && !part['ignored'] && !part['synthetic'])
      .map((part) => (typeof part['text'] === 'string' ? part['text'] : ''))
      .join('\n')
      .trim();
  }
  if (providerFailed) return failed('provider_error');
  if (!final || !record(final['time'])['completed'] || final['finish'] !== 'stop' || !result) {
    return failed('no_final_result');
  }
  return { outcome: 'succeeded', result };
}

export interface OpenCodeTaskHarnessOptions {
  modelEndpoint: string;
  modelTokenFile: string;
  modelCaFile: string;
  workDirectory?: string;
  onEvent?: TaskHarnessEventSink;
  binary?: string;
  configFile?: string;
  timeoutMs?: number;
  /** Storage capability for tool subprocesses; never model/channel credentials. */
  storageEnv?: {
    LIFEMODEL_STORAGE_ENDPOINT: string;
    LIFEMODEL_STORAGE_SPACE: string;
    LIFEMODEL_STORAGE_TOKEN_FILE: string;
    LIFEMODEL_STORAGE_CA_FILE: string;
  };
}

export class OpenCodeTaskHarness implements TaskHarness {
  private started = false;
  private aborted = false;
  private readonly cancellation = new AbortController();
  private origin: string | undefined;
  private sessionID: string | undefined;

  constructor(private readonly options: OpenCodeTaskHarnessOptions) {}

  async steer(_text: string): Promise<'not_supported'> {
    return 'not_supported';
  }
  async wrap(): Promise<'not_supported'> {
    return 'not_supported';
  }

  async abort(): Promise<void> {
    this.aborted = true;
    // Cancel the local wait first. Teardown remains bounded if the server hangs.
    this.cancellation.abort();
    if (this.origin && this.sessionID) {
      try {
        const response = await fetch(`${this.origin}/session/${this.sessionID}/abort`, {
          method: 'POST',
          headers: { connection: 'close' },
          signal: AbortSignal.timeout(2_000),
        });
        await response.body?.cancel();
      } catch {
        /* Best effort; start's finally kills the entire process group. */
      }
    }
  }

  async start(briefing: TaskBriefing): Promise<TaskHarnessResult> {
    if (this.started) throw new Error('harness_already_started');
    this.started = true;
    if (this.aborted) return { outcome: 'aborted', result: '', reasonCode: 'aborted' };
    const timeoutMs = this.options.timeoutMs ?? 3_600_000;
    const signal = AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(timeoutMs)]);
    const eventsStop = new AbortController();
    let child: ChildProcess | undefined;
    let relay: Awaited<ReturnType<typeof createTaskModelRelay>> | undefined;
    let events: Promise<void> | undefined;
    let providerFailed = false;
    let processFailed = false;
    const run = async (): Promise<TaskHarnessResult> => {
      try {
        const work = this.options.workDirectory ?? '/work';
        await Promise.all(
          ['home', 'tmp'].map((name) => mkdir(join(work, name), { recursive: true, mode: 0o700 }))
        );
        relay = await createTaskModelRelay({
          modelEndpoint: this.options.modelEndpoint,
          modelTokenFile: this.options.modelTokenFile,
          modelCaFile: this.options.modelCaFile,
          timeoutMs: Math.min(timeoutMs, 300_000),
          onError: () => {
            providerFailed = true;
          },
        });
        if (briefing.model !== 'lifemodel/task') throw new Error('model_not_allowed');
        const config = {
          model: briefing.model,
          small_model: briefing.model,
          enabled_providers: ['lifemodel'],
          provider: {
            lifemodel: {
              npm: '@ai-sdk/openai-compatible',
              options: { baseURL: relay.baseURL },
              models: {
                task: { name: 'task', tool_call: true, limit: { context: 128000, output: 16000 } },
              },
            },
          },
          agent: { title: { disable: true }, summary: { disable: true } },
          permission: { '*': 'allow', question: 'deny', external_directory: 'deny' },
        };
        // Do not inherit projected tokens, bootstrap proxy variables, API keys or
        // arbitrary owner configuration. XDG config is immutable in the image;
        // all mutable cache/data/state live in the private work volume.
        const storageEnv = this.options.storageEnv;
        const env: NodeJS.ProcessEnv = {
          ...(storageEnv
            ? {
                LIFEMODEL_STORAGE_ENDPOINT: storageEnv.LIFEMODEL_STORAGE_ENDPOINT,
                LIFEMODEL_STORAGE_SPACE: storageEnv.LIFEMODEL_STORAGE_SPACE,
                LIFEMODEL_STORAGE_TOKEN_FILE: storageEnv.LIFEMODEL_STORAGE_TOKEN_FILE,
                LIFEMODEL_STORAGE_CA_FILE: storageEnv.LIFEMODEL_STORAGE_CA_FILE,
              }
            : {}),
          PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: join(work, 'home'),
          TMPDIR: join(work, 'tmp'),
          XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'] ?? '/etc/lifemodel/xdg',
          XDG_CACHE_HOME: join(work, 'home/.cache'),
          XDG_DATA_HOME: join(work, 'home/.local/share'),
          XDG_STATE_HOME: join(work, 'home/.local/state'),
          OPENCODE_CONFIG: this.options.configFile ?? '/etc/lifemodel/opencode.json',
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
          OPENCODE_DISABLE_AUTOUPDATE: 'true',
          OPENCODE_DISABLE_MODELS_FETCH: 'true',
          OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
          OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
          OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
          OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
          OPENCODE_DISABLE_CLAUDE_CODE: 'true',
          OPENCODE_PURE: 'true',
        };
        // At this pin --port 0 prefers 4096 instead of an ephemeral port. Select
        // a fresh port so separate adapters cannot reuse stale HTTP pool sockets.
        const reservation = createServer();
        reservation.on('error', () => undefined);
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(() => {
            reservation.close();
            reject(new Error('harness_port_timeout'));
          }, 5_000);
          reservation.once('error', (error) => {
            clearTimeout(deadline);
            reject(error);
          });
          reservation.listen(0, '127.0.0.1', () => {
            clearTimeout(deadline);
            resolve();
          });
        });
        const reserved = reservation.address();
        if (!reserved || typeof reserved === 'string') throw new Error('harness_port_failed');
        const port = reserved.port;
        await new Promise<void>((resolve) => reservation.close(() => resolve()));
        child = spawn(
          'python3',
          [
            '-c',
            TASK_PROCESS_SUPERVISOR,
            this.options.binary ?? 'opencode',
            'serve',
            '--hostname',
            '127.0.0.1',
            '--port',
            String(port),
          ],
          {
            cwd: work,
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        const processController = new AbortController();
        child.on('error', () => {
          processFailed = true;
          processController.abort();
        });
        child.on('exit', () => {
          processFailed = true;
          processController.abort();
        });
        child.stdout!.on('error', () => processController.abort());
        child.stderr!.on('error', () => processController.abort());
        // Raw harness logs may contain prompts, model output and tool arguments.
        // Never forward them into launcher logs or channel progress.
        child.stderr!.resume();
        const runSignal = AbortSignal.any([signal, processController.signal]);
        this.origin = await new Promise<string>((resolve, reject) => {
          const startupSignal = AbortSignal.any([runSignal, AbortSignal.timeout(30_000)]);
          let buffer = '';
          const stop = () => {
            cleanup();
            reject(new Error('harness_start_failed'));
          };
          const data = (chunk: Buffer) => {
            buffer = (buffer + chunk.toString()).slice(-8192);
            const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer);
            if (match?.[1]) {
              cleanup();
              resolve(match[1]);
            }
          };
          const cleanup = () => {
            child!.stdout!.off('data', data);
            startupSignal.removeEventListener('abort', stop);
          };
          child!.stdout!.on('data', data);
          startupSignal.addEventListener('abort', stop, { once: true });
          if (startupSignal.aborted) stop();
        });
        child.stdout!.resume();
        const request = async (path: string, body?: unknown): Promise<unknown> => {
          const response = await fetch(this.origin + path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: {
              'content-type': 'application/json',
              'x-opencode-directory': work,
              connection: 'close',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.any([
              runSignal,
              AbortSignal.timeout(
                path.endsWith('/message') && body !== undefined ? timeoutMs : 30_000
              ),
            ]),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error('harness_http_failed');
          }
          return response.json();
        };
        const created = record(await request('/session', { title: 'Task' }));
        if (typeof created['id'] !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(created['id'])) {
          throw new Error('harness_session_invalid');
        }
        this.sessionID = created['id'];
        const eventHeaders = new AbortController();
        const eventDeadline = setTimeout(() => eventHeaders.abort(), 30_000);
        let eventResponse: Response;
        try {
          eventResponse = await fetch(this.origin + '/event', {
            headers: { 'x-opencode-directory': work, connection: 'close' },
            signal: AbortSignal.any([runSignal, eventsStop.signal, eventHeaders.signal]),
          });
        } finally {
          clearTimeout(eventDeadline);
        }
        if (!eventResponse.ok || !eventResponse.body) throw new Error('harness_events_failed');
        events = this.consumeEvents(eventResponse.body, () => {
          providerFailed = true;
        });
        // Observe rejection immediately; race below still propagates the failure.
        void events.catch(() => undefined);
        await this.options.onEvent?.({ type: 'step', text: 'Running task' });
        const prompt = request(`/session/${this.sessionID}/message`, {
          model: { providerID: 'lifemodel', modelID: 'task' },
          parts: [{ type: 'text', text: briefing.text }],
        });
        await Promise.race([
          prompt,
          events.then(() => {
            throw new Error('harness_events_closed');
          }),
        ]);
        const messages = await request(`/session/${this.sessionID}/message`);
        if (this.aborted) return { outcome: 'aborted', result: '', reasonCode: 'aborted' };
        return openCodeSemanticResult(messages, providerFailed);
      } catch {
        if (this.aborted) return { outcome: 'aborted', result: '', reasonCode: 'aborted' };
        const reasonCode = providerFailed
          ? 'provider_error'
          : signal.aborted
            ? 'harness_timeout'
            : processFailed
              ? 'harness_process_failed'
              : 'harness_failed';
        try {
          await this.options.onEvent?.({ type: 'error', code: reasonCode });
        } catch {
          /* Reporting cannot skip teardown. */
        }
        return { outcome: 'failed', result: '', reasonCode };
      }
    };
    const result = await run();
    let cleanupFailed = false;
    try {
      eventsStop.abort();
      await events?.catch(() => undefined);
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* already exited */
        }
        const hard = setTimeout(() => {
          try {
            process.kill(-child!.pid!, 'SIGKILL');
          } catch {
            /* exited */
          }
        }, 5_000);
        await exited;
        clearTimeout(hard);
      }
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      await relay?.close();
      // Cleanup is part of success. A supervisor alarm, crash or hard kill
      // cannot leave a semantic success while task-owned tools survive.
      cleanupFailed =
        !!child && (child.signalCode !== null || (child.exitCode !== 0 && child.exitCode !== 143));
    } catch {
      cleanupFailed = true;
    }
    return cleanupFailed && result.outcome === 'succeeded'
      ? {
          outcome: this.aborted ? 'aborted' : 'failed',
          result: '',
          reasonCode: this.aborted ? 'aborted' : 'harness_cleanup_failed',
        }
      : result;
  }

  private async consumeEvents(
    body: ReadableStream<Uint8Array>,
    providerError: () => void
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolStates = new Map<string, string>();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        buffer += decoder.decode(next.value, { stream: true }).replace(/\r\n/g, '\n');
        if (buffer.length > 1_048_576) throw new Error('harness_event_too_large');
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          if (!data) continue;
          const event = record(JSON.parse(data));
          const props = record(event['properties']);
          const part = record(props['part']);
          const info = record(props['info']);
          if (
            props['sessionID'] !== this.sessionID &&
            part['sessionID'] !== this.sessionID &&
            info['sessionID'] !== this.sessionID
          )
            continue;
          if (
            event['type'] === 'session.error' ||
            (event['type'] === 'message.updated' && info['error'])
          ) {
            providerError();
            await this.options.onEvent?.({ type: 'error', code: 'provider_error' });
          }
          if (event['type'] === 'message.part.updated' && part['type'] === 'step-start') {
            await this.options.onEvent?.({ type: 'step', text: 'Working on task' });
          }
          if (event['type'] === 'message.part.updated' && part['type'] === 'tool') {
            const state = record(part['state']);
            const status = state['status'];
            const id = String(part['id']);
            if (status !== 'running' && status !== 'completed' && status !== 'error') continue;
            if (toolStates.get(id) === status) continue;
            if (toolStates.size >= 10_000 && !toolStates.has(id))
              throw new Error('harness_tool_limit');
            toolStates.set(id, status);
            // A fixed name prevents model-selected tool text leaking to channel.
            await this.options.onEvent?.({ type: 'tool', name: 'task_tool', status });
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
}
