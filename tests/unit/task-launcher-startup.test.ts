/** Execute the real compiled entrypoint and graph, without an agent or service. */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const CANARY = 'STARTUP-PRIVATE-CREDENTIAL-CANARY';
let graph: string;

beforeAll(() => {
  graph = mkdtempSync(join(tmpdir(), 'launcher-module-graph-'));
  mkdirSync(join(graph, 'loader/dist'), { recursive: true });
  mkdirSync(join(graph, 'src/ports'), { recursive: true });
  writeFileSync(join(graph, 'package.json'), JSON.stringify({ type: 'module' }));
  // Use the real emitted module bodies, preserving runtime imports. No service
  // modules are mocked; this catches transitive dependencies outside task-*.js.
  for (const file of readdirSync('loader/src').filter((name) => name.endsWith('.ts'))) {
    const output = ts.transpileModule(read(`loader/src/${file}`), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2024,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText;
    writeFileSync(join(graph, 'loader/dist', file.replace(/\.ts$/, '.js')), output);
  }
  for (const file of ['task-agent-validation.mjs', 'task-harness-registry.json']) {
    cpSync(`src/ports/${file}`, join(graph, 'src/ports', file));
  }
});
afterAll(() => rmSync(graph, { recursive: true, force: true }));

function launch(
  options: {
    missing?: string;
    throwing?: string;
    selfCheck?: boolean;
    start?: boolean;
    noTermination?: boolean;
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'launcher-entrypoint-'));
  try {
    cpSync(graph, directory, { recursive: true });
    const dist = join(directory, 'loader/dist');
    if (options.missing) rmSync(join(dist, options.missing));
    if (options.throwing) writeFileSync(join(dist, 'task-launcher.js'), options.throwing);
    const terminationLog = join(directory, 'termination-log');
    const preloader = join(directory, 'capture-termination.mjs');
    writeFileSync(
      preloader,
      `import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.writeFileSync;
fs.writeFileSync = (path, ...args) => {
  if (path === '/dev/termination-log' && ${Boolean(options.noTermination)}) throw new Error('${CANARY}');
  return original(path === '/dev/termination-log' ? ${JSON.stringify(terminationLog)} : path, ...args);
};
${options.selfCheck ? `promises.mkdir = async () => { throw Object.assign(new Error('${CANARY}'), { code: 'EACCES', stderr: '${CANARY}' }); };` : ''}
syncBuiltinESMExports();
`
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        preloader,
        join(dist, 'task-launcher-main.js'),
        ...(options.start ? [] : [options.selfCheck ? '--self-check' : '--check-modules']),
      ],
      { encoding: 'utf8', timeout: 10_000, cwd: directory, env: {} }
    );
    const termination = (() => {
      try {
        return read(terminationLog);
      } catch {
        return '';
      }
    })();
    return { ...result, termination };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function diagnostic(result: ReturnType<typeof launch>) {
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(result.termination);
  expect(Buffer.byteLength(result.stderr)).toBeLessThan(256);
  expect(result.stderr).not.toContain(CANARY);
  return JSON.parse(result.stderr);
}

describe('workbench launcher startup diagnostics and graph check', () => {
  it('loads the complete real graph without starting a task or needing configuration', () => {
    const result = launch();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.termination).toBe('');
  });

  it.each(['task-launcher.js', 'task-launcher-http.js', 'model-error-excerpt.js'])(
    'fails the offline check when the image omits %s, reporting only its basename',
    (missing) => {
      expect(diagnostic(launch({ missing }))).toEqual({
        code: 'launcher_start_failed',
        reasonCode: 'ERR_MODULE_NOT_FOUND',
        module: missing,
      });
    }
  );

  it('records a real startup import failure before a task can execute', () => {
    expect(diagnostic(launch({ start: true, missing: 'model-error-excerpt.js' }))).toEqual({
      code: 'launcher_start_failed',
      reasonCode: 'ERR_MODULE_NOT_FOUND',
      module: 'model-error-excerpt.js',
    });
  });

  it('keeps the original bounded stderr diagnostic when the termination file is unavailable', () => {
    const result = launch({
      missing: 'model-error-excerpt.js',
      noTermination: true,
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({
      code: 'launcher_start_failed',
      reasonCode: 'ERR_MODULE_NOT_FOUND',
      module: 'model-error-excerpt.js',
    });
    expect(result.stderr).not.toContain(CANARY);
    expect(result.termination).toBe('');
  });

  it.each([
    `throw Object.assign(new Error('${CANARY}'), { code: '${CANARY}', url: 'file:///secret/${CANARY}.js', stderr: '${CANARY}', stack: '${CANARY}' });`,
    `throw { get code() { throw new Error('${CANARY}'); }, message: '${CANARY}' };`,
    `throw '${CANARY}';`,
    `throw { code: '${'x'.repeat(4096)}', url: '${'x'.repeat(4096)}' };`,
  ])('does not expose arbitrary error text, properties or credentials', (throwing) => {
    expect(diagnostic(launch({ throwing }))).toEqual({
      code: 'launcher_start_failed',
      reasonCode: 'startup_error',
      module: 'unknown',
    });
  });

  it.each([
    `https://${CANARY}@example.invalid/task-launcher.js`,
    `file:///secret/task-launcher.js?token=${CANARY}`,
    `file:///secret/task-launcher.js#${CANARY}`,
    `file://host/secret/task-launcher.js`,
    `file:///secret/${CANARY}.js`,
  ])('does not expose a hostile module URL', (url) => {
    const throwing = `throw Object.assign(new Error('${CANARY}'), { code: 'ERR_MODULE_NOT_FOUND', url: '${url}' });`;
    expect(diagnostic(launch({ throwing }))).toEqual({
      code: 'launcher_start_failed',
      reasonCode: 'ERR_MODULE_NOT_FOUND',
      module: 'unknown',
    });
  });

  it('retains the distinct self-check failure code in stderr and the termination file', () => {
    expect(diagnostic(launch({ selfCheck: true }))).toEqual({
      code: 'workbench_self_check_failed',
      reasonCode: 'EACCES',
      module: 'unknown',
    });
  });

  it('checks the real workbench entrypoint through the bounded image smoke command', () => {
    const directory = mkdtempSync(join(tmpdir(), 'workbench-smoke-command-'));
    try {
      const docker = join(directory, 'docker');
      writeFileSync(docker, '#!/bin/sh\nprintf "%s\\n" "$*"\n', {
        mode: 0o755,
      });
      const result = spawnSync(
        'sh',
        [resolve('scripts/smoke-image-modules.sh'), 'workbench', 'workbench-image'],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        }
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('--network none --read-only');
      expect(result.stdout).toContain(
        'workbench-image /opt/lifemodel/loader/dist/task-launcher-main.js --check-modules'
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
