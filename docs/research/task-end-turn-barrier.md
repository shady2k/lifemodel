# End-of-turn barrier verification

Task: lifemodel-653.9.6. Base: `2a92844a`. These are local launcher-policy
checks inside the untrusted task Pod, not proof of task truthfulness or stage
acceptance. Real agents use the isolated launcher's checksum-pinned OpenCode
2.1.4 and Prime Agent 0.10.1, against a local TLS stub gateway, never a live model.

## Shared contract

`tests/integration/task-harness-contract.test.ts` runs the same tail/late
steering and question-timeout assertions for both shipped registry entries and
the distinct scripted ACP fixture. A final-text callback admits the tail steer.
An end-turn question wait admits the late steer. The latter would be lost by
the old shutdown path. Late-tool additionally starts a real tool in the
continuation/successor. The last model body must have one user row containing
the steering text, and the task returns only the steered final result.

The question seam keeps the task waiting, reopens intake for an admitted answer,
and uses the original absolute `softDueAt`. All three entries must fail with
`timeout` when the question remains unanswered. The Prime-owned fixture proxies
the actual daemon wire and removes successor `toolResult` rows while retaining
final text. The harness must fail `end_turn_uncertain`. Unit daemon-wire cases
also cover valid, absent, unfinished and error results.

Related fixes: storage and launcher fixtures now supply the existing start
claim's `softDueAt`; plugin tests recognize native ACK as pending, never inserted.
The lifecycle closure test waits for `Settling task turn` before checking a
rejection. Polling `steer` to discover closure is wrong: a probe can itself
become an admitted flight and deadlock the test.

## Hand-planted mutations

Each mutation ran alone through `lifemodel-heavy node scripts/test-isolated.mjs
test -- tests/integration/task-harness-contract.test.ts -t <filter>`. Every
command returned its own exit **1**. Each mutation was restored before the next.
The final full check runs the restored sources.

| Mutation | Filter | RED evidence |
| --- | --- | --- |
| Skip the end-turn barrier | `final-answer steer` | All nine tail/late/late-tool cases fail across the three agents: stale or concatenated text, or the answer seam is never reached. |
| Resend steering text instead of the plain continuation | `late final-answer steer` | OpenCode's final model history contains two steering user rows instead of one. Prime and scripted cases still pass; this specifically exercises OpenCode's plain ACP continuation. |
| Accept Prime final text without required successor tool evidence | `successor tool evidence is missing` | The actual Prime daemon runs its successor tool, the proxy removes its result, and the mutated adapter incorrectly succeeds; the expected failed classification catches it. |
| Ignore the accepted `softDueAt` | `unanswered question waiting until softDueAt` | Historical first-round run: all three unanswered-question cases hit their 30-second test bound instead of returning failed/timeout at their 12-second task deadline. |

The rework test allows 30 seconds of task budget and 45 seconds of test budget,
with a 20-second startup observation bound. This gives startup a larger margin
under two workers.

The third mutant removes both the adapter's unsettled-tool rejection and its
pending-tool updates, modeling acceptance of prose alone. Removing only one is
also prevented by the other layer; prose alone must not bypass both checks.

## Review-round regressions

The rework uses an event-gated delayed admission. Its event sink does not wait
for the send: the send waits for `Settling task turn`, then calls the actual
registry adapter. The first reconciliation must contain the admitted ID and the
result must be the steered result on both real pins and the scripted agent.
Lifecycle unit tests additionally hold a native ACK across a fully dispatched
reply and assert no reconciliation occurs before it resolves.

Fake-daemon tests keep `more:true` beyond the required marker, put an oversized
old row behind that boundary, simulate lagging idle flags without command IDs,
check both nonempty queue lanes, and reject repeated cursors or 1000 unfinished
pages. Relevant rows have an 8 MiB aggregate bound as well as the 1 MiB frame
bound. Earlier history is not fetched. Multiple markers retain evidence from
the earliest required user row so an earlier unfinished tool cannot disappear.

Prime successor tests admit another steer while closing intake. The first idle
observation is not trusted: admissions settle, native idle is checked again, and
new work is awaited before transcript inspection. Progress from normalized
successor tools goes through the same event path as ACP updates. Distinct ACP
assistant `messageId` values replace old final prose; chunks of one ID append.
There is no invented `turn_start` notification in generic protocol handling.

The question lost-wake version check was redundant: `wakeAdmission` is installed
synchronously before reopening intake and before emitting the waiting event.
An admission completed inside that event resolves the already-created promise.
The rework removes that redundant check and tests this exact interleaving. A
local flag closing without admitted text fails uncertain. A faulty seam that
immediately resolves with its level unchanged is rate-limited, not a hot loop.

Settled failures retain the existing within-turn recovery rule across turns:
a reset alone does not recover them, but later agent prose or new/resumed tool
work does. Unsettled calls always block success. The ADR and feature document
now say this explicitly rather than claiming immutable failure accumulation.
Every task currently stops at its start-snapshotted soft deadline, without wrap
or live shortening; those 653.10 gaps are explicit in both channel and harness
documents. No MCP implementation is added.


All review-round mutants below were planted independently and each isolated
command returned its own exit **1**. Sources were restored byte-for-byte before
the full rework check. Filters run through `lifemodel-heavy node
scripts/test-isolated.mjs test -- <paths> -t <filter>`.

| Mutant | Targeted regression | RED observation |
| --- | --- | --- |
| Delete admissions await | Lifecycle delayed ACK + shared delayed admission ACK | 5 failures: both lifecycle states and all three registered agents reconcile without the ID. |
| OpenCode unknown as inserted | Native disposition table | 3 failures: unknown, compaction and failed become idle. |
| Reject closed-intake replay | Closed replay lifecycle | Replay settles rejected instead of joining the native flight. |
| Force full scan on idle inserted command | Prime idle-with-receipt | Returns successor rather than idle with zero history reads. |
| Scan past required tail boundary | Prime old-oversize, old-many-pages, unsteered | 3 failures; old oversized row or endless old pages invalidate otherwise sufficient evidence. |
| Remove deferred receipt | Lifecycle continuation | Required receipt absent. |
| Remove both queue checks | Prime queue lanes | 2 failures: nonempty steering or followUp incorrectly returns idle. |
| Remove cursor nonprogress guard | Prime repeated more:true cursor | 1000 reads instead of 2. |
| Remove page cap | Prime endless more:true | Read count exceeds 1000 before test abort. |
| Remove softDueAt validation | Launcher invalid start claim | 4 failures: missing, null, number and malformed string start the harness. |
| Trust closed question flag | Question closed without native answer | Incorrect success instead of end_turn_uncertain. |
| Remove pending-ID continuation cap | OpenCode pending after continuation | Incorrect second continuation instead of unknown. |
| Skip successor intake fence | Prime steer during successor wait | No close/settle cycle; expected successor ownership is missing. |
| Ignore isError | Prime error successor evidence | Completed instead of failed tool observation. |
| Omit admission wake | Question admission inside waiting event | Test bound reached instead of waking reconciliation. |

## Rework full check

`lifemodel-heavy npm run check` returned exit **0** on restored rework sources:
all project typechecks, lint, formatting and 353 test files passed; 5450 tests
passed and 3 pre-existing skips remained (5453 total). The suite took 429.49 s;
the whole command took 487.36 s. This includes the full shared contract,
launcher negative claims, native adapter cases, lifecycle races and the generic
boundary scan. `npm run present` returned exit **0** with no new errors and 12
older dead references. No plugin source changed, so no workbench rebuild was
needed. These are local checks, not independent stage acceptance.

## Limits

No workbench image rebuild, deployed Job, real provider, arm64 execution,
long-poll, core commands, MCP question tool, or 653.10 wrap path is checked here.
Question correlation is a generic seam, driven by tests until 653.9.9 supplies
the MCP implementation. Prime's accepted Python-exception limitation remains.
The three pre-existing shared-contract skips remain unchanged. Local logs live
in ignored `.worker-*.log` files; the worker report records final command results.
The automatic document acceptance gate is not installed and did not run.
