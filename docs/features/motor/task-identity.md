# Task identity and model gateway

Task: lifemodel-653.8.6. Implements the gateway side of ADR-014 D1/D3.
This describes source behaviour, not deployed stage acceptance.

## Separate TLS task door

`https://model-gateway.lifemodel-system.svc:8446` uses an instance-CA leaf.
The existing core listeners remain HTTP 8080 (model) and 8081 (status).
No task route or caller-controlled header on those listeners selects task authority.
The task listener uses the same ADR-013 slot reader, primary/reserve failover,
header rendering, response filtering and key custody as core. There is no relay
socket or alternate provider implementation.

- `POST /task/start` takes exactly `{taskId,attemptId,launchId,bootNonce}` and
  `Authorization: Bearer <lifemodel-task-model token>`. IDs identify the requested
  registry row, not the caller. `bootNonce` is a fresh, memory-only random UUID
  per launcher process (16–128 ASCII letters, digits, underscore or hyphen).
- `POST /v1/chat/completions` and `GET /v1/models` require the **raw token** on
  `x-lifemodel-task-token`. The harness's placeholder `Authorization` is ignored.
  A dedicated header keeps the Kubernetes token separate from OpenAI-compatible
  harness credentials. These paths need no provider URL rewriting.

The launcher reads `LIFEMODEL_TASK_MODEL_TOKEN_FILE` for every HTTP request and
uses `LIFEMODEL_TASK_MODEL_CA_FILE` to verify TLS. It must never disable certificate
verification. The executor supplies `LIFEMODEL_TASK_MODEL_ENDPOINT`.
Neither token nor placeholder is forwarded upstream. Body `user` and the slot
`{session}` placeholder are replaced with the trusted registry task ID; caller
`session`, `session_id`, `conversation_id`, `taskId` and `task_id` are removed.
Unknown input headers are not forwarded. The task ID always comes from the
verified Job's registry binding, never from a caller session or body.

## Proof and transaction order

Every request performs fresh TokenReview with audience `lifemodel-task-model`,
exact `system:serviceaccount:lifemodel-motor:task`, a nonempty service-account UID,
and exactly one bound Pod name and UID claim. SA-only tokens fail. It then GETs
that Pod in fixed namespace `lifemodel-motor`, checks name/UID, non-deletion,
`task` SA and exactly one `batch/v1` Job controller. It GETs the Job and checks
name/UID, namespace, non-deletion, launch label, controlled template labels,
selector, positive native deadline and finite Job.status.startTime. The actual
normalized Job template hash must equal its annotation. Normalization mirrors
the executor, retaining unknown fields and checking generated ownership fields
before omitting them. Names must be Kubernetes DNS names.

The SQL lookup starts from that verified Job name and UID. In a bounded
transaction the gateway locks task, launch, canonical intent and allocated space
in the canonical writer's order. It checks nonterminal state, no terminal
candidate/tombstone, reserved slot, deterministic Job name/launch label, registry
Job UID/template hash and the original observed Job start time. Missing intent
fails closed; the gateway never initializes or extends canonical authority.
The reconciler must already have initialized it from Job start time.

Start additionally requires active intent and no soft-stop request. It verifies
both the saved allocation receipt and storage allocation/catalog row. Canonical
deadlines cannot exceed the accepted profile/grace snapshot. Database wall time,
read after lock waits, must precede the hard deadline. In **one transaction** it
inserts `task_access.start_claims` with unique launch/task/attempt/Pod identities,
boot nonce, Job start time and deadline snapshot, then inserts the immutable
`task_access.projections` row. Projection locators come only from the verified
Pod claim and deterministic Job name; core supplies neither names nor UIDs.
It snapshots the independent storage access revision and canonical intent
revision, mode and deadlines. Any error rolls back both writes.

Only the successful first commit can return `{start:true,taskId,attemptId,
launchId,space,softDueAt,hardStopAt}`. It is a one-use transition ACK, not a bearer
permit. The launcher must guard its own inert→started transition and reject
late ACKs after its request deadline. No ACK replay is implemented. An ambiguous
COMMIT, lost reply, timeout, gateway restart, same nonce retry, new process nonce,
second Pod or replacement Pod cannot reacquire start. HTTP `409 start_consumed`
means **stay inert and report uncertain/lost start**, never launch or retry with
a new identity. A model authorization can read the binding but grants no start.
Claims remain durable through compute cleanup.

Model requests require that same Pod/Job to have won the claim and have the
matching projection. The canonical intent must be `active` or `wrapping`, never
`revoked`, and database time must precede the hard deadline. A stale/paused
projection cannot defeat canonical revocation. The intent's share lock orders the
short authorization with lifecycle updates; no SQL lock spans model network I/O.
After body intake, slot custody and destination resolution, the listener repeats
fresh Kubernetes and SQL authorization immediately before each upstream dispatch,
including reserve failover. Pausing a body or a custody/DNS read cannot preserve
old authority. An upstream request dispatched before revocation can finish; no
next request may authorize after committed revoke. This is request-level mediation, not cancellation of
already-dispatched upstream inference or a cross-service transaction.

## Bounds, caching and failures

Identity/authorization uses a five-second operation budget (including SQL lock
waits and pool checkout). Kubernetes uses one bounded keep-alive agent, rereads
the gateway's own token/CA for each call, bounds response size and never logs
raw errors. SQL uses a maximum-eight pool with finite connection/query/statement/
lock limits. Cancellation destroys the owned connection; uncertain protocol
states are retired, not returned for another request. All request/socket/client
errors have safe listeners kept through teardown. The start body is at most
4096 bytes. Header/body intake is bounded. Model forwarding retains ADR-013's
complete request/first-byte/idle/connect deadlines.

No positive TokenReview, Pod/Job liveness, canonical intent, binding authorization
or deadline decision is cached. Kubernetes token rotation is accepted on the
next request. Only transports and ADR-013's existing slot custody cache are
reused. The task TLS leaf reloads from its mounted directory every minute; a
failed reload keeps the last valid certificate and emits only a code.

- 400 `invalid_request`: malformed/extra start fields or invalid IDs/nonce.
- 403 `identity_denied` / `task_denied`: wrong identity, missing/deleting resource,
  wrong registry/intent/binding, revoked authority or elapsed deadline.
- 409 `start_consumed`: no new start; the existing claim is never replaced.
- 413 `request_too_large`: start body exceeds the limit.
- 503 `identity_unavailable` / `task_unavailable`: API, credential, schema or SQL
  unavailable or timed out. There is no fallback execution or model path.
- 404: route absent on this listener. Provider errors use ADR-013 safe codes.

Denials contain a random diagnostic ID and safe code/status only. Logs contain
IDs, status and codes, never tokens, credentials, prompts, request bodies or raw
URLs/errors. Slot response filtering protects provider credentials.

## Platform and SQL custody

The gateway runs in step A, before SQL arrives in C. Readiness still checks only
its own status listener, never SQL, credentials or task rows. The optional
`model-gateway-db-credentials` directory appears after C copies core credentials;
`LIFEMODEL_DB_USERNAME_FILE` and `LIFEMODEL_DB_PASSWORD_FILE` are read per SQL
operation. The pool is created lazily. A changed credential replaces the pool,
without stale-credential fallback. This follows the interim owner-login decision
used by storage, until lifemodel-2t5 provides narrow leased roles. Gateway owns
only start claims and verified projections, not core lifecycle writes.

The gateway gets only cluster `create` TokenReview and namespaced `get` Pod/Job
in `lifemodel-motor`. These prove live bound identity and controller ownership.
No list/watch, Secret or Kubernetes mutation permission is granted. Network
policy admits only task 8446, API proof and the existing model/Bao and SQL routes.
The task SA retains zero RBAC. The root `.dockerignore` already allows loader
TypeScript files; no image-context expansion or new dependency is needed.

See [registry](task-registry.md), [storage read contract](storage-access-contract.md)
and [launch](task-launch.md). `tests/integration/task-identity.test.ts` exercises
real migrated Postgres with local TLS Kubernetes and fake upstream HTTP endpoints.
