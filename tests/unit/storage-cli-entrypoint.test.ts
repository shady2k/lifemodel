/** The shipped CLI owns asynchronous stdout/stderr failures, not its caller. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';

const entrypoint = fileURLToPath(new URL('../../loader/src/storage-cli-main.ts', import.meta.url));
const page = { objects: [], nextCursor: null };
const CHILD_DEADLINE_MS = 5_000;
let certificate: TestStorageCertificate;
let server: Server;
let endpoint: string;
let directory: string;
let env: NodeJS.ProcessEnv;
let requests: number;

beforeAll(async () => {
  certificate = await createStorageCertificate(['localhost']);
  server = createServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
    requests += 1;
    req.on('error', () => undefined);
    res.on('error', () => undefined);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(page));
  });
  server.on('error', () => undefined);
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture has no port');
  endpoint = `https://localhost:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  certificate.cleanup();
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'storage-cli-entrypoint-'));
  await writeFile(join(directory, 'token'), 'entrypoint-task-token');
  await writeFile(join(directory, 'ca'), certificate.ca);
  env = {
    LIFEMODEL_STORAGE_ENDPOINT: endpoint,
    LIFEMODEL_STORAGE_SPACE: 'space-a',
    LIFEMODEL_STORAGE_TOKEN_FILE: join(directory, 'token'),
    LIFEMODEL_STORAGE_CA_FILE: join(directory, 'ca'),
  };
  requests = 0;
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function runEntrypoint(args: string[], closed: ('stdout' | 'stderr')[] = []) {
  const child = spawn(
    process.execPath,
    [
      '--report-uncaught-exception',
      `--report-directory=${directory}`,
      '--import',
      'tsx',
      entrypoint,
      ...args,
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('error', () => undefined);
  child.stderr.on('error', () => undefined);
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  // Close the real pipe reader before the TS entrypoint can make its first write.
  for (const stream of closed) child[stream].destroy();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, CHILD_DEADLINE_MS);
  const outcome = await new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }
  ).finally(() => clearTimeout(timer));
  // Diagnostic reports expose uncaught EPIPE even when stderr itself is closed.
  const reports = (await readdir(directory)).filter((name) => name.startsWith('report.'));
  return { ...outcome, timedOut, stdout, stderr, reports };
}

function expectBounded(result: Awaited<ReturnType<typeof runEntrypoint>>, code: number) {
  expect(result.timedOut, JSON.stringify(result)).toBe(false);
  expect(result.signal, JSON.stringify(result)).toBeNull();
  expect(result.code, JSON.stringify(result)).toBe(code);
  expect(result.reports, 'no uncaught exception report may be generated').toEqual([]);
  expect(result.stderr).not.toMatch(/Unhandled|Error:|\n\s+at |write EPIPE/);
}

describe('storage CLI entrypoint output pipes', () => {
  it('awaits successful stdout and exits without a live output timeout', async () => {
    const result = await runEntrypoint(['list']);
    expectBounded(result, 0);
    expect(requests).toBe(1);
    expect(result.stdout).toBe(`${JSON.stringify(page)}\n`);
    expect(result.stderr).toBe('');
  });

  it('handles a closed stdout pipe with one safe diagnostic and a bounded failure', async () => {
    const result = await runEntrypoint(['list'], ['stdout']);
    expectBounded(result, 1);
    expect(requests).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(
      /^lifemodel-storage: operation_failed id=[0-9a-f-]{36} status=500\n$/
    );
  });

  it('handles a closed stderr pipe without an uncaught exception or recursive diagnostic', async () => {
    const result = await runEntrypoint(['invalid'], ['stderr']);
    expectBounded(result, 1);
    expect(requests).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('exits when stdout failure must be reported to an already closed stderr pipe', async () => {
    const result = await runEntrypoint(['list'], ['stdout', 'stderr']);
    expectBounded(result, 1);
    expect(requests).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
