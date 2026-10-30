import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpTurn } from '../../loader/src/task-acp.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import {
  admit,
  bind,
  observeInsertion,
  release,
  reconcileEndTurn,
} from '../../loader/src/task-prime-agent.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function daemon(
  roots: unknown[],
  loseAck = false,
  respond?: (
    command: Record<string, unknown>,
    seen: Record<string, unknown>[]
  ) => Record<string, unknown>
) {
  const work = await mkdtemp(join(tmpdir(), 'prime-steer-'));
  await mkdir(join(work, '.launcher'));
  cleanup.push(() => rm(work, { recursive: true, force: true }));
  const seen: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    socket.on('error', () => undefined);
    socket.write(
      JSON.stringify({
        type: 'daemon_hello',
        appVersion: '0.10.1',
        protocol: { name: 'prime-agent.daemon', version: 7 },
      }) + '\n'
    );
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      const frame = JSON.parse(buffer.split('\n')[0]!);
      seen.push(frame.command);
      if (frame.command.type === 'steer' && loseAck) {
        socket.destroy();
        return;
      }
      socket.end(
        JSON.stringify({
          type: 'response',
          id: frame.id,
          command: frame.command.type,
          success: true,
          ...(frame.command.type !== 'list' && respond
            ? respond(frame.command, seen)
            : {
                data:
                  frame.command.type === 'list'
                    ? { sessions: roots.map((root) => ({ cwd: work, ...(root as object) })) }
                    : { queued: true },
              }),
        }) + '\n'
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(join(work, '.launcher/daemon.sock'), resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  );
  cleanup.push(async () => {
    release({ workDirectory: work, sessionId: 'acp' });
    release({ workDirectory: work, sessionId: 'acp-id-is-different' });
  });
  return { work, seen };
}
const control = () => ({ closeIntake: vi.fn(async () => [] as string[]), reopenIntake: vi.fn() });
const idleState = {
  activeSessionId: 'native-root',
  isSessionActive: false,
  isStreaming: false,
  isCompacting: false,
  isRunningTools: false,
  hasRunningSubagents: false,
};
const row = (role: string, text: string) => ({
  role,
  content: [{ type: 'text', text }],
  ...(role === 'assistant' ? { stopReason: 'stop' } : {}),
});
const root = { rlmDepth: 0, runtimeKind: 'top-level', activeSessionId: 'native-root' };
describe('Prime same-daemon steering', () => {
  it('returns idle without scanning a long transcript when every command was observed inserted', async () => {
    const { work, seen } = await daemon([root], false, (command) => {
      if (command.type === 'get_state') return { data: idleState };
      if (command.type === 'get_queue') return { data: { steering: [], followUp: [] } };
      return {
        data: {
          messages: [row('toolResult', 'x'.repeat(1048577))],
          more: true,
          firstEntryId: 'old',
        },
      };
    });
    await bind({ workDirectory: work, sessionId: 'acp' });
    expect(
      await reconcileEndTurn({
        workDirectory: work,
        sessionId: 'acp',
        commandIds: ['cmd'],
        insertedCommandIds: ['cmd'],
        signal: new AbortController().signal,
      })
    ).toEqual({ state: 'idle' });
    expect(seen.map((c) => c.type)).toEqual(['list', 'get_state', 'get_queue']);
  });

  it.each(['steering', 'followUp'] as const)(
    'awaits a nonempty %s queue even with idle flags',
    async (lane) => {
      let queued = true;
      const { work, seen } = await daemon([root], false, (command) => {
        if (command.type === 'get_state') return { data: idleState };
        if (command.type === 'get_queue')
          return { data: { steering: [], followUp: [], [lane]: queued ? ['waiting'] : [] } };
        return {
          data: {
            messages: [row('user', 'brief'), row('assistant', 'Queue drained')],
            more: false,
          },
        };
      });
      await bind({ workDirectory: work, sessionId: 'acp' });
      const result = await reconcileEndTurn({
        workDirectory: work,
        sessionId: 'acp',
        commandIds: [],
        signal: new AbortController().signal,
      });
      expect(result.state).toBe('successor');
      if (result.state !== 'successor') throw new Error('expected_successor');
      const fence = control();
      const pending = result.wait(fence);
      await vi.waitFor(() =>
        expect(seen.filter((c) => c.type === 'get_queue').length).toBeGreaterThanOrEqual(2)
      );
      expect(fence.closeIntake).not.toHaveBeenCalled();
      queued = false;
      expect((await pending)?.updates.at(-1)).toEqual({ kind: 'text', text: 'Queue drained' });
    }
  );

  it.each(['old-oversize', 'old-many-pages', 'unsteered'] as const)(
    'stops at the required user boundary before %s',
    async (mode) => {
      let marker = '';
      let states = 0;
      const { work, seen } = await daemon([root], false, (command) => {
        if (command.type === 'steer') {
          marker = command.message as string;
          return { data: { queued: true } };
        }
        if (command.type === 'get_state')
          return {
            data: { ...idleState, isSessionActive: mode === 'unsteered' && states++ === 0 },
          };
        if (command.type === 'get_queue') return { data: { steering: [], followUp: [] } };
        const before = (command.page as { before?: string }).before;
        const index = before ? Number(before) : 0;
        const relevant = mode === 'unsteered' ? 'brief' : marker;
        return {
          data: {
            messages: [
              index === 0
                ? row('assistant', 'Tail final')
                : index === 1
                  ? row('user', relevant)
                  : row('toolResult', mode === 'old-oversize' ? 'x'.repeat(1048577) : 'old'),
            ],
            more: true,
            firstEntryId: String(index + 1),
            historyLeafId: 'leaf',
          },
        };
      });
      const command = { workDirectory: work, sessionId: 'acp', commandId: 'cmd', text: 'continue' };
      await bind(command);
      if (mode !== 'unsteered') await admit(command);
      // Simulate flags lagging ACP: first state check is busy, successor then idle.
      const ids = mode === 'unsteered' ? [] : ['cmd'];
      const result = await reconcileEndTurn({
        ...command,
        commandIds: ids,
        signal: new AbortController().signal,
      });
      expect(result.state).toBe('successor');
      if (result.state !== 'successor') throw new Error('expected_successor');
      expect((await result.wait(control()))?.updates.at(-1)).toEqual({
        kind: 'text',
        text: 'Tail final',
      });
      const pages = seen.filter((c) => c.type === 'get_messages');
      expect(pages).toHaveLength(2);
      expect(pages[1]).toMatchObject({ historyLeafId: 'leaf', page: { before: '1' } });
    }
  );

  it('backs off native idle probes while successor work is busy', async () => {
    const probes: number[] = [];
    const { work } = await daemon([root], false, (command) => {
      if (command.type === 'get_state') {
        probes.push(performance.now());
        return { data: { ...idleState, isSessionActive: probes.length < 5 } };
      }
      if (command.type === 'get_queue') return { data: { steering: [], followUp: [] } };
      return { data: { messages: [row('user', 'brief'), row('assistant', 'Final')], more: false } };
    });
    await bind({ workDirectory: work, sessionId: 'acp' });
    const result = await reconcileEndTurn({
      workDirectory: work,
      sessionId: 'acp',
      commandIds: [],
      signal: AbortSignal.timeout(5000),
    });
    if (result.state !== 'successor') throw new Error('expected_successor');
    expect(await result.wait(control())).toBeDefined();
    expect(probes[3]! - probes[2]!).toBeGreaterThanOrEqual(180);
    expect(probes[4]! - probes[3]!).toBeGreaterThanOrEqual(380);
  });

  it('retains evidence from the earliest of multiple required markers, not just the latest', async () => {
    const markers: string[] = [];
    const { work } = await daemon([root], false, (command) => {
      if (command.type === 'steer') {
        markers.push(command.message as string);
        return { data: { queued: true } };
      }
      if (command.type === 'get_state') return { data: idleState };
      if (command.type === 'get_queue') return { data: { steering: [], followUp: [] } };
      const rows = [
        row('user', markers[0]!),
        { role: 'assistant', content: [{ type: 'toolCall', id: 'unfinished', arguments: {} }] },
        row('user', markers[1]!),
        row('assistant', 'Later final'),
      ];
      const index = Number((command.page as { before?: string }).before ?? 0);
      return {
        data: {
          messages: [rows[3 - index]],
          more: true,
          firstEntryId: String(index + 1),
          historyLeafId: 'leaf',
        },
      };
    });
    const input = {
      workDirectory: work,
      sessionId: 'acp',
      commandIds: ['first', 'second'],
      signal: new AbortController().signal,
    };
    await bind(input);
    for (const commandId of input.commandIds) await admit({ ...input, commandId, text: commandId });
    const result = await reconcileEndTurn(input);
    if (result.state !== 'successor') throw new Error('expected_successor');
    expect(await result.wait(control())).toBeUndefined(); // the first marker's tool is still pending
  });

  it.each(['repeated', 'endless'] as const)(
    'fails closed on %s more:true paging',
    async (mode) => {
      const { work, seen } = await daemon([root], false, (command, calls) => {
        if (command.type === 'get_state') return { data: idleState };
        if (command.type === 'get_queue') return { data: { steering: [], followUp: [] } };
        return {
          data: {
            messages: [],
            more: true,
            firstEntryId: mode === 'repeated' ? 'same' : String(calls.length),
            historyLeafId: 'leaf',
          },
        };
      });
      await bind({ workDirectory: work, sessionId: 'acp' });
      const result = await reconcileEndTurn({
        workDirectory: work,
        sessionId: 'acp',
        commandIds: ['missing'],
        signal: AbortSignal.timeout(10000),
      });
      if (result.state !== 'successor') throw new Error('expected_successor');
      expect(await result.wait(control())).toBeUndefined();
      expect(seen.filter((c) => c.type === 'get_messages')).toHaveLength(
        mode === 'repeated' ? 2 : 1000
      );
    },
    15000
  );

  it('closes intake and rechecks idle after a steer is admitted during successor waiting', async () => {
    let marker = '';
    let lateMarker = '';
    let busy = false;
    let lateCompleted = false;
    let closing = 0;
    const { work, seen } = await daemon([root], false, (command) => {
      if (command.type === 'steer') {
        lateMarker = command.message as string;
        marker ||= lateMarker;
        return { data: { queued: true } };
      }
      if (command.type === 'get_state') {
        const active = busy;
        if (lateMarker !== marker && !busy) lateCompleted = true;
        busy = false;
        return { data: { ...idleState, isSessionActive: active } };
      }
      if (command.type === 'get_queue') return { data: { steering: [], followUp: [] } };
      return {
        data: {
          messages: [
            row('user', marker),
            row('assistant', 'First final'),
            row('user', lateMarker),
            ...(lateCompleted ? [row('assistant', 'Late final')] : []),
          ],
          more: false,
        },
      };
    });
    const input = {
      workDirectory: work,
      sessionId: 'acp',
      commandIds: ['first'],
      signal: new AbortController().signal,
    };
    await bind(input);
    await admit({ ...input, commandId: 'first', text: 'first' });
    const result = await reconcileEndTurn(input);
    if (result.state !== 'successor') throw new Error('expected_successor');
    const reopen = vi.fn();
    const evidence = await result.wait({
      closeIntake: async () => {
        closing++;
        if (closing !== 1) return [];
        expect(seen.some((c) => c.type === 'get_messages')).toBe(false);
        await admit({ ...input, commandId: 'late', text: 'late' });
        busy = true;
        return ['late'];
      },
      reopenIntake: reopen,
    });
    expect(closing).toBe(2);
    expect(reopen).toHaveBeenCalledOnce();
    expect(evidence?.updates.at(-1)).toEqual({ kind: 'text', text: 'Late final' });
  });

  it.each(['valid', 'missing', 'pending', 'error'] as const)(
    'classifies daemon successor evidence: %s',
    async (mode) => {
      let marker = '';
      const { work } = await daemon([root], false, (command) => {
        if (command.type === 'steer') {
          marker = command.message as string;
          return { data: { queued: true } };
        }
        if (command.type === 'get_state')
          return {
            data: {
              activeSessionId: 'native-root',
              isSessionActive: false,
              isStreaming: false,
              isCompacting: false,
              isRunningTools: false,
              hasRunningSubagents: false,
            },
          };
        if (command.type === 'get_queue') return { data: { steering: [], followUp: [] } };
        return {
          data: {
            more: false,
            messages: [
              { role: 'user', content: [{ type: 'text', text: marker }] },
              {
                role: 'assistant',
                content: [{ type: 'toolCall', id: 't', name: 'shell', arguments: {} }],
              },
              ...(mode === 'missing' || mode === 'pending'
                ? []
                : [
                    { role: 'toolResult', toolCallId: 't', isError: mode === 'error', content: [] },
                  ]),
              ...(mode === 'pending'
                ? []
                : [
                    {
                      role: 'assistant',
                      content: [{ type: 'text', text: 'Native final' }],
                      stopReason: 'stop',
                    },
                  ]),
            ],
          },
        };
      });
      const command = {
        workDirectory: work,
        sessionId: 'acp',
        commandId: 'successor',
        text: 'continue',
      };
      await bind(command);
      expect(await admit(command)).toBe('accepted');
      const reconciliation = await reconcileEndTurn({
        ...command,
        commandIds: ['successor'],
        signal: new AbortController().signal,
      });
      expect(reconciliation.state).toBe('successor');
      if (reconciliation.state !== 'successor') throw new Error('successor_required');
      const evidence = await reconciliation.wait(control());
      if (mode === 'valid' || mode === 'error') {
        expect(evidence?.updates.at(-1)).toEqual({ kind: 'text', text: 'Native final' });
        expect(evidence?.updates).toContainEqual(
          expect.objectContaining({
            kind: 'tool',
            status: mode === 'error' ? 'failed' : 'completed',
          })
        );
        const turn = new AcpTurn();
        for (const update of evidence!.updates) {
          if (update.kind === 'tool')
            turn.update({
              sessionUpdate: 'tool_call_update',
              toolCallId: update.id,
              status: update.status,
            });
        }
        expect(turn.result('end_turn').reasonCode).toBe(
          mode === 'error' ? 'required_tool_failed' : 'no_final_result'
        );
      } else expect(evidence).toBeUndefined();
    }
  );

  it('binds the sole root before steering and never retries a lost ACK', async () => {
    const { work, seen } = await daemon([root], true);
    await bind({ workDirectory: work, sessionId: 'acp-id-is-different' });
    const command = {
      workDirectory: work,
      sessionId: 'acp-id-is-different',
      commandId: 'cmd',
      text: 'do this',
    };
    expect(await admit(command)).toBe('uncertain');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ type: 'list', includeClientOwned: true });
    expect(seen[1]).toMatchObject({
      type: 'steer',
      activeSessionId: 'native-root',
      message: expect.stringContaining('do this'),
    });
  });
  it.each([
    { roots: [] },
    { roots: [root, root] },
    { roots: [{ ...root, rlmDepth: 1 }] },
    { roots: [{ ...root, runtimeKind: 'child' }] },
  ])('refuses ambiguous or nonroot bindings: %j', async ({ roots }) => {
    const { work, seen } = await daemon(roots);
    await expect(bind({ workDirectory: work, sessionId: 'acp' })).rejects.toThrow(
      'prime_root_ambiguous'
    );
    expect(
      await admit({ workDirectory: work, sessionId: 'acp', commandId: 'c', text: 'text' })
    ).toBe('rejected');
    expect(seen).toHaveLength(1);
  });
  it.each([
    { response: { success: false }, expected: 'rejected' },
    { response: { data: { queued: false } }, expected: 'uncertain' },
    { response: { data: {} }, expected: 'uncertain' },
    { response: { command: 'other', data: { queued: true } }, expected: 'uncertain' },
  ])(
    'normalizes the native admission outcome: $expected $response',
    async ({ response, expected }) => {
      const { work, seen } = await daemon([root], false, () => response);
      await bind({ workDirectory: work, sessionId: 'acp' });
      expect(
        await admit({ workDirectory: work, sessionId: 'acp', commandId: 'c', text: 'text' })
      ).toBe(expected);
      expect(seen).toHaveLength(2);
    }
  );

  it('releases the bound native root at harness end', async () => {
    const { work, seen } = await daemon([root]);
    await bind({ workDirectory: work, sessionId: 'acp' });
    release({ workDirectory: work, sessionId: 'acp' });
    expect(
      await admit({ workDirectory: work, sessionId: 'acp', commandId: 'c', text: 'text' })
    ).toBe('rejected');
    expect(seen).toHaveLength(1);
    expect(
      await observeInsertion({
        workDirectory: work,
        sessionId: 'acp',
        commandId: 'c',
        signal: new AbortController().signal,
      })
    ).toBe(false);
  });

  it('reads page two with the same history leaf and only accepts the marker in a native user row', async () => {
    let marker = '';
    const { work, seen } = await daemon([root], false, (command) => {
      if (command.type === 'steer') {
        marker = command.message as string;
        return { data: { queued: true } };
      }
      const page = command.page as { before?: string };
      return {
        data: page.before
          ? { messages: [{ role: 'user', content: [{ type: 'text', text: marker }] }] }
          : {
              messages: [{ role: 'assistant', content: [{ type: 'text', text: marker }] }],
              more: true,
              firstEntryId: 'page-1',
              historyLeafId: 'leaf',
            },
      };
    });
    const command = {
      workDirectory: work,
      sessionId: 'acp',
      commandId: 'page-two',
      text: 'continue',
    };
    await bind(command);
    expect(await admit(command)).toBe('accepted');
    expect(await observeInsertion({ ...command, signal: new AbortController().signal })).toBe(true);
    expect(seen.slice(2)).toEqual([
      { type: 'get_messages', activeSessionId: 'native-root', page: { from: 'end', limit: 1 } },
      {
        type: 'get_messages',
        activeSessionId: 'native-root',
        page: { from: 'end', limit: 1, before: 'page-1' },
        historyLeafId: 'leaf',
      },
    ]);
  });

  it.each(['pending', 'compaction'] as const)(
    'never infers insertion from %s and returns false on abort',
    async (mode) => {
      let marker = '';
      const { work, seen } = await daemon([root], false, (command) => {
        if (command.type === 'steer') {
          marker = command.message as string;
          return { data: { queued: true } };
        }
        return {
          data: {
            messages:
              mode === 'compaction'
                ? [{ role: 'compactionSummary', content: [{ type: 'text', text: marker }] }]
                : [],
          },
        };
      });
      const command = { workDirectory: work, sessionId: 'acp', commandId: mode, text: 'continue' };
      await bind(command);
      expect(await admit(command)).toBe('accepted');
      const abort = new AbortController();
      let settled = false;
      const observing = observeInsertion({ ...command, signal: abort.signal }).then((value) => {
        settled = true;
        return value;
      });
      try {
        await vi.waitFor(() =>
          expect(seen.some((command) => command.type === 'get_messages')).toBe(true)
        );
        expect(settled).toBe(false);
      } finally {
        abort.abort();
      }
      expect(await observing).toBe(false);
    }
  );

  it('silently abandons an oversized single-row page without another native steer', async () => {
    const { work, seen } = await daemon([root], false, (command) =>
      command.type === 'steer'
        ? { data: { queued: true } }
        : { data: { messages: [{ role: 'tool', content: 'x'.repeat(1048577) }] } }
    );
    const command = {
      workDirectory: work,
      sessionId: 'acp',
      commandId: 'oversize',
      text: 'continue',
    };
    await bind(command);
    expect(await admit(command)).toBe('accepted');
    expect(await observeInsertion({ ...command, signal: new AbortController().signal })).toBe(
      false
    );
    expect(seen.filter((command) => command.type === 'steer')).toHaveLength(1);
    expect(seen.filter((command) => command.type === 'get_messages')).toHaveLength(1);
  });

  it('a missing history socket yields no receipt evidence, not an exception', async () => {
    const { work } = await daemon([root]);
    const command = {
      workDirectory: work,
      sessionId: 'acp',
      commandId: 'lost-history',
      text: 'continue',
    };
    await bind(command);
    await rm(join(work, '.launcher/daemon.sock'));
    expect(await observeInsertion({ ...command, signal: new AbortController().signal })).toBe(
      false
    );
  });
});

it('uses native insertion timestamp for observation and successor evidence', async () => {
  let marker = '';
  const insertedAt = '2026-10-01T12:00:00.000Z';
  const { work } = await daemon([root], false, (command) => {
    if (command.type === 'steer') {
      marker = command.message as string;
      return { data: { queued: true } };
    }
    if (command.type === 'get_state') return { data: idleState };
    if (command.type === 'get_queue') return { data: { steering: [], followUp: [] } };
    return {
      data: {
        messages: [
          { ...row('user', marker), timestamp: Date.parse(insertedAt) },
          row('assistant', 'Caused work'),
        ],
        more: false,
      },
    };
  });
  const input = {
    workDirectory: work,
    sessionId: 'acp',
    commandId: 'cmd',
    text: 'continue',
    signal: new AbortController().signal,
  };
  await bind(input);
  await admit(input);
  expect(await observeInsertion(input)).toBe(insertedAt);
  const result = await reconcileEndTurn({ ...input, commandIds: ['cmd'] });
  if (result.state !== 'successor') throw new Error('expected_successor');
  expect((await result.wait(control()))?.updates).toContainEqual({
    kind: 'inserted',
    commandId: 'cmd',
    text: marker,
    insertedAt,
  });
});
