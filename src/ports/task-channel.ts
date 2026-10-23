/** Core-only task channel. Never exposed through PluginPrimitives. */
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
  readonly logObjectId: string | null;
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
  } else if (value['kind'] === 'terminal') {
    const failed = payload['outcome'] === 'failed';
    if (
      !['succeeded', 'failed', 'aborted'].includes(payload['outcome'] as string) ||
      !keys(payload, [
        'outcome',
        'summary',
        'resultObjectId',
        'logObjectId',
        'artifactObjectIds',
        ...(failed ? ['reasonCode'] : []),
      ]) ||
      (failed &&
        (typeof payload['reasonCode'] !== 'string' || !CODE.test(payload['reasonCode']))) ||
      !line(payload['summary']) ||
      ![payload['resultObjectId'], payload['logObjectId']].every((v) => v === null || id(v)) ||
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
