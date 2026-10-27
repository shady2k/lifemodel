# Ordered task command mailbox verification

Task: lifemodel-653.9.7. Source contract evidence, not deployed stage acceptance.

The integration fixture uses the isolated launcher's migrated Postgres and Valkey,
real TLS, and the existing fake Kubernetes API boundary. Commands use the public
poll/ACK/receipt routes. The owner-isolation case starts a real core and waits
for its committed owner message and assistant answer while the poll remains held;
it also checks zero checked-out or waiting clients in a one-connection task pool.

## Mutation checks

Hand-planted mutations were tested one at a time in
`tests/integration/task-channel.test.ts` through `lifemodel-heavy node
scripts/test-isolated.mjs test -- ... -t <case>`.

| Mutation | Case | Observed RED |
| --- | --- | --- |
| Poll sorts by descending sequence | delivers commands in committed per-task order... | Returns `a-second`/2 instead of `z-first`/1 |
| Same-ID changed content accepted | replays identical command creation... | Changed-content enqueue resolves instead of rejecting |
| Retirement update runs before ACK insert | delivers commands in committed per-task order... | Database guard rejects; ACK route returns 503 instead of 200 |
| Empty poll commits but retains its checked-out client until HTTP cancellation | held poll releases every SQL connection... | Pool has one checked-out connection instead of zero |

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
