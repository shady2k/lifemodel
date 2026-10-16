import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const preparerPath = fileURLToPath(
  new URL('../../scripts/release/prepare-loader-context.sh', import.meta.url)
);

function runPreparer(options: { commit: boolean; existingContext?: boolean }): {
  status: number;
  contextExists: boolean;
  contextContents: string[];
} {
  const temporary = mkdtempSync(join(tmpdir(), 'lifemodel-release-seed-'));
  const repo = join(temporary, 'repo');
  try {
    mkdirSync(join(repo, 'scripts/release'), { recursive: true });
    mkdirSync(join(repo, 'loader'));
    cpSync(preparerPath, join(repo, 'scripts/release/prepare-loader-context.sh'));
    execFileSync('git', ['init', '--quiet', repo]);
    if (options.commit) {
      const seedFile = join(repo, 'deploy/platform/applications/lifemodel/kustomization.yaml');
      mkdirSync(join(repo, 'deploy/platform/applications/lifemodel'), { recursive: true });
      writeFileSync(
        seedFile,
        `apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - core.yaml\nimages:\n  - name: ghcr.io/shady2k/lifemodel-core\n    newName: ghcr.io/shady2k/lifemodel-core\n    digest: sha256:${'a'.repeat(64)}\n`
      );
      writeFileSync(
        join(repo, 'deploy/platform/applications/lifemodel/core.yaml'),
        'apiVersion: v1\nkind: Pod\n'
      );
      execFileSync('git', ['-C', repo, 'add', 'deploy']);
      execFileSync('git', [
        '-C',
        repo,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--quiet',
        '-m',
        'seed',
      ]);
    }
    const context = join(repo, '.docker-context');
    if (options.existingContext) {
      mkdirSync(context);
      writeFileSync(join(context, 'owner-file'), 'keep');
    }
    let status = 0;
    try {
      execFileSync('sh', [join(repo, 'scripts/release/prepare-loader-context.sh')], {
        cwd: repo,
        stdio: 'pipe',
      });
    } catch (error) {
      status = (error as { status?: number }).status ?? -1;
    }
    return {
      status,
      contextExists: existsSync(context),
      contextContents: existsSync(context) ? readdirSync(context).sort() : [],
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

describe('loader image release seed bundle', () => {
  it('prepares the full-history bundle before the release workflow builds the loader', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');
    const prepare = workflow.indexOf('scripts/release/prepare-loader-context.sh');
    const build = workflow.indexOf('file: docker/loader/Dockerfile');
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(prepare);
    const coreBuild = workflow.indexOf('id: core');
    const digestPin = workflow.indexOf('run: scripts/release/set-core-digest.sh');
    const loaderBuild = workflow.indexOf('file: docker/loader/Dockerfile');
    const artifactPush = workflow.indexOf('flux push artifact');
    expect(coreBuild).toBeGreaterThanOrEqual(0);
    expect(coreBuild).toBeLessThan(digestPin);
    expect(digestPin).toBeLessThan(prepare);
    expect(prepare).toBeLessThan(loaderBuild);
    expect(loaderBuild).toBeLessThan(artifactPush);
    const pinStep = workflow.slice(
      workflow.lastIndexOf('name: Pin the core image', digestPin),
      digestPin
    );
    expect(pinStep).toContain('CORE_DIGEST: ${{ steps.core.outputs.digest }}');
  });

  it('includes the prepared history bundle in the platform loader image only', async () => {
    const dockerfile = await readFile('docker/loader/Dockerfile', 'utf8');
    const ignore = await readFile('.dockerignore', 'utf8');
    const prepareScript = await readFile('scripts/release/prepare-loader-context.sh', 'utf8');
    expect(dockerfile).toContain(
      'COPY --chown=root:root .docker-context/seed.bundle /opt/lifemodel/seed.bundle'
    );
    expect(ignore).toContain('!.docker-context');
    expect(ignore).toContain('!.docker-context/**');
    for (const deny of [
      '**/.env',
      '**/.git/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
    ])
      expect(ignore).toContain(deny);
    expect(ignore).not.toContain('docker/instance');
    expect(prepareScript).toContain('git bundle create "$context/seed.bundle" HEAD');
    expect(prepareScript).toContain('commit-tree');
    expect(prepareScript).toContain('source_commit');
    expect(prepareScript).toContain('git bundle verify "$context/seed.bundle"');
  });

  it('checks out full history and always cleans the prepared context after loader build', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');
    const checkout = workflow.indexOf('uses: actions/checkout@');
    const login = workflow.indexOf('name: Log in to GitHub Container Registry');
    const build = workflow.indexOf('name: Build and push loader image');
    const cleanup = workflow.indexOf('name: Remove the temporary loader build context');
    expect(workflow.slice(checkout, login)).toContain('fetch-depth: 0');
    expect(cleanup).toBeGreaterThan(build);
    expect(workflow.slice(cleanup, workflow.indexOf('name: Pin the loader image'))).toContain(
      'if: always()'
    );
    expect(workflow.slice(cleanup, workflow.indexOf('name: Pin the loader image'))).not.toContain(
      'steps.prepare-seed.outcome'
    );
  });

  it('carries the pushed core digest through the seed bundle into both rendered pod images', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'lifemodel-release-render-'));
    const repo = join(temporary, 'repo');
    const clone = join(temporary, 'clone');
    const digest = `sha256:${'b'.repeat(64)}`;
    try {
      mkdirSync(join(repo, 'scripts/release'), { recursive: true });
      mkdirSync(join(repo, 'loader'));
      mkdirSync(join(repo, 'deploy/platform/applications/lifemodel'), { recursive: true });
      cpSync(preparerPath, join(repo, 'scripts/release/prepare-loader-context.sh'));
      writeFileSync(
        join(repo, 'deploy/platform/applications/lifemodel/kustomization.yaml'),
        `apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n  - core.yaml\nimages:\n  - name: ghcr.io/shady2k/lifemodel-core\n    newName: ghcr.io/shady2k/lifemodel-core\n    digest: ${digest}\n`
      );
      writeFileSync(
        join(repo, 'deploy/platform/applications/lifemodel/core.yaml'),
        `apiVersion: apps/v1\nkind: StatefulSet\nmetadata: {name: core}\nspec:\n  template:\n    spec:\n      initContainers: [{name: migrate, image: ghcr.io/shady2k/lifemodel-core:main}]\n      containers: [{name: core, image: ghcr.io/shady2k/lifemodel-core:main}]\n`
      );
      execFileSync('git', ['init', '-b', 'main', repo]);
      execFileSync('git', ['-C', repo, 'add', 'deploy']);
      execFileSync('git', [
        '-C',
        repo,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--quiet',
        '-m',
        'tagged source',
      ]);
      const source = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      execFileSync('sh', [join(repo, 'scripts/release/prepare-loader-context.sh')], {
        cwd: repo,
        stdio: 'pipe',
      });
      const bundle = join(repo, '.docker-context/seed.bundle');
      execFileSync('git', ['clone', bundle, clone], { stdio: 'pipe' });
      const seedHead = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      expect(
        execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim()
      ).toBe(source);
      const seedKustomization = execFileSync(
        'git',
        ['-C', clone, 'show', 'HEAD:deploy/platform/applications/lifemodel/kustomization.yaml'],
        { encoding: 'utf8' }
      );
      const seedResource = execFileSync(
        'git',
        ['-C', clone, 'show', 'HEAD:deploy/platform/applications/lifemodel/core.yaml'],
        { encoding: 'utf8' }
      );
      const { parse, parseAllDocuments } = await import('yaml');
      const imagePin = parse(seedKustomization).images.find(
        (image: any) => image.name === 'ghcr.io/shady2k/lifemodel-core'
      );
      const resources = parseAllDocuments(seedResource).map((doc) => doc.toJSON());
      const pod = resources.find((resource: any) => resource.kind === 'StatefulSet').spec.template
        .spec;
      const renderedImage = `${imagePin.newName}@${imagePin.digest}`;
      const images = [...pod.initContainers, ...pod.containers].map((container: any) =>
        container.image.replace(/:[^/:]+$/, `@${imagePin.digest}`)
      );
      expect(seedHead).not.toBe(source);
      expect(imagePin.digest).toBe(digest);
      expect(images).toEqual([renderedImage, renderedImage]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('removes its newly created context when bundle preparation fails', async () => {
    const result = runPreparer({ commit: false });
    expect(result.status).not.toBe(0);
    expect(result.contextExists).toBe(false);
  });

  it('refuses to seed a zero or placeholder core digest', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'lifemodel-release-zero-digest-'));
    const repo = join(temporary, 'repo');
    try {
      mkdirSync(join(repo, 'scripts/release'), { recursive: true });
      mkdirSync(join(repo, 'loader'));
      mkdirSync(join(repo, 'deploy/platform/applications/lifemodel'), { recursive: true });
      cpSync(preparerPath, join(repo, 'scripts/release/prepare-loader-context.sh'));
      writeFileSync(
        join(repo, 'deploy/platform/applications/lifemodel/kustomization.yaml'),
        `images:\n  - name: ghcr.io/shady2k/lifemodel-core\n    digest: sha256:${'0'.repeat(64)}\n`
      );
      execFileSync('git', ['init', '-b', 'main', repo]);
      execFileSync('git', ['-C', repo, 'add', 'deploy']);
      execFileSync('git', [
        '-C',
        repo,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--quiet',
        '-m',
        'tagged source',
      ]);
      let status = 0;
      try {
        execFileSync('sh', [join(repo, 'scripts/release/prepare-loader-context.sh')], {
          cwd: repo,
          stdio: 'pipe',
        });
      } catch (error) {
        status = (error as { status?: number }).status ?? -1;
      }
      expect(status).not.toBe(0);
      expect(existsSync(join(repo, '.docker-context'))).toBe(false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('refuses a pre-existing context without deleting it', async () => {
    const result = runPreparer({ existingContext: true });
    expect(result.status).toBe(2);
    expect(result.contextContents).toEqual(['owner-file']);
  });

  it('leaves the verified bundle in place after successful preparation', async () => {
    const result = runPreparer({ commit: true });
    expect(result.status).toBe(0);
    expect(result.contextContents).toEqual(['seed.bundle']);
  });

  it('removes its context when interrupted during bundle creation', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'lifemodel-release-interrupt-'));
    const repo = join(temporary, 'repo');
    const bin = join(temporary, 'bin');
    const marker = join(temporary, 'bundle-started');
    mkdirSync(join(repo, 'scripts/release'), { recursive: true });
    mkdirSync(join(repo, 'loader'));
    mkdirSync(bin);
    cpSync(preparerPath, join(repo, 'scripts/release/prepare-loader-context.sh'));
    execFileSync('git', ['init', '--quiet', repo]);
    const seedDirectory = join(repo, 'deploy/platform/applications/lifemodel');
    mkdirSync(seedDirectory, { recursive: true });
    writeFileSync(
      join(seedDirectory, 'kustomization.yaml'),
      `images:\n  - name: ghcr.io/shady2k/lifemodel-core\n    digest: sha256:${'c'.repeat(64)}\n`
    );
    execFileSync('git', ['-C', repo, 'add', 'deploy']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--quiet',
      '-m',
      'seed',
    ]);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nif [ "$1" = bundle ]; then : > "${marker}"; exec sleep 30; fi\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 }
    );
    const child = spawn('sh', [join(repo, 'scripts/release/prepare-loader-context.sh')], {
      cwd: repo,
      detached: true,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdio: 'ignore',
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const watcher = watch(temporary, (_event, filename) => {
          if (filename === 'bundle-started') {
            watcher.close();
            resolve();
          }
        });
        const timeout = setTimeout(() => {
          watcher.close();
          reject(new Error('preparer never started bundle creation'));
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          watcher.close();
          reject(new Error('preparer exited before bundle creation'));
        });
      });
      process.kill(-child.pid!, 'SIGTERM');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      expect(existsSync(join(repo, '.docker-context'))).toBe(false);
    } finally {
      if (child.exitCode === null) {
        process.kill(-child.pid!, 'SIGKILL');
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
      rmSync(temporary, { recursive: true, force: true });
    }
  });
});
