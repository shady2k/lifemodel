/**
 * The pinned Vector binary (ADR-016), run either natively or in its image.
 *
 * Two ways to run it, so the same checks work wherever they can:
 *
 * - a `vector` binary named by `LIFEMODEL_VECTOR_BIN`: used as is. The CI job's
 *   check image ships the pinned image's binary under that path
 *   (`docker/logs-vrl/Dockerfile`), and the isolated test boundary mounts no
 *   Docker socket, so a binary is its only route.
 * - otherwise the Docker CLI and the digest-pinned image, started with the
 *   checkout's directory mounted at /work. This is how the host runs it.
 *
 * Neither is reachable from the isolated test boundary, which mounts no Docker
 * socket and attaches the test container to no network; `vectorRunner()` then
 * answers undefined and the caller says so instead of standing in for it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const PINNED_VECTOR_IMAGE =
  'docker.io/timberio/vector@sha256:f6c23b5a7e16fb2838d33619ef7acf4bad2289a7cf22bc90efc2371f520c4ea2';

function works(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: 30_000 });
  return result.error === undefined && result.status === 0;
}

function binaryRunner(binary) {
  return {
    label: `the vector binary at ${binary}`,
    binary,
    /** Where a config written into `directory` is read from. */
    basePath: (directory) => directory,
    /** Run a Vector unit-test case file; the collector's own verdict. */
    test: (directory, name) =>
      spawnSync(binary, ['test', join(directory, name)], { encoding: 'utf8', timeout: 300_000 }),
    /**
     * Start the collector with a config for a while. Returns the stop function;
     * the caller waits its period between the two.
     */
    startCollector: ({ directory, configName, env }) => {
      const child = spawn(binary, ['--config', join(directory, configName)], {
        cwd: directory,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      return (signal = 'SIGTERM') => {
        if (signal === 'SIGKILL') {
          return new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('exit', resolve);
            child.kill(signal);
          });
        }
        child.kill(signal);
      };
    },
  };
}

function dockerRunner() {
  return {
    label: `Docker ${PINNED_VECTOR_IMAGE}`,
    binary: undefined,
    basePath: () => '/work',
    test: (directory, name) =>
      spawnSync(
        'docker',
        ['run', '--rm', '-v', `${directory}:/work:ro`, PINNED_VECTOR_IMAGE, 'test', `/work/${name}`],
        { encoding: 'utf8', timeout: 300_000 }
      ),
    startCollector: ({ directory, configName, containerName, env, hostNetwork = false }) => {
      const start = spawnSync(
        'docker',
        [
          'run',
          '-d',
          '--name',
          containerName,
          ...(hostNetwork ? ['--network', 'host'] : []),
          ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
          '-v',
          `${directory}:/work`,
          '-w',
          '/work',
          PINNED_VECTOR_IMAGE,
          '--config',
          `/work/${configName}`,
        ],
        { encoding: 'utf8' }
      );
      if (start.error) throw start.error;
      if (start.status !== 0) throw new Error(`the collector did not start: ${start.stderr.trim()}`);
      return () => {
        spawnSync('docker', ['rm', '-f', containerName], { encoding: 'utf8' });
      };
    },
  };
}

/**
 * The pinned VRL, or undefined when this machine has no way to run it.
 */
export function vectorRunner() {
  const binary = process.env['LIFEMODEL_VECTOR_BIN'];
  if (binary) return binaryRunner(binary);
  if (!works('docker', ['version', '--format', '{{.Server.Version}}'])) return undefined;
  return dockerRunner();
}
