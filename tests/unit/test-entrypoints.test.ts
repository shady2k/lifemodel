/**
 * Entrypoint policy tests: local and ordinary CI suite entrypoints start
 * inside the disposable test boundary. Only ci-image has the approved
 * CI-only, built-image first-start exception.
 *
 * Ordinary suites never start on the host. `npm test`, `npm run check`, the husky
 * pre-commit hook and CI's product job all go through the isolated launcher
 * (`scripts/test-isolated.mjs`), which bounds every run and keeps the owner's
 * checkout, environment and Docker daemon out of it. These tests read only the
 * repository's own committed config files — no environment, no state, no
 * network — and, like every test here, they themselves run only through the
 * launcher.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as semver from 'semver';
import { ciEntrypointPolicy } from '../helpers/ci-entrypoint-policy.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const LAUNCHER = 'node scripts/test-isolated.mjs';

const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const scripts = manifest.scripts;

describe('test entrypoint policy (lifemodel-q4x.5.2)', () => {
  it('npm test runs the whole suite through the isolated launcher', () => {
    expect(scripts.test).toBe(`${LAUNCHER} test`);
  });

  it('npm run check runs every product check through the isolated launcher', () => {
    expect(scripts.check).toBe(`${LAUNCHER} check`);
  });

  it('the docker mode is reachable as its own script', () => {
    expect(scripts['test:docker']).toBe(`${LAUNCHER} docker`);
  });

  it('watch is explicitly unsupported: the launcher has no watch option, and the host is refused', () => {
    const watch = scripts['test:watch'] ?? '';
    expect(watch).not.toBe('');
    // Match the whole command: an explanation followed by a failure, with
    // no hidden host command before or after it.
    expect(watch).toMatch(/^echo '[^'\n]*unsupported[^'\n]*' >&2 && exit 1$/);
    // It names the bounded substitute a person can actually run.
    expect(watch).toContain('test-isolated.mjs test');
  });

  it('no npm script starts a raw vitest command on the host', () => {
    for (const [name, value] of Object.entries(scripts)) {
      expect(value, `npm run ${name} starts vitest on the host`).not.toMatch(/\bvitest\b/);
    }
  });

  it('the manifest still declares Node.js >= 24', () => {
    expect(manifest.engines?.node).toBe('>=24.0.0');
  });

  it('vitest.config.ts caps workers at 2, whatever starts the suite (defense in depth)', () => {
    const config = readFileSync(join(repoRoot, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/maxWorkers:\s*2\b/);
  });

  it('the pre-commit hook lints staged files, then runs the isolated check, and keeps the gate', () => {
    const hook = readFileSync(join(repoRoot, '.husky/pre-commit'), 'utf8');
    const lintStaged = hook.indexOf('npx lint-staged');
    const isolatedCheck = hook.indexOf('node scripts/test-isolated.mjs check');
    expect(lintStaged).toBeGreaterThanOrEqual(0);
    expect(isolatedCheck).toBeGreaterThan(lintStaged);
    expect(hook).not.toMatch(/\bvitest\b/);
    expect(hook).not.toMatch(/tsc --noEmit/);
    // lint-staged and the gate drive the commit through git context variables
    // (GIT_INDEX_FILE above all); none of them may leak into the launcher's
    // child, which snapshots the tree itself.
    expect(hook).toMatch(
      /^\(\n\s+unset GIT_INDEX_FILE[^\n]*\\\n[^\n]*\n\s+node scripts\/test-isolated\.mjs check\n\)/m,
    );
    expect(hook).toContain('# --- BEGIN LIFEMODEL BACKLOG GATE ---');
    expect(hook).toContain('node .backlog/gate.mjs');
    expect(hook).toContain('# --- END LIFEMODEL BACKLOG GATE ---');
  });

  it('CI allows only the named, bounded image exception; ordinary jobs remain isolated', () => {
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(() => ciEntrypointPolicy(ci)).not.toThrow();
  });

  it('rejects synthetic policy regressions, including multiline and new-job commands', () => {
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const imageStart = ci.indexOf('\n  ci-image:\n');
    const publishStart = ci.indexOf('\n  ci-image-publish:\n');
    expect(imageStart).toBeGreaterThan(0);
    expect(publishStart).toBeGreaterThan(imageStart);
    const mutateImage = (from: string, to: string): string => {
      const block = ci.slice(imageStart, publishStart);
      expect(block).toContain(from);
      return ci.slice(0, imageStart) + block.replace(from, to) + ci.slice(publishStart);
    };
    const productExtra = (step: string): string => ci.replace(
      'run: node scripts/test-isolated.mjs check',
      `run: node scripts/test-isolated.mjs check\n${step}`,
    );
    const ordinaryExtra = (step: string): string =>
      `${ci}\n  ordinary-new:\n    steps:\n${step}\n`;
    const namedStep = (run: string): string =>
      `      - name: Bad\n        ${run}`;
    const cases: [string, string][] = [
      ['product install', ci.replace('run: node scripts/test-isolated.mjs check', 'run: npm ci')],
      ['product suite', ci.replace('run: node scripts/test-isolated.mjs check', 'run: npx vitest run')],
      ['product Node', ci.replace("node-version: '24'", "node-version: '22'")],
      ['multiline product install', ci.replace(
        'run: node scripts/test-isolated.mjs check',
        'run: |\n          node scripts/test-isolated.mjs check\n          npm ci',
      )],
      ['new job install', ci + '\n  ordinary-new:\n    steps:\n      - name: Bad\n        run: npm ci\n'],
      ['new job suite', ci + '\n  ordinary-new:\n    steps:\n      - name: Bad\n        run: |\n          set -eu\n          npx vitest run\n'],
      ['product quoted run extra', productExtra(namedStep('"run": npx vitest run'))],
      ['new job quoted run', ordinaryExtra(namedStep('"run": npm ci'))],
      ['new job single-quoted run', ordinaryExtra(namedStep("'run': npm ci"))],
      ['new job escaped run key', ordinaryExtra(namedStep('"r\\u0075n": npm ci'))],
      ['product inline-map run extra', productExtra(
        '      - {name: Bad, run: npx vitest run}',
      )],
      ['new job inline-map run', ordinaryExtra('      - {name: Bad, run: npm ci}')],
      ['new job flagged npm ci', ordinaryExtra(namedStep('run: npm --ignore-scripts ci'))],
      ['product flagged npm ci extra', productExtra(namedStep('run: npm --ignore-scripts ci'))],
      ['new job quoted npm executable', ordinaryExtra(namedStep('run: command "npm" ci'))],
      ['new job single-quoted npm executable', ordinaryExtra(namedStep("run: command 'npm' ci"))],
      ['product quoted npm executable extra', productExtra(namedStep('run: command "npm" ci'))],
      ['new job other npm command', ordinaryExtra(namedStep('run: npm --version'))],
      ['renamed exception', ci.replace('\n  ci-image:\n', '\n  image-copy:\n')],
      ['wrong file', mutateImage('instance-first-start.test.ts', 'other.test.ts')],
      ['extra file', mutateImage('instance-first-start.test.ts', 'instance-first-start.test.ts tests/unit/energy-management.test.ts')],
      ['general suite', mutateImage(' tests/integration/instance-first-start.test.ts', '')],
      ['workers', mutateImage('--maxWorkers=2', '--maxWorkers=3')],
      ['wrong image', mutateImage('lifemodel:ci-$SHA', 'lifemodel:main')],
      ['wrong build', mutateImage('scripts/build-image.sh "ci-$SHA"', 'scripts/build-image.sh main')],
      ['self-hosted', mutateImage('runs-on: ubuntu-latest', 'runs-on: self-hosted')],
      ['unbounded', mutateImage('    timeout-minutes: 45\n', '')],
      ['longer deadline', mutateImage('timeout-minutes: 45', 'timeout-minutes: 90')],
      ['push', mutateImage("github.event_name == 'pull_request'", "github.event_name == 'push'")],
      ['credentials', mutateImage('persist-credentials: false', 'persist-credentials: true')],
      ['shallow', mutateImage('fetch-depth: 0', 'fetch-depth: 1')],
      ['secret', mutateImage('SHA: ${{ github.sha }}', 'SHA: ${{ secrets.IMAGE_TOKEN }}')],
      ['extra env', mutateImage('    steps:', '    env:\n      TOKEN: ${{ secrets.TOKEN }}\n    steps:')],
      ['write', mutateImage('    steps:', '    permissions:\n      contents: write\n    steps:')],
      ['login', mutateImage('run: npm ci', 'run: |\n          npm ci\n          docker login ghcr.io')],
      ['extra install command', mutateImage('run: npm ci', 'run: npm ci && npm test')],
      ['inherited secret', ci.replace('jobs:', 'env:\n  TOKEN: ${{ secrets.TOKEN }}\njobs:')],
      ['inherited write', ci.replace('permissions:\n  contents: read', 'permissions:\n  contents: write')],
      ['unsupported folded run', ci.replace(
        'run: node scripts/test-isolated.mjs check',
        'run: >\n          npm ci',
      )],
    ];
    for (const [name, changed] of cases) {
      expect(changed, name).not.toBe(ci);
      expect(() => ciEntrypointPolicy(changed), name).toThrow();
    }
  });

  it('package.json and package-lock.json agree, what npm ci used to prove before the checks', () => {
    const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, unknown>;
    };
    const rootMapping = lock.packages[''] as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const group of ['dependencies', 'devDependencies'] as const) {
      const declared = manifest[group] ?? {};
      const locked = rootMapping[group] ?? {};
      // The lockfile's root mapping mirrors the manifest (lockfileVersion 3
      // keeps the specifiers there); checked in both directions, so a stale
      // lock is caught too.
      expect(locked, `${group} missing from the lockfile's root mapping`).toEqual(declared);
      for (const [name, spec] of Object.entries(declared)) {
        const entry = lock.packages[`node_modules/${name}`] as { version?: string } | undefined;
        expect(entry, `${name} is in package.json but has no lockfile entry`).toBeTruthy();
        expect(
          entry?.version !== undefined && semver.satisfies(entry.version, spec),
          `${name}@${entry?.version} does not satisfy ${spec}`,
        ).toBe(true);
      }
    }
  });

  it('the launcher script the entrypoints call exists', () => {
    // The launcher worker owns it (lifemodel-q4x.5.1); this holds once the two
    // worktrees are integrated, which is also when the suite can run at all.
    expect(existsSync(join(repoRoot, 'scripts/test-isolated.mjs'))).toBe(true);
  });

  it('the documents describe the boundary, its prerequisites and its limits', () => {
    for (const file of ['AGENTS.md', 'README.md']) {
      const doc = readFileSync(join(repoRoot, file), 'utf8');
      expect(doc, `${file} names the launcher`).toContain('scripts/test-isolated.mjs');
      expect(doc, `${file} names the Node.js prerequisite`).toContain('Node.js ≥ 24');
      expect(doc, `${file} names the Docker prerequisite`).toContain('Docker');
    }
  });
});
