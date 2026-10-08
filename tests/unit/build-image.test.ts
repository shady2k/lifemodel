/**
 * scripts/build-image.sh, the one command that builds the instance image
 * (lifemodel-q4x.2.2).
 *
 * This script is what CI runs and what a person runs, so the two inputs it can
 * be missing — a checkout with no history to bundle and a checkout with no
 * loader/ — are refused by name, with a non-zero exit and no build started.
 * Nothing here runs docker: a stand-in earlier in PATH records whether it was
 * ever called.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
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
import { fileURLToPath } from 'node:url';

/** This checkout: the script and the docker/instance files under test. */
const checkout = fileURLToPath(new URL('../..', import.meta.url));
const script = join(checkout, 'scripts/build-image.sh');

interface Refusal {
  status: number;
  output: string;
  /** What the stand-in docker was asked to do, empty when it never ran. */
  dockerCalls: string;
  /** What is left in the clone's build context after the run, one name per line. */
  contextFiles: string;
}

/**
 * Runs the script in a throwaway clone of this checkout, with the script and
 * the image files as this branch has them (a clone carries the committed
 * state, not the working tree) and a stand-in docker first in PATH.
 */
function runInClone(
  options: { shallow?: boolean; withoutLoader?: boolean; withContext?: boolean } = {}
): Refusal {
  const workdir = mkdtempSync(join(tmpdir(), 'lifemodel-build-image-'));
  try {
    const clone = join(workdir, 'repo');
    if (options.shallow === true) {
      // A shallow clone needs file:// to be taken literally.
      execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${checkout}`, clone]);
    } else {
      execFileSync('git', ['clone', '--quiet', '--shared', checkout, clone]);
    }
    mkdirSync(join(clone, 'docker/instance'), { recursive: true });
    cpSync(join(checkout, 'docker/instance'), join(clone, 'docker/instance'), { recursive: true });
    cpSync(join(checkout, '.dockerignore'), join(clone, '.dockerignore'));
    cpSync(script, join(clone, 'scripts/build-image.sh'));
    if (options.withoutLoader === true) {
      rmSync(join(clone, 'loader'), { recursive: true, force: true });
    }
    if (options.withContext === true) {
      // A build context that is already there: a stale one, or a person's own.
      mkdirSync(join(clone, '.docker-context'), { recursive: true });
      writeFileSync(join(clone, '.docker-context/seed.bundle'), "a person's own file\n");
    }

    // The stand-in docker: it records the call and fails, so a script that got
    // as far as building would be visible in both places.
    const bin = join(workdir, 'bin');
    const calls = join(workdir, 'docker-calls');
    mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$@" >> ${calls}\nexit 1\n`, {
      mode: 0o755,
    });

    let status = 0;
    let output = '';
    try {
      output = execFileSync('sh', [join(clone, 'scripts/build-image.sh')], {
        cwd: clone,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      status = failure.status ?? -1;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    const context = join(clone, '.docker-context');
    return {
      status,
      output,
      dockerCalls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
      contextFiles: existsSync(context) ? readdirSync(context).join('\n') : '',
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

describe('scripts/build-image.sh', () => {
  it('refuses a shallow checkout, naming the cause, and builds nothing', () => {
    const refusal = runInClone({ shallow: true });

    expect(refusal.status).toBe(2);
    expect(refusal.output).toContain('build-image:');
    expect(refusal.output).toContain('shallow');
    expect(refusal.output).toContain('git fetch --unshallow');
    expect(refusal.dockerCalls).toBe('');
  }, 60_000);

  it('refuses a checkout without loader/, naming the cause, and builds nothing', () => {
    const refusal = runInClone({ withoutLoader: true });

    expect(refusal.status).toBe(2);
    expect(refusal.output).toContain('build-image:');
    expect(refusal.output).toContain('no loader/');
    expect(refusal.dockerCalls).toBe('');
  }, 60_000);

  it('refuses a build context that is already there, and deletes nothing in it', () => {
    // The script removes only what it made itself (rework 2, finding 8): a
    // `.docker-context` that existed before the run is refused by name and left
    // exactly as it was, and no build starts.
    const refusal = runInClone({ withContext: true });

    expect(refusal.status).toBe(2);
    expect(refusal.output).toContain('build-image:');
    expect(refusal.output).toContain('.docker-context already exists');
    expect(refusal.output).toContain('nothing was deleted');
    expect(refusal.dockerCalls).toBe('');
    expect(refusal.contextFiles).toBe('seed.bundle');
  }, 60_000);

  it('removes the context it made itself, and nothing else', () => {
    // The other half: a run that gets as far as the build removes its own
    // context on the way out (the stand-in docker fails, so nothing is built).
    const refusal = runInClone();

    expect(refusal.status).not.toBe(0);
    expect(refusal.dockerCalls).toContain('build');
    expect(refusal.contextFiles).toBe('');
  }, 60_000);
});
