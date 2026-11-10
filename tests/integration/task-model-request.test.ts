/** Generic ACP + real loopback relay + stub TLS upstream. No agent/provider implementation. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpTaskHarness, AcpTurn } from '../../loader/src/task-acp.js';
import { createTaskModelRelay, type TaskModelRequest } from '../../loader/src/task-model-relay.js';
import type { TaskHarnessEvent } from '../../loader/src/task-harness.js';
import {
  createStorageCertificate,
  type TestStorageCertificate,
} from '../helpers/storage-certificate.js';

const TOKEN = 'PROJECTED-CREDENTIAL-CANARY';
const AUTH = 'AUTHORIZATION-CANARY';
const PROMPT = 'PRIVATE-PROMPT-CANARY';
const SCRIPT = String.raw`import json, os, signal, sys, urllib.request, urllib.error
scenario = sys.argv[1]
def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)
for line in sys.stdin:
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"id": msg["id"], "result": {"protocolVersion": 1}})
    elif method == "session/new":
        send({"id": msg["id"], "result": {"sessionId": "test"}})
    elif method == "session/prompt":
        for attempt in range(3 if scenario == "exhausted" else 2 if scenario == "recover" else 1):
            req = urllib.request.Request(os.environ["RELAY"] + "/chat/completions", data=b'PRIVATE-PROMPT-CANARY', headers={"Authorization": "Bearer AUTHORIZATION-CANARY"})
            try:
                urllib.request.urlopen(req).read()
            except urllib.error.HTTPError as error:
                error.read()
        if scenario == "prompt-error":
            send({"id": msg["id"], "error": {"code": -32603, "message": "RAW-ACP-ERROR-CANARY"}})
        else:
            send({"method": "session/update", "params": {"sessionId": "test", "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Files are ready."}}}})
            send({"id": msg["id"], "result": {"stopReason": "max_tokens" if scenario == "abnormal" else "end_turn"}})
        while True:
            signal.pause()
`;

describe('model request failures are observations, not permanent task failure', () => {
  let certificate: TestStorageCertificate;
  let directory: string;
  beforeAll(async () => {
    certificate = await createStorageCertificate(['localhost']);
    directory = await mkdtemp(join(tmpdir(), 'task-model-request-'));
    await writeFile(join(directory, 'ca'), certificate.ca);
    await writeFile(join(directory, 'token'), TOKEN);
    await writeFile(join(directory, 'agent.py'), SCRIPT);
  });
  afterAll(async () => {
    await certificate.cleanup();
    await rm(directory, { recursive: true, force: true });
  });

  async function run(
    status: number,
    scenario: string,
    error: unknown = { type: 'gateway_error', code: 'upstream_429' }
  ) {
    let attempts = 0;
    const upstream = createServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
      req.resume();
      expect(req.headers['x-lifemodel-task-token']).toBe(TOKEN);
      expect(req.headers.authorization).toBeUndefined();
      res.writeHead(++attempts === 1 || scenario === 'exhausted' ? status : 200, {
        'content-type': 'application/json',
      });
      res.end(
        typeof error === 'string'
          ? error
          : JSON.stringify({ error, request: PROMPT, authorization: AUTH, token: TOKEN })
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('no listener');
    const events: TaskHarnessEvent[] = [];
    const work = await mkdtemp(join(directory, 'work-'));
    const task = new AcpTaskHarness({
      modelEndpoint: `https://localhost:${address.port}`,
      modelCaFile: join(directory, 'ca'),
      modelTokenFile: join(directory, 'token'),
      workDirectory: work,
      timeoutMs: 5000,
      agent: {
        label: 'Scripted ACP',
        protocol: 'acp',
        command: 'python3',
        args: [join(directory, 'agent.py'), scenario],
        configFile: '',
        version: '',
        versionOutput: '',
        versionArgs: [],
        adapterModule: '',
      },
      configure: ({ relayBaseURL }) => ({ RELAY: relayBaseURL }),
      onEvent: (event) => {
        events.push(event);
      },
    });
    try {
      const result = await task.start({ text: PROMPT, model: 'task/model' });
      await Promise.resolve();
      const spans = events.flatMap((event) => (event.type === 'trace' ? [event.span] : []));
      return { result, spans, attempts };
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }

  it.each([429, 500])(
    'recovers from HTTP %s and leaves a warning request under an ok model',
    async (status) => {
      const { result, spans, attempts } = await run(status, 'recover');
      expect(attempts).toBe(2);
      expect(result).toEqual({ outcome: 'succeeded', result: 'Files are ready.' });
      const model = spans.filter((span) => span.component === 'task.model').at(-1)!;
      expect(model.status).toBe('ok');
      const requests = spans.filter((span) => span.component === 'task.model.request');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        parentSpanId: model.spanId,
        status: 'failed',
        endedAt: expect.any(String),
        attrs: {
          status,
          method: 'POST',
          path: '/v1/chat/completions',
          attempt: 1,
          severity: 'warn',
          reasonCode: 'upstream_429',
          durationMs: expect.any(Number),
        },
      });
      expect(requests[0]!.attrs.durationMs).toBeGreaterThanOrEqual(0);
    }
  );

  it.each(['prompt-error', 'abnormal', 'exhausted'])(
    'links provider_error to its deciding request on %s',
    async (scenario) => {
      const { result, spans, attempts } = await run(429, scenario);
      if (scenario === 'exhausted') expect(attempts).toBe(3);
      expect(result).toMatchObject({ outcome: 'failed', reasonCode: 'provider_error' });
      expect(spans.find((span) => span.spanId === result.failureSpanId)).toMatchObject({
        component: 'task.model.request',
        status: 'failed',
        attrs: { status: 429, reasonCode: 'upstream_429' },
      });
    }
  );

  it('gives a prompt error without a failed HTTP request its own safe deciding span', async () => {
    const { result, spans } = await run(200, 'prompt-error');
    expect(result).toMatchObject({ outcome: 'failed', reasonCode: 'provider_error' });
    expect(spans.find((span) => span.spanId === result.failureSpanId)).toMatchObject({
      component: 'task.model.request',
      status: 'failed',
      attrs: {
        method: 'ACP',
        path: 'session/prompt',
        status: null,
        reasonCode: 'acp_prompt_error',
      },
    });
    expect(JSON.stringify(spans)).not.toContain('RAW-ACP-ERROR-CANARY');
  });

  it.each(['older-success', 'older-failure', 'model-list'] as const)(
    'keeps completion start ordering through concurrent relay requests: %s',
    async (mode) => {
      let arrivals = 0;
      const firstArrived = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      const upstream = createServer(
        { cert: certificate.cert, key: certificate.key },
        (req, res) => {
          req.resume();
          const first = ++arrivals === 1;
          const answer = () => {
            res.writeHead(
              (mode === 'older-failure' ? first : !first) && req.method === 'POST' ? 429 : 200
            );
            res.end(JSON.stringify({ error: { message: 'Capacity exhausted' } }));
          };
          if (first) {
            firstArrived.resolve();
            void releaseFirst.promise.then(answer);
          } else answer();
        }
      );
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      if (!address || typeof address === 'string') throw new Error('no listener');
      const events: TaskHarnessEvent[] = [];
      const turn = new AcpTurn(undefined, (event) => {
        events.push(event);
      });
      turn.begin('task/model');
      const relay = await createTaskModelRelay({
        modelEndpoint: `https://localhost:${address.port}`,
        modelTokenFile: join(directory, 'token'),
        modelCaFile: join(directory, 'ca'),
        timeoutMs: 2000,
        onRequest: (request) => turn.modelRequest(request),
      });
      const post = () =>
        fetch(`${relay.baseURL}/chat/completions`, { method: 'POST', body: PROMPT }).then((res) =>
          res.text()
        );
      try {
        const first = post();
        await firstArrived.promise;
        await post();
        if (mode === 'model-list') await fetch(`${relay.baseURL}/models`).then((res) => res.text());
        releaseFirst.resolve();
        await first;
        turn.update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Final text' },
        });
        const result = turn.result('end_turn');
        turn.finish(result, { stopReason: 'end_turn' });
        await Promise.resolve();
        expect(result.outcome).toBe(mode === 'older-failure' ? 'succeeded' : 'failed');
        if (mode !== 'older-failure')
          expect(
            events.find(
              (event) => event.type === 'trace' && event.span.spanId === result.failureSpanId
            )
          ).toMatchObject({ type: 'trace', span: { attrs: { attempt: 2 } } });
      } finally {
        releaseFirst.resolve();
        await relay.close();
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      }
    }
  );

  it('keeps only a gateway-owned code, never model fields or arbitrary codes', async () => {
    const { spans } = await run(500, 'prompt-error', {
      message: PROMPT,
      type: 'gateway_error',
      code: 'upstream_500',
    });
    expect(spans.find((span) => span.component === 'task.model.request')!.attrs).toMatchObject({
      reasonCode: 'upstream_500',
    });
    for (const error of [
      { message: PROMPT, type: 'gateway_error', code: TOKEN },
      { message: PROMPT, type: 'validation_error', code: 'upstream_500' },
      'PRIVATE-RAW-BODY-CANARY',
      { message: 'PRIVATE-OVERSIZED-CANARY'.repeat(2000) },
    ]) {
      const result = await run(500, 'prompt-error', error);
      const attrs = result.spans.find((span) => span.component === 'task.model.request')!.attrs;
      expect(attrs).not.toHaveProperty('errorExcerpt');
      expect(attrs.reasonCode).toBeUndefined();
      expect(JSON.stringify(result.spans)).not.toContain('CANARY');
    }
    expect(JSON.stringify(spans)).not.toContain(PROMPT);
  });

  it.each(['transport', 'timeout', 'stream', 'client-close'] as const)(
    'records one bounded %s failure, even after response headers',
    async (mode) => {
      const upstream = createServer(
        { cert: certificate.cert, key: certificate.key },
        (req, res) => {
          req.resume();
          if (mode === 'transport') req.socket.destroy();
          if (mode === 'client-close') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: partial\n\n');
          }
          if (mode === 'stream') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write('data: partial\n\n', () => res.socket?.destroy());
          }
        }
      );
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address();
      if (!address || typeof address === 'string') throw new Error('no listener');
      const observations: TaskModelRequest[] = [];
      const relay = await createTaskModelRelay({
        modelEndpoint: `https://localhost:${address.port}`,
        modelTokenFile: join(directory, 'token'),
        modelCaFile: join(directory, 'ca'),
        timeoutMs: 150,
        startupWindowMs: 0,
        onRequest: (request) => {
          observations.push(request);
        },
      });
      try {
        if (mode === 'client-close') {
          await new Promise<void>((resolve, reject) => {
            const req = httpRequest(
              `${relay.baseURL}/chat/completions`,
              { method: 'POST' },
              (res) => {
                res.once('data', () => {
                  res.destroy();
                  resolve();
                });
              }
            );
            req.on('error', reject);
            req.end(PROMPT);
          });
        } else
          await fetch(`${relay.baseURL}/chat/completions`, { method: 'POST', body: PROMPT })
            .then((response) => response.text())
            .catch(() => undefined);
        await expect.poll(() => observations.length).toBe(1);
        expect(observations[0]).toMatchObject({
          failed: mode !== 'client-close',
          attempt: 1,
          reasonCode:
            mode === 'client-close'
              ? 'client_closed'
              : mode === 'timeout'
                ? 'model_timeout'
                : 'model_transport_failed',
        });
        if (mode === 'stream' || mode === 'client-close') expect(observations[0]!.status).toBe(200);
        else expect(observations[0]!.status).toBeNull();
      } finally {
        await relay.close();
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      }
    }
  );
});
