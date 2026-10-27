# Task live channel

Task: lifemodel-653.8.8. This is the task-to-core direction of ADR-014 D2.
The task-to-core direction is a source contract, not deployed stage acceptance.
The core-to-task mailbox and launcher intake are implemented in source by
lifemodel-653.9.7. Real-store integration checks cover ordering, replay, ACKs,
receipts, authority, questions and owner-core processing during a held poll.
This source contract is not deployed stage acceptance.

## Transport and identity

The launcher posts one JSON frame to `https://core.lifemodel.svc:8447/task/events`.
HTTP/1.1 keep-alive gives a reusable outbound TLS channel with one explicit HTTP
200 ACK per frame. Unlike a bidirectional streaming body, this bounds body intake,
allows a clear 429 with Retry-After, and does not tie up a worker while a peer holds
an idle connection. The launcher also dials out for bounded command long-polls. No task Pod ingress
port is created.

The server leaf is issued by the instance CA, stored in the fixed
`core-task-channel-tls` Secret, and mounted only into core. The listener reloads
its projected leaf every minute. Health stays on the separate core health port.
A0 precreates the Secret; the loader can read/update only that name in the
application namespace. It cannot create arbitrary application Secrets.

Each request carries `Authorization: Bearer <lifemodel-task-channel token>`.
The launcher must reread its projected token for every request and verify the instance
CA. Mailbox frames replay the same immutable message after an ambiguous response;
trace frames are best effort and are never replayed.
Trace intake has its own authentication worker and authority worker, with at
most two admitted requests. Its physically separate one-connection authority
pool uses a one-second deadline and the active-holder fence; it never borrows the
terminal channel pool. Trace storage uses a separate unfenced one-connection
pool. Trace authority or storage waits therefore cannot occupy terminal
mailbox workers or SQL connections. No token
or positive identity result is cached. TokenReview must return the channel audience,
exact task service account, and bound Pod name/UID. Fresh Pod/Job GETs validate
nondeletion, controller ownership, actual controlled template hash, launch label
and Job start time. The checks mirror the model listener and are pinned by a parity
test because the core and loader images have independent TypeScript build roots.

Within the fenced mailbox transaction, the verified Job selects the registry
binding. The task/attempt, Job, Pod, immutable start time, saved allocation,
`task_access.start_claims` winner and verified projection must all match.
Canonical active/wrapping intent is read under lock and its hard deadline is
checked at database wall time after waits. Revocation or API/store outage denies.
A replacement Pod that did not win the start claim cannot send reports.
This authenticates the task Pod, not the launcher process within it. Launcher,
agent and shell commands share one untrusted zone; any of them can make claims
under that task's identity. Events, outcomes and trace content are not verified
facts ([ADR-014 amendment](../../adr/014-task-runtime.md#amendment--2026-10-26-the-task-pod-is-one-untrusted-zone)).

## Launcher discovery and briefing

The same TLS listener accepts two bodyless GETs with the channel audience,
projected-token reread and fresh live Kubernetes identity described above:

- `GET /task/identity` returns exactly `{taskId,attemptId,launchId}`. This solves
  the restricted Job's bootstrap: its ten allowed environment names contain no
  registry IDs. The verified Job name and UID select the task, never a caller ID,
  storage-space guess or token payload decoded without verification. The fenced
  transaction checks the live nonterminal reserved launch, saved allocation and
  storage catalog, active canonical intent, deadline and absence of a soft-stop
  request. It needs no start claim and returns no briefing or profile. Repeating
  discovery grants no start, does not write a claim and cannot replace the
  gateway's once-only `POST /task/start`.
- After its timely won start, the launcher reads `GET /task/briefing` (with the
  [startup connection-only retries](task-harness.md) when no connection opened). It
  returns `{taskId,attemptId,launchId,briefing,profile,harness,traceId,parentSpanId}`,
  where `traceId` is the stable task trace and `parentSpanId` links the launch root
  to its recorded parent (or is null). The accepted resource profile has
  `id`, `revision`, `timeoutSeconds`, `cpuMillis` and `memoryBytes`. This requires
  the exact won Pod/Job start claim and projection, plus current active/wrapping
  intent and matching allocation. A replacement/loser Pod cannot read it. The
  launcher does not start a harness if this fetch fails and reports
  `failed` / `briefing_unavailable` when the channel can accept a report.

Both reads use the same bounded authentication workers, per-Job mailbox scheduler,
separate fenced pool, operation/request deadlines and cancellation as frames.
Task, launch, intent and storage locks follow the canonical order; database wall
time is checked after waits. Reads emit no mailbox row or Signal. Responses use
`Cache-Control: no-store`, are capped at 1 MiB (including JSON overhead), and hold
that allowance against connection/process byte reservations until completion.
Lower configured byte budgets lower the response allowance. Oversized results
fail closed with a safe 503 code, before any briefing bytes are sent. Request
bodies, query strings and unknown routes are refused on these existing reads. Refusal logs name a fixed route (unknown paths are `unknown`), and authenticated
frames include canonical generated task/trace locators even if the authority
lookup fails. Arbitrary wire locator text is omitted until storage resolves it.
These locators are diagnostic input, not a grant of authority. Errors/logs contain only
safe status/codes and locators, never tokens, briefing, profile content or raw SQL causes.

## Frame and ACK contract for the launcher

POST with `Content-Type: application/json`, no content encoding:

```json
{
  "taskId": "task_<64 hex>",
  "attemptId": "attempt_<64 hex>",
  "direction": "task_to_core",
  "messageId": "msg_immutable_opaque_id",
  "sequence": 7,
  "kind": "step",
  "payload": { "line": "Checking the generated result" }
}
```

IDs are 1–128 ASCII letters/digits/underscore/hyphen, starting with a letter or
digit. Registry task/attempt IDs still have the registry's deterministic format.
Sequence is a positive safe integer, independent per task/attempt/direction.
Gaps and out-of-order sequence numbers are accepted: sequence 7, then 11, then 9
is valid. A reused sequence with a different message conflicts. Message IDs are
unique per task/direction and must never change content on replay.
A step line is nonempty, at most 1024 UTF-8 bytes, with no CR, LF or NUL.
Unknown frame or payload fields are refused.

ACK (HTTP 200) repeats `taskId`, `attemptId`, `direction`, `messageId`, `sequence`
and adds `receivedAt` (the stored ISO timestamp). Postgres commits the immutable
row and received cursor before this response. Exact duplicates return the same
ACK without another row or cursor increment. A lost ACK never permits a new
message ID for the same logical report.

- 400: malformed frame or payload.
- 403: identity, binding, won-claim, canonical intent or deadline denied.
- 409: conflicting key/sequence, or terminal attempt. An unknown/current-attempt
  mismatch is denied with 403.
- 413: oversized frame.
- 429 with `Retry-After: 1`: connection/process capacity exhausted.
- 503: authority/store unavailable or stopping. No fallback execution.
- ACK timeout disconnects; the launcher reconnects and replays immutable IDs.

A new frame after a stored terminal report is refused. An exact duplicate of an
already stored frame can replay its ACK while current identity/intent still
permits access. Terminal/revoked task authority does not become reusable merely
because a caller presents an old message ID.

## Stage 4 commands and questions

The [ADR amendment](../../adr/014-task-runtime.md#amendment--2026-10-27-live-steering-behind-the-harness-port)
adds a bounded long-poll from launcher to this listener and outbound ACK/receipt
posts. Fresh task-audience identity, won claim, canonical intent and deadline
checks apply on each request and again before delivery after a wait. Reserve
separate bounded wait capacity: held polls must not occupy event ACK or owner
intake workers or SQL connections. A commit-path in-process notification wakes
the poll; bounded rechecks cover missed notifications. Allow at most one held
poll per attempt, timing out after 25 seconds. Close on revocation/shutdown. Respect
the frame, per-task and process bounds below in both directions.

Core commits immutable commands before delivery: task/attempt, command ID,
per-direction sequence, kind (`steer` or `answer`), text and optional question
ID. Reserve wrap for 653.10; reject steer and answer while wrapping. Deliver in per-task
order. Replay outstanding rows by exact IDs, not a contiguous sequence
watermark; changed content under an ID or sequence conflicts. The launcher
records dispatch intent before native send and disposition before ACK. Core
commits the ACK before retiring a delivery. Lost ACK replays the recorded
disposition, not the native operation; a duplicate during native admission joins that in-flight call. After
process loss or socket failure an ambiguous Prime dispatch is uncertain; it fails the task with
`steer_uncertain`. Command ACK timeout is at least the adapter admission bound. Later inserted/deferred/failed/uncertain receipts use
separate immutable, idempotent correlated frames. A lost Pod is not restarted
to replay commands. Terminal or revoked attempts refuse new commands.

`question` joins `step` and `terminal` in task-to-core frames, with a
launcher-generated question ID derived from the frame message ID and nonempty
text (at most 1024 UTF-8 bytes; no CR, LF or NUL). At most one question per
task may be unanswered; another call fails explicitly. Core refuses a `question`
frame while that task has an unanswered question, even from a compromised
launcher. A question counts as answered once its answer command is committed.
Store before ACK and
emit `task_report` as for step, but only question wakes cognition. Its trigger
prompt reads mailbox content and quotes it as untrusted data. Cognition may ask
the owner or answer using `core.steerTask`; TaskService owns read/steer/answer.
In a turn triggered by a task question, `core.steerTask` may target only that task.
Each command ID derives from deciding turn recipient, correlationId and call
index, with `recoverAcceptedEffect`; the tool returns queued after the fenced
commit, without waiting for ACK or receipt. A rejected or uncertain ACK or failed
receipt is recorded on the command and shown to cognition through TaskService
read and status views. No user-message trigger is required;
D7 grants alone authorize privileged effects. The launcher prefixes the question
ID to the plain-text answer. An unanswered question keeps barrier intake open
for answers and ordinary steers until admission or the accepted task timeout
from the briefing (`TaskAccessIntent.softDueAt`). At expiry the barrier ends
unanswered and the task proceeds as D4 `failed`/`timeout`; the 653.10 wrap
command replaces this once available. Today the launcher applies the start
claim's snapshotted `softDueAt` to every task, including active model/tool work
and tasks without questions: expiry aborts and returns `failed`/`timeout`, with
no wrap. A later shortening (soft Stop) is not seen by this snapshot. Live
deadline updates and wrap belong to 653.10. The Job deadline is the hard bound.
MCP over stdio, including Prime offline, remains unverified. ACKs and receipts
are task claims, not core evidence of execution or obedience.

### Cognition command tool (lifemodel-653.9.8)

The platform registers `core.steerTask` beside `core.startTask`, outside the
legacy Motor Cortex registration. Legacy `core.task` is unchanged. The tool
accepts `action: read | steer | answer` and `taskId`; commands require `text`,
and answers also require `questionId`. TaskService composes the acceptance
registry with the fenced mailbox. Its read view includes the open question,
command ACK disposition (`queued | accepted | rejected | uncertain`), receipts
and an explicit `retryable` flag. Rejected intake is retryable in a **new**
deciding turn; replay returns the original committed command, not a new send.
Uncertainty and failed receipts remain visible and are not automatic retries.
Cognition commands and question reads use a dedicated two-connection bounded
SQL pool, separate from owner intake and the task listener. A post-commit relay
notifies the listener mailbox instance so its held poll wakes immediately;
bounded transport rechecks still cover a lost commit reply or notification.

Command IDs hash the trusted recipient and persisted deciding-turn ID plus the
operation identity: task ID and question ID for answers; task ID and per-task
committed/recovered steer count for steers. Reads reserve no count and do not
recover write receipts. Refusals do not advance the steer count.
`recoverAcceptedEffect` selects the operation and target IDs before regenerated
payload validation, so a crash after command commit can recover the original
text even if replay adds/removes reads or refusals. The queued tool receipt is
returned after Postgres commit even if no launcher is polling. It promises
neither native admission nor obedience. An end-turn/successor barrier rejection
is ACKed and retired, then shown as `rejected, retryable: true` by read.

Question `task_report` signals use the existing durable bus admission receipt.
Core reads the question from Postgres during normalization; aggregation selects
one question for one cognition turn. A failed lookup logs a safe warning and
leaves the signal pending for a later tick, without stopping the core. A prepared
question waiting on busy cognition is reused until cognition becomes available,
then revalidated before selection. Busy cognition and an owner-input batch
retain the unselected question on the durable bus. Step and terminal reports do
not wake cognition. The trigger escapes and quotes question text as untrusted
content. Trusted tool context restricts question-turn commands to that task;
ordinary agent turns need no owner-message trigger. Correlated answer commit
closes the question, not a launcher ACK. On an uncommitted question-turn replay,
the historical question remains available to recover the already committed
answer under the same command ID. A completed question does not wake again.
No polling or plugin-type import is added to the cognition path. D7 is unchanged.

Source checks: `tests/integration/task-mailbox.test.ts` exercises the real
Postgres/Valkey, aggregation and cognition path, crash/replay and a closed ACP
barrier; `tests/unit/task-steering-lifecycle.test.ts` holds the brief's write
callback to prove `intakeReady` cannot resolve early. These are source evidence,
not a deployed-harness or owner-interface acceptance claim. Task-side MCP
question/step tools remain in lifemodel-653.9.9.

### Command routes and durable storage

`GET /task/commands` returns `{command: null}` after at most 25 seconds or one
`{command: {taskId, attemptId, commandId, direction: "core_to_task", sequence,
kind, text, questionId?}}`. It returns the oldest outstanding command, not a
sequence watermark. A task-scoped commit notification wakes only that task's
waiter. Empty database authority rechecks back off from one to two, four, then
five seconds to cover missed notifications. They do not lock task or launch
rows for update or repeat Kubernetes calls. The listener verifies live Kubernetes
identity once on every poll request (at most 25 seconds), and again before
returning a command after any wait. Every SQL transaction commits and releases
its client before waiting; successful transactions reuse pooled connections.
Shutdown cancels held polls.

Commands and event frames share the same two credential-verification workers and
the same round-robin SQL workers, bounded by `tasks.channel.workers` and
`tasks.channel.sqlConnections`. Credentials queue by token digest; verified work
queues by Job UID. One Job cannot own concurrent SQL operations across event,
poll, ACK and receipt routes. Held polls occupy neither worker nor SQL client.
There are at most 16 command polls and 32 command writes, with one poll and four
writes per credential and per verified Job. Polls and writes each use at most a
quarter of `tasks.channel.maxBufferedBytes`, charged to the common event/command
budget; at least half remains reserved for events. Per-socket limits still apply.
The task channel/replay pool remains physically separate from owner intake.

The real-store isolation test runs the real owner core in the same process and
uses one two-connection task pool for command reads/writes, event append and
replay. Two polls remain held while repeated receipts are committed, an owner
message and reply commit, and a third task's event receives an ACK under a bounded
event wait. Idle pool assertions run after completed empty reads, before rechecks
are released, not at an arbitrary sample time.

`POST /task/commands/ack` takes `{taskId, attemptId, commandId, disposition}`
(`accepted | rejected | uncertain`). `POST /task/commands/receipt` adds
`receiptId`, and accepts `inserted | deferred-to-next-turn | failed | uncertain`.
Both return `{stored: true}` only after commit. They have a ten-second request
bound, above both adapters' five-second native admission bound. This is the
deadline of the ACK POST, not a timer from command delivery to ACK. Core has no
such delivery lease: an unretired command is redelivered on the next poll.
No changes to ordinary event ACK settings are needed. The launcher uses independent poll,
ACK, receipt and progress clients so a held poll cannot block writes.

`TaskCommandMailbox.enqueueCommand` is a core-only API, not an agent tool.
It validates immutable IDs/content and assigns monotonically increasing order
under the task lock. `core.task_commands` retains content after retirement;
`core.task_command_acks` stores disposition before retirement in the same fenced
transaction. A database trigger refuses retirement without that ACK. Exact
creation/ACK/receipt duplicates are idempotent; changed content conflicts.
`core.task_command_receipts` retains at most 16 receipts per command. A task
admits at most 1024 commands, matching the harness journal reservation. Enqueue
also bounds the complete command response by the configured frame ceiling before
commit. New commands and polls are refused for terminal, revoked or wrapping
authority; wrapping delivery policy belongs to 653.10. Exact core-side creation
replay returns the original command even after these state changes; changed
content still conflicts. Existing ACKs and receipts remain admissible while the
same fenced Pod has active or wrapping intent, a live deadline, allocation and
won claim. Revoked, expired or replaced bindings cannot write old ACKs/receipts.
No replacement Pod receives commands. The forward migration is `20261015000026_create_task_commands.sql`.

A `question` frame's payload is `{questionId, text}`. `questionId` equals its
launcher-generated `messageId`; text uses the step-line bound. Core records
questions in `core.task_questions`, with a unique partial index on the open
question per task. Committing its correlated `answer` command marks it answered.
Question wake/cognition tools and the MCP dispatcher remain later tasks.

## Disposable task trace route

`POST /task/trace` carries `{taskId,attemptId,launchId,span}`. The span contains
`traceId`, `spanId`, `parentSpanId`, `component`, `startedAt`, `endedAt`, `status`
and `attrs`. It uses the channel audience and current bound launch authority,
but is not a mailbox event. A 200 `{accepted:true}` acknowledges trace intake,
not durable task work. Trace intake emits no Signal and owns no mailbox sequence,
terminal report, retry or finalization state. Trace authentication and authority
have independent single-worker queues and admit at most two requests. Their
buffered-byte allowance is separate from mailbox intake. Production trace
authority has its own one-connection fenced pool with a one-second operation bound;
it reads task/launch rows without the exclusive locks needed by terminal append.
Shared canonical authority checks still deny stale, revoked or unclaimed pods.
The authority transaction makes 13 sequential SQL round trips plus connection
setup. Its one-second budget covers 40 ms round trips with setup margin; it is
not a terminal budget. The independent launcher client allows 1500 ms for this
check, authentication and HTTPS, with no retry.
The unfenced observation writer uses another one-connection pool. The trace
route never falls back to the briefing reader's exclusive locks.

The launch root span ID is `launchId`; its parent comes from the won briefing.
Harness child IDs and their non-null parent IDs are namespaced as
`launchId_rawSpanId`. A null harness parent binds to the launch root. A failed
root preserves the namespaced `attrs.failureSpanId` of the required tool that
failed, even when a later tool succeeded. Tool commands, bounded output tails,
model usage and completion text are trace observations, not authority or results.

Launcher intake is capped at 2048 observations per run, 128 queued spans and
30000 encoded bytes per span. Oversized or excess observations are dropped.
The launcher scrubs projected token contents before sending. It uses a separate
1500 ms trace client and no connection or ACK replay. A trace failure never blocks
the terminal report or changes the semantic outcome. After terminal settlement,
the independent trace drain closes within one second; remaining spans may be
lost. There is no fixed `log.jsonl` journal or log object upload. See
[observability](observability.md) for the trace storage and content policy.

## Semantic terminal report and finalizer handoff

Use `kind: "terminal"` and the same frame identity fields. Payload:

```json
{
  "outcome": "succeeded",
  "summary": "The requested report is ready",
  "resultObjectId": "object_result_id",
  "artifactObjectIds": ["object_attachment_id"]
}
```

`outcome` is `succeeded`, `failed`, or `aborted`. Failed requires a `reasonCode`
matching `[a-z][a-z0-9_]{0,63}`; other outcomes do not carry it. Summary follows
the step-line bound. `resultObjectId` is an object ID or null. `logObjectId` is
not part of the terminal protocol. Artifacts are at
most 64 distinct object IDs. Only IDs are allowed: no object bytes, signed URLs,
stdout or log chunks. The launcher marks those objects through storage before
reporting their IDs. A terminal report is unique per attempt. A claimed semantic
success is not yet public `done`: the finalizer must validate marks, stop compute,
revoke writes, obtain a seal, and commit its keyed outcome separately. Those
checks establish finalization and retention, not the truth of the success claim.

`TaskMailbox.readTerminal(taskId, attemptId)` returns the committed frame and
ACK for lifemodel-653.8.9. This leaf does not seal, publish, change public task
state, or release the compute slot.

## Bounds, isolation and shutdown

All limits are typed loader/platform declarations mirrored in core, finite safe
integers with minimum 1 and hard maximum equal to the defaults below. Values
are snapshotted when the listener starts; changes apply on its next start.
Raising a hard maximum requires code review and rerunning the two-second fixture.

| Setting | Default / hard maximum |
| --- | ---: |
| `tasks.channel.maxFrameBytes` | 65536 |
| `tasks.channel.maxUnackedFrames` | 16 |
| `tasks.channel.maxUnackedBytes` | 1048576 |
| `tasks.channel.maxBufferedBytes` | 4194304 |
| `tasks.channel.ackTimeoutMs` | 5000 |
| `tasks.channel.workers` | 2 |
| `tasks.channel.sqlConnections` | 2 |

Before body intake, a fixed-length request reserves its Content-Length (at least
one byte); a chunked request reserves the smaller of the frame ceiling and the
two byte budgets. Bodies exceeding their reservation are refused with 413.
Thus small frames fit lowered byte budgets without requiring the frame ceiling
to be lowered too. Reservations include slow/partial bodies, queued frames and
outstanding responses. At most 64 requests may be admitted across all stages,
even when bodies are tiny. Each connection has its own frame/byte accounting.
Fresh verification has two dedicated workers, separately from mailbox workers,
and serializes repeated credentials by a nonlogged token digest without caching
proofs. Unknown credentials cannot be assigned a trusted task share; distinct
credentials can saturate this bounded verification reservation, but never occupy
mailbox or owner-intake workers. Verified queues are round-robin by Job UID,
not the supplied frame task ID: one frame per Job per pass, no concurrent frames
from one Job even across Pod credentials or token rotations. Active mailbox
workers are bounded by both worker and SQL limits. Core creates a physically separate bounded Postgres pool
for task intake and replay. It never borrows the owner-intake pool. Artifact
transfers use storage and no channel worker. On shutdown, intake stops, sockets
close, identity requests abort and mailbox-owned SQL clients are destroyed before
core drains owner work, inside the same overall stop deadline.

## Durable Signals and restart

`core.task_mailbox` stores immutable content, receipt time and per-row emission
status. `core.task_mailbox_cursors` stores per-direction receipt/emission counts
and exact last message IDs; these are not contiguous sequence watermarks.
The replay scan selects every committed unsignalled row, so a late commit or
sequence gap cannot be skipped. Core emits a normal `task_report` Signal from
`task.channel` through the existing Valkey bus. Signal data contains task,
attempt and message IDs plus `eventKind`, not report content. Step and question reports remain
available for cognition and later status views. Only question `task_report`
wakes cognition; step does not. Terminal reports identify finalization work.
The [finalizer](task-finalize.md) consumes terminal reports before tick-local
completion and scans all unfinalized terminal rows at startup; this does not wake the old
Motor Cortex cognition path or introduce another event model. `signalled_at` proves
bus admission only, not finalization. The finalizer must scan every unfinalized
terminal mailbox report at startup regardless of `signalled_at` or the bus
watermark, and consume terminal `task_report` Signals before tick-local completion.

A Valkey Lua operation atomically deduplicates bus append by task/direction/message
ID. Only after that succeeds does Postgres mark the row signalled. A crash after
insert but before append replays the row. A crash after append but before marking
replays the append key and cannot insert a second Signal, including after bus
trimming. The dedup receipt remains durable alongside the mailbox lifetime; its
retention must be paired with future task/mailbox retention, not a short TTL.
Append completion requests replay independently of the HTTP ACK or disconnect.
If COMMIT's reply is lost, a fresh mailbox transaction waits for the affected task's
row lock before scanning. This observes the settled database outcome instead of
racing an unresolved server-side commit. Canceled queued requests are unlinked
before their frame reservations are released.
This closes the mailbox-to-bus retry gap without claiming a cross-store transaction.
The bus's existing ledger/turn IDs still own downstream processing and replay.

Tests: `tests/integration/task-mailbox.test.ts`,
`tests/integration/task-channel.test.ts`, `tests/integration/task-channel-replay.test.ts`,
`tests/integration/task-briefing.test.ts`.
