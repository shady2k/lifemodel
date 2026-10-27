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
| Ignore the accepted `softDueAt` | `unanswered question waiting until softDueAt` | All three unanswered-question cases hit their 30-second test bound instead of returning failed/timeout at their 12-second task deadline. |

The third mutant removes both the adapter's unsettled-tool rejection and its
pending-tool updates, modeling acceptance of prose alone. Removing only one is
also prevented by the other layer; prose alone must not bypass both checks.

## Limits

No workbench image rebuild, deployed Job, real provider, arm64 execution,
long-poll, core commands, MCP question tool, or 653.10 wrap path is checked here.
Question correlation is a generic seam, driven by tests until 653.9.9 supplies
the MCP implementation. Prime's accepted Python-exception limitation remains.
The three pre-existing shared-contract skips remain unchanged. Local logs live
in ignored `.worker-*.log` files; the worker report records final command results.
The automatic document acceptance gate is not installed and did not run.
