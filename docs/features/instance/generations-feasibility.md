# Candidate-first generations — source feasibility reconciliation

**Superseded 2026-10-11 (owner):** generations run as their own containers started by the loader, with state in Valkey and Postgres; the same-container candidate this document reasons about is not built. Kept as the record of that direction; see `docs/charters/instance-1.md`.

Status: supporting source-only research; not implemented or accepted capability.
Change: lifemodel-b0r-feasibility.
Kind: supporting docs-only research; task: lifemodel-b0r.3.3.
Stage: lifemodel-b0r.3. Base source: 30b9627. Planning [PR23](https://github.com/shady2k/lifemodel/pull/23) remains a separate unmerged proposal, not a prerequisite capability assumed by this report.

## Result

Current source does **not** enforce an initialized, powerless candidate beside the primary. Same-process activation on latest shared data remains an allowed design direction, but feasibility is conditional on unresolved containment and handle-release mechanisms. This report cannot authorize implementation or select a weaker acceptance contract.

Two fresh workers ran on `shady2k-gateway/glm-5.3-flash`. Their inspected findings and admission points are retained in [containment source](generations-containment-source.md) (lifemodel-b0r.3.1) and [lifecycle source](generations-lifecycle-source.md) (lifemodel-b0r.3.2). Coordinator source comparison removed initial overclaims about DATA_PATH isolation, resource limits, exit-code release proof and impossible/trivial graph rebuild. Source-only means no runtime enforcement or native release behavior was tested.

## Reconciled contracts

1. **Preparation and containment are separate.** Builds currently run in the uid-writable repo; entry existence and recorded commit are not immutable generation identity (`loader/src/repo.ts:255-289`). A sealed publication must remain root-owned/non-writable by the child, distinct from build staging. DATA_PATH changes destination, not filesystem authority. No candidate UID/ACL policy, per-candidate aggregate CPU/memory/process ceilings, or second supervisor slot exists. The current uid egress rule denies direct external connections but permits proxy/loader/resolver services; it does not prove candidate inactivity. A different uid is not covered by it (`loader/src/egress.ts:109-163`).
2. **An inactive initialized graph uses private rehearsal stores and restricted admission.** Creating the current container already creates/deletes logs, migrates/repairs files, starts flush/autosave timers, registers persistent schedules, recovers/prunes Motor work and downloads unfinished photo receipts (`src/core/container.ts:495-517,991-1004,1113-1117,1157-1205`). Omitting main's settings/channel/loop starts is not enough. Built-in activation admission is mapped in the lifecycle report; arbitrary dynamic imports/activation must be denied/deferred until exclusive release or verified restricted execution. Rehearsal must still initialize a graph; postponing all initialization until activation would miss the owner outcome.
3. **Release must be observable, exclusive and complete for the resources being transferred.** Existing stop is bounded best effort: intake, loop drain, state, channels, final deferred flush. Only loop waits have local deadline waits; other steps are covered by the overall referenced hard-exit timer (`src/core/container.ts:301-353`, `src/index.ts:198-228`). A process exit, stop log, empty deferred dirty count or tick count does not alone prove released native handles, continuations or external work. Unknown/failed release refuses admission. No durable generation release/attempt record exists today.
4. **Activate the same process, rebuild from current data.** Close the candidate's private rehearsal graph/handles before opening latest shared data, after verified primary release. Rebuild all consumers holding configuration, memory, registry, plugin and tool references; switching a path or one JSON graph object is insufficient. LanceVectorStore opens lazily but its wrapper has no close surface; pinned native release API is unverified. This is a proof gap, not a claim that rebuilding is impossible. Never restore historical snapshots over primary writes. Atomic JSON rename is per file, not a cross-store migration transaction.
5. **No candidate recovery against primary-owned external work.** Motor recovery may prune matching age-labelled containers and resume stored runs; generation ownership is absent. Risks are conditional on shared artifacts/Docker and simultaneous use, not observed incidents. Defer recovery until admission and design explicit artifact ownership; determine whether that alone meets ownership requirements before requiring an additional generation-label subsystem. Two stale inbound-log readers likewise must never both activate. Existing bounded dedup horizon is deliberate, not a newly diagnosed bug.

## Decision and proof gates before implementation

| Gate | What remains unsettled | Consequence |
|---|---|---|
| Containment mechanism | Same-process permission transition that denies live writes, signaling the primary and unauthorized proxy use during rehearsal; pinned vault listener auth; dynamic plugin policy | No candidate launch authorization. DATA_PATH/env removal alone is insufficient. Same-uid signaling risk is not silently accepted. |
| Candidate resource ceilings | Required aggregate semantics and enforcing mechanism compatible with approved deployment; numerical ceilings remain unset | No launch until mechanism and owner ceilings agreed. Landlock is filesystem-only; rlimits and whole-container caps do not establish aggregate per-candidate isolation. Recorded 653 environment evidence is historical, not current proof. No new VM/privileges/resources assumed. |
| Native/lifetime release | Pinned LanceDB/ONNX/logger APIs, plugin continuations, Motor ownership and complete same-process consumer rebuild | No activation if release is uncertain. Source reading can narrow APIs; any runnable probe requires separate authorization. |
| Durable ownership and migration | Attempt/epoch/release record, crash semantics, sealed publication and reversible consistent current-data migration | No stale candidate admission or migration restore over live writes. Placement/transaction protocol needs reviewed design. |
| Operational health | Completed-work definition, health window and failure threshold | Constants unset; uptime/spawn/tick starts are not success. |
| Acceptance execution | Expanded native heavy-CI scenarios and resource budget | Existing 19-case fixture and sole final S6 daemon restart unchanged. No local heavy walk and no CI expansion authorized. |

`lifemodel-653` remains the task-executor containment track; no implemented enforcement is borrowed from its open charter. `lifemodel-ww8` remains the vector storage ownership exception. This report does not resolve either or invent competing ownership.

## Session slices and order — recommendations, not dispatched tasks

The source reports were each one worker session. Later implementation stages remain coarse. These are bounded deliverables to refine after the proof/decision gates, not new commitments or invented forecasts:

| Slice | One-session deliverable and check boundary | Prerequisites |
|---|---|---|
| P1 containment decision | Source-backed mechanism/permission-transition and resource semantics; explicit unsupported requirements and owner decision | Containment/resource gates, coordinated with 653; no probes unless separately authorized |
| P2 lifetime API evidence | Pinned dependency source/API audit and awaited lifetime inventory; close/rebuild acceptance scenarios | Native source availability; runtime proof permission if needed |
| I1 sealed publication | Root-owned selected-code identity distinct from mutable staging; adversarial mutable-tree scenario | P1, reviewed publication design |
| I2 rehearsal admission | Private graph plus explicit admission for every constructor writer, plugin continuation and external action | P1/P2; lifecycle table; no weaker delayed-only initialization |
| I3 complete release/rebuild | Awaited private graph cleanup and all-consumer rebuild from latest shared stores; timeout/uncertainty refusal | P2/I2; storage ownership decision with ww8 |
| I4 candidate supervision | Separate candidate slot, durable attempts/epochs/panic arbitration and exclusive activity grant to the same process | I1/I2/I3; reviewed record protocol |
| I5 operational fallback/migration | Completed-work health and current-data reversible fallback/boot | I4; approved health constants and migration design; decompose further before dispatch |
| A1 assembled acceptance | Exact criteria on assembled revision, existing regressions plus approved scenarios | All above and explicit native-CI permission; independent review |

No blanket “one session” claim is made for unresolved implementation. I2/I3/I4 must be split if reviewed design cannot fit a worker session. Actual tracked leaves and prerequisite edges are added only at authorized decomposition; b0r.4–.7 are not ready merely because this research exists. Owner-required later implementation model remains `shady2k-gateway/glm-5.3-flash`; model selection is not authorization.

## Verification and limits

Source citations were compared in the coordinator checkout at 30b9627; integrated reports are committed under their own leaf tasks in the same stage checkout. Guarded .3.3 claim accepted those implemented report revisions; no early closure or dependency removal. Product-document/backlog/present checks apply. Product suite, mutation and runtime walks are N/A for supporting source research. Automatic document-transition gate is not installed; it is not claimed as run. Fresh different-model [review](generations-feasibility-review.md) initially blocked two weaker acceptance alternatives; targeted corrections removed them and the same reviewer cleared the source-only review. Independent approval is of these research documents only. Final publication evidence is recorded on the tracked stage. Acceptance and owner merge remain pending; a green research PR does not establish operational capability.
