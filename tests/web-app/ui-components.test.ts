import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const kit = new URL('../../web/kit/', import.meta.url);

async function listFiles(directory: URL): Promise<string[]> {
  const entries = await readdir(fileURLToPath(directory), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory())
      files.push(...(await listFiles(child)).map((file) => `${entry.name}/${file}`));
    else files.push(entry.name);
  }
  return files;
}

describe('shadcn registry provenance', () => {
  it('keeps kit sources out of app/src and rejects stray app UI copies', async () => {
    const appSrc = new URL('../../web/app/src/', import.meta.url);
    const appCss = await readFile(new URL('index.css', appSrc), 'utf8');
    expect(appCss).toContain("@source '../../kit/**/*.{ts,tsx}'");
    const ui = new URL('components/ui/', appSrc);
    let uiFiles: string[] = [];
    try {
      uiFiles = await listFiles(ui);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    expect(uiFiles).toEqual([]);
    const appFiles = await listFiles(appSrc);
    const locked = (
      JSON.parse(await readFile(new URL('registry-lock/manifest.json', kit), 'utf8')) as {
        files: Array<{ path: string }>;
      }
    ).files.map((entry) => entry.path);
    for (const file of appFiles) expect(locked).not.toContain(file);
  });

  it('filters forbidden nested files from every image source subtree', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const context = await mkdtemp(path.join(tmpdir(), 'lifemodel-web-context-test-'));
    await rm(context, { recursive: true, force: true });
    for (const subtree of ['web/kit', 'web/app']) {
      for (const forbidden of ['.env.review-sentinel', '.git/config', 'node_modules/sentinel']) {
        const target = path.join(root, subtree, 'src', forbidden);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, 'sentinel');
      }
    }
    try {
      execFileSync('sh', [path.join(root, 'scripts/prepare-web-image-context.sh'), context], {
        cwd: root,
      });
      for (const subtree of ['web/kit', 'web/app']) {
        const files = await listFiles(new URL(`${subtree}/`, `file://${context}/`));
        expect(
          files.some((file) => /(^|\/)\.env|(^|\/)\.git\/|(^|\/)node_modules\//.test(file))
        ).toBe(false);
      }
      expect(await readFile(path.join(context, 'web/kit/theme.css'), 'utf8')).toContain('@theme');
    } finally {
      await rm(context, { recursive: true, force: true });
      for (const subtree of ['web/kit', 'web/app']) {
        await rm(path.join(root, subtree, 'src', '.env.review-sentinel'), { force: true });
        await rm(path.join(root, subtree, 'src', '.git'), { recursive: true, force: true });
        await rm(path.join(root, subtree, 'src', 'node_modules'), { recursive: true, force: true });
      }
    }
  });

  it('keeps all generated files identical to the pinned CLI add output, with no unlisted kit files', async () => {
    const root = new URL('registry-lock/files/', kit);
    const manifest = JSON.parse(
      await readFile(new URL('registry-lock/manifest.json', kit), 'utf8')
    ) as {
      cli: string;
      files: Array<{ path: string; sha256: string }>;
    };
    expect(manifest.cli).toBe('shadcn@4.21.5');
    const locked = (await listFiles(root)).sort();
    expect(locked).toEqual(manifest.files.map((file) => file.path).sort());
    for (const directory of ['components/ui/', 'hooks/', 'lib/']) {
      const actualRoot = new URL(directory, kit);
      const actual = (await listFiles(actualRoot)).map((file) => `${directory}${file}`).sort();
      const expected = locked.filter((file) => file.startsWith(directory));
      expect(actual).toEqual(expected);
    }
    for (const file of manifest.files) {
      const content = await readFile(new URL(file.path, root), 'utf8');
      expect(await readFile(new URL(file.path, kit), 'utf8'), file.path).toBe(content);
      expect(createHash('sha256').update(content).digest('hex'), file.path).toBe(
        manifest.files.find((entry) => entry.path === file.path)?.sha256
      );
    }
  });
});
