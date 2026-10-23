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
              'loader/src/task-harness.ts',
              'loader/src/task-opencode.ts',
              'loader/src/task-model-relay.ts',
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

function assertAptProvenance(text: string): void {
  const hash = '77737fa4b34f2693e982cc9ee35736816c35a7778fc2d326cc1bbf5b301fe1aa';
  expect(text).toContain(`ENV DEBIAN_INRELEASE_SHA256=${hash}`);
  expect(text).toContain('/usr/lib/apt/apt-helper download-file');
  expect(text).toContain('"SHA256:${DEBIAN_INRELEASE_SHA256}"');
  expect(text).toContain('${DEBIAN_INRELEASE_SHA256}  /tmp/debian.InRelease');
  expect(text).toContain('cmp /tmp/debian.InRelease /var/lib/apt/lists/*_InRelease');
  expect(text.indexOf('sha256sum -c -')).toBeLessThan(text.indexOf('apt-get update'));
  expect(text.indexOf('cmp /tmp/debian.InRelease')).toBeLessThan(text.indexOf('apt-get install'));
  expect(text).not.toMatch(
    /trusted\s*=\s*yes|allow-unauthenticated|allow-insecure|check-valid-until=no/i
  );
}

function assertLifecyclePolicy(text: string): void {
  const instructions = text.replace(/\\\n\s*/g, ' ').split('\n');
  const installs = instructions.filter((line) => /^RUN .*npm ci\b/.test(line));
  expect(installs).toHaveLength(2);
  for (const line of installs) expect(line).toContain('--ignore-scripts');
  expect(instructions).toContain(
    'RUN --network=none ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm rebuild esbuild onnxruntime-node protobufjs sharp --foreground-scripts'
  );
  expect(text).not.toMatch(/--ignore-scripts=false|--allow-scripts(?:=|\s)/);
}

describe('task workbench image contract', () => {
  it('binds authenticated apt metadata to the intended snapshot before package installation', () => {
    assertAptProvenance(dockerfile());
  });

  it('installs lockfile bytes without scripts and rebuilds only audited scripts without network', () => {
    assertLifecyclePolicy(dockerfile());
    // A new or upgraded installer requires a new source audit, not silent enablement.
    const packages = JSON.parse(read('package-lock.json')).packages;
    expect(
      Object.entries(packages)
        .filter(([, entry]: [string, any]) => entry.hasInstallScript)
        .map(([name, entry]: [string, any]) => [name, entry.version])
    ).toEqual([
      ['node_modules/esbuild', '0.27.2'],
      ['node_modules/fsevents', '2.3.3'],
      ['node_modules/onnxruntime-node', '1.21.0'],
      ['node_modules/protobufjs', '7.5.4'],
      ['node_modules/sharp', '0.34.5'],
    ]);
    expect(
      Object.values(JSON.parse(read('loader/package-lock.json')).packages).filter(
        (entry: any) => entry.hasInstallScript
      )
    ).toEqual([]);
    expect(JSON.parse(read('package.json')).scripts.prepare).toBe('husky');
  });

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
    // All TaskHarness/relay/launcher modules must ship, not only the old stub.
    expect(text).toContain('/build/dist/task-*.js');
    expect(read('loader/src/task-launcher-main.ts')).not.toContain('launcher_not_implemented');
    const config = JSON.parse(read('docker/workbench/opencode.json'));
    expect(config.autoupdate).toBe(false);
    expect(config.share).toBe('disabled');
    expect(config.model).toBe('lifemodel/task');
    expect(config.small_model).toBe('lifemodel/task');
    expect(config.enabled_providers).toEqual(['lifemodel']);
    expect(config.provider.lifemodel.npm).toBe('@ai-sdk/openai-compatible');
    expect(config.provider.lifemodel.models.task).toEqual({
      name: 'task',
      tool_call: true,
      limit: { context: 128000, output: 16000 },
    });
    expect(config.provider.lifemodel.options.baseURL).toBe(
      'https://model-gateway.lifemodel-system.svc:8446/v1'
    );
    expect(JSON.stringify(config)).not.toMatch(/apiKey|token|password/i);
  });

  it('keeps OpenCode config non-writable so its exact-pin bootstrap cannot install plugins', () => {
    const text = dockerfile();
    expect(text).toContain('XDG_CONFIG_HOME=/etc/lifemodel/xdg');
    expect(text).toContain('mkdir -p /etc/lifemodel/xdg/opencode');
    expect(text).toContain('> /etc/lifemodel/xdg/opencode/.gitignore');
    expect(text).toContain('chmod 0555 /etc/lifemodel/xdg /etc/lifemodel/xdg/opencode');
    expect(text).toContain('chmod 0444 /etc/lifemodel/xdg/opencode/.gitignore');
    expect(text).not.toContain('XDG_CONFIG_HOME=/work/');
    for (const flag of [
      'OPENCODE_DISABLE_AUTOUPDATE',
      'OPENCODE_DISABLE_MODELS_FETCH',
      'OPENCODE_DISABLE_PROJECT_CONFIG',
      'OPENCODE_DISABLE_DEFAULT_PLUGINS',
      'OPENCODE_DISABLE_LSP_DOWNLOAD',
      'OPENCODE_DISABLE_EXTERNAL_SKILLS',
      'OPENCODE_DISABLE_CLAUDE_CODE',
      'OPENCODE_PURE',
    ]) {
      expect(text).toContain(`${flag}=true`);
    }
    // This is a build-surface assertion. The real config-load/no-network receipt
    // must come from running the pinned binary as uid 1000 in the built image.
  });

  it('provisions the same verified native binary before either isolated test runtime', () => {
    const setup = read('scripts/test-isolated.mjs');
    const machine = read('scripts/test-docker-isolated.mjs');
    const version = dockerfile().match(/OPENCODE_VERSION=(\d+\.\d+\.\d+)/)![1];
    const hash = dockerfile().match(/OPENCODE_SHA256=([0-9a-f]{64})/)![1];
    expect(setup).toContain(`OPENCODE_VERSION = '${version}'`);
    expect(setup).toContain(`sha256: '${hash}'`);
    expect(setup).toContain('sha256sum -c -');
    expect(setup).toContain('recipe-v6-opencode-ripgrep');
    expect(setup).toContain('.update(OPENCODE_VERSION).update(JSON.stringify(OPENCODE_ARCHIVES))');
    expect(setup.indexOf('opencodeProvisionScript(opencodeArch)')).toBeLessThan(
      setup.indexOf("'npm', 'ci'")
    );
    expect(machine).toContain('opencode: { ...OPENCODE_ARCHIVES }');
    expect(machine).toContain("id: 'provision-opencode'");
    expect(machine).toContain('/usr/local/bin/opencode --version');
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

  it.each([
    'malformed suffix',
    'misplaced placeholder',
    'zero digest',
    'wrong target name',
    'wrong target kind',
  ])('refuses %s without modifying the overlay', (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), 'workbench-pin-invalid-'));
    const file = join(dir, 'kustomization.yaml');
    const original = read(pinFile);
    const text =
      scenario === 'malformed suffix'
        ? original.replace(placeholder, `${placeholder}f`)
        : scenario === 'misplaced placeholder'
          ? original.replace(placeholder, `${image}@sha256:${'b'.repeat(64)}`) +
            `\n# ${placeholder}\n`
          : scenario === 'wrong target name'
            ? original.replace('name: core', 'name: web')
            : scenario === 'wrong target kind'
              ? original.replace('kind: StatefulSet', 'kind: Deployment')
              : original;
    const digest = `sha256:${(scenario === 'zero digest' ? '0' : 'a').repeat(64)}`;
    try {
      writeFileSync(file, text);
      expect(
        spawnSync('bash', ['scripts/release/set-workbench-digest.sh', digest, file]).status
      ).not.toBe(0);
      expect(read(file)).toBe(text);
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
