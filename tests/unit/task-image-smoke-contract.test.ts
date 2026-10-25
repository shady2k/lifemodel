import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const fixture = readFileSync('tests/fixtures/task-launcher-image-smoke.mjs', 'utf8');

async function protocol() {
  // Run the real smoke handler without its image launcher, TLS listeners or /work writes.
  // The first top-level try starts those external resources; declarations above it
  // are the same protocol exercised by the documented real-image acceptance run.
  const declarations = fixture
    .slice(0, fixture.indexOf('\ntry {\n  await mkdir'))
    .replace(/^import .*;\n/gm, '');
  return runInNewContext(
    `(async () => { ${declarations}
      return { handler, ids, objects, violations, terminalFrames, tokens,
        traceFrames: () => typeof traceFrames === 'undefined' ? [] : traceFrames };
    })()`,
    { process: { env: {} }, Buffer, readFile: async () => Buffer.alloc(0) }
  );
}

async function request(api: Awaited<ReturnType<typeof protocol>>, path: string, body: object) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: 'POST',
    url: path,
    headers: { authorization: `Bearer ${api.tokens.channel}` },
  });
  let status: number | undefined;
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end() {},
  };
  await api.handler('channel', req, res);
  return status;
}

describe('real-image smoke trace contract', () => {
  it('accepts success with marked result/artifacts and no removed log field or log object', async () => {
    const api = await protocol();
    api.objects.set('result_1', { id: 'result_1', mark: 'result' });
    api.objects.set('artifact_1', { id: 'artifact_1', mark: 'artifact' });
    const status = await request(api, '/task/events', {
      taskId: api.ids.taskId,
      attemptId: api.ids.attemptId,
      direction: 'task_to_core',
      messageId: `msg_${'a'.repeat(8)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(12)}`,
      sequence: 1,
      kind: 'terminal',
      payload: {
        outcome: 'succeeded',
        resultObjectId: 'result_1',
        artifactObjectIds: ['artifact_1'],
      },
    });
    expect(status).toBe(200);
    expect(api.violations).toEqual([]);
    expect(
      /objects\.get\((?:frame\.payload|report)\.logObjectId\)/.test(fixture),
      'image smoke must not dereference the removed log object'
    ).toBe(false);
    expect(
      fixture.includes('assert.equal(objects.size, 1)'),
      'text-only smoke stores one object'
    ).toBe(true);
  });

  it.each(['unmarked artifact', 'log field', 'log object'])(
    'rejects a terminal with %s',
    async (invalid) => {
      const api = await protocol();
      api.objects.set('result_1', { id: 'result_1', mark: 'result' });
      if (invalid === 'log object')
        api.objects.set('log_1', { id: 'log_1', name: 'log.jsonl', mark: 'log' });
      const status = await request(api, '/task/events', {
        taskId: api.ids.taskId,
        attemptId: api.ids.attemptId,
        direction: 'task_to_core',
        messageId: 'msg_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        sequence: 1,
        kind: 'terminal',
        payload: {
          outcome: 'succeeded',
          resultObjectId: 'result_1',
          artifactObjectIds: invalid === 'unmarked artifact' ? ['missing_1'] : [],
          ...(invalid === 'log field' ? { logObjectId: 'log_1' } : {}),
        },
      });
      expect(status).toBe(400);
      expect(api.violations).toEqual(['terminal_before_marks']);
    }
  );

  it('handles disposable trace requests separately from terminal frames', async () => {
    const api = await protocol();
    const status = await request(api, '/task/trace', {
      ...api.ids,
      span: {
        traceId: api.ids.taskId,
        spanId: api.ids.launchId,
        parentSpanId: null,
        component: 'task',
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: null,
        attrs: { taskId: api.ids.taskId, launchId: api.ids.launchId },
      },
    });
    expect(status).toBe(200);
    expect(api.violations).toEqual([]);
    expect(api.terminalFrames).toHaveLength(0);
    expect(api.traceFrames()).toHaveLength(1);
  });

  it('documents result-only image smoke storage and separate disposable traces', () => {
    const doc = readFileSync('docs/features/motor/task-harness.md', 'utf8').replace(/\s+/g, ' ');
    expect(doc.includes('two marked objects'), 'obsolete image storage claim').toBe(false);
    expect(doc.includes('one marked result object'), 'result-only smoke contract').toBe(true);
    expect(doc.includes('/task/trace'), 'separate disposable trace route').toBe(true);
  });
});
