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
    const publish = upload.steps.find((step: any) => step.run?.includes('gh release upload'));
    expect(publish.env.GH_TOKEN).toBe('${{ github.token }}');
    expect(publish.run).toContain('gh release create');
    expect(publish.run).toContain('lifemodel-installer-$TAG.tar.gz');
    expect(publish.run).toContain('gh release upload');
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
