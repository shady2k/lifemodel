/** Workbench ENTRYPOINT. Self-check stays offline; tasks use the once-only start. */
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { selfCheckHarnesses } from './task-harness-registry.js';

// Keep listeners through teardown, including late EPIPE after a write callback.
function write(stream: NodeJS.WriteStream, text: string): void {
  if (stream.destroyed) {
    process.exitCode = 1;
    return;
  }
  const timer = setTimeout(() => {
    process.exitCode = 1;
    stream.destroy();
  }, 1_000);
  stream.write(text, (error) => {
    clearTimeout(timer);
    if (error) {
      process.exitCode = 1;
      stream.destroy();
    }
  });
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {
    process.exitCode = 1;
    stream.destroy();
  });
}

async function main(): Promise<void> {
  if (process.argv.length === 2) {
    const { runTaskLauncher } = await import('./task-launcher.js');
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    process.on('SIGTERM', abort);
    process.on('SIGINT', abort);
    try {
      process.exitCode = await runTaskLauncher({
        env: process.env,
        signal: controller.signal,
        diagnostic: (code) => {
          write(process.stderr, `${code}\n`);
        },
      });
    } finally {
      process.off('SIGTERM', abort);
      process.off('SIGINT', abort);
    }
    return;
  }
  if (process.argv.length !== 3 || process.argv[2] !== '--self-check') {
    process.exitCode = 1;
    return;
  }
  for (const path of ['/work/home', '/work/tmp']) await mkdir(path, { recursive: true });
  for (const path of [
    '/opt/lifemodel/node_modules/typescript/bin/tsc',
    '/opt/lifemodel/node_modules/vitest/vitest.mjs',
    '/opt/lifemodel/loader/dist/storage-cli-main.js',
    '/opt/lifemodel/loader/dist/storage-cli.js',
  ]) {
    await access(path, constants.R_OK);
  }
  const manifest = JSON.parse(await readFile('/opt/lifemodel/package.json', 'utf8')) as {
    name: string;
  };
  if (manifest.name !== 'lifemodel' || process.getuid?.() === 0) {
    throw new Error('invalid_workbench');
  }
  for (const [command, args] of [
    ['node', ['--version']],
    ['git', ['--version']],
    ['lifemodel-storage', ['--help']],
  ] as const) {
    const output = execFileSync(command, [...args], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    write(process.stdout, `${command}: ${output.trim()}\n`);
  }
  for (const checked of await selfCheckHarnesses()) write(process.stdout, `${checked}\n`);
  write(process.stdout, 'workbench_self_check_ok\n');
}

main().catch(() => {
  // Do not include process env, command stderr or credentials in diagnostics.
  write(process.stderr, 'workbench_self_check_failed\n');
  process.exitCode = 1;
});
