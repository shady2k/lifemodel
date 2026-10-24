import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(root, entry.name)) : [join(root, entry.name)]
  );
}
it('keeps the shipped external source in one default, never in loader or core consumers', () => {
  const hits = [...files('loader/src'), ...files('src')]
    .filter((path) => path.endsWith('.ts'))
    .flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.includes('ghcr.io'))
        .map(() => path)
    );
  expect(hits).toEqual(['loader/src/workbench-source.ts']);
});
