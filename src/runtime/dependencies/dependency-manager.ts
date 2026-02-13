/**
 * Dependency Manager — Pre-installs skill dependencies via prep containers.
 *
 * Skills declare npm/pip packages in policy.json. This module:
 * 1. Computes a content-addressed cache key (hash of packages + image + platform)
 * 2. On cache hit: returns the Docker volume name (instant)
 * 3. On cache miss: runs a prep container that installs into a named Docker volume
 * 4. Returns volume names for the runtime container to mount
 *
 * Uses Docker named volumes (not bind mounts) to avoid macOS com.apple.provenance
 * xattr issues entirely — files never touch the host filesystem.
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../../types/index.js';
import { CONTAINER_IMAGE } from '../container/types.js';

const execFileAsync = promisify(execFile);

// ─── Types ───────────────────────────────────────────────────────

export interface SkillDependencies {
  npm?: { packages: { name: string; version: string }[] } | undefined;
  pip?: { packages: { name: string; version: string }[] } | undefined;
}

export interface PreparedDeps {
  /** Docker volume name containing node_modules */
  npmDir?: string;
  /** Docker volume name containing site-packages */
  pipDir?: string;
  /** Container-side path for PYTHONPATH */
  pipPythonPath?: string;
}

// ─── Constants ───────────────────────────────────────────────────

/** Schema version — bump when install flags change to invalidate cache */
const CACHE_SCHEMA_VERSION = 1;

/** Volume name prefix */
const VOLUME_PREFIX = 'lifemodel-deps';

/** Stale lock threshold (10 minutes) */
const STALE_LOCK_THRESHOLD_MS = 10 * 60 * 1000;

/** Prep container timeout (5 minutes) */
const PREP_CONTAINER_TIMEOUT_MS = 5 * 60 * 1000;

// ─── Cache Hash ──────────────────────────────────────────────────

/**
 * Compute a deterministic, content-addressed hash for a set of dependencies.
 *
 * Includes: sorted package specs, ecosystem, image digest, platform, schema version.
 * Two skills with identical deps share the same cache entry.
 */
export function computeDepsHash(
  ecosystem: 'npm' | 'pip',
  packages: { name: string; version: string }[],
  imageId: string
): string {
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name));
  const canonical = JSON.stringify({
    schemaVersion: CACHE_SCHEMA_VERSION,
    ecosystem,
    packages: sorted.map((p) => ({ name: p.name, version: p.version })),
    imageId,
    platform: `${process.platform}-${process.arch}`,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ─── Image ID ────────────────────────────────────────────────────

async function getImageId(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', '{{.Id}}', CONTAINER_IMAGE],
      { timeout: 10_000 }
    );
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

// ─── Docker Volume ───────────────────────────────────────────────

async function volumeExists(volumeName: string): Promise<boolean> {
  try {
    await execFileAsync('docker', ['volume', 'inspect', volumeName], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check that a dependency volume is fully installed (not just created).
 *
 * Docker auto-creates named volumes when a container starts, even if the
 * install command fails. A host-side `.ready` marker (written only after
 * successful install) distinguishes "volume exists" from "install complete."
 */
function isVolumeReady(lockDir: string, ecosystem: string, hash: string): boolean {
  return existsSync(join(lockDir, `${ecosystem}-${hash}.ready`));
}

async function markVolumeReady(lockDir: string, ecosystem: string, hash: string): Promise<void> {
  await writeFile(join(lockDir, `${ecosystem}-${hash}.ready`), '', { flag: 'w' });
}

async function clearVolumeReady(lockDir: string, ecosystem: string, hash: string): Promise<void> {
  try {
    await rm(join(lockDir, `${ecosystem}-${hash}.ready`), { force: true });
  } catch {
    // Best-effort
  }
}

// ─── Lock File ───────────────────────────────────────────────────

async function acquireLock(lockPath: string): Promise<boolean> {
  try {
    if (existsSync(lockPath)) {
      const s = await stat(lockPath);
      if (Date.now() - s.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
        await rm(lockPath, { force: true });
      } else {
        return false;
      }
    }
    await writeFile(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await rm(lockPath, { force: true });
  } catch {
    // Best-effort
  }
}

// ─── Container Cleanup ───────────────────────────────────────────

async function removeContainer(name: string): Promise<void> {
  try {
    await execFileAsync('docker', ['rm', '-f', name], { timeout: 10_000 });
  } catch {
    // Best-effort
  }
}

// ─── Verification (exported for unit tests) ──────────────────────

/**
 * Verify that npm install produced the expected packages.
 * Checks: node_modules exists + each declared package has a subdirectory.
 */
export function verifyNpmInstall(
  tmpDir: string,
  packages: { name: string; version: string }[]
): void {
  const nodeModulesPath = join(tmpDir, 'node_modules');
  if (!existsSync(nodeModulesPath)) {
    throw new Error('npm install did not produce node_modules directory');
  }
  const missingPkgs = packages.filter((p) => !existsSync(join(nodeModulesPath, p.name)));
  if (missingPkgs.length > 0) {
    const names = missingPkgs.map((p) => `${p.name}@${p.version}`).join(', ');
    throw new Error(`npm install completed but missing packages: ${names}`);
  }
}

/**
 * Verify that pip install produced a non-empty site-packages directory.
 */
export async function verifyPipInstall(tmpDir: string): Promise<void> {
  const { readdir } = await import('node:fs/promises');
  const sitePackagesPath = join(tmpDir, 'site-packages');
  if (!existsSync(sitePackagesPath)) {
    throw new Error('pip install did not produce site-packages directory');
  }
  const entries = await readdir(sitePackagesPath);
  if (entries.length === 0) {
    throw new Error('pip install produced empty site-packages directory');
  }
}

// ─── Install: npm ────────────────────────────────────────────────

async function installNpm(
  packages: { name: string; version: string }[],
  lockDir: string,
  hash: string,
  _imageId: string,
  logger: Logger
): Promise<string> {
  const volumeName = `${VOLUME_PREFIX}-npm-${hash}`;

  // Cache check: volume exists AND was fully installed
  if (isVolumeReady(lockDir, 'npm', hash) && (await volumeExists(volumeName))) {
    logger.info({ hash, volumeName, ecosystem: 'npm' }, 'Dependency cache hit (volume exists)');
    return volumeName;
  }

  // Stale volume without ready marker — remove and re-install
  if (await volumeExists(volumeName)) {
    logger.warn({ hash, volumeName }, 'Removing stale npm volume (no ready marker)');
    try {
      await execFileAsync('docker', ['volume', 'rm', '-f', volumeName], { timeout: 10_000 });
    } catch {
      // Best-effort
    }
  }

  // Acquire lock (lock files are tiny, no bind-mount issue)
  const lockPath = join(lockDir, `npm-${hash}.lock`);
  const locked = await acquireLock(lockPath);
  if (!locked) {
    logger.info({ hash }, 'Waiting for concurrent npm install');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (isVolumeReady(lockDir, 'npm', hash) && (await volumeExists(volumeName))) {
      return volumeName;
    }
    throw new Error('Concurrent npm install did not complete');
  }

  const containerName = `prep-npm-${randomBytes(4).toString('hex')}`;

  try {
    // Build package.json content inline
    const deps: Record<string, string> = {};
    for (const pkg of packages) {
      deps[pkg.name] = pkg.version;
    }
    const packageJson = JSON.stringify({
      name: 'skill-deps',
      version: '1.0.0',
      dependencies: deps,
    });
    const escapedJson = packageJson.replace(/'/g, "'\\''");

    // Build verification: test -d for each declared package
    const verifyChecks = packages
      .map((p) => `test -d /workspace/node_modules/${p.name}`)
      .join(' && ');

    // Install into a named Docker volume — no host filesystem involvement.
    // Mount at /workspace (not a subdirectory) because Docker initializes new
    // named volumes with the image directory's ownership. The Dockerfile has
    // `RUN mkdir -p /workspace && chown node:node /workspace`, so the volume
    // starts writable by the non-root 'node' user.
    const args = [
      'run',
      '--name',
      containerName,
      '--entrypoint',
      'sh',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      '512m',
      '--pids-limit',
      '64',
      '--network',
      'bridge',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '-v',
      `${volumeName}:/workspace`,
      CONTAINER_IMAGE,
      '-c',
      `printf '%s' '${escapedJson}' > /workspace/package.json && cd /workspace && npm install --ignore-scripts --no-audit --no-fund --omit=optional 2>&1 && ${verifyChecks}`,
    ];

    logger.info(
      { hash, packageCount: packages.length, ecosystem: 'npm', containerName, volumeName },
      'Installing npm dependencies via prep container'
    );

    const { stdout, stderr } = await execFileAsync('docker', args, {
      timeout: PREP_CONTAINER_TIMEOUT_MS,
    });

    if (stdout) logger.debug({ output: stdout.slice(0, 500) }, 'npm install stdout');
    if (stderr) logger.debug({ output: stderr.slice(0, 500) }, 'npm install stderr');

    await markVolumeReady(lockDir, 'npm', hash);
    logger.info({ hash, volumeName, ecosystem: 'npm' }, 'npm dependencies cached in volume');
    return volumeName;
  } catch (error) {
    // Clean up the volume and ready marker on failure
    await clearVolumeReady(lockDir, 'npm', hash);
    try {
      await execFileAsync('docker', ['volume', 'rm', '-f', volumeName], { timeout: 10_000 });
    } catch {
      // Best-effort
    }
    throw error;
  } finally {
    await removeContainer(containerName);
    await releaseLock(lockPath);
  }
}

// ─── Install: pip ────────────────────────────────────────────────

async function installPip(
  packages: { name: string; version: string }[],
  lockDir: string,
  hash: string,
  _imageId: string,
  logger: Logger
): Promise<{ volumeName: string; pythonPath: string }> {
  const volumeName = `${VOLUME_PREFIX}-pip-${hash}`;

  // Cache check: volume exists AND was fully installed
  if (isVolumeReady(lockDir, 'pip', hash) && (await volumeExists(volumeName))) {
    logger.info({ hash, volumeName, ecosystem: 'pip' }, 'Dependency cache hit (volume exists)');
    return { volumeName, pythonPath: '/opt/skill-deps/pip/site-packages' };
  }

  // Stale volume without ready marker — remove and re-install
  if (await volumeExists(volumeName)) {
    logger.warn({ hash, volumeName }, 'Removing stale pip volume (no ready marker)');
    try {
      await execFileAsync('docker', ['volume', 'rm', '-f', volumeName], { timeout: 10_000 });
    } catch {
      // Best-effort
    }
  }

  // Acquire lock
  const lockPath = join(lockDir, `pip-${hash}.lock`);
  const locked = await acquireLock(lockPath);
  if (!locked) {
    logger.info({ hash }, 'Waiting for concurrent pip install');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (isVolumeReady(lockDir, 'pip', hash) && (await volumeExists(volumeName))) {
      return { volumeName, pythonPath: '/opt/skill-deps/pip/site-packages' };
    }
    throw new Error('Concurrent pip install did not complete');
  }

  const containerName = `prep-pip-${randomBytes(4).toString('hex')}`;

  try {
    // Install into named volume (mount at /workspace for correct ownership)
    const args = [
      'run',
      '--name',
      containerName,
      '--entrypoint',
      'sh',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      '512m',
      '--pids-limit',
      '64',
      '--network',
      'bridge',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '-v',
      `${volumeName}:/workspace`,
      CONTAINER_IMAGE,
      '-c',
      `printf '%s\\n' ${packages.map((p) => `'${p.name}==${p.version}'`).join(' ')} > /workspace/requirements.txt && pip install --target /workspace/site-packages --only-binary :all: -r /workspace/requirements.txt 2>&1 && test -d /workspace/site-packages && test $(ls /workspace/site-packages | wc -l) -gt 0`,
    ];

    logger.info(
      { hash, packageCount: packages.length, ecosystem: 'pip', containerName, volumeName },
      'Installing pip dependencies via prep container'
    );

    const { stdout, stderr } = await execFileAsync('docker', args, {
      timeout: PREP_CONTAINER_TIMEOUT_MS,
    });

    if (stdout) logger.debug({ output: stdout.slice(0, 500) }, 'pip install stdout');
    if (stderr) logger.debug({ output: stderr.slice(0, 500) }, 'pip install stderr');

    await markVolumeReady(lockDir, 'pip', hash);
    logger.info({ hash, volumeName, ecosystem: 'pip' }, 'pip dependencies cached in volume');
    return { volumeName, pythonPath: '/opt/skill-deps/pip/site-packages' };
  } catch (error) {
    await clearVolumeReady(lockDir, 'pip', hash);
    try {
      await execFileAsync('docker', ['volume', 'rm', '-f', volumeName], { timeout: 10_000 });
    } catch {
      // Best-effort
    }
    throw error;
  } finally {
    await removeContainer(containerName);
    await releaseLock(lockPath);
  }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Install skill dependencies (cache-first, prep container on miss).
 *
 * Returns PreparedDeps with Docker volume names. The runtime container
 * mounts these volumes (Docker treats non-absolute -v sources as named volumes).
 *
 * @param deps - Declared dependencies from policy.json
 * @param cacheBaseDir - Base directory for lock files
 * @param skillName - Skill name (for logging)
 * @param logger - Logger instance
 * @returns PreparedDeps with volume names, or null if no dependencies
 * @throws Error if installation fails (skill cannot run without its deps)
 */
export async function installSkillDependencies(
  deps: SkillDependencies,
  cacheBaseDir: string,
  skillName: string,
  logger: Logger
): Promise<PreparedDeps | null> {
  const log = logger.child({ component: 'dependency-manager', skill: skillName });

  const hasNpm = deps.npm && deps.npm.packages.length > 0;
  const hasPip = deps.pip && deps.pip.packages.length > 0;

  if (!hasNpm && !hasPip) {
    return null;
  }

  // Lock dir for concurrency control (tiny files, no bind-mount issue)
  await mkdir(cacheBaseDir, { recursive: true });
  const imageId = await getImageId();
  const result: PreparedDeps = {};

  if (hasNpm && deps.npm) {
    const hash = computeDepsHash('npm', deps.npm.packages, imageId);
    log.info({ hash, packages: deps.npm.packages }, 'Preparing npm dependencies');
    result.npmDir = await installNpm(deps.npm.packages, cacheBaseDir, hash, imageId, log);
  }

  if (hasPip && deps.pip) {
    const hash = computeDepsHash('pip', deps.pip.packages, imageId);
    log.info({ hash, packages: deps.pip.packages }, 'Preparing pip dependencies');
    const pipResult = await installPip(deps.pip.packages, cacheBaseDir, hash, imageId, log);
    result.pipDir = pipResult.volumeName;
    result.pipPythonPath = pipResult.pythonPath;
  }

  return result;
}
