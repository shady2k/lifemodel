import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, readFile, stat, mkdir, chmod } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskTools } from '../../loader/src/task-tools.js';
import { LauncherError } from '../../loader/src/task-launcher-http.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(report: Parameters<typeof createTaskTools>[0]['report']) {
  const work = await mkdtemp(join(tmpdir(), 'task-mcp-'));
  cleanup.push(() => rm(work, { recursive: true, force: true }));
  // Permissions must also be repaired for a directory that already exists.
  await mkdir(join(work, '.launcher'));
  await chmod(join(work, '.launcher'), 0o755);
  const diagnostics: string[] = [];
  const tools = await createTaskTools({
    workDirectory: work,
    report,
    diagnostic: (code) => diagnostics.push(code),
  });
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
  const pending = new Map<number | null, (value: any) => void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const raw = (line: string, identity: number | null) =>
    new Promise<any>((resolve) => {
      pending.set(identity, resolve);
      child.stdin.write(line + '\n');
    });
  const call = async (method: string, params: unknown = {}, identity = ++id) =>
    (await raw(JSON.stringify({ jsonrpc: '2.0', id: identity, method, params }), identity)).result;
  return { tools, work, child: child as ChildProcessWithoutNullStreams, call, raw, diagnostics };
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
    const f = await fixture(async () => {
      count++;
      await gate.promise;
      throw new Error('private_channel_failure');
    });
    const relay = (id: string, kind = 'question') =>
      new Promise<any>((resolve, reject) => {
        const socket = createConnection(join(f.work, '.launcher/tools.sock'));
        socket.on('error', reject);
        let buffer = '';
        socket.on('data', (chunk) => {
          buffer += chunk;
        });
        socket.on('end', () => {
          try {
            resolve(JSON.parse(buffer));
          } catch {
            reject(new Error('relay_response_missing'));
          }
        });
        socket.on('connect', () =>
          socket.write(JSON.stringify({ id, kind, text: 'Which output?' }) + '\n')
        );
      });
    const id = 'a'.repeat(64);
    const first = relay(id);
    await expect.poll(() => count).toBe(1);
    const duplicate = relay(id);
    expect(await relay('b'.repeat(64), 'step')).toEqual({ error: 'report_busy' });
    expect(await relay('c'.repeat(64))).toEqual({ error: 'question_open' });
    gate.resolve();
    expect(await first).toEqual({ error: 'report_uncertain' });
    expect(await duplicate).toEqual({ error: 'report_uncertain' });
    expect(await relay(id)).toEqual({ error: 'report_uncertain' });
    expect(count).toBe(1);
    expect(f.tools.question.isOpen()).toBe(true);
  });

  it('keeps a slow committing ACK in flight beyond the request-read deadline', async () => {
    let committed = false;
    const f = await fixture(async () => {
      await delay(16_000);
      committed = true;
    });
    const result = await f.call('tools/call', { name: 'step', arguments: { text: 'Slow ACK' } });
    expect(committed).toBe(true);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text).messageId).toMatch(/^msg_/);
    expect(f.diagnostics).toEqual([]);
  }, 25_000);

  it('releases a definitely refused question, notifies waiters, and retains its failed identity', async () => {
    let count = 0;
    const f = await fixture(async () => {
      if (++count === 1) throw new LauncherError('request_refused', 409);
    });
    const args = { name: 'question', arguments: { text: 'Private refused question' } };
    expect(await f.call('tools/call', args, 10)).toMatchObject({
      isError: true,
      content: [{ text: '"report_unavailable"' }],
    });
    expect(f.tools.question.isOpen()).toBe(false);
    const abort = new AbortController();
    const changed = f.tools.question.waitForChange(abort.signal);
    expect(await f.call('tools/call', args, 10)).toMatchObject({ isError: true });
    expect(count).toBe(1);
    expect((await f.call('tools/call', args, 11)).isError).toBe(false);
    await changed;
    abort.abort();
    expect(count).toBe(2);
    expect(f.tools.question.isOpen()).toBe(true);
    expect(f.diagnostics).toEqual(['task_tool_report_unavailable', 'task_tool_report_unavailable']);
  });

  it('emits only fixed diagnostic codes and reports an unknown send as uncertain', async () => {
    const f = await fixture(async () => {
      throw new Error('PRIVATE REPORT TEXT');
    });
    expect(
      await f.call('tools/call', { name: 'question', arguments: { text: 'PRIVATE QUESTION' } })
    ).toMatchObject({ isError: true, content: [{ text: '"report_uncertain"' }] });
    expect(f.tools.question.isOpen()).toBe(true);
    expect(f.diagnostics).toEqual(['task_tool_question_retained', 'task_tool_report_uncertain']);
  });

  it('replies to malformed and oversized stdin and keeps serving with supported protocol versions', async () => {
    const f = await fixture(async () => undefined);
    const invalid: [string, number | null, number][] = [
      ['{', null, -32700],
      ['[]', null, -32600],
      ['null', null, -32600],
      [JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: null }), 10, -32602],
      ['x'.repeat(140_000), null, -32600],
    ];
    for (const [line, identity, code] of invalid) {
      expect(await f.raw(line, identity)).toMatchObject({ id: identity, error: { code } });
      expect(await f.call('ping')).toEqual({});
    }
    for (const version of ['2024-11-05', '2025-06-18'])
      expect(await f.call('initialize', { protocolVersion: version })).toMatchObject({
        protocolVersion: version,
      });
    expect(await f.call('initialize', { protocolVersion: '2099-unknown' })).toMatchObject({
      protocolVersion: '2025-06-18',
    });
    expect(
      (await f.call('tools/call', { name: 'step', arguments: { text: 'Still serving' } })).isError
    ).toBe(false);
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

  it('accepts a UTF-8 line at the byte limit without expanding it into a refused relay frame', async () => {
    const reports: unknown[] = [];
    const f = await fixture(async (...args) => {
      reports.push(args);
    });
    const text = 'é'.repeat(512);
    expect((await f.call('tools/call', { name: 'step', arguments: { text } })).isError).toBe(false);
    expect(reports).toHaveLength(1);
  });

  it('executes the actual shim with an empty environment and private socket, without credential paths or contents', async () => {
    const f = await fixture(async () => undefined);
    // Observe the Python process after exec, not env's transient empty proc view.
    await f.call('initialize', { protocolVersion: '2024-11-05' });
    const environment = (await readFile(`/proc/${f.child.pid}/environ`, 'utf8'))
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.split('=', 1)[0]);
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
