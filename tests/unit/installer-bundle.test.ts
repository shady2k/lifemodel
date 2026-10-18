import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const roots: string[] = [];
const digest = `sha256:${'a'.repeat(64)}`;
const tag = 'v9.8.7';
const command = (file: string, args: string[], cwd?: string) =>
  spawnSync(file, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, LIFEMODEL_INSTANCE_ENV: '/nonexistent/instance.env' },
  });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'installer-bundle-'));
  roots.push(root);
  const source = join(root, 'source');
  for (const directory of [
    'scripts/release',
    'deploy/root',
    'deploy/mdns',
    'deploy/cli',
    'deploy/nixos',
  ]) {
    mkdirSync(join(source, directory), { recursive: true });
    cpSync(directory, join(source, directory), { recursive: true });
  }
  cpSync('scripts/install.sh', join(source, 'scripts/install.sh'));
  return { root, source, output: join(root, 'output') };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('versioned release installer', () => {
  it('documents the release asset, root zero-parameter invocation, flags and persisted identity/pin', () => {
    const guide = readFileSync('deploy/nixos/README.md', 'utf8');
    expect(guide).toContain("not GitHub's automatically generated source archive");
    expect(guide).toContain("--pattern 'lifemodel-installer-*.tar.gz'");
    expect(guide).toContain('tar -xzf lifemodel-installer-*.tar.gz');
    expect(guide).toMatch(/^sudo sh scripts\/install\.sh$/m);
    expect(guide).toContain('no required parameters');
    for (const flag of [
      '--name',
      '--lan-interface',
      '--platform-url',
      '--tag',
      '--digest',
      '--verify',
      '--public-key-file',
      '--issuer',
      '--subject-regex',
      '--insecure-registry',
      '--render-only',
      '--root-templates',
    ]) {
      expect(guide).toContain(flag);
    }
    expect(guide).toContain('/etc/lifemodel/instance.env');
    expect(guide).toContain('even from a newer installer bundle');
    expect(guide).toContain('before any host change');
  });

  it('publishes an immutable versioned asset: first upload, same-pin retry, different-pin refusal', () => {
    const { root, source, output } = fixture();
    const bin = join(root, 'bin');
    const remote = join(root, 'release');
    mkdirSync(bin);
    mkdirSync(remote);
    const gh = join(bin, 'gh');
    writeFileSync(
      gh,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const root = process.env.FAKE_RELEASE;
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify(args) + '\\n');
const asset = path.join(root, 'lifemodel-installer-${tag}.tar.gz');
const release = path.join(root, 'exists');
if (args[0] !== 'release' || args[2] !== '${tag}') process.exit(64);
switch (args[1]) {
  case 'view':
    if (!fs.existsSync(release)) process.exit(1);
    if (args.includes('--json') && fs.existsSync(asset)) console.log(path.basename(asset));
    break;
  case 'create':
    if (fs.existsSync(release)) process.exit(1);
    fs.writeFileSync(release, 'release');
    break;
  case 'upload':
    if (fs.existsSync(asset) && !args.includes('--clobber')) process.exit(1);
    fs.copyFileSync(args[3], asset);
    break;
  case 'download':
    fs.copyFileSync(asset, path.join(args[args.indexOf('--dir') + 1], path.basename(asset)));
    break;
  default: process.exit(64);
}
`
    );
    chmodSync(gh, 0o755);
    const prepare = (pin: string) =>
      command('sh', [
        join(source, 'scripts/release/prepare-installer-bundle.sh'),
        tag,
        pin,
        output,
      ]);
    expect(prepare(digest).status).toBe(0);
    const asset = join(output, `lifemodel-installer-${tag}.tar.gz`);
    // Run the actual workflow publication boundary, not a parallel test implementation.
    const workflow = YAML.parse(readFileSync('.github/workflows/release.yml', 'utf8'));
    const publish = workflow.jobs['installer-release'].steps.find(
      (step: any) => step.name === 'Publish the versioned installer asset'
    );
    const runner = join(root, 'runner');
    mkdirSync(join(runner, 'installer'), { recursive: true });
    const publishRun = (pin: string) => {
      cpSync(asset, join(runner, 'installer', `lifemodel-installer-${tag}.tar.gz`));
      return spawnSync('bash', ['-c', publish.run], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TAG: tag,
          PLATFORM_DIGEST: pin,
          RUNNER_TEMP: runner,
          FAKE_RELEASE: remote,
          GH_TOKEN: 'fake-local-token',
          GH_REPO: 'local/fixture',
        },
      });
    };
    const first = publishRun(digest);
    expect(first.status, first.stderr).toBe(0);
    const remoteAsset = join(remote, `lifemodel-installer-${tag}.tar.gz`);
    const original = readFileSync(remoteAsset);
    expect(original).toEqual(readFileSync(asset));
    // Different bundle bytes, same verified pin: retry must not replace original.
    writeFileSync(join(source, 'deploy/cli/lifemodel.mjs'), '// rebuilt same pin\n', { flag: 'a' });
    rmSync(asset);
    expect(prepare(digest).status).toBe(0);
    expect(readFileSync(asset)).not.toEqual(original);
    const retry = publishRun(digest);
    expect(retry.status, retry.stderr).toBe(0);
    expect(readFileSync(remoteAsset)).toEqual(original);
    rmSync(asset);
    const otherDigest = `sha256:${'b'.repeat(64)}`;
    expect(prepare(otherDigest).status).toBe(0);
    const different = publishRun(otherDigest);
    expect(different.status, different.stderr).not.toBe(0);
    expect(different.stderr).toContain('different platform pin');
    expect(readFileSync(remoteAsset)).toEqual(original);
    const calls = readFileSync(join(remote, 'calls'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.filter((args) => args[1] === 'upload')).toHaveLength(1);
    expect(calls.some((args) => args.includes('--clobber'))).toBe(false);
    expect(calls.filter((args) => args[1] === 'create')).toHaveLength(1);
  }, 60_000);

  it('extracts into a clean directory and renders the stamped digest without release or identity arguments', () => {
    const { root, source, output } = fixture();
    const result = command('sh', [
      join(source, 'scripts/release/prepare-installer-bundle.sh'),
      tag,
      digest,
      output,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const archive = join(output, `lifemodel-installer-${tag}.tar.gz`);
    expect(existsSync(archive)).toBe(true);
    const clean = join(root, 'clean');
    mkdirSync(clean);
    expect(command('tar', ['-xzf', archive, '-C', clean]).status).toBe(0);
    rmSync(source, { recursive: true });
    expect(readdirSync(clean).sort()).toEqual(['deploy', 'scripts']);
    for (const name of ['lifemodel.mjs', 'wait-ready.mjs']) {
      expect(existsSync(join(clean, 'deploy/cli', name)), name).toBe(true);
    }
    const smoke = command(
      'sh',
      ['scripts/release/smoke-installer-bundle.sh', archive, digest],
      process.cwd()
    );
    expect(smoke.status, smoke.stderr).toBe(0);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'ip'),
      `#!/bin/sh
printf '[{"dev":"eth0"}]\\n'
`
    );
    chmodSync(join(bin, 'ip'), 0o755);
    const render = join(root, 'render');
    const rendered = spawnSync('sh', [join(clean, 'scripts/install.sh'), '--render-only', render], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LIFEMODEL_INSTANCE_ENV: join(root, 'absent'),
      },
    });
    expect(rendered.status, rendered.stderr).toBe(0);
    const oci = YAML.parse(readFileSync(join(render, 'ocirepository.yaml'), 'utf8'));
    expect(oci.spec.url).toBe('oci://ghcr.io/shady2k/lifemodel-platform');
    expect(oci.spec.ref).toEqual({ digest });
    expect(oci.spec.verify.provider).toBe('cosign');
    expect(oci.spec.verify.matchOIDCIdentity).toHaveLength(1);
    const instance = YAML.parse(readFileSync(join(render, 'instance.yaml'), 'utf8'));
    expect(instance.data.LIFEMODEL_NAME).toBe('lifemodel');
    expect(
      readFileSync(join(render, 'systemd/lifemodel-mdns-boot-lifemodel-local.service'), 'utf8')
    ).toContain('boot-lifemodel.local eth0');
  }, 60_000);

  it('checks the source release tag before publication and can stamp a prepared source tree', () => {
    const { source } = fixture();
    const stamp = join(source, 'scripts/release/stamp-release-tag.sh');
    const sourceTag = readFileSync(join(source, 'deploy/nixos/release-tag'), 'utf8').trim();
    const valid = command('sh', [stamp, sourceTag, '--check-source']);
    expect(valid.status, valid.stderr).toBe(0);
    const mismatch = command('sh', [stamp, tag, '--check-source']);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain('must match the tagged source');
    expect(readFileSync(join(source, 'deploy/nixos/release-tag'), 'utf8').trim()).toBe(sourceTag);
    const stamped = command('sh', [stamp, tag]);
    expect(stamped.status, stamped.stderr).toBe(0);
    expect(readFileSync(join(source, 'deploy/nixos/release-tag'), 'utf8')).toBe(`${tag}\n`);
  });

  it.each(['v1&bad', 'v1;bad', '../bad', 'v', 'v1\nbad'])(
    'rejects an unsafe release tag %j',
    (invalid) => {
      const { source, output } = fixture();
      const result = command('sh', [
        join(source, 'scripts/release/prepare-installer-bundle.sh'),
        invalid,
        digest,
        output,
      ]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('invalid release tag');
      expect(existsSync(output)).toBe(false);
    }
  );

  it.each(['sha256:abc', `sha256:${'g'.repeat(64)}`, 'other:abc'])(
    'rejects malformed platform digest %j',
    (invalid) => {
      const { source, output } = fixture();
      const result = command('sh', [
        join(source, 'scripts/release/prepare-installer-bundle.sh'),
        tag,
        invalid,
        output,
      ]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('invalid platform digest');
      expect(existsSync(output)).toBe(false);
    }
  );

  it('creates and uploads one versioned asset only after signed platform verification, without writing into the platform', () => {
    const workflow = YAML.parse(readFileSync('.github/workflows/release.yml', 'utf8'));
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const build = workflow.jobs.release;
    expect(build.permissions).toEqual({ contents: 'read', packages: 'write', 'id-token': 'write' });
    const upload = workflow.jobs['installer-release'];
    expect(upload.needs).toEqual(['release']);
    expect(upload.permissions).toEqual({ contents: 'write' });
    expect(build.outputs['platform-digest']).toBe('${{ steps.platform.outputs.digest }}');
    const prepare = upload.steps.find((step: any) =>
      step.run?.includes('prepare-installer-bundle.sh')
    );
    expect(prepare.env).toMatchObject({
      PLATFORM_DIGEST: '${{ needs.release.outputs.platform-digest }}',
      TAG: '${{ github.ref_name }}',
    });
    expect(prepare.run).toContain('smoke-installer-bundle.sh');
    expect(prepare.run).not.toContain('--help');
    const publish = upload.steps.find((step: any) =>
      step.run?.includes('publish-installer-bundle.sh')
    );
    expect(publish.env.GH_TOKEN).toBe('${{ github.token }}');
    expect(publish.env.PLATFORM_DIGEST).toBe('${{ needs.release.outputs.platform-digest }}');
    const publisher = readFileSync('scripts/release/publish-installer-bundle.sh', 'utf8');
    expect(publisher).toContain('gh release create');
    expect(publish.run).toContain('lifemodel-installer-$TAG.tar.gz');
    expect(publisher).toContain('gh release upload');
    const verifyIndex = build.steps.findIndex((step: any) => step.run?.includes('cosign verify'));
    expect(verifyIndex).toBeGreaterThan(
      build.steps.findIndex((step: any) => step.id === 'platform')
    );
    const digestSteps = build.steps.filter((step: any) =>
      Object.keys(step.env ?? {}).includes('PLATFORM_DIGEST')
    );
    expect(digestSteps).toEqual([]);
    const sourceTag = readFileSync('deploy/nixos/release-tag', 'utf8').trim();
    expect(sourceTag).toMatch(/^v[0-9][A-Za-z0-9._-]*$/);
    const stamp = build.steps.find((step: any) => step.run?.includes('stamp-release-tag.sh'));
    expect(stamp.env.TAG).toBe('${{ github.ref_name }}');
    expect(stamp.run).toContain('--check-source');
  });
});
