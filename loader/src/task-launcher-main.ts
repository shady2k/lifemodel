/** Workbench ENTRYPOINT. Self-check stays offline; tasks use the once-only start. */
import { execFileSync } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { constants, writeFileSync } from 'node:fs';

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
  if (
    process.argv.length === 2 ||
    (process.argv.length === 3 && process.argv[2] === '--check-modules')
  ) {
    // Load the task's actual graph, not just the offline self-check's graph.
    const { runTaskLauncher } = await import('./task-launcher.js');
    if (process.argv[2] === '--check-modules') {
      const { checkHarnessModules } = await import('./task-harness-registry.js');
      await checkHarnessModules();
      return;
    }
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
        diagnostic: (code, context) => {
          write(process.stderr, `${JSON.stringify({ code, ...context })}\n`);
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
  const { selfCheckHarnesses } = await import('./task-harness-registry.js');
  for (const checked of await selfCheckHarnesses()) write(process.stdout, `${checked}\n`);
  write(process.stdout, 'workbench_self_check_ok\n');
}

// These are trusted public identifiers, not a general-purpose error formatter.
// Even a syntactically valid error code or basename could contain a secret.
const START_ERROR_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_REQUIRE_ESM',
  'MODULE_NOT_FOUND',
  'EACCES',
  'ENOENT',
]);
// The build inlines the immutable source-file inventory here. An unbuilt source
// run has no trusted inventory and reports unknown, never names from the error.
const START_MODULE_NAMES: ReadonlySet<string> = new Set(
  Object.freeze(/* task-start-module-manifest */ [] as string[])
);

main().catch((error: unknown) => {
  let reasonCode = 'startup_error';
  let module = 'unknown';
  try {
    if (error && typeof error === 'object') {
      const value = error as Record<string, unknown>;
      const code = value['code'];
      if (typeof code === 'string' && START_ERROR_CODES.has(code)) reasonCode = code;
      // Node's ESM resolver supplies a URL separately from its unsafe message.
      // Do not parse error.message, stack, path, stderr, or an arbitrary URL host.
      const url = value['url'];
      if (typeof url === 'string' && url.length <= 2_048) {
        const parsed = new URL(url);
        const name = parsed.pathname.split('/').at(-1) ?? '';
        if (
          parsed.protocol === 'file:' &&
          !parsed.host &&
          !parsed.search &&
          !parsed.hash &&
          START_MODULE_NAMES.has(name)
        )
          module = name;
      }
    }
  } catch {
    // Untrusted properties/getters and malformed URLs must not break reporting.
  }
  const code =
    process.argv[2] === '--self-check' ? 'workbench_self_check_failed' : 'launcher_start_failed';
  const diagnostic = `${JSON.stringify({ code, reasonCode, module })}\n`;
  process.exitCode = 1;
  write(process.stderr, diagnostic);
  try {
    // Kubernetes captures this file before core removes the failed Job.
    writeFileSync('/dev/termination-log', diagnostic, { encoding: 'utf8' });
  } catch {
    // A missing/read-only termination file must not replace the original code.
  }
});
