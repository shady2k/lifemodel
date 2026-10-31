/** One process, one start transition, one immutable semantic terminal frame. */
import { TASK_REPORT_NAME } from '../../src/ports/task-output-names.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, opendir, lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TaskJsonClient, LauncherError, type TaskEndpoint } from './task-launcher-http.js';
import { runStorageCli, storageNameValid } from './storage-cli.js';
import { createTaskTranscriptChannel } from './task-transcript-channel.js';
import { transcriptText } from './task-transcript.js';
import { createTaskTraceChannel } from './task-trace-channel.js';
import { createRegisteredHarness } from './task-harness-factory.js';
import { createTaskCommandIntake } from './task-command-intake.js';
import { createTaskTools } from './task-tools.js';
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
  diagnostic?: (code: string, context?: { taskId?: string; traceId?: string }) => void;
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
  role: 'result' | 'artifact',
  env: NodeJS.ProcessEnv,
  cwd: string,
  launchId: string
): Promise<string> {
  // Role/launch upload identities make retries idempotent. Reserved report
  // and unique owner-facing names are enforced before a successful terminal.
  const uploadId = `upload_${createHash('sha256')
    .update(JSON.stringify([launchId, role, basename(name)]))
    .digest('hex')}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const receipt = await storage(
        ['put', basename(name), '--upload-id', uploadId],
        env,
        join(cwd, dirname(name))
      );
      const id = receipt['id'];
      if (typeof id !== 'string' || !ID.test(id))
        throw new LauncherError('storage_response_invalid');
      const marked = await storage(['mark', id, role], env, cwd);
      if (marked['id'] !== id || marked['mark'] !== role)
        throw new LauncherError('storage_mark_invalid');
      return id;
    } catch (error) {
      // An ACK can be lost after PUT or mark committed. Reuse exactly the same
      // upload identity and role; the shipped module replays the saved receipt.
      if (
        !(error instanceof LauncherError) ||
        error.code !== 'storage_unavailable' ||
        attempt === 2
      )
        throw error;
    }
  }
}

async function collectOutputs(
  env: NodeJS.ProcessEnv,
  cwd: string,
  launchId: string,
  warning?: (code: string, upload?: boolean) => void
): Promise<void> {
  const outputDirectory = join(cwd, 'outputs');
  const stat = await lstat(outputDirectory);
  if (stat.isSymbolicLink()) throw new LauncherError('output_symlink');
  if (!stat.isDirectory()) throw new LauncherError('output_not_regular');
  const names: string[] = [];
  const directory = await opendir(outputDirectory);
  let inspected = 0;
  for await (const entry of directory) {
    // Partial collection is bounded too. Do not scan an attacker-sized folder.
    if (++inspected > 64) {
      if (!warning) throw new LauncherError('output_limit');
      warning('output_limit');
      break;
    }
    const code = entry.isSymbolicLink()
      ? 'output_symlink'
      : entry.isDirectory()
        ? 'output_subdirectory'
        : !entry.isFile()
          ? 'output_not_regular'
          : entry.name === TASK_REPORT_NAME
            ? 'output_name_reserved'
            : !storageNameValid(entry.name)
              ? 'output_name_invalid'
              : undefined;
    if (code) {
      if (!warning) throw new LauncherError(code);
      warning(code);
    } else names.push(entry.name);
  }
  // Successful tasks validate the whole folder before upload. Partial collection
  // skips bad entries. Transfer-time no-follow opens still reject replacements.
  for (const name of names.sort()) {
    try {
      await save(join('outputs', name), 'artifact', env, cwd, launchId);
    } catch (error) {
      if (!warning) throw error;
      warning(error instanceof LauncherError ? error.code : 'output_upload_failed', true);
    }
  }
}

function outputInstructions(cwd: string): string {
  return `Files for the owner go in ${join(cwd, 'outputs')}/, flat, with their final file names.
Only regular files are allowed; no subfolders or symlinks. Maximum: 64 files.
I collect outputs/ automatically. Do not also upload these files with the storage CLI: duplicate owner-facing names fail the run (output_name_ambiguous).
${TASK_REPORT_NAME} is reserved for my semantic report; do not use it as a work output name.
Files elsewhere are not retained. Failed-task outputs are retained as partial objects, not delivered as successful work.
Use the task MCP step tool for short progress reports and question to ask the coordinating agent.
Question returns after storage, not an answer. Wait for the correlated answer via steering.`;
}
async function artifacts(
  env: NodeJS.ProcessEnv,
  cwd: string,
  reportId: string | null,
  warning?: (code: string) => void
): Promise<string[]> {
  const ids: string[] = [];
  const names = new Map<string, string[]>();
  const ambiguous = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 0; pages < 100; pages++) {
    const page = await storage(
      ['list', '--limit', '100', ...(cursor ? ['--cursor', cursor] : [])],
      env,
      cwd
    );
    for (const item of page['objects'] as Record<string, unknown>[]) {
      if (item['mark'] === 'artifact' || item['mark'] === 'result') {
        const name = item['name'];
        const code =
          name === TASK_REPORT_NAME && item['id'] !== reportId
            ? 'output_name_reserved'
            : typeof name !== 'string' || names.has(name)
              ? 'output_name_ambiguous'
              : undefined;
        if (code) {
          if (!warning) throw new LauncherError(code);
          warning(code);
          if (typeof name === 'string') ambiguous.add(name);
          continue;
        }
        names.set(name as string, typeof item['id'] === 'string' ? [item['id']] : []);
      }
      if (item['mark'] === 'artifact') {
        const id = item['id'];
        if (typeof id !== 'string' || !ID.test(id) || ids.includes(id) || ids.length === 64)
          throw new LauncherError('artifact_limit');
        ids.push(id);
      }
    }
    // Row count cannot prove EOF: encoded metadata may cut a page short.
    if (page['nextCursor'] === null) {
      // Both sides of a duplicate are ambiguous, even across listing pages.
      const excluded = new Set([...ambiguous].flatMap((name) => names.get(name) ?? []));
      return ids.filter((id) => !excluded.has(id));
    }
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
  let commands: ReturnType<typeof createTaskCommandIntake> | undefined;
  let tools: Awaited<ReturnType<typeof createTaskTools>> | undefined;
  let sequence = 0;
  let started = false;
  let trace: ReturnType<typeof createTaskTraceChannel> | undefined;
  let transcript: ReturnType<typeof createTaskTranscriptChannel> | undefined;
  let traceId: string | undefined;
  let root: Extract<TaskHarnessEvent, { type: 'trace' }>['span'] | undefined;
  let failureSpanId: string | undefined;
  let outputsStartedAt: string | undefined;
  let terminalAttempted = false;
  const terminal: Terminal = {
    outcome: 'failed',
    summary: 'Task could not complete',
    resultObjectId: null,
    artifactObjectIds: [],
    reasonCode: 'launcher_failed',
  };
  const diagnostic = (code: string) =>
    options.diagnostic?.(code, {
      ...(ids ? { taskId: ids.taskId } : {}),
      ...(traceId ? { traceId } : {}),
    });
  const onAbort = () => {
    void harness?.abort().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  async function send(
    kind: 'step' | 'question' | 'terminal' | 'lifecycle',
    payload: unknown,
    messageId = `msg_${randomUUID()}`
  ): Promise<void> {
    if (!channel || !ids) throw new LauncherError('channel_unavailable');
    const frame = {
      taskId: ids.taskId,
      attemptId: ids.attemptId,
      direction: 'task_to_core',
      messageId,
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
        ) {
          if (attempt === 0) throw error;
          // A later refusal cannot disprove a prior attempt's unknown commit.
          throw new LauncherError('channel_unavailable', undefined, connectionAttempts);
        }
        if (attempt === 2)
          throw new LauncherError('channel_unavailable', undefined, connectionAttempts);
      }
    }
  }
  async function lifecycle(phase: 'running' | 'wrapping-up'): Promise<void> {
    try {
      await send('lifecycle', { phase });
    } catch {
      // Informational only: retain outputs and the terminal outcome even when
      // the phase cannot be observed. At most one fixed diagnostic per phase.
      diagnostic('lifecycle_unavailable');
    }
  }
  async function report(): Promise<void> {
    terminalAttempted = true;
    await transcript?.close();
    if (root)
      trace?.enqueue({
        ...root,
        endedAt: new Date().toISOString(),
        status:
          terminal.outcome === 'succeeded'
            ? 'ok'
            : terminal.outcome === 'aborted'
              ? 'suppressed'
              : 'failed',
        attrs: {
          ...root.attrs,
          outcome: terminal.outcome,
          reasonCode: terminal.reasonCode ?? null,
          failureSpanId: failureSpanId ?? null,
        },
      });
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
      typeof claim['softDueAt'] !== 'string' ||
      !Number.isFinite(Date.parse(claim['softDueAt'])) ||
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
    await mkdir(join(cwd, 'outputs'), { mode: 0o700 });
    const directory = `launcher_${randomUUID()}`;
    await mkdir(join(cwd, directory), { mode: 0o700 });
    traceId = typeof briefing['traceId'] === 'string' ? briefing['traceId'] : ids.taskId;
    trace = createTaskTraceChannel({
      endpoint: endpoint(options.env, 'CHANNEL'),
      env: options.env,
      identity: ids,
      traceId,
    });
    transcript = createTaskTranscriptChannel({
      endpoint: endpoint(options.env, 'CHANNEL'),
      env: options.env,
      identity: ids,
      nextSequence: () => ++sequence,
    });
    transcript.enqueue({
      id: `brief_${ids.launchId}`,
      role: 'user-briefing',
      time: new Date().toISOString(),
      text: transcriptText(`${outputInstructions(cwd)}\n\n${briefing['briefing']}`),
      tool: null,
    });
    root = {
      spanId: ids.launchId,
      parentSpanId: typeof briefing['parentSpanId'] === 'string' ? briefing['parentSpanId'] : null,
      component: 'task',
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: null,
      attrs: {
        taskId: ids.taskId,
        launchId: ids.launchId,
        harness: typeof briefing['harness'] === 'string' ? briefing['harness'] : '',
      },
    };
    trace.enqueue(root);
    const launchId = ids.launchId;
    let eventCount = 0;
    let sessionStarted = false;
    const onEvent = async (event: TaskHarnessEvent): Promise<void> => {
      if (event.type === 'transcript') {
        transcript?.enqueue(event.entry);
        return;
      }
      if (event.type === 'receipt') {
        commands?.receipt(event);
        return;
      }
      if (event.type === 'trace') {
        trace?.enqueue({
          ...event.span,
          spanId: `${launchId}_${event.span.spanId}`,
          parentSpanId: event.span.parentSpanId
            ? `${launchId}_${event.span.parentSpanId}`
            : launchId,
        });
        return;
      }
      if (++eventCount > 10_000) throw new LauncherError('event_limit');
      if (!sessionStarted && (event.type === 'step' || event.type === 'tool')) {
        sessionStarted = true;
        await lifecycle('running');
      }
      // Native harness events use fixed progress lines. Explicit MCP step/question
      // text goes to the durable mailbox; private model/tool content uses traces.
      const line =
        event.type === 'step'
          ? 'Task is working'
          : event.type === 'tool'
            ? 'Task is using a tool'
            : 'Harness reported an error';
      await send('step', { line });
    };
    tools = await createTaskTools({
      workDirectory: cwd,
      diagnostic: (code) => {
        diagnostic(code);
        process.stderr.write(`${JSON.stringify({ component: 'task-tools', code })}\n`);
      },
      report: (kind, text, messageId) =>
        send(kind, kind === 'step' ? { line: text } : { questionId: messageId, text }, messageId),
    });
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
          mcpServers: tools.mcpServers,
          question: tools.question,
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
    let intakeFailed = false;
    const execution = harness.start({
      text: `${outputInstructions(cwd)}\n\n${briefing['briefing']}`,
      model: 'lifemodel/task',
      softDueAt: claim['softDueAt'],
    });
    commands = createTaskCommandIntake({
      endpoint: endpoint(options.env, 'CHANNEL'),
      identity: ids,
      harness,
      onAnswerAdmitted: (questionId) => {
        tools?.answerAdmitted(questionId);
      },
      hardStopAt: Date.parse(claim['hardStopAt']),
      diagnostic: (level, code, status) => {
        diagnostic(code);
        process.stderr.write(
          `${JSON.stringify({ level, component: 'task-command-intake', code, status })}\n`
        );
      },
      onFatal: () => {
        intakeFailed = true;
        void harness?.abort().catch(() => undefined);
      },
    });
    commands.start();
    let result: TaskHarnessResult = await execution.finally(() => tools?.close());
    await commands.stop();
    await lifecycle('wrapping-up');
    if (intakeFailed)
      result = {
        outcome: 'failed',
        result: '',
        reasonCode: 'command_intake_failed',
      };
    failureSpanId = result.failureSpanId ? `${ids.launchId}_${result.failureSpanId}` : undefined;
    outputsStartedAt = new Date().toISOString();
    const resultName = `${directory}/${TASK_REPORT_NAME}`;
    terminal.outcome = result.outcome;
    terminal.summary =
      result.outcome === 'succeeded'
        ? 'Task result is ready'
        : result.outcome === 'aborted'
          ? 'Task was aborted'
          : 'Task could not complete';
    if (result.outcome !== 'succeeded' && result.reasonCode)
      terminal.reasonCode = /^[a-z][a-z0-9_]{0,63}$/.test(result.reasonCode)
        ? result.reasonCode
        : 'harness_failed';
    else delete terminal.reasonCode;
    const reasons: Record<string, number> = {};
    let skippedEntries = 0;
    let uploadFailures = 0;
    const warning = (code: string, upload = false) => {
      reasons[code] = (reasons[code] ?? 0) + 1;
      if (upload) uploadFailures++;
      else skippedEntries++;
    };
    const retain = async (action: () => Promise<void>, upload = false) => {
      try {
        await action();
      } catch (error) {
        if (result.outcome === 'succeeded') throw error;
        warning(error instanceof LauncherError ? error.code : 'output_collection_failed', upload);
      }
    };
    await retain(async () => {
      await writeFile(join(cwd, resultName), result.result, {
        flag: 'wx',
        mode: 0o600,
      });
      terminal.resultObjectId = await save(resultName, 'result', options.env, cwd, launchId);
    }, true);
    await retain(() =>
      collectOutputs(
        options.env,
        cwd,
        launchId,
        result.outcome === 'succeeded' ? undefined : warning
      )
    );
    await retain(async () => {
      terminal.artifactObjectIds = await artifacts(
        options.env,
        cwd,
        terminal.resultObjectId,
        result.outcome === 'succeeded' ? undefined : warning
      );
    }, true);
    if (skippedEntries || uploadFailures)
      trace?.enqueue({
        spanId: `${ids.launchId}_outputs`,
        parentSpanId: ids.launchId,
        component: 'task.outputs',
        startedAt: outputsStartedAt,
        endedAt: new Date().toISOString(),
        status: 'failed',
        attrs: {
          severity: 'warn',
          skippedEntries,
          uploadFailures,
          reasonCounts: JSON.stringify(reasons),
        },
      });
    await report();
    return result.outcome === 'succeeded' ? 0 : 1;
  } catch (error) {
    await tools?.close();
    await harness?.abort().catch(() => undefined);
    const code =
      error instanceof LauncherError
        ? error.code
        : options.signal?.aborted
          ? 'launcher_aborted'
          : 'launcher_failed';
    if (root && ids) {
      failureSpanId = `${ids.launchId}_launcher`;
      trace?.enqueue({
        spanId: failureSpanId,
        parentSpanId: ids.launchId,
        component: 'task.launcher',
        startedAt: outputsStartedAt ?? root.startedAt,
        endedAt: new Date().toISOString(),
        status: 'failed',
        attrs: { reasonCode: code },
      });
    }
    diagnostic(code);
    if (error instanceof LauncherError && error.connectionAttempts !== undefined)
      diagnostic(`connection_attempts=${String(error.connectionAttempts)}`);
    if (!terminalAttempted) {
      terminal.outcome = 'failed';
      terminal.summary = 'Task could not complete';
      terminal.reasonCode = code;
      try {
        await report();
      } catch (reportError) {
        diagnostic('terminal_unavailable');
        if (reportError instanceof LauncherError && reportError.connectionAttempts !== undefined)
          diagnostic(`connection_attempts=${String(reportError.connectionAttempts)}`);
      }
    }
    return 1;
  } finally {
    await commands?.stop();
    options.signal?.removeEventListener('abort', onAbort);
    trace?.close();
    await transcript?.close();
    await tools?.close();
    channel?.close();
    model?.close();
  }
}
