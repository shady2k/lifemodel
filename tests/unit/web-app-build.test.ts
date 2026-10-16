import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const appRoot = fileURLToPath(new URL('../../web/app/', import.meta.url));
let outputDirectory: string | undefined;
beforeAll(async () => {
  outputDirectory = await mkdtemp(path.join(tmpdir(), 'lifemodel-web-app-'));
  await build({
    configFile: path.join(appRoot, 'vite.config.ts'),
    build: { outDir: outputDirectory, emptyOutDir: true },
  });
}, 60_000);

afterAll(async () => {
  if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
});

describe('production web app output', () => {
  it('uses same-origin scripts and styles', async () => {
    const html = await readFile(path.join(outputDirectory!, 'index.html'), 'utf8');
    expect(html).toMatch(/src="\/assets\/index-[^"]+\.js"/);
    expect(html).toMatch(/href="\/assets\/index-[^"]+\.css"/);
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//);
  });

  it('emits same-origin fonts and no inline document code or unsafe Shiki HTML', async () => {
    const html = await readFile(path.join(outputDirectory!, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<style\b|<script\b(?![^>]*\bsrc=)/i);
    const files = await readdir(path.join(outputDirectory!, 'assets'));
    const css = await Promise.all(
      files
        .filter((file) => file.endsWith('.css'))
        .map((file) => readFile(path.join(outputDirectory!, 'assets', file), 'utf8'))
    );
    expect(css.join('\n')).not.toMatch(/url\(["']?data:font\//i);
    expect(files.some((file) => file.endsWith('.woff2'))).toBe(true);
    const sources = await Promise.all(
      ['src/Conversation.tsx', 'src/components/ui/code-block.tsx', 'src/lib/highlighter.tsx'].map(
        (file) => readFile(path.join(appRoot, file), 'utf8')
      )
    );
    expect(sources.join('\n')).not.toContain('dangerouslySetInnerHTML');
  });
});
