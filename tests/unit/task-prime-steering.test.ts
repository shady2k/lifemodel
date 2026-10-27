import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { admit, bind, observeInsertion, release } from '../../loader/src/task-prime-agent.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function daemon(
  roots: unknown[], loseAck = false,
  respond?: (command: Record<string, unknown>, seen: Record<string, unknown>[]) => Record<string, unknown>
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
          ...(frame.command.type !== 'list' && respond ? respond(frame.command, seen) : { data:
            frame.command.type === 'list'
              ? { sessions: roots.map((root) => ({ cwd: work, ...(root as object) })) }
              : { queued: true } }),
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
  cleanup.push(async () => { release({workDirectory: work, sessionId: 'acp'}); release({workDirectory: work, sessionId: 'acp-id-is-different'}); });
  return { work, seen };
}
const root = { rlmDepth: 0, runtimeKind: 'top-level', activeSessionId: 'native-root' };
describe('Prime same-daemon steering', () => {
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
  ])('normalizes the native admission outcome: $expected $response', async ({response, expected}) => {
    const { work, seen } = await daemon([root], false, () => response);
    await bind({workDirectory: work, sessionId: 'acp'});
    expect(await admit({workDirectory: work, sessionId: 'acp', commandId: 'c', text: 'text'})).toBe(expected);
    expect(seen).toHaveLength(2);
  });

  it('releases the bound native root at harness end', async () => {
    const {work, seen} = await daemon([root]);
    await bind({workDirectory: work, sessionId: 'acp'});
    release({workDirectory: work, sessionId: 'acp'});
    expect(await admit({workDirectory: work, sessionId: 'acp', commandId: 'c', text: 'text'})).toBe('rejected');
    expect(seen).toHaveLength(1);
    expect(await observeInsertion({workDirectory: work, sessionId: 'acp', commandId: 'c', signal: new AbortController().signal})).toBe(false);
  });

  it('reads page two with the same history leaf and only accepts the marker in a native user row', async () => {
    let marker = '';
    const {work, seen} = await daemon([root], false, command => {
      if (command.type === 'steer') {
        marker = command.message as string;
        return {data: {queued: true}};
      }
      const page = command.page as {before?: string};
      return {data: page.before ? {messages: [{role: 'user', content: [{type: 'text', text: marker}]}]} :
        {messages: [{role: 'assistant', content: [{type: 'text', text: marker}]}], more: true, firstEntryId: 'page-1', historyLeafId: 'leaf'}};
    });
    const command = {workDirectory: work, sessionId: 'acp', commandId: 'page-two', text: 'continue'};
    await bind(command);
    expect(await admit(command)).toBe('accepted');
    expect(await observeInsertion({...command, signal: new AbortController().signal})).toBe(true);
    expect(seen.slice(2)).toEqual([
      {type: 'get_messages', activeSessionId: 'native-root', page: {from: 'end', limit: 1}},
      {type: 'get_messages', activeSessionId: 'native-root', page: {from: 'end', limit: 1, before: 'page-1'}, historyLeafId: 'leaf'}
    ]);
  });

  it.each(['pending', 'compaction'] as const)('never infers insertion from %s and returns false on abort', async mode => {
    let marker = '';
    const {work, seen} = await daemon([root], false, command => {
      if (command.type === 'steer') { marker = command.message as string; return {data: {queued: true}}; }
      return {data: {messages: mode === 'compaction' ? [{role: 'compactionSummary', content: [{type: 'text', text: marker}]}] : []}};
    });
    const command = {workDirectory: work, sessionId: 'acp', commandId: mode, text: 'continue'};
    await bind(command);
    expect(await admit(command)).toBe('accepted');
    const abort = new AbortController();
    let settled = false;
    const observing = observeInsertion({...command, signal: abort.signal}).then(value => {settled = true; return value;});
    try {
      await vi.waitFor(() => expect(seen.some(command => command.type === 'get_messages')).toBe(true));
      expect(settled).toBe(false);
    } finally { abort.abort(); }
    expect(await observing).toBe(false);
  });

  it('silently abandons an oversized single-row page without another native steer', async () => {
    const {work, seen} = await daemon([root], false, command => command.type === 'steer' ?
      {data: {queued: true}} : {data: {messages: [{role: 'tool', content: 'x'.repeat(1048577)}]}});
    const command = {workDirectory: work, sessionId: 'acp', commandId: 'oversize', text: 'continue'};
    await bind(command);
    expect(await admit(command)).toBe('accepted');
    expect(await observeInsertion({...command, signal: new AbortController().signal})).toBe(false);
    expect(seen.filter(command => command.type === 'steer')).toHaveLength(1);
    expect(seen.filter(command => command.type === 'get_messages')).toHaveLength(1);
  });

  it('a missing history socket yields no receipt evidence, not an exception', async () => {
    const {work} = await daemon([root]);
    const command = {workDirectory: work, sessionId: 'acp', commandId: 'lost-history', text: 'continue'};
    await bind(command);
    await rm(join(work, '.launcher/daemon.sock'));
    expect(await observeInsertion({...command, signal: new AbortController().signal})).toBe(false);
  });

});
