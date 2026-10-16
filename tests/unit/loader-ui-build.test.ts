import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const outputs: string[] = [];
afterEach(() => {
  for (const output of outputs.splice(0)) rmSync(output, { recursive: true, force: true });
});
describe('loader UI production build', () => {
  it(
    'builds a static, kit-backed app for the independent loader image',
    { timeout: 60_000 },
    () => {
      const output = mkdtempSync(join(tmpdir(), 'loader-ui-build-'));
      outputs.push(output);
      execFileSync(
        process.execPath,
        [
          resolve('node_modules/vite/bin/vite.js'),
          'build',
          '--config',
          'web/loader/vite.config.ts',
          '--outDir',
          output,
          '--emptyOutDir',
        ],
        { cwd: process.cwd(), stdio: 'pipe', timeout: 50_000 }
      );
      expect(readFileSync(join(output, 'index.html'), 'utf8')).toContain('/assets/');
      const assets = readdirSync(join(output, 'assets'));
      expect(assets.some((name) => name.endsWith('.js'))).toBe(true);
      expect(assets.some((name) => name.endsWith('.css'))).toBe(true);
    }
  );
});
