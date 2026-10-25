import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createPostgresTraceStore } from '../../src/storage/postgres-trace-store.js';

const cli = fileURLToPath(new URL('../../deploy/cli/lifemodel.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function run(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-trace-'));
  dirs.push(dir);
  const calls = join(dir, 'calls');
  const fake = join(dir, 'kubectl');
  // Emulate kubectl exec, but run its read-only query through the actual test store.
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs=require('node:fs');const cp=require('node:child_process');
const args=process.argv.slice(2);fs.writeFileSync(process.env.TRACE_CALLS,JSON.stringify(args));
if(process.env.TRACE_FAIL==='1'){process.stderr.write('secret-do-not-print');process.exit(1);}
const command=args.slice(args.indexOf('--')+1);
const result=cp.spawnSync(process.execPath,command.slice(1),{encoding:'utf8',env:{...process.env,LIFEMODEL_DATABASE_URL:process.env.TRACE_DB}});
process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status??1);
`
  );
  chmodSync(fake, 0o755);
  const result = spawnSync(process.execPath, [cli, 'doctor', 'trace', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LIFEMODEL_KUBECTL: fake,
      LIFEMODEL_STATE_DIR: dir,
      TRACE_CALLS: calls,
      TRACE_DB: workerDatabaseUrl(),
      ...env,
    },
  });
  return { ...result, calls: () => readFileSync(calls, 'utf8') };
}

describe('doctor trace stored tree', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    await stores.postgres.query('TRUNCATE observability.trace_spans,observability.trace_events');
    const writer = createPostgresTraceStore({
      pool: stores.postgres,
      retention: { maxAgeDays: null },
    });
    const startedAt = '2026-01-01T00:00:00.000Z';
    const endedAt = '2026-01-01T00:00:01.000Z';
    writer.enqueue({
      kind: 'span',
      span: {
        traceId: 'stored-run',
        spanId: 'root',
        parentSpanId: 'external-turn',
        component: 'task',
        startedAt,
        endedAt,
        status: 'failed',
        attrs: { reasonCode: 'required_tool_failed', failureSpanId: 'bad-tool' },
      },
    });
    writer.enqueue({
      kind: 'span',
      span: {
        traceId: 'stored-run',
        spanId: 'bad-tool',
        parentSpanId: 'root',
        component: 'tool',
        startedAt,
        endedAt,
        status: 'failed',
        attrs: { command: 'false', exitCode: 1, outputTail: 'command failed' },
      },
    });
    writer.enqueue({
      kind: 'span',
      span: {
        traceId: 'stored-run',
        spanId: 'good-tool',
        parentSpanId: 'root',
        component: 'tool',
        startedAt,
        endedAt,
        status: 'ok',
        attrs: { command: 'true', exitCode: 0 },
      },
    });
    writer.enqueue({
      kind: 'event',
      event: {
        recordId: 'result',
        traceId: 'stored-run',
        spanId: 'bad-tool',
        event: 'tool-result',
        ts: endedAt,
        fields: { exitCode: 1 },
      },
    });
    writer.enqueue({
      kind: 'span',
      span: {
        traceId: 'open-run',
        spanId: 'open',
        parentSpanId: null,
        component: 'task',
        startedAt: '2026-01-02T00:00:00Z',
        endedAt: null,
        status: null,
        attrs: { taskId: 'task-2' },
      },
    });
    await writer.close();
  });
  afterAll(async () => {
    await stores.redis.quit();
    await stores.postgres.end();
  });

  it('renders the persisted span tree, duration, failure cause, tool output and exit codes', () => {
    const result = run(['stored-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('trace stored-run');
    expect(result.stdout).toContain('  task [failed] 1000ms span=root');
    expect(result.stdout).toContain('failureSpanId="bad-tool"');
    expect(result.stdout).toContain('    tool [failed] 1000ms span=bad-tool');
    expect(result.stdout).toContain('exitCode=1');
    expect(result.stdout).toContain('outputTail="command failed"');
    expect(result.stdout).toContain('      · tool-result exitCode=1');
    expect(result.stdout).toContain('    tool [ok] 1000ms span=good-tool');
    expect(result.stdout).toContain('exitCode=0');
    const args = JSON.parse(result.calls());
    expect(args.slice(0, 8)).toEqual([
      'exec',
      '-n',
      'lifemodel',
      'core-0',
      '-c',
      'core',
      '--',
      'node',
    ]);
    expect(result.calls()).not.toContain(workerDatabaseUrl());
    expect(result.calls()).toContain('BEGIN READ ONLY');
    expect(result.calls()).not.toContain('get secrets');
  });

  it('last defaults to one newest trace and marks open spans incomplete', () => {
    const result = run(['last']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('trace open-run');
    expect(result.stdout).toContain('task [incomplete] open span=open');
    expect(result.stdout).not.toContain('trace stored-run');
    const both = run(['last', '2']);
    expect(both.status).toBe(0);
    expect(both.stdout).toContain('trace stored-run');
    expect(both.stdout.indexOf('trace open-run')).toBeLessThan(
      both.stdout.indexOf('trace stored-run')
    );
  });

  it('gives a clear message for an absent trace', () => {
    const result = run(['absent']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('(no spans or events recorded)');
  });

  it.each([
    [[]],
    [['last', '0']],
    [['last', '21']],
    [['last', 'NaN']],
    [['bad;id']],
    [['id', 'extra']],
  ])('rejects malformed arguments %j without querying', (args) => {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Usage:|integer from 1 to 20/);
  });

  it('fails softly without echoing command errors or credentials', () => {
    const result = run(['last'], { TRACE_FAIL: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Trace store unavailable');
    expect(result.stderr).not.toContain('secret-do-not-print');
    expect(result.stderr).not.toContain(workerDatabaseUrl());
  });
});
