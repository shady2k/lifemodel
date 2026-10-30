import { Worker } from 'node:worker_threads';
import ts from 'typescript';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createTranscriptMapper as first } from '../../loader/src/task-opencode.js';
import { createTranscriptMapper as scripted } from '../fixtures/task-scripted-config.mjs';
import { createTranscriptMapper as second } from '../../loader/src/task-prime-agent.js';
import { type TaskHarnessEvent } from '../../loader/src/task-harness.js';
import { validateTaskChannelFrame } from '../../src/ports/task-channel.js';

describe('neutral task session capture', () => {
  it.each([['�'], ['abc\uD800'], ['\uD800'], ['a�b�'], ['x'.repeat(3995), '🙂🙂', 'last�']])(
    'round2: malformed or replacement text completes without loss (%#)',
    async (...parts) => {
      const source = await readFile('loader/src/task-transcript.ts', 'utf8');
      const compiled = ts
        .transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2024 },
        })
        .outputText.replace(
          '../../src/ports/task-transcript-bounds.mjs',
          pathToFileURL(resolve('src/ports/task-transcript-bounds.mjs')).href
        );
      const url = 'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64');
      const worker = new Worker(
        `const {parentPort,workerData}=require('node:worker_threads');
        (async()=>{const m=await import(workerData.url);const entries=[];
          const mapper=m.createAcpTranscriptMapper(e=>entries.push(e.entry),{name:()=>'',output:()=>''});
          for(const text of workerData.parts) mapper.update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
          mapper.flush();await Promise.resolve();await Promise.resolve();parentPort.postMessage(entries);})();`,
        { eval: true, workerData: { url, parts } }
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const entries = await new Promise<{ text: string }[]>((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('mapper deadline exceeded')), 2000);
          worker.once('message', resolve);
          worker.once('error', reject);
        });
        expect(entries.map((e) => e.text).join('')).toBe(
          Buffer.from(parts.join('')).toString('utf8')
        );
        for (const entry of entries)
          expect(Buffer.byteLength(entry.text)).toBeLessThanOrEqual(4000);
      } finally {
        clearTimeout(timer);
        await worker.terminate();
      }
    }
  );

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
      await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 3000 });
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

  it('round2: migration describes newest-entry ring rather than frozen capture', async () => {
    const sql = await readFile('db/migrations/20261015000031_create_task_transcript.sql', 'utf8');
    expect(sql).not.toContain('Capture stops');
    expect(sql).toContain('newest');
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
      'src/layers/cognition/prompts/running-tasks.ts',
      'src/storage/postgres-task-registry.ts',
      'src/ports/task-transcript-bounds.mjs',
      'src/storage/postgres-task-mailbox.ts',
    ];
    for (const path of paths)
      expect(await readFile(path, 'utf8'), path).not.toMatch(/opencode|prime/i);
  });
});

it.each([first, second, scripted])(
  'shell call retains specific name and scrubbed input (%#)',
  async (factory) => {
    const { createTaskContentScrubber } = await import('../../loader/src/task-content-scrub.js');
    const { boundTaskTranscript } = await import('../../src/ports/task-transcript-bounds.mjs');
    const scrub = createTaskContentScrubber({});
    const entries: unknown[] = [];
    const flights: Promise<void>[] = [];
    const mapper = factory((event) => {
      if (event.type === 'transcript')
        flights.push(
          scrub(event.entry).then((entry) => {
            entries.push(boundTaskTranscript(entry));
          })
        );
    });
    mapper.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'shell',
      name: 'shell',
      kind: 'execute',
      status: 'pending',
      rawInput: {},
    });
    mapper.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'shell',
      title: 'shell',
      kind: 'execute',
      rawInput: { command: 'TOKEN=planted-secret sleep 240' },
      status: 'in_progress',
    });
    mapper.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'shell',
      title: 'execute',
      kind: 'execute',
      status: 'completed',
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.all(flights);
    expect(entries).toMatchObject([
      { tool: { name: 'shell', status: 'running', input: 'TOKEN=[REDACTED] sleep 240' } },
      { tool: { name: 'shell', status: 'completed', input: 'TOKEN=[REDACTED] sleep 240' } },
    ]);
    expect(JSON.stringify(entries)).not.toContain('planted-secret');
  }
);

it.each([first, second])(
  '300 ms chunks coalesce; 2.5 s idle splits a message (%#)',
  async (factory) => {
    vi.useFakeTimers();
    try {
      const entries: string[] = [];
      const mapper = factory((event) => {
        if (event.type === 'transcript') entries.push(event.entry.text);
      });
      const add = (text: string, messageId = 'one') =>
        mapper.update({
          sessionUpdate: 'agent_message_chunk',
          messageId,
          content: { type: 'text', text },
        });
      for (const text of ['a', 'b', 'c', 'd', 'e']) {
        add(text);
        await vi.advanceTimersByTimeAsync(300);
      }
      expect(entries).toEqual([]);
      await vi.advanceTimersByTimeAsync(2500);
      expect(entries).toEqual(['abcde']);
      add('f');
      add('g', 'two');
      mapper.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(entries).toEqual(['abcde', 'f', 'g']);
    } finally {
      vi.useRealTimers();
    }
  }
);

it('tool description advertises finished task chats', async () => {
  const { createSteerTaskTool } =
    await import('../../src/layers/cognition/tools/core/steer-task.js');
  const tool = createSteerTaskTool({} as never);
  expect(tool.description).toContain('running and finished tasks');
  expect(tool.description).toContain('view="transcript"');
});

it('assistant observation time is its first chunk, not delayed flush', async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
    const entries: string[] = [];
    const mapper = first((event) => {
      if (event.type === 'transcript') entries.push(event.entry.time);
    });
    mapper.update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'before insertion' },
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(entries).toEqual(['2026-10-01T12:00:00.000Z']);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  [first, { filePath: '/workspace/count.txt' }, '/workspace/count.txt'],
  [first, { url: 'https://example.test/page' }, 'https://example.test/page'],
  [second, { code: 'h = bash("sleep 240")' }, 'h = bash("sleep 240")'],
] as const)('adapter selects its native input field (%#)', async (factory, rawInput, input) => {
  const entries: TaskHarnessEvent[] = [];
  const mapper = factory((event) => {
    entries.push(event);
  });
  mapper.update({ sessionUpdate: 'tool_call', toolCallId: 'input', title: 'read', rawInput });
  await Promise.resolve();
  await Promise.resolve();
  expect(entries).toMatchObject([{ entry: { tool: { input } } }]);
});
