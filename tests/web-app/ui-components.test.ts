import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const app = new URL('../../web/app/', import.meta.url);

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
  it('keeps all generated files identical to the pinned CLI add output, with no unlisted kit files', async () => {
    const root = new URL('registry-lock/files/', app);
    const manifest = JSON.parse(
      await readFile(new URL('registry-lock/manifest.json', app), 'utf8')
    ) as {
      cli: string;
      files: Array<{ path: string; sha256: string }>;
    };
    expect(manifest.cli).toBe('shadcn@4.21.5');
    const locked = (await listFiles(root)).sort();
    expect(locked).toEqual(manifest.files.map((file) => file.path).sort());
    for (const directory of ['src/components/ui/', 'src/hooks/', 'src/lib/']) {
      const actualRoot = new URL(directory, app);
      const actual = (await listFiles(actualRoot))
        .map((file) => `${directory.slice(4)}${file}`)
        .sort();
      const expected = locked.filter((file) => file.startsWith(directory.slice(4)));
      expect(actual).toEqual(expected);
    }
    for (const file of manifest.files) {
      const content = await readFile(new URL(file.path, root), 'utf8');
      expect(await readFile(new URL(`src/${file.path}`, app), 'utf8'), file.path).toBe(content);
      expect(createHash('sha256').update(content).digest('hex'), file.path).toBe(
        manifest.files.find((entry) => entry.path === file.path)?.sha256
      );
    }
  });
});
