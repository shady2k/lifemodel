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
    PRIME_AGENT_DAEMON_SOCKET: join(input.workDirectory, 'tmp/daemon.sock'),
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
const roots = new Map<string, string>();
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
    const socket = connect(join(workDirectory, 'tmp/daemon.sock'));
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
      message: steeringText(input.commandId, input.text),
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
function steeringText(commandId: string, text: string): string {
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
}): Promise<boolean> {
  const activeSessionId = roots.get(bindingKey(input.workDirectory, input.sessionId));
  if (!activeSessionId) return false;
  const marker = steeringMarker(input.commandId) + '\n';
  while (!input.signal.aborted) {
    let before: string | undefined;
    let historyLeafId: unknown;
    for (let page = 0; page < 100 && !input.signal.aborted; page++) {
      const response = await nativeCall(
        input.workDirectory,
        {
          type: 'get_messages',
          activeSessionId,
          page: { from: 'end', limit: 100, ...(before ? { before } : {}) },
          ...(historyLeafId ? { historyLeafId } : {}),
        },
        input.signal
      );
      if (response['success'] !== true || response['command'] !== 'get_messages') break;
      const data = asRecord(response['data']);
      if (!Array.isArray(data['messages'])) break;
      if (
        data['messages'].some((value: unknown) => {
          const message = asRecord(value);
          return (
            message['role'] === 'user' &&
            Array.isArray(message['content']) &&
            message['content'].some((part: unknown) => {
              const content = asRecord(part);
              return (
                content['type'] === 'text' &&
                typeof content['text'] === 'string' &&
                content['text'].startsWith(marker)
              );
            })
          );
        })
      )
        return true;
      const next = data['firstEntryId'];
      if (data['more'] !== true || typeof next !== 'string' || next === before) break;
      before = next;
      historyLeafId = data['historyLeafId'];
    }
    await delay(100, undefined, { signal: input.signal }).catch(() => undefined);
  }
  return false;
}
