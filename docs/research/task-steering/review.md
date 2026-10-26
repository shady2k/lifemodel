# Review of native steering evidence — lifemodel-653.9.2

## Scope and method

This is a **same-model review**, not independent cross-model review. I read the worker brief, `run.mjs`, `stub.mjs`, `plugin/index.mjs`, `verify-evidence.mjs`, the collector/launcher and source notes. I checked `evidence/summary.json` against selected raw model bodies, ACP transcripts, native/plugin events and snapshots. I checked all model-request start times against recorded ACP intervals. All 156 initial SHA-256 manifest entries matched when read. After the strengthened duplicate rerun, all 159 updated entries also matched. Hashes establish consistency, not independent provenance or correctness.

I did not load skills, change the tracker, build, start containers, run the verifier, change production files or commit. This review is the only file I wrote. The main `docs/research/task-steering.md` deliverable was absent on first inspection. I subsequently read the newly written main report and sent corrections to the author. The final section records that pass; I did not edit the main report.

## Verdict

The probe supports **native mid-tool steering in the same ACP-driven engine** for both pinned agents. It also supplies useful negative evidence: **Prime's idle steer starts model work outside the completed ACP prompt**. Prime cannot receive an unqualified check-6 pass from this bridge.

OpenCode is the stronger candidate for the required lifecycle boundary. Its retained traces show `resume:false` does not wake an idle session, and a plain nonempty ACP continuation consumes parked steering without resubmitting that text. Do not extend these bounded observations into crash durability, arbitrary compaction preservation, or proof of every completion race.

| Check | OpenCode 2.1.4 | prime-agent 0.10.1 |
| --- | --- | --- |
| 1. Mid-tool delivery | Supported in retained run | Supported in retained run |
| 2. Two-call tool batch | Supported, genuinely concurrent tools | Supported for a two-call batch; tools execute **serially**, not concurrently |
| 3. Compaction | Supported with the scripted preserving summarizer | Supported with the scripted preserving summarizer; pending queue and later summary preservation both exercised |
| 4. Duplicate submission | Pending duplicate suppressed; promoted retry gives the existing row, does not wake, and later control request still has one steering row. Lost ACK itself not simulated | Negative: same transport ID does not deduplicate. Launcher must reconcile; safe retry after uncertainty not established |
| 5. Final-answer race | Pre-finish steer remains in turn; post-ACP steer parks and later ACP continuation consumes it | Pre-finish steer remains in turn; post-ACP steer runs immediately outside the original turn |
| 6. ACP observer boundary | No outside request starts observed in the retained bounded windows | **Fails** in `late` and promoted `duplicate` retry; ACP turn-0 updates remain visible on the connection |

## Decisive evidence

### Checks 1 and 2: good boundary evidence

Both `*-mid/model-requests.jsonl` files show the next primary request ordered as assistant tool call, completed tool result, then a user row containing `STEER_UNIQUE_6539`. The marker is not in the ACP prompt text. `admitted-during-tool` records `done0:false`; the shell result is `start-0` / `done-0`, and each first ACP prompt lasts over 20 seconds. No `session/cancel` appears. These facts support uninterrupted completion in this run; an admission ACK alone would not.

Both `*-parallel` next requests contain **two** completed tool results before a single steering user row. OpenCode ACP shows both calls in progress around `21:53:34`, completing around `21:53:38` and `21:53:42`. Prime ACP instead completes call 0 at `21:55:22.458` and only then starts call 1, which completes at `21:55:30.485`. Prime therefore tests batch-join ordering with serialized `python_repl` calls, not concurrent Python tool execution. If “parallel” means simultaneous execution rather than two calls in one response, that portion is unproven for Prime.

### Check 3: compaction is real, semantic preservation is scripted

OpenCode's compaction input includes the steering. `native-state.json` records a completed compaction. Its next primary request, in the second ACP turn, contains a `<conversation-checkpoint>` with the marker in both the summary and retained recent context. This is not two admissions: `steerOccurrences:2` counts text copies inside the checkpoint.

Prime's first compaction at `21:55:56.417` has no marker in summarizer input; the queued steer subsequently appears in primary request 2. The later compaction at `21:55:57.496` includes the marker. Primary request 3 and the later continuation contain it in the compaction summary. The native connection reports compactions. This exercises more than an unchanged, un-compacted history.

However, `stub.mjs:67` deliberately copies the marker into a canned summary whenever it finds it anywhere in summarizer input. This proves that the agents feed steering into compaction and use a preserving result. It does **not** prove that an arbitrary real summarizer preserves the literal command, its meaning, or an actionable instruction. OpenCode explicitly wraps the checkpoint as historical context, “not as new instructions.” The stub's final answer is unconditional, so there is no obedience or task-correction test. State these limits, rather than claiming lossless steering through arbitrary compaction.

### Check 4: duplicate test is useful but is not an ACK-loss fault test

`run.mjs:58` awaits the first receipt and then sends the second request. It does not cut a socket, discard an ACK or restart a client. Calling it a simulated lost-ACK retry is acceptable only with that qualification.

OpenCode plugin raw events show one enqueue and one delivered event for the stable steering ID. The first two receipts have the same creation time. After promotion, the third receipt reflects the promoted row's creation time and there is no further enqueue event or model request. Source notes explain native reconciliation by pending/promoted ID. This is good live-process idempotency evidence. The automated verifier is weaker: `totalRequests === 2` cannot alone exclude a wrongly parked duplicate because `resume:false` would keep it from executing. The saved context/disposition is taken **before** the third retry (`run.mjs:72-76`). A subsequent plain ACP prompt plus a post-retry context/inbox inspection would make promoted-retry uniqueness a stronger black-box assertion. No restart/crash claim is tested.

Prime receives the same outer ID on all three steers and produces two marker user rows in primary request 2, then three in request 3. This directly disproves transport-ID deduplication. A launcher may reconcile a unique command marker against queue and history, but queue absence is not proof of non-admission: dequeue/in-flight and compaction leave uncertain windows. Do not promise retry-safe exactly-once admission or durable acceptance from `queued:true`.

### Checks 5 and 6: distinguish the two endpoint cases

`stub.mjs:74-77` writes final content, then **awaits steer admission before sending the terminal finish reason and `[DONE]`** in the `tail` case. Both agents make primary request 2 with steering before the first ACP prompt ends. This establishes the pre-finish endpoint. It deliberately biases that endpoint toward successful admission. It does not stress the interval after stream completion but before ACP terminal settlement, or every concurrent admission/close interleaving.

OpenCode `late` admits after the first ACP prompt ends (`21:54:45.935`), reports pending, and makes no request until the plain continuation. Its next request contains the existing steering user row without the steering text being in that continuation's ACP payload. The plugin event map can distinguish pending/delivered while connected, but it is volatile and not restart-safe.

Prime `late` ends ACP turn 1 at `21:56:39.405`, ACKs steer at `21:56:39.413`, and starts primary request 2 at `21:56:39.423`, well before ACP turn 2 starts at `21:56:41.431`. Prime's promoted duplicate retry similarly starts primary request 3 at `21:56:26.804` with no later ACP prompt at all. These are genuine outside-turn executions, not requests from a second engine. The private daemon list contains one root at `/work/probe` with `rlmDepth:0`, `runtimeKind:"top-level"`, one attached client, and the same history receives ACP and native inputs.

Prime is **not absolutely invisible to a still-listening ACP connection**: late/duplicate ACP updates after the first terminal response carry `promptTurnId:0`. The precise failed guarantee is “no successor execution outside the original ACP prompt,” not “ACP receives no updates.” A client that stops observing at the prompt response misses them. A later plain ACP prompt does not merely wake parked Prime input; in `late` it adds a third model request after the successor already ran. Reading busy/idle before admission would not close this race.

## Receipts: claims that are honest

- Socket/frame reception alone can support **received**, not native acceptance.
- OpenCode's successful prompt result supports native acceptance of a user item. Pending/delivered events and ID reconciliation support live disposition. A delivered event proves native promotion, **not that the HTTP model request was sent or accepted**. The probe's raw stub request body proves inclusion for this run.
- Prime's `success:true, data:{queued:true}` supports acceptance to the native live queue. It supplies no stable steering identity or model-insertion receipt. Queue/history inspection is reconciliation evidence with uncertainty, not an atomic delivery ledger.
- Neither agent's receipt proves model obedience, successful remote provider processing, or crash-safe exactly-once effects.

The plugin currently labels `session.inbox.delivered` as `inserted` (`plugin/index.mjs:10`). Keep the report precise: inserted into **native context** is different from inserted into a **model request**. `model.request` hook notification also precedes actual receipt by the stub; the body log is stronger evidence.

## Initial verifier observations and remaining gaps

The promoted-duplicate gap below was resolved by the later rerun documented at the end. Other limits remain.

1. `verify-evidence.mjs:19-23` checks request **start times** only in the interval between first ACP end and second start. It does not prove no tool execution exists outside a prompt, no already-in-flight request outlives a prompt, or no execution starts after the second prompt ends. The driver mostly observes two seconds, then one second after continuation/retry. Report a bounded observation, not an absolute absence guarantee.
2. `tail` checks inclusion before first ACP end but does not assert all ACK/content/finish ordering. That ordering follows from this driver's control flow, not an independently randomized race.
3. `parallel` does not assert one marker occurrence in that request, although the retained body does have one. It asserts two results before the first marker and final done files, not overlapping execution.
4. Compaction assertions search for a marker anywhere. They do not distinguish native user row, summary, quote, duplicate checkpoint copy, or meaningful instruction. They also do not alone establish chronology relative to a successful compaction; raw events/snapshots are necessary.
5. OpenCode promoted duplicate uniqueness is not tested with a later model request, as discussed above. No actual lost-ACK/reconnect test or restart recovery is performed for either agent.
6. The stub's request-kind heuristic treats a no-tools request or broad “summarize” text as compaction (`stub.mjs:54`). Source notes correctly disclose that the OpenCode hook header said `primary` even for compaction. The retained structured prompts and completed native checkpoint substantiate these specific compactions; do not rely solely on the heuristic.
7. Request-header checks establish the fixture relay token in captured requests, not a broad absence-of-secrets guarantee. `connect.log` checks only `AF_INET`; this is not an IPv6 egress audit. The recorded launcher uses Docker `--network none`, which is the stronger isolation boundary. No external-route attempt is needed to conclude the retained calls are loopback, but the regex is not general egress proof.
8. The hash manifest does not cover the verifier itself, pins, source notes, Dockerfile, collector or inherited `/previous` code. Matching hashes do not bind all runtime inputs or attest the binaries. Existing image/archive pins are useful separate provenance, not something the hash loop independently validates.

## Security/artifact review

I found **no apparent real API credential, private key, authorization bearer value or owner harness memory in the retained evidence files** using targeted pattern scans plus selected raw-body inspection. The recorded relay header is the known dummy `probe-placeholder-only`. Prime's copied harness digest reports zero saved entries. Fixture system prompts, task text and tool results are intentionally retained as evidence. This is not an exhaustive secret audit of ignored artifacts or all inherited image contents.

Minor disclosure: all twelve retained `command.txt` files embed absolute host worktree paths under `/home/dev/`. That is unnecessary host-layout leakage and makes commands less portable. Prefer a documented checkout placeholder in published excerpts; if raw commands must remain byte-identical, acknowledge this limited disclosure. No credential was found in those paths.

The plugin socket is an unauthenticated command/context interface with default filesystem permissions, and native responses plus full request headers are logged. This is acceptable as a local fixture behind the recorded container boundary, **not a reviewed production security design**. A production bridge needs explicit socket access policy and redaction; arbitrary tool output and actual authorization headers could otherwise become retained artifacts. Do not copy this fixture's full logging policy into production.

## Acceptance recommendation

Accept the probe as runtime evidence for native steering and for choosing the OpenCode mechanism, with the limits above in the final report. Retain Prime's check-6 failure prominently. Do not describe this as six unconditional passes per agent, a true ACK-loss test, concurrent Prime tools, a universal final-answer-race proof, or compaction-proof instructions. A TaskHarness receipt should separate native acceptance, pending/native-context disposition, provider-request inclusion when observable, and unknown disposition. Any Prime production acceptance needs an atomic lifecycle/admission fence or a changed boundary, not a busy-state precheck.

## Follow-up review of the newly written main report

The main report now clearly discloses scripted compaction, serial Prime calls, bounded observation, replay without actual ACK loss, and Prime's outside-turn failure. Its proposed completion barrier and durable receipt/reconciliation work are explicitly **not implemented by the probe**. Those production limitations are appropriate. `model-requested` remains a diagnostic evidence state here, not an established production receipt capability.

I sent the following corrections to the parent; these line numbers refer to the first newly written version, not a later revision:

- Line 118: OpenCode mid ACK is `21:53:08.640`; `.637` is the native item creation time, not the driver's receipt time.
- Lines 372–373: Prime late ACK is `21:56:39.413`; raw stub request 2 is logged at `21:56:39.423`. The main document's `.414` / `.422` are not those raw timestamps.
- Line 331: Prime `native-history.json` contains a **`role:"compactionSummary"`** row with the marker, not a surviving original steering user row. In the next provider request it is rendered inside a digest user message. “Summary retains the marker” is supported; “native steering user row survives compaction” is not.
- Line 459: OpenCode's retained final run exercises **inserted-before-compaction**, not the separately mentioned scratch pending-compaction path. Do not assign a retained-evidence pass to both pathways without retaining that other evidence. Prime does exercise pending-before-first-compaction and inserted-before-second-compaction.
- Line 64: `exit-code.txt` records the launcher/container command's returned status, written by `run-local.py`, not the collector's own status. All retained statuses were zero; the collector requires zero but does not create that result.
- Line 183 and the promoted-retry pass: the saved native history is from **before** the third submission. Post-retry absence of a new enqueue event is useful supporting evidence, but the existing context snapshot must not be represented as a post-third-retry snapshot. A continuation test would strengthen the verifier.

No main-document changes were made by this reviewer. A same-model secondary review is useful error checking, not independent cross-model validation or stage acceptance.

## Final follow-up: strengthened OpenCode duplicate case

The author replaced the retained OpenCode duplicate case after the initial review. I read the updated raw result, model bodies, driver timeline, `after-retry-context.json` and revised main report. I did **not** run the verifier or any command/build/container; the author reports its verifier passes. All 159 updated manifest entries match on direct file hashing.

The new evidence resolves the promoted-retry black-box gap identified above:

- First ACP prompt ends at `22:04:42.497` with two primary requests total.
- After the promoted third submission, the one-second no-wake observation still records **two** requests at `22:04:45.523`.
- `after-retry-context.json`, taken after that submission and after the control prompt returns, contains exactly one native user row with `id:"msg_steer_unique_6539"`.
- A plain second ACP prompt starts at `22:04:45.527`. Primary request 3 starts at `22:04:45.666` and contains the steering marker exactly once. It is not in that ACP continuation's submitted text.
- ACP prompt 2 ends at `22:04:45.739`.

The native-ID retry therefore neither starts an unobserved successor nor produces a second steering row at the later model boundary in this run. The initial review's statement that the snapshot preceded retry describes the **superseded** retained case, not the final evidence. The initial verifier weakness is resolved for this case. Actual ACK loss, reconnect/restart recovery and crash durability remain untested.

The main report now uses the correct OpenCode ACK and Prime late timestamps. It distinguishes Prime's `compactionSummary` record / summary-bearing provider user content from a surviving original steering user row. It limits the retained OpenCode compaction claim to inserted-before-compaction, identifies the recorded exit status correctly, and distinguishes the promoted receipt's creation time from the pending receipt's creation time. These resolve the specific main-document corrections from the preceding pass. The production receipt limitations remain stated: the live event map is not durable reconciliation, and stub inclusion is not a production provider-delivery receipt.

**Final review recommendation unchanged:** the bounded OpenCode native-admission mechanism is supported, including the strengthened live-process retry case. Prime remains unsuitable for the required bare-bridge lifecycle contract because late native steer wakes execution outside the completed ACP prompt. Scripted compaction preservation, bounded observer windows, serial Prime tool execution and same-model review remain explicit limits. This is evidence review, not stage acceptance.

Final manifest refresh: after the author added the remaining retained metadata, I rechecked the manifest: **169 entries, zero mismatches**. The preceding count of 159 describes the intermediate refresh. This file was the only review edit.
