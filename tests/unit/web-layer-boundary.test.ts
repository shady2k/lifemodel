import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/web');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : extname(path) === '.ts' ? [path] : [];
  });
}

describe('web module layer boundary', () => {
  it('imports only ports and storage outside its own module', () => {
    const disallowed = sourceFiles(root).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const imports = [...source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)];
      return imports.flatMap((match) => {
        const specifier = match[1]!;
        if (!specifier.startsWith('.')) return [];
        const target = resolve(dirname(file), specifier);
        const srcPath = relative(resolve(root, '../'), target).replaceAll('\\', '/');
        return srcPath.startsWith('web/') ||
          srcPath.startsWith('ports/') ||
          srcPath.startsWith('storage/')
          ? []
          : [`${relative(root, file)} -> ${specifier}`];
      });
    });
    expect(disallowed).toEqual([]);
  });
});
