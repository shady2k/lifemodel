/** Bounded, decoded inspection of everything returned from a model (ADR-013 G-01/B-01). */
export class GatewayError extends Error {
  constructor(
    readonly code: string,
    readonly status = 502
  ) {
    super(code);
  }
}
export const MAX_BODY = 1024 * 1024;
export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function containsKey(value: unknown, key: string, depth = 0): boolean {
  if (depth > 64) throw new GatewayError('bad_response');
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
export function parseSafe(text: string, key?: string): unknown {
  if (Buffer.byteLength(text) > MAX_BODY) throw new GatewayError('bad_response');
  try {
    const value: unknown = JSON.parse(text);
    if (key && (text.includes(key) || containsKey(value, key)))
      throw new GatewayError('unsafe_response');
    return value;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError('bad_response');
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
function validateDelta(delta: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(delta)) {
    if (TEXT_FIELDS.includes(field)) {
      if (value !== null && typeof value !== 'string') throw new GatewayError('bad_response');
    } else if (field === 'role') {
      if (value !== 'assistant') throw new GatewayError('bad_response');
    } else if (field === 'tool_calls') {
      if (!Array.isArray(value) || !value.every((call: unknown) => toolCall(call, true)))
        throw new GatewayError('bad_response');
    } else throw new GatewayError('bad_response');
  }
}
export function validateResponse(value: unknown, models: boolean): void {
  const object = record(value);
  if (models) {
    if (
      !Array.isArray(object?.['data']) ||
      !object['data'].every((item: unknown) => typeof record(item)?.['id'] === 'string')
    )
      throw new GatewayError('bad_response');
    return;
  }
  const choices = object?.['choices'];
  if (
    typeof object?.['model'] !== 'string' ||
    !Array.isArray(choices) ||
    choices.length === 0 ||
    !choices.every((choice: unknown) => {
      const message = record(record(choice)?.['message']);
      if (!message) return false;
      const tools = message['tool_calls'];
      if (
        tools !== undefined &&
        (!Array.isArray(tools) || !tools.every((call: unknown) => toolCall(call, false)))
      )
        return false;
      return (
        typeof message['content'] === 'string' ||
        (message['content'] === null && Array.isArray(tools) && tools.length > 0)
      );
    })
  )
    throw new GatewayError('bad_response');
}
/**
 * Only parsed/re-encoded data frames cross this boundary. A queue retains whole
 * frames whenever any reconstructed string ends in a possible credential prefix.
 * This preserves frame order and tool metadata without inventing synthetic deltas.
 */
export class SafeEventStream {
  private readonly tails = new Map<string, string>();
  private queued: string[] = [];
  private queuedBytes = 0;
  private carry = '';
  private seenCompletion = false;
  done = false;
  constructor(private readonly key?: string) {}
  frame(raw: string): string {
    if (this.done || Buffer.byteLength(raw) > MAX_BODY) throw new GatewayError('bad_response');
    const data = raw
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    // Comments/heartbeats are not forwarded unparsed.
    if (!data) return '';
    if (data === '[DONE]') {
      if (!this.seenCompletion) throw new GatewayError('bad_response');
      this.done = true;
      return this.flush() + 'data: [DONE]\n\n';
    }
    const value = parseSafe(data, this.key);
    const object = record(value);
    if (typeof object?.['model'] !== 'string' || !Array.isArray(object['choices']))
      throw new GatewayError('bad_response');
    if (object['choices'].length === 0 && (!this.seenCompletion || !record(object['usage'])))
      throw new GatewayError('bad_response');
    for (const choice of object['choices'] as unknown[]) {
      const item = record(choice);
      const index = item?.['index'];
      if (!Number.isSafeInteger(index) || Number(index) < 0) throw new GatewayError('bad_response');
      const delta = record(item?.['delta']);
      if (!delta) throw new GatewayError('bad_response');
      validateDelta(delta);
      if (!this.seenCompletion && Object.keys(delta).length === 0)
        throw new GatewayError('bad_response');
      this.seenCompletion = true;
      // Typed tuples cannot alias through attacker-controlled field names.
      for (const field of TEXT_FIELDS) {
        const text = delta[field];
        if (typeof text === 'string') this.inspect(text, JSON.stringify([index, field]));
      }
      if (Array.isArray(delta['tool_calls']))
        for (const value of delta['tool_calls'] as unknown[]) {
          const call = record(value);
          const fn = record(call?.['function']);
          const id = call?.['id'];
          if (typeof id === 'string')
            this.inspect(id, JSON.stringify([index, 'tool_calls', call?.['index'], 'id']));
          for (const field of ['name', 'arguments']) {
            const text = fn?.[field];
            if (typeof text === 'string')
              this.inspect(text, JSON.stringify([index, 'tool_calls', call?.['index'], field]));
          }
        }
    }
    const frame = `data: ${JSON.stringify(value)}\n\n`;
    // Raw carry-over also covers text outside the reconstructed delta fields.
    if (this.key) {
      const joined = this.carry + frame;
      if (joined.includes(this.key)) throw new GatewayError('unsafe_response');
      this.carry = joined.slice(-(this.key.length - 1 || 1));
    }
    this.queued.push(frame);
    this.queuedBytes += Buffer.byteLength(frame);
    if (this.queuedBytes > MAX_BODY) throw new GatewayError('bad_response');
    return [...this.tails.values()].some((tail) => tail !== '') ? '' : this.flush();
  }
  private inspect(value: string, path: string): void {
    if (!this.key) return;
    const joined = (this.tails.get(path) ?? '') + value;
    if (joined.includes(this.key)) throw new GatewayError('unsafe_response');
    let length = Math.min(joined.length, this.key.length - 1);
    while (length > 0 && !joined.endsWith(this.key.slice(0, length))) length--;
    this.tails.set(path, length ? joined.slice(-length) : '');
    if (this.tails.size > 1024) throw new GatewayError('bad_response');
  }
  private flush(): string {
    const frames = this.queued.join('');
    this.queued = [];
    this.queuedBytes = 0;
    return frames;
  }
}
