/**
 * One trace span per model call (lifemodel-d4t8).
 *
 * What this answers, from the database instead of a packet capture: what a
 * model call cost, whether its input was cached, what reasoning effort went
 * out, which gateway slot answered, and which part of the prompt changed when
 * a cache miss happened. The span is written at the SHARED provider boundary
 * (`BaseLLMProvider.complete`), so summary, compaction, reflection and every
 * other caller are covered by the same record.
 *
 * Names: the `gen_ai.*` attributes follow the OpenTelemetry GenAI semantic
 * conventions registry at semantic-conventions-genai commit
 * `3fe84604a581b3d50dd5b4bd29383b462d2a5018` (2026-10-28), the revision this
 * leaf was written against; see `docs/features/motor/observability.md`.
 * "Not reported" stays absent, never 0: a zero cached count would claim the
 * provider answered with no cache hit, and it did not answer at all.
 *
 * No prompt or answer text reaches a span. The request's stable prefix parts
 * are recorded as a sha-256 prefix and a character length only, so a cache
 * miss can be attributed to the part that changed without storing content.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getTraceContext } from '../core/trace-context.js';
import type { CompletionResponse } from './provider.js';
import type { TraceRecord, TraceWriter } from '../ports/observability.js';

/** The component name of a model-call span in the observability store. */
export const MODEL_CALL_COMPONENT = 'llm';

/**
 * The writer a model call records into. Never the owner of the call: recording
 * is fail-open, so a full or failing store cannot delay or fail a model call.
 */
export type ModelCallSpanSink = Pick<TraceWriter, 'enqueue'>;

/** One request against the endpoint: the attempt a call makes (ADR-013 D4). */
export interface ModelCallWire {
  /** How many HTTP attempts this call made. */
  attempts: number;
  /** The endpoint's answer status, when it answered at all. */
  httpStatus?: number;
  /** The gateway's own `x-lifemodel-slot` answer header. */
  slot?: string;
  /** The model string exactly as it left on the wire. */
  requestModel?: string;
  /** `reasoning_effort` exactly as it left on the wire. */
  reasoningEffort?: string;
  /** `max_tokens` (or its `max_completion_tokens` spelling) as it left. */
  maxTokens?: number;
  /** `temperature` exactly as it left on the wire. */
  temperature?: number;
  /** The message count as the endpoint received it. */
  messageCount?: number;
  /** The tool count as the endpoint received it. */
  toolCount?: number;
  /** The response model named by the endpoint's own answer. */
  responseModel?: string;
  /** The endpoint's response id, when the answer carried one. */
  responseId?: string;
  /** The endpoint's finish reason(s), when the answer carried one. */
  finishReasons?: string[];
  /** Provider-reported usage. Absent means "not reported", never 0. */
  usage?: {
    inputTokens?: number;
    cacheReadInputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
  /** Prefix fingerprints of the serialized request, when they were seen. */
  prefixes?: PrefixFingerprints;
  /** A code-only failure classification (never a message with values). */
  errorCode?: string;
}

/** One stable prefix part: a sha-256 prefix and the part's character length. */
export interface PrefixFingerprint {
  hash: string;
  size: number;
}

/**
 * The four stable prefix parts of one serialized chat request. A cache miss is
 * explained by which of them changed since the previous call.
 */
export interface PrefixFingerprints {
  /** The system message(s), as sent. */
  system?: PrefixFingerprint;
  /** The tool set, serialized as sent. */
  tools?: PrefixFingerprint;
  /** Every other message: the conversation the live context arrives after. */
  history?: PrefixFingerprint;
  /** The newest message: the live context of this call. */
  context?: PrefixFingerprint;
}

/** One logical model call, filled while the call proceeds. */
export class ModelCallTrace {
  readonly callId: string;
  readonly startedAt = new Date();
  readonly traceId: string;
  readonly parentSpanId: string | null;
  /** The trigger that woke the turn this call belongs to, when it is known. */
  readonly triggerType: string | undefined;
  readonly role: string | undefined;
  readonly requestModel: string | undefined;
  readonly requestMessageCount: number;
  readonly requestToolCount: number;
  wire: ModelCallWire = { attempts: 0 };
  /** Which usage counts the endpoint's answer carried; set on the wire path. */
  private reportedUsage:
    | { input: boolean; output: boolean; cached: boolean; reasoning: boolean }
    | undefined;
  /** This call's span id: 64 random bits, unique inside its trace. */
  readonly spanId = `chat_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

  constructor(request: {
    role?: string | undefined;
    model?: string | undefined;
    messages?: readonly unknown[] | undefined;
    tools?: readonly unknown[] | undefined;
  }) {
    this.callId = `call_${randomUUID()}`;
    const context = getTraceContext();
    // A call with no turn context starts its own trace: the record is worth
    // more than the parent it lacks.
    this.traceId = context?.traceId ?? this.callId;
    this.parentSpanId = context?.spanId ?? null;
    this.triggerType = context?.triggerType;
    this.role = request.role;
    this.requestModel = request.model;
    this.requestMessageCount = request.messages?.length ?? 0;
    this.requestToolCount = request.tools?.length ?? 0;
  }

  /** The request facts the transport read off the serialized body. */
  observeRequest(body: Record<string, unknown>): void {
    if (typeof body['model'] === 'string') this.wire.requestModel = body['model'];
    if (typeof body['reasoning_effort'] === 'string')
      this.wire.reasoningEffort = body['reasoning_effort'];
    const maxTokens = body['max_tokens'] ?? body['max_completion_tokens'];
    if (typeof maxTokens === 'number') this.wire.maxTokens = maxTokens;
    if (typeof body['temperature'] === 'number') this.wire.temperature = body['temperature'];
    const messages = body['messages'];
    if (Array.isArray(messages)) this.wire.messageCount = messages.length;
    const tools = body['tools'];
    if (Array.isArray(tools)) this.wire.toolCount = tools.length;
    this.wire.prefixes = prefixFingerprints(body);
  }

  /** The endpoint's answer frame, read before the body reaches the SDK. */
  observeResponse(status: number, headers: Headers | { get(name: string): string | null }): void {
    this.wire.attempts += 1;
    this.wire.httpStatus = status;
    const slot = headers.get('x-lifemodel-slot');
    if (typeof slot === 'string' && slot.length > 0) this.wire.slot = slot;
  }

  /**
   * Which counts the endpoint's own usage object carried, read off the wire
   * before the transport maps it. The AI SDK defaults a missing cache and
   * reasoning count to 0, so the wire is the only witness of "not reported".
   */
  observeWireUsage(usage: Record<string, unknown>): void {
    const detail = (name: string): Record<string, unknown> => {
      const value = usage[name];
      return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
    };
    this.reportedUsage = {
      input: typeof usage['prompt_tokens'] === 'number',
      output: typeof usage['completion_tokens'] === 'number',
      cached: typeof detail('prompt_tokens_details')['cached_tokens'] === 'number',
      reasoning: typeof detail('completion_tokens_details')['reasoning_tokens'] === 'number',
    };
  }

  /** The provider-reported usage, with "not reported" kept absent. */
  observeUsage(usage: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    inputTokenDetails?: { cacheReadTokens?: number | undefined } | undefined;
    outputTokenDetails?: { reasoningTokens?: number | undefined } | undefined;
    reasoningTokens?: number | undefined;
  }): void {
    const reported = this.reportedUsage;
    // A count the wire did not carry has no number to bring: the SDK's 0 is
    // the transport's default, not the provider's answer. A cached count is
    // also only meaningful when non-zero, which is what the convention says.
    const count = (value: number | undefined, carried: boolean, nonZeroOnly: boolean) => {
      if (typeof value !== 'number') return undefined;
      // The wire is the witness of what was reported. Without it a 0 cannot be
      // told from a missing count, so only a positive count is recorded.
      if (reported ? !carried : value <= 0) return undefined;
      if (nonZeroOnly && value <= 0) return undefined;
      return value;
    };
    const recorded: NonNullable<ModelCallWire['usage']> = {};
    const input = count(usage.inputTokens, reported?.input ?? false, false);
    if (input !== undefined) recorded.inputTokens = input;
    const output = count(usage.outputTokens, reported?.output ?? false, false);
    if (output !== undefined) recorded.outputTokens = output;
    const cached = count(usage.inputTokenDetails?.cacheReadTokens, reported?.cached ?? false, true);
    if (cached !== undefined) recorded.cacheReadInputTokens = cached;
    const reasoning = count(
      usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens,
      reported?.reasoning ?? false,
      true
    );
    if (reasoning !== undefined) recorded.reasoningOutputTokens = reasoning;
    this.wire.usage = recorded;
  }

  /** The classified failure, code only: a span never carries error text. */
  fail(code: string): void {
    this.wire.errorCode ??= code;
  }
}

/** sha-256 of one prefix part, first 16 hex characters, plus its length. */
export function fingerprint(part: string): PrefixFingerprint {
  return { hash: createHash('sha256').update(part).digest('hex').slice(0, 16), size: part.length };
}

/** A JSON array from the wire body, without letting `any` into the records. */
function objectList(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

/** The serialized part's fingerprint; empty text has a fingerprint too. */
function fingerprintValue(value: unknown): PrefixFingerprint {
  return fingerprint(typeof value === 'string' ? value : JSON.stringify(value));
}

/**
 * The four stable prefix parts of a serialized chat request.
 *
 * The system messages are the leading part, the tool set is sent unchanged on
 * every call, the newest message is the live context and everything else is
 * history. On a chat turn that is exactly "the messages between the system
 * messages and the last user message"; in a tool continuation the finished
 * round's assistant and tool messages are history and the newest tool result
 * is the live context, because the live context is what changed since the
 * previous call.
 */
export function prefixFingerprints(body: {
  messages?: unknown;
  tools?: unknown;
}): PrefixFingerprints {
  const parts: PrefixFingerprints = {};
  if (body.tools !== undefined) parts.tools = fingerprintValue(body.tools);
  const messages = objectList(body.messages);
  if (messages.length === 0) return parts;
  const roleOf = (message: unknown): unknown =>
    typeof message === 'object' && message !== null
      ? (message as { role?: unknown }).role
      : undefined;
  const system = messages.filter((message) => roleOf(message) === 'system');
  const rest = messages.filter((message) => roleOf(message) !== 'system');
  if (system.length > 0) parts.system = fingerprintValue(system);
  const live = rest.at(-1);
  if (live !== undefined) parts.context = fingerprintValue(live);
  const history = rest.slice(0, -1);
  if (history.length > 0) parts.history = fingerprintValue(history);
  return parts;
}

function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null) target[key] = value;
}

function putPrefix(
  attrs: Record<string, unknown>,
  name: string,
  part: PrefixFingerprint | undefined
): void {
  if (!part) return;
  attrs[`lifemodel.prefix.${name}.hash`] = part.hash;
  attrs[`lifemodel.prefix.${name}.size`] = part.size;
}

/**
 * The span attributes of one finished model call.
 *
 * Exported for the checks and for the reader's expectations: the names are the
 * contract the doctor command and the docs describe.
 */
export function modelCallAttributes(call: ModelCallTrace): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    'gen_ai.operation.name': 'chat',
    // The wire is OpenAI Chat Completions. The platform's gateway hides which
    // upstream served it; `lifemodel.slot` names the answering slot.
    'gen_ai.provider.name': 'openai',
    'lifemodel.call_id': call.callId,
    'lifemodel.attempt': Math.max(1, call.wire.attempts),
  };
  const model = call.wire.requestModel ?? call.requestModel;
  attrs['span.name'] = model ? `chat ${model}` : 'chat';
  put(attrs, 'gen_ai.request.model', model);
  put(attrs, 'gen_ai.response.model', call.wire.responseModel);
  put(attrs, 'gen_ai.response.id', call.wire.responseId);
  put(attrs, 'gen_ai.response.finish_reasons', call.wire.finishReasons);
  put(attrs, 'gen_ai.request.max_tokens', call.wire.maxTokens);
  put(attrs, 'gen_ai.request.temperature', call.wire.temperature);
  put(attrs, 'lifemodel.role', call.role);
  put(attrs, 'lifemodel.trigger_type', call.triggerType);
  put(attrs, 'lifemodel.request.reasoning_effort', call.wire.reasoningEffort);
  put(attrs, 'lifemodel.slot', call.wire.slot);
  put(attrs, 'lifemodel.http.status', call.wire.httpStatus);
  put(attrs, 'lifemodel.error_code', call.wire.errorCode);
  const usage = call.wire.usage;
  if (usage) {
    put(attrs, 'gen_ai.usage.input_tokens', usage.inputTokens);
    put(attrs, 'gen_ai.usage.output_tokens', usage.outputTokens);
    put(attrs, 'gen_ai.usage.cache_read.input_tokens', usage.cacheReadInputTokens);
    put(attrs, 'gen_ai.usage.reasoning.output_tokens', usage.reasoningOutputTokens);
  }
  attrs['lifemodel.message_count'] = call.wire.messageCount ?? call.requestMessageCount;
  attrs['lifemodel.tool_count'] = call.wire.toolCount ?? call.requestToolCount;
  const prefixes = call.wire.prefixes;
  if (prefixes) {
    putPrefix(attrs, 'system', prefixes.system);
    putPrefix(attrs, 'tools', prefixes.tools);
    putPrefix(attrs, 'history', prefixes.history);
    putPrefix(attrs, 'context', prefixes.context);
  }
  return attrs;
}

/** The failure code of a call that did not answer, from facts only. */
export function modelCallErrorCode(call: ModelCallTrace, error: unknown): string {
  if (call.wire.errorCode) return call.wire.errorCode;
  const status =
    call.wire.httpStatus ??
    (error instanceof Error && 'statusCode' in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined);
  if (typeof status === 'number' && status >= 400) return `http_${String(status)}`;
  // A call that never reached the endpoint (no model for the role, no base
  // URL) is a configuration failure; one that left and did not answer is a
  // transport failure. Neither carries the error's text.
  if (call.wire.attempts === 0) return 'configuration';
  return 'transport';
}

/**
 * Record one finished model call into the trace store, closed and fail-open.
 *
 * Called once per call, from the shared provider boundary, after the answer or
 * the failure: a record is never awaited and never throws into the caller.
 */
export function recordModelCall(
  traces: ModelCallSpanSink | undefined,
  call: ModelCallTrace,
  outcome: { response?: CompletionResponse; error?: unknown }
): void {
  if (!traces) return;
  try {
    const endedAt = new Date();
    if (outcome.response) {
      if (call.wire.responseId === undefined && outcome.response.generationId !== undefined)
        call.wire.responseId = outcome.response.generationId;
      const finish = outcome.response.finishReason;
      if (finish !== undefined) call.wire.finishReasons = [finish];
    } else {
      call.fail(modelCallErrorCode(call, outcome.error));
    }
    const record: TraceRecord = {
      kind: 'span',
      span: {
        traceId: call.traceId,
        spanId: call.spanId,
        parentSpanId: call.parentSpanId,
        component: MODEL_CALL_COMPONENT,
        startedAt: call.startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        status: outcome.response ? 'ok' : 'failed',
        attrs: buildAttributes(call, endedAt),
      },
    };
    traces.enqueue(record);
  } catch {
    // Disposable evidence: a store failure must never reach the model call.
  }
}

/** The span's attributes, with the call's own duration added. */
function buildAttributes(call: ModelCallTrace, endedAt: Date): Record<string, unknown> {
  const attrs = modelCallAttributes(call);
  attrs['lifemodel.duration_ms'] = Math.max(0, endedAt.getTime() - call.startedAt.getTime());
  return attrs;
}
