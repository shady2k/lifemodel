/**
 * `lifemodel status|panic|resume` inside the container (lifemodel-q4x.2.1,
 * story S6).
 *
 * The command line is what the owner has when the browser is not at hand. It
 * talks to the loader over loopback and proves itself with the token file only
 * root can read, so lifemodel's own user cannot reach the same endpoints.
 */
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { createNodeFileSystem } from './fs.js';
import type { InstanceStatus } from './bootstrap.js';
import { createLoaderState } from './state.js';
import { describe } from './state.js';

export const USAGE = 'usage: lifemodel status|panic|resume';

export interface CliDeps {
  /** Where the loader listens and which token it asks for. */
  baseUrl: string;
  readCliToken(): Promise<string | null>;
  out(line: string): void;
  err(line: string): void;
  fetchImpl: typeof fetch;
}

/** The three lines `status` prints: the state, the commit, whether panic is set. */
function printStatus(out: (line: string) => void, status: InstanceStatus): void {
  out(status.lifemodel === 'running' ? 'running' : 'stopped');
  out(`commit ${status.commit ?? 'none'}`);
  out(`panic ${status.panic ? 'on' : 'off'}`);
}

async function request(
  deps: CliDeps,
  path: string,
  method: 'GET' | 'POST'
): Promise<InstanceStatus> {
  const token = await deps.readCliToken();
  if (token === null) {
    throw new Error('the loader token is not on the volume: has the loader ever started?');
  }
  let response: Response;
  try {
    response = await deps.fetchImpl(`${deps.baseUrl}${path}`, {
      method,
      headers: { 'x-loader-cli-token': token },
    });
  } catch (error) {
    throw new Error(`the loader is not reachable on ${deps.baseUrl}: ${describe(error)}`, {
      cause: error,
    });
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`the loader refused ${path} (HTTP ${String(response.status)}): ${body}`);
  }
  return JSON.parse(body) as InstanceStatus;
}

/** Run one command line. Returns the code the process should leave with. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const command = argv[0];
  // Bound, not detached: these are the command's own two channels.
  const out = (line: string): void => {
    deps.out(line);
  };
  const err = (line: string): void => {
    deps.err(line);
  };
  if (command === undefined) {
    err(USAGE);
    return 1;
  }
  try {
    switch (command) {
      case 'status':
        printStatus(out, await request(deps, '/_api/status', 'GET'));
        return 0;
      case 'panic':
        printStatus(out, await request(deps, '/_api/panic', 'POST'));
        return 0;
      case 'resume':
        printStatus(out, await request(deps, '/_api/resume', 'POST'));
        return 0;
      default:
        err(`unknown command: ${command}`);
        err(USAGE);
        return 1;
    }
  } catch (error) {
    err(describe(error));
    return 1;
  }
}

/** The token reader of the real command line: the root-only file on the volume. */
export function cliTokenReader(
  config: ReturnType<typeof loadConfig>
): () => Promise<string | null> {
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const state = createLoaderState({ fs: createNodeFileSystem(), config, logger: silent });
  return () => state.readCliToken();
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const config = loadConfig(process.env);
  const code = await runCli(process.argv.slice(2), {
    baseUrl: `http://127.0.0.1:${String(config.httpPort)}`,
    readCliToken: cliTokenReader(config),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    fetchImpl: fetch,
  });
  process.exit(code);
}
