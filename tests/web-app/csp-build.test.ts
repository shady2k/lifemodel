import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const appRoot = fileURLToPath(new URL('../../web/app/', import.meta.url));
const dist = new URL('../../web/app/dist/', import.meta.url);

describe('production web output and restrictive CSP compatibility', () => {
  it('emits same-origin fonts and no inline document code or unsafe Shiki HTML', async () => {
    await build({ configFile: `${appRoot}/vite.config.ts` });
    const html = await readFile(new URL('index.html', dist), 'utf8');
    expect(html).not.toMatch(/<style\b|<script\b(?![^>]*\bsrc=)/i);
    const files = await readdir(new URL('assets/', dist));
    const css = await Promise.all(
      files
        .filter((file) => file.endsWith('.css'))
        .map((file) => readFile(new URL(`assets/${file}`, dist), 'utf8'))
    );
    const styles = css.join('\n');
    expect(styles).not.toMatch(/url\(["']?data:font\//i);
    expect(files.some((file) => file.endsWith('.woff2'))).toBe(true);
    const sources = await Promise.all(
      ['src/Conversation.tsx', 'src/components/ui/code-block.tsx', 'src/lib/highlighter.tsx'].map(
        (file) => readFile(new URL(file, new URL('../../web/app/', import.meta.url)), 'utf8')
      )
    );
    expect(sources.join('\n')).not.toContain('dangerouslySetInnerHTML');
  });
});
