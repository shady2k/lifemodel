import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const app = new URL('../../web/app/', import.meta.url);

describe('shadcn generated component inventory', () => {
  it('allows only files declared in the generated component inventory', async () => {
    const inventory = JSON.parse(
      await readFile(new URL('components.generated.json', app), 'utf8')
    ) as { components: string[] };
    const uiDirectory = new URL('src/components/ui/', app);
    const files = await readdir(fileURLToPath(uiDirectory));
    expect(files.sort()).toEqual([...inventory.components].sort());
  });
});
