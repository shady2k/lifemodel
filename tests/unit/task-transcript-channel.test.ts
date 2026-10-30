import { boundTaskTranscript, transcriptSlice } from '../../src/ports/task-transcript-bounds.mjs';
import { afterEach, expect, it, vi } from 'vitest';
import { createTaskTranscriptChannel } from '../../loader/src/task-transcript-channel.js';
import { TaskJsonClient, LauncherError } from '../../loader/src/task-launcher-http.js';
const entry = (text = 'hello') => ({
  id: 'entry_test',
  role: 'assistant' as const,
  time: new Date().toISOString(),
  text,
  tool: null,
});
const channel = () =>
  createTaskTranscriptChannel({
    endpoint: { endpoint: 'https://localhost:1', tokenFile: '/unused', caFile: '/unused' },
    env: {},
    identity: { taskId: 'task', attemptId: 'attempt' },
    nextSequence: () => 1,
  });
afterEach(() => vi.restoreAllMocks());
it('review4: launcher re-bounds after expanding redactions', async () => {
  const calls = vi.spyOn(TaskJsonClient.prototype, 'call').mockResolvedValue({});
  const c = channel();
  c.enqueue(entry('token=x '.repeat(500)));
  await c.close();
  expect(calls).toHaveBeenCalledOnce();
  const frame = calls.mock.calls[0]?.[1] as { payload: ReturnType<typeof entry> };
  expect(Buffer.byteLength(frame.payload.text)).toBeLessThanOrEqual(4000);
  expect(Buffer.byteLength(JSON.stringify(frame.payload))).toBeLessThanOrEqual(8192);
  expect(frame.payload.text).not.toContain('token=x');
});
it.each([400, 409, 429, 500, 503, undefined])(
  'review5: retry classification %s',
  async (status) => {
    const calls = vi
      .spyOn(TaskJsonClient.prototype, 'call')
      .mockRejectedValue(new LauncherError('request_refused', status));
    const c = channel();
    c.enqueue(entry());
    await c.close();
    expect(calls).toHaveBeenCalledTimes(status !== undefined && status < 500 ? 1 : 2);
  }
);

it('review4: escaped fields stay below SQL jsonb text bound', () => {
  const result = boundTaskTranscript({
    ...entry('\\'.repeat(4000)),
    tool: { name: '\\'.repeat(128), status: 'completed', outputTail: '\\'.repeat(2000) },
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192 - 256);
  expect(result.tool.outputTail).not.toBe('');
});

it('round2: escaped tool tails are bounded before queue admission', async () => {
  const calls = vi.spyOn(TaskJsonClient.prototype, 'call').mockResolvedValue({});
  const c = channel();
  c.enqueue({
    ...entry(''),
    role: 'tool',
    tool: { name: 'shell', status: 'completed', outputTail: '\u0001'.repeat(2000) },
  });
  await c.close();
  expect(calls).toHaveBeenCalledOnce();
  const frame = calls.mock.calls[0]?.[1] as { payload: { tool: { outputTail: string } } };
  expect(frame.payload.tool.outputTail.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(frame.payload))).toBeLessThanOrEqual(8192);
  expect(c.droppedCount).toBe(0);
});
it.each(['�', 'abc\uD800', '\uD800', 'a�b�'])(
  'round2: shared bounds preserve replacement characters in %s',
  (text) => {
    expect(boundTaskTranscript(entry(text)).text).toBe(Buffer.from(text).toString('utf8'));
  }
);

it('round2: UTF-8 head/tail cuts keep real replacement glyphs', () => {
  expect(transcriptSlice('�a�', 7).text).toBe('�a�');
  expect(transcriptSlice('x🙂�', 7, true).text).toBe('🙂�');
  expect(transcriptSlice('🙂', 3).text).toBe('');
  expect(transcriptSlice('🙂', 3, true).text).toBe('');
  expect(transcriptSlice('abc\uD800', 6)).toEqual({ text: 'abc�', consumed: 4 });
});

it('tool input is scrubbed and re-bounded after redaction expansion', async () => {
  const calls = vi.spyOn(TaskJsonClient.prototype, 'call').mockResolvedValue({});
  const c = channel();
  c.enqueue({
    ...entry(''),
    role: 'tool',
    tool: { name: 'shell', input: 'token=x '.repeat(100), status: 'running', outputTail: '' },
  });
  await c.close();
  const frame = calls.mock.calls[0]?.[1] as { payload: { tool: { input: string } } };
  expect(Buffer.byteLength(frame.payload.tool.input)).toBeLessThanOrEqual(300);
  expect(frame.payload.tool.input).toContain('[REDACTED]');
  expect(frame.payload.tool.input).not.toContain('token=x');
});

it('core rejects an oversized or non-string input summary', async () => {
  const { validateTaskChannelFrame } = await import('../../src/ports/task-channel.js');
  const frame = (input: unknown) => ({
    taskId: 'task',
    attemptId: 'attempt',
    direction: 'task_to_core',
    sequence: 1,
    messageId: 'entry_test',
    kind: 'transcript',
    payload: {
      ...entry(''),
      role: 'tool',
      tool: { name: 'shell', input, status: 'running', outputTail: '' },
    },
  });
  expect(() => validateTaskChannelFrame(frame('🙂'.repeat(75)))).not.toThrow();
  expect(() => validateTaskChannelFrame(frame('🙂'.repeat(76)))).toThrow('invalid_frame');
  expect(() => validateTaskChannelFrame(frame({ command: 'oops' }))).toThrow('invalid_frame');
});

// Keep credentials intact until redaction, including native adapter bounds.
it.each([
  ['url', 'https://oauth2:glpat-' + 'X'.repeat(90) + '@host/repo', 'glpat-'],
  ['key', 'sk-' + 'Y'.repeat(90), 'sk-'],
])('r1 secret straddles input and output bounds (%s)', async (_name, credential, marker) => {
  const { createTranscriptMapper } = await import('../../loader/src/task-opencode.js');
  const calls = vi.spyOn(TaskJsonClient.prototype, 'call').mockResolvedValue({});
  const c = channel();
  const mapper = createTranscriptMapper((event) => {
    if (event.type === 'transcript') c.enqueue(event.entry);
  });
  mapper.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'edge',
    title: 'shell',
    status: 'completed',
    rawInput: { command: 'echo ok; '.repeat(27) + credential + ' trailing' },
    rawOutput: { output: 'before ' + credential + ' ' + 'end '.repeat(490) },
  });
  await Promise.resolve();
  await c.close();
  expect(calls).toHaveBeenCalledOnce();
  const payload = (
    calls.mock.calls[0]?.[1] as { payload: { tool: { input: string; outputTail: string } } }
  ).payload;
  const serialized = JSON.stringify(payload);
  expect(payload.tool.input).toContain('[REDACTED]');
  expect(payload.tool.input).toContain(' trailing');
  expect(serialized).not.toContain(marker);
  expect(serialized).not.toContain('X'.repeat(8));
  expect(serialized).not.toContain('Y'.repeat(8));
  expect(Buffer.byteLength(payload.tool.input)).toBeLessThanOrEqual(300);
  expect(Buffer.byteLength(payload.tool.outputTail)).toBeLessThanOrEqual(2000);
});

it('r1 final bounds drop partial non-whitespace runs at both edges', () => {
  const bounded = boundTaskTranscript({
    ...entry(''),
    tool: {
      name: 'shell',
      input: 'ok '.repeat(95) + 'unrecognized-sensitive-run-' + 'Z'.repeat(80),
      outputTail: 'Z'.repeat(80) + 'secret-fragment ' + 'ok '.repeat(655),
    },
  });
  expect(bounded.tool.input).toBe('ok '.repeat(95) + '…');
  expect(bounded.tool.outputTail).toBe('… ' + 'ok '.repeat(655));
  expect(JSON.stringify(bounded.tool)).not.toContain('Z');
});

it('r1 short key prefix cut at byte 300 is never stored', async () => {
  const calls = vi.spyOn(TaskJsonClient.prototype, 'call').mockResolvedValue({});
  const c = channel();
  const { createTranscriptMapper } = await import('../../loader/src/task-opencode.js');
  const mapper = createTranscriptMapper((event) => {
    if (event.type === 'transcript') c.enqueue(event.entry);
  });
  mapper.update({
    sessionUpdate: 'tool_call',
    toolCallId: 'short-edge',
    title: 'shell',
    status: 'completed',
    rawInput: { command: 'x '.repeat(146) + 'sk-abcdef0123456789ABCDEFGHIJ' },
    rawOutput: '',
  });
  await Promise.resolve();
  await c.close();
  expect(calls).toHaveBeenCalledOnce();
  const tool = (calls.mock.calls[0]?.[1] as { payload: { tool: { input: string } } }).payload.tool;
  expect(tool.input).toBe('x '.repeat(146) + '…');
  expect(tool.input).not.toContain('sk-');
  expect(tool.input).not.toContain('abcdef');
});

it('r1 output front cut drops the entire partial run and keeps UTF-8 valid', () => {
  const bounded = boundTaskTranscript({
    ...entry(''),
    tool: {
      name: 'shell',
      outputTail: 'cut-sensitive-run-' + '🙂'.repeat(50) + ' safe '.repeat(330),
    },
  });
  expect(bounded.tool.outputTail).toBe('…' + ' safe '.repeat(330));
});

it.each([
  ['json', '"api_key": "s3cr3tvalue"', 's3cr3tvalue'],
  ['password', 'password: hunter2', 'hunter2'],
  ['bearer', 'Bearer abcdefghijklmnop', 'abcdefghijklmnop'],
])(
  'r2 raw output front cut never loses secret context (%s)',
  async (_label, assignment, secret) => {
    const { createTranscriptMapper } = await import('../../loader/src/task-opencode.js');
    const calls = vi.spyOn(TaskJsonClient.prototype, 'call').mockResolvedValue({});
    const c = channel();
    const mapper = createTranscriptMapper((event) => {
      if (event.type === 'transcript') c.enqueue(event.entry);
    });
    // Native 2,000-byte front edge lands inside the key/scheme, not the value.
    const output = 'prefix ' + assignment + ' '.repeat(1999 - assignment.length + 3);
    mapper.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'edge',
      title: 'shell',
      status: 'completed',
      rawOutput: { output },
    });
    await Promise.resolve();
    await c.close();
    expect(calls).toHaveBeenCalledOnce();
    const payload = (calls.mock.calls[0]?.[1] as { payload: { tool: { outputTail: string } } })
      .payload;
    expect(payload.tool.outputTail).not.toBe('');
    expect(payload.tool.outputTail).not.toContain(secret);
    expect(Buffer.byteLength(payload.tool.outputTail)).toBeLessThanOrEqual(2000);
  }
);

it.each(['"api_key": "s3cr3tvalue"', 'password: hunter2', 'Bearer abcdefghijklmnop'])(
  'r2 oversized raw front cut drops the orphaned first line (%s)',
  async (assignment) => {
    const { transcriptRawTail } = await import('../../src/ports/task-transcript-bounds.mjs');
    const raw = 'prefix ' + assignment + ' '.repeat(3999 - assignment.length + 3);
    expect(transcriptRawTail(raw, 4000)).toBe('…');
    expect(transcriptRawTail(raw + '\nkeep this line', 4000)).toBe('…keep this line');
    const value = boundTaskTranscript(
      { ...entry(''), tool: { name: 'shell', outputTail: raw } },
      true
    );
    expect(value.tool.outputTail).toBe('…');
  }
);

it('r2 raw budget spends input headroom before output and does not split text runs', () => {
  const outputTail = 'important output\n'.repeat(230);
  const raw = boundTaskTranscript(
    { ...entry(''), tool: { name: 'shell', input: 'input '.repeat(660), outputTail } },
    true
  );
  expect(raw.tool.outputTail).toBe(outputTail);
  expect(Buffer.byteLength(raw.tool.input)).toBeLessThanOrEqual(1024);
  const text = 'a '.repeat(1990) + 'sk-abcdefghijk' + 'longrun'.repeat(20);
  const bounded = boundTaskTranscript(entry(text), true);
  expect(bounded.text).toBe('a '.repeat(1990) + '…');
  expect(bounded.text).not.toContain('sk-');
});

it('r2 raw JSON budget drops cut text runs instead of orphaning credential prefixes', () => {
  const text = '" '.repeat(1550) + 'sk-abcdefghijk' + 'x'.repeat(500);
  const value = boundTaskTranscript(
    {
      ...entry(text),
      tool: { name: 'shell', input: 'i '.repeat(650), outputTail: 'important\n'.repeat(350) },
    },
    true
  );
  expect(value.text).not.toContain('sk-');
  expect(value.text).toMatch(/…$/);
  expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(8192 - 256);
});

it('call references survive launcher scrub and both bounds', async () => {
  const calls = vi.spyOn(TaskJsonClient.prototype, 'call').mockResolvedValue({});
  const c = channel();
  const callRef = 'call_' + 'a'.repeat(64);
  c.enqueue({
    ...entry(''),
    role: 'tool',
    tool: {
      name: 'shell',
      callRef,
      input: 'token=private',
      status: 'running',
      outputTail: '',
    },
  });
  await c.close();
  expect(calls).toHaveBeenCalledOnce();
  expect(calls.mock.calls[0]?.[1]).toMatchObject({
    payload: { tool: { callRef, input: 'token=[REDACTED]' } },
  });
  expect(c.droppedCount).toBe(0);
});

it('call references are optional safe bounded IDs at the core boundary', async () => {
  const { validateTaskChannelFrame } = await import('../../src/ports/task-channel.js');
  const frame = (reference: Record<string, unknown>) => ({
    taskId: 'task',
    attemptId: 'attempt',
    direction: 'task_to_core',
    sequence: 1,
    messageId: 'entry_test',
    kind: 'transcript',
    payload: {
      ...entry(''),
      role: 'tool',
      tool: { name: 'shell', status: 'running', outputTail: '', ...reference },
    },
  });
  expect(() => validateTaskChannelFrame(frame({}))).not.toThrow();
  expect(() =>
    validateTaskChannelFrame(frame({ callRef: 'call_' + 'a'.repeat(64) }))
  ).not.toThrow();
  expect(() => validateTaskChannelFrame(frame({ callRef: 'a'.repeat(128) }))).not.toThrow();
  for (const callRef of ['', 'a'.repeat(129), 5, null, {}, 'native/call:123', 'bad\0id'])
    expect(() => validateTaskChannelFrame(frame({ callRef }))).toThrow('invalid_frame');
  const bounded = boundTaskTranscript({
    ...entry(''),
    tool: { name: 'shell', callRef: 'a'.repeat(200), outputTail: '' },
  });
  expect(bounded.tool.callRef).toBe('a'.repeat(128));
});
