import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  admit,
  nativeMessageId,
  observeInsertion,
  reconcileEndTurn,
} from '../../loader/src/task-opencode.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function work(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'steering-adapter-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, '.launcher'));
  return dir;
}
async function server(
  dir: string,
  respond: (request: Record<string, unknown>) => unknown
): Promise<void> {
  const listener: Server = createServer((socket) => {
    socket.on('error', () => undefined);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      const response = respond(
        JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as Record<string, unknown>
      );
      if (response === undefined) socket.end();
      else socket.end(JSON.stringify(response) + '\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(join(dir, '.launcher/steer.sock'), resolve);
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve()))
      )
  );
}

describe('OpenCode steering adapter boundary', () => {
  it.each([
    ['inserted', 'idle'],
    ['pending', 'continue'],
    ['unknown', 'unknown'],
    ['compaction', 'unknown'],
    ['failed', 'unknown'],
  ])('reconciles native %s as %s', async (status, expected) => {
    const dir = await work();
    await server(dir, (request) => ({ ok: true, data: { id: request.id, status } }));
    const result = await reconcileEndTurn({
      workDirectory: dir,
      sessionId: 'session',
      commandIds: ['cmd'],
      signal: new AbortController().signal,
    });
    expect(result).toEqual(
      expected === 'continue' ? { state: 'continue', commandIds: ['cmd'] } : { state: expected }
    );
  });

  it('fails closed if an ID remains pending after its one continuation', async () => {
    const dir = await work();
    await server(dir, (request) => ({ ok: true, data: { id: request.id, status: 'pending' } }));
    const input = {
      workDirectory: dir,
      sessionId: 'session',
      commandIds: ['cmd'],
      signal: new AbortController().signal,
    };
    expect(await reconcileEndTurn(input)).toEqual({ state: 'continue', commandIds: ['cmd'] });
    expect(await reconcileEndTurn({ ...input, continuedCommandIds: ['cmd'] })).toEqual({
      state: 'unknown',
    });
  });

  it('sends the native session and deterministic identity and accepts only its matching acknowledgement', async () => {
    const dir = await work();
    const seen: Record<string, unknown>[] = [];
    await server(dir, (request) => {
      seen.push(request);
      return { ok: true, data: { id: request.id } };
    });
    const command = {
      workDirectory: dir,
      sessionId: 'session',
      commandId: 'command',
      text: 'steer text',
    };
    expect(await admit(command)).toBe('accepted');
    expect(seen).toEqual([
      { op: 'steer', sessionID: 'session', id: nativeMessageId('command'), text: 'steer text' },
    ]);
    expect(nativeMessageId('command')).toBe(nativeMessageId('command'));
    expect(nativeMessageId('another')).not.toBe(nativeMessageId('command'));
  });

  it('treats wrong acknowledgements and dropped connections as uncertain, not rejected', async () => {
    const dir = await work();
    let count = 0;
    await server(dir, () => (++count === 1 ? { ok: true, data: { id: 'wrong' } } : undefined));
    const command = {
      workDirectory: dir,
      sessionId: 'session',
      commandId: 'command',
      text: 'steer',
    };
    expect(await admit(command)).toBe('uncertain');
    expect(await admit(command)).toBe('uncertain');
    expect(await admit({ ...command, text: ' ' })).toBe('rejected');
    expect(count).toBe(2);
  });
  it('waits through pending/compaction status and returns false when never inserted before abort', async () => {
    const dir = await work();
    const statuses = ['pending', 'compaction'];
    const seen: Record<string, unknown>[] = [];
    await server(dir, (request) => {
      seen.push(request);
      return { ok: true, data: { id: request.id, status: statuses[Math.min(seen.length - 1, 1)] } };
    });
    const abort = new AbortController();
    let settled = false;
    const observing = observeInsertion({
      workDirectory: dir,
      commandId: 'cmd',
      signal: abort.signal,
    }).then((value) => {
      settled = true;
      return value;
    });
    try {
      await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
      expect(settled).toBe(false);
    } finally {
      abort.abort();
    }
    expect(await observing).toBe(false);
    expect(seen.every((request) => request.op === 'disposition')).toBe(true);
  });

  it('accepts only a matching positive inserted disposition', async () => {
    const dir = await work();
    let count = 0;
    await server(dir, (request) => ({
      ok: true,
      data: { id: ++count === 1 ? 'wrong' : request.id, status: 'inserted' },
    }));
    expect(
      await observeInsertion({
        workDirectory: dir,
        commandId: 'cmd',
        signal: new AbortController().signal,
      })
    ).toBe(true);
    expect(count).toBe(2);
  });

  it('does not mistake an oversized disposition page for insertion', async () => {
    const dir = await work();
    const abort = new AbortController();
    let reads = 0;
    await server(dir, (request) => {
      reads++;
      if (reads === 2) abort.abort();
      return { ok: true, data: { id: request.id, status: 'pending', output: 'x'.repeat(1048577) } };
    });
    expect(
      await observeInsertion({ workDirectory: dir, commandId: 'cmd', signal: abort.signal })
    ).toBe(false);
    expect(reads).toBe(2);
  });
});
