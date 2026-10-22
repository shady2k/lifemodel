/**
 * The per-file record of the Postgres databases a test file created
 * (lifemodel-653.7.10).
 *
 * The worker process writes the record as it creates a database and removes it
 * when its own afterAll hook has reclaimed them. The main process reads it when
 * the module ends (`tests/setup/test-store-finalizer.ts`): an entry still there
 * means the file's teardown never ran - it threw or timed out, and Vitest drops
 * the remaining afterAll hooks of that file. A skipped hook cannot free the
 * volume on its own.
 *
 * The directory lives in the container's memory-backed `/tmp`, which every run
 * gets fresh; nothing outside a run reads it.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TestDatabaseRecord {
  /** Absolute path of the test file that created the databases. */
  file: string;
  databases: string[];
}

export function testDatabaseRegistryDirectory(): string {
  return join(tmpdir(), 'lifemodel-test-databases');
}

function recordPath(file: string): string {
  const key = createHash('sha256').update(file).digest('hex').slice(0, 16);
  return join(testDatabaseRegistryDirectory(), `${key}.json`);
}

function readRecord(file: string): TestDatabaseRecord | undefined {
  let text: string;
  try {
    text = readFileSync(recordPath(file), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = JSON.parse(text) as TestDatabaseRecord;
  if (typeof parsed.file !== 'string' || !Array.isArray(parsed.databases)) {
    throw new Error('Test database record is malformed');
  }
  return parsed;
}

function writeRecord(record: TestDatabaseRecord): void {
  mkdirSync(testDatabaseRegistryDirectory(), { recursive: true });
  const target = recordPath(record.file);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  renameSync(temporary, target);
}

/** Adds a database this file created, so a teardown that never runs still leaves a record. */
export function recordTestDatabase(file: string, database: string): void {
  const record = readRecord(file) ?? { file, databases: [] };
  if (record.databases.includes(database)) return;
  writeRecord({ file, databases: [...record.databases, database] });
}

/** The databases this file created and has not reclaimed yet. */
export function pendingTestDatabases(file: string): TestDatabaseRecord | undefined {
  return readRecord(file);
}

export function forgetTestDatabases(file: string): void {
  rmSync(recordPath(file), { force: true });
}

let currentFile: string | undefined;

/** The file the setup hook recorded; the helper keys its records by it. */
export function setCurrentTestFile(file: string): void {
  currentFile = file;
}

export function currentTestFile(): string {
  if (!currentFile)
    throw new Error(
      'The current test file is unknown; create test stores inside a test or a hook, never at module scope'
    );
  return currentFile;
}

export function knownTestFile(): string | undefined {
  return currentFile;
}
