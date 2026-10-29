import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createPostgresTraceStore } from '../../src/storage/postgres-trace-store.js';
import { recordTaskPodTermination } from '../../src/core/task-pod-trace.js';
import type { TaskRecord } from '../../src/ports/tasks.js';

const cli = fileURLToPath(new URL('../../deploy/cli/lifemodel.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function run(args: string[], env: Record<string, string> = {}, command = 'trace') {
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
  const result = spawnSync(process.execPath, [cli, 'doctor', command, ...args], {
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
    // Two model calls of one turn (lifemodel-d4t8): the first reported a cache
    // hit and a reasoning count, the second reported neither and failed.
    writer.enqueue({
      kind: 'span',
      span: {
        traceId: 'stored-run',
        spanId: 'chat_1',
        parentSpanId: 'root',
        component: 'llm',
        startedAt: '2026-01-01T00:00:00.500Z',
        endedAt: '2026-01-01T00:00:01.500Z',
        status: 'ok',
        attrs: {
          'span.name': 'chat smart-model',
          'gen_ai.operation.name': 'chat',
          'gen_ai.request.model': 'smart-model',
          'gen_ai.response.model': 'served-model-2026',
          'gen_ai.usage.input_tokens': 1200,
          'gen_ai.usage.cache_read.input_tokens': 1024,
          'gen_ai.usage.output_tokens': 180,
          'gen_ai.usage.reasoning.output_tokens': 64,
          'lifemodel.call_id': 'call_11111111-1111-1111-1111-111111111111',
          'lifemodel.role': 'smart',
          'lifemodel.trigger_type': 'user_message',
          'lifemodel.slot': 'primary',
          'lifemodel.request.reasoning_effort': 'low',
          'lifemodel.http.status': 200,
          'lifemodel.attempt': 1,
          'lifemodel.duration_ms': 1000,
          'lifemodel.prefix.system.hash': 'aaaa1111bbbb2222',
          'lifemodel.prefix.system.size': 4800,
          'lifemodel.prefix.tools.hash': 'cccc3333dddd4444',
          'lifemodel.prefix.tools.size': 12034,
          'lifemodel.prefix.history.hash': 'eeee5555ffff6666',
          'lifemodel.prefix.history.size': 900,
          'lifemodel.prefix.context.hash': '9999aaaa0000bbbb',
          'lifemodel.prefix.context.size': 120,
        },
      },
    });
    writer.enqueue({
      kind: 'span',
      span: {
        traceId: 'stored-run',
        spanId: 'chat_2',
        parentSpanId: 'root',
        component: 'llm',
        startedAt: '2026-01-01T00:00:02.000Z',
        endedAt: '2026-01-01T00:00:02.400Z',
        status: 'failed',
        attrs: {
          'span.name': 'chat fast-model',
          'gen_ai.request.model': 'fast-model',
          'gen_ai.usage.input_tokens': 40,
          'gen_ai.usage.output_tokens': 7,
          'lifemodel.call_id': 'call_22222222-2222-2222-2222-222222222222',
          'lifemodel.role': 'fast',
          'lifemodel.error_code': 'http_500',
          'lifemodel.http.status': 500,
          'lifemodel.slot': 'reserve',
          'lifemodel.attempt': 1,
          'lifemodel.duration_ms': 400,
          'lifemodel.prefix.system.hash': 'aaaa1111bbbb2222',
          'lifemodel.prefix.system.size': 4800,
        },
      },
    });
    writer.enqueue({
      kind: 'span',
      span: {
        traceId: 'stored-run',
        spanId: 'chat_3',
        parentSpanId: 'root',
        component: 'llm',
        startedAt: '2026-01-01T00:00:03.000Z',
        endedAt: '2026-01-01T00:00:03.200Z',
        status: 'ok',
        attrs: {
          'span.name': 'chat smart-model',
          'gen_ai.request.model': 'smart-model',
          // A reported cache miss and no reasoning: zeros, not dashes.
          'gen_ai.usage.input_tokens': 1200,
          'gen_ai.usage.cache_read.input_tokens': 0,
          'gen_ai.usage.output_tokens': 180,
          'gen_ai.usage.reasoning.output_tokens': 0,
          'lifemodel.call_id': 'call_33333333-3333-3333-3333-333333333333',
          'lifemodel.role': 'smart',
          'lifemodel.slot': 'primary',
          'lifemodel.http.status': 200,
          'lifemodel.attempt': 1,
          'lifemodel.duration_ms': 200,
        },
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
    const launcherDirectory = mkdtempSync(join(tmpdir(), 'doctor-launcher-start-'));
    let startupDiagnostic: string;
    try {
      const main = ts.transpileModule(readFileSync('loader/src/task-launcher-main.ts', 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
      }).outputText;
      writeFileSync(join(launcherDirectory, 'package.json'), '{"type":"module"}');
      writeFileSync(join(launcherDirectory, 'task-launcher-main.js'), main);
      const failedStart = spawnSync(
        process.execPath,
        [join(launcherDirectory, 'task-launcher-main.js')],
        {
          encoding: 'utf8',
          env: {},
          timeout: 10_000,
        }
      );
      expect(failedStart.status).toBe(1);
      startupDiagnostic = failedStart.stderr;
      expect(JSON.parse(startupDiagnostic)).toMatchObject({
        code: 'launcher_start_failed',
        reasonCode: 'ERR_MODULE_NOT_FOUND',
      });
    } finally {
      rmSync(launcherDirectory, { recursive: true, force: true });
    }
    recordTaskPodTermination(
      {
        id: 'task-start-failure',
        traceId: 'stored-run',
        launchId: 'root',
      } as TaskRecord,
      {
        metadata: { uid: 'failed-pod' },
        status: {
          phase: 'Failed',
          containerStatuses: [
            {
              name: 'task',
              state: {
                terminated: {
                  exitCode: 1,
                  reason: 'Error',
                  startedAt,
                  finishedAt: endedAt,
                  message: `${startupDiagnostic}\u001b[2J token=never-print`,
                },
              },
            },
          ],
        },
      },
      writer
    );
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
    expect(result.stdout).toContain('    task.pod [failed] 1000ms');
    expect(result.stdout).toContain('reason="Error"');
    expect(result.stdout).toContain('terminationMessage=');
    expect(result.stdout).toContain('launcher_start_failed');
    expect(result.stdout).toContain('ERR_MODULE_NOT_FOUND');
    expect(result.stdout).toContain('untrusted=true');
    expect(result.stdout).not.toContain('never-print');
    expect(result.stdout).not.toContain('\u001b');
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

  it('renders a model call inside its trace with its usage, slot, effort and prefix parts', () => {
    const result = run(['stored-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('  llm [ok] 1000ms span=chat_1');
    expect(result.stdout).toContain('name="chat smart-model"');
    expect(result.stdout).toContain('role=smart');
    expect(result.stdout).toContain('trigger=user_message');
    expect(result.stdout).toContain('model=smart-model');
    expect(result.stdout).toContain('served=served-model-2026');
    expect(result.stdout).toContain('slot=primary');
    expect(result.stdout).toContain('effort=low');
    expect(result.stdout).toContain('in=1200 cached=1024 out=180 reasoning=64');
    expect(result.stdout).toContain('http=200');
    expect(result.stdout).toContain('call=call_11111111-1111-1111-1111-111111111111');
    expect(result.stdout).toContain(
      'prefix system=aaaa1111/4800 tools=cccc3333/12034 history=eeee5555/900 context=9999aaaa/120'
    );
    // Two spans share a component name but not an id.
    expect(result.stdout).toContain('span=chat_2');
  });

  it('lists recent model calls newest first with a dash where the provider reported nothing', () => {
    const result = run([], {}, 'llm');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('recent model calls, newest first (3)');
    const chatThree = result.stdout.indexOf('call=call_33333333-3333-3333-3333-333333333333');
    const chatTwo = result.stdout.indexOf('call=call_22222222-2222-2222-2222-222222222222');
    const chatOne = result.stdout.indexOf('call=call_11111111-1111-1111-1111-111111111111');
    expect(chatThree).toBeGreaterThan(0);
    expect(chatThree).toBeLessThan(chatTwo);
    expect(chatTwo).toBeLessThan(chatOne);
    expect(result.stdout).toContain(' 2026-01-01T00:00:00.500Z smart smart-model primary low 1200/1024/180/64 1000ms ok call=call_111');
    expect(result.stdout).toContain(' 2026-01-01T00:00:02.000Z fast fast-model reserve - 40/-/7/- 400ms failed call=call_222');
    // A reported zero is a cache miss and reads 0; a dash is "not reported".
    expect(result.stdout).toContain(' 2026-01-01T00:00:03.000Z smart smart-model primary - 1200/0/180/0 200ms ok call=call_333');
    expect(result.stdout).toContain('error=http_500');
  });

  it('rejects a malformed model-call listing count without querying', () => {
    for (const args of [['0'], ['51'], ['NaN'], ['1', '2']]) {
      const result = run(args, {}, 'llm');
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Usage:|integer from 1 to 50/);
    }
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
