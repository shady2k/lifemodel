# Task-to-core live channel

Task: lifemodel-653.8.8. This is the task-to-core direction of ADR-014 D2.
It is a source contract, not deployed stage acceptance. Steering remains stage 4.

## Transport and identity

The launcher posts one JSON frame to `https://core.lifemodel.svc:8447/task/events`.
HTTP/1.1 keep-alive gives a reusable outbound TLS channel with one explicit HTTP
200 ACK per frame. Unlike a bidirectional streaming body, this bounds body intake,
allows a clear 429 with Retry-After, and does not tie up a worker while a peer holds
an idle connection. There is no command route or task ingress port.

The server leaf is issued by the instance CA, stored in the fixed
`core-task-channel-tls` Secret, and mounted only into core. The listener reloads
its projected leaf every minute. Health stays on the separate core health port.
A0 precreates the Secret; the loader can read/update only that name in the
application namespace. It cannot create arbitrary application Secrets.

Each request carries `Authorization: Bearer <lifemodel-task-channel token>`.
The launcher must reread its projected token for every request, verify the instance
CA, and replay the same immutable message after an ambiguous response. No token
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

## Semantic terminal report and finalizer handoff

Use `kind: "terminal"` and the same frame identity fields. Payload:

```json
{
  "outcome": "succeeded",
  "summary": "The requested report is ready",
  "resultObjectId": "object_result_id",
  "logObjectId": "object_log_id",
  "artifactObjectIds": ["object_attachment_id"]
}
```

`outcome` is `succeeded`, `failed`, or `aborted`. Failed requires a `reasonCode`
matching `[a-z][a-z0-9_]{0,63}`; other outcomes do not carry it. Summary follows
the step-line bound. Result/log IDs are an object ID or null. Artifacts are at
most 64 distinct object IDs. Only IDs are allowed: no object bytes, signed URLs,
stdout or log chunks. The launcher marks those objects through storage before
reporting their IDs. A terminal report is unique per attempt. Semantic success
is not public task success: the finalizer must validate marks, stop compute,
revoke writes, obtain a seal, and commit its keyed outcome separately.

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
attempt and message IDs plus `eventKind`, not report content. Step reports remain
available for later status views. Terminal reports identify finalization work.
The next finalization leaf supplies its consumer; this leaf does not wake the old
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
`tests/integration/task-channel.test.ts`, `tests/integration/task-channel-replay.test.ts`.
