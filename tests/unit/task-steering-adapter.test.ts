import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admit, nativeMessageId } from '../../loader/src/task-opencode.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function work(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'steering-adapter-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'tmp'));
  return dir;
}
async function server(dir: string, respond: (request: Record<string, unknown>) => unknown): Promise<void> {
  const listener: Server = createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      const response = respond(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as Record<string, unknown>);
      if (response === undefined) socket.end();
      else socket.end(JSON.stringify(response) + '\n');
    });
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(join(dir, 'tmp/steer.sock'), resolve);
  });
  cleanup.push(() => new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));
}

describe('OpenCode steering adapter boundary', () => {
  it('sends the native session and deterministic identity and accepts only its matching acknowledgement', async () => {
    const dir = await work();
    const seen: Record<string, unknown>[] = [];
    await server(dir, (request) => { seen.push(request); return { ok: true, data: { id: request.id } }; });
    const command = { workDirectory: dir, sessionId: 'session', commandId: 'command', text: 'steer text' };
    expect(await admit(command)).toBe('accepted');
    expect(seen).toEqual([{ op: 'steer', sessionID: 'session', id: nativeMessageId('command'), text: 'steer text' }]);
    expect(nativeMessageId('command')).toBe(nativeMessageId('command'));
    expect(nativeMessageId('another')).not.toBe(nativeMessageId('command'));
  });

  it('treats wrong acknowledgements and dropped connections as uncertain, not rejected', async () => {
    const dir = await work();
    let count = 0;
    await server(dir, () => ++count === 1 ? { ok: true, data: { id: 'wrong' } } : undefined);
    const command = { workDirectory: dir, sessionId: 'session', commandId: 'command', text: 'steer' };
    expect(await admit(command)).toBe('uncertain');
    expect(await admit(command)).toBe('uncertain');
    expect(await admit({ ...command, text: ' ' })).toBe('rejected');
    expect(count).toBe(2);
  });
});
