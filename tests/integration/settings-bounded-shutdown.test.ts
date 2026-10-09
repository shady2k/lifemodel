/**
 * The REAL entry point's stop, in a real process (lifemodel-q4x.4.1, review
 * round 2 finding I).
 *
 * The child (tests/fixtures/settings-entrypoint-child.ts) imports src/index.ts
 * itself - NOT a copy of the stop order - and drives:
 *
 * - a REAL successful POST /settings, whose answer's finish event runs the
 *   REAL restart path (save -> restartAfterSettingsSaved -> stopAndLeave);
 * - the stop coordinator (`runStopSequence`) on the container boundary a
 *   controlled double stands officially still for.
 *
 * The old copied-wiring cases below are kept for what they still prove (the
 * settings server closes bounded around a half-sent request, and the fixture's
 * own ordering did not change), but they are NOT labelled entry-point proof
 * any more: a mutation of src/index.ts cannot reach them.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const CHILD = join(process.cwd(), 'tests', 'fixtures', 'settings-entrypoint-child.ts');
const OLD_CHILD = join(process.cwd(), 'tests', 'fixtures', 'settings-partial-request-child.ts');

interface ChildResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

/**
 * Run one child mode. `on` names a stderr marker whose appearance triggers the
 * optional signal: an EVENT, never a sleep. The child is killed if it has not
 * left on its own within `timeoutMs` - which an unbounded stop would.
 */
function runChild(
  path: string,
  mode: string,
  env: NodeJS.ProcessEnv,
  options: { signal?: NodeJS.Signals; on?: string; timeoutMs?: number } = {}
): Promise<ChildResult> {
  const { signal, on, timeoutMs } = options;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let signaled = false;
    const child = spawn(TSX, [path, mode], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      if (signal && !signaled && on !== undefined && stderr.includes(on)) {
        signaled = true;
        child.kill(signal);
      }
    });
    const killTimer = setTimeout(
      () => {
        child.kill('SIGKILL');
      },
      timeoutMs ?? 10_000
    );
    child.on('close', (code, signalName) => {
      clearTimeout(killTimer);
      resolve({ code, signal: signalName, stdout, stderr });
    });
  });
}

const dirs: string[] = [];
let dataDir = '';

beforeEach(async () => {
  dataDir = '';
});

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function childEnv(): { DATA_PATH: string } {
  if (dataDir === '') {
    // synchronous is not available for mkdir; runChild awaits nothing here...
    dataDir = join(tmpdir(), `settings-entry-${String(process.pid)}`);
    dirs.push(dataDir);
  }
  return { DATA_PATH: dataDir, LIFEMODEL_ENTRYPOINT_AUTOSTART: '0' };
}

describe('the entry point stop (real module, controlled boundary)', { timeout: 40_000 }, () => {
  it('restarts through the REAL path: a successful save exits 75, close before drain', async () => {
    const env = childEnv();
    const child: ChildResult = await runChild(CHILD, 'restart-grace', env, { timeoutMs: 15_000 });
    const config = await readFile(join(env.DATA_PATH, 'config', 'agent.json'), 'utf-8');

    // The save went through the REAL interface: the file holds what was saved.
    expect(JSON.parse(config)).toMatchObject({
      llm: { endpoint: { baseUrl: 'http://127.0.0.1:1234/v1' } },
    });
    expect(child.code).toBe(75);
    expect(child.signal).toBeNull();
    // The exit can beat the client's own last readout of the answer (the
    // restart trigger is the answer's server-side finish event), so the
    // receipt of the successful save is the WRITTEN FILE, not a marker.
    expect(child.stderr).toContain('DRAIN-DONE');
    expect(child.stdout + child.stderr).not.toContain('Stop deadline reached');
    expect(child.stderr).not.toContain('HELD-SOCKET-RECEIVED'); // no socket held here
  });

  it('abandons an unfinishable stop at the deadline the coordinator armed (exit 1)', async () => {
    const env = childEnv();
    const child = await runChild(CHILD, 'restart-abandoned', env, { timeoutMs: 15_000 });

    expect(child.signal).toBeNull(); // left on its own, inside the budget
    expect(child.stderr).toContain('HELD-SOCKET-RECEIVED'); // received is an event
    expect(child.stderr).toContain('SAVED-200'); // the restart was truly asked
    expect(child.stderr).not.toContain('DRAIN-DONE'); // the drain never finished
    expect(child.code).toBe(1);
    expect(child.stdout).toContain('Stop deadline reached');
  });

  it('a signal like the loader stop drains through the REAL path and exits 0', async () => {
    const env = childEnv();
    const child = await runChild(CHILD, 'sigterm', env, {
      signal: 'SIGTERM',
      on: 'HELD-SOCKET-RECEIVED',
      timeoutMs: 15_000,
    });

    expect(child.signal).toBeNull();
    expect(child.stderr).toContain('HELD-SOCKET-RECEIVED');
    expect(child.stderr).toContain('DRAIN-DONE');
    expect(child.code).toBe(0);
    expect(child.stdout + child.stderr).not.toContain('Stop deadline reached');
  });
});

describe('the settings server closes bounded around a half-sent request (fixture-scoped)', () => {
  // These cases predate the entry-point test. They prove the settings SERVER
  // object closes bounded and the FIXTURE's own copied wiring still works;
  // they do NOT exercise src/index.ts's coordinator - finding I's red run
  // demonstrated that a mutation there leaves them green.
  it('a settings save cannot be stalled by a half-sent request: its own wiring exits 75', async () => {
    const child = await runChild(OLD_CHILD, 'restart', {}, { timeoutMs: 10_000 });

    expect(child.signal).toBeNull(); // it left on its own, not killed
    expect(child.stderr).toContain('HOLD-OPEN');
    expect(child.stderr).toContain('CLOSED-BOUNDED');
    expect(child.code).toBe(75);
    expect(child.stdout + child.stderr).not.toContain('Stop deadline reached');
  });

  it('a signal cannot be stalled either: its own wiring drains and exits 0', async () => {
    const child = await runChild(OLD_CHILD, 'sigterm', {}, { signal: 'SIGTERM', on: 'HOLD-OPEN' });

    expect(child.signal).toBeNull();
    expect(child.stderr).toContain('HOLD-OPEN');
    expect(child.stderr).toContain('CLOSED-BOUNDED');
    expect(child.code).toBe(0);
  });
});
