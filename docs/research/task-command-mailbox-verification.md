# Ordered task command mailbox verification

Task: lifemodel-653.9.7. Source contract evidence, not deployed stage acceptance.

The integration fixture uses the isolated launcher's migrated Postgres and Valkey,
real TLS, and the existing fake Kubernetes API boundary. Commands use the public
poll/ACK/receipt routes. The revised owner-isolation case runs the actual owner core in the same process.
Command reads, receipt writes, event appends and replay use one shared two-client
task pool, like production. Two empty polls remain held while a receipt flood,
another task's event ACK and an owner message/answer commit. Idle pool assertions
run after completed empty reads and before rechecks are released, not at an
arbitrary in-flight sample. The embedding pipeline and LLM are external-boundary
fakes; the owner loop and stores are real.

## Mutation checks

Hand-planted mutations were tested one at a time in
`tests/integration/task-channel.test.ts` through `lifemodel-heavy node
scripts/test-isolated.mjs test -- ... -t <case>`.

| Mutation | Case | Observed RED |
| --- | --- | --- |
| Poll sorts by descending sequence | delivers commands in committed per-task order... | Returns `a-second`/2 instead of `z-first`/1 |
| Same-ID changed content accepted | replays identical command creation... | Changed-content enqueue resolves instead of rejecting |
| Retirement update runs before ACK insert | delivers commands in committed per-task order... | Database guard rejects; ACK route returns 503 instead of 200 |
| Empty poll commits but retains its checked-out client until HTTP cancellation | historical owner-poll case (round 2) | Pool has one checked-out connection instead of zero |

Every targeted mutation run exited 1 with the named behavioral assertion failure.
The held-client mutation's first provisioning attempt failed Docker Hub DNS;
that was not counted as RED. Its retry reached the test and failed the pool
assertion. An earlier held-client variant tried acquiring another client before
the transaction released its first one and hit the fixture deadline; the more
precise retained-idle-client variant above is the acceptance evidence.

All mutations were restored before the unmutated regression run and full check.
Logs are worker-local `.w6539-7-mut-*.log`; the worker report records final check
results and revisions. Tests also cover missed notifications, revocation while
waiting, exact ACK replay, conflicting disposition and receipt IDs, launcher
journal reopening after lost ACK, and in-flight ACK drain at shutdown.

## Review round 3

The revised integration and unit suites add generic harness readiness, per-task
commit notifications, shared fair auth/SQL workers, deleted Pod/Job checks after
a held wait, exact state-specific refusal codes, authoritative wrapping reports,
configured enqueue frame limits, and explicit deterministic/transient error
classification. A direct SQL insert also proves the one-open-question index as
defense in depth independently of the application's task-row lock.

Additional hand-planted mutations, each restored after its targeted run:

| Mutation | Case | Observed RED (exit 1) |
| --- | --- | --- |
| Start intake without waiting for harness readiness | leaves early commands in core... | Transport poll occurs before readiness opens |
| Remove live verify before delivery after a held wait | re-verifies a deleted Pod/Job... | Returns command with HTTP 200 instead of identity denial 403, both resources |
| Remove ACK or receipt task-ID comparison (separate runs), leaving attempt guard | task A cannot ACK, receipt, or poll task B... | Leaks not-found 404 instead of identity mismatch 403 |
| Broadcast command commit to every task listener | command commit wakes only its task listener... | Two task wake callbacks instead of one |

The ACK task-ID test uses the attacker's own attempt with the victim task ID.
This isolates that comparison: a missing check cannot hide behind the remaining
attempt check. A poll has no caller-selected task locator; A's verified proof
can read only A's outstanding row, not B's.

Network/DNS or TLS provisioning failures are not counted as mutation evidence.
The source and final full-check results are recorded in the worker report; this
record is not independent stage acceptance or a deployed network walk.

The revised code also re-killed the four original required mutations: descending
command order, accepting changed content, retirement before ACK, and retaining
an empty poll's SQL client. Each exited 1 at the intended assertion. The new
shared-pool idle gate observed two retained clients instead of zero. Additional
wrapping-state-only and terminal-frame-only mutations each accepted a new command
instead of rejecting; neither test is masked by canonical wrapping mode or
beginFinalization. All these mutations were removed before verification.
