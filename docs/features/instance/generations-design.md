# Candidate-first generation rollout — proposed change

**Superseded 2026-10-11 (owner):** generations run as their own containers started by the loader, with state in Valkey and Postgres; the same-container candidate this document reasons about is not built. Kept as the record of that direction; see `docs/charters/instance-1.md`.

Status: Proposed behavioral contract and coarse implementation stages; not implemented or accepted capability documentation.
Planning is a supporting docs-only change. Source-only feasibility must settle the architecture before implementation. No product requirements or present-capability documents are changed.
Change: lifemodel-b0r-planning.
Kind: supporting docs-only planning; leaf task: lifemodel-b0r.2.
Tracked outcome: lifemodel-b0r; planning: lifemodel-b0r.2.
Serves instance-1 outcome 5. Accepted loader behavior remains unchanged until stage acceptance.

## Problem
The loader currently restarts mutable instance code in place. It cannot first validate a new generation while the primary works, distinguish initialized readiness from operational health, or safely select an older generation against current data.

## Solution
The owner selects a code generation through the existing loader interface. The loader prepares and initializes one inactive candidate while the primary remains active. It then drains and releases the primary and activates that SAME candidate against the latest data. A generation that fails its operational health window falls back to the last healthy compatible generation, or enters maintenance if safe activation cannot be established.

## Stories
- The owner tries new code without interrupting a healthy primary during preparation.
- A rejected candidate never polls Telegram, sends, runs schedules, cognition, plugins with side effects, or Motor Cortex work.
- The owner sees preparation, handoff, health, fallback and refusal reasons through the loader.
- After activation and new writes, fallback preserves those writes rather than restoring an old snapshot.
- In maintenance the owner can select a retained generation; unsupported data formats refuse without changing live data.

## Decisions
Owner-retained: candidate-first; current shared data; same initialized process promoted; no promise of zero downtime; Kubernetes and independently deployable modules deferred.

Proposed contracts (engineering choices pending source reconciliation):
- B0R-R01: numbered code-only generations have a verified build identity. Mutable work cannot rewrite a selected generation or loader authority.
- B0R-R02: initialization is split from acquisition of live data and activity authority. Inactive readiness proves local initialization only; it cannot claim live external-service health.
- B0R-R03: old intake stops, in-flight turn and sends drain, storage flushes, and exclusive storage/activity ownership is released before the candidate opens current stores. The existing stop remains a bounded best-effort drain: deadline expiry or flush/release uncertainty prohibits activation, rather than establishing quiescence. A readiness rehearsal never supplies promoted production data.
- B0R-R04: activation and stop/panic requests are serialized under loader authority and durable recovery state. A stale candidate cannot activate after stop_epoch changes. Exit 75 preserves same-generation restart semantics, not automatic generation approval.
- B0R-R05: operational health requires completed internal work after activation, not PID existence, spawn success, an HTTP 200 or a pre-completion tick counter. External model/key/network failures are classified separately and do not condemn code by themselves.
- B0R-R06: failed operational health triggers one safe fallback to a previous healthy generation against CURRENT data. Consecutive failed generations enter maintenance; panic overrides all automatic starts. Attempts and reasons survive loader restart.
- B0R-R07: expanding formats are preferred. Breaking changes carry versioned up/down migrations; down belongs to the generation being left. Unknown newer formats refuse. Migration operates on a separate copy of latest quiesced state, checked before durable publication. A failed migration leaves live data unchanged. Historical snapshots are never restored over later writes.
- B0R-R08: migration publication has one durable authority and recoverable phases. JSON, configuration and LanceDB must have a defined consistent boundary; ordinary recursive copying of live stores is not one. Migration confinement and crash-safe filesystem publication require proof before implementation acceptance.
- B0R-R09: the existing authenticated loader interface exposes generations, health, migration/refusal and maintenance boot. No second control interface. Diagnostics identify request/attempt/generation and phase without keys or user content.

Health-window length, failure threshold and candidate resource ceiling are NOT silently chosen here. Existing stop deadline remains one bounded deadline; this proposal changes no constants.

## Checks
Proposed acceptance seams: existing authenticated loader requests/status, native runtime activity observations, persisted generation/data authority and fixture Bot/model requests. Checks use made-up keys and synthetic messages, never owner data.

- B0R-C01: primary serves during preparation; rejected candidate produces no external activity or live writes.
- B0R-C02: same candidate identity activates only after observed primary settlement; messages arriving around handoff retain durable inbound semantics and known crash-window qualifications.
- B0R-C03: stale handoff, panic, stop, exit75 and loader crash cannot admit a second active writer; uncertainty is reported, not converted to success.
- B0R-C04: healthy activation completes the window; internally broken generation falls back once with a report; external-only failures do not incorrectly condemn it.
- B0R-C05: maintenance boots a retained compatible generation and refuses unknown formats.
- B0R-C06: up/down round trip preserves current synthetic state including writes since activation; migration failure/crash never publishes a partial copy or replaces current data with rehearsal state.
- B0R-C07: native acceptance preserves all 19 existing first-start cases, capability/Mounts/journal/ownership proofs, additions before final S6 and its sole daemon restart. Expanded heavy-CI permission is still outstanding: proposed additions are NOT authorized to run yet.

Coverage: R01–R02 → C01; R03 → C02–C03; R04 → C03; R05–R06 → C04–C05; R07–R08 → C05–C06; R09 → C04–C05; C07 preserves the accepted loader regression envelope. These are planned checks, not executed evidence.

Each negative case pairs with an ordinary successful path. Failures print the violated invariant and retained fixture authority/phase; identity or cleanup uncertainty retains owned evidence. Unit checks support, not replace, native acceptance. Stage review and hand-planted mutations follow existing policy.

## Stages — proposed
1. Establish candidate containment and lifecycle feasibility. Produce an evidence-backed launch/release contract using current deployment primitives, identify what cannot be enforced, and size implementation slices. No executable prototype or privilege expansion is included. DONE WHEN: an independent reviewer can trace every candidate authority/resource restriction and every graph release/rebuild obligation to a current primitive or an explicitly unresolved gap; the plan never treats same-UID separation as isolation.
2. Prepare sealed generations and initialize a powerless second instance. DONE WHEN: through existing loader actions/status, the primary continues serving while an actual candidate initializes private synthetic data; rejected/cancelled candidates cannot affect live storage or external activity. Implementation leaves are sized only after stage 1 acceptance.
3. Transfer exclusive activity and current shared storage to the same candidate. DONE WHEN: observed primary drain/release precedes candidate opening current stores and acquiring activity authority; process identity survives; panic, stale epochs, crashes and uncertain release cannot admit two writers.
4. Observe operational health, fall back safely and expose maintenance boot. DONE WHEN: completed internal work establishes health; code failure falls back against current compatible data with a report; external-only failures do not condemn code; persistent panic and no-safe-fallback maintenance refuse automatic activation.
5. Add reversible breaking migrations and assemble native acceptance. DONE WHEN: latest quiesced data migrates in isolated staging, failed publication preserves live authority, down uses current data rather than a historical snapshot, and the owner boots an older generation through maintenance. Reuse acceptance leaf lifemodel-b0r.1 for the assembled outcome. Expanded native scenarios remain blocked on explicit CI-scope approval.

Only stage 1 (lifemodel-b0r.3) receives session-sized tasks now:
- lifemodel-b0r.3.1: Map candidate launch containment to existing deployment primitives, including CPU/memory/process ceilings and filesystem/process/network authority. Source evidence must either support a concrete design or name an unenforceable restriction; no runtime probe is authorized by this task.
- lifemodel-b0r.3.2: Define the inactive initialization, graph release/rebuild and current-storage activation contract against actual initialization/restore/action seams. Every writer and external side effect has an explicit admission point; unknown release prevents activation.
- lifemodel-b0r.3.3: Reconcile the two reports into implementable session slices, an honest cost range and acceptance scope. Name any required prototype/resource approval rather than assuming it. Stage acceptance includes independent review and normal planning/document checks.

The first two tasks may run in parallel in separate source-only reports. Their reconciliation task waits for both. Later stages remain coarse; the coordinator decomposes them when feasible, adding only real result/conflict dependencies between leaves. No staged copy is used for compatible handoff. Latest-state staging and data-root publication belong only to breaking migrations.

## Source reconciliation
Baseline inspected: main 30b9627. These are present-source observations, not proof of the proposed design:

- The supervisor owns one child. OS spawn confirmation marks it running; uptime resets crash backoff. Neither establishes initialized readiness or completed-work health. Exit 75 restarts the configured entry; stop invalidates in-memory restart epochs and panic blocks starts. A generation-aware durable attempt/stop authority does not exist yet.
- Process launch selects uid/gid and an environment, not a distinct candidate filesystem, process or network boundary. The current uid-based egress rule intentionally permits the credential proxy. Reusing that identity for a candidate is not powerless containment. Sealed code and resource admission need source feasibility evidence.
- Container construction already starts deferred auto-flush, loads plugins, restores state and inbound messages, flushes storage, and starts auto-save. Delaying CoreLoop start alone cannot define inactive readiness. Admission must cover constructor-time actions, settings writes, plugin initialization and restore/replay as well as the active loop.
- The current stop drains intake/loop/sends, persists registries, releases channels, closes durable loop writes and flushes DeferredStorage last. It is bounded best effort, not a complete reusable graph-release API. Plugin, Motor Cortex and native memory handle release still need explicit reconciliation; an uncertain stop cannot authorize candidate activation.
- LanceDB opens lazily and owns its own files outside DeferredStorage. Its current wrapper has no explicit close method. JSON atomic save is a per-file publication boundary, not a transaction across JSON, config and LanceDB. Closing rehearsal handles and rebuilding the graph in the candidate therefore remain implementation obligations, not available lifecycle guarantees.
- CoreLoop increments its tick counter before work; its completed-tick log is a more relevant observation, but a loader-facing completed-work health contract and external-failure classification are not implemented.
- The first-start fixture contains 19 cases. Its final S6 case alone performs the authorized daemon restart; endpoint-dependent journeys precede it. The PR-only image job has a 45-minute bound, synthetic credentials, credential-less checkout and at most 2 workers. This planning change neither edits that fixture nor authorizes additional scenarios.

Source comparison for planning reads `the former instance supervisor`, `loader/src/exec.ts`, `loader/src/app.ts`, `the former instance egress integration`, `src/core/container.ts`, `src/core/core-loop.ts`, `src/storage/deferred-storage.ts`, `src/storage/json-storage.ts`, `the former LanceDB vector-store wrapper`, `.github/workflows/ci.yml` and `the removed Docker instance first-start fixture`. Stage 1 must still produce complete containment and lifecycle reports rather than treating these observations as its accepted result.

Same-process graph reconstruction is allowed after closing rehearsal handles; replacing open LanceDB files is not. The original 6–12 agent-hour draft and consultation 26–45 day total are both withdrawn as usable forecasts. The latter included unnecessary ordinary-switch copying and multi-day packages mislabeled as session tasks. No implementation budget is established before feasibility acceptance. Planning does not update accepted loader behavior or declare candidate isolation implemented.

## Planning verification
Independent source review by a fresh `openai-codex/gpt-6-sol` session approved this as a docs-only feasibility plan, not capability acceptance, with no blocking finding. It verified the source gaps above and the 19-case/S6 description. Its stop-drain precision comment is reflected in R03: timeout never establishes quiescence.

Backlog and product-document form checks apply to this supporting change. Present-document checks compare the planning branch with main. Product suite, runtime walk and mutations are not applicable: no executable logic or present behavior changes. The automatic document-transition gate is not installed and did not run. Planning publication does not accept the implementation stages.

## Open decisions and risks
- Explicit approval for expanded native heavy-CI scenarios on the existing disposable CI host, within 45 minutes / max 2 workers and unchanged security boundaries.
- Resource/cost forecast awaits reconciled stage sizing; earlier 6–12 agent-hours is superseded, not a commitment.
- Storage migration consistency, confinement and atomic publication are design proof obligations, not presumed capabilities. No new VM/controller/storage service is authorized.
- Shared-data activity isolation must be enforced, not a best-effort mute flag. Same-process activation needs a lifecycle refactor; current constructor initialization cannot simply be treated as inactive readiness.

## Out
Task executor changes, self-change initiation, modular/Kubernetes deployment, zero-downtime guarantee, new owner-host test execution, new VM/DinD/controller, rollback of user history, general live-store delta merge, and deferred document-transition gate lifemodel-bqc.

## DONE WHEN
Through the existing loader interface, a never-healthy generation is safely replaced without owner intervention by the previous healthy one with a report; maintenance boots a retained older generation against CURRENT data, including reversible breaking-format migration. Native checks prove candidate-first same-process activation, exclusive authority, panic/crash refusal and current-data preservation under the explicitly approved acceptance scope. Current docs are updated only after accepted implementation.
