import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import dockerignore from '@balena/dockerignore';

const preparerPath = fileURLToPath(
  new URL('../../scripts/release/prepare-loader-context.sh', import.meta.url)
);

const originPin = 'deploy/platform/a0/workbench-origin.env';
const workbenchRepository = 'zot.lifemodel-system.svc:5001/lifemodel/workbench';
const originEnv = (digest: string) => `LIFEMODEL_WORKBENCH_DIGEST=${digest}\n`;
const workbenchPatch = (digest: string) => `patches:
  - target:
      kind: StatefulSet
      name: core
    patch: |-
      - op: add
        path: /spec/template/spec/containers/0/env/-
        value:
          name: LIFEMODEL_TASK_WORKBENCH_IMAGE
          value: ${workbenchRepository}@${digest}
`;

function runPreparer(options: {
  commit: boolean;
  existingContext?: boolean;
  release?: boolean;
  origin?:
    | 'valid'
    | 'zero'
    | 'matching zero'
    | 'tag'
    | 'origin reference instead of digest'
    | 'untracked'
    | 'deleted'
    | 'mismatched'
    | 'missing local pin'
    | 'duplicate';
}): {
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
      if (options.origin) {
        mkdirSync(join(repo, 'deploy/platform/a0'), { recursive: true });
        writeFileSync(join(repo, originPin), originEnv(`sha256:${'b'.repeat(64)}`));
        if (options.origin !== 'missing local pin') {
          const localDigest = `sha256:${(options.origin === 'mismatched' ? 'c' : 'b').repeat(64)}`;
          writeFileSync(seedFile, readFileSync(seedFile, 'utf8') + workbenchPatch(localDigest));
        }
      }
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
    if (options.origin === 'untracked')
      execFileSync('git', ['-C', repo, 'rm', '--cached', originPin]);
    if (options.origin === 'deleted') rmSync(join(repo, originPin));
    if (options.origin === 'zero' || options.origin === 'matching zero')
      writeFileSync(join(repo, originPin), originEnv(`sha256:${'0'.repeat(64)}`));
    if (options.origin === 'matching zero') {
      const seedFile = join(repo, 'deploy/platform/applications/lifemodel/kustomization.yaml');
      writeFileSync(
        seedFile,
        readFileSync(seedFile, 'utf8').replaceAll('b'.repeat(64), '0'.repeat(64))
      );
    }
    if (options.origin === 'tag')
      writeFileSync(join(repo, originPin), `LIFEMODEL_WORKBENCH_DIGEST=latest\n`);
    if (options.origin === 'origin reference instead of digest')
      writeFileSync(
        join(repo, originPin),
        originEnv(`sha256:${'b'.repeat(64)}`).replace(
          'LIFEMODEL_WORKBENCH_DIGEST=',
          `LIFEMODEL_WORKBENCH_DIGEST=${workbenchRepository}@`
        )
      );
    if (options.origin === 'duplicate')
      writeFileSync(join(repo, originPin), originEnv(`sha256:${'b'.repeat(64)}`).repeat(2));
    const context = join(repo, '.docker-context');
    if (options.existingContext) {
      mkdirSync(context);
      writeFileSync(join(context, 'owner-file'), 'keep');
    }
    let status = 0;
    try {
      execFileSync(
        'sh',
        [
          join(repo, 'scripts/release/prepare-loader-context.sh'),
          ...(options.release ? ['--release'] : []),
        ],
        {
          cwd: repo,
          stdio: 'pipe',
        }
      );
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
  it('excludes arbitrary and credential names with the context matcher while admitting build inputs', async () => {
    const source = process.cwd();
    const temporary = mkdtempSync(join(tmpdir(), 'lifemodel-docker-context-'));
    const repo = join(temporary, 'repo');
    try {
      cpSync(source, repo, {
        recursive: true,
        filter: (path) =>
          !path.includes('/node_modules') && !path.includes('/.git') && !path.includes('/data'),
      });
      const directories = [
        '.',
        'docker',
        'docker/loader',
        'loader',
        'loader/src',
        'web',
        'web/kit',
        'web/kit/components',
        'web/kit/components/ui',
        'web/kit/hooks',
        'web/kit/lib',
        'web/kit/registry-lock',
        'web/kit/registry-lock/files',
        'web/kit/registry-lock/files/components',
        'web/kit/registry-lock/files/components/ui',
        'web/kit/registry-lock/files/hooks',
        'web/kit/registry-lock/files/lib',
        'web/loader',
        'web/loader/src',
        'web/loader/public',
        '.docker-context',
      ];
      const names = [
        '.npmrc',
        '.env',
        'id_rsa',
        'x.pem',
        'private.key',
        'notes.txt',
        'backup.json',
        'dump.sql',
      ];
      const planted = directories.flatMap((directory) => {
        mkdirSync(join(repo, directory), { recursive: true });
        return names.map((name) => join(directory, name));
      });
      for (const path of planted) writeFileSync(join(repo, path), 'SYNTHETIC_CREDENTIAL');
      const filter = dockerignore({ ignorecase: false }).add(
        await readFile(join(repo, '.dockerignore'), 'utf8')
      );
      const candidates = [
        'web/loader/src/App.tsx',
        'web/loader/index.html',
        'web/loader/public/favicon.svg',
        'web/kit/theme.css',
        'web/kit/components/ui/card.tsx',
        'web/kit/hooks/use-mobile.ts',
        'web/kit/lib/utils.ts',
        'web/kit/lib/highlighter.tsx',
        'web/loader/src/index.css',
        'web/loader/vite.config.ts',
        'web/loader/tsconfig.json',
        'web/loader/package.json',
        'package.json',
        'package-lock.json',
        'loader/package-lock.json',
        'loader/tsconfig.json',
        'loader/src/http.ts',
        'loader/package.json',
        'docker/loader/Dockerfile',
        'docker/loader/lifemodel-storage',
        'src/web/model-status.ts',
        'src/web/contract.ts',
        '.docker-context/seed.bundle',
      ];
      const admitted = (path: string) => !filter.ignores(path);
      for (const path of candidates) expect(admitted(path), path).toBe(true);
      for (const path of planted) expect(admitted(path), path).toBe(false);
      expect(admitted('web/loader/public/.npmrc')).toBe(false);
      // The loader UI admits only the two shared modules it imports, by name.
      expect(admitted('src/web/index.ts')).toBe(false);
      expect(admitted('src/web/server.ts')).toBe(false);
      expect(admitted('src/web/model-status-poller.ts')).toBe(false);
      expect(admitted('.docker-context/seed.bundle')).toBe(true);
      expect(admitted('.docker-context/other-file')).toBe(false);
      const publicFiles = readdirSync(join(repo, 'web/loader/public'));
      expect(publicFiles).toContain('favicon.svg');
      expect(publicFiles.filter((name) => admitted(`web/loader/public/${name}`))).toEqual([
        'favicon.svg',
      ]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('copies only named UI inputs and never a public directory into ui-build', async () => {
    const dockerfile = await readFile('docker/loader/Dockerfile', 'utf8');
    const uiBuild = dockerfile.split(' AS ui-build\n')[1].split(/^FROM /m)[0];
    const sources = [...uiBuild.matchAll(/^COPY (.+) \S+$/gm)].flatMap((match) =>
      match[1].split(/\s+/)
    );
    expect(sources).toEqual([
      'package.json',
      'package-lock.json',
      'web/kit/theme.css',
      'web/kit/components/ui/*.tsx',
      'web/kit/hooks/*.ts',
      'web/kit/lib/*.ts',
      'web/kit/lib/*.tsx',
      'web/loader/index.html',
      'web/loader/vite.config.ts',
      'web/loader/tsconfig.json',
      'web/loader/package.json',
      'web/loader/src/',
      'web/loader/public/favicon.svg',
      'src/web/model-status.ts',
      'src/web/contract.ts',
      'src/ports/message-attachment.ts',
      'loader/src/settings/registry.ts',
      'loader/src/workbench-status.ts',
    ]);
  });

  it('prepares the full-history bundle before the release workflow builds the loader', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');
    const prepare = workflow.indexOf('scripts/release/prepare-loader-context.sh');
    const build = workflow.indexOf('file: docker/loader/Dockerfile');
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(workflow).toContain('run: scripts/release/prepare-loader-context.sh --release');
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
    expect(ignore).toContain('!.docker-context/seed.bundle');
    expect(ignore).not.toContain('!.docker-context/**');
    for (const deny of ['**/.env', '**/.git*', '**/id_*', '**/*.pem', '**/*.key', '**/.npmrc'])
      expect(ignore).toContain(deny);
    expect(ignore).not.toContain('docker/instance');
    // Docker re-includes a directory's entire contents; the JS matcher is not authoritative.
    // Pin this rule directly as well as checking individual candidate paths.
    expect(ignore.split('\n').filter((line) => line.startsWith('!'))).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/\/$/)])
    );
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

  it('carries pushed core and both workbench pins into the seed bundle while retaining source history', async () => {
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
      mkdirSync(join(repo, 'deploy/platform/a0'), { recursive: true });
      writeFileSync(join(repo, originPin), originEnv(`sha256:${'0'.repeat(64)}`));
      execFileSync('git', ['-C', repo, 'add', originPin]);
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
        'source origin placeholder',
      ]);
      const source = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      const overlayFile = join(repo, 'deploy/platform/applications/lifemodel/kustomization.yaml');
      writeFileSync(overlayFile, readFileSync(overlayFile, 'utf8') + workbenchPatch(digest));
      writeFileSync(join(repo, originPin), originEnv(digest));
      execFileSync('sh', [join(repo, 'scripts/release/prepare-loader-context.sh'), '--release'], {
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
      expect(seedKustomization).toContain(`${workbenchRepository}@${digest}`);
      expect(
        execFileSync('git', ['-C', clone, 'show', `HEAD:${originPin}`], { encoding: 'utf8' })
      ).toBe(originEnv(digest));
      expect(
        execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      ).toBe(source);
      expect(
        execFileSync('git', ['-C', repo, 'show', `HEAD:${originPin}`], { encoding: 'utf8' })
      ).toBe(originEnv(`sha256:${'0'.repeat(64)}`));
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

  describe.each([false, true])('workbench pin validation with release=%s', (release) => {
    it.each([
      'zero',
      'tag',
      'origin reference instead of digest',
      'untracked',
      'deleted',
      'mismatched',
      'missing local pin',
      'duplicate',
    ] as const)('refuses a %s workbench origin pin and removes its context', (origin) => {
      const result = runPreparer({ commit: true, origin, release });
      expect(result.status).toBe(2);
      expect(result.contextExists).toBe(false);
    });

    it('accepts a tracked, nonzero origin pin matching the local workbench pin', () => {
      const result = runPreparer({ commit: true, origin: 'valid', release });
      expect(result.status).toBe(0);
      expect(result.contextContents).toEqual(['seed.bundle']);
    });
  });

  it('accepts matching zero workbench placeholders for the unpublished CI loader build', () => {
    const result = runPreparer({ commit: true, origin: 'matching zero' });
    expect(result.status).toBe(0);
    expect(result.contextContents).toEqual(['seed.bundle']);
  });

  it('refuses matching zero workbench placeholders for a release and removes its context', () => {
    const result = runPreparer({ commit: true, origin: 'matching zero', release: true });
    expect(result.status).toBe(2);
    expect(result.contextExists).toBe(false);
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
