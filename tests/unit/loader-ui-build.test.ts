import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import dockerignore from '@balena/dockerignore';
const outputs: string[] = [];
afterEach(() => {
  for (const output of outputs.splice(0)) rmSync(output, { recursive: true, force: true });
});
describe('loader UI production build', () => {
  it(
    'builds a static, kit-backed app for the independent loader image',
    { timeout: 60_000 },
    () => {
      const output = mkdtempSync(join(tmpdir(), 'loader-ui-build-'));
      outputs.push(output);
      execFileSync(
        process.execPath,
        [
          resolve('node_modules/vite/bin/vite.js'),
          'build',
          '--config',
          'web/loader/vite.config.ts',
          '--outDir',
          output,
          '--emptyOutDir',
        ],
        { cwd: process.cwd(), stdio: 'pipe', timeout: 50_000 }
      );
      const html = readFileSync(join(output, 'index.html'), 'utf8');
      expect(html).toContain('/assets/');
      expect(html).toContain('favicon.svg');
      expect(readFileSync(join(output, 'favicon.svg'), 'utf8')).toContain('<svg');
      const cssFile = readdirSync(join(output, 'assets')).find((name) => name.endsWith('.css'))!;
      const css = readFileSync(join(output, 'assets', cssFile), 'utf8');
      expect(css).not.toMatch(/:root\s*\{[^}]*font-family\s*:/);
      expect(css).toContain('--font-sans');
      const assets = readdirSync(join(output, 'assets'));
      expect(assets.some((name) => name.endsWith('.js'))).toBe(true);
      expect(assets.some((name) => name.endsWith('.css'))).toBe(true);
    }
  );
});

/**
 * The loader image is built from a narrow context: `.dockerignore` admits a
 * fixed file list and the `ui-build` stage copies named inputs. The loader UI
 * still reads modules that live outside `web/loader` (the shared model-status
 * projection and its wire contract), so every such module must be admitted and
 * copied, and every relative import must be followed transitively to find them
 * (lifemodel-s9v5.1.3: main merged red because neither list carried them).
 */
const RELATIVE_IMPORT_PATTERNS = [
  /\bfrom\s*['"](\.[^'"]*)['"]/g,
  /\bimport\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g,
  /\bimport\s+['"](\.[^'"]*)['"]/g,
];
const MODULE_SUFFIXES = ['.ts', '.tsx', '.css'];

function relativeImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of RELATIVE_IMPORT_PATTERNS)
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]!);
  return specifiers;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** The file a relative specifier names, with the suffixes TypeScript omits. */
function resolveModule(from: string, specifier: string): string | null {
  const base = resolve(dirname(from), specifier);
  const candidates = [base, ...MODULE_SUFFIXES.map((suffix) => `${base}${suffix}`)];
  // A compiled-style './contract.js' names the source './contract.ts'.
  if (base.endsWith('.js'))
    candidates.push(...MODULE_SUFFIXES.map((suffix) => `${base.slice(0, -3)}${suffix}`));
  for (const candidate of candidates) if (isFile(candidate)) return candidate;
  if (isDirectory(base))
    for (const suffix of MODULE_SUFFIXES) {
      const index = join(base, `index${suffix}`);
      if (isFile(index)) return index;
    }
  return null;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

/** Every file outside `web/loader` that the loader UI reaches by relative import. */
function outsideLoaderImports(loaderRoot: string): string[] {
  const found = new Set<string>();
  const visited = new Set<string>();
  const pending = sourceFiles(join(loaderRoot, 'src')).filter((file) => /\.tsx?$/.test(file));
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of relativeImports(readFileSync(file, 'utf8'))) {
      const resolved = resolveModule(file, specifier);
      if (resolved === null) continue;
      if (resolved.startsWith(`${loaderRoot}${sep}`)) {
        pending.push(resolved);
        continue;
      }
      found.add(relative(process.cwd(), resolved).split(sep).join('/'));
      if (/\.tsx?$/.test(resolved)) pending.push(resolved);
    }
  }
  return [...found].sort();
}

/** The COPY sources of the loader image's `ui-build` stage. */
function uiBuildCopySources(dockerfile: string): string[] {
  const uiBuild = dockerfile.split(' AS ui-build\n')[1]!.split(/^FROM /m)[0]!;
  return [...uiBuild.matchAll(/^COPY (.+) \S+$/gm)].flatMap((match) => match[1]!.split(/\s+/));
}

describe('loader UI build inputs from outside web/loader', () => {
  it('admits and copies every module the loader UI imports from outside web/loader', () => {
    const loaderRoot = resolve('web/loader');
    const imported = outsideLoaderImports(loaderRoot);
    expect(imported).toContain('src/web/model-status.ts');
    expect(imported).toContain('src/web/contract.ts');
    const admitted = dockerignore({ ignorecase: false }).add(readFileSync('.dockerignore', 'utf8'));
    const copied = dockerignore({ ignorecase: false }).add(
      uiBuildCopySources(readFileSync('docker/loader/Dockerfile', 'utf8'))
    );
    for (const path of imported) {
      expect(admitted.ignores(path), `${path} is not admitted by .dockerignore`).toBe(false);
      expect(copied.ignores(path), `${path} is not copied by the ui-build stage`).toBe(true);
    }
  });
});
