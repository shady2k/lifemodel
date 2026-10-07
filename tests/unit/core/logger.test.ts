/**
 * The logging switch a test needs (lifemodel-ctc.2.1, review round 7).
 *
 * A pino target runs in a WORKER THREAD, which cannot be fenced or awaited: a
 * file target kept appending to its log while a test removed the directory
 * around it (ENOTEMPTY on the rmdir). A test that starts the real container
 * therefore turns the log FILE off (createContainerAsync's `logToFile`), and
 * this file pins what that switch promises: no file, no log directory, and no
 * writer aimed at a directory the test is about to remove.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createConversationLogger, createLogger } from '../../../src/core/logger.js';

const scratch: string[] = [];

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of scratch.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('logger file switch (lifemodel-ctc.2.1)', () => {
  it('file: false creates no log directory and writes no file', async () => {
    const root = await scratchDir('logger-nofile-');
    const logDir = join(root, 'logs');
    const logger = createLogger({ logDir, file: false, pretty: false, level: 'info' });

    logger.info('a line with no file to go to');

    // The directory would be created SYNCHRONOUSLY by the file target (and a
    // broken switch is caught here, not by a race with a worker thread).
    expect(existsSync(logDir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it('the file target stays on by default: it creates its directory', async () => {
    const root = await scratchDir('logger-file-');
    const logDir = join(root, 'logs');

    // No line is logged, so the worker thread has nothing to write: only the
    // directory the file target prepares can be observed here.
    createLogger({ logDir, pretty: false, level: 'info' });

    expect(existsSync(logDir)).toBe(true);
    expect(readdirSync(logDir)).toEqual([]);
  });

  it('file: false turns the conversation log off too', async () => {
    const root = await scratchDir('logger-noconv-');
    const logDir = join(root, 'logs');
    const logger = createConversationLogger(logDir, 'info', { file: false });

    logger.info('an exchange nobody writes down');

    expect(existsSync(logDir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});
