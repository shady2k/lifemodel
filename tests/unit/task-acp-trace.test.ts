import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpTaskHarness, AcpTurn } from '../../loader/src/task-acp.js';
import type { TaskModelRequest } from '../../loader/src/task-model-relay.js';
import {
  ScriptedTaskHarness,
  type TaskHarnessEvent,
  type TaskHarnessEventSink,
} from '../../loader/src/task-harness.js';
import { toolOutputFailed } from '../../loader/src/task-opencode.js';
import { validateTaskTraceFrame } from '../../src/ports/task-channel.js';

const traces = (events: TaskHarnessEvent[]) =>
  events.flatMap((event) => (event.type === 'trace' ? [event.span] : []));
const final = (turn: AcpTurn, text = 'Recovered final answer') =>
  turn.update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  });
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const requestObservation = (attempt: number, failed = true, method = 'POST'): TaskModelRequest => ({
  startedAt: new Date(attempt).toISOString(),
  endedAt: new Date(attempt + 1).toISOString(),
  durationMs: 1,
  attempt,
  method,
  path: method === 'GET' ? '/v1/models' : '/v1/chat/completions',
  status: failed ? 429 : 200,
  failed,
  errorExcerpt: failed ? 'Capacity exhausted' : '',
});

describe('ACP trace mapping behind the harness port', () => {
  it('bounds 300 failed requests but retains the deciding span and exact counts', async () => {
    const events: TaskHarnessEvent[] = [];
    const turn = new AcpTurn(undefined, (event) => {
      events.push(event);
    });
    turn.begin('task/model');
    for (let attempt = 1; attempt <= 300; attempt++) turn.modelRequest(requestObservation(attempt));
    turn.update({ sessionUpdate: 'tool_call', toolCallId: 'good', status: 'completed' });
    final(turn, 'Retries exhausted');
    const result = turn.result('end_turn');
    turn.finish(result, { stopReason: 'end_turn' });
    await flush();
    const spans = traces(events);
    expect(result).toMatchObject({ outcome: 'failed', reasonCode: 'provider_error' });
    const requests = spans.filter((span) => span.component === 'task.model.request');
    expect(requests).toHaveLength(17);
    expect(requests.find((span) => span.spanId === result.failureSpanId)).toMatchObject({
      attrs: { attempt: 300, status: 429 },
    });
    expect(spans.filter((span) => span.component === 'task.model').at(-1)).toMatchObject({
      status: 'failed',
      attrs: { failedRequests: 300, suppressed: 283 },
    });
    expect(spans.some((span) => span.component === 'task.tool')).toBe(true);
  });

  it.each(['older-success', 'older-failure', 'model-list'] as const)(
    'orders concurrent completion observations by start ordinal, not %s finish timing',
    (mode) => {
      const turn = new AcpTurn();
      turn.begin('model');
      if (mode === 'older-failure') {
        turn.modelRequest(requestObservation(2, false));
        turn.modelRequest(requestObservation(1, true));
      } else {
        turn.modelRequest(requestObservation(2, true));
        turn.modelRequest(
          requestObservation(
            mode === 'model-list' ? 3 : 1,
            false,
            mode === 'model-list' ? 'GET' : 'POST'
          )
        );
      }
      final(turn);
      expect(turn.result('end_turn').outcome).toBe(
        mode === 'older-failure' ? 'succeeded' : 'failed'
      );
    }
  );

  it('does not count client closure as a failure or as recovery of a failed completion', async () => {
    const events: TaskHarnessEvent[] = [];
    const turn = new AcpTurn(undefined, (event) => {
      events.push(event);
    });
    turn.begin('model');
    turn.modelRequest(requestObservation(1));
    turn.modelRequest({ ...requestObservation(2, false), reasonCode: 'client_closed' });
    final(turn);
    const result = turn.result('end_turn');
    turn.finish(result, { stopReason: 'end_turn' });
    await flush();
    expect(result.reasonCode).toBe('provider_error');
    expect(
      traces(events)
        .filter((span) => span.component === 'task.model')
        .at(-1)
    ).toMatchObject({ attrs: { failedRequests: 1, suppressed: 0 } });
  });

  it('appends chunks of one message but replaces prose at a new message identity', () => {
    const turn = new AcpTurn();
    const chunk = (messageId: string, text: string) =>
      turn.update({
        sessionUpdate: 'agent_message_chunk',
        messageId,
        content: { type: 'text', text },
      });
    chunk('first', 'Old final');
    chunk('second', 'New');
    chunk('second', ' final');
    expect(turn.result('end_turn')).toEqual({ outcome: 'succeeded', result: 'New final' });
  });

  it('ignores an invented wire turn_start and resets only through the internal path', () => {
    const turn = new AcpTurn();
    final(turn, 'Retained final');
    turn.update({ sessionUpdate: 'turn_start' });
    expect(turn.result('end_turn')).toEqual({ outcome: 'succeeded', result: 'Retained final' });
    turn.continueTurn();
    expect(turn.result('end_turn')).toMatchObject({
      outcome: 'failed',
      reasonCode: 'no_final_result',
    });
  });

  it('carries settled failure across reset, but later agent work recovers it; pending tools always block', () => {
    const turn = new AcpTurn();
    turn.update({ sessionUpdate: 'tool_call', toolCallId: 'failed', status: 'failed' });
    turn.continueTurn();
    expect(turn.result('end_turn')).toMatchObject({
      outcome: 'failed',
      reasonCode: 'required_tool_failed',
    });
    final(turn);
    expect(turn.result('end_turn').outcome).toBe('succeeded');
    turn.update({ sessionUpdate: 'tool_call', toolCallId: 'pending', status: 'in_progress' });
    turn.continueTurn();
    final(turn);
    expect(turn.result('end_turn')).toMatchObject({
      outcome: 'failed',
      reasonCode: 'required_tool_failed',
    });
  });

  it('recovers after a failed call while preserving its failed span', async () => {
    const events: TaskHarnessEvent[] = [];
    const turn = new AcpTurn(toolOutputFailed, (event) => {
      events.push(event);
    });
    turn.begin('test-model');
    turn.update({ sessionUpdate: 'usage_update', used: 12, size: 100 });
    turn.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'bad',
      kind: 'execute',
      title: 'Probe',
      status: 'pending',
      rawInput: { command: 'exit 42' },
    });
    turn.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'bad',
      status: 'completed',
      rawOutput: { metadata: { exit: 42 }, output: 'failed output' },
    });
    turn.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'good',
      kind: 'execute',
      status: 'completed',
      rawInput: { command: 'true' },
      rawOutput: { metadata: { exit: 0 }, output: 'good output' },
    });
    final(turn);
    const result = turn.result('end_turn');
    turn.finish(result, { stopReason: 'end_turn', usage: { inputTokens: 11, outputTokens: 7 } });
    await flush();
    expect(result).toEqual({ outcome: 'succeeded', result: 'Recovered final answer' });
    const spans = traces(events);
    const model = spans.find((span) => span.component === 'task.model' && span.endedAt);
    expect(model).toMatchObject({
      status: 'ok',
      parentSpanId: null,
      attrs: {
        model: 'test-model',
        stopReason: 'end_turn',
        inputTokens: 11,
        outputTokens: 7,
        used: 12,
      },
    });
    expect(model!.attrs['durationMs']).toBeGreaterThanOrEqual(0);
    const bad = spans.filter(
      (span) => span.component === 'task.tool' && span.attrs['toolCallId'] === 'bad'
    );
    expect(bad).toHaveLength(2);
    expect(bad[0]).toMatchObject({ status: null, endedAt: null });
    expect(bad[1]).toMatchObject({
      spanId: bad[0]!.spanId,
      parentSpanId: model!.spanId,
      status: 'failed',
      attrs: {
        kind: 'execute',
        title: 'Probe',
        command: 'exit 42',
        hostStatus: 'completed',
        exitCode: 42,
        outputTail: 'failed output',
      },
    });
    expect(result.failureSpanId).toBeUndefined();
    expect(spans.find((span) => span.attrs['toolCallId'] === 'good')).toMatchObject({
      status: 'ok',
      attrs: { exitCode: 0 },
    });
    expect(spans.find((span) => span.component === 'task.completion')).toMatchObject({
      parentSpanId: model!.spanId,
      attrs: { finalText: 'Recovered final answer' },
    });
  });

  it('names the trailing failure rather than an earlier recovered failure', async () => {
    const events: TaskHarnessEvent[] = [];
    const turn = new AcpTurn(toolOutputFailed, (event) => {
      events.push(event);
    });
    turn.begin('model');
    turn.update({ sessionUpdate: 'tool_call', toolCallId: 'earlier', status: 'failed' });
    final(turn);
    turn.update({ sessionUpdate: 'tool_call', toolCallId: 'trailing', status: 'pending' });
    turn.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'trailing',
      status: 'completed',
      rawOutput: { metadata: { exit: 1 } },
    });
    // Whitespace, usage and presentation updates are not agent recovery.
    final(turn, '  ');
    turn.update({ sessionUpdate: 'usage_update', used: 10 });
    turn.update({ sessionUpdate: 'tool_call_update', toolCallId: 'trailing', title: 'Done' });
    const result = turn.result('end_turn');
    turn.finish(result, { stopReason: 'end_turn' });
    await flush();
    expect(result).toMatchObject({ outcome: 'failed', reasonCode: 'required_tool_failed' });
    expect(
      traces(events)
        .filter((span) => span.spanId === result.failureSpanId)
        .at(-1)
    ).toMatchObject({
      component: 'task.tool',
      status: 'failed',
      attrs: { toolCallId: 'trailing' },
    });
  });

  it.each(['failed', 'exit', 'background', 'running', 'signal', 'timeout'])(
    'accepts nonempty assistant work after a settled %s failure',
    (mode) => {
      const turn = new AcpTurn(toolOutputFailed);
      turn.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'probe',
        status: mode === 'failed' ? 'failed' : 'completed',
        rawInput: mode === 'background' ? { background: true } : {},
        rawOutput: {
          metadata: {
            ...(mode === 'exit' ? { exit: 42 } : {}),
            ...(mode === 'running' ? { status: 'running' } : {}),
            ...(mode === 'signal' ? { signal: 'SIGKILL' } : {}),
            ...(mode === 'timeout' ? { timeout: true } : {}),
          },
        },
      });
      final(turn);
      turn.update({ sessionUpdate: 'tool_call_update', toolCallId: 'probe', status: null });
      expect(turn.result('end_turn')).toEqual({
        outcome: 'succeeded',
        result: 'Recovered final answer',
      });
    }
  );

  it('does not treat another already-running call settling as later agent work', () => {
    const turn = new AcpTurn();
    turn.update({ sessionUpdate: 'tool_call', toolCallId: 'other', status: 'in_progress' });
    turn.update({ sessionUpdate: 'tool_call', toolCallId: 'bad', status: 'failed' });
    turn.update({ sessionUpdate: 'tool_call_update', toolCallId: 'other', status: 'completed' });
    expect(turn.result('end_turn').reasonCode).toBe('required_tool_failed');
  });

  it.each(['new', 'resumed'])(
    'counts %s tool work as recovery but still requires final text',
    (mode) => {
      const turn = new AcpTurn();
      turn.update({ sessionUpdate: 'tool_call', toolCallId: 'retry', status: 'completed' });
      turn.update({ sessionUpdate: 'tool_call', toolCallId: 'bad', status: 'failed' });
      const toolCallId = mode === 'new' ? 'next' : 'retry';
      turn.update({ sessionUpdate: 'tool_call', toolCallId, status: 'in_progress' });
      turn.update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
      expect(turn.result('end_turn').reasonCode).toBe('no_final_result');
      final(turn);
      expect(turn.result('end_turn').outcome).toBe('succeeded');
    }
  );

  it('recovers resumed failed work once its new result is successful', () => {
    const turn = new AcpTurn(toolOutputFailed);
    turn.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'retry',
      status: 'completed',
      rawOutput: { metadata: { exit: 42 } },
    });
    final(turn);
    turn.update({ sessionUpdate: 'tool_call_update', toolCallId: 'retry', status: 'in_progress' });
    turn.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'retry',
      status: 'completed',
      rawOutput: { metadata: { exit: 0 } },
    });
    expect(turn.result('end_turn').reasonCode).toBe('no_final_result');
    final(turn);
    expect(turn.result('end_turn').outcome).toBe('succeeded');
  });

  it.each(['background', 'failed'])(
    'reopens recovered %s failure on newly reported exit evidence',
    (mode) => {
      const turn = new AcpTurn(toolOutputFailed);
      turn.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'probe',
        status: mode === 'failed' ? 'failed' : 'completed',
        rawInput: mode === 'background' ? { background: true } : {},
      });
      final(turn);
      expect(turn.result('end_turn').outcome).toBe('succeeded');
      turn.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'probe',
        rawOutput: { metadata: { exit: 42 } },
      });
      expect(turn.result('end_turn').reasonCode).toBe('required_tool_failed');
      final(turn);
      // Structurally identical retransmission is still the same failure evidence.
      turn.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'probe',
        rawOutput: { metadata: { exit: 42 } },
      });
      expect(turn.result('end_turn').outcome).toBe('succeeded');
    }
  );

  it('requires new work after a late output patch newly reveals failure', () => {
    const turn = new AcpTurn(toolOutputFailed);
    turn.update({ sessionUpdate: 'tool_call', toolCallId: 'probe', status: 'completed' });
    final(turn);
    turn.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'probe',
      rawOutput: { metadata: { exit: 1 } },
    });
    expect(turn.result('end_turn').reasonCode).toBe('required_tool_failed');
    final(turn);
    expect(turn.result('end_turn').outcome).toBe('succeeded');
  });

  it.each(['pending', 'in_progress'])('never recovers a still %s call', (status) => {
    const turn = new AcpTurn();
    turn.update({ sessionUpdate: 'tool_call', toolCallId: 'unfinished', status });
    final(turn);
    expect(turn.result('end_turn').reasonCode).toBe('required_tool_failed');
  });

  it('closes an unsettled tool as failed and retains its exact culprit id', async () => {
    const events: TaskHarnessEvent[] = [];
    const turn = new AcpTurn(undefined, (event) => {
      events.push(event);
    });
    turn.begin('model');
    turn.update({ sessionUpdate: 'tool_call', toolCallId: 'unfinished', status: 'in_progress' });
    final(turn);
    const result = turn.result('end_turn');
    turn.finish(result, { stopReason: 'end_turn' });
    await flush();
    expect(
      traces(events)
        .filter((span) => span.spanId === result.failureSpanId)
        .at(-1)
    ).toMatchObject({
      status: 'failed',
      endedAt: expect.any(String),
      attrs: { reasonCode: 'unsettled_tool' },
    });
  });

  it('marks a blank end_turn as failed rather than a successful model span', async () => {
    const events: TaskHarnessEvent[] = [];
    const turn = new AcpTurn(undefined, (event) => {
      events.push(event);
    });
    turn.begin('model');
    const result = turn.result('end_turn');
    turn.finish(result, { stopReason: 'end_turn' });
    await flush();
    expect(result.reasonCode).toBe('no_final_result');
    expect(
      traces(events)
        .filter((span) => span.component === 'task.model')
        .at(-1)
    ).toMatchObject({
      status: 'failed',
      endedAt: expect.any(String),
    });
  });

  it('records unknown host status as failed before failing the protocol closed', async () => {
    const events: TaskHarnessEvent[] = [];
    const turn = new AcpTurn(undefined, (event) => {
      events.push(event);
    });
    turn.begin('model');
    expect(() =>
      turn.update({ sessionUpdate: 'tool_call', toolCallId: 'unknown', status: 'surprise' })
    ).toThrow('harness_protocol_error');
    await flush();
    expect(traces(events).find((span) => span.component === 'task.tool')).toMatchObject({
      status: 'failed',
      attrs: { hostStatus: 'surprise', toolCallId: 'unknown' },
    });
  });

  it('bounds multibyte final text and output tail, retaining the tail not the head', async () => {
    const events: TaskHarnessEvent[] = [];
    const turn = new AcpTurn(undefined, (event) => {
      events.push(event);
    });
    turn.begin('model');
    turn.update({
      sessionUpdate: 'tool_call',
      toolCallId: 'tail',
      status: 'completed',
      rawOutput: 'discarded head' + '界'.repeat(4000) + 'LAST',
    });
    final(turn, '😀'.repeat(4000));
    turn.finish(turn.result('end_turn'), { stopReason: 'end_turn' });
    await flush();
    const output = traces(events).find((span) => span.component === 'task.tool')!.attrs[
      'outputTail'
    ] as string;
    const text = traces(events).find((span) => span.component === 'task.completion')!.attrs[
      'finalText'
    ] as string;
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4000);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4000);
    expect(output.endsWith('LAST')).toBe(true);
    expect(output).not.toContain('discarded head');
  });
});

const SCRIPT = String.raw`import json, sys
mode = sys.argv[1]
session = "trace-test"
def send(value):
    print(json.dumps({"jsonrpc": "2.0", **value}), flush=True)
def update(value):
    send({"method": "session/update", "params": {"sessionId": session, "update": value}})
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        send({"id": msg["id"], "result": {"protocolVersion": 1}})
    elif msg.get("method") == "session/new":
        send({"id": msg["id"], "result": {"sessionId": session}})
    elif msg.get("method") == "session/prompt":
        if mode in ("recovered", "trailing"):
            update({"sessionUpdate": "tool_call", "toolCallId": "failed-probe", "kind": "execute", "status": "completed", "rawInput": {"command": "exit 42"}, "rawOutput": {"metadata": {"exit": 42}, "output": "bad output"}})
        if mode == "recovered":
            update({"sessionUpdate": "tool_call", "toolCallId": "recovered", "kind": "execute", "status": "completed", "rawInput": {"command": "true"}, "rawOutput": {"metadata": {"exit": 0}}})
        if mode != "trailing":
            update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Real ACP final answer"}})
        send({"id": msg["id"], "result": {"stopReason": "end_turn", "usage": {"inputTokens": 9, "outputTokens": 4}}})
`;

describe('real ACP wire mapping and fail-open tracing', () => {
  let directory: string;
  let script: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'acp-trace-'));
    script = join(directory, 'agent.py');
    await writeFile(script, SCRIPT);
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  async function run(onEvent: TaskHarnessEventSink, mode = 'trailing') {
    const work = await mkdtemp(join(directory, 'work-'));
    return new AcpTaskHarness({
      modelEndpoint: 'https://model.invalid',
      modelTokenFile: join(work, 'unused-token'),
      modelCaFile: join(work, 'unused-ca'),
      workDirectory: work,
      timeoutMs: 5000,
      agent: {
        label: 'Trace fixture',
        protocol: 'acp',
        command: 'python3',
        args: [script, mode],
        configFile: '',
        version: '',
        versionOutput: '',
        versionArgs: [],
        adapterModule: '',
      },
      configure: () => ({}),
      toolOutputFailed,
      onEvent,
    }).start({ text: 'Fixture task', model: 'model' });
  }
  it('maps actual trailing failure frames with the exact offending span', async () => {
    const events: TaskHarnessEvent[] = [];
    const result = await run((event) => {
      events.push(event);
    });
    expect(result).toMatchObject({ outcome: 'failed', reasonCode: 'required_tool_failed' });
    const spans = traces(events);
    for (const span of spans)
      expect(() =>
        validateTaskTraceFrame({
          taskId: 'task',
          attemptId: 'attempt',
          launchId: 'launch',
          span: { ...span, traceId: 'trace' },
        })
      ).not.toThrow();
    const bad = spans.find((span) => span.spanId === result.failureSpanId);
    expect(bad).toMatchObject({
      component: 'task.tool',
      status: 'failed',
      attrs: {
        toolCallId: 'failed-probe',
        command: 'exit 42',
        exitCode: 42,
        outputTail: 'bad output',
      },
    });
    expect(spans.find((span) => span.component === 'task.model' && span.endedAt)).toMatchObject({
      attrs: { stopReason: 'end_turn', inputTokens: 9, outputTokens: 4 },
    });
  }, 10000);
  it.each(['throw', 'reject', 'hang'] as const)(
    'never gates protocol or outcome on %s trace sink',
    async (mode) => {
      let count = 0;
      const result = await run((event) => {
        if (event.type !== 'trace') return;
        count++;
        if (mode === 'throw') throw new Error('broken trace');
        if (mode === 'reject') return Promise.reject(new Error('broken trace'));
        return new Promise<void>(() => {});
      });
      expect(count).toBeGreaterThan(0);
      expect(result).toMatchObject({
        outcome: 'failed',
        reasonCode: 'required_tool_failed',
        failureSpanId: expect.any(String),
      });
    },
    10000
  );
  it('accepts actual recovered failure frames and keeps the failed tool observation', async () => {
    const events: TaskHarnessEvent[] = [];
    const result = await run((event) => {
      events.push(event);
    }, 'recovered');
    expect(result).toEqual({ outcome: 'succeeded', result: 'Real ACP final answer' });
    expect(
      traces(events).find((span) => span.attrs['toolCallId'] === 'failed-probe')
    ).toMatchObject({ status: 'failed' });
    expect(
      traces(events).find((span) => span.component === 'task.model' && span.endedAt)
    ).toMatchObject({ status: 'ok' });
  }, 10000);
  it('a hanging trace sink cannot turn a successful prompt into failure', async () => {
    const result = await run(
      (event) => (event.type === 'trace' ? new Promise<void>(() => {}) : undefined),
      'success'
    );
    expect(result).toEqual({ outcome: 'succeeded', result: 'Real ACP final answer' });
  }, 10000);
  it('also keeps scripted-harness trace events fail-open', async () => {
    const harness = new ScriptedTaskHarness({
      events: [
        {
          type: 'trace',
          span: {
            spanId: 'span',
            parentSpanId: null,
            component: 'task.model',
            startedAt: new Date().toISOString(),
            endedAt: null,
            status: null,
            attrs: {},
          },
        },
      ],
      onEvent: () => new Promise<void>(() => {}),
    });
    await expect(harness.start({ text: 'fixture', model: 'model' })).resolves.toMatchObject({
      outcome: 'succeeded',
    });
  });
});
