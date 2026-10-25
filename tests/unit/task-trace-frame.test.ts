import { describe, expect, it } from 'vitest';
import { validateTaskTraceFrame } from '../../src/ports/task-channel.js';
function frame() {
  return {
    taskId: 'task',
    attemptId: 'attempt',
    launchId: 'launch',
    span: {
      traceId: 'trace',
      spanId: 'span',
      parentSpanId: null,
      component: 'task.tool',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:01Z',
      status: 'failed',
      attrs: { command: 'false', exitCode: 1, outputTail: 'failed' },
    },
  };
}
describe('bounded disposable trace frames', () => {
  it('detaches valid observations', () => {
    const value = frame();
    const result = validateTaskTraceFrame(value);
    value.span.attrs.command = 'changed';
    expect(result.span.attrs['command']).toBe('false');
  });
  it.each(['field', 'status', 'open', 'date', 'nested', 'bytes', 'keys', 'identity'])(
    'rejects invalid %s',
    (fault) => {
      const value: any = frame();
      if (fault === 'field') value.span.unexpected = true;
      if (fault === 'status') value.span.status = 'surprise';
      if (fault === 'open') value.span.endedAt = null;
      if (fault === 'date') value.span.startedAt = 'yesterday';
      if (fault === 'nested') value.span.attrs.output = { unbounded: true };
      if (fault === 'bytes') value.span.attrs.outputTail = 'x'.repeat(8193);
      if (fault === 'keys')
        value.span.attrs = Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [String(i), 'x'])
        );
      if (fault === 'identity') value.launchId = '../wrong';
      expect(() => validateTaskTraceFrame(value)).toThrow('invalid_frame');
    }
  );
});
