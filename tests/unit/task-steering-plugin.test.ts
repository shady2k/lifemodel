import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { admit, nativeMessageId } from '../../loader/src/task-opencode.js';

describe('baked OpenCode steering plugin', () => {
  it('uses stable native IDs, delivery steer and resume false, without waiting for a tool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-steer-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, '.launcher'));
    const old = process.env.LIFEMODEL_STEER_SOCKET;
    process.env.LIFEMODEL_STEER_SOCKET = join(dir, '.launcher/steer.sock');
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
      const { connect } = await import('node:net');
      const unicode = 'Привет 🧭';
      const frame = Buffer.from(
        JSON.stringify({ op: 'steer', sessionID: 'native-session', id: 'unicode', text: unicode }) +
          '\n'
      );
      const split = frame.indexOf(Buffer.from('🧭')) + 1;
      await new Promise<void>((resolve, reject) => {
        const socket = connect(join(dir, '.launcher/steer.sock'));
        socket.on('error', reject);
        socket.on('connect', () => {
          socket.write(frame.subarray(0, split));
          // Yield one I/O turn to force an incremental decoder boundary.
          setTimeout(() => socket.end(frame.subarray(split)), 10);
        });
        socket.resume();
        socket.on('close', () => resolve());
      });
      expect(prompt.mock.calls[2]![0]).toMatchObject({ text: unicode, resume: false });
    } finally {
      await close();
      if (old === undefined) delete process.env.LIFEMODEL_STEER_SOCKET;
      else process.env.LIFEMODEL_STEER_SOCKET = old;
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('reports pending until a delivered event, not a compaction or unrelated inbox event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'plugin-evidence-'));
    const {mkdir} = await import('node:fs/promises');
    await mkdir(join(dir, '.launcher'));
    const path = join(dir, '.launcher/steer.sock');
    const old = process.env.LIFEMODEL_STEER_SOCKET;
    process.env.LIFEMODEL_STEER_SOCKET = path;
    let push!: (event: unknown) => void;
    const plugin = (await import('../../docker/workbench/steering-plugin/index.mjs')).default;
    const close = await plugin.setup({
      session: {prompt: async ({id}: {id: string}) => ({id})},
      event: {async *subscribe() { while (true) yield await new Promise(resolve => {push = resolve;}); }},
    });
    const {connect} = await import('node:net');
    const read = () => new Promise<{data: {status: string}}>((resolve, reject) => {
      const socket = connect(path); let buffer = '';
      socket.on('error', reject);
      socket.on('connect', () => socket.write(JSON.stringify({op: 'disposition', id: nativeMessageId('cmd')}) + '\n'));
      socket.on('data', chunk => {buffer += chunk.toString(); if (buffer.includes('\n')) {resolve(JSON.parse(buffer)); socket.destroy();}});
    });
    try {
      expect(await admit({workDirectory: dir, sessionId: 's', commandId: 'cmd', text: 'continue'})).toBe('accepted');
      // Native admission ACK proves pending even before the event reader catches up.
      expect((await read()).data.status).toBe('pending');
      push({type: 'session.inbox.enqueued', data: {inboxID: nativeMessageId('cmd')}});
      await vi.waitFor(async () => expect((await read()).data.status).toBe('pending'));
      push({type: 'session.compacted', data: {inboxID: nativeMessageId('cmd')}});
      expect((await read()).data.status).toBe('pending');
      push({type: 'session.inbox.delivered', data: {inboxID: 'other'}});
      expect((await read()).data.status).toBe('pending');
      push({type: 'session.inbox.delivered', data: {inboxID: nativeMessageId('cmd')}});
      await vi.waitFor(async () => expect((await read()).data.status).toBe('inserted'));
    } finally {
      await close();
      push({type: 'stop'});
      if (old === undefined) delete process.env.LIFEMODEL_STEER_SOCKET;
      else process.env.LIFEMODEL_STEER_SOCKET = old;
      await rm(dir, {recursive: true, force: true});
    }
  });

});
