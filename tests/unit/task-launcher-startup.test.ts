/** Execute the real compiled entrypoint and graph, without an agent or service. */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');
const CANARY = 'STARTUP-PRIVATE-CREDENTIAL-CANARY';
const registry = JSON.parse(read('src/ports/task-harness-registry.json')) as Record<
  string,
  { adapterModule: string }
>;
const adapterModules = Object.values(registry).map((agent) => agent.adapterModule.slice(2));
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
  for (const file of [
    'task-agent-validation.mjs',
    'task-transcript-bounds.mjs',
    'task-output-names.mjs',
    'task-harness-registry.json',
  ]) {
    cpSync(`src/ports/${file}`, join(graph, 'src/ports', file));
  }
  const generated = spawnSync(
    process.execPath,
    ['scripts/task-start-manifest.mjs', 'loader', join(graph, 'loader/dist/task-launcher-main.js')],
    { encoding: 'utf8', timeout: 10_000 }
  );
  expect(generated.status, generated.stderr).toBe(0);
});
afterAll(() => rmSync(graph, { recursive: true, force: true }));

function launch(
  options: {
    missing?: string;
    adapterDependency?: string;
    extraRuntimeModule?: string;
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
    if (options.adapterDependency) {
      const adapter = join(dist, options.adapterDependency);
      // Current adapters use builtins only after type erasure. Add a runtime
      // edge to a real emitted module outside the static launcher graph.
      writeFileSync(adapter, `import './clock.js';\n${read(adapter)}`);
    }
    if (options.extraRuntimeModule) writeFileSync(join(dist, options.extraRuntimeModule), '');
    if (options.missing)
      rmSync(
        options.missing.endsWith('.mjs')
          ? join(directory, 'src/ports', options.missing)
          : join(dist, options.missing)
      );
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

  it.each([
    'task-launcher.js',
    'task-launcher-http.js',
    'model-error-excerpt.js',
    'task-transcript-bounds.mjs',
    'task-output-names.mjs',
    ...adapterModules,
  ])('fails the offline check when the image omits %s, reporting only its basename', (missing) => {
    expect(diagnostic(launch({ missing }))).toEqual({
      code: 'launcher_start_failed',
      reasonCode: 'ERR_MODULE_NOT_FOUND',
      module: missing,
    });
  });

  it.each(['task-identity.js', 'task-model-gateway.js', 'model-error-codes.js'])(
    'names trusted build module %s even when its runtime file is absent',
    (missing) => {
      const throwing = `throw { code: 'ERR_MODULE_NOT_FOUND', url: 'file:///opt/lifemodel/loader/dist/${missing}' };`;
      expect(diagnostic(launch({ missing, throwing }))).toEqual({
        code: 'launcher_start_failed',
        reasonCode: 'ERR_MODULE_NOT_FOUND',
        module: missing,
      });
    }
  );

  it.each(adapterModules)(
    'loads transitive dependencies of registered adapter %s without starting it',
    (adapterDependency) => {
      const loaded = launch({ adapterDependency });
      expect(loaded.status, loaded.stderr).toBe(0);
      expect(loaded.stdout).toBe('');
      expect(loaded.stderr).toBe('');
      expect(diagnostic(launch({ adapterDependency, missing: 'clock.js' }))).toEqual({
        code: 'launcher_start_failed',
        reasonCode: 'ERR_MODULE_NOT_FOUND',
        module: 'clock.js',
      });
    }
  );

  it('does not trust a runtime file as a public diagnostic name', () => {
    const extraRuntimeModule = `${CANARY}.js`;
    const throwing = `throw { code: 'ERR_MODULE_NOT_FOUND', url: 'file:///secret/${extraRuntimeModule}' };`;
    expect(diagnostic(launch({ throwing, extraRuntimeModule }))).toEqual({
      code: 'launcher_start_failed',
      reasonCode: 'ERR_MODULE_NOT_FOUND',
      module: 'unknown',
    });
  });

  it('root build:loader emits a nonempty trusted start-module inventory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'root-loader-build-'));
    try {
      for (const path of [
        'package.json',
        'loader',
        'src/ports',
        'scripts/task-start-manifest.mjs',
      ]) {
        mkdirSync(join(directory, path, '..'), { recursive: true });
        cpSync(path, join(directory, path), { recursive: true });
      }
      symlinkSync(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
      const result = spawnSync('npm', ['run', 'build:loader'], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const emitted = read(join(directory, 'loader/dist/task-launcher-main.js'));
      expect(emitted).not.toContain('/* task-start-module-manifest */ []');
      const inventory = emitted.match(/Object\.freeze\((\[[^\]]*\])\)/);
      expect(inventory).not.toBeNull();
      const names = JSON.parse(inventory![1]!) as string[];
      expect(names.length).toBeGreaterThan(0);
      expect(names).toEqual(expect.arrayContaining(['task-launcher.js', 'task-output-names.mjs']));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 70_000);

  it('builds the trusted manifest before copying the complete graph into the image', () => {
    const loader = JSON.parse(read('loader/package.json')) as { scripts: { build: string } };
    expect(loader.scripts.build).toContain(
      'tsc -p tsconfig.json && node ../scripts/task-start-manifest.mjs .'
    );
    const image = read('docker/workbench/Dockerfile');
    expect(image).toContain('COPY scripts/task-start-manifest.mjs /scripts/');
    expect(image.indexOf('RUN npm run build')).toBeLessThan(
      image.indexOf('COPY --from=cli-build /build/dist/')
    );
    for (const path of ['docker/workbench/Dockerfile.dockerignore', '.dockerignore']) {
      expect(read(path)).toContain('!scripts/task-start-manifest.mjs');
    }
    expect(read('docker/loader/Dockerfile')).toContain(
      'COPY scripts/task-start-manifest.mjs /scripts/'
    );
    for (const selector of ['ci-loader-paths.sh', 'ci-workbench-paths.sh']) {
      const selected = spawnSync('sh', [`scripts/${selector}`], {
        input: 'changed: scripts/task-start-manifest.mjs\n',
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(selected.status, selected.stderr).toBe(0);
      expect(selected.stdout.trim()).toMatch(/_image=true$/);
    }
  });

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
