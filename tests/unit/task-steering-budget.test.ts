import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const fake = { commands: [] as Record<string, unknown>[] };
vi.doMock('node:timers/promises', () => ({
  setTimeout: (ms: number, value: unknown, {signal}: {signal: AbortSignal}) => new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new Error('aborted')); };
    const timer = setTimeout(() => {signal.removeEventListener('abort', cancel); resolve(value);}, ms);
    signal.addEventListener('abort', cancel, {once: true});
    if (signal.aborted) cancel();
  }),
}));
vi.doMock('node:net', () => ({
  connect: (path: string) => {
    class Socket extends EventEmitter {
      setEncoding() {}
      destroy() { this.removeAllListeners(); }
      write(line: string) {
        const request = JSON.parse(line);
        const command = request.command ?? request;
        fake.commands.push(command);
        const response = request.command ? {
          type: 'response', id: request.id, command: command.type, success: true,
          data: command.type === 'list' ? {sessions: [{cwd: '/work', rlmDepth: 0, runtimeKind: 'top-level', activeSessionId: 'native'}]} : {messages: []},
        } : {ok: true, data: {id: command.id, status: 'pending'}};
        queueMicrotask(() => this.emit('data', JSON.stringify(response) + '\n'));
      }
    }
    const socket = new Socket();
    queueMicrotask(() => {
      if (path.endsWith('daemon.sock')) socket.emit('data', JSON.stringify({type: 'daemon_hello', appVersion: '0.10.1', protocol: {name: 'prime-agent.daemon', version: 7}}) + '\n');
      else socket.emit('connect');
    });
    return socket;
  },
}));
const { bind, release, observeInsertion: prime } = await import('../../loader/src/task-prime-agent.js');
const { observeInsertion: openCode } = await import('../../loader/src/task-opencode.js');

afterEach(() => { vi.useRealTimers(); fake.commands = []; release({workDirectory: '/work', sessionId: 'acp'}); });
describe('bounded insertion observation', () => {
  it.each([
    {name: 'Prime', observe: prime, passes: 8, op: 'get_messages'},
    {name: 'OpenCode', observe: openCode, passes: 12, op: 'disposition'},
  ])('$name backs off then silently gives up with no receipt', async ({observe, passes, op}) => {
    await bind({workDirectory: '/work', sessionId: 'acp'});
    fake.commands = [];
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    let settled = false;
    const pending = observe({workDirectory: '/work', sessionId: 'acp', commandId: 'never', signal: new AbortController().signal})
      .then(value => {settled = true; return value;});
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.commands).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(fake.commands).toHaveLength(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.commands).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(fake.commands).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await pending).toBe(false);
    expect(fake.commands).toHaveLength(passes);
    expect(fake.commands.every(command => (command.type ?? command.op) === op)).toBe(true);
  });
});
