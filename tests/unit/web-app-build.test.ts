import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { afterEach, expect, it } from 'vitest';

let outputDirectory: string | undefined;
afterEach(async () => {
  if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  outputDirectory = undefined;
});

it('builds the React app with same-origin scripts and styles', async () => {
  outputDirectory = await mkdtemp(path.join(tmpdir(), 'lifemodel-web-app-'));
  await build({
    configFile: 'web/app/vite.config.ts',
    build: { outDir: outputDirectory, emptyOutDir: true },
  });
  const html = await readFile(path.join(outputDirectory, 'index.html'), 'utf8');
  expect(html).toMatch(/src="\/assets\/index-[^"]+\.js"/);
  expect(html).toMatch(/href="\/assets\/index-[^"]+\.css"/);
  expect(html).not.toMatch(/(?:src|href)="https?:\/\//);
});
