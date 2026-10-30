import type {
  TaskEndTurnInput,
  TaskEndTurnReconciliation,
  TaskSuccessorEvidence,
} from './task-harness.js';
import { createAcpTranscriptMapper, acpToolOutput } from './task-transcript.js';
import type { TaskHarnessEventSink } from './task-harness.js';
/** Prime Agent 0.10.1 configuration. The protocol client remains generic ACP. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function configureAgent(input: {
  workDirectory: string;
  configFile: string;
  relayBaseURL: string;
  adapterConfig?: { settingsFile: string; kernelPython: string };
}): NodeJS.ProcessEnv {
  const dir = join(input.workDirectory, 'home/.prime/agent');
  const models = JSON.parse(readFileSync(input.configFile, 'utf8')) as {
    providers: { task: { baseUrl: string } };
  };
  models.providers.task.baseUrl = input.relayBaseURL;
  if (!input.adapterConfig) throw new Error('harness_adapter_config_missing');
  const settings = readFileSync(input.adapterConfig.settingsFile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'models.json'), JSON.stringify(models), { mode: 0o600 });
  writeFileSync(join(dir, 'settings.json'), settings, { mode: 0o600 });
  return {
    PI_OFFLINE: '1',
    DO_NOT_TRACK: '1',
    PRIME_AGENT_TELEMETRY: '0',
    PRIME_AGENT_CODING_AGENT_DIR: dir,
    PRIME_AGENT_SESSION_DIR: join(dir, 'sessions'),
    PRIME_AGENT_DAEMON_SOCKET: join(input.workDirectory, '.launcher/daemon.sock'),
    PRIME_AGENT_KERNEL_PYTHON: input.adapterConfig.kernelPython,
  };
}

/** Prime's Python exceptions lack structured failure evidence (ADR-014). */
export function toolOutputFailed(_output: unknown): boolean {
  return false;
}

/** Version probing must not start update or telemetry activity. */
export function versionCheckEnv(workDirectory: string): NodeJS.ProcessEnv {
  return {
    PI_OFFLINE: '1',
    DO_NOT_TRACK: '1',
    PRIME_AGENT_TELEMETRY: '0',
    PRIME_AGENT_CODING_AGENT_DIR: join(workDirectory, 'agent'),
    PRIME_AGENT_SESSION_DIR: join(workDirectory, 'sessions'),
    PRIME_AGENT_DAEMON_SOCKET: join(workDirectory, 'daemon.sock'),
  };
}

// ACP's session ID is not the daemon's activeSessionId. Bind while the
// freshly-created session is the only root, before the brief can spawn agents.
export const failOnUncertain = true;
const roots = new Map<string, string>();

export function release(input: { workDirectory: string; sessionId: string }): void {
  roots.delete(bindingKey(input.workDirectory, input.sessionId));
}
const bindingKey = (workDirectory: string, sessionId: string): string =>
  JSON.stringify([workDirectory, sessionId]);

type NativeRecord = Record<string, unknown>;
const asRecord = (value: unknown): NativeRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as NativeRecord)
    : {};

/** A single native command, on the same private supervisor socket as ACP. */
function nativeCall(
  workDirectory: string,
  command: NativeRecord,
  signal?: AbortSignal
): Promise<NativeRecord> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = connect(join(workDirectory, '.launcher/daemon.sock'));
    let buffer = '';
    let hello = false;
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error('prime_daemon_timeout'));
    }, 5000);
    const finish = (error?: Error, response?: NativeRecord): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      socket.destroy();
      if (error) reject(error);
      else resolve(response ?? {});
    };
    const cancel = () => {
      finish(new Error('prime_observation_stopped'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    socket.setEncoding('utf8');
    socket.on('error', () => {
      finish(new Error('prime_daemon_socket_error'));
    });
    socket.on('close', () => {
      finish(new Error('prime_daemon_closed'));
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        finish(new Error('prime_daemon_frame_limit'));
        return;
      }
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let frame: NativeRecord;
        try {
          frame = asRecord(JSON.parse(line));
        } catch {
          finish(new Error('prime_daemon_invalid_frame'));
          return;
        }
        if (!hello) {
          const protocol = asRecord(frame['protocol']);
          if (
            frame['type'] !== 'daemon_hello' ||
            frame['appVersion'] !== '0.10.1' ||
            protocol['name'] !== 'prime-agent.daemon' ||
            protocol['version'] !== 7
          ) {
            finish(new Error('prime_daemon_incompatible'));
            return;
          }
          hello = true;
          socket.write(
            JSON.stringify({
              type: 'command',
              id,
              protocol: { name: 'prime-agent.daemon', version: 7 },
              command,
            }) + '\n'
          );
        } else if (frame['type'] === 'response' && frame['id'] === id) {
          finish(undefined, frame);
          return;
        }
      }
    });
  });
}

export async function bind(input: { workDirectory: string; sessionId: string }): Promise<void> {
  const key = bindingKey(input.workDirectory, input.sessionId);
  roots.delete(key);
  const response = await nativeCall(input.workDirectory, {
    type: 'list',
    includeClientOwned: true,
  });
  const sessions = asRecord(response['data'])['sessions'];
  if (response['success'] !== true || !Array.isArray(sessions) || sessions.length !== 1)
    throw new Error('prime_root_ambiguous');
  const root = asRecord(sessions[0]);
  if (
    root['rlmDepth'] !== 0 ||
    root['runtimeKind'] !== 'top-level' ||
    root['parentActiveSessionId'] != null ||
    root['cwd'] !== input.workDirectory ||
    typeof root['activeSessionId'] !== 'string' ||
    !root['activeSessionId']
  )
    throw new Error('prime_root_ambiguous');
  roots.set(key, root['activeSessionId']);
}

/** Never retry: Prime correlates request IDs but does not deduplicate steer. */
export async function admit(input: {
  workDirectory: string;
  sessionId: string;
  commandId: string;
  text: string;
}): Promise<'accepted' | 'rejected' | 'uncertain'> {
  const activeSessionId = roots.get(bindingKey(input.workDirectory, input.sessionId));
  if (!activeSessionId) return 'rejected';
  try {
    const response = await nativeCall(input.workDirectory, {
      type: 'steer',
      activeSessionId,
      message: insertedText(input.commandId, input.text),
    });
    if (response['command'] !== 'steer') return 'uncertain';
    if (response['success'] === false) return 'rejected';
    if (response['success'] === true && asRecord(response['data'])['queued'] === true)
      return 'accepted';
    return 'uncertain';
  } catch {
    // A broken connection cannot tell whether the daemon enqueued the text.
    return 'uncertain';
  }
}

/** Marker is correlation evidence, not a native idempotency key. */
function steeringMarker(commandId: string): string {
  return `[lifemodel-steer:${createHash('sha256').update(commandId).digest('hex')}]`;
}
export function insertedText(commandId: string, text: string): string {
  return `${steeringMarker(commandId)}\n${text}`;
}

/** Positive native user-row evidence only. Queue absence never means inserted.
 * Walk bounded transcript pages so a compaction or busy session cannot turn
 * a missing recent row into a false receipt. No native steer is retried here.
 */
export async function observeInsertion(input: {
  workDirectory: string;
  sessionId: string;
  commandId: string;
  signal: AbortSignal;
}): Promise<boolean | string> {
  const activeSessionId = roots.get(bindingKey(input.workDirectory, input.sessionId));
  if (!activeSessionId) return false;
  const marker = steeringMarker(input.commandId) + '\n';
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(60000)]);
  // Eight passes, at most 100 single-row pages each. A large tool row can
  // exceed the byte limit even alone: abandon observation, not the task.
  for (let pass = 0; pass < 8 && !signal.aborted; pass++) {
    try {
      let before: string | undefined;
      let historyLeafId: unknown;
      for (let page = 0; page < 100 && !signal.aborted; page++) {
        const response = await nativeCall(
          input.workDirectory,
          {
            type: 'get_messages',
            activeSessionId,
            page: { from: 'end', limit: 1, ...(before ? { before } : {}) },
            ...(historyLeafId ? { historyLeafId } : {}),
          },
          signal
        );
        if (response['success'] !== true || response['command'] !== 'get_messages') break;
        const data = asRecord(response['data']);
        if (!Array.isArray(data['messages'])) break;
        const inserted: unknown = data['messages'].find((value: unknown) => {
          const message = asRecord(value);
          return message['role'] === 'user' && messageText(message).startsWith(marker);
        });
        if (inserted) return nativeInsertionTime(asRecord(inserted)) ?? true;
        const next = data['firstEntryId'];
        if (data['more'] !== true || typeof next !== 'string' || next === before) break;
        before = next;
        historyLeafId = data['historyLeafId'];
      }
    } catch {
      // Unreadable/oversized history is no insertion evidence. Never retry
      // a native steer or fail a running turn because this observer failed.
      return false;
    }
    if (pass < 7)
      await delay(Math.min(100 * 2 ** pass, 5000), undefined, { signal: signal }).catch(
        () => undefined
      );
  }
  return false;
}

/** A closed launcher intake makes native idle + empty queue a completion fence. */
export async function reconcileEndTurn(
  input: TaskEndTurnInput
): Promise<TaskEndTurnReconciliation> {
  const activeSessionId = roots.get(bindingKey(input.workDirectory, input.sessionId));
  if (!activeSessionId) return { state: 'unknown' };
  const call = async (type: string, extra: NativeRecord = {}) => {
    const response = await nativeCall(
      input.workDirectory,
      { type, activeSessionId, ...extra },
      input.signal
    );
    if (response['success'] !== true || response['command'] !== type)
      throw new Error('prime_evidence_missing');
    return asRecord(response['data']);
  };
  const idle = async () => {
    const state = await call('get_state');
    const queue = await call('get_queue');
    if (
      state['activeSessionId'] !== activeSessionId ||
      !Array.isArray(queue['steering']) ||
      !Array.isArray(queue['followUp'])
    )
      throw new Error('prime_evidence_missing');
    return (
      state['isSessionActive'] === false &&
      state['isStreaming'] === false &&
      state['isCompacting'] === false &&
      state['isRunningTools'] === false &&
      state['hasRunningSubagents'] === false &&
      queue['steering'].length === 0 &&
      queue['followUp'].length === 0
    );
  };
  try {
    if ((await idle()) && input.commandIds.every((id) => input.insertedCommandIds?.includes(id)))
      return { state: 'idle' };
  } catch {
    return { state: 'unknown' };
  }
  return {
    state: 'successor',
    wait: async (control) => {
      try {
        const commandIds = new Set(input.commandIds);
        let backoff = 100;
        for (;;) {
          while (!(await idle())) {
            await delay(backoff, undefined, { signal: input.signal });
            backoff = Math.min(backoff * 2, 2000);
          }
          // Native idle is not a fence while launcher intake is open. A steer
          // may enqueue/start work between the two native reads. Close, settle,
          // and check again before inspecting any final text.
          const added = await control.closeIntake();
          for (const id of added) commandIds.add(id);
          const settledIdle = await idle();
          if (settledIdle && added.length === 0) break;
          // An admitted command can have left its queue before the daemon's
          // running flags catch up. Give it another idle fence as well.
          control.reopenIntake();
        }
        // Read only the relevant branch-pinned tail. Old task history is not
        // evidence for this successor and must not cost memory or frame budget.
        const messages: NativeRecord[] = [];
        const markers = new Set([...commandIds].map((id) => steeringMarker(id) + '\n'));
        let before: string | undefined;
        let historyLeafId: unknown;
        let bytes = 0;
        for (let page = 0; ; page++) {
          const data = await call('get_messages', {
            page: { from: 'end', limit: 1, ...(before ? { before } : {}) },
            ...(historyLeafId ? { historyLeafId } : {}),
          });
          if (!Array.isArray(data['messages'])) return undefined;
          let boundary = false;
          const rows = data['messages'].map(asRecord);
          for (let index = rows.length - 1; index >= 0; index--) {
            const row = rows[index];
            if (!row) return undefined;
            bytes += Buffer.byteLength(JSON.stringify(row));
            if (bytes > 8 * 1024 * 1024) return undefined;
            messages.unshift(row);
            if (row['role'] === 'user') {
              const text = messageText(row);
              for (const marker of markers) if (text.startsWith(marker)) markers.delete(marker);
              if (markers.size === 0) {
                boundary = true;
                break;
              }
            }
          }
          if (boundary) return successorEvidence(messages, [...commandIds]);
          if (data['more'] === false) return undefined;
          if (
            data['more'] !== true ||
            typeof data['firstEntryId'] !== 'string' ||
            data['firstEntryId'] === before ||
            page === 999
          )
            return undefined;
          before = data['firstEntryId'];
          historyLeafId = data['historyLeafId'];
        }
      } catch {
        return undefined;
      }
    },
  };
}

function messageText(row: NativeRecord): string {
  return Array.isArray(row['content'])
    ? row['content']
        .map((part: unknown) => {
          const value = asRecord(part);
          return value['type'] === 'text' && typeof value['text'] === 'string' ? value['text'] : '';
        })
        .join('')
    : '';
}

/** Only structured daemon rows can prove successor final text and tool settlement. */
function successorEvidence(
  messages: NativeRecord[],
  commandIds: string[]
): TaskSuccessorEvidence | undefined {
  let start = messages.length;
  for (const commandId of commandIds) {
    const index = messages.findIndex(
      (row) =>
        row['role'] === 'user' && messageText(row).startsWith(steeringMarker(commandId) + '\n')
    );
    if (index < 0) return undefined;
    start = Math.min(start, index);
  }
  if (!commandIds.length) start = messages.findLastIndex((row) => row['role'] === 'user');
  if (start < 0) return undefined;
  const updates: TaskSuccessorEvidence['updates'] = [];
  const pending = new Set<string>();
  let final = '';
  for (const row of messages.slice(start)) {
    if (row['role'] === 'assistant') {
      if (!Array.isArray(row['content'])) return undefined;
      for (const part of row['content']) {
        const content = asRecord(part);
        if (content['type'] !== 'toolCall') continue;
        if (typeof content['id'] !== 'string' || !content['id'] || pending.has(content['id']))
          return undefined;
        pending.add(content['id']);
        final = '';
        updates.push({
          kind: 'tool',
          id: content['id'],
          status: 'in_progress',
          ...(typeof content['name'] === 'string' ? { name: content['name'] } : {}),
          input: content['arguments'],
        });
      }
      if (row['stopReason'] === 'error' || row['stopReason'] === 'aborted') return undefined;
      if (row['stopReason'] === 'stop' && messageText(row).trim()) {
        final = messageText(row);
        updates.push({ kind: 'reset' }, { kind: 'text', text: final });
      }
    } else if (row['role'] === 'toolResult') {
      if (
        typeof row['toolCallId'] !== 'string' ||
        !pending.delete(row['toolCallId']) ||
        typeof row['isError'] !== 'boolean'
      )
        return undefined;
      updates.push({
        kind: 'tool',
        id: row['toolCallId'],
        status: row['isError'] ? 'failed' : 'completed',
        output: row['content'],
      });
    } else if (row['role'] === 'user') {
      const insertedAt = nativeInsertionTime(row);
      for (const commandId of commandIds)
        if (messageText(row).startsWith(steeringMarker(commandId) + '\n'))
          updates.push({
            kind: 'inserted',
            commandId,
            text: messageText(row),
            ...(insertedAt ? { insertedAt } : {}),
          });
      final = '';
      updates.push({ kind: 'reset' });
    }
  }
  if (!final.trim() || pending.size) return undefined;
  return { updates, stopReason: 'end_turn' };
}

/** Map this adapter's ACP session, including native successor observations. */
export function createTranscriptMapper(sink?: TaskHarnessEventSink) {
  return createAcpTranscriptMapper(sink, {
    name: (tool) =>
      ['name', 'title', 'kind']
        .map((key) => tool[key])
        .find((value): value is string => typeof value === 'string') ?? 'tool',
    input: (tool) => {
      const raw = tool['rawInput'];
      if (typeof raw === 'string') return raw;
      if (!raw || typeof raw !== 'object') return '';
      const input = raw as Record<string, unknown>;
      return (
        ['code', 'command', 'path', 'url']
          .map((key) => input[key])
          .find((value): value is string => typeof value === 'string') ?? ''
      );
    },
    output: acpToolOutput,
  });
}

/** Daemon rows carry a millisecond timestamp; absent timestamps remain observation time. */
function nativeInsertionTime(row: NativeRecord): string | undefined {
  const value = row['timestamp'];
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : undefined;
}
