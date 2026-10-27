# Launcher MCP shared-contract verification

Task: lifemodel-653.9.9. Source verification on Linux amd64, not deployed-stage
acceptance. Base: `0b331fb1`. The isolated suite provisions OpenCode 2.1.4,
prime-agent 0.10.1 and a distinct scripted ACP agent from the registry. No live
Internet model is used; the real adapters call a local TLS model-gateway fixture.
Postgres and Valkey are real disposable stores. Pod identity proof in the shared
fixture is synthetic; fresh Kubernetes identity is covered by the channel suite.

## Checks and measurement

`lifemodel-heavy node scripts/test-isolated.mjs test --
tests/integration/task-harness-contract.test.ts tests/integration/task-tools.test.ts
tests/integration/task-launcher.test.ts` exercises the complete shared lifecycle,
real shell tools, live steering, parallel work, end-turn races, question waiting,
answer delivery and native successor evidence. The T02/T07 additions run for
both real registry entries and the scripted entry. Each drives MCP step and
question into the fenced mailbox, replays their exact frames, holds at the real
question barrier, runs 20 owner intakes and 20 second-task command/ACK exchanges,
then commits a correlated answer and observes success. Each ACK must be <=2 s;
the test logs all 40 latency samples per adapter.

T02's full image signing/deployed gateway/stop walk is not performed here. The
shared suite proves the isolated offline harness lifecycle and MCP path, not a
production network/LLM latency SLO. No skip is counted as evidence. The three
pre-existing conditional skips are the two non-Prime uncertain-socket cases and
Prime's owner-accepted Python-exception required-tool exemption. Native successor
evidence-loss cases apply to the native-successor adapter only.

`task-tools.test.ts` additionally checks actual shim discovery, durable-ACK
waiting, same-ID tool replay, changed-content refusal, an in-flight duplicate,
ambiguous question failure, four-peer bounds, listener cancellation, bounded UTF-8
text and a 40-question flood. Its credential test waits for the actual Python
MCP handshake before inspecting `/proc`: observing the short-lived `env` process
was insufficient. It compares environment **names only**, never values.

The production-launcher test runs the actual shim via the factory configuration,
loses the first step and question HTTP ACKs, and requires identical replayed
message IDs, sequences and payloads. One logical report of each kind remains.
The shared real-store fixture replays both reports against the real core listener
and mailbox, requiring equal stored ACKs and exactly one row per ID.


Final focused GREEN: the command above returned **0**, with **99 passed and
3 pre-existing skips** (three files; 102 total tests), after all mutations were
restored. Maximum observed ACK latencies in that run (milliseconds):

| Adapter | 20 owner intakes | 20 second-task controls |
| --- | ---: | ---: |
| opencode | 4.275 | 37.050 |
| prime-agent | 1.820 | 24.185 |
| scripted | 4.524 | 23.792 |

## Hand-planted mutations

Every mutation below was restored. Test selections run through the same isolated
launcher. Targeted selections skip unrelated tests by design; those are not passes.

| Mutation | Expected failing check | Observed RED |
| --- | --- | --- |
| Drop `session/new.mcpServers` | Shared `T02/T07`, all three adapters | exit 1, all three tests fail: question missing; no task can silently succeed without reporting |
| Delay real `OwnerMessageIntake.acceptOwnerMessage` 2100 ms | Shared `T02/T07`, all three adapters | exit 1, measured owner maxima 2103.96 / 2101.23 / 2102.79 ms exceed 2000 |
| Remove launcher `question_open` check | Shim question flood | exit 1: 40 accepted questions instead of one |
| Remove core `question_open` application check | Shared hostile-frame question flood | exit 1 on all three adapters: unique index still protects one question, but errors become `storage_error`, not explicit `question_open` |
| Ignore relay's saved call identity | Same-MCP-ID replay | exit 1: duplicate returns a new message ID/effect |
| Change launcher message ID after lost ACK | Production-launcher lost-report-ACK case | exit 1: replay content/identity conflicts and launcher cannot succeed |
| Remove `env -i` | Actual shim environment check | initial survivor (exit 0) exposed the pre-exec observation race; after waiting for MCP initialize, exit 1 and inherited environment names detected |
| Make relay `reporting` a number initialized from boolean | Loader typecheck, the full check's second gate | exit 2, TS2322 at initialization and both boolean assignments |

The first missing-MCP mutation let the fake model retry tools without a bound;
OpenCode reported missing question at timeout, then a worker died with retained
history. The fixture now caps discovery attempts at eight model requests. The
repeat mutation is the clean three-test RED recorded above (4.79 s), not that
worker failure. This cap does not weaken the assertions: both durable reports
must exist before responsiveness or answer checks run.

The full check is attempted once after the final implementation commit. Its
verdict and the final focused GREEN receipt are recorded in `.worker-report.md`.
A separate pre-final static run passed both TypeScript roots, then found two lint
errors (unbound callback and confusing void expression); both were corrected.
The static rerun was killed with exit 137. That is not counted as a green lint
result or as the required final full-check attempt.

## Remaining scope

No arm64 execution, workbench image rebuild, deployed Kubernetes/gateway walk,
signing/release, owner UI acceptance or 653.10 wrap/soft-stop check is claimed.
No dependency, tracker or agent pin changes were needed. Prime uses upstream's
session-scoped offline MCP registry and its already-baked Python `mcp` package.
The Pod remains one untrusted zone; credential-free shim transport is not proof
that its progress or answers are true.


## Review round 1 regressions (lifemodel-653.9.9)

The relay disables its request-read idle timeout during a report. The shim's
60-second receive bound exceeds three 5-second sends and the shared 30-second
startup-connect window. Unknown send outcomes are `report_uncertain`; only a
definite refusal is `report_unavailable`. A subsequent refusal cannot disprove
an earlier attempt's unknown commit. Definite 4xx refusals (except retryable 429)
release the local question and notify its waiters, while preserving call identity.
Relay diagnostics are fixed codes with no text. The tools socket closes before
outputs and terminal reporting, on both resolved and rejected execution. Closing
is idempotent. Existing `.launcher` permissions are explicitly reset to 0700.

Malformed, non-object, null-params and oversized stdin lines get JSON-RPC errors;
the shim keeps serving. Unknown protocol versions negotiate `2025-06-18` rather
than echoing unrecognized versions. Both supported versions are tested.

Checks use `lifemodel-heavy npm run check -- -- <files>`: the second separator
must reach `test-isolated.mjs`. The initially requested single-separator spelling
returned exit 2 before tests, not a product failure. The initial corrected scoped
run passed all 50 tests in task-tools and task-launcher (exit 0), including the
16-second slow ACK. A later scoped run also covers the real launcher's
first-refusal versus lost-ACK-then-refusal classification.

Required mutations were planted individually and restored:

| Finding | Mutation | Observed RED |
| --- | --- | --- |
| M1 | Re-enable 15-second idle timeout during report | exit 1: slow ACK returns before the 16-second commit (`committed` false) |
| L1 | Keep reservation after definite 409 | exit 1: `question.isOpen()` is true, expected false |
| L2 | Exit on malformed JSON instead of replying | exit 1: no JSON-RPC reply; test's 5-second bound expires |
| L4 | Defer tools closure until final cleanup | exit 1: socket still connects during output uploads; thrown-execution case still passes |

The first L1 attempt was terminated before tests (exit 143); it is not RED
assertion evidence. Its repeat produced the assertion failure above. Targeted
mutation selections skip unrelated cases; those skips are not passes. Logs use
the local `.worker-fix1-*.log` prefix. Final restored scoped and full-check
verdicts are recorded in the worker report. The full check is run exactly once;
an OOM exit 137 is reported without retry.

M2 is intentionally unchanged. Known limit, tracked on lifemodel-653.10:
uncertain or rejected answer admission leaves the task waiting until timeout,
even though core already committed the answer and cannot accept another for
that question. No stage acceptance or deployed gateway walk is claimed here.
