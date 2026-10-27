/** Prime owns its offline runtime and private configuration. */
import { access, rename } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { expect } from 'vitest';
export const usesModelEndpoint = true;
// Python exceptions are reported completed by Prime; see docs/features/motor/task-harness.md.
export const failedToolExemption = 'Prime ACP does not report Python exceptions as failed';
export function shellTool(command: string): { name: string; arguments: string } {
  return {
    name: 'python_repl',
    arguments: JSON.stringify({
      code: `h = bash(${JSON.stringify(command)}, yield_after=60)\nr = await h\nprint(r.output)\nif r.exit_code != 0: raise RuntimeError(f"Shell exit {r.exit_code}")`,
    }),
  };
}
export async function checkProvisioned(): Promise<void> {
  await access('/opt/lifemodel/agents/prime-agent-python/bin/python');
  await access('/opt/lifemodel/agents/prime-agent/prime-agent-runtime');
}
export async function checkOffline(work: string): Promise<void> {
  await expect(access(join(work, 'home/bootstrap-attempt'))).rejects.toThrow();
}

/** Wire-level evidence loss, while the actual pinned daemon still executes. */
export async function loseSuccessorEvidence(work: string): Promise<() => Promise<void>> {
  const path = join(work, '.launcher/daemon.sock');
  const original = path + '.real';
  await rename(path, original);
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((client) => {
    const upstream = connect(original);
    sockets.add(client);
    sockets.add(upstream);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => {
      sockets.delete(client);
      upstream.destroy();
    });
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.end();
    });
    client.pipe(upstream);
    let buffer = '';
    upstream.setEncoding('utf8');
    upstream.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const frame = JSON.parse(line);
        if (frame.type === 'response' && frame.command === 'get_messages' && frame.success) {
          // Keep final text but erase required tool settlement evidence.
          frame.data.messages = (frame.data.messages ?? []).filter(
            (row: { role?: string }) => row.role !== 'toolResult'
          );
        }
        client.write(JSON.stringify(frame) + '\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
