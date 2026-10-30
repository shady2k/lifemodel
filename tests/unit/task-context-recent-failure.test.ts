import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresTaskRegistry } from '../../src/storage/postgres-task-registry.js';

it('r1 recent query failure preserves active context and logs no values', async () => {
  const task = {
    id: 'active',
    harness: 'scripted',
    state: 'working',
    briefing: 'private briefing',
    commands: [],
    commandsOmitted: 0,
    question: null,
  };
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [task] })
    .mockRejectedValueOnce(new Error('private error value'));
  const warn = vi.fn();
  const registry = createPostgresTaskRegistry({
    pool: { query } as unknown as Pool,
    epoch: 1,
    settings: {} as never,
    logger: { warn },
  });
  await expect(registry.listActiveContext()).resolves.toEqual({
    tasks: [task],
    omitted: false,
    recentTasks: [],
  });
  expect(query).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    { component: 'task-context' },
    'Recent task context unavailable'
  );
});

it('r1 active query failure still rejects instead of hiding lost active state', async () => {
  const query = vi.fn().mockRejectedValue(new Error('offline'));
  const registry = createPostgresTaskRegistry({
    pool: { query } as unknown as Pool,
    epoch: 1,
    settings: {} as never,
  });
  await expect(registry.listActiveContext()).rejects.toThrow('offline');
});
