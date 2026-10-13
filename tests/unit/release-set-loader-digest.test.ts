import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const script = join(repoRoot, 'scripts/release/set-loader-digest.sh');
let tempDir: string;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function fixture(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'lifemodel-release-digest-'));
  const path = join(tempDir, 'kustomization.yaml');
  writeFileSync(path, `images:\n  - name: ghcr.io/shady2k/lifemodel-loader\n    newName: ghcr.io/shady2k/lifemodel-loader\n    digest: sha256:${'0'.repeat(64)}\n`);
  return path;
}

describe('set-loader-digest release helper', () => {
  it('replaces the loader placeholder with the supplied immutable digest', () => {
    const path = fixture();
    const digest = `sha256:${'a'.repeat(64)}`;
    const result = spawnSync('bash', [script, digest, path], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(readFileSync(path, 'utf8')).toContain(`digest: ${digest}`);
    expect(readFileSync(path, 'utf8')).not.toContain('0'.repeat(64));
  });

  it('refuses a value that is not a SHA-256 digest without changing the file', () => {
    const path = fixture();
    const before = readFileSync(path, 'utf8');
    const result = spawnSync('bash', [script, 'sha256:not-a-digest', path], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
