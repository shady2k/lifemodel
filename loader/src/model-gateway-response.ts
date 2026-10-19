/** Bounded, decoded inspection of everything returned from a model (ADR-013 G-01/B-01). */

/**
 * Why an upstream answer was rejected, safe to log: a fixed check code, the
 * JSON path into the answer with array indexes, and — when the check is about
 * a type — only the JSON type name that was found (ADR-013 D4). Never a
 * value, a key or any other string from the body.
 */
export interface RejectReason {
  check: string;
  path: string;
  got?: string;
}

export class GatewayError extends Error {
  constructor(
    readonly code: string,
    readonly status = 502,
    readonly reason?: RejectReason
  ) {
    super(code);
  }
}

/** Only a JSON type name: the value itself never leaves the check. */
function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** A `bad_response` rejection carrying its safe reason. */
export function badResponse(check: string, path: string, got?: string): GatewayError {
  return new GatewayError('bad_response', 502, {
    check,
    path,
    ...(got === undefined ? {} : { got }),
  });
}

/** An `unsafe_response` rejection carrying its safe reason. */
export function unsafeResponse(check: string, path: string): GatewayError {
  return new GatewayError('unsafe_response', 502, { check, path });
}
export const MAX_BODY = 1024 * 1024;
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function containsKey(value: unknown, key: string, depth = 0): boolean {
  if (depth > 64) throw badResponse('nesting_depth', '');
  if (typeof value === 'string') return value.includes(key);
  if (Array.isArray(value)) return value.some((item: unknown) => containsKey(item, key, depth + 1));
  const object = record(value);
  return (
    object !== undefined &&
    Object.entries(object).some(
      ([name, item]) => name.includes(key) || containsKey(item, key, depth + 1)
    )
  );
}
export function serializeSafe(value: unknown, keys: readonly string[]): string {
  const text = JSON.stringify(value);
  if (keys.some((key) => text.includes(key))) throw unsafeResponse('forbidden_key', '');
  return text;
}
export function parseSafe(text: string, keys: readonly string[]): unknown {
  if (Buffer.byteLength(text) > MAX_BODY) throw badResponse('body_size', '');
  try {
    const value: unknown = JSON.parse(text);
    if (keys.some((key) => text.includes(key) || containsKey(value, key)))
      throw unsafeResponse('forbidden_key', '');
    return value;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw badResponse('json_syntax', '');
  }
}
function toolCall(value: unknown, partial: boolean): boolean {
  const call = record(value);
  if (!call) return false;
  const fn = record(call['function']);
  if (!partial)
    return (
      typeof call['id'] === 'string' &&
      call['type'] === 'function' &&
      fn !== undefined &&
      typeof fn['name'] === 'string' &&
      typeof fn['arguments'] === 'string'
    );
  return (
    Number.isSafeInteger(call['index']) &&
    Number(call['index']) >= 0 &&
    Object.keys(call).every((key) => ['index', 'id', 'type', 'function'].includes(key)) &&
    (call['id'] === undefined || typeof call['id'] === 'string') &&
    (call['type'] === undefined || call['type'] === 'function') &&
    (call['function'] === undefined ||
      (fn !== undefined &&
        Object.keys(fn).every((key) => ['name', 'arguments'].includes(key)) &&
        (fn['name'] === undefined || typeof fn['name'] === 'string') &&
        (fn['arguments'] === undefined || typeof fn['arguments'] === 'string')))
  );
}
const TEXT_FIELDS = ['content', 'reasoning', 'reasoning_content', 'refusal'];
function validateDelta(delta: Record<string, unknown>, path: string): void {
  for (const [field, value] of Object.entries(delta)) {
    if (TEXT_FIELDS.includes(field)) {
      if (value !== null && typeof value !== 'string')
        throw badResponse('text_field_type', `${path}.${field}`, jsonType(value));
    } else if (field === 'role') {
      if (value !== 'assistant') throw badResponse('role_value', `${path}.role`, jsonType(value));
    } else if (field === 'tool_calls') {
      // `tool_calls: null` is a common OpenAI-compatible encoding of "no tool calls".
      if (value !== null) {
        if (!Array.isArray(value))
          throw badResponse('tool_calls_type', `${path}.tool_calls`, jsonType(value));
        const call = value.findIndex((item: unknown) => !toolCall(item, true));
        if (call >= 0)
          throw badResponse(
            'tool_call_shape',
            `${path}.tool_calls[${String(call)}]`,
            jsonType(value[call])
          );
      }
    } else
      // The unknown field's own name comes from the body and is never logged.
      throw badResponse('delta_field', path, jsonType(value));
  }
}
export function validateResponse(value: unknown, models: boolean): void {
  const object = record(value);
  if (models) {
    if (!object) throw badResponse('models_shape', '', jsonType(value));
    const data = object['data'];
    if (!Array.isArray(data)) throw badResponse('models_data_type', 'data', jsonType(data));
    const index = data.findIndex((item: unknown) => typeof record(item)?.['id'] !== 'string');
    if (index >= 0)
      throw badResponse(
        'model_id_type',
        `data[${String(index)}].id`,
        jsonType(record(data[index])?.['id'])
      );
    return;
  }
  if (!object) throw badResponse('response_shape', '', jsonType(value));
  if (typeof object['model'] !== 'string')
    throw badResponse('model_type', 'model', jsonType(object['model']));
  const choices = object['choices'];
  if (!Array.isArray(choices)) throw badResponse('choices_type', 'choices', jsonType(choices));
  if (choices.length === 0) throw badResponse('choices_empty', 'choices');
  for (const [index, choice] of choices.entries()) {
    const message = record(record(choice)?.['message']);
    if (!message)
      throw badResponse(
        'message_shape',
        `choices[${String(index)}].message`,
        jsonType(record(choice)?.['message'])
      );
    const tools = message['tool_calls'];
    // `tool_calls: null` is a common OpenAI-compatible encoding of "no tool calls".
    if (tools !== undefined && tools !== null) {
      if (!Array.isArray(tools))
        throw badResponse(
          'tool_calls_type',
          `choices[${String(index)}].message.tool_calls`,
          jsonType(tools)
        );
      const call = tools.findIndex((item: unknown) => !toolCall(item, false));
      if (call >= 0)
        throw badResponse(
          'tool_call_shape',
          `choices[${String(index)}].message.tool_calls[${String(call)}]`,
          jsonType(tools[call])
        );
    }
    const content = message['content'];
    const calls = Array.isArray(tools) ? tools : [];
    if (typeof content !== 'string' && !(content === null && calls.length > 0))
      throw badResponse(
        'content_type',
        `choices[${String(index)}].message.content`,
        jsonType(content)
      );
  }
}
/**
 * Only parsed/re-encoded data frames cross this boundary. A queue retains whole
 * frames whenever any reconstructed string ends in a possible credential prefix.
 * This preserves frame order and tool metadata without inventing synthetic deltas.
 */
interface StreamTool {
  /** The tool's array position in the frame that first mentioned it. */
  origin: number;
  id: boolean;
  type: boolean;
  name: boolean;
  arguments: boolean;
}
interface StreamChoice {
  /** The choice's array position in the frame that first mentioned it. */
  origin: number;
  finished: boolean;
  hasText: boolean;
  tools: Map<number, StreamTool>;
}
export class SafeEventStream {
  private readonly tails = new Map<string, string>();
  private readonly choices = new Map<number, StreamChoice>();
  private toolCount = 0;
  private queued: string[] = [];
  private queuedBytes = 0;
  private carry = '';
  private seenCompletion = false;
  done = false;
  constructor(private readonly keys: () => readonly string[]) {}
  frame(raw: string): string {
    if (this.done || Buffer.byteLength(raw) > MAX_BODY) throw badResponse('frame_size', '');
    const data = raw
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    // Comments/heartbeats are not forwarded unparsed.
    if (!data) return '';
    if (data === '[DONE]') {
      if (!this.seenCompletion || [...this.choices.values()].some((choice) => !choice.finished))
        throw badResponse('premature_done', '');
      this.done = true;
      return this.flush() + 'data: [DONE]\n\n';
    }
    const value = parseSafe(data, this.keys());
    const object = record(value);
    if (typeof object?.['model'] !== 'string')
      throw badResponse('model_type', 'model', jsonType(object?.['model']));
    if (!Array.isArray(object['choices']))
      throw badResponse('choices_type', 'choices', jsonType(object['choices']));
    if (object['choices'].length === 0 && (!this.seenCompletion || !record(object['usage'])))
      throw badResponse('empty_choices', 'choices');
    for (const [position, choice] of (object['choices'] as unknown[]).entries()) {
      const item = record(choice);
      const index = item?.['index'];
      if (!Number.isSafeInteger(index) || Number(index) < 0)
        throw badResponse('choice_index', `choices[${String(position)}].index`, jsonType(index));
      const delta = record(item?.['delta']);
      if (!delta)
        throw badResponse(
          'delta_shape',
          `choices[${String(position)}].delta`,
          jsonType(item?.['delta'])
        );
      validateDelta(delta, `choices[${String(position)}].delta`);
      if (!this.seenCompletion && Object.keys(delta).length === 0)
        throw badResponse('empty_delta', `choices[${String(position)}].delta`);
      this.seenCompletion = true;
      const choiceIndex = Number(index);
      const state = this.choices.get(choiceIndex) ?? {
        origin: position,
        finished: false,
        hasText: false,
        tools: new Map<number, StreamTool>(),
      };
      if (state.finished) throw badResponse('finished_choice', `choices[${String(position)}]`);
      this.choices.set(choiceIndex, state);
      if (this.choices.size > 128) throw badResponse('choice_count', 'choices');
      // Typed tuples cannot alias through attacker-controlled field names.
      for (const field of TEXT_FIELDS) {
        const text = delta[field];
        if (typeof text === 'string') {
          state.hasText = true;
          this.inspect(text, JSON.stringify([index, field]));
        }
      }
      if (Array.isArray(delta['tool_calls']))
        for (const [toolPosition, value] of (delta['tool_calls'] as unknown[]).entries()) {
          const call = record(value);
          const fn = record(call?.['function']);
          const toolIndex = Number(call?.['index']);
          const tool = state.tools.get(toolIndex) ?? {
            origin: toolPosition,
            id: false,
            type: false,
            name: false,
            arguments: false,
          };
          if (!state.tools.has(toolIndex) && ++this.toolCount > 1024)
            throw badResponse(
              'tool_call_count',
              `choices[${String(state.origin)}].delta.tool_calls`
            );
          tool.id ||= typeof call?.['id'] === 'string' && call['id'].length > 0;
          tool.type ||= call?.['type'] === 'function';
          tool.name ||= typeof fn?.['name'] === 'string' && fn['name'].length > 0;
          tool.arguments ||= typeof fn?.['arguments'] === 'string';
          state.tools.set(toolIndex, tool);
          const id = call?.['id'];
          if (typeof id === 'string')
            this.inspect(id, JSON.stringify([index, 'tool_calls', call?.['index'], 'id']));
          for (const field of ['name', 'arguments']) {
            const text = fn?.[field];
            if (typeof text === 'string')
              this.inspect(text, JSON.stringify([index, 'tool_calls', call?.['index'], field]));
          }
        }
      const finish = item?.['finish_reason'];
      if (finish !== undefined && finish !== null) {
        if (
          typeof finish !== 'string' ||
          !['stop', 'tool_calls', 'length', 'content_filter'].includes(finish)
        )
          throw badResponse(
            'finish_reason',
            `choices[${String(position)}].finish_reason`,
            jsonType(finish)
          );
        if (!state.hasText && state.tools.size === 0 && finish !== 'content_filter')
          throw badResponse('empty_answer', `choices[${String(state.origin)}]`);
        const incomplete = [...state.tools.entries()].find(
          ([, tool]) => !tool.id || !tool.type || !tool.name || !tool.arguments
        );
        if (incomplete !== undefined)
          throw badResponse(
            'incomplete_tool_call',
            `choices[${String(state.origin)}].delta.tool_calls[${String(incomplete[1].origin)}]`
          );
        if (finish === 'tool_calls' && state.tools.size === 0)
          throw badResponse('tool_calls_finish', `choices[${String(position)}].finish_reason`);
        state.finished = true;
      }
    }
    const keys = this.keys();
    const frame = `data: ${serializeSafe(value, keys)}\n\n`;
    // Raw carry-over also covers text outside the reconstructed delta fields.
    const joined = this.carry + frame;
    if (keys.some((key) => joined.includes(key))) throw unsafeResponse('forbidden_key', '');
    const carryLength = Math.max(0, ...keys.map((key) => key.length - 1));
    this.carry = carryLength ? joined.slice(-carryLength) : '';
    this.queued.push(frame);
    this.queuedBytes += Buffer.byteLength(frame);
    if (this.queuedBytes > MAX_BODY) throw badResponse('stream_size', '');
    return [...this.tails.values()].some((tail) => tail !== '') ? '' : this.flush();
  }
  private inspect(value: string, path: string): void {
    for (const key of this.keys()) {
      const field = JSON.stringify([key, path]);
      const joined = (this.tails.get(field) ?? '') + value;
      if (joined.includes(key)) throw unsafeResponse('forbidden_key', '');
      let length = Math.min(joined.length, key.length - 1);
      while (length > 0 && !joined.endsWith(key.slice(0, length))) length--;
      this.tails.set(field, length ? joined.slice(-length) : '');
    }
    if (this.tails.size > 1024) throw badResponse('tail_count', '');
  }
  private flush(): string {
    const frames = this.queued.join('');
    this.queued = [];
    this.queuedBytes = 0;
    return frames;
  }
}
