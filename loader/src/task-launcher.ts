/** One process, one start transition, one immutable semantic terminal frame. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { TaskJsonClient, LauncherError, type TaskEndpoint } from './task-launcher-http.js';
import { runStorageCli } from './storage-cli.js';
import { createRegisteredHarness } from './task-harness-factory.js';
import type { TaskHarness, TaskHarnessEvent, TaskHarnessResult } from './task-harness.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const BOOT_NONCE = randomUUID(); // One memory-only nonce per launcher process.
interface Identity {
  taskId: string;
  attemptId: string;
  launchId: string;
}
interface Terminal {
  outcome: 'succeeded' | 'failed' | 'aborted';
  summary: string;
  resultObjectId: string | null;
  logObjectId: string | null;
  artifactObjectIds: string[];
  reasonCode?: string;
}
export interface LauncherOptions {
  env: NodeJS.ProcessEnv;
  workDirectory?: string;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  startupWindowMs?: number;
  harness?: (onEvent: (event: TaskHarnessEvent) => Promise<void>) => TaskHarness;
  diagnostic?: (code: string) => void;
}
function endpoint(env: NodeJS.ProcessEnv, service: string): TaskEndpoint {
  const prefix = `LIFEMODEL_TASK_${service}`;
  const url = env[`${prefix}_ENDPOINT`];
  const tokenFile = env[`${prefix}_TOKEN_FILE`];
  const caFile = env[`${prefix}_CA_FILE`];
  if (!url || !tokenFile || !caFile) throw new LauncherError('configuration_unavailable');
  return { endpoint: url, tokenFile, caFile };
}
function identity(value: Record<string, unknown>): Identity {
  const { taskId, attemptId, launchId } = value;
  if (
    typeof taskId !== 'string' ||
    !/^task_[0-9a-f]{64}$/.test(taskId) ||
    typeof attemptId !== 'string' ||
    !/^attempt_[0-9a-f]{64}$/.test(attemptId) ||
    typeof launchId !== 'string' ||
    !/^launch_[0-9a-f]{64}$/.test(launchId)
  )
    throw new LauncherError('identity_unavailable');
  return { taskId, attemptId, launchId };
}
function same(a: Identity, b: Identity): boolean {
  return a.taskId === b.taskId && a.attemptId === b.attemptId && a.launchId === b.launchId;
}
/** Calls the shipped storage CLI implementation without exposing output to stdout. */
async function storage(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<Record<string, unknown>> {
  let output = '';
  const status = await runStorageCli(argv, {
    env,
    cwd,
    stdout: (text) => {
      output += text;
      if (output.length > 128 * 1024) throw new Error();
    },
    stderr: () => undefined,
  });
  if (status !== 0) throw new LauncherError('storage_unavailable');
  try {
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new LauncherError('storage_response_invalid');
  }
}
async function save(
  name: string,
  role: 'result' | 'log',
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<string> {
  const receipt = await storage(['put', name, '--upload-id', `upload_${randomUUID()}`], env, cwd);
  const id = receipt['id'];
  if (typeof id !== 'string' || !ID.test(id)) throw new LauncherError('storage_response_invalid');
  const marked = await storage(['mark', id, role], env, cwd);
  if (marked['id'] !== id || marked['mark'] !== role)
    throw new LauncherError('storage_mark_invalid');
  return id;
}
async function artifacts(env: NodeJS.ProcessEnv, cwd: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 100; pages++) {
    const page = await storage(
      ['list', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])],
      env,
      cwd
    );
    for (const item of page['objects'] as Record<string, unknown>[]) {
      if (item['mark'] === 'artifact') {
        const id = item['id'];
        if (typeof id !== 'string' || !ID.test(id) || ids.includes(id) || ids.length === 64)
          throw new LauncherError('artifact_limit');
        ids.push(id);
      }
    }
    if (page['nextCursor'] === null) return ids;
    cursor = page['nextCursor'] as string;
  }
  throw new LauncherError('artifact_limit');
}
export async function runTaskLauncher(options: LauncherOptions): Promise<number> {
  // Memory-only nonce. It is never an upload ID, a file, or a retry identity.
  const bootNonce = BOOT_NONCE;
  const cwd = options.workDirectory ?? '/work';
  let channel: TaskJsonClient | undefined;
  let model: TaskJsonClient | undefined;
  let ids: Identity | undefined;
  let harness: TaskHarness | undefined;
  let sequence = 0;
  let started = false;
  let log: Awaited<ReturnType<typeof open>> | undefined;
  let logName: string | undefined;
  let terminalAttempted = false;
  const terminal: Terminal = {
    outcome: 'failed',
    summary: 'Task could not complete',
    resultObjectId: null,
    logObjectId: null,
    artifactObjectIds: [],
    reasonCode: 'launcher_failed',
  };
  const onAbort = () => {
    void harness?.abort().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  async function send(kind: 'step' | 'terminal', payload: unknown): Promise<void> {
    if (!channel || !ids) throw new LauncherError('channel_unavailable');
    const frame = {
      taskId: ids.taskId,
      attemptId: ids.attemptId,
      direction: 'task_to_core',
      messageId: `msg_${randomUUID()}`,
      sequence: ++sequence,
      kind,
      payload,
    };
    // Never change the immutable frame after an ambiguous ACK. One in flight.
    let connectionAttempts = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ack = await channel.call('/task/events', frame);
        if (
          ack['taskId'] !== frame.taskId ||
          ack['attemptId'] !== frame.attemptId ||
          ack['direction'] !== frame.direction ||
          ack['messageId'] !== frame.messageId ||
          ack['sequence'] !== frame.sequence ||
          typeof ack['receivedAt'] !== 'string' ||
          !Number.isFinite(Date.parse(ack['receivedAt']))
        )
          throw new LauncherError('ack_invalid');
        return;
      } catch (error) {
        connectionAttempts += error instanceof LauncherError ? (error.connectionAttempts ?? 1) : 1;
        if (
          error instanceof LauncherError &&
          error.status &&
          ![429, 500, 502, 503, 504].includes(error.status)
        )
          throw error;
        if (attempt === 2)
          throw new LauncherError('channel_unavailable', undefined, connectionAttempts);
      }
    }
  }
  async function report(): Promise<void> {
    terminalAttempted = true;
    await send('terminal', terminal);
  }
  try {
    await mkdir(join(cwd, 'home'), { recursive: true, mode: 0o700 });
    await mkdir(join(cwd, 'tmp'), { recursive: true, mode: 0o700 });
    channel = new TaskJsonClient(
      endpoint(options.env, 'CHANNEL'),
      options.requestTimeoutMs,
      options.startupWindowMs
    );
    model = new TaskJsonClient(
      endpoint(options.env, 'MODEL'),
      options.requestTimeoutMs,
      options.startupWindowMs
    );
    ids = identity(await channel.call('/task/identity', undefined, options.signal));
    options.signal?.throwIfAborted();
    // Exactly one call. Never retry timeout, lost response, 409 or late ACK.
    let claim: Record<string, unknown>;
    try {
      claim = await model.call('/task/start', { ...ids, bootNonce }, options.signal);
    } catch (error) {
      throw new LauncherError(
        'start_lost',
        undefined,
        error instanceof LauncherError ? error.connectionAttempts : undefined
      );
    }
    if (
      claim['start'] !== true ||
      !same(ids, identity(claim)) ||
      claim['space'] !== options.env['LIFEMODEL_STORAGE_SPACE'] ||
      typeof claim['hardStopAt'] !== 'string' ||
      !Number.isFinite(Date.parse(claim['hardStopAt'])) ||
      Date.parse(claim['hardStopAt']) <= Date.now()
    )
      throw new LauncherError('start_lost');
    if (started) throw new LauncherError('start_lost');
    started = true;
    channel.hardStopAt = model.hardStopAt = Date.parse(claim['hardStopAt']);
    let briefing: Record<string, unknown>;
    try {
      briefing = await channel.call('/task/briefing', undefined, options.signal);
      if (
        !same(ids, identity(briefing)) ||
        typeof briefing['briefing'] !== 'string' ||
        !briefing['briefing'].trim()
      )
        throw new Error();
    } catch (error) {
      throw new LauncherError(
        'briefing_unavailable',
        undefined,
        error instanceof LauncherError ? error.connectionAttempts : undefined
      );
    }
    options.signal?.throwIfAborted();
    const directory = `launcher_${randomUUID()}`;
    await mkdir(join(cwd, directory), { mode: 0o700 });
    logName = `${directory}/log.jsonl`;
    log = await open(join(cwd, logName), 'wx', 0o600);
    let eventCount = 0;
    const onEvent = async (event: TaskHarnessEvent): Promise<void> => {
      if (++eventCount > 10_000) throw new LauncherError('event_limit');
      // Payload text/tool output never enters launcher diagnostics or the channel.
      const line =
        event.type === 'step'
          ? 'Task is working'
          : event.type === 'tool'
            ? 'Task is using a tool'
            : 'Harness reported an error';
      // Fixed fields also prevent unbounded or secret-bearing harness payloads.
      await log?.write(`${JSON.stringify({ type: event.type, line })}\n`);
      await send('step', { line });
    };
    const modelConfig = endpoint(options.env, 'MODEL');
    harness =
      options.harness?.(onEvent) ??
      (await createRegisteredHarness(
        typeof briefing['harness'] === 'string' ? briefing['harness'] : '',
        {
          modelEndpoint: modelConfig.endpoint,
          modelTokenFile: modelConfig.tokenFile,
          modelCaFile: modelConfig.caFile,
          workDirectory: cwd,
          storageEnv: {
            LIFEMODEL_STORAGE_ENDPOINT: options.env['LIFEMODEL_STORAGE_ENDPOINT'] ?? '',
            LIFEMODEL_STORAGE_SPACE: options.env['LIFEMODEL_STORAGE_SPACE'] ?? '',
            LIFEMODEL_STORAGE_TOKEN_FILE: options.env['LIFEMODEL_STORAGE_TOKEN_FILE'] ?? '',
            LIFEMODEL_STORAGE_CA_FILE: options.env['LIFEMODEL_STORAGE_CA_FILE'] ?? '',
          },
          onEvent,
          timeoutMs: Math.max(1, Date.parse(claim['hardStopAt']) - Date.now() - 10_000),
        }
      ));
    if (options.signal?.aborted) {
      await harness.abort();
      throw new LauncherError('launcher_aborted');
    }
    const result: TaskHarnessResult = await harness.start({
      text: briefing['briefing'],
      model: 'lifemodel/task',
    });
    await log.sync();
    await log.close();
    log = undefined;
    const resultName = `${directory}/result.txt`;
    await writeFile(join(cwd, resultName), result.result, { flag: 'wx', mode: 0o600 });
    terminal.resultObjectId = await save(resultName, 'result', options.env, cwd);
    terminal.logObjectId = await save(logName, 'log', options.env, cwd);
    terminal.artifactObjectIds = await artifacts(options.env, cwd);
    terminal.outcome = result.outcome;
    terminal.summary =
      result.outcome === 'succeeded'
        ? 'Task result is ready'
        : result.outcome === 'aborted'
          ? 'Task was aborted'
          : 'Task could not complete';
    if (result.outcome === 'failed')
      terminal.reasonCode =
        result.reasonCode && /^[a-z][a-z0-9_]{0,63}$/.test(result.reasonCode)
          ? result.reasonCode
          : 'harness_failed';
    else delete terminal.reasonCode;
    await report();
    return result.outcome === 'succeeded' ? 0 : 1;
  } catch (error) {
    await harness?.abort().catch(() => undefined);
    const code =
      error instanceof LauncherError
        ? error.code
        : options.signal?.aborted
          ? 'launcher_aborted'
          : 'launcher_failed';
    options.diagnostic?.(code);
    if (error instanceof LauncherError && error.connectionAttempts !== undefined)
      options.diagnostic?.(`connection_attempts=${String(error.connectionAttempts)}`);
    if (!terminalAttempted) {
      terminal.outcome = 'failed';
      terminal.reasonCode = code;
      if (log) {
        await log.sync().catch(() => undefined);
        await log.close().catch(() => undefined);
        log = undefined;
      }
      if (started && logName && !terminal.logObjectId) {
        try {
          terminal.logObjectId = await save(logName, 'log', options.env, cwd);
        } catch {
          /* best report retains only durable marks */
        }
      }
      try {
        await report();
      } catch (reportError) {
        options.diagnostic?.('terminal_unavailable');
        if (reportError instanceof LauncherError && reportError.connectionAttempts !== undefined)
          options.diagnostic?.(`connection_attempts=${String(reportError.connectionAttempts)}`);
      }
    }
    return 1;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await log?.close().catch(() => undefined);
    channel?.close();
    model?.close();
  }
}
