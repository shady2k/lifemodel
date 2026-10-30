import { boundTaskTranscript } from '../../src/ports/task-transcript-bounds.mjs';
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
it('review4: escaped fields stay below SQL jsonb text bound', () => {
  const result = boundTaskTranscript({
    ...entry('\\'.repeat(4000)),
    tool: { name: '\\'.repeat(128), status: 'completed', outputTail: '\\'.repeat(2000) },
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192 - 256);
  expect(result.tool.outputTail).not.toBe('');
});
