import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

export type SteeringDisposition = 'accepted' | 'rejected' | 'uncertain';
export interface SteeringCommand {
  commandId: string;
  text: string;
}

// A slot contains the two SHA-256 identities and one independently synced state byte.
// State zero is unused; 1 is pre-send, 2/3/4 are final dispositions.
const HEADER = Buffer.from('LMSTEER1');
const SLOT_SIZE = 65;
const STATE: Record<SteeringDisposition, number> = { accepted: 2, rejected: 3, uncertain: 4 };
const FINAL: Record<number, SteeringDisposition> = { 1: 'uncertain', 2: 'accepted', 3: 'rejected', 4: 'uncertain' };

interface Entry {
  textHash: string;
  offset: number;
  disposition: SteeringDisposition;
  flight?: Promise<SteeringDisposition>;
}

/**
 * Launcher-private journal. One launcher process must exclusively own the file.
 * The caller must treat missing/corrupt journals for an existing task as task
 * failure; opening a fresh journal is only safe for a newly created task.
 */
export class TaskSteeringJournal {
  private readonly entries = new Map<string, Entry>();
  private nextSlot = 0;
  private serial: Promise<void> = Promise.resolve();
  private failed = false;
  private closed = false;

  private constructor(private readonly file: FileHandle, private readonly capacity: number) {}

  /** Set create only when this is a new task; false never recreates a lost journal. */
  static async open(path: string, options: { capacity: number; create: boolean }): Promise<TaskSteeringJournal> {
    const { capacity, create } = options;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000) throw new Error('Invalid steering journal capacity');
    const size = HEADER.length + capacity * SLOT_SIZE;
    const file = await open(path, create ? 'wx+' : 'r+', 0o600);
    try {
      if (create) {
        // Write every byte, rather than truncate, to reserve backing space before admission.
        const chunk = Buffer.alloc(Math.min(size, 65536));
        for (let offset = 0; offset < size; offset += chunk.length) {
          await writeAll(file, chunk.subarray(0, Math.min(chunk.length, size - offset)), offset);
        }
        await writeAll(file, HEADER, 0);
        await file.sync();
        const dir = await open(dirname(path), 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      }
      const stat = await file.stat();
      if (stat.size !== size) throw new Error('Invalid steering journal size');
      const data = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const result = await file.read(data, read, size - read, read);
        if (!result.bytesRead) throw new Error('Short steering journal read');
        read += result.bytesRead;
      }
      if (!data.subarray(0, HEADER.length).equals(HEADER)) throw new Error('Invalid steering journal header');
      const journal = new TaskSteeringJournal(file, capacity);
      let unused = false;
      for (let i = 0; i < capacity; i++) {
        const offset = HEADER.length + i * SLOT_SIZE;
        const state = data[offset];
        if (state === 0) { unused = true; continue; }
        const disposition = state === undefined ? undefined : FINAL[state];
        if (unused || disposition === undefined) throw new Error('Corrupt steering journal');
        const idHash = data.subarray(offset + 1, offset + 33).toString('hex');
        const textHash = data.subarray(offset + 33, offset + 65).toString('hex');
        if (journal.entries.has(idHash)) throw new Error('Duplicate steering journal identity');
        journal.entries.set(idHash, { textHash, offset, disposition });
        journal.nextSlot++;
      }
      return journal;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  /** Same ID and text joins an in-flight call or returns its recorded outcome. */
  async admit(command: SteeringCommand, send: () => Promise<SteeringDisposition>): Promise<SteeringDisposition> {
    const idHash = hash(command.commandId);
    const textHash = hash(command.text);
    // The lock protects journal state but not the native call: unrelated commands can proceed.
    const result = await this.lock(async () => {
      if (this.failed || this.closed) return { result: Promise.resolve<SteeringDisposition>('uncertain') };
      const existing = this.entries.get(idHash);
      if (existing) {
        if (existing.textHash !== textHash) return { result: Promise.resolve<SteeringDisposition>('rejected') };
        return { result: existing.flight ?? Promise.resolve(existing.disposition) };
      }
      if (this.nextSlot === this.capacity) return { result: Promise.resolve<SteeringDisposition>('rejected') };
      const offset = HEADER.length + this.nextSlot * SLOT_SIZE;
      try {
        // A zero state cannot have been sent. Sync identities before publishing pre-send.
        await writeAll(this.file, Buffer.concat([Buffer.from(idHash, 'hex'), Buffer.from(textHash, 'hex')]), offset + 1);
        await this.file.sync();
        await writeAll(this.file, Buffer.from([1]), offset);
        await this.file.sync();
      } catch {
        this.failed = true;
        return { result: Promise.resolve<SteeringDisposition>('uncertain') };
      }
      this.nextSlot++;
      const entry: Entry = { textHash, offset, disposition: 'uncertain' };
      this.entries.set(idHash, entry);
      entry.flight = this.sendAndRecord(entry, send);
      return { result: entry.flight };
    });
    return result.result;
  }

  private async sendAndRecord(entry: Entry, send: () => Promise<SteeringDisposition>): Promise<SteeringDisposition> {
    let disposition: SteeringDisposition;
    try {
      const value = await send();
      disposition = value === 'accepted' || value === 'rejected' ? value : 'uncertain';
    } catch {
      disposition = 'uncertain';
    }
    return this.lock(async () => {
      if (this.failed) return 'uncertain';
      try {
        await writeAll(this.file, Buffer.from([STATE[disposition]]), entry.offset);
        await this.file.sync();
        entry.disposition = disposition;
      } catch {
        this.failed = true;
        entry.disposition = 'uncertain';
      }
      delete entry.flight;
      return entry.disposition;
    });
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Stop new admissions and wait for all already admitted native calls. */
  async close(): Promise<void> {
    const flights = await this.lock(() => {
      this.closed = true;
      return Promise.resolve([...this.entries.values()].flatMap((entry) => entry.flight ? [entry.flight] : []));
    });
    await Promise.all(flights);
    await this.file.close();
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function writeAll(file: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < buffer.length) {
    const result = await file.write(buffer, written, buffer.length - written, position + written);
    if (!result.bytesWritten) throw new Error('Short steering journal write');
    written += result.bytesWritten;
  }
}
