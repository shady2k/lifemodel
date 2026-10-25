import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpTaskHarness, AcpTurn } from '../../loader/src/task-acp.js';
import type { TaskHarnessEvent } from '../../loader/src/task-harness.js';

const RESULT = 'The task result is durable.';
const text = (turn: AcpTurn) =>
  turn.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: RESULT } });

// ACP v1: ToolCallUpdate requires only toolCallId. Nullable patch fields leave
// existing values unchanged, including rawInput/rawOutput:
// https://agentclientprotocol.com/protocol/tool-calls#updating
// https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json
const SCRIPT = String.raw`import json, os, signal, sys
scenario = sys.argv[1]
session = "framing-session"
if scenario == "teardown-tail":
    supervisor = os.getppid()
    def teardown_tail(_signum, _frame):
        os.write(sys.stdout.fileno(), b"not-json-from-teardown")
        os.kill(supervisor, signal.SIGCONT)
        os._exit(0)
    signal.signal(signal.SIGTERM, teardown_tail)
    # The supervisor normally kills children immediately on SIGTERM. Suspend
    # just this fixture's supervisor so its SIGTERM cannot race our handler;
    # resume it only after the teardown bytes have reached the stdout pipe.
    os.kill(supervisor, signal.SIGSTOP)
def frame(value):
    return json.dumps({"jsonrpc": "2.0", **value}) + "\n"
def send(value):
    sys.stdout.write(frame(value))
    sys.stdout.flush()
def update(value):
    send({"method": "session/update", "params": {"sessionId": session, "update": value}})
for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if method == "initialize":
        send({"id": message["id"], "result": {"protocolVersion": 1}})
    elif method == "session/new":
        send({"id": message["id"], "result": {"sessionId": session}})
    elif method == "session/prompt":
        if scenario.startswith("patch-") or scenario.startswith("input-"):
            update({"sessionUpdate": "tool_call", "toolCallId": "t", "title": "Working", "status": "pending", "rawInput": {"mustCheck": True}})
            patch = {"sessionUpdate": "tool_call_update", "toolCallId": "t", "status": "completed"}
            if scenario.startswith("input-"):
                patch["rawOutput"] = {"failed": True}
                if scenario == "input-null":
                    patch["rawInput"] = None
            update(patch)
        update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "The task result is durable."}})
        if scenario.startswith("patch-"):
            patch = {"sessionUpdate": "tool_call_update", "toolCallId": "t", "title": "Finished", "locations": [], "rawOutput": {"finished": True}}
            if scenario == "patch-null":
                patch["status"] = None
                patch["rawInput"] = None
            update(patch)
        terminal = frame({"id": message["id"], "result": {"stopReason": "end_turn"}}).encode()
        tails = {
            "clean": b"",
            "whitespace": b" \t\r",
            "malformed": b"not-json",
            "late-tool": json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": {"sessionUpdate": "tool_call", "toolCallId": "late", "title": "Late", "status": "failed"}}}).encode(),
            "truncated-frame": b'{"jsonrpc":"2.0","method":"session/update"',
            "incomplete-utf8": b"\xe2\x82",
        }
        # One write puts terminal and tail in the same batch. Stay alive until
        # the harness signals shutdown; EOF must come from actual teardown,
        # not a sleep or a guessed quiet period after the prompt reply.
        with open("agent.pid", "w") as marker:
            marker.write(str(os.getpid()))
        os.write(sys.stdout.fileno(), terminal + tails.get(scenario, b""))
        while True:
            signal.pause()
`;

describe('ACP nullable per-tool patches', () => {
  it.each([{}, { status: null }, { status: 'completed' }])(
    'preserves final text after a settled call metadata/output patch: %j',
    (patch) => {
      const turn = new AcpTurn();
      turn.update({ sessionUpdate: 'tool_call', toolCallId: 't', status: 'pending' });
      turn.update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' });
      text(turn);
      turn.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't',
        title: 'Finished',
        locations: [],
        rawOutput: { finished: true },
        ...patch,
      });
      expect(turn.toolStatus('t')).toBe('completed');
      expect(turn.result('end_turn')).toEqual({ outcome: 'succeeded', result: RESULT });
    }
  );

  it.each([{}, { rawInput: null }])('retains tool input for output validation: %j', (patch) => {
    const turn = new AcpTurn(
      (output, input) =>
        (output as { failed?: boolean } | undefined)?.failed === true &&
        (input as { mustCheck?: boolean } | undefined)?.mustCheck === true
    );
    turn.update({
      sessionUpdate: 'tool_call',
      toolCallId: 't',
      status: 'pending',
      rawInput: { mustCheck: true },
    });
    turn.update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't',
      status: 'completed',
      rawOutput: { failed: true },
      ...patch,
    });
    text(turn);
    expect(turn.result('end_turn').reasonCode).toBe('required_tool_failed');
  });

  it.each([{}, { rawOutput: null }])(
    'retains output when a later input patch arrives: %j',
    (patch) => {
      const turn = new AcpTurn(
        (output, input) =>
          (output as { failed?: boolean } | undefined)?.failed === true &&
          (input as { mustCheck?: boolean } | undefined)?.mustCheck === true
      );
      turn.update({
        sessionUpdate: 'tool_call',
        toolCallId: 't',
        status: 'completed',
        rawOutput: { failed: true },
      });
      text(turn);
      turn.update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 't',
        rawInput: { mustCheck: true },
        ...patch,
      });
      expect(turn.result('end_turn').reasonCode).toBe('required_tool_failed');
    }
  );

  it('still invalidates earlier prose when tool work resumes and settles', () => {
    const turn = new AcpTurn();
    turn.update({ sessionUpdate: 'tool_call', toolCallId: 't', status: 'completed' });
    text(turn);
    turn.update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'in_progress' });
    turn.update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' });
    expect(turn.result('end_turn').reasonCode).toBe('no_final_result');
  });

  it('does not settle an outstanding call on a null status', () => {
    const turn = new AcpTurn();
    turn.update({ sessionUpdate: 'tool_call', toolCallId: 't', status: 'pending' });
    turn.update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: null });
    text(turn);
    expect(turn.result('end_turn').reasonCode).toBe('required_tool_failed');
    expect(() =>
      turn.update({ sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'unknown' })
    ).toThrow('harness_protocol_error');
  });
});

describe('scripted ACP framing and patch contract', () => {
  let directory: string;
  let script: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'task-acp-framing-'));
    script = join(directory, 'agent.py');
    await writeFile(script, SCRIPT);
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function run(scenario: string) {
    const work = await mkdtemp(join(directory, 'work-'));
    const events: TaskHarnessEvent[] = [];
    const task = new AcpTaskHarness({
      // The scripted agent never calls the model relay. No network fixture or
      // real model/binary provisioning is needed to test generic ACP framing.
      modelEndpoint: 'https://model.invalid',
      modelTokenFile: join(work, 'unused-token'),
      modelCaFile: join(work, 'unused-ca'),
      workDirectory: work,
      timeoutMs: 5000,
      agent: {
        label: 'Scripted framing ACP',
        protocol: 'acp',
        command: 'python3',
        args: [script, scenario],
        configFile: '',
        version: '',
        versionOutput: '',
        versionArgs: [],
        adapterModule: '',
      },
      configure: () => ({}),
      toolOutputFailed: (output, input) =>
        (output as { failed?: boolean } | undefined)?.failed === true &&
        (input as { mustCheck?: boolean } | undefined)?.mustCheck === true,
      onEvent: (event) => {
        events.push(event);
      },
    });
    const result = await task.start({
      text: 'Complete the scripted task.',
      model: 'lifemodel/task',
    });
    const pid = Number(await readFile(join(work, 'agent.pid'), 'utf8'));
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).toThrow();
    return { result, events };
  }

  it.each(['clean', 'whitespace', 'patch-null', 'patch-omitted'])(
    'accepts a clean terminated stream and settled nullable patches: %s',
    async (scenario) => {
      const { result, events } = await run(scenario);
      expect(result).toEqual({ outcome: 'succeeded', result: RESULT });
      if (scenario.startsWith('patch-')) {
        expect(
          events.filter((event) => event.type === 'tool').map((event) => event.status)
        ).toEqual(['running', 'completed', 'completed']);
      }
    },
    10000
  );

  it.each(['input-null', 'input-omitted'])(
    'validates output against retained input across wire patches: %s',
    async (scenario) => {
      expect((await run(scenario)).result).toEqual({
        outcome: 'failed',
        result: '',
        reasonCode: 'required_tool_failed',
        failureSpanId: expect.any(String),
      });
    },
    10000
  );

  it('fails closed on a malformed tail written only by the shutdown signal handler', async () => {
    const { result, events } = await run('teardown-tail');
    const culprit = events
      .flatMap((event) =>
        event.type === 'trace' && event.span.spanId === result.failureSpanId ? [event.span] : []
      )
      .at(-1);
    expect(culprit).toMatchObject({
      status: 'failed',
      attrs: { reasonCode: 'harness_cleanup_failed' },
    });
    expect(result).toEqual({
      outcome: 'failed',
      result: '',
      reasonCode: 'harness_cleanup_failed',
      failureSpanId: expect.any(String),
    });
  }, 10000);

  it.each(['malformed', 'late-tool', 'truncated-frame', 'incomplete-utf8'])(
    'fails closed on an unterminated tail from an agent alive until signalled: %s',
    async (scenario) => {
      expect((await run(scenario)).result).toEqual({
        outcome: 'failed',
        result: '',
        reasonCode: 'harness_cleanup_failed',
        failureSpanId: expect.any(String),
      });
    },
    10000
  );
});
