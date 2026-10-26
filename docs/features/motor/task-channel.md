# Task live channel

Task: lifemodel-653.8.8. This is the task-to-core direction of ADR-014 D2.
The task-to-core direction is a source contract, not deployed stage acceptance.
The core-to-task direction below is the stage-4 design, not yet implemented.

## Transport and identity

The launcher posts one JSON frame to `https://core.lifemodel.svc:8447/task/events`.
HTTP/1.1 keep-alive gives a reusable outbound TLS channel with one explicit HTTP
200 ACK per frame. Unlike a bidirectional streaming body, this bounds body intake,
allows a clear 429 with Retry-After, and does not tie up a worker while a peer holds
an idle connection. Today there is no command route or task ingress port;
stage 4 adds bounded outbound long-poll, never a Pod ingress port.

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
command replaces this once available. The Job deadline is the hard bound.
MCP over stdio, including Prime offline, remains unverified. ACKs and receipts
are task claims, not core evidence of execution or obedience.

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
