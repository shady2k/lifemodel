import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

function checkRelativeImports(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      checkRelativeImports(file);
      continue;
    }
    if (!/\.(?:mjs|cjs|js)$/.test(file)) continue;
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest);
    const visit = (node: ts.Node): void => {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        specifier = node.moduleSpecifier;
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        specifier = node.arguments[0];
      }
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
        const target = resolve(dirname(file), specifier.text);
        expect(existsSync(target), `${file} imports missing ${specifier.text}`).toBe(true);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
}

it('builds a complete relative module graph, including declaration-shadowed mjs sources', () => {
  const directory = mkdtempSync(join(tmpdir(), 'built-module-graph-'));
  try {
    for (const path of ['src', 'scripts', 'tsconfig.json', 'package.json']) {
      cpSync(path, join(directory, path), { recursive: true });
    }
    symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
    // Prove why the broad include and allowJs do not emit this runtime module:
    // TypeScript's same-basename extension priority picks its declaration instead.
    const config = ts.readConfigFile(join(directory, 'tsconfig.json'), ts.sys.readFile);
    const inputs = () => ts.parseJsonConfigFileContent(config.config, ts.sys, directory).fileNames;
    const validator = join(directory, 'src/ports/task-agent-validation.mjs');
    const declaration = join(directory, 'src/ports/task-agent-validation.d.mts');
    expect(inputs()).toContain(validator);
    const wildcardInputs = () =>
      ts.parseJsonConfigFileContent({ ...config.config, files: undefined }, ts.sys, directory)
        .fileNames;
    expect(wildcardInputs()).toContain(declaration);
    expect(wildcardInputs()).not.toContain(validator);
    rmSync(declaration);
    expect(wildcardInputs()).toContain(validator);
    cpSync('src/ports/task-agent-validation.d.mts', declaration);

    const built = spawnSync('npm', ['run', 'build'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(built.status, `${built.error ?? ''}\n${built.stdout}\n${built.stderr}`).toBe(0);
    const dist = join(directory, 'dist');
    const emitted = join(dist, 'ports/task-agent-validation.mjs');
    expect(existsSync(emitted)).toBe(true);
    checkRelativeImports(dist);
    const smoke = () =>
      spawnSync(process.execPath, [join(dist, 'index.js'), '--check-modules'], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 20_000,
        env: { PATH: process.env.PATH, HOME: directory, MOTOR_CORTEX_ENABLED: 'false' },
      });
    const green = smoke();
    expect(green.status, `${green.error ?? ''}\n${green.stderr}`).toBe(0);
    // Plant the original packaging defect: the SAME graph and runtime checks turn red.
    rmSync(emitted);
    expect(() => checkRelativeImports(dist)).toThrow(/task-agent-validation[.]mjs/);
    const red = smoke();
    expect(red.status).not.toBe(0);
    expect(red.stderr).toContain('ERR_MODULE_NOT_FOUND');
    expect(red.stderr).toContain('task-agent-validation.mjs');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 150_000);
