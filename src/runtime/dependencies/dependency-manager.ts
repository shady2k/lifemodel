/**
 * Dependency Manager — Pre-installs skill dependencies via prep containers.
 *
 * Skills declare npm/pip packages in policy.json. This module:
 * 1. Computes a content-addressed cache key (hash of packages + image + platform)
 * 2. On cache hit: returns the cached directory paths (instant)
 * 3. On cache miss: runs a short-lived prep container to install packages
 * 4. Atomically publishes the result to the cache
 * 5. Returns mount paths for the runtime container
 *
 * The runtime container mounts these as read-only volumes with NODE_PATH/PYTHONPATH.
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, rename, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolve4 } from 'node:dns/promises';
import type { Logger } from '../../types/index.js';
import { CONTAINER_IMAGE } from '../container/types.js';

const execFileAsync = promisify(execFile);

// ─── Types ───────────────────────────────────────────────────────

export interface SkillDependencies {
  npm?: { packages: { name: string; version: string }[] } | undefined;
  pip?: { packages: { name: string; version: string }[] } | undefined;
}

export interface PreparedDeps {
  /** Path to cached node_modules dir (for bind mount) */
  npmDir?: string;
  /** Path to cached site-packages dir (for bind mount) */
  pipDir?: string;
  /** Dynamic site-packages path inside container (from python3 -c "import site; ...") */
  pipPythonPath?: string;
}

interface CacheManifest {
  schemaVersion: number;
  ecosystem: 'npm' | 'pip';
  hash: string;
  packages: { name: string; version: string }[];
  imageId: string;
  platform: string;
  installedAt: string;
  pythonPath?: string;
}

// ─── Constants ───────────────────────────────────────────────────

/** Schema version — bump when install flags change to invalidate cache */
const CACHE_SCHEMA_VERSION = 1;

/** npm registry hostname for DNS resolution */
const NPM_REGISTRY = 'registry.npmjs.org';

/** pip registry hostname for DNS resolution */
const PIP_REGISTRY = 'pypi.org';

/** Additional pip CDN hostname */
const PIP_FILES = 'files.pythonhosted.org';

/** Stale temp directory threshold (1 hour) */
const STALE_TMP_THRESHOLD_MS = 60 * 60 * 1000;

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

// ─── DNS Resolution ──────────────────────────────────────────────

async function resolveRegistryIps(
  hostnames: string[],
  logger: Logger
): Promise<Map<string, string[]>> {
  const resolved = new Map<string, string[]>();
  for (const hostname of hostnames) {
    try {
      const ips = await resolve4(hostname);
      resolved.set(hostname, ips);
      logger.debug({ hostname, ips }, 'Resolved registry DNS');
    } catch (error) {
      logger.warn({ hostname, error }, 'Failed to resolve registry DNS');
      // Don't fail — Docker's DNS may resolve it at runtime
    }
  }
  return resolved;
}

// ─── Cleanup ─────────────────────────────────────────────────────

/**
 * Clean up stale temp directories and lock files.
 */
async function cleanupStale(cacheDir: string, logger: Logger): Promise<void> {
  if (!existsSync(cacheDir)) return;

  try {
    const entries = await readdir(cacheDir);
    const now = Date.now();

    for (const entry of entries) {
      const fullPath = join(cacheDir, entry);

      // Clean stale tmp-* directories
      if (entry.startsWith('tmp-')) {
        try {
          const s = await stat(fullPath);
          if (now - s.mtimeMs > STALE_TMP_THRESHOLD_MS) {
            await rm(fullPath, { recursive: true, force: true });
            logger.debug({ path: fullPath }, 'Cleaned stale temp dir');
          }
        } catch {
          // Ignore
        }
      }

      // Clean stale lock files
      if (entry.endsWith('.lock')) {
        try {
          const s = await stat(fullPath);
          if (now - s.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
            await rm(fullPath, { force: true });
            logger.debug({ path: fullPath }, 'Cleaned stale lock file');
          }
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

// ─── Lock File ───────────────────────────────────────────────────

async function acquireLock(lockPath: string): Promise<boolean> {
  try {
    // Check for stale lock
    if (existsSync(lockPath)) {
      const s = await stat(lockPath);
      if (Date.now() - s.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
        await rm(lockPath, { force: true });
      } else {
        return false; // Lock held by another process
      }
    }
    await writeFile(lockPath, String(process.pid), { flag: 'wx' }); // Exclusive create
    return true;
  } catch {
    return false; // Lock exists or creation failed
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await rm(lockPath, { force: true });
  } catch {
    // Best-effort
  }
}

// ─── Install: npm ────────────────────────────────────────────────

async function installNpm(
  packages: { name: string; version: string }[],
  cacheDir: string,
  hash: string,
  imageId: string,
  logger: Logger
): Promise<string> {
  const ecosystemDir = join(cacheDir, 'npm');
  await mkdir(ecosystemDir, { recursive: true });

  // Check cache
  const cachePath = join(ecosystemDir, hash);
  if (existsSync(join(cachePath, 'manifest.json'))) {
    logger.info({ hash, ecosystem: 'npm' }, 'Dependency cache hit');
    return join(cachePath, 'node_modules');
  }

  // Clean stale entries
  await cleanupStale(ecosystemDir, logger);

  // Acquire lock
  const lockPath = join(ecosystemDir, `${hash}.lock`);
  const locked = await acquireLock(lockPath);
  if (!locked) {
    // Another process is installing — wait and check cache again
    logger.info({ hash }, 'Waiting for concurrent npm install');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (existsSync(join(cachePath, 'manifest.json'))) {
      return join(cachePath, 'node_modules');
    }
    throw new Error('Concurrent npm install did not complete');
  }

  try {
    // Create temp dir
    const tmpDir = join(ecosystemDir, `tmp-${randomBytes(4).toString('hex')}`);
    await mkdir(tmpDir, { recursive: true });

    // Write package.json
    const deps: Record<string, string> = {};
    for (const pkg of packages) {
      deps[pkg.name] = pkg.version;
    }
    await writeFile(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'skill-deps', version: '1.0.0', dependencies: deps }, null, 2)
    );

    // Resolve registry DNS
    const registryHosts = await resolveRegistryIps([NPM_REGISTRY], logger);

    // Build docker run args
    const args = [
      'run',
      '--rm',
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
      '--dns',
      '127.0.0.1',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '-v',
      `${tmpDir}:/deps:rw`,
    ];

    // Add --add-host entries for registry
    for (const [hostname, ips] of registryHosts.entries()) {
      for (const ip of ips) {
        args.push('--add-host', `${hostname}:${ip}`);
      }
    }

    args.push(
      CONTAINER_IMAGE,
      '-c',
      'cd /deps && npm install --ignore-scripts --no-audit --no-fund --no-optional 2>&1'
    );

    logger.info(
      { hash, packageCount: packages.length, ecosystem: 'npm' },
      'Installing npm dependencies via prep container'
    );

    const { stdout, stderr } = await execFileAsync('docker', args, {
      timeout: PREP_CONTAINER_TIMEOUT_MS,
    });

    if (stdout) logger.debug({ output: stdout.slice(0, 500) }, 'npm install stdout');
    if (stderr) logger.debug({ output: stderr.slice(0, 500) }, 'npm install stderr');

    // Verify node_modules was created
    if (!existsSync(join(tmpDir, 'node_modules'))) {
      throw new Error('npm install did not produce node_modules directory');
    }

    // Write manifest
    const manifest: CacheManifest = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      ecosystem: 'npm',
      hash,
      packages,
      imageId,
      platform: `${process.platform}-${process.arch}`,
      installedAt: new Date().toISOString(),
    };
    await writeFile(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Atomic rename
    await rename(tmpDir, cachePath);
    logger.info({ hash, cachePath, ecosystem: 'npm' }, 'npm dependencies cached');

    return join(cachePath, 'node_modules');
  } finally {
    await releaseLock(lockPath);
  }
}

// ─── Install: pip ────────────────────────────────────────────────

async function installPip(
  packages: { name: string; version: string }[],
  cacheDir: string,
  hash: string,
  imageId: string,
  logger: Logger
): Promise<{ pipDir: string; pythonPath: string }> {
  const ecosystemDir = join(cacheDir, 'pip');
  await mkdir(ecosystemDir, { recursive: true });

  // Check cache
  const cachePath = join(ecosystemDir, hash);
  if (existsSync(join(cachePath, 'manifest.json'))) {
    logger.info({ hash, ecosystem: 'pip' }, 'Dependency cache hit');
    const manifestRaw = await readFile(join(cachePath, 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw) as CacheManifest;
    return {
      pipDir: join(cachePath, 'site-packages'),
      pythonPath: manifest.pythonPath ?? '/deps/site-packages',
    };
  }

  // Clean stale entries
  await cleanupStale(ecosystemDir, logger);

  // Acquire lock
  const lockPath = join(ecosystemDir, `${hash}.lock`);
  const locked = await acquireLock(lockPath);
  if (!locked) {
    logger.info({ hash }, 'Waiting for concurrent pip install');
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (existsSync(join(cachePath, 'manifest.json'))) {
      const manifestRaw = await readFile(join(cachePath, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(manifestRaw) as CacheManifest;
      return {
        pipDir: join(cachePath, 'site-packages'),
        pythonPath: manifest.pythonPath ?? '/deps/site-packages',
      };
    }
    throw new Error('Concurrent pip install did not complete');
  }

  try {
    // Create temp dir
    const tmpDir = join(ecosystemDir, `tmp-${randomBytes(4).toString('hex')}`);
    await mkdir(tmpDir, { recursive: true });

    // Write requirements.txt
    const requirements = packages.map((p) => `${p.name}==${p.version}`).join('\n');
    await writeFile(join(tmpDir, 'requirements.txt'), requirements);

    // Resolve registry DNS
    const registryHosts = await resolveRegistryIps([PIP_REGISTRY, PIP_FILES], logger);

    // Build docker run args
    const args = [
      'run',
      '--rm',
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
      '--dns',
      '127.0.0.1',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '-v',
      `${tmpDir}:/deps:rw`,
    ];

    for (const [hostname, ips] of registryHosts.entries()) {
      for (const ip of ips) {
        args.push('--add-host', `${hostname}:${ip}`);
      }
    }

    args.push(
      CONTAINER_IMAGE,
      '-c',
      'pip install --target /deps/site-packages --only-binary :all: -r /deps/requirements.txt 2>&1 && python3 -c "import sysconfig; print(sysconfig.get_path(\'purelib\'))" > /deps/.python-path'
    );

    logger.info(
      { hash, packageCount: packages.length, ecosystem: 'pip' },
      'Installing pip dependencies via prep container'
    );

    const { stdout, stderr } = await execFileAsync('docker', args, {
      timeout: PREP_CONTAINER_TIMEOUT_MS,
    });

    if (stdout) logger.debug({ output: stdout.slice(0, 500) }, 'pip install stdout');
    if (stderr) logger.debug({ output: stderr.slice(0, 500) }, 'pip install stderr');

    // Verify site-packages was created
    if (!existsSync(join(tmpDir, 'site-packages'))) {
      throw new Error('pip install did not produce site-packages directory');
    }

    // Read python path
    let pythonPath = '/deps/site-packages';
    try {
      const pathContent = await readFile(join(tmpDir, '.python-path'), 'utf-8');
      if (pathContent.trim()) {
        pythonPath = pathContent.trim();
      }
    } catch {
      // Use default
    }

    // Write manifest
    const manifest: CacheManifest = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      ecosystem: 'pip',
      hash,
      packages,
      imageId,
      platform: `${process.platform}-${process.arch}`,
      installedAt: new Date().toISOString(),
      pythonPath,
    };
    await writeFile(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Atomic rename
    await rename(tmpDir, cachePath);
    logger.info({ hash, cachePath, ecosystem: 'pip' }, 'pip dependencies cached');

    return { pipDir: join(cachePath, 'site-packages'), pythonPath };
  } finally {
    await releaseLock(lockPath);
  }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Install skill dependencies (cache-first, prep container on miss).
 *
 * @param deps - Declared dependencies from policy.json
 * @param cacheBaseDir - Base directory for the dependency cache
 * @param skillName - Skill name (for logging)
 * @param logger - Logger instance
 * @returns PreparedDeps with mount paths, or null if no dependencies
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

  await mkdir(cacheBaseDir, { recursive: true });
  const imageId = await getImageId();
  const result: PreparedDeps = {};

  // Install npm dependencies
  if (hasNpm && deps.npm) {
    const hash = computeDepsHash('npm', deps.npm.packages, imageId);
    log.info({ hash, packages: deps.npm.packages }, 'Preparing npm dependencies');
    result.npmDir = await installNpm(deps.npm.packages, cacheBaseDir, hash, imageId, log);
  }

  // Install pip dependencies
  if (hasPip && deps.pip) {
    const hash = computeDepsHash('pip', deps.pip.packages, imageId);
    log.info({ hash, packages: deps.pip.packages }, 'Preparing pip dependencies');
    const pipResult = await installPip(deps.pip.packages, cacheBaseDir, hash, imageId, log);
    result.pipDir = pipResult.pipDir;
    result.pipPythonPath = pipResult.pythonPath;
  }

  return result;
}
