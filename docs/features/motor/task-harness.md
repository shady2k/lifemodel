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

`AcpTaskHarness` is the only real protocol adapter. It runs a named registry
configuration over stdio JSON-RPC, in `/work` with private HOME/TMPDIR. Agent
command, config, version check and image pin are registry/config inputs, never
launcher conditionals. The won briefing supplies the accepted `harness` name;
an unknown/missing name fails closed. No new Job env value is introduced.
Tool subprocesses receive only the four storage CLI capability values, not
model/channel token paths. Raw ACP content never enters launcher diagnostics.

The fixed baked provider/model is `lifemodel/task`. A loopback relay adds the
fresh projected model token on `x-lifemodel-task-token` for each gateway request;
The agent never holds a provider key. The relay verifies the projected instance
CA. Only `/v1/chat/completions` and `/v1/models` can reach the gateway.

Success requires ACP `end_turn`, final assistant text and no provider error or unresolved
required tool failure. Process exit 0, idle, `step_finish` or an ended agent
alone does not prove success. Abort normalizes to `aborted`. Provider and tool
failures normalize to `failed`; raw errors never enter launcher diagnostics.
The accepted hard deadline bounds the adapter; the Job's native deadline remains
the final compute bound. A Linux Python subreaper supervises the agent and reaps
its adopted detached tool descendants before adapter completion, including after
agent failure. Failure to establish or finish that cleanup fails closed.

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
Stage 4 adds a second real ACP agent configuration and steering/wrap with ACK only after the
adapter accepts it. It must preserve the single-start boundary and the same
semantic-result contract.

Tests: `tests/integration/task-harness-contract.test.ts`,
`tests/integration/task-launcher.test.ts`, `tests/integration/task-briefing.test.ts`
and `tests/unit/task-workbench-contract.test.ts`. The isolated test dependency
setup installs the same checksum-verified pinned binary before network is
removed; real harness tests do not fetch binaries at runtime.

## OpenCode v2 facts

Research pin: **2.1.4**, npm stable `@opencode/cli` observed for the owner's
2026-10-24 decision (the worker host clock reads 2026-10-23). Source tag
`v2.1.4` resolves to **68bc26b7da1990ce10ffecfbc1e09eb13aa5d824**.
All upstream references below are relative to
<https://github.com/anomalyco/opencode/tree/68bc26b7da1990ce10ffecfbc1e09eb13aa5d824>.
The v2 docs <https://opencode.ai/v2/docs/> identify `@opencode/cli` and versioned
2.x Docker tags. GitHub's 1.x Latest release is not this distribution.

### Distribution and startup

Use the native npm tarball at build time, not npm's platform-selecting
postinstall at task startup:
`https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-2.1.4.tgz`.
The npm registry reports integrity
`sha512-o8EJ0ZsT4dzDKN+0mpG2EKbNGzJyp+F1++Av28UReRVfiEv+N34eZEnN/unkiMoerKHad6W6Ii7k4ukTnPNmNQ==`.
The downloaded archive was verified against that integrity; its SHA-256 is
`ce05abe2dce1041391c8ec8cdb8da066f640fd471e72ac846dcb089c441e11e1`.
Extract `package/bin/opencode`. No runtime package manager is needed.

`opencode acp` uses NDJSON JSON-RPC over stdin/stdout:
`packages/cli/src/commands/handlers/acp.ts:23-44`. It starts an internal
standalone service (`packages/cli/src/services/standalone.ts:17-31,61-63`),
with `serve --stdio --port 0`, a random lease password and stdin ownership.
The service defaults to loopback and enforces its generated password:
`packages/cli/src/server-process.ts:74-100`. This internal HTTP transport is
an implementation detail, not a launcher API. Do not implement its native
session/event routes. The owner selected **ACP only** on 2026-10-24.

### ACP coverage and semantic outcome

- `initialize`, `session/new`, `session/prompt`, `session/cancel` are registered
  in `packages/cli/src/acp/agent.ts:68-118`; capabilities and sessions are
  implemented in `packages/cli/src/acp/service.ts:106-150,238-239`.
- Session updates are sent before the prompt response:
  `packages/cli/src/acp/turn.ts:139,314-349`. Text deltas become
  `agent_message_chunk`; tool events become `tool_call` and
  `tool_call_update`: `packages/cli/src/acp/translate.ts:291-403`.
- Tool failure is `failed`; successful tool output retains raw metadata:
  `packages/cli/src/acp/tool.ts:100-153`. A shell nonzero exit can still be
  `completed`: its `rawOutput.metadata.exit`, `signal` and `timeout` must
  also be checked (`packages/core/src/shell/result.ts:30-42`). Treat any
  failed or unsettled required call conservatively as failure. A final
  prose apology cannot turn it into success.
- Provider/auth failures become JSON-RPC prompt errors, not a successful
  `end_turn`: `packages/cli/src/acp/translate.ts:137-147` and
  `packages/cli/src/acp/turn.ts:314-349`. Content filters yield `refusal`;
  interruption yields `cancelled`; token limits yield `max_tokens`:
  `packages/cli/src/acp/translate.ts:470-478`.
- Permission requests use the client's `session/request_permission` callback:
  `packages/cli/src/acp/permission.ts:60-83`. The client must respond with an
  offered permission option or cancelled, never leave the agent waiting.
  Do not advertise client filesystem/terminal capabilities unless implemented.

One generic ACP client implements the port. OpenCode is its first registry
configuration; goose and other conforming agents must reuse the same client.
Success requires `end_turn`, nonempty final agent text, no provider error and
no failed/unsettled required tool call. Process exit status cannot prove it.
Cancellation must return `aborted`, with bounded process-tree cleanup even if
an agent fails to respond. No native protocol fallback is permitted.

### Config and offline obligations

v2 config is **not** the 1.x schema. It uses `providers`, `settings`, `agents`,
`permissions`, `plugins`, `update`: `packages/schema/src/config.ts:25-117`,
`packages/schema/src/config/provider.ts:116-125`. A custom built-in native
OpenAI-compatible provider uses package
`@opencode/ai/providers/openai-compatible` and `settings.baseURL` set to the
launcher's loopback relay; no external SDK install. Provider/model overlays
are applied in `packages/core/src/config/plugin/provider.ts:67-96,125-140`.
The relay, not the agent, rereads the projected token per request.

Set `update: "disable"`, `share: "disabled"`, `formatter: false`, `lsp: false`,
no external plugins, MCP servers, URL skills or instructions, and no warming.
Plugin disable selectors use `-<id>` (`packages/core/src/config/plugin/source.ts:125-132`);
do not disable essential config/tool plugins with `-*`.
`OPENCODE_DISABLE_MODELS_FETCH=true` is wired to the models source
(`packages/cli/src/server-process.ts:116-120`); `packages/core/src/models-dev.ts:393`
returns no fetch task when disabled. Disable project config and Claude skill
roots with the flags actually consumed at `server-process.ts:122-139`.
No v1 plugin-bootstrap dependency or obsolete v1 disable flags are assumed.

Config names remain `opencode.json`/`opencode.jsonc`; roots include system,
XDG global and explicit files (`packages/core/src/config/discovery.ts:12,27-31,64-144`).
Keep config roots precreated and read-only. Mutable HOME/XDG cache, data, state,
logs, repositories and TMPDIR live below private `/work`:
`packages/util/src/global.ts:12-31,62-75`. Session database location comes from
`packages/cli/src/server-process.ts:111-114`.

Runtime receipt, 2026-10-24: the rebuilt uid-1000 image ran its actual launcher
with fake gateway/channel/storage on loopback, `--network none --read-only`,
all capabilities dropped, private `/work`, and descendant `strace -f -e
trace=connect`. The smoke completed with one start, one briefing, one model
request, two marked objects and one ACKed success (exit 0). All 42 AF_INET
connect attempts were loopback; no outbound address was attempted (44 total
connect calls including Unix sockets). The fixture is
`tests/fixtures/task-launcher-image-smoke.mjs`; the run log is
`/tmp/task-harness-v2-smoke2.log`. Isolated real-session tests additionally trap
npm/bun/curl/wget startup and assert no invocation. Network isolation by itself
would prove denial, not absence of attempted outbound fetches.

## Adding a harness

1. Add one configuration module beside `task-opencode.ts`. Export
   `configureAgent({workDirectory, configFile, relayBaseURL})` and
   `toolOutputFailed(rawOutput, rawInput)` for agent-specific command status;
   return only the agent's scoped environment. Do not implement a native client.
2. Add one entry in `src/ports/task-harness-registry.json`: name, label,
   ACP command/args, module path, immutable config path, version/versionArgs,
   exact version output, and `provision`. The latter owns architecture-keyed
   archive URLs/SHA-256, extraction member, config source/destination/mode, and
   immutable config directories. Settings, launcher selection and self-check
   derive from this list. Missing architecture pins fail closed.
3. Add its non-secret config under `docker/workbench/` (JSON files are admitted
   by the dedicated allowlist). `scripts/task-agent-provision.mjs` consumes the
   registry directly for the Dockerfile and both isolated test paths. There is
   no second binary list, Dockerfile pin or agent-specific extraction branch.
4. Add the agent-owned `contractModule` fixture. It owns any test setup and
   offline assertions for that agent. The shared suite uses its normal registry
   configuration without replacing its config with another agent's JSON.

The shared contract iterates the shipped registry plus
`tests/fixtures/task-agent-registry.json`. The latter adds a distinct scripted
ACP configuration with its own executable, module, config and version check;
normal test provisioning installs it using the same registry-driven path. It is
not an owner setting and is not shipped in the workbench. Every real agent must
pass success, provider error, abort and required-tool failure before being
offered. Missing ACP signals block integration; there is no native fallback.

### ACP patch and framing boundary

ACP v1 `ToolCallUpdate` requires only `toolCallId`; null/omitted patch fields
leave retained call state unchanged. Retained input and output feed the agent's
semantic guard. Metadata-only updates of settled calls preserve the final
answer, while new or continuing work invalidates earlier prose. See the
[upstream schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json).

Success remains provisional until the process tree stops and stdout reaches
EOF. Fatal UTF-8 decoding and the final frame boundary reject non-whitespace
unterminated bytes, even when received during teardown. No quiet-time timer is
used as evidence that stdout has drained. The scripted contract includes live
agents writing end_turn plus malformed, late-tool, truncated and incomplete
UTF-8 tails, then waiting for the shutdown signal.
