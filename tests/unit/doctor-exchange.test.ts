import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestStores, workerDatabaseUrl, type TestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';

const cli = fileURLToPath(new URL('../../deploy/cli/lifemodel.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function run(args: string[], fail = false) {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-exchange-'));
  dirs.push(dir);
  const fake = join(dir, 'kubectl');
  const calls = join(dir, 'calls');
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs=require('node:fs');const cp=require('node:child_process');
const args=process.argv.slice(2);fs.writeFileSync(process.env.EXCHANGE_CALLS,JSON.stringify(args));
if(process.env.EXCHANGE_FAIL==='1'){process.stderr.write('never-print-secret');process.exit(1);}
const command=args.slice(args.indexOf('--')+1);
const result=cp.spawnSync(process.execPath,command.slice(1),{encoding:'utf8',env:{...process.env,LIFEMODEL_DATABASE_URL:process.env.EXCHANGE_DB}});
fs.writeSync(1,result.stdout||'');fs.writeSync(2,result.stderr||'');process.exit(result.status??1);
`
  );
  chmodSync(fake, 0o755);
  const result = spawnSync(process.execPath, [cli, 'doctor', 'exchange', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LIFEMODEL_KUBECTL: fake,
      LIFEMODEL_STATE_DIR: dir,
      EXCHANGE_CALLS: calls,
      EXCHANGE_DB: workerDatabaseUrl(),
      EXCHANGE_FAIL: fail ? '1' : '0',
    },
  });
  return { ...result, calls: () => readFileSync(calls, 'utf8') };
}

describe('doctor exchange readback', () => {
  let stores: TestStores;
  beforeAll(async () => {
    stores = await createTestStores();
    await applyTestMigrations(stores.postgres);
    await stores.postgres.query('TRUNCATE observability.model_exchanges');
    for (const attempt of [1, 2]) {
      await stores.postgres.query(
        `SELECT observability.append_model_exchange($1,$2,'primary','task-one','session-one',$3,now()+interval '1 hour')`,
        [
          'call_fixture',
          attempt,
          {
            inbound: {
              method: 'POST',
              path: '/v1/chat/completions',
              headers: { authorization: '[redacted len=40]' },
              body: 'caller body',
            },
            upstream: {
              url: 'https://upstream.test/v1/chat/completions',
              method: 'POST',
              headers: { 'x-custom': 'present' },
              body: '{"reasoning_effort":"none"}',
            },
            response: { status: 200, headers: { 'x-cache': 'HIT' }, body: 'response\u001b[31m' },
            timing: { startedAt: '2026-10-29T00:00:00Z', firstByteMs: 4, durationMs: 10 },
          },
        ]
      );
    }
    await stores.postgres
      .query(`INSERT INTO observability.model_exchanges(call_id,attempt,slot,exchange,size_bytes,created_at)
      VALUES('expired',1,'primary','{}',1,now()-interval '25 hours')`);
  });
  afterAll(async () => {
    await Promise.all([stores.postgres.end(), stores.redis.quit()]);
  });
  it('prints each attempt, headers, bodies, timings and the model call id through a SELECT-only role', () => {
    const result = run(['call_fixture']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'exchange call=call_fixture attempt=2 slot=primary task=task-one session=session-one'
    );
    expect(result.stdout).toContain('attempt=1');
    for (const text of [
      'inbound',
      'upstream',
      'response',
      'timing',
      'reasoning_effort',
      'none',
      'x-cache',
      'HIT',
      '[redacted len=40]',
    ])
      expect(result.stdout).toContain(text);
    expect(result.stdout).not.toContain('\u001b');
    expect(result.calls()).toContain('SET LOCAL ROLE lifemodel_capture_reader');
    expect(result.calls()).toContain('BEGIN READ ONLY');
    expect(result.calls()).not.toContain('get secrets');
  });
  it('lists the newest N attempts and hides expired rows', () => {
    const result = run(['last', '1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('attempt=2');
    expect(result.stdout).not.toContain('attempt=1');
    expect(result.stdout).toContain('(exchange count truncated)');
    expect(run(['expired']).stdout).toContain('No model exchanges recorded');
  });
  it('bounds body output and marks truncation', async () => {
    await stores.postgres.query(
      `SELECT observability.append_model_exchange('large',1,'primary',NULL,NULL,$1,now()+interval '1 hour')`,
      [{ response: { body: 'x'.repeat(300000) } }]
    );
    const result = run(['large']);
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeLessThan(264000);
    expect(result.stdout).toContain('(exchange display truncated at 262144 characters)');
  });
  it('rejects invalid input and never prints database or kubectl errors', () => {
    for (const args of [
      [],
      ['last', '0'],
      ['last', '21'],
      ['last', '1.5'],
      ['bad;SQL'],
      ['call_fixture', 'extra'],
    ])
      expect(run(args).status).toBe(1);
    const result = run(['last'], true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Exchange store unavailable');
    expect(result.stderr).not.toContain('never-print-secret');
  });
  it('links exchange help to doctor llm call ids', () => {
    const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
    expect(result.stdout).toContain('lifemodel doctor exchange <call_id | last [N]>');
    expect(result.stdout).toContain('call id printed by doctor llm');
  });
});
