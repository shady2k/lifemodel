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
