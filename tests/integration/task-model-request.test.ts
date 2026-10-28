/** Generic ACP + real loopback relay + stub TLS upstream. No agent/provider implementation. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:https';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpTaskHarness } from '../../loader/src/task-acp.js';
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
        for attempt in range(2 if scenario == "recover" else 1):
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
    error: unknown = { message: 'Capacity exhausted', type: 'overloaded', code: 'retry' }
  ) {
    let attempts = 0;
    const upstream = createServer({ cert: certificate.cert, key: certificate.key }, (req, res) => {
      req.resume();
      expect(req.headers['x-lifemodel-task-token']).toBe(TOKEN);
      expect(req.headers.authorization).toBeUndefined();
      res.writeHead(++attempts === 1 ? status : 200, { 'content-type': 'application/json' });
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
          errorExcerpt: 'Capacity exhausted',
          durationMs: expect.any(Number),
        },
      });
      expect(requests[0]!.attrs.durationMs).toBeGreaterThanOrEqual(0);
    }
  );

  it.each(['prompt-error', 'abnormal'])(
    'links provider_error to its deciding request on %s',
    async (scenario) => {
      const { result, spans } = await run(429, scenario);
      expect(result).toMatchObject({ outcome: 'failed', reasonCode: 'provider_error' });
      expect(spans.find((span) => span.spanId === result.failureSpanId)).toMatchObject({
        component: 'task.model.request',
        status: 'failed',
        attrs: { status: 429, errorExcerpt: 'Capacity exhausted' },
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
        errorExcerpt: '',
        reasonCode: 'acp_prompt_error',
      },
    });
    expect(JSON.stringify(spans)).not.toContain('RAW-ACP-ERROR-CANARY');
  });

  it('bounds error fields and excludes headers, token text, prompts and raw ACP errors', async () => {
    const { spans } = await run(500, 'prompt-error', {
      message: '界'.repeat(500),
      type: 'safe',
      code: 'safe',
      headers: AUTH,
      prompt: PROMPT,
    });
    const request = spans.find((span) => span.component === 'task.model.request')!;
    expect(Buffer.byteLength(String(request.attrs.errorExcerpt))).toBeLessThanOrEqual(300);
    expect(String(request.attrs.errorExcerpt)).toBe('界'.repeat(100));
    const unsafe = await run(500, 'prompt-error', {
      message: `Authorization: Bearer ${AUTH}`,
      type: `token=${TOKEN}`,
      code: TOKEN,
    });
    const serialized = JSON.stringify([...spans, ...unsafe.spans]);
    for (const canary of [TOKEN, AUTH, PROMPT, 'Authorization', 'Bearer', 'RAW-ACP-ERROR-CANARY'])
      expect(serialized).not.toContain(canary);
    expect(
      unsafe.spans.find((span) => span.component === 'task.model.request')!.attrs.errorExcerpt
    ).toBe('[redacted]');
  });

  it.each(['non-json', 'oversized'] as const)('never excerpts a %s response body', async (mode) => {
    const { spans } = await run(
      500,
      'prompt-error',
      mode === 'non-json'
        ? 'PRIVATE-RAW-BODY-CANARY'
        : { message: 'PRIVATE-OVERSIZED-CANARY'.repeat(2000) }
    );
    expect(spans.find((span) => span.component === 'task.model.request')!.attrs.errorExcerpt).toBe(
      ''
    );
    expect(JSON.stringify(spans)).not.toContain('CANARY');
  });

  it.each(['transport', 'timeout', 'stream'] as const)(
    'records one bounded %s failure, even after response headers',
    async (mode) => {
      const upstream = createServer(
        { cert: certificate.cert, key: certificate.key },
        (req, res) => {
          req.resume();
          if (mode === 'transport') req.socket.destroy();
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
        await fetch(`${relay.baseURL}/chat/completions`, { method: 'POST', body: PROMPT })
          .then((response) => response.text())
          .catch(() => undefined);
        await expect.poll(() => observations.length).toBe(1);
        expect(observations[0]).toMatchObject({
          failed: true,
          attempt: 1,
          errorExcerpt: '',
          reasonCode: mode === 'timeout' ? 'model_timeout' : 'model_transport_failed',
        });
        if (mode === 'stream') expect(observations[0]!.status).toBe(200);
        else expect(observations[0]!.status).toBeNull();
      } finally {
        await relay.close();
        upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
      }
    }
  );
});
