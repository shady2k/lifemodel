import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createTranscriptMapper as first } from '../../loader/src/task-opencode.js';
import { createTranscriptMapper as second } from '../../loader/src/task-prime-agent.js';
import { type TaskHarnessEvent } from '../../loader/src/task-harness.js';
import { validateTaskChannelFrame } from '../../src/ports/task-channel.js';

describe('neutral task session capture', () => {
  it.each([first, second])(
    'maps tool patches and assistant excerpts with stable replay IDs (%#)',
    async (factory) => {
      const events: TaskHarnessEvent[] = [];
      const mapper = factory((event) => {
        events.push(event);
      });
      mapper.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Inspecting the files.' },
      });
      mapper.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'shell-1',
        title: 'shell',
        kind: 'execute',
        status: 'in_progress',
      });
      const end = {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'shell-1',
        status: 'completed',
        rawOutput: { output: 'head' + '🙂'.repeat(1000) + 'OUTPUT-END' },
      };
      mapper.update(end);
      mapper.update(end);
      mapper.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Final '.repeat(2000) },
      });
      mapper.flush();
      await vi.waitFor(() => expect(events).toHaveLength(6));
      const entries = events.flatMap((event) => (event.type === 'transcript' ? [event.entry] : []));
      expect(entries[0]).toMatchObject({ role: 'assistant', text: 'Inspecting the files.' });
      expect(entries[1]).toMatchObject({ role: 'tool', tool: { status: 'running' } });
      expect(entries[2]).toMatchObject({
        role: 'tool',
        tool: { status: 'completed', outputTail: expect.stringContaining('OUTPUT-END') },
      });
      expect(entries[3]?.role).toBe('assistant');
      for (const entry of entries) {
        expect(Buffer.byteLength(entry.text)).toBeLessThanOrEqual(4000);
        expect(Buffer.byteLength(entry.tool?.outputTail ?? '')).toBeLessThanOrEqual(2000);
        expect(entry.text).not.toContain('�');
        expect(() =>
          validateTaskChannelFrame({
            taskId: 'task',
            attemptId: 'attempt',
            direction: 'task_to_core',
            sequence: 1,
            messageId: entry.id,
            kind: 'transcript',
            payload: entry,
          })
        ).not.toThrow();
      }
    }
  );
  it.each([first, second])(
    'captures live assistant text before turn end and limits the mapper per task (%#)',
    async (factory) => {
      const events: TaskHarnessEvent[] = [];
      const mapper = factory((event) => {
        events.push(event);
      });
      mapper.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Still working' },
      });
      await vi.waitFor(() => expect(events).toHaveLength(1));
      for (let i = 0; i < 1100; i++)
        mapper.update({
          sessionUpdate: 'tool_call',
          toolCallId: `bounded-${i}`,
          status: 'completed',
        });
      await Promise.resolve();
      await Promise.resolve();
      expect(events).toHaveLength(1101);
    }
  );

  it('review8: assistant chunks crossing a UTF-8 bound carry every byte', async () => {
    const events: TaskHarnessEvent[] = [];
    const mapper = first((e) => {
      events.push(e);
    });
    const parts = ['x'.repeat(500), '🙂'.repeat(1000), 'last'];
    for (const text of parts)
      mapper.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    mapper.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(events.flatMap((e) => (e.type === 'transcript' ? [e.entry.text] : [])).join('')).toBe(
      parts.join('')
    );
  });

  it('review2: streams tool tails without spending entries and coalesces prose', async () => {
    const events: TaskHarnessEvent[] = [];
    const mapper = first((event) => {
      events.push(event);
    });
    mapper.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'long',
      title: 'shell',
      status: 'in_progress',
    });
    for (let i = 0; i < 2000; i++)
      mapper.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'long',
        rawOutput: 'tail-' + i,
      });
    mapper.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'long',
      status: 'completed',
      rawOutput: 'FINAL',
    });
    for (let i = 0; i < 7; i++)
      mapper.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'a'.repeat(500) },
      });
    mapper.flush();
    await Promise.resolve();
    await Promise.resolve();
    const entries = events.flatMap((e) => (e.type === 'transcript' ? [e.entry] : []));
    expect(entries.filter((e) => e.role === 'tool').length).toBeLessThanOrEqual(3);
    expect(entries.find((e) => e.tool?.status === 'completed')?.tool?.outputTail).toBe('FINAL');
    expect(entries.filter((e) => e.role === 'assistant').map((e) => e.text)).toEqual([
      'a'.repeat(3500),
    ]);
  });

  it('generic transcript/launcher/client/port code does not name vendors', async () => {
    const paths = [
      'loader/src/task-transcript.ts',
      'loader/src/task-transcript-channel.ts',
      'loader/src/task-acp.ts',
      'loader/src/task-launcher.ts',
      'loader/src/task-harness.ts',
      'loader/src/task-harness-factory.ts',
      'loader/src/task-command-intake.ts',
      'loader/src/task-content-scrub.ts',
      'src/layers/cognition/tools/core/steer-task.ts',
      'src/ports/task-channel.ts',
      'src/core/task-service.ts',
      'src/storage/postgres-task-mailbox.ts',
    ];
    for (const path of paths)
      expect(await readFile(path, 'utf8'), path).not.toMatch(/opencode|prime/i);
  });
});
