import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTaskChannelScheduler } from '../../src/core/task-channel-scheduler.js';

describe('task-channel core reservations', () => {
  it('removes counter entries by the same TLS request socket used as their key', () => {
    const source = readFileSync('src/core/task-channel.ts', 'utf8');
    expect(source).toContain('const socket = req.socket;');
    expect(source).toContain(
      "if (!counters.has(socket)) socket.once('close', () => counters.delete(socket));"
    );
    expect(source).toContain('counters.set(socket, count);');
  });

  it('unlinks canceled queued work before releasing frame reservations', async () => {
    const source = readFileSync('src/core/task-channel.ts', 'utf8');
    expect(source.indexOf('mailbox.remove(queuedWork)')).toBeGreaterThan(0);
    expect(source.indexOf('mailbox.remove(queuedWork)')).toBeLessThan(
      source.indexOf('buffered -= reservedBytes')
    );
    const scheduler = createTaskChannelScheduler(1, () => false);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const complete = Promise.withResolvers<void>();
    const ran: string[] = [];
    scheduler.add({
      taskId: 'a',
      cancelled: () => false,
      run: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    const cancelled = {
      taskId: 'b',
      cancelled: () => false,
      run: async () => {
        ran.push('cancelled');
      },
    };
    scheduler.add(cancelled);
    scheduler.remove(cancelled);
    scheduler.add({
      taskId: 'c',
      cancelled: () => false,
      run: async () => {
        ran.push('healthy');
        complete.resolve();
      },
    });
    release.resolve();
    await complete.promise;
    expect(ran).toEqual(['healthy']);
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
