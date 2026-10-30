import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createTranscriptMapper as first } from '../../loader/src/task-opencode.js';
import { createTranscriptMapper as scripted } from '../fixtures/task-scripted-config.mjs';
import { createTranscriptMapper as second } from '../../loader/src/task-prime-agent.js';
import { type TaskHarnessEvent, type TaskTranscriptEntry } from '../../loader/src/task-harness.js';
import { boundTaskTranscript } from '../../src/ports/task-transcript-bounds.mjs';
import { validateTaskChannelFrame } from '../../src/ports/task-channel.js';

describe('neutral task session capture', () => {
  it.each([['�'], ['abc\uD800'], ['\uD800'], ['a�b�'], ['x '.repeat(1997), '🙂🙂 ', 'last�']])(
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
          mapper.flush(true);await Promise.resolve();await Promise.resolve();parentPort.postMessage(entries);})();`,
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
        content: { type: 'text', text: 'Inspecting the files. ' },
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
        rawOutput: { output: 'head ' + '🙂'.repeat(1000) + '\nOUTPUT-END' },
      };
      mapper.update(end);
      mapper.update(end);
      mapper.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Final '.repeat(2000) },
      });
      mapper.flush(true);
      await vi.waitFor(() => expect(events).toHaveLength(7));
      const entries = events.flatMap((event) => (event.type === 'transcript' ? [event.entry] : []));
      expect(entries[0]).toMatchObject({ role: 'assistant', text: 'Inspecting the files. ' });
      expect(entries[1]).toMatchObject({ role: 'tool', tool: { status: 'running' } });
      expect(entries[2]).toMatchObject({
        role: 'tool',
        tool: { status: 'completed', outputTail: expect.stringContaining('OUTPUT-END') },
      });
      expect(entries[3]?.role).toBe('assistant');
      for (const raw of entries) {
        const entry = boundTaskTranscript(raw);
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
        content: { type: 'text', text: 'Still working ' },
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
    const parts = ['x '.repeat(250), '🙂 '.repeat(1000), 'last'];
    for (const text of parts)
      mapper.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    mapper.flush(true);
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
        content: { type: 'text', text: 'a '.repeat(250) },
      });
    mapper.flush(true);
    await Promise.resolve();
    await Promise.resolve();
    const entries = events.flatMap((e) => (e.type === 'transcript' ? [e.entry] : []));
    expect(entries.filter((e) => e.role === 'tool').length).toBeLessThanOrEqual(3);
    expect(entries.find((e) => e.tool?.status === 'completed')?.tool?.outputTail).toBe('FINAL');
    expect(entries.filter((e) => e.role === 'assistant').map((e) => e.text)).toEqual([
      'a '.repeat(1750),
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
      for (const text of ['a ', 'b ', 'c ', 'd ', 'e ']) {
        add(text);
        await vi.advanceTimersByTimeAsync(300);
      }
      expect(entries).toEqual([]);
      await vi.advanceTimersByTimeAsync(2500);
      expect(entries).toEqual(['a b c d e ']);
      add('f ');
      add('g', 'two');
      mapper.flush(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(entries).toEqual(['a b c d e ', 'f ', 'g']);
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
      content: { type: 'text', text: 'before insertion ' },
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

it.each([first, second])(
  'r1 pending-only tools are captured once on session end (%#)',
  async (factory) => {
    const events: TaskHarnessEvent[] = [];
    const mapper = factory((event) => {
      events.push(event);
    });
    mapper.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'waiting',
      title: 'shell',
      status: 'pending',
      rawInput: { command: 'sleep 240', code: 'sleep 240' },
    });
    mapper.flush();
    await Promise.resolve();
    expect(events).toEqual([]);
    mapper.flush(true);
    mapper.flush(true);
    await Promise.resolve();
    expect(events).toMatchObject([
      {
        type: 'transcript',
        entry: {
          role: 'tool',
          tool: {
            name: 'shell',
            input: 'sleep 240',
            status: 'error',
          },
        },
      },
    ]);
  }
);

it.each(
  [first, second, scripted].flatMap((factory) =>
    ['tool_call', 'tool_call_update', 'message'].map((boundary) => [factory, boundary] as const)
  )
)('complete assistant text ends before a tool or new message (%#)', async (factory, boundary) => {
  const entries: TaskTranscriptEntry[] = [];
  const mapper = factory((event) => {
    if (event.type === 'transcript') entries.push(event.entry);
  });
  const add = (text: string, messageId = 'one') =>
    mapper.update({
      sessionUpdate: 'agent_message_chunk',
      messageId,
      content: { type: 'text', text },
    });
  add('I will run it in a single shell ');
  add('command.');
  if (boundary !== 'message')
    mapper.update({
      sessionUpdate: boundary,
      toolCallId: 'shell-boundary',
      title: 'shell',
      status: 'completed',
    });
  add('The sleep is running.', boundary === 'message' ? 'two' : 'one');
  await Promise.resolve();
  expect(entries.filter((entry) => entry.role === 'assistant').map((entry) => entry.text)).toEqual([
    'I will run it in a single shell command.',
  ]);
  mapper.flush(true);
  await Promise.resolve();
  expect(entries.map((entry) => entry.role)).toEqual(
    boundary === 'message' ? ['assistant', 'assistant'] : ['assistant', 'tool', 'assistant']
  );
  expect(entries.filter((entry) => entry.role === 'assistant').map((entry) => entry.text)).toEqual([
    'I will run it in a single shell command.',
    'The sleep is running.',
  ]);
});

it.each(
  [first, second, scripted].flatMap((factory) =>
    ['completed', 'failed'].map((status) => [factory, status] as const)
  )
)(
  'tool start and terminal rows share a bounded opaque replay-stable reference (%#)',
  async (factory, status) => {
    const nativeIds = ['native-call/' + 'x'.repeat(5000) + ':one', 'native-call:two'];
    const capture = async () => {
      const entries: TaskTranscriptEntry[] = [];
      const mapper = factory((event) => {
        if (event.type === 'transcript') entries.push(event.entry);
      });
      for (const toolCallId of nativeIds)
        mapper.update({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'shell',
          status: 'in_progress',
        });
      for (const toolCallId of [...nativeIds].reverse()) {
        const end = {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status,
          rawOutput: 'done',
        };
        mapper.update(end);
        mapper.update(end);
      }
      mapper.flush(true);
      await Promise.resolve();
      return entries;
    };
    const entries = await capture();
    expect(entries.map((entry) => entry.tool?.status)).toEqual([
      'running',
      'running',
      status === 'failed' ? 'error' : 'completed',
      status === 'failed' ? 'error' : 'completed',
    ]);
    const refs = nativeIds.map(
      (id) => `call_${createHash('sha256').update(`${id}\0${0}`).digest('hex')}`
    );
    expect(entries.map((entry) => entry.tool?.callRef)).toEqual([
      refs[0],
      refs[1],
      refs[1],
      refs[0],
    ]);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(4);
    expect(new Set(refs).size).toBe(2);
    for (const entry of entries) {
      expect(entry.tool?.callRef).toMatch(/^call_[a-f0-9]{64}$/);
      expect(Buffer.byteLength(entry.tool?.callRef ?? '')).toBeLessThanOrEqual(69);
      expect(JSON.stringify(entry)).not.toContain('native-call');
    }
    const replay = await capture();
    expect(replay.map((entry) => ({ id: entry.id, callRef: entry.tool?.callRef }))).toEqual(
      entries.map((entry) => ({ id: entry.id, callRef: entry.tool?.callRef }))
    );
  }
);

it.each(
  [first, second, scripted].flatMap((factory) =>
    ['idle', 'insertion', 'size'].map((boundary) => [factory, boundary] as const)
  )
)(
  'assistant key streamed across a non-final boundary stays whole for scrubbing (%#)',
  async (factory, boundary) => {
    const { createTaskContentScrubber } = await import('../../loader/src/task-content-scrub.js');
    vi.useFakeTimers();
    try {
      const entries: TaskHarnessEvent[] = [];
      const mapper = factory((event) => {
        entries.push(event);
      });
      const add = (text: string) =>
        mapper.update({
          sessionUpdate: 'agent_message_chunk',
          messageId: 'one',
          content: { type: 'text', text },
        });
      const prefix = boundary === 'size' ? 'safe '.repeat(798) : 'before ';
      add(prefix + 'sk-abcdefghijk');
      if (boundary === 'idle') await vi.advanceTimersByTimeAsync(2500);
      else if (boundary === 'insertion') mapper.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(
        entries.flatMap((event) => (event.type === 'transcript' ? [event.entry.text] : []))
      ).toEqual([prefix]);
      add('lmnopqrstu0123456789 after ');
      mapper.flush(true);
      await vi.advanceTimersByTimeAsync(0);
      const scrub = createTaskContentScrubber({});
      const captured = await Promise.all(
        entries.filter((event) => event.type === 'transcript').map((event) => scrub(event.entry))
      );
      const text = captured.map((entry) => entry.text).join('');
      expect(text).toContain('[REDACTED]');
      expect(text).not.toContain('sk-abcdefghijk');
      expect(text).not.toContain('lmnopqrstu');
      expect(text).toContain('after ');
    } finally {
      vi.useRealTimers();
    }
  }
);

it.each(
  [first, second, scripted].flatMap((factory) =>
    [
      { sessionUpdate: 'tool_call', toolCallId: 'known', status: 'in_progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'known', rawOutput: 'progress' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'known', status: 'completed' },
      { sessionUpdate: 'tool_call_update' },
      { sessionUpdate: 'tool_call_update', toolCallId: null },
      { sessionUpdate: 'tool_call_update', toolCallId: '' },
      { sessionUpdate: 'tool_call_update', toolCallId: 42 },
      { sessionUpdate: 'tool_call', toolCallId: null },
    ].map((patch) => [factory, patch] as const)
  )
)(
  'known or malformed tool patches hold a streamed credential for scrubbing (%#)',
  async (factory, patch) => {
    const { createTaskContentScrubber } = await import('../../loader/src/task-content-scrub.js');
    const entries: TaskTranscriptEntry[] = [];
    const mapper = factory((event) => {
      if (event.type === 'transcript') entries.push(event.entry);
    });
    mapper.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'known',
      title: 'shell',
      status: 'in_progress',
    });
    const add = (text: string) =>
      mapper.update({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'one',
        content: { type: 'text', text },
      });
    add('before sk-abcdefghijk');
    mapper.update(patch);
    await Promise.resolve();
    expect(
      entries.filter((entry) => entry.role === 'assistant').map((entry) => entry.text)
    ).toEqual(['before ']);
    add('lmnopqrstu0123456789 after');
    mapper.flush(true);
    await Promise.resolve();
    const scrub = createTaskContentScrubber({});
    const captured = await Promise.all(
      entries.filter((entry) => entry.role === 'assistant').map((entry) => scrub(entry))
    );
    const text = captured.map((entry) => entry.text).join('');
    expect(text).toBe('before [REDACTED] after');
    expect(text).not.toContain('sk-abcdefghijk');
    expect(text).not.toContain('lmnopqrstu');
  }
);

it.each(
  [first, second, scripted].flatMap((factory) =>
    [undefined, null, '', 42, {}].map((messageId) => [factory, messageId] as const)
  )
)(
  'a true message ID change holds the trailing run after an unidentified chunk (%#)',
  async (factory, unknownId) => {
    const { createTaskContentScrubber } = await import('../../loader/src/task-content-scrub.js');
    const entries: TaskTranscriptEntry[] = [];
    const mapper = factory((event) => {
      if (event.type === 'transcript') entries.push(event.entry);
    });
    const add = (text: string, messageId?: unknown) =>
      mapper.update({
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text },
      });
    add('A complete.', 'A');
    add(' before sk-abcdefghijk', unknownId);
    add('lmnopqrstu0123456789 after', 'B');
    await Promise.resolve();
    expect(entries.map((entry) => entry.text)).toEqual(['A complete. before ']);
    mapper.flush(true);
    await Promise.resolve();
    const scrub = createTaskContentScrubber({});
    const captured = await Promise.all(entries.map((entry) => scrub(entry)));
    const text = captured.map((entry) => entry.text).join('');
    expect(text).toBe('A complete. before [REDACTED] after');
    expect(text).not.toContain('sk-abcdefghijk');
    expect(text).not.toContain('lmnopqrstu');
  }
);

it.each(
  [first, second, scripted].flatMap((factory) =>
    ['completed', 'failed'].flatMap((terminal) =>
      [
        { sessionUpdate: 'tool_call_update', status: 'pending' },
        { sessionUpdate: 'tool_call_update', status: 'in_progress' },
        { sessionUpdate: 'tool_call_update', status: 'running' },
        { sessionUpdate: 'tool_call' },
      ].map((restart) => [factory, terminal, restart] as const)
    )
  )
)(
  'reused terminal native IDs create distinct replay-stable call generations (%#)',
  async (factory, terminal, restart) => {
    const nativeId = 'reused-native-id';
    const capture = async () => {
      const entries: TaskTranscriptEntry[] = [];
      const mapper = factory((event) => {
        if (event.type === 'transcript') entries.push(event.entry);
      });
      mapper.update({
        sessionUpdate: 'tool_call',
        toolCallId: nativeId,
        name: 'first-tool',
        rawInput: 'first input',
        status: 'in_progress',
      });
      const firstEnd = {
        sessionUpdate: 'tool_call_update',
        toolCallId: nativeId,
        status: terminal,
        rawOutput: 'first output',
      };
      mapper.update(firstEnd);
      mapper.update(firstEnd);
      // A late output-only patch is not new work and must not reopen a terminal call.
      mapper.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: nativeId,
        rawOutput: 'late first output',
      });
      mapper.update({
        ...restart,
        toolCallId: nativeId,
        name: 'second-tool',
        rawInput: 'second input',
      });
      if ('status' in restart && restart.status === 'pending')
        mapper.update({
          sessionUpdate: 'tool_call_update',
          toolCallId: nativeId,
          status: 'in_progress',
        });
      const secondEnd = {
        sessionUpdate: 'tool_call_update',
        toolCallId: nativeId,
        status: terminal,
        rawOutput: 'second output',
      };
      mapper.update(secondEnd);
      mapper.update(secondEnd);
      mapper.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: nativeId,
        rawOutput: 'late second output',
      });
      mapper.flush(true);
      mapper.flush(true);
      await Promise.resolve();
      return entries;
    };
    const entries = await capture();
    const refs = [0, 1].map(
      (generation) =>
        `call_${createHash('sha256').update(`${nativeId}\0${generation}`).digest('hex')}`
    );
    const terminalStatus = terminal === 'failed' ? 'error' : 'completed';
    expect(entries.map((entry) => entry.tool)).toEqual([
      {
        callRef: refs[0],
        name: 'first-tool',
        input: 'first input',
        status: 'running',
        outputTail: '',
      },
      {
        callRef: refs[0],
        name: 'first-tool',
        input: 'first input',
        status: terminalStatus,
        outputTail: 'first output',
      },
      {
        callRef: refs[1],
        name: 'second-tool',
        input: 'second input',
        status: 'running',
        outputTail: '',
      },
      {
        callRef: refs[1],
        name: 'second-tool',
        input: 'second input',
        status: terminalStatus,
        outputTail: 'second output',
      },
    ]);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(4);
    expect(new Set(entries.map((entry) => entry.tool?.callRef)).size).toBe(2);
    expect(JSON.stringify(entries)).not.toContain(nativeId);
    const replay = await capture();
    expect(replay.map((entry) => ({ id: entry.id, tool: entry.tool }))).toEqual(
      entries.map((entry) => ({ id: entry.id, tool: entry.tool }))
    );
  }
);

it('r2 oversized assistant run is dropped through its streamed suffix', async () => {
  const entries: TaskHarnessEvent[] = [];
  const mapper = first((event) => {
    entries.push(event);
  });
  for (const text of ['sk-' + 'x'.repeat(5000), 'still-secret', ' safe end'])
    mapper.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  mapper.flush(true);
  await Promise.resolve();
  expect(
    entries.flatMap((event) => (event.type === 'transcript' ? [event.entry.text] : [])).join('')
  ).toBe('… safe end');
});

it.each([first, second, scripted])(
  'interrupted tool gets one error paired to its running row at session end (%#)',
  async (factory) => {
    const entries: TaskTranscriptEntry[] = [];
    const mapper = factory((event) => {
      if (event.type === 'transcript') entries.push(event.entry);
    });
    mapper.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'running',
      title: 'shell',
      status: 'in_progress',
    });
    mapper.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'running',
      rawOutput: 'last output before interruption',
    });
    mapper.flush(true);
    mapper.flush(true);
    await Promise.resolve();
    const callRef = `call_${createHash('sha256')
      .update('running\0' + '0')
      .digest('hex')}`;
    expect(entries).toMatchObject([
      { tool: { status: 'running', callRef } },
      {
        tool: {
          status: 'error',
          callRef,
          outputTail: 'last output before interruption',
        },
      },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.id).not.toBe(entries[1]?.id);
  }
);

it('r2 recent index follows the small-table bounded-lock squawk precedent', async () => {
  const sql = await readFile(
    'db/migrations/20261015000034_index_recent_terminal_tasks.sql',
    'utf8'
  );
  const precedent = await readFile('db/migrations/20261015000022_create_task_mailbox.sql', 'utf8');
  const ignoredIndex = /-- squawk-ignore require-concurrent-index-creation\nCREATE INDEX/;
  expect(precedent).toMatch(ignoredIndex);
  expect(sql).toMatch(ignoredIndex);
  expect(sql).toContain("SET lock_timeout = '1s'");
  expect(sql).toContain('Small core task table');
});

it.each([first, second])(
  'fix3 complete text keeps a final word in one row without closing tools (%#)',
  async (factory) => {
    const events: TaskHarnessEvent[] = [];
    const mapper = factory((event) => {
      events.push(event);
    });
    mapper.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'live',
      title: 'shell',
      status: 'in_progress',
    });
    for (const text of ['The task result is ', 'durable.'])
      mapper.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    mapper.completeText();
    await Promise.resolve();
    expect(
      events.filter((event) => event.type === 'transcript' && event.entry.role === 'assistant')
    ).toMatchObject([{ entry: { text: 'The task result is durable.' } }]);
    expect(
      events.filter((event) => event.type === 'transcript' && event.entry.tool?.status === 'error')
    ).toEqual([]);
    mapper.flush(true);
    await Promise.resolve();
    expect(
      events.filter((event) => event.type === 'transcript' && event.entry.role === 'assistant')
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'transcript' && event.entry.tool?.status === 'error')
    ).toHaveLength(1);
  }
);

it.each([first, second, scripted])(
  'omitted or invalid message IDs do not split a streamed credential (%#)',
  async (factory) => {
    const { createTaskContentScrubber } = await import('../../loader/src/task-content-scrub.js');
    const entries: TaskTranscriptEntry[] = [];
    const mapper = factory((event) => {
      if (event.type === 'transcript') entries.push(event.entry);
    });
    const add = (text: string, messageId?: unknown) =>
      mapper.update({
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text },
      });
    add('before sk-abc', 'one');
    add('def');
    add('ghi', null);
    add('jkl', '');
    add('mno', 42);
    add('pqrstuvwxyz after', 'one');
    await Promise.resolve();
    expect(entries).toEqual([]);
    mapper.flush(true);
    await Promise.resolve();
    expect(entries.map((entry) => entry.text)).toEqual([
      'before sk-abcdefghijklmnopqrstuvwxyz after',
    ]);
    const scrub = createTaskContentScrubber({});
    expect((await scrub(entries))[0]?.text).toBe('before [REDACTED] after');
  }
);

it.each(
  [first, second, scripted].flatMap((factory) =>
    ['completed', 'failed'].map((status) => [factory, status] as const)
  )
)('terminal-only new calls also advance reused ID generations (%#)', async (factory, status) => {
  const entries: TaskTranscriptEntry[] = [];
  const mapper = factory((event) => {
    if (event.type === 'transcript') entries.push(event.entry);
  });
  for (const name of ['first', 'second']) {
    mapper.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'reused',
      status,
      name,
      rawInput: `${name} input`,
      rawOutput: `${name} output`,
    });
    // Terminal patches repeat observations; a new tool_call starts another call.
    mapper.update({ sessionUpdate: 'tool_call_update', toolCallId: 'reused', status });
  }
  mapper.flush(true);
  await Promise.resolve();
  expect(entries.map((entry) => entry.tool?.name)).toEqual(['first', 'second']);
  expect(entries.map((entry) => entry.tool?.input)).toEqual(['first input', 'second input']);
  expect(entries.map((entry) => entry.tool?.outputTail)).toEqual(['first output', 'second output']);
  expect(new Set(entries.map((entry) => entry.tool?.callRef)).size).toBe(2);
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
});
