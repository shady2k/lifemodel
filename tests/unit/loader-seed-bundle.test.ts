import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const preparerPath = fileURLToPath(new URL('../../scripts/release/prepare-loader-context.sh', import.meta.url));

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
      writeFileSync(join(repo, 'tracked-file'), 'seed');
      execFileSync('git', ['-C', repo, 'add', 'tracked-file']);
      execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'seed']);
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
    expect(workflow.slice(prepare - 160, build)).toContain(
      'run: scripts/release/prepare-loader-context.sh'
    );
  });

  it('lets the prepared bundle into the loader image and shares bundle creation with the instance builder', async () => {
    const dockerfile = await readFile('docker/loader/Dockerfile', 'utf8');
    const ignore = await readFile('.dockerignore', 'utf8');
    const instanceBuilder = await readFile('scripts/build-image.sh', 'utf8');
    const prepareScript = await readFile('scripts/release/prepare-loader-context.sh', 'utf8');
    expect(dockerfile).toContain(
      'COPY --chown=root:root .docker-context/seed.bundle /opt/lifemodel/seed.bundle'
    );
    expect(ignore).toContain('!.docker-context');
    expect(ignore).toContain('!.docker-context/**');
    expect(instanceBuilder).toContain('scripts/release/prepare-loader-context.sh');
    expect(prepareScript).toContain('git bundle create "$context/seed.bundle" HEAD');
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

  it('removes its newly created context when bundle preparation fails', async () => {
    const result = runPreparer({ commit: false });
    expect(result.status).not.toBe(0);
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
    writeFileSync(join(repo, 'tracked-file'), 'seed');
    execFileSync('git', ['-C', repo, 'add', 'tracked-file']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'seed']);
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
