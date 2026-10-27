import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskSteeringJournal } from '../../loader/src/task-steering-journal.js';

const directories: string[] = [];
async function path(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'steering-journal-'));
  directories.push(dir);
  return join(dir, 'journal');
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('task steering journal', () => {
  it.each(['intent', 'disposition'] as const)(
    'fails closed when the %s sync fails',
    async (boundary) => {
      const file = await path();
      const journal = await TaskSteeringJournal.open(file, { capacity: 2, create: true });
      const handle = (journal as unknown as { file: import('node:fs/promises').FileHandle }).file;
      const sync = vi.spyOn(handle, 'sync');
      const command = { commandId: 'disk-failure', text: 'continue' };
      const send = vi.fn(async () => {
        sync.mockRejectedValueOnce(new Error('disk full after send'));
        return 'accepted' as const;
      });
      if (boundary === 'intent') sync.mockRejectedValueOnce(new Error('disk full before send'));
      expect(await journal.admit(command, send)).toBe('uncertain');
      expect(journal.hasFailed()).toBe(true);
      expect(send).toHaveBeenCalledTimes(boundary === 'intent' ? 0 : 1);
      expect(await journal.admit(command, send)).toBe('uncertain');
      expect(await journal.admit({ commandId: 'new', text: 'new' }, send)).toBe('uncertain');
      await journal.close();
      if (boundary === 'disposition') {
        const recovered = await TaskSteeringJournal.open(file, { capacity: 2, create: false });
        expect(await recovered.admit(command, send)).toBe('uncertain');
        expect(send).toHaveBeenCalledTimes(1);
        await recovered.close();
      }
    }
  );

  it('does not ACK before disposition sync, and close waits for admitted calls', async () => {
    const file = await path();
    const journal = await TaskSteeringJournal.open(file, { capacity: 2, create: true });
    const handle = (journal as unknown as { file: import('node:fs/promises').FileHandle }).file;
    const originalSync = handle.sync.bind(handle);
    let finishSync!: () => void;
    let syncing!: () => void;
    const atSync = new Promise<void>((resolve) => {
      syncing = resolve;
    });
    const send = vi.fn(async () => {
      vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
        syncing();
        await new Promise<void>((resolve) => {
          finishSync = resolve;
        });
        await originalSync();
      });
      return 'accepted' as const;
    });
    let acked = false;
    const first = journal.admit({ commandId: 'a', text: 'a' }, send).then((value) => {
      acked = true;
      return value;
    });
    await atSync;
    expect(acked).toBe(false);
    let closed = false;
    const closing = journal.close().then(() => {
      closed = true;
    });
    expect(closed).toBe(false);
    finishSync();
    expect(await first).toBe('accepted');
    await closing;
    expect(await journal.admit({ commandId: 'b', text: 'b' }, send)).toBe('uncertain');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('joins an in-flight duplicate, rejects conflicting text, and persists the result', async () => {
    const file = await path();
    let journal = await TaskSteeringJournal.open(file, { capacity: 2, create: true });
    let resolveSend!: (value: 'accepted') => void;
    let started!: () => void;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const send = vi.fn(() => {
      started();
      return new Promise<'accepted'>((resolve) => {
        resolveSend = resolve;
      });
    });
    const command = { commandId: 'one', text: 'continue' };
    const first = journal.admit(command, send);
    await sending;
    const duplicate = journal.admit(command, send);
    expect(await journal.admit({ ...command, text: 'different' }, send)).toBe('rejected');
    expect(send).toHaveBeenCalledTimes(1);
    resolveSend('accepted');
    expect(await Promise.all([first, duplicate])).toEqual(['accepted', 'accepted']);
    await journal.close();
    journal = await TaskSteeringJournal.open(file, { capacity: 2, create: false });
    expect(await journal.admit(command, send)).toBe('accepted');
    expect(send).toHaveBeenCalledTimes(1);
    await journal.close();
  });

  it('records pre-send before calling the adapter and recovers it as uncertain', async () => {
    const file = await path();
    const journal = await TaskSteeringJournal.open(file, { capacity: 1, create: true });
    const command = { commandId: 'private-id', text: 'private-text' };
    const send = vi.fn(async () => {
      const snapshot = await readFile(file);
      expect(snapshot[8]).toBe(1);
      expect(snapshot.includes(Buffer.from(command.commandId))).toBe(false);
      expect(snapshot.includes(Buffer.from(command.text))).toBe(false);
      // Save the on-disk pre-send state to model a process crash at this boundary.
      await writeFile(file + '.crash', snapshot);
      throw new Error('connection lost after send');
    });
    expect(await journal.admit(command, send)).toBe('uncertain');
    await journal.close();
    const recovered = await TaskSteeringJournal.open(file + '.crash', {
      capacity: 1,
      create: false,
    });
    expect(await recovered.admit(command, send)).toBe('uncertain');
    expect(send).toHaveBeenCalledTimes(1);
    await recovered.close();
  });

  it('fails closed on missing or corrupt state and rejects capacity overflow without sending', async () => {
    const file = await path();
    await expect(TaskSteeringJournal.open(file, { capacity: 1, create: false })).rejects.toThrow();
    const journal = await TaskSteeringJournal.open(file, { capacity: 1, create: true });
    const send = vi.fn(async () => 'rejected' as const);
    expect(await journal.admit({ commandId: 'a', text: 'a' }, send)).toBe('rejected');
    expect(await journal.admit({ commandId: 'b', text: 'b' }, send)).toBe('rejected');
    expect(send).toHaveBeenCalledTimes(1);
    await journal.close();
    const data = await readFile(file);
    data[8] = 255;
    await writeFile(file, data);
    await expect(TaskSteeringJournal.open(file, { capacity: 1, create: false })).rejects.toThrow();
  });
});
