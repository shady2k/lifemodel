/**
 * Dependency Manager — Unified skill dependency image builder.
 *
 * Skills declare npm/pip/apt packages in policy.json. This module:
 * 1. Computes a single content-addressed hash across all ecosystems
 * 2. Checks Docker image labels for cache hit (zero host FS state)
 * 3. On cache miss: generates a Dockerfile in-memory and pipes via stdin to `docker build`
 * 4. Returns the derived image name for the runtime container
 *
 * No prep containers. No volume mounts for deps. No persistent host state
 * (no lock files, no ready markers). Only Docker CLI calls + ephemeral temp dir for build context.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Logger } from '../../types/index.js';
import { CONTAINER_IMAGE } from '../container/types.js';
import type { PreparedDeps } from '../motor-cortex/motor-protocol.js';

const execFileAsync = promisify(execFile);

// ─── Types ───────────────────────────────────────────────────────

export interface SkillDependencies {
  npm?: { packages: { name: string; version: string }[] } | undefined;
  pip?: { packages: { name: string; version: string }[] } | undefined;
  apt?: { packages: { name: string; version: string }[] } | undefined;
}

// ─── Constants ───────────────────────────────────────────────────

/** Schema version — bump to invalidate all cached skill deps images */
const SKILL_DEPS_SCHEMA_VERSION = 1;

/** Docker label for identifying skill deps images */
const SKILL_DEPS_LABEL = 'com.lifemodel.component=skill-deps';

/** Build timeout (10 minutes) */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000;

// ─── Cache Hash ──────────────────────────────────────────────────

/**
 * Compute a deterministic, content-addressed hash for a set of dependencies.
 *
 * Single hash across all ecosystems: sorted packages per ecosystem, base image ID,
 * platform, schema version. Two skills with identical deps share the same cached image.
 */
export function computeDepsHash(
  deps: {
    apt?: { name: string; version: string }[];
    pip?: { name: string; version: string }[];
    npm?: { name: string; version: string }[];
  },
  baseImageId: string
): string {
  const sortPkgs = (pkgs: { name: string; version: string }[]) =>
    [...pkgs]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ name: p.name, version: p.version }));

  const canonical = JSON.stringify({
    schemaVersion: SKILL_DEPS_SCHEMA_VERSION,
    apt: deps.apt ? sortPkgs(deps.apt) : [],
    pip: deps.pip ? sortPkgs(deps.pip) : [],
    npm: deps.npm ? sortPkgs(deps.npm) : [],
    baseImageId,
    platform: `${process.platform}-${process.arch}`,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// ─── Image Inspection Helpers ────────────────────────────────────

/**
 * Get the Docker image ID (content digest) for an image.
 * Fails hard — caller should not proceed with 'unknown' fallback.
 */
async function getImageId(image: string): Promise<string> {
  const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{.Id}}', image], {
    timeout: 10_000,
  });
  return stdout.trim();
}

/**
 * Check if a Docker image exists and its labels match expected values.
 */
async function imageMatchesLabels(
  imageName: string,
  expected: Record<string, string>
): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', '{{json .Config.Labels}}', imageName],
      { timeout: 10_000 }
    );
    const labels = JSON.parse(stdout.trim()) as Record<string, string> | null;
    if (!labels) return false;
    for (const [key, value] of Object.entries(expected)) {
      if (labels[key] !== value) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the most useful build error from stderr.
 * Looks for apt-get E: lines, npm ERR!, and pip error patterns.
 */
function extractBuildError(stderr: string): string {
  const lines = stderr.split('\n');
  // apt-get errors
  const aptErrors = lines.filter((l) => /^\s*E:\s/.test(l));
  if (aptErrors.length > 0) return aptErrors.join('\n').trim();
  // npm errors
  const npmErrors = lines.filter((l) => /npm ERR!/i.test(l));
  if (npmErrors.length > 0) return npmErrors.join('\n').trim();
  // pip errors
  const pipErrors = lines.filter((l) => /ERROR:/i.test(l));
  if (pipErrors.length > 0) return pipErrors.join('\n').trim();
  return '';
}

// ─── Dockerfile Generation ───────────────────────────────────────

/**
 * Generate a Dockerfile string for the unified skill deps image.
 *
 * Conditional layers: only ecosystems with packages get RUN instructions.
 * Shell heredocs (`cat <<'DELIM'`) for manifest content to avoid escaping.
 * Package names/versions already validated by `validateDependencies()` in skill-loader.
 */
function generateDockerfile(
  baseImage: string,
  deps: {
    apt?: { name: string; version: string }[];
    pip?: { name: string; version: string }[];
    npm?: { name: string; version: string }[];
  }
): string {
  const lines: string[] = [`FROM ${baseImage}`];

  const hasApt = deps.apt && deps.apt.length > 0;
  const hasPip = deps.pip && deps.pip.length > 0;
  const hasNpm = deps.npm && deps.npm.length > 0;

  // Need root for any install step
  if (hasApt || hasPip || hasNpm) {
    lines.push('USER root');
  }

  // ── Layer 1: apt ──
  if (hasApt && deps.apt) {
    const sorted = [...deps.apt].sort((a, b) => a.name.localeCompare(b.name));
    const pkgSpecs = sorted
      .map((p) => (p.version === 'latest' ? p.name : `${p.name}=${p.version}`))
      .join(' ');

    lines.push(
      `RUN printf 'Package: *\\nPin: release a=unstable\\nPin-Priority: 100\\n' \\`,
      `      > /etc/apt/preferences.d/unstable \\`,
      `    && echo 'deb http://deb.debian.org/debian unstable main' \\`,
      `      > /etc/apt/sources.list.d/unstable.list \\`,
      `    && apt-get update \\`,
      `    && apt-get install -y --no-install-recommends -t unstable ${pkgSpecs} \\`,
      `    && rm -rf /var/lib/apt/lists/*`
    );
  }

  // ── Layer 2: pip ──
  if (hasPip && deps.pip) {
    const sorted = [...deps.pip].sort((a, b) => a.name.localeCompare(b.name));
    const reqLines = sorted
      .map((p) => (p.version === 'latest' ? p.name : `${p.name}==${p.version}`))
      .join('\n');

    lines.push(
      `RUN cat <<'REQUIREMENTS' > /tmp/requirements.txt`,
      reqLines,
      `REQUIREMENTS`,
      `RUN python3 -m pip install --no-cache-dir --no-user --break-system-packages \\`,
      `    --target /opt/skill-deps/pip/site-packages \\`,
      `    -r /tmp/requirements.txt \\`,
      `    && rm /tmp/requirements.txt`
    );
  }

  // ── Layer 3: npm ──
  if (hasNpm && deps.npm) {
    const sorted = [...deps.npm].sort((a, b) => a.name.localeCompare(b.name));
    const depsObj: Record<string, string> = {};
    for (const p of sorted) {
      depsObj[p.name] = p.version;
    }
    const packageJson = JSON.stringify({ dependencies: depsObj });

    lines.push(
      `RUN mkdir -p /opt/skill-deps/npm && cat <<'PACKAGEJSON' > /opt/skill-deps/npm/package.json`,
      packageJson,
      `PACKAGEJSON`,
      `RUN cd /opt/skill-deps/npm \\`,
      `    && npm install --ignore-scripts --no-audit --no-fund --omit=optional`
    );
  }

  // ── Environment ──
  if (hasNpm) {
    lines.push('ENV NODE_PATH=/opt/skill-deps/npm/node_modules');
  }
  if (hasPip) {
    lines.push('ENV PYTHONPATH=/opt/skill-deps/pip/site-packages');
  }

  // Back to non-root user
  if (hasApt || hasPip || hasNpm) {
    lines.push('USER node');
  }

  return lines.join('\n');
}

// ─── Build ───────────────────────────────────────────────────────

/**
 * Ensure a derived Docker image with all skill dependencies baked in.
 *
 * Content-addressed: hash = sorted packages + base image ID + platform.
 * Two skills with identical deps share the same cached image.
 * No host FS state: Docker image labels ARE the cache.
 * Concurrent-safe without locks: identical builds produce identical images.
 *
 * @returns The derived image name (e.g., `lifemodel-skill-deps-<hash>:latest`)
 */
async function ensureSkillDepsImage(
  deps: {
    apt?: { name: string; version: string }[];
    pip?: { name: string; version: string }[];
    npm?: { name: string; version: string }[];
  },
  baseImage: string,
  logger: Logger
): Promise<string> {
  // ── Get base image ID (fail hard — no 'unknown' fallback) ──
  let baseImageId: string;
  try {
    baseImageId = await getImageId(baseImage);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot inspect base image "${baseImage}": ${msg}`);
  }

  // ── Compute unified hash ──
  const hash = computeDepsHash(deps, baseImageId);
  const derivedImage = `lifemodel-skill-deps-${hash}:latest`;

  // ── Cache check ──
  const expectedLabels: Record<string, string> = {
    'com.lifemodel.component': 'skill-deps',
    'com.lifemodel.skill-deps-hash': hash,
    'com.lifemodel.base-image-id': baseImageId,
    'com.lifemodel.schema-version': String(SKILL_DEPS_SCHEMA_VERSION),
  };

  if (await imageMatchesLabels(derivedImage, expectedLabels)) {
    logger.info({ hash, derivedImage }, 'Skill deps image cache hit');
    return derivedImage;
  }

  // ── Build ──
  const dockerfile = generateDockerfile(baseImage, deps);

  // Docker build with Dockerfile piped via stdin (-f -) and an empty temp dir as context.
  // We don't COPY/ADD anything, so the context is unused — but Docker requires a valid dir.
  const contextDir = join(tmpdir(), `skill-deps-build-${hash}`);
  await mkdir(contextDir, { recursive: true });

  const buildArgs = [
    'build',
    '-t',
    derivedImage,
    '--label',
    SKILL_DEPS_LABEL,
    '--label',
    `com.lifemodel.skill-deps-hash=${hash}`,
    '--label',
    `com.lifemodel.base-image-id=${baseImageId}`,
    '--label',
    `com.lifemodel.schema-version=${String(SKILL_DEPS_SCHEMA_VERSION)}`,
    '-f',
    '-', // Read Dockerfile from stdin
    contextDir, // Empty build context (no files needed, but Docker requires a dir)
  ];

  logger.info(
    {
      hash,
      derivedImage,
      aptCount: deps.apt?.length ?? 0,
      pipCount: deps.pip?.length ?? 0,
      npmCount: deps.npm?.length ?? 0,
    },
    'Building unified skill deps image'
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', buildArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      let stdout = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(
          new Error(`Skill deps image build timed out after ${String(BUILD_TIMEOUT_MS / 1000)}s`)
        );
      }, BUILD_TIMEOUT_MS);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          if (stdout) logger.debug({ output: stdout.slice(0, 1000) }, 'Build stdout');
          resolve();
        } else {
          const buildError = extractBuildError(stderr);
          reject(
            new Error(
              `Skill deps image build failed (exit ${String(code)}): ${buildError || stderr.slice(-500)}`
            )
          );
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      // Write Dockerfile to stdin
      proc.stdin?.write(dockerfile);
      proc.stdin?.end();
    });

    logger.info({ hash, derivedImage }, 'Skill deps image built successfully');

    // Clean up context dir
    await rm(contextDir, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });

    return derivedImage;
  } catch (error) {
    // Clean up context dir on failure too
    await rm(contextDir, { recursive: true, force: true }).catch(() => {
      /* best-effort */
    });
    // On build failure, re-check image inspect once — absorbs concurrent-success race.
    // If another process built the same image while we were building, use theirs.
    if (await imageMatchesLabels(derivedImage, expectedLabels)) {
      logger.info({ hash, derivedImage }, 'Skill deps image available (concurrent build)');
      return derivedImage;
    }
    throw error;
  }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Install skill dependencies by building a unified Docker image.
 *
 * All ecosystems (apt + pip + npm) are baked into a single derived image.
 * Cache-first: if an image with matching labels exists, returns immediately.
 *
 * @param deps - Declared dependencies from policy.json
 * @param _cacheBaseDir - Unused (kept for call-site compat, will remove in follow-up)
 * @param skillName - Skill name (for logging)
 * @param logger - Logger instance
 * @returns PreparedDeps with derived image name, or null if no dependencies
 * @throws Error if installation fails (skill cannot run without its deps)
 */
export async function installSkillDependencies(
  deps: SkillDependencies,
  _cacheBaseDir: string,
  skillName: string,
  logger: Logger
): Promise<PreparedDeps | null> {
  const log = logger.child({ component: 'dependency-manager', skill: skillName });

  const hasNpm = deps.npm && deps.npm.packages.length > 0;
  const hasPip = deps.pip && deps.pip.packages.length > 0;
  const hasApt = deps.apt && deps.apt.packages.length > 0;

  if (!hasNpm && !hasPip && !hasApt) {
    return null;
  }

  const skillImage = await ensureSkillDepsImage(
    {
      ...(hasApt && deps.apt && { apt: deps.apt.packages }),
      ...(hasPip && deps.pip && { pip: deps.pip.packages }),
      ...(hasNpm && deps.npm && { npm: deps.npm.packages }),
    },
    CONTAINER_IMAGE,
    log
  );

  return { version: 2, skillImage };
}
