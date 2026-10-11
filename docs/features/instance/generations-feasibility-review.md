# Generation feasibility — independent source review

**Superseded 2026-10-11 (owner):** generations run as their own containers started by the loader, with state in Valkey and Postgres; the same-container candidate this document reasons about is not built. Kept as the record of that direction; see `docs/charters/instance-1.md`.

Status: supporting source-only review, not product acceptance.
Change: lifemodel-b0r-feasibility-review.
Kind: supporting docs-only review; task: lifemodel-b0r.3.3.
Reviewer: fresh `openai-codex/gpt-6-sol` session, different from source workers (`shady2k-gateway/glm-5.3-flash`). Baseline source `30b9627`; integrated source support reports through `45036cb` plus reconciliation draft `generations-feasibility.md`.

**BLOCK** the integrated stage review as written. This is a review of source-only research against baseline `30b9627`, not product acceptance or a demand for probes. The central reconciliation correctly keeps PR23 unmerged, leaves implementation and native checks unauthorized, requires same-process fresh-data rebuild after exclusive release, and names the absent native-release, candidate-ceiling and credential mechanisms. Two acceptance-facing alternatives in a supporting report nevertheless contradict the stage's non-weakened containment requirement.

## Blocking findings

1. **A same-UID candidate's ability to terminate the primary is offered as an approvable option.** `generations-containment-source.md`, §B “Process separation primary vs candidate” says same-UID signal rights “must be either accepted (owner approval) or avoided by a different uid”; §C.3 repeats this. The primary must keep serving while candidate preparation proceeds (PR23, “Solution” and C01). At baseline, privileged spawn selects the child uid/gid (`loader/src/supervisor.ts:168-172`), and there is only one process slot; a second process with the same uid could signal the first. Approval of that risk alone cannot establish the asserted containment or continued-primary-service check, even if DATA_PATH differs. Make this an explicit unsatisfied requirement until an enforcing process-authority boundary is selected/proven; do not present mere risk acceptance as the stage-to-implementation pass condition. `generations-feasibility.md`, “Decision and proof gates / Containment mechanism,” already requires *denying* primary signaling, so harmonize the support report with that gate.

2. **A whole-container cap is presented as a selectable candidate ceiling despite explicitly failing the required semantics.** `generations-containment-source.md`, §B “CPU/memory/process ceiling per candidate” correctly states that rlimits are not aggregate per-candidate controls and whole-container caps let a candidate starve the primary within the cap; but §D.3 presents “acceptance of container-level-only caps” among the honest options, as a “weak stopgap.” `generations-feasibility.md`, “Decision and proof gates / Candidate resource ceilings,” correctly says no launch until an enforcing mechanism and owner ceilings are agreed. Remove the acceptance option as a way to discharge that gate. It may be named as *rejected/inadequate*, not as a proposed weaker acceptance contract. The present source has only uid/gid/env spawn (`loader/src/supervisor.ts:168-172`) and Motor-specific container caps, not a candidate aggregate budget.

## Nonblocking source precision before publication

- `generations-lifecycle-source.md`, §5.2(f), says “plugins carry no timers at stop because their timers route through the loop's scheduler tick.” This is true only of built-in scheduled activity, not arbitrary dynamic plugins: the same report's §3b correctly identifies dynamic import/activate as arbitrary timer/network authorities, and source invokes plugin activation at `src/core/plugin-loader.ts:415` from `src/core/container.ts:991-1004`, without calling deactivate from `shutdownSequence` (`src/core/container.ts:301-353`). Qualify §5.2(f) as built-ins only. The reconciled admission gate correctly denies/defer dynamic imports until verified isolation or exclusive release, so this is a local overclaim rather than an additional independent failure of the integrated gate.
- `generations-lifecycle-source.md`, §3 row 13 calls the built-ins “all 11” while §3b enumerates twelve (seven neurons, two web tools, news, reminder, calories); correct the count. The audit itself covers twelve.

After the two blocking options are removed as acceptance alternatives, the remaining source-only limitations can remain named design/proof gates. I did not run probes, tests, or create resources; no source/docs/tracker files were edited.

## Disposition after targeted corrections (same review; 2026-10-11)

**Original BLOCK cleared for this source-only stage review.** I re-read only the corrected passages against the original findings; this is not product acceptance or a new review of implementation.

- Finding 1: `generations-containment-source.md` §B process-separation row and §C.3 now say same-UID signaling leaves primary service unprotected and cannot be accepted as enforcement. §D.2 continues to require a real authority decision. **Resolved.**
- Finding 2: §B ceiling row and §D.3 now reject rlimits alone and whole-container-only caps as aggregate per-candidate ceiling alternatives, and require an enforcing mechanism before launch. **Resolved.**
- Related credential precision: §B credential row now requires evidence of Agent Vault listener authorization before candidate admission and explicitly rejects approval without enforcement evidence. **Confirmed.**
- Nonblocking precision: `generations-lifecycle-source.md` §3 row 13 now says 12 built-ins, consistent with §3b; §5.2(f) limits the scheduler/timer observation to built-ins and explicitly excludes arbitrary dynamic plugin timers. **Resolved.**

The reports remain source-only; they identify unresolved gates, not operational capability. No probes, tests, resources, or repository edits were made in this targeted verification.
