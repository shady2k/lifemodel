import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const read = (file: string): string => readFileSync(file, 'utf8');
const ci = YAML.parse(read('.github/workflows/ci.yml'));
const release = YAML.parse(read('.github/workflows/release.yml')).jobs.release;
const commands = (job: any): string => job.steps.map((step: any) => step.run ?? '').join('\n');

function requireSmokeBeforePush(job: any, kind: string): void {
  const run = commands(job);
  const smoke = run.indexOf(`scripts/smoke-image-modules.sh ${kind} `);
  const push = run.indexOf('docker push ');
  expect(smoke).toBeGreaterThanOrEqual(0);
  expect(push).toBeGreaterThan(smoke);
}

describe('built image module smoke contract', () => {
  it.each([0, 42, 124])('cleans its named container and preserves docker status %s', (status) => {
    const directory = mkdtempSync(join(tmpdir(), 'module-smoke-cleanup-'));
    try {
      const log = join(directory, 'calls');
      const docker = join(directory, 'docker');
      writeFileSync(
        docker,
        `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
case "$1" in run) exit "$RUN_STATUS" ;; esac
`
      );
      chmodSync(docker, 0o755);
      const result = spawnSync(
        'sh',
        [resolve('scripts/smoke-image-modules.sh'), 'core', 'test-image'],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
            CALL_LOG: log,
            RUN_STATUS: String(status),
          },
        }
      );
      expect(result.status, result.stderr).toBe(status);
      const calls = read(log).trim().split('\n');
      expect(calls).toHaveLength(2);
      const name = calls[0].match(/--name (lifemodel-module-smoke-\d+)/)?.[1];
      expect(name).toBeTruthy();
      expect(calls[0]).toContain('test-image /opt/lifemodel/dist/index.js --check-modules');
      expect(calls[1]).toBe(`rm --force ${name}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['core', 'web'])(
    'smokes the %s PR image and the published image before either push',
    (kind) => {
      const pr = commands(ci.jobs[`ci-${kind}-image`]);
      expect(pr.indexOf(`scripts/smoke-image-modules.sh ${kind} `)).toBeGreaterThan(
        pr.indexOf(`scripts/build-${kind}-image.sh `)
      );
      expect(pr).toContain(`ghcr.io/shady2k/lifemodel-${kind}:ci-${kind}-$SHA`);
      const publish = ci.jobs[`ci-${kind}-image-publish`];
      requireSmokeBeforePush(publish, kind);
      const run = commands(publish);
      expect(run).toContain(
        `scripts/smoke-image-modules.sh ${kind} "ghcr.io/shady2k/lifemodel-${kind}:$SHA"`
      );
      expect(() =>
        requireSmokeBeforePush(
          { steps: [{ run: run.replace(/scripts\/smoke-image-modules.sh [^\n]+/, '') }] },
          kind
        )
      ).toThrow();
      expect(() =>
        requireSmokeBeforePush({ steps: [{ run: `docker push unchecked\n${run}` }] }, kind)
      ).toThrow();
    }
  );

  it('smokes the workbench PR and main images after build, before publishing', () => {
    const pr = commands(ci.jobs['ci-workbench-image']);
    expect(
      pr.indexOf('scripts/smoke-image-modules.sh workbench "ci-workbench-$SHA"')
    ).toBeGreaterThan(pr.indexOf('docker build --file docker/workbench/Dockerfile'));
    requireSmokeBeforePush(ci.jobs['ci-workbench-image-publish'], 'workbench');
    const publish = commands(ci.jobs['ci-workbench-image-publish']);
    expect(publish).toContain(
      'scripts/smoke-image-modules.sh workbench "ghcr.io/shady2k/lifemodel-workbench:$SHA"'
    );
  });

  it('smokes the loader PR image after build, without starting its service', () => {
    const run = commands(ci.jobs['ci-loader-image']);
    expect(run.indexOf('scripts/smoke-image-modules.sh loader "ci-loader-$SHA"')).toBeGreaterThan(
      run.indexOf('docker build --file docker/loader/Dockerfile')
    );
  });

  it.each(['core', 'loader', 'web', 'workbench'])(
    'loads, smokes and pushes the SAME release %s image in order',
    (kind) => {
      const steps = release.steps;
      const buildIndex = steps.findIndex(
        (step: any) => step.with?.file === `docker/${kind}/Dockerfile`
      );
      const smokeIndex = steps.findIndex(
        (step: any) => step.run === `scripts/smoke-image-modules.sh ${kind} "$IMAGE"`
      );
      const pushIndex = steps.findIndex((step: any) => step.id === kind);
      expect(buildIndex).toBeGreaterThanOrEqual(0);
      expect(smokeIndex).toBeGreaterThan(buildIndex);
      expect(pushIndex).toBeGreaterThan(smokeIndex);
      const build = steps[buildIndex];
      const smoke = steps[smokeIndex];
      const push = steps[pushIndex];
      expect(build.with.push).toBe(false);
      expect(build.with.load).toBe(true);
      expect(smoke.env.IMAGE).toBe(build.with.tags);
      expect(push.env.IMAGE).toBe(build.with.tags);
      expect(push.run).toBe('scripts/release/push-checked-image.sh "$IMAGE"');
      expect(read('scripts/release/push-checked-image.sh')).toContain('docker push "$1"');
      expect(read('scripts/release/push-checked-image.sh')).toContain('digest=%s');
    }
  );

  it('uses the real entrypoints with a bounded, offline, read-only check', () => {
    const smoke = read('scripts/smoke-image-modules.sh');
    for (const entry of [
      'dist/index.js',
      'loader/dist/main.js',
      'dist/web/server.cjs',
      'loader/dist/task-launcher-main.js',
    ]) {
      expect(smoke).toContain(`/opt/lifemodel/${entry}`);
    }
    expect(smoke).toContain('timeout --kill-after=5 60 docker run --rm --name');
    expect(smoke).toContain('--network none --read-only');
    expect(smoke).toContain('trap cleanup EXIT');
    expect(smoke).toContain('timeout --kill-after=2 10 docker rm --force');
    expect(smoke).toContain('--entrypoint node "$2" "$entry" --check-modules');
    for (const [file, sideEffect] of [
      ['src/index.ts', 'let container:'],
      ['loader/src/main.ts', 'let config:'],
      ['src/web/index.ts', 'const logger = pino()'],
    ]) {
      const source = read(file);
      const guard = source.indexOf(
        "if (process.argv.includes('--check-modules')) process.exit(0);"
      );
      expect(guard).toBeGreaterThan(0);
      expect(guard).toBeLessThan(source.indexOf(sideEffect));
    }
  });
});
