/**
 * Entrypoint policy tests: local and ordinary CI suite entrypoints start
 * inside the disposable test boundary. CI has no host test exception.
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
import { networkCreateArgs, STORE_IMAGES, storeContainerArgs, validateStoreImages } from '../../scripts/test-isolated.mjs';

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

  it('CI builds only the standalone core image and keeps all suites isolated', () => {
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    expect(() => ciEntrypointPolicy(ci)).not.toThrow();
    expect(ci).not.toMatch(/^  ci-image:/m);
    expect(ci).not.toContain('instance-first-start.test.ts');
    expect(ci).toContain('scripts/build-core-image.sh');
    expect(ci).not.toContain('scripts/build-image.sh');
  });

  it('puts pinned migration lint inside the required backlog job', () => {
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const backlogStart = ci.indexOf('  ci-backlog:');
    const coreImageStart = ci.indexOf('  ci-core-image:', backlogStart);
    const backlog = ci.slice(backlogStart, coreImageStart);
    expect(backlogStart).toBeGreaterThan(0);
    expect(backlog).toContain('Lint expanding-only Postgres migrations with squawk');
    expect(backlog).toContain('9af8b2b54135ab236389122bce6c9edc40a8db4347e77d19079f19dcceddc737');
    expect(backlog).toContain('"$squawk" db/migrations/*.sql');
    expect(ci).not.toContain('  ci-migrations:');
  });

  it('rejects raw host test or install commands in every CI job', () => {
    const ci = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    const mutations = [
      ci.replace('run: node scripts/test-isolated.mjs check', 'run: npm ci'),
      ci.replace('run: node scripts/test-isolated.mjs check', 'run: npx vitest run'),
      ci.replace('run: node scripts/test-isolated.mjs check', 'run: |\n          node scripts/test-isolated.mjs check\n          npm ci'),
      ci + '\n  unexpected:\n    steps:\n      - name: Bad\n        run: npm ci\n',
      ci + '\n  unexpected:\n    steps:\n      - name: Bad\n        run: |\n          npx vitest run\n',
      ci.replace('\n  ci-core-image:\n', '\n  renamed-core-image:\n'),
    ];
    for (const changed of mutations) {
      expect(changed).not.toBe(ci);
      expect(() => ciEntrypointPolicy(changed)).toThrow();
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

  it('store images are digest pinned and refuses tag-only images', () => {
    expect(Object.values(STORE_IMAGES).every((image) => /@sha256:[a-f0-9]{64}$/.test(image))).toBe(true);
    expect(() => validateStoreImages({ valkey: 'valkey/valkey:8.1' })).toThrow(/sha256 digest/);
  });

  it('store containers join a network and the network itself is internal', () => {
    const network = networkCreateArgs('run-network');
    expect(network).toContain('--internal');
    expect(network).toContain('--label');
    const valkey = storeContainerArgs('valkey', STORE_IMAGES.valkey, 'run-network', 'valkey');
    const postgres = storeContainerArgs('postgres', STORE_IMAGES.postgres, 'run-network', 'postgres');
    for (const args of [valkey, postgres]) {
      expect(args).toContain('--network');
      expect(args).toContain('run-network');
      expect(args).toContain('--label');
      expect(args.join(' ')).not.toMatch(/--network (?:host|bridge|none)/);
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
