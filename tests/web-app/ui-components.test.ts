import { readdir, readFile } from 'node:fs/promises';
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
