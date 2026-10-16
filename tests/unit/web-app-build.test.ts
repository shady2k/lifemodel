import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
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
  it('emits a kit-only utility when the kit is scanned, and drops it without @source', async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), 'lifemodel-kit-tailwind-'));
    try {
      const app = path.join(fixture, 'app');
      const packageRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
      await symlink(
        path.join(packageRoot, 'node_modules'),
        path.join(fixture, 'node_modules'),
        'dir'
      );
      await mkdir(app, { recursive: true });
      await writeFile(
        path.join(app, 'index.html'),
        '<div></div><script type="module" src="/main.ts"></script>'
      );
      await writeFile(path.join(app, 'main.ts'), "import './index.css';");
      const source = path.join(fixture, 'kit-component.ts');
      await writeFile(source, "export const className = 'outline-offset-13';");
      const withoutKitCss = "@import 'tailwindcss' source(none);\n.known-rule { color: red; }\n";
      await writeFile(
        path.join(app, 'index.css'),
        `@import 'tailwindcss' source(none);\n@source '${source}';\n.known-rule { color: red; }\n`
      );
      const withOutDir = path.join(fixture, 'with-kit');
      await build({
        configFile: false,
        root: app,
        plugins: [react(), tailwindcss()],
        cacheDir: path.join(fixture, 'cache-with'),
        build: { outDir: withOutDir, emptyOutDir: true },
      });
      expect(existsSync(withOutDir)).toBe(true);
      const withAssets = await readdir(path.join(withOutDir, 'assets'));
      const withCss = withAssets.find((file) => file.endsWith('.css'));
      expect(withCss).toBeDefined();
      const emittedWithKit = await readFile(path.join(withOutDir, 'assets', withCss!), 'utf8');
      expect(emittedWithKit).toContain('outline-offset-13');
      expect(emittedWithKit).toContain('.known-rule');

      await writeFile(path.join(app, 'index.css'), withoutKitCss);
      const withoutOutDir = path.join(fixture, 'without-kit');
      expect(withoutOutDir).not.toBe(withOutDir);
      await build({
        configFile: false,
        root: app,
        plugins: [react(), tailwindcss()],
        cacheDir: path.join(fixture, 'cache-without'),
        build: { outDir: withoutOutDir, emptyOutDir: true },
      });
      expect(existsSync(withoutOutDir)).toBe(true);
      const withoutAssets = await readdir(path.join(withoutOutDir, 'assets'));
      const withoutCss = withoutAssets.find((file) => file.endsWith('.css'));
      expect(withoutCss).toBeDefined();
      const emittedWithoutKit = await readFile(
        path.join(withoutOutDir, 'assets', withoutCss!),
        'utf8'
      );
      expect(emittedWithoutKit).toContain('.known-rule');
      expect(emittedWithoutKit).not.toContain('outline-offset-13');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  }, 60_000);

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
      [
        'src/Conversation.tsx',
        '../kit/components/ui/code-block.tsx',
        '../kit/lib/highlighter.tsx',
      ].map((file) => readFile(path.join(appRoot, file), 'utf8'))
    );
    expect(sources.join('\n')).not.toContain('dangerouslySetInnerHTML');
  });
});
