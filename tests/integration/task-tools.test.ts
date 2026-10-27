import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskTools } from '../../loader/src/task-tools.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(report: Parameters<typeof createTaskTools>[0]['report']) {
  const work = await mkdtemp(join(tmpdir(), 'task-mcp-'));
  cleanup.push(() => rm(work, { recursive: true, force: true }));
  const tools = await createTaskTools({ workDirectory: work, report });
  cleanup.push(() => tools.close());
  const config = tools.mcpServers[0]!;
  const child = spawn(config.command, config.args, {
    env: {
      ...process.env,
      LIFEMODEL_TASK_CHANNEL_TOKEN_FILE: '/private/channel-token',
      SECRET_CANARY: 'must-not-inherit',
    },
    stdio: 'pipe',
  });
  cleanup.push(async () => {
    if (child.exitCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.kill();
    await closed;
  });
  let id = 0;
  const pending = new Map<number, (value: any) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
  });
  const call = (method: string, params: unknown = {}, identity = ++id) =>
    new Promise<any>((resolve) => {
      pending.set(identity, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: identity, method, params }) + '\n');
    });
  return { tools, work, child: child as ChildProcessWithoutNullStreams, call };
}
describe('credential-free task MCP stdio shim and launcher relay', () => {
  it('discovers only step/question, waits for durable ACK, and replays the same MCP call without a second effect', async () => {
    const gate = Promise.withResolvers<void>();
    const reports: unknown[] = [];
    const f = await fixture(async (...args) => {
      reports.push(args);
      await gate.promise;
    });
    expect(await f.call('initialize', { protocolVersion: '2024-11-05' })).toMatchObject({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
    });
    expect((await f.call('tools/list')).tools.map((tool: { name: string }) => tool.name)).toEqual([
      'step',
      'question',
    ]);
    let finished = false;
    const pending = f
      .call('tools/call', { name: 'step', arguments: { text: 'Saved step' } }, 10)
      .then((value) => {
        finished = true;
        return value;
      });
    await expect.poll(() => reports.length).toBe(1);
    expect(finished).toBe(false);
    gate.resolve();
    const first = await pending;
    expect(first.isError).toBe(false);
    expect(
      await f.call('tools/call', { name: 'step', arguments: { text: 'Saved step' } }, 10)
    ).toEqual(first);
    expect(reports).toHaveLength(1);
    expect(
      await f.call('tools/call', { name: 'step', arguments: { text: 'Changed step' } }, 10)
    ).toMatchObject({ isError: true, content: [{ text: '"report_conflict"' }] });
    const q = await f.call(
      'tools/call',
      { name: 'question', arguments: { text: 'Which output?' } },
      11
    );
    expect(q.isError).toBe(false);
    expect(
      await f.call('tools/call', { name: 'question', arguments: { text: 'Which output?' } }, 11)
    ).toEqual(q);
    expect(reports).toHaveLength(2);
    const result = JSON.parse(q.content[0].text);
    expect(result.questionId).toBe(result.messageId);
    expect(f.tools.question.isOpen()).toBe(true);
    f.tools.answerAdmitted('wrong-question');
    expect(f.tools.question.isOpen()).toBe(true);
    f.tools.answerAdmitted(result.questionId);
    expect(f.tools.question.isOpen()).toBe(false);
  });


  it('joins in-flight relay replay, bounds the producer and retains an ambiguous failed question', async () => {
    const gate = Promise.withResolvers<void>();
    let count = 0;
    const f = await fixture(async () => { count++; await gate.promise; throw new Error('private_channel_failure'); });
    const relay = (id: string, kind = 'question') => new Promise<any>((resolve, reject) => {
      const socket = createConnection(join(f.work, '.launcher/tools.sock'));
      socket.on('error', reject);
      let buffer = '';
      socket.on('data', (chunk) => { buffer += chunk; });
      socket.on('end', () => { resolve(JSON.parse(buffer)); });
      socket.on('connect', () => socket.end(JSON.stringify({ id, kind, text: 'Which output?' }) + '\n'));
    });
    const id = 'a'.repeat(64);
    const first = relay(id);
    await expect.poll(() => count).toBe(1);
    const duplicate = relay(id);
    expect(await relay('b'.repeat(64), 'step')).toEqual({ error: 'report_busy' });
    expect(await relay('c'.repeat(64))).toEqual({ error: 'question_open' });
    gate.resolve();
    expect(await first).toEqual({ error: 'report_unavailable' });
    expect(await duplicate).toEqual({ error: 'report_unavailable' });
    expect(await relay(id)).toEqual({ error: 'report_unavailable' });
    expect(count).toBe(1);
    expect(f.tools.question.isOpen()).toBe(true);
  });

  it('bounds a question flood to one open question and returns explicitly refused calls', async () => {
    const reports: unknown[] = [];
    const f = await fixture(async (...args) => {
      reports.push(args);
    });
    const results = [];
    for (let i = 0; i < 40; i++)
      results.push(
        await f.call('tools/call', { name: 'question', arguments: { text: `Question ${i}?` } })
      );
    expect(results.filter((value) => !value.isError)).toHaveLength(1);
    expect(results.slice(1).every((value) => value.content[0].text === '"question_open"')).toBe(
      true
    );
    expect(reports).toHaveLength(1);
  });

  it('rejects oversized, multiline and identity-injecting reports before the durable channel', async () => {
    const reports: unknown[] = [];
    const f = await fixture(async (...args) => {
      reports.push(args);
    });
    for (const args of [
      { text: 'x'.repeat(1025) },
      { text: 'a\nb' },
      { text: '' },
      { text: 'hi', questionId: 'forged' },
    ]) {
      expect((await f.call('tools/call', { name: 'question', arguments: args })).isError).toBe(
        true
      );
    }
    expect(reports).toEqual([]);
    expect(f.tools.question.isOpen()).toBe(false);
  });

  it('executes the actual shim with an empty environment and private socket, without credential paths or contents', async () => {
    const f = await fixture(async () => undefined);
    const environment = (await readFile(`/proc/${f.child.pid}/environ`, 'utf8'))
      .split('\0')
      .filter(Boolean);
    expect(environment).toEqual([]);
    const argv = (await readFile(`/proc/${f.child.pid}/cmdline`, 'utf8')).split('\0');
    expect(argv.join(' ')).not.toMatch(/private\/channel-token|must-not-inherit/);
    expect((await stat(join(f.work, '.launcher'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(f.work, '.launcher/tools.sock'))).mode & 0o777).toBe(0o600);
    expect(
      (await f.call('tools/call', { name: 'step', arguments: { text: 'No credential needed' } }))
        .isError
    ).toBe(false);
  });

  it('releases question-state listeners on abort and limits partial socket peers', async () => {
    const f = await fixture(async () => undefined);
    const abort = new AbortController();
    const waiting = f.tools.question.waitForChange(abort.signal);
    abort.abort();
    await waiting;
    const sockets = Array.from({ length: 5 }, () =>
      createConnection(join(f.work, '.launcher/tools.sock'))
    );
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy();
    });
    for (const socket of sockets) socket.on('error', () => undefined);
    await expect.poll(() => sockets.filter((socket) => socket.destroyed).length).toBe(1);
  });
});
