import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('task-channel core reservations', () => {
  it('removes counter entries by the same TLS request socket used as their key', () => {
    const source = readFileSync('src/core/task-channel.ts', 'utf8');
    expect(source).toContain('const socket = req.socket;');
    expect(source).toContain(
      "if (!counters.has(socket)) socket.once('close', () => counters.delete(socket));"
    );
    expect(source).toContain('counters.set(socket, count);');
  });

  it('unlinks canceled queued work before releasing frame reservations', () => {
    const source = readFileSync('src/core/task-channel.ts', 'utf8');
    expect(source).toContain('queue.splice(index, 1)');
    expect(source.indexOf('queue.splice(index, 1)')).toBeLessThan(
      source.indexOf('buffered -= reservedBytes')
    );
  });

  it('uses a separate bounded SQL pool and cancels it at intake stop', () => {
    const source = readFileSync('src/core/container.ts', 'utf8');
    expect(source).toContain('const channelPool = new Pool({');
    expect(source).toContain("max: settings['tasks.channel.sqlConnections']");
    expect(source).toMatch(/createPostgresTaskMailbox\(\{\s*pool: channelPool,/);
    expect(source).not.toMatch(/createPostgresTaskMailbox\(\{\s*pool: rawPostgres,/);
    expect(source).toContain('const taskChannelDrain = stopTaskChannel?.(deadline)');
    expect(source).toContain('mailbox.stop()');
    expect(source.indexOf('const taskChannelDrain = stopTaskChannel?.(deadline)')).toBeLessThan(
      source.indexOf('return shutdownSequence({', source.indexOf('const taskChannelDrain'))
    );
  });
});
