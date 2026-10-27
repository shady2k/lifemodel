# Task harness and launcher

Task: lifemodel-653.8.7. Implements the pod-local side of ADR-014 D1/D2.
This is a source contract, not deployed stage acceptance.
The whole Pod, including launcher, agent and tool commands, is untrusted
([ADR-014 amendment](../../adr/014-task-runtime.md#amendment--2026-10-26-the-task-pod-is-one-untrusted-zone)).
The rules below are launcher policy within that zone. Reported outcomes,
events and traces are the task's claims, not independently verified facts;
process environment filtering does not create an inner trust boundary.

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

After winning, the launcher reads `GET /task/briefing` on the same core
listener. Its authority additionally checks the exact won claim and projection.
The reply contains IDs, `briefing`, the accepted resource `profile`, the
accepted `harness`, and `traceId`/`parentSpanId` for the launch trace. There is
no prompt in the Job spec or task storage. A refused/failed read starts no
harness and reports `failed` / `briefing_unavailable`. Responses are capped at
1 MiB. Both GET routes share the channel's reservations, deadlines and dedicated
SQL/identity workers. Neither caches positive authority.

## Pod-local harness port

`loader/src/task-harness.ts` declares `TaskHarness.start(briefing)`, `abort()`,
`steer({commandId,text})` and `wrap()`. Steering returns `accepted`, `rejected`
or `uncertain` after bounded native admission and journal recording, without
waiting for a model or tool. `wrap()` remains `not_supported`; soft-stop control
belongs to lifemodel-653.10. Steering before the briefing's ACP prompt has been written or after shutdown
is rejected. The command ID is bounded to 256 UTF-8 bytes, text to 60000 bytes;
blank IDs/text are rejected. Accepted means native live-queue admission only.
Normalized events are short `step`, `tool`, safe-code `error`, correlated
`receipt` (`inserted | deferred-to-next-turn | failed | uncertain`) and best-effort `trace` events. Trace callbacks cannot gate the harness protocol or outcome. One
start returns one semantic result: `succeeded`, `failed` or `aborted`, with
result text and a safe failure reason. A required-tool failure also carries
`failureSpanId`, identifying the failed tool observation rather than whichever
tool ran last. `ScriptedTaskHarness` implements the
same port for caller tests; it is not a second production agent.

The shared `AcpTaskHarness` runs a named registry
configuration over stdio JSON-RPC, in `/work` with private HOME/TMPDIR. Agent
command, config, version check and image pin are registry/config inputs, never
launcher conditionals. The won briefing supplies the accepted `harness` name;
an unknown/missing name fails closed. No new Job env value is introduced.
Tool subprocesses receive only the four storage CLI capability values, not
model/channel token paths. Raw ACP content never enters launcher diagnostics.

OpenCode uses the fixed baked provider/model `lifemodel/task`; Prime Agent uses
`task/task`. Both are local aliases. Prime 0.10.1 uses private rendered model
and settings files, a private daemon socket, offline controls, and an image-baked
Python runtime. Prime does not implement the ACP permission method, and its
Python tool can report an exception as completed without structured failure
evidence. These are accepted exemptions, not reliable failure detection.
Both agents require verified pins for each supported architecture; a missing pin fails the workbench build.

These are neutral local harness aliases, not upstream model names or provider choices. The task
model gateway owns model selection: after validating a nonempty model string,
it replaces any harness-supplied name with the configured model of each attempted
slot, on primary and on reserve failover. Changing the harness alias is not
needed for routing and would not enforce this rule for other task callers.
Core's separate listener still resolves `default` to the primary slot model,
passes explicit names on primary, and uses the configured reserve model on failover.

A loopback relay adds the fresh projected model token on `x-lifemodel-task-token`
for each gateway request. The agent never holds a provider key. The relay verifies
the projected instance CA. Only `/v1/chat/completions` and `/v1/models` can reach
the gateway.

The launcher classifies success from ACP `end_turn`, nonempty final assistant
text and no provider error or unresolved required tool failure. A settled tool failure is recovered
when later agent work is observed: an `agent_message_chunk` with non-whitespace
text, or a new tool call / a settled call resuming as `pending` or `in_progress`.
A completion update for an already running call, usage, thought chunks, empty or
whitespace text, and metadata-only patches are not later agent work. Recovery
requires no claim that the failed command itself succeeded; its tool span stays
`failed` while a successful task root is `ok` and its `failureSpanId` is null.

Any tool still `pending` or `in_progress` at turn end blocks success, even after
later prose. A newly observed tool failure remains unresolved until later agent
work. For a call still classified as failed, structurally changed `rawInput`
or `rawOutput`, a transition into explicit `failed` status, or a new failed
settlement is new evidence. Structurally identical raw values and presentation
patches do not reopen a recovered failure. A resumed call does not reopen a
failure from retained old output alone; its new evidence or settlement decides. A trailing failure with no later agent work fails with
`required_tool_failed` and names that tool span. With no unresolved tool failure,
a missing `end_turn` or empty final text fails with `no_final_result`. Provider
errors always fail. New/resumed tool work clears earlier final text; settled
presentation patches do not. Process exit 0, idle, `step_finish` or an ended
agent alone does not prove success. Abort normalizes to `aborted`. Raw errors
never enter launcher diagnostics.

An adapter may flag an unobserved background command result as failed evidence.
It follows the same recovery rule: later agent work can accept that uncertainty
and finish the task. This is not proof of background process completion; ACP
pending/in-progress calls still block success, and supervised process-tree
cleanup must still finish before any successful result is accepted.
The accepted hard deadline bounds the adapter; the Job's native deadline remains
the final compute bound. A Linux Python subreaper supervises the agent and reaps
its adopted detached tool descendants before adapter completion, including after
agent failure. Failure to establish or finish that cleanup fails closed.


### Cognition steering identity and known limits

`core.steerTask` reads task status without reserving a command identity or
recovering a write receipt. Answers are keyed by the recipient, persisted
deciding turn, task ID and question ID. Steers are keyed by the recipient,
deciding turn, task ID and that task's steer count in the turn. Committed, recovered
and uncertain steers advance the count; reads and deterministic refusals do not. Replay
can therefore add or remove reads/refusals without duplicating commands or
returning a write receipt as a task view. The operation and target IDs must
still be supplied on replay. Invalid steer text (blank, NUL, or over the
JSON/wire byte budget) is refused before recovery. Valid regenerated steer text
and answer text do not determine recovery identity. Changing the order of successful steers to the same task
is not covered by this identity scheme.

Known limits (review findings F5 and F6, lifemodel-653.9.8):

- **Smart-escalation history rebuild (F5).** Some provider-error escalation
  paths rebuild initial history without this live turn's earlier tool calls
  and results. Per-task steer counts survive, but the smart model can miss
  that guidance was already committed and issue another steer under the next
  identity. This is not replay deduplication and is not fixed here.
- **Cross-turn task injection (F6).** The trusted question-turn restriction
  prevents steering another task in that turn only. Injected task text may
  influence a thought or other self-signal and reach a later unrestricted turn,
  which may steer another task. Quoting task text and same-turn target checks
  are not a cross-turn information-flow boundary or proof of safety.

### Native admission and launcher-owned journal

The registry adapter exports `admit`, optional pre-brief `bind`, and
`observeInsertion`, plus optional `release` and `failOnUncertain` policy.
Generic ACP and factory code do not import native APIs.
OpenCode's baked dependency-free plugin listens on `/work/.launcher/steer.sock`, mode
0600. It calls `ctx.session.prompt` with the ACP/native session ID, a stable
SHA-256 message ID derived from `commandId`, `delivery: "steer"` and always
`resume: false`. An accepted socket reply must carry that same ID. Native
`session.inbox.delivered` evidence supports an inserted receipt; queue admission
alone does not. The observer backs off from 100 ms to 5 s, tries at most 12
reads, and stops with the harness. Missing evidence yields no inserted receipt.
An uncertain native OpenCode admission does not abort the turn; the stable ID
keeps ambiguity safe. The journal still returns its stored outcome, not a resend.

Prime binds before the brief using `list` with `includeClientOwned:true` on the
private daemon socket. Exactly one top-level root at the task working directory
must exist. Its native `activeSessionId`, not the ACP session ID, routes native
`steer`. The model sees the prefix `[lifemodel-steer:<hex>]`, where `<hex>` is the
command ID's SHA-256, before the plain steering text. This correlation marker is
not an upstream deduplication key. The observer reads at most 100 single-row
transcript pages per pass, with eight passes, exponential backoff capped at 5 s
and an overall 60 s observation deadline. A response over 1 MiB, timeout or
unreadable history gives up silently with no receipt. A compaction summary,
absent user row or empty queue never proves insertion. Observation failure
never aborts a running task. Only a failed/ambiguous native **steer send** is
uncertain and fails the Prime harness with `steer_uncertain`; native sends are
never retried. The real-agent socket-failure test removes the socket before
sending (ENOENT); a separate fake daemon tests lost ACK after receiving steer.
The root binding is released when the harness ends.

`task-steering-journal.ts` reserves 1024 fixed slots before opening intake. Each
slot stores hashes of command identity and text plus a synced pre-send state,
then a synced final admission disposition before the ACK returns. No prompt
text is stored in this journal. Same-ID, same-text in-flight duplicates join
one native call; later replays return the stored disposition. Changed text is
rejected. Capacity overflow rejects before send. Intent or disposition I/O
failure yields uncertainty and fails the task. Existing corrupt/missing state
cannot be silently recreated. Recovering a pre-send state returns uncertainty,
never a resend, especially on Prime. The journal and both adapter sockets live
in `/work/.launcher/`, outside the agent's TMPDIR (`/work/tmp`) and tool working
files. This is launcher-owned ephemeral state, **not a trust boundary**: the Pod
is one untrusted zone, and receipts are task claims. It is not the core's
durable mailbox and does not survive Pod loss. An ordinary TMPDIR cleanup
therefore does not delete the journal or channel files.

### End-of-turn barrier

Each registry adapter exports `reconcileEndTurn`, returning `idle | continue |
successor | unknown`. The generic ACP client closes intake when it dispatches
the prompt reply, before resolving the prompt waiter. It settles every in-flight
admission, including journal sync, then calls the adapter. Commands arriving
after closure are rejected only if their IDs are new. Known IDs still join the
in-flight journal call or return its stored disposition; changed text conflicts.
Intake reopens for a continuation, successor or open
question, and closes again before each reconciliation.

OpenCode reconciles stable native IDs against the plugin's pending/inserted
observations. Pending input emits `deferred-to-next-turn` and causes a plain,
nonempty ACP continuation (`Continue.`), without resending steering text. Each
pending ID gets at most one continuation. If it remains pending at the next
barrier, or any disposition is unknown, fail closed with `end_turn_uncertain`.

Prime checks the bound root's idle flags and both queue lanes. Idle with every
command already observed inserted inside the ACP turn returns `idle`, without
reading history. Otherwise it awaits the native successor, with polling backoff
from 100 ms to 2 s. When idle first succeeds, the client closes intake, settles
admissions, then rechecks native idle and queues. New busy work reopens intake
and repeats the wait. Only a closed, settled intake plus native idle permits
reading final evidence.

Branch-pinned history is scanned backward only to the earliest required steering
marker, or to the last user row when no command IDs are required. Older history,
including oversized old tool rows, is never requested or retained. Relevant
evidence is bounded to 1000 single-row pages, 1 MiB per frame and 8 MiB retained
rows. Missing markers, cursor nonprogress, compaction, limits or absent final/tool
settlement evidence fail closed. Native observation errors never cause a resend.

Across turns the client retains tool state and uses only the last final text.
Unsettled calls always block success. A settled failure carries across a reset,
but later agent prose or new/resumed tool work recovers it under the same
classifier used within a turn. Adapter-neutral successor observations go through
that classifier and emit the same progress events as ACP updates. One terminal
candidate is classified only after reconciliation and process-tree cleanup.

The generic `TaskQuestionState` seam has these rules for the 9.9 dispatcher:
- `isOpen()` synchronously reads whether the single question is still open.
- `waitForChange(signal)` subscribes to a later state change, resolves on change
  or abort, and removes its listeners on abort. It must not resolve repeatedly
  for an unchanged level. The barrier defensively rate-limits such a faulty seam.
- The answer dispatcher closes the local question only after its correlated text
  is admitted through `steer`. Core answer commit is not native delivery.
- Open questions keep intake open. Answers and ordinary steers wake the barrier;
  merely clearing the flag without admitted text fails `end_turn_uncertain`.

Every task, including active model/tool work and tasks without questions, uses
the absolute `TaskBriefing.softDueAt` snapshotted from the verified start claim.
Startup time counts. Expiry currently aborts work and ends D4 `failed` / `timeout`
without a wrap. A later shortening (soft Stop) is not observed by this snapshot.
Lifemodel-653.10 must add wrap and live deadline updates; they are not implemented
here. The Job deadline remains the hard compute bound. Tests drive the question
seam; MCP tools and core answer correlation belong to lifemodel-653.9.9.

The local shared-contract and mutation evidence is recorded in
[End-of-turn barrier verification](../../research/task-end-turn-barrier.md).

### Remaining mailbox and MCP contract

`task-command-intake.ts` now long-polls the core's durable mailbox on an
independent outbound client. Before any poll, it waits for the generic
`TaskHarness.intakeReady` promise. The ACP harness resolves it only when the
brief's `session/prompt` write installs native steering, not on process start or
session creation. A harness that ends before opening intake never resolves it;
launcher stop cancels the wait and leaves commands in core for terminal handling.
The scripted harness has the same port contract. This is not a retry around a
native rejected disposition. Once ready, intake sends one command at a time
through `TaskHarness.steer`, then posts the disposition ACK. Lost ACKs reconnect and
redeliver the same ID/text through the existing harness journal, not directly to
a native adapter. Answers prefix `[question:<questionId>]` to their plain text.
The optional `onAnswerAdmitted` callback is the seam for the later question
MCP dispatcher; it is called only on accepted admission. Receipt events use
stable SHA-256 receipt IDs and an independent bounded writer. Transient
connection, 408, 429 and server failures back off exponentially from 250 ms to
five seconds, for both command redelivery and receipts. Deterministic 4xx
refusals and invalid response/command envelopes never retry indefinitely.
A deterministic receipt refusal drops that receipt with a safe warning; reaching
the 128-entry receipt cap also warns. A deterministic poll or disposition-ACK
failure logs an error, aborts the harness and reports `command_intake_failed`
instead of silently disabling intake. Diagnostics contain fixed codes and HTTP
status only, never command text or credentials. A final bounded receipt attempt
drains before terminal reporting. Real-store integration checks cover journal recovery after lost ACKs, answer
prefixes, receipt forwarding and draining an in-flight disposition ACK before
terminal reporting. This is source verification, not deployed stage acceptance.
A steer delivered while end-turn intake is closed is explicitly rejected,
ACKed and retired, never silently discarded. The core read/status view shows
that rejection as retryable in a new deciding turn. The regression check drives
a real ACP barrier plus command intake and the Postgres mailbox. A separate
ordering regression holds the prompt write callback: `intakeReady` remains
pending until the brief write finishes, even after the agent receives its bytes.

The ten-second ACK POST deadline exceeds the five-second adapter admission
bound; it is not a delivery-to-ACK timer in core. Core redelivers on the next
poll until the ACK commits. Receipts and ACKs are
task claims, not proof of execution or obedience. Launcher-hosted MCP tools use a
stdio subprocess in `session/new`. The stdio server is a thin launcher-shipped
shim relaying over an inherited pipe or launcher-private local socket; it holds
no channel credentials. Frames, IDs and limits are the launcher’s and core’s.
MCP, including Prime offline support, is
unverified. The question returns after durable frame ACK, not an answer. One
unanswered question per task is permitted; further calls fail explicitly. Core
refuses a `question` frame while that task has an unanswered question, even from
a compromised launcher. An answer command’s commit makes the question answered.
Immediate stop deletes the Job. The Pod remains one untrusted zone.

## Durable outputs before the report

The launcher creates `/work/outputs/` before starting the harness. It prepends
these standing instructions to every briefing through the harness-neutral port,
not the OpenCode configuration (the owner-facing goal remains unchanged):

```text
Files for the owner go in /work/outputs/, flat, with their final file names.
Only regular files are allowed; no subfolders or symlinks. Maximum: 64 files.
Files elsewhere are not delivered. Outputs are delivered only if the task succeeds.
```

A custom launcher work directory uses its own `outputs/` child in these
instructions. Nothing is declared up front. After harness success the launcher
validates the whole flat folder, then uploads each regular file through the
shipped `lifemodel-storage put` implementation and durably marks it `artifact`.
Files elsewhere are not automatically uploaded. The folder and its entries must
not be symlinks. A subdirectory is `output_subdirectory`; a symlink is
`output_symlink`; a FIFO, device or other non-regular entry is
`output_not_regular`; a 65th entry is `output_limit`; a name rejected by the
storage CLI's canonical-name validator is `output_name_invalid`. These fixed
codes expose no file names or contents. Validation finishes before the first
output upload. Transfer-time no-follow, nonblocking file opens in the shipped
CLI also reject replacement links and non-regular files.

Failed and aborted harness outcomes do not collect the folder or list artifacts.
Their files may be incomplete and must not be offered as successful work. Result
text is still uploaded and marked `result` for finalization diagnostics. The
launcher does not write or upload a fixed event journal or `log` object. Private
harness observations use the best-effort trace path instead. The core attaches
result and artifact objects only for a sealed `done` outcome, never for
failed/stopped work.

Every saved object has its plain leaf name as display metadata: `fib.txt` or
`result.txt`, never the private `launcher_<uuid>/` work path.
Display names are not unique catalog slots. Immutable object IDs distinguish
objects, including an agent output also called `result.txt`. Upload IDs are
`upload_` plus the SHA-256 of the JSON array `[launchId, role, fileName]`.
This separates the launcher result role from artifacts without changing visible
names. Up to three attempts reuse that upload ID and mark after a missing storage
ACK; the module replays its original receipt and the mark is idempotent. Changed
bytes under that ID conflict rather than creating a second object.

After output collection, bounded own-space listing discovers all objects marked
`artifact` (including explicit CLI uploads): at most 100 pages, 100 rows per
request and 64 artifact IDs in total. Follow the opaque cursor until
`nextCursor: null`; a short page is not EOF because encoded metadata has a
separate 64 KiB bound. A 65th marked artifact fails with `artifact_limit`.
Result text is written, uploaded and marked before collection; a later collection
failure retains its already-durable result ID and bytes in the failed
report, not owner attachments. A storage failure can leave already marked
partial objects, but never produces a successful report or partial owner reply.
An empty `result.txt` therefore reflects an empty harness result, not collection
truncating the file. The ACP adapter deliberately returns empty result text for
failed/aborted turns, including required-tool failure or missing final text;
earlier prose alone is not an accepted final answer. A storage failure can mask
that earlier semantic reason in the terminal report. No object bytes, prompt,
stdout, provider response or log chunk is sent through the channel. The terminal
payload contains only semantic outcome, a fixed short summary, safe failure code
when applicable, and the exact marked object IDs. An unsuccessful storage mark
prevents a successful terminal report.

One frame is in flight at a time. The launcher rereads the channel token and CA
per request. Ambiguous ACKs replay the identical frame, message ID and sequence,
at most three bounded attempts. A terminal frame is never replaced by a second
logical report after an uncertain ACK. The server stores before ACK and exact
duplicate replay creates no second report. Failure to obtain a terminal ACK
exits nonzero. Only an ACKed semantic success exits 0; ACKed failed/aborted
outcomes still exit nonzero. Earlier failures attempt the best failed report
with any already durably marked IDs.

New-pod network policy can take time to admit the pod IP. Identity and briefing
reads and channel sends retry only allowlisted connection failures before the
TCP socket connects: refused, host/network unreachable, reset, or connect timeout.
A TCP `connect` (or a reused socket) ends this permission, even before TLS finishes;
no request that may have written bytes is replayed by this transport rule.
Exponential backoff starts at 100 ms, caps at 2 s and uses 50–100% jitter.
Retries share a 30 s client-startup window and respect the known `hardStopAt`;
each attempt also has its existing request timeout. Projected token and CA files
are read again on each attempt. `/task/start` remains strictly single-shot,
even for a refused connection. No timeout, lost response, 409 or late ACK can
resend it. The relay applies the same connection-only rule to idempotent
`GET /v1/models`, never streaming `POST /v1/chat/completions`.
The separate, existing three-attempt identical-frame ACK replay remains unchanged.

Launcher diagnostics contain fixed codes and safe `connection_attempts=N` counts, not token bytes, briefings,
prompts or model output. Result text belongs in task storage; private command,
output and completion observations belong in bounded traces, not diagnostics. TLS is never
disabled. HTTP requests, sockets and child streams keep error listeners through
teardown and have finite deadlines.

## Best-effort traces, not a journal

The launcher sends [task trace frames](task-channel.md#disposable-task-trace-route)
to `/task/trace`, independently of progress and terminal mailbox frames. The
launch root is `launchId`, under the briefing's `parentSpanId`; every harness
span ID is prefixed with `launchId_`. A null harness parent attaches to that
root. A failed semantic result supplies its culprit's namespaced `failureSpanId`
in final root attributes. Recovered tool failures remain visible as failed child
spans but do not supply a failure link on a successful root.

Trace observations include model status and usage, tool command and bounded
output tail, and final completion text. Before sending, the launcher scrubs
projected token contents. Trace intake permits at most 2048 observations per
run, 128 queued spans and 30000 encoded bytes per span. An independent 500 ms
client sends each frame once, with no mailbox row, Signal, connection retry or
ACK replay. Intake or transport failures drop observations without changing
task execution, result storage or terminal reporting. After terminal settlement,
trace draining has at most one second to finish before the client closes.
There is no replacement `log.jsonl` object: traces can be incomplete or lost and
must never prove success, replay work or own finalization.

## Finalizer and later stages

The report is a terminal **candidate**, not public task completion.
lifemodel-653.8.9 must read the stored mailbox report, validate marks, stop the
exact compute instance, revoke task writes, seal storage and commit the keyed
public outcome. It must also reconcile failed Jobs with no accepted report
(e.g. a lost start or unavailable core). It must never infer success from exit 0.
Stage 4 adds prime-agent and steering with ACK only after the
adapter accepts it and the launcher records the disposition. It must preserve the single-start boundary and the same
semantic-result contract.

Tests: `tests/integration/task-harness-contract.test.ts`,
`tests/integration/task-launcher.test.ts`, `tests/integration/task-briefing.test.ts`
`tests/unit/task-connection-retry.test.ts` and
`tests/unit/task-workbench-contract.test.ts`. The isolated test dependency
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
an implementation detail, not a launcher API. Native admission is confined to
the baked plugin and adapter under the 2026-10-27 amendment.

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
  also be checked (`packages/core/src/shell/result.ts:30-42`). These produce
  failed tool observations, not permanent task failure. Later agent work can
  recover a settled failure under the generic ACP rule above; an unsettled
  required call still blocks success.
- Provider/auth failures become JSON-RPC prompt errors, not a successful
  `end_turn`: `packages/cli/src/acp/translate.ts:137-147` and
  `packages/cli/src/acp/turn.ts:314-349`. Content filters yield `refusal`;
  interruption yields `cancelled`; token limits yield `max_tokens`:
  `packages/cli/src/acp/translate.ts:470-478`.
- Permission requests use the client's `session/request_permission` callback:
  `packages/cli/src/acp/permission.ts:60-83`. The client must respond with an
  offered permission option or cancelled, never leave the agent waiting.
  Do not advertise client filesystem/terminal capabilities unless implemented.

One generic ACP client owns lifecycle. OpenCode and prime-agent use it with
agent-specific steering behind their registry adapter modules.
Its local success policy requires `end_turn`, nonempty final agent text, no
provider error and no unresolved failure or unsettled required tool call.
Neither this classification nor process exit status proves the work is correct.
Cancellation must return `aborted`, with bounded process-tree cleanup even if
an agent fails to respond. Only the specified native steering and completion reconciliation are permitted.

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
no external plugins, URL skills or instructions, and no warming. Stage 4 adds only the baked steering plugin and launcher-provided MCP tools.
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

Historical runtime receipt, 2026-10-24 (before task-trace log removal): the
rebuilt uid-1000 image ran its actual launcher with fake gateway/channel/storage
on loopback, `--network none --read-only`, all capabilities dropped, private
`/work`, and descendant `strace -f -e trace=connect`. It completed with one start,
one briefing, one model request, result plus legacy log storage, and one ACKed
success (exit 0). All 42 AF_INET connect attempts were loopback; no outbound
address was attempted (44 total connect calls including Unix sockets). The run
log is `/tmp/task-harness-v2-smoke2.log`; this historical receipt does not prove
the updated trace contract.

The current fixture, `tests/fixtures/task-launcher-image-smoke.mjs`, expects one
marked result object and no artifacts for its text-only model response. A terminal
must reference marked result/artifact objects only; `logObjectId` and a launcher
log object must be absent. Disposable observations go separately to `/task/trace`;
the fixture checks their task/launch identity and projected-token scrubbing without
counting them as durable terminal events or storage objects. It observes the root
but does not require best-effort root closure to arrive before terminal completion.
Isolated real-session tests additionally trap npm/bun/curl/wget startup and assert
no invocation. Network isolation by itself would prove denial, not absence of
attempted outbound fetches. The updated image smoke still needs a fresh real-image
receipt.

## Adding a harness

1. Add one configuration module beside `task-opencode.ts`. Export
   `configureAgent({workDirectory, configFile, relayBaseURL})` and
   `toolOutputFailed(rawOutput, rawInput)` for agent-specific command status;
   return only the agent's scoped environment. Add its native steering and
   barrier hook here, behind TaskHarness, not in the launcher or core.
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
not an owner setting and is not shipped in the workbench. Every real agent must pass success, provider error, abort and observable required-tool
failure before being offered. Prime’s Python-tool path is exempt from the
required-tool failure check: its exceptions can appear completed, so failure
detection there is weaker, an owner-accepted gap. Other missing required tool
evidence must not be represented as success.

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
