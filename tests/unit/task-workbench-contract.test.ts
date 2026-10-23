import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dockerignore from '@balena/dockerignore';
import YAML from 'yaml';

const read = (path: string): string => readFileSync(path, 'utf8');
const dockerfile = () => read('docker/workbench/Dockerfile');
const image = 'ghcr.io/shady2k/lifemodel-workbench';
const placeholder = `${image}@sha256:${'0'.repeat(64)}`;
const pinFile = 'deploy/platform/applications/lifemodel/kustomization.yaml';

function assertPinnedBuild(text: string): void {
  const from = text.match(/^FROM (\S+)/gm) ?? [];
  expect(from.length).toBeGreaterThan(0);
  for (const line of from) {
    expect(line).toMatch(/^FROM node:24\.21\.0-bookworm-slim@sha256:[0-9a-f]{64}$/);
  }
  expect(text).toMatch(/^ENV OPENCODE_VERSION=\d+\.\d+\.\d+\s*\\$/m);
  expect(text).toMatch(/OPENCODE_SHA256=[0-9a-f]{64}/);
  expect(text).toContain('sha256sum -c -');
  expect(text).toContain('${OPENCODE_VERSION}');
  expect(text).not.toMatch(/(?:latest|curl[^\n]*\|\s*(?:sh|bash))/);
  // Check continuation lines too, not only the first assignment of an ENV.
  const instructions = text.replace(/\\\n\s*/g, ' ').split('\n');
  for (const line of instructions.filter((line) => /^(?:ARG|ENV)\s/.test(line))) {
    expect(line).not.toMatch(/\b[A-Z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET)[A-Z0-9_]*(?:\s|=|$)/i);
  }
}

function assertContext(text: string, ignore: string): void {
  expect(ignore.split('\n').filter((line) => line && !line.startsWith('#'))[0]).toBe('*');
  expect(ignore.split('\n').filter((line) => line.startsWith('!') && line.endsWith('/'))).toEqual(
    []
  );
  const filter = dockerignore({ ignorecase: false }).add(ignore);
  // Every literal COPY input and representative files of each directory input.
  for (const line of text
    .split('\n')
    .filter((line) => /^COPY /.test(line) && !line.includes('--from='))) {
    const parts = line
      .split(/\s+/)
      .slice(1)
      .filter((part) => !part.startsWith('--'));
    for (const source of parts.slice(0, -1)) {
      const paths =
        source === 'loader/src/'
          ? [
              'loader/src/task-launcher-main.ts',
              'loader/src/storage-cli-main.ts',
              'loader/src/storage-cli.ts',
            ]
          : [source];
      for (const path of paths)
        expect(filter.ignores(path), `COPY input excluded: ${path}`).toBe(false);
    }
  }
  for (const path of [
    '.env',
    '.git/config',
    '.npmrc',
    'data/secret',
    'loader/src/secret.key',
    'loader/src/.env',
    '.worker-report.md',
  ]) {
    expect(filter.ignores(path), `sensitive input admitted: ${path}`).toBe(true);
  }
}

describe('task workbench image contract', () => {
  it('pins the Node base, OpenCode version and archive checksum; contains no key build input', () => {
    assertPinnedBuild(dockerfile());
  });

  it('admits every COPY input through a dedicated allowlist and excludes local/secret files', () => {
    assertContext(dockerfile(), read('docker/workbench/Dockerfile.dockerignore'));
  });

  it('bakes offline dev dependencies, compiled storage and a non-root launcher entry', () => {
    const text = dockerfile();
    expect(text).toContain('npm ci --legacy-peer-deps --no-audit --no-fund');
    expect(text).toContain('/opt/lifemodel/node_modules');
    expect(text).toContain('npm run build');
    expect(text).toContain('/opt/lifemodel/loader');
    expect(text).toContain('/usr/local/bin/lifemodel-storage');
    expect(text).toContain('USER 1000:1000');
    expect(text).toContain('HOME=/work/home');
    expect(text).toContain('WORKDIR /work');
    expect(text).toContain('ENTRYPOINT ["/usr/local/bin/lifemodel-task-launcher"]');
    expect(read('docker/workbench/lifemodel-task-launcher')).toContain(
      'exec node /opt/lifemodel/loader/dist/task-launcher-main.js "$@"'
    );
    expect(read('loader/src/task-launcher-main.ts')).toContain('launcher_not_implemented');
    const config = JSON.parse(read('docker/workbench/opencode.json'));
    expect(config.autoupdate).toBe(false);
    expect(config.share).toBe('disabled');
    expect(config.provider.lifemodel.options.baseURL).toBe(
      'https://model-gateway.lifemodel-system.svc:8446/v1'
    );
    expect(JSON.stringify(config)).not.toMatch(/apiKey|token|password/i);
  });

  it('pins the reference in the core overlay and substitutes exactly that release digest', () => {
    const text = read(pinFile);
    expect(text).toContain('name: LIFEMODEL_TASK_WORKBENCH_IMAGE');
    const references = text.match(/ghcr\.io\/shady2k\/lifemodel-workbench[^\s"']*/g);
    expect(references).toEqual([placeholder]);
    // The overlay targets the actual core, not an unused ConfigMap.
    expect(text).toMatch(/kind: StatefulSet\s+name: core/);
    expect(text).toContain('/spec/template/spec/containers/0/env/-');
    const overlay = YAML.parse(text);
    const manifests = overlay.resources.flatMap((resource: string) =>
      YAML.parseAllDocuments(read(`deploy/platform/applications/lifemodel/${resource}`)).map(
        (document) => document.toJSON()
      )
    );
    const core = manifests.find(
      (resource: any) => resource.kind === 'StatefulSet' && resource.metadata.name === 'core'
    );
    const patch = overlay.patches.find(
      (entry: any) => entry.target.kind === core.kind && entry.target.name === core.metadata.name
    );
    const operations = YAML.parse(patch.patch);
    expect(operations).toEqual([
      {
        op: 'add',
        path: '/spec/template/spec/containers/0/env/-',
        value: { name: 'LIFEMODEL_TASK_WORKBENCH_IMAGE', value: placeholder },
      },
    ]);
    const coreEnv = [...core.spec.template.spec.containers[0].env, operations[0].value];
    expect(coreEnv.filter((entry: any) => entry.name === 'LIFEMODEL_TASK_WORKBENCH_IMAGE')).toEqual(
      [
        {
          name: 'LIFEMODEL_TASK_WORKBENCH_IMAGE',
          value: placeholder,
        },
      ]
    );
    const dir = mkdtempSync(join(tmpdir(), 'workbench-pin-'));
    const file = join(dir, 'kustomization.yaml');
    try {
      writeFileSync(file, text);
      const digest = `sha256:${'a'.repeat(64)}`;
      execFileSync('bash', ['scripts/release/set-workbench-digest.sh', digest, file]);
      const pinned = read(file);
      expect(pinned).toContain(`${image}@${digest}`);
      expect(pinned).not.toContain(placeholder);
      expect(pinned.replace(`${image}@${digest}`, placeholder)).toBe(text);
      expect(
        spawnSync('bash', ['scripts/release/set-workbench-digest.sh', digest, file]).status
      ).not.toBe(0);
      expect(read(file)).toBe(pinned);
      writeFileSync(file, text);
      expect(
        spawnSync('bash', ['scripts/release/set-workbench-digest.sh', 'latest', file]).status
      ).not.toBe(0);
      expect(read(file)).toBe(text);
      writeFileSync(file, text + `\n# ${placeholder}\n`);
      expect(
        spawnSync('bash', ['scripts/release/set-workbench-digest.sh', digest, file]).status
      ).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds, pushes and pins before the seed bundle and signs the containing platform artifact', () => {
    const release = read('.github/workflows/release.yml');
    const build = release.indexOf('name: Build and push workbench image');
    const pin = release.indexOf('scripts/release/set-workbench-digest.sh');
    const seed = release.indexOf('name: Prepare the full-history loader seed bundle');
    expect(build).toBeGreaterThan(0);
    expect(pin).toBeGreaterThan(build);
    expect(seed).toBeGreaterThan(pin);
    const section = release.slice(build, seed);
    expect(section).toContain('id: workbench');
    expect(section).toContain('file: docker/workbench/Dockerfile');
    expect(section).toContain('push: true');
    expect(section).toContain('lifemodel-workbench:${{ github.ref_name }}');
    expect(section).toContain('WORKBENCH_DIGEST: ${{ steps.workbench.outputs.digest }}');
    expect(section).toContain(pinFile);
    expect(release).toContain('cosign sign --yes "ghcr.io/$OWNER/lifemodel-platform@$DIGEST"');
    expect(read('scripts/release/prepare-loader-context.sh')).toContain('git add -- "$seed_file"');
  });

  it('builds on affected PRs without publishing and checks offline startup', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain('workbench_image: ${{ steps.classify.outputs.workbench_image }}');
    expect(ci).toContain('scripts/ci-workbench-paths.sh < "$out" >> "$GITHUB_OUTPUT"');
    const start = ci.indexOf('\n  ci-workbench-image:');
    expect(start).toBeGreaterThan(0);
    const job = ci.slice(start + 1).split(/\n(?=  [a-z][a-z0-9-]*:\n)/)[0]!;
    expect(job).toContain("github.event_name == 'pull_request'");
    expect(job).toContain("needs.changes.result != 'success'");
    expect(job).toContain("needs.changes.outputs.workbench_image == 'true'");
    expect(job).toContain('!github.event.pull_request.draft');
    expect(job).toContain('docker build --file docker/workbench/Dockerfile');
    expect(job).toContain('--network none');
    expect(job).toContain('--read-only');
    expect(job).toContain('--self-check');
    expect(job).not.toMatch(/packages: write|docker push|docker login/);
  });

  it.each([
    'docker/workbench/Dockerfile',
    'docker/workbench/Dockerfile.dockerignore',
    'loader/src/storage-cli.ts',
    'loader/package-lock.json',
    'docker/loader/lifemodel-storage',
    'package.json',
    'package-lock.json',
    '.github/workflows/ci.yml',
    'scripts/ci-workbench-paths.sh',
    'scripts/release/set-workbench-digest.sh',
  ])('selects the image job for input %s', (path) => {
    expect(
      execFileSync('sh', ['scripts/ci-workbench-paths.sh'], {
        input: `changed: ${path}\nproduct=true\n`,
        encoding: 'utf8',
      }).trim()
    ).toBe('workbench_image=true');
  });

  it('selects unknown ranges but skips unrelated source and docs', () => {
    const select = (input: string) =>
      execFileSync('sh', ['scripts/ci-workbench-paths.sh'], { input, encoding: 'utf8' }).trim();
    expect(select('product=true\n')).toBe('workbench_image=true');
    expect(
      select('changed: docs/architecture.md\nchanged: src/core/agent.ts\nproduct=true\n')
    ).toBe('workbench_image=false');
  });
});
