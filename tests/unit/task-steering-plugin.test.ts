import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { admit } from '../../loader/src/task-opencode.js';

describe('baked OpenCode steering plugin', () => {
  it('uses stable native IDs, delivery steer and resume false, without waiting for a tool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-steer-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'tmp'));
    const old = process.env.LIFEMODEL_STEER_SOCKET;
    process.env.LIFEMODEL_STEER_SOCKET = join(dir, 'tmp/steer.sock');
    // Import the shipped source, not a copy of the bridge in the test.
    const plugin = (await import('../../docker/workbench/steering-plugin/index.mjs')).default;
    const prompt = vi.fn(async (value: { id: string }) => ({ id: value.id }));
    const close = await plugin.setup({ session: { prompt }, event: { async *subscribe() {} } });
    try {
      const command = {
        workDirectory: dir,
        sessionId: 'native-session',
        commandId: 'stable',
        text: 'steer',
      };
      expect(await admit(command)).toBe('accepted');
      expect(await admit(command)).toBe('accepted');
      expect(prompt).toHaveBeenCalledTimes(2);
      const first = prompt.mock.calls[0]![0];
      expect(first).toMatchObject({
        sessionID: 'native-session',
        text: 'steer',
        delivery: 'steer',
        resume: false,
      });
      expect(prompt.mock.calls[1]![0]).toEqual(first);
    } finally {
      await close();
      if (old === undefined) delete process.env.LIFEMODEL_STEER_SOCKET;
      else process.env.LIFEMODEL_STEER_SOCKET = old;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
