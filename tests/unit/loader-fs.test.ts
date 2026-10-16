import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem } from '../../loader/src/fs.js';
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
describe('loader durable file publication', () => {
  it('atomically publishes mode-restricted files and exclusive auth files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'loader-fs-'));
    roots.push(root);
    const fs = createNodeFileSystem();
    const path = join(root, 'state/auth.json');
    await fs.writeFileAtomic(path, 'first', 0o600);
    await expect(fs.writeFileExclusive(path, 'second', 0o600)).rejects.toThrow();
    expect(readFileSync(path, 'utf8')).toBe('first');
    expect(readdirSync(join(root, 'state'))).toEqual(['auth.json']);
  });
});
