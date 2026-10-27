/** Core-only task channel. Never exposed through PluginPrimitives. */
import type { TaskProfile } from './tasks.js';
import type { TraceSpan } from './observability.js';

/** Locators only; discovery is not a start grant. */
export interface TaskLaunchIdentity {
  readonly taskId: string;
  readonly attemptId: string;
  readonly launchId: string;
}
export interface TaskBriefing extends TaskLaunchIdentity {
  readonly traceId: string;
  readonly parentSpanId: string | null;
  readonly briefing: string;
  readonly harness: string;
  readonly profile: TaskProfile;
}

export type TaskChannelDirection = 'task_to_core';

/** Structural live Kubernetes proof; callers must verify it freshly for each request. */
export interface TaskChannelProof {
  readonly podUid: string;
  readonly podName: string;
  readonly jobUid: string;
  readonly jobName: string;
  readonly launchLabel: string;
  readonly templateHash: string;
  readonly startedAt: string;
}

interface TerminalObjects {
  readonly summary: string;
  readonly resultObjectId: string | null;
  readonly artifactObjectIds: readonly string[];
}
/** Semantic outcome only. Object contents and URLs never belong on this channel. */
export type TaskTerminalReport = TerminalObjects &
  (
    | { readonly outcome: 'succeeded' | 'aborted'; readonly reasonCode?: never }
    | { readonly outcome: 'failed'; readonly reasonCode: string }
  );
interface FrameIdentity {
  readonly taskId: string;
  readonly attemptId: string;
  readonly direction: TaskChannelDirection;
  readonly messageId: string;
  /** Independent per task, direction and attempt. Gaps and reordering are valid. */
  readonly sequence: number;
}
export type TaskChannelFrame = FrameIdentity &
  (
    | { readonly kind: 'step'; readonly payload: { readonly line: string } }
    | {
        readonly kind: 'question';
        readonly payload: { readonly questionId: string; readonly text: string };
      }
    | { readonly kind: 'terminal'; readonly payload: TaskTerminalReport }
  );
export interface TaskChannelAck extends FrameIdentity {
  readonly receivedAt: string;
}
export interface StoredTaskChannelFrame {
  readonly frame: TaskChannelFrame;
  readonly ack: TaskChannelAck;
}
export interface TaskChannelCursor {
  readonly taskId: string;
  readonly direction: TaskChannelDirection;
  readonly receivedCount: string;
  readonly lastReceivedMessageId: string;
  readonly signalledCount: string;
  readonly lastSignalledMessageId: string | null;
}
export type TaskChannelErrorCode =
  | 'invalid_frame'
  | 'invalid_input'
  | 'identity_mismatch'
  | 'not_found'
  | 'terminal_attempt'
  | 'message_conflict'
  | 'sequence_conflict'
  | 'question_open'
  | 'question_absent'
  | 'wrapping_attempt'
  | 'command_capacity'
  | 'storage_error'
  | 'cancelled'
  | 'stopped'
  | 'identity_denied'
  | 'identity_unavailable'
  | 'identity_config'
  | 'access_revoked'
  | 'channel_config'
  | 'channel_unavailable';
/** Safe to log by code/status only; never carries frame data or SQL causes. */
export class TaskChannelError extends Error {
  constructor(
    readonly status: number,
    readonly code: TaskChannelErrorCode
  ) {
    super(`TaskChannelError: ${code}`);
    this.name = 'TaskChannelError';
  }
}
export interface TaskMailbox {
  /** Fresh Job binding, active intent and allocation; no claim or briefing. */
  readIdentity(proof: TaskChannelProof, signal?: AbortSignal): Promise<TaskLaunchIdentity>;
  /** Same live authority plus the exact won start claim and projection. */
  readBriefing(proof: TaskChannelProof, signal?: AbortSignal): Promise<TaskBriefing>;
  /** Disposable trace authority. Must not exclusively lock task or launch rows. */
  readTraceAuthority?(proof: TaskChannelProof, signal?: AbortSignal): Promise<TaskBriefing>;
  append(
    frame: TaskChannelFrame,
    proof: TaskChannelProof,
    signal?: AbortSignal
  ): Promise<TaskChannelAck>;
  /** No sequence watermark: every committed, not-yet-signalled row is eligible. */
  listUnsignalled(limit?: number, signal?: AbortSignal): Promise<readonly StoredTaskChannelFrame[]>;
  /** Call only AFTER durable bus admission deduplicated by task+direction+message ID. */
  markSignalled(
    taskId: string,
    direction: TaskChannelDirection,
    messageId: string,
    signal?: AbortSignal
  ): Promise<void>;
  /** Finalizer (653.8.9) reads the committed semantic report; receipt is not itself finalization. */
  readTerminal(
    taskId: string,
    attemptId: string,
    signal?: AbortSignal
  ): Promise<StoredTaskChannelFrame | null>;
  /** Informational receipt metadata, never a contiguous sequence or replay filter. */
  readCursor(
    taskId: string,
    direction: TaskChannelDirection,
    signal?: AbortSignal
  ): Promise<TaskChannelCursor | null>;
  /** Cancels owned operations. The caller still owns the independent bounded pool. */
  stop(): void;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort().join(',') === expected.sort().join(',');
}
function line(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= 1024 &&
    !/[\r\n]/.test(value) &&
    !value.includes('\0')
  );
}
function id(value: unknown): boolean {
  return typeof value === 'string' && ID.test(value);
}
/** Strict wire validator. Returns a detached immutable-content snapshot. */
export function validateTaskChannelFrame(value: unknown): TaskChannelFrame {
  const invalid = (): never => {
    throw new TaskChannelError(400, 'invalid_frame');
  };
  if (
    !object(value) ||
    !keys(value, [
      'taskId',
      'attemptId',
      'direction',
      'messageId',
      'sequence',
      'kind',
      'payload',
    ]) ||
    !id(value['taskId']) ||
    !id(value['attemptId']) ||
    !id(value['messageId']) ||
    value['direction'] !== 'task_to_core' ||
    !Number.isSafeInteger(value['sequence']) ||
    (value['sequence'] as number) < 1 ||
    !object(value['payload'])
  )
    return invalid();
  const payload = value['payload'];
  if (value['kind'] === 'step') {
    if (!keys(payload, ['line']) || !line(payload['line'])) return invalid();
  } else if (value['kind'] === 'question') {
    if (
      !keys(payload, ['questionId', 'text']) ||
      payload['questionId'] !== value['messageId'] ||
      !line(payload['text'])
    )
      return invalid();
  } else if (value['kind'] === 'terminal') {
    const failed = payload['outcome'] === 'failed';
    if (
      !['succeeded', 'failed', 'aborted'].includes(payload['outcome'] as string) ||
      !keys(payload, [
        'outcome',
        'summary',
        'resultObjectId',
        'artifactObjectIds',
        ...(failed ? ['reasonCode'] : []),
      ]) ||
      (failed &&
        (typeof payload['reasonCode'] !== 'string' || !CODE.test(payload['reasonCode']))) ||
      !line(payload['summary']) ||
      !(payload['resultObjectId'] === null || id(payload['resultObjectId'])) ||
      !Array.isArray(payload['artifactObjectIds']) ||
      payload['artifactObjectIds'].length > 64 ||
      !payload['artifactObjectIds'].every(id) ||
      new Set(payload['artifactObjectIds']).size !== payload['artifactObjectIds'].length
    )
      return invalid();
  } else return invalid();
  // Reject exotic input objects/getters via JSON and keep callers from changing
  // content while authentication or SQL waits. JSON byte limit also bounds ACK work.
  try {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 65_536) return invalid();
    return JSON.parse(encoded) as TaskChannelFrame;
  } catch {
    return invalid();
  }
}

/** Best-effort observation, not a durable step/terminal frame. */
export interface TaskTraceFrame extends TaskLaunchIdentity {
  readonly span: TraceSpan;
}
export function validateTaskTraceFrame(value: unknown): TaskTraceFrame {
  const invalid = (): never => {
    throw new TaskChannelError(400, 'invalid_frame');
  };
  if (
    !object(value) ||
    !keys(value, ['taskId', 'attemptId', 'launchId', 'span']) ||
    !id(value['taskId']) ||
    !id(value['attemptId']) ||
    !id(value['launchId']) ||
    !object(value['span'])
  )
    return invalid();
  const span = value['span'];
  if (
    !keys(span, [
      'traceId',
      'spanId',
      'parentSpanId',
      'component',
      'startedAt',
      'endedAt',
      'status',
      'attrs',
    ]) ||
    !id(span['traceId']) ||
    !id(span['spanId']) ||
    !(span['parentSpanId'] === null || id(span['parentSpanId'])) ||
    typeof span['component'] !== 'string' ||
    !/^task(?:[.][a-z_]+)?$/.test(span['component']) ||
    typeof span['startedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(span['startedAt'])) ||
    !(
      span['endedAt'] === null ||
      (typeof span['endedAt'] === 'string' && Number.isFinite(Date.parse(span['endedAt'])))
    ) ||
    ![null, 'ok', 'failed', 'suppressed'].includes(span['status'] as null | string) ||
    (span['endedAt'] === null) !== (span['status'] === null) ||
    !object(span['attrs'])
  )
    return invalid();
  try {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 32768 || Object.keys(span['attrs']).length > 32)
      return invalid();
    for (const [key, field] of Object.entries(span['attrs'])) {
      if (
        key.length > 128 ||
        (!['string', 'number', 'boolean'].includes(typeof field) && field !== null) ||
        (typeof field === 'string' && Buffer.byteLength(field) > 8192) ||
        (typeof field === 'number' && !Number.isFinite(field))
      )
        return invalid();
    }
    return JSON.parse(encoded) as TaskTraceFrame;
  } catch {
    return invalid();
  }
}

/** Core-to-task commands are immutable; the core assigns their per-task order. */
export interface TaskCommandInput {
  readonly taskId: string;
  readonly attemptId: string;
  readonly commandId: string;
  readonly kind: 'steer' | 'answer';
  readonly text: string;
  readonly questionId?: string;
}
export interface TaskCommand extends TaskCommandInput {
  readonly direction: 'core_to_task';
  readonly sequence: number;
}
export interface TaskCommandAck {
  readonly taskId: string;
  readonly attemptId: string;
  readonly commandId: string;
  readonly disposition: 'accepted' | 'rejected' | 'uncertain';
}
export interface TaskCommandReceipt {
  readonly taskId: string;
  readonly attemptId: string;
  readonly commandId: string;
  readonly receiptId: string;
  readonly disposition: 'inserted' | 'deferred-to-next-turn' | 'failed' | 'uncertain';
}
export interface TaskQuestion {
  readonly taskId: string;
  readonly attemptId: string;
  readonly questionId: string;
  readonly text: string;
  readonly answerCommandId: string | null;
}
export interface TaskCommandStatus extends TaskCommand {
  readonly disposition: TaskCommandAck['disposition'] | 'queued';
  readonly receipts: readonly TaskCommandReceipt[];
  /** Rejected intake is safe to retry in a NEW deciding turn, never by replay. */
  readonly retryable: boolean;
}
export interface TaskCommandReader {
  readCommand(commandId: string): Promise<TaskCommandStatus | null>;
  readCommands(taskId: string): Promise<readonly TaskCommandStatus[]>;
  readQuestion(taskId: string, questionId?: string): Promise<TaskQuestion | null>;
}
export interface TaskCommandMailbox {
  enqueueCommand(command: TaskCommandInput, signal?: AbortSignal): Promise<TaskCommand>;
  /** Immediate authorized recheck, never a held database transaction. */
  pollCommand(proof: TaskChannelProof, signal?: AbortSignal): Promise<TaskCommand | null>;
  acknowledgeCommand(
    ack: TaskCommandAck,
    proof: TaskChannelProof,
    signal?: AbortSignal
  ): Promise<void>;
  recordCommandReceipt(
    receipt: TaskCommandReceipt,
    proof: TaskChannelProof,
    signal?: AbortSignal
  ): Promise<void>;
  subscribeCommands(taskId: string, wake: () => void): () => void;
}
/** Deterministic text gate, including JSON escaping and the largest wire identity.
 * Reserve the answer envelope too, so either operation fits the configured channel.
 */
export function isTaskCommandText(value: unknown, frameLimit = 65_536): value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return false;
  const identity = 'x'.repeat(128);
  const command = {
    taskId: identity,
    attemptId: identity,
    commandId: identity,
    kind: 'answer',
    text: value,
    questionId: identity,
  };
  return (
    Buffer.byteLength(JSON.stringify(command)) <= 60_000 &&
    Buffer.byteLength(
      JSON.stringify({
        command: { ...command, direction: 'core_to_task', sequence: Number.MAX_SAFE_INTEGER },
      })
    ) <= frameLimit
  );
}
export function validateTaskCommandInput(value: unknown): TaskCommandInput {
  if (
    !object(value) ||
    !keys(value, [
      'taskId',
      'attemptId',
      'commandId',
      'kind',
      'text',
      ...(value['questionId'] === undefined ? [] : ['questionId']),
    ]) ||
    !id(value['taskId']) ||
    !id(value['attemptId']) ||
    !id(value['commandId']) ||
    !['steer', 'answer'].includes(value['kind'] as string) ||
    !isTaskCommandText(value['text']) ||
    Buffer.byteLength(JSON.stringify(value)) > 60000 ||
    (value['kind'] === 'answer' ? !id(value['questionId']) : value['questionId'] !== undefined)
  )
    throw new TaskChannelError(400, 'invalid_frame');
  return JSON.parse(JSON.stringify(value)) as TaskCommandInput;
}
export function validateTaskCommandAck(value: unknown): TaskCommandAck {
  if (
    !object(value) ||
    !keys(value, ['taskId', 'attemptId', 'commandId', 'disposition']) ||
    !id(value['taskId']) ||
    !id(value['attemptId']) ||
    !id(value['commandId']) ||
    !['accepted', 'rejected', 'uncertain'].includes(value['disposition'] as string)
  )
    throw new TaskChannelError(400, 'invalid_frame');
  return JSON.parse(JSON.stringify(value)) as TaskCommandAck;
}
export function validateTaskCommandReceipt(value: unknown): TaskCommandReceipt {
  if (
    !object(value) ||
    !keys(value, ['taskId', 'attemptId', 'commandId', 'receiptId', 'disposition']) ||
    !id(value['taskId']) ||
    !id(value['attemptId']) ||
    !id(value['commandId']) ||
    !id(value['receiptId']) ||
    !['inserted', 'deferred-to-next-turn', 'failed', 'uncertain'].includes(
      value['disposition'] as string
    )
  )
    throw new TaskChannelError(400, 'invalid_frame');
  return JSON.parse(JSON.stringify(value)) as TaskCommandReceipt;
}
