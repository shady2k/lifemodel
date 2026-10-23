/** Workbench entry only. 653.8.7 adds verified binding and the real adapter. */
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== '--self-check') {
    // No harness or shell can start before the once-only binding handshake.
    process.stderr.write('launcher_not_implemented\n');
    process.exitCode = 1;
    return;
  }
  for (const path of ['/work/home', '/work/tmp']) await mkdir(path, { recursive: true });
  for (const path of [
    '/opt/lifemodel/node_modules/typescript/bin/tsc',
    '/opt/lifemodel/node_modules/vitest/vitest.mjs',
    '/opt/lifemodel/loader/dist/storage-cli-main.js',
    '/opt/lifemodel/loader/dist/storage-cli.js',
    '/etc/lifemodel/opencode.json',
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
    ['opencode', ['--version']],
    ['git', ['--version']],
    ['lifemodel-storage', ['--help']],
  ] as const) {
    const output = execFileSync(command, [...args], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.stdout.write(`${command}: ${output.trim()}\n`);
  }
  process.stdout.write('workbench_self_check_ok\n');
}

main().catch(() => {
  // Do not include process env, command stderr or credentials in diagnostics.
  process.stderr.write('workbench_self_check_failed\n');
  process.exitCode = 1;
});
