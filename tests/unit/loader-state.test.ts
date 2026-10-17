import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '../../loader/src/fs.js';
import { loadConfig } from '../../loader/src/config.js';
import { createLoaderState } from '../../loader/src/state.js';
import { createRecordingLogger } from '../../loader/src/logger.js';
import { hashPassword, verifyPassword } from '../../loader/src/auth.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('durable loader first writer', () => {
  it('allows only one of independent state writers to publish auth in a shared real directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-state-'));
    roots.push(root);
    const fs = createNodeFileSystem();
    const config = {
      ...loadConfig({ LIFEMODEL_VOLUME_ROOT: root, LIFEMODEL_NAME: 'lifemodel' }),
      loaderDir: join(root, 'loader'),
    };
    const logger = createRecordingLogger([]);
    const a = createLoaderState({ fs, config, logger });
    const b = createLoaderState({ fs, config, logger });
    await Promise.all([a.ensureLayout(), b.ensureLayout()]);
    const passwords = ['winner alpha secure', 'winner beta secure'];
    const records = await Promise.all(passwords.map(hashPassword));
    const outcomes = await Promise.allSettled([a.writeAuth(records[0]!), b.writeAuth(records[1]!)]);
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((x) => x.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    const reopened = createLoaderState({ fs, config, logger });
    const persisted = await reopened.readAuth();
    expect(persisted).not.toBeNull();
    const matches = await Promise.all(
      records.map((record) => verifyPassword(passwords[records.indexOf(record)]!, persisted!))
    );
    expect(matches.filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, 'loader', 'auth.json'), 'utf8'))).toHaveProperty(
      'hash'
    );
  });
});
