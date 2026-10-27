import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { admit, bind } from '../../loader/src/task-prime-agent.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function daemon(roots: unknown[], loseAck = false) {
  const work = await mkdtemp(join(tmpdir(), 'prime-steer-'));
  await mkdir(join(work, 'tmp'));
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
          data:
            frame.command.type === 'list'
              ? { sessions: roots.map((root) => ({ cwd: work, ...(root as object) })) }
              : { queued: true },
        }) + '\n'
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(join(work, 'tmp/daemon.sock'), resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  );
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
});
