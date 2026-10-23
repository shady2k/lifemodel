# Task harness and launcher

Task: lifemodel-653.8.7. Implements the pod-local side of ADR-014 D1/D2.
This is a source contract, not deployed stage acceptance.

## Authority before execution

The workbench ENTRYPOINT runs `loader/src/task-launcher-main.ts`. With no
arguments it runs one task. `--self-check` remains an offline image check.
No task API, shell command, prompt or provider credential comes from Job args.

The ten [launch environment values](task-launch.md) contain endpoints and files,
not registry IDs. The launcher first calls `GET /task/identity` on the core task
channel. That route freshly verifies the channel-audience bound Pod/Job and
checks its allocated registry binding and active canonical intent. It returns
only `{taskId,attemptId,launchId}`. It exposes neither the briefing nor a start
permit. Repeating this read cannot replace a gateway start claim.

One memory-only `randomUUID()` boot nonce is generated per launcher invocation.
The launcher sends exactly one `POST /task/start` with those three IDs and the
nonce, using the model-audience bearer token. Only a timely 200 `start:true`,
matching IDs, matching space and a future hard deadline enters the running
transition. A timeout, lost reply, refused/consumed start or invalid reply is
`start_lost`: do not retry, change the nonce or start a harness. A best-effort
failed report is attempted; channel authority may correctly refuse it if this
Pod did not win the claim. The Job's nonzero exit then remains the observation
for finalization. It is not a semantic success or permission to rerun.

After winning, the launcher calls `GET /task/briefing` once on the same core
listener. Its authority additionally checks the exact won claim and projection.
The reply contains IDs, `briefing` and the accepted resource `profile`; there is
no prompt in the Job spec or task storage. A refused/failed read starts no
harness and reports `failed` / `briefing_unavailable`. Responses are capped at
1 MiB. Both GET routes share the channel's reservations, deadlines and dedicated
SQL/identity workers. Neither caches positive authority.

## Pod-local harness port

`loader/src/task-harness.ts` declares `TaskHarness.start(briefing)`, `abort()`,
`steer(text)` and `wrap()`. Stage 3 returns `not_supported` for steer/wrap.
Normalized events are short `step`, `tool` and safe-code `error` events. One
start returns one semantic result: `succeeded`, `failed` or `aborted`, with
result text and a safe failure reason. `ScriptedTaskHarness` implements the
same port for caller tests; it is not a second production agent.

`OpenCodeTaskHarness` runs the pinned OpenCode 1.19.4 `serve` binary, bound to
loopback only, with its working directory under `/work` and private HOME/TMPDIR.
It drives one session through HTTP/SSE. Those raw APIs never leave the Pod.
Tool subprocesses receive the four storage CLI environment values explicitly,
not the model/channel environment values. They can upload and mark artifacts
through task-scoped storage authority. No provider key is available.

The fixed baked provider/model is `lifemodel/task`. A loopback relay adds the
fresh projected model token on `x-lifemodel-task-token` for each gateway request;
OpenCode never holds a provider key. The relay verifies the projected instance
CA. Only `/v1/chat/completions` and `/v1/models` can reach the gateway.

Success requires final assistant text and no provider error or unresolved
required tool failure. Process exit 0, idle, `step_finish` or an ended agent
alone does not prove success. Abort normalizes to `aborted`. Provider and tool
failures normalize to `failed`; raw errors never enter launcher diagnostics.
The accepted hard deadline bounds the adapter; the Job's native deadline remains
the final compute bound. A Linux Python subreaper supervises OpenCode and reaps
its adopted detached tool descendants before adapter completion, including after
server failure. Failure to establish or finish that cleanup fails closed.

## Durable outputs before the report

Result text and a bounded structured event log (fixed event types and lines,
not raw provider/tool payloads) are written to private temporary work
files and passed through the shipped `lifemodel-storage put` implementation.
Each saved object is then durably `mark`ed `result` or `log`. Files the agent
uploads and marks `artifact` are discovered by bounded own-space listing. No
object bytes, prompt, stdout, provider response or log chunk is sent through
the channel. The terminal payload contains only semantic outcome, a fixed short
summary, safe failure code when applicable, and the exact marked object IDs.
An unsuccessful storage mark prevents a successful terminal report.

One frame is in flight at a time. The launcher rereads the channel token and CA
per request. Ambiguous ACKs replay the identical frame, message ID and sequence,
at most three bounded attempts. A terminal frame is never replaced by a second
logical report after an uncertain ACK. The server stores before ACK and exact
duplicate replay creates no second report. Failure to obtain a terminal ACK
exits nonzero. Only an ACKed semantic success exits 0; ACKed failed/aborted
outcomes still exit nonzero. Earlier failures attempt the best failed report
with any already durably marked IDs.

Launcher diagnostics contain fixed codes only, not token bytes, briefings,
prompts or model output. Harness content belongs in task storage. TLS is never
disabled. HTTP requests, sockets and child streams keep error listeners through
teardown and have finite deadlines.

## Finalizer and later stages

The report is a terminal **candidate**, not public task completion.
lifemodel-653.8.9 must read the stored mailbox report, validate marks, stop the
exact compute instance, revoke task writes, seal storage and commit the keyed
public outcome. It must also reconcile failed Jobs with no accepted report
(e.g. a lost start or unavailable core). It must never infer success from exit 0.
Stage 4 adds the second real adapter and steering/wrap with ACK only after the
adapter accepts it. It must preserve the single-start boundary and the same
semantic-result contract.

Tests: `tests/integration/task-harness-contract.test.ts`,
`tests/integration/task-launcher.test.ts`, `tests/integration/task-briefing.test.ts`
and `tests/unit/task-workbench-contract.test.ts`. The isolated test dependency
setup installs the same checksum-verified pinned binary before network is
removed; real harness tests do not fetch binaries at runtime.
