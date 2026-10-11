# Generation candidate design — proposed decision and owner trade

**Superseded 2026-10-11 (owner):** generations run as their own containers started by the loader, with state in Valkey and Postgres; the same-container candidate this document reasons about is not built. Kept as the record of that direction; see `docs/charters/instance-1.md`.

Status: supporting source-only design; decision-pending, not capability acceptance.
Change: lifemodel-b0r-design. Task: lifemodel-b0r.8.3. Stage: lifemodel-b0r.8.
Source baseline: 78a5dca. Planning/research PR23/24 merged; bookkeeping PR25 merged. Present behavior unchanged.

## Fixed drivers

The candidate initializes privately while primary serves, then **the same process** closes its private graph and rebuilds every consumer on **latest shared data**, after verified exclusive primary release. No historical restore, two-owner window or zero-downtime promise. Candidate cannot write/signal/use unauthorized network or starve primary. Numeric health/resource constants unset. Current source has not enforced these guarantees.

## Options considered and proposed direction

[Authority options](generations-authority-options.md): distinct unprivileged candidate identity plus trusted external grants and preventative aggregate kernel bulkhead is the recommended conditional direction. Same-uid Landlock alone, sampled watchdog, whole-container caps and rlimits alone fail requirements and are rejected acceptance alternatives. Identity alone does not prove capability/FD/network denial. No weakened launch permitted while enforcement unavailable.

[Handoff options](generations-handoff-options.md): explicit lifetime ownership, observed/fenced release and whole-container fresh construction in the same PID; loader-owned authenticated fencing record; validated shadow migration of latest quiesced state with a single synced authoritative pointer. Native pinned close/dispose APIs exist but app surfaces and actual release proof do not. Child intent markers/exit codes are not release evidence. Current atomic helper lacks fsync; durable protocol is proposed work. New-process activation rejected by fixed owner direction. In-place cross-store journal not selected without a complete equivalent recovery argument.

This is a proposal, not an accepted ADR or an implementation instruction. The hard-to-reverse runtime/deployment trade remains owner-held. Supporting docs record choices without changing the current product spec or resolving 653/ww8 ownership.

## Runtime view (proposed)

Trusted loader record/policy owner → two separate process slots (primary + confined candidate).
Candidate private graph → verified private release → authenticated root/config grant → fresh current-data graph in SAME PID.
Primary all-owner release → stable latest root → restricted staged migration → synced root publication → candidate activity grant.
Every stale epoch, failed sync, unknown owner or uncertain native release → refusal/maintenance, never presumed grant.
After publication, latest published root is authority even on failed activation; fallback generation transforms THAT root, never retained historical data.

## Owner decision: enforcement versus deployment constraints

Recommendation: pursue narrowly delegated cgroup control for the trusted loader, if approved deployment can provide non-escapable CPU/memory/pid subtree controls and preserve primary headroom. Do not grant blanket privilege or owner Docker socket. Before a deployment choice, identify exact necessary delegation/mount/control ownership and supported host behavior; source-only evidence has not established availability.

Alternative: keep current deployment permissions and do not launch a concurrent initialized candidate. That preserves current service but does not satisfy the desired generation outcome. Watchdog-first is not an acceptable intermediate implementation.

Trade: stronger preventive resource isolation costs trusted-loader/kernel-policy surface and deployment compatibility. Selected filesystem ownership/ACL layout and migration staging also cost handoff latency/storage; at 10x data/descendants these are explicit capacity gates, not assumptions. Owner numerical budgets and retention policy remain separate. No implementation estimate until mechanism/proof scopes are bounded.

**Next bounded action recommended:** authorize a separately scoped environment/native release proof plan only after exact runtime mechanism and safe boundary are reviewed. This document does not authorize executable proof, privilege/resource changes or CI expansion. If the mechanism cannot work without disallowed deployment changes, return worked alternatives to owner; never lower containment.

## Planned acceptance checks / evidence boundary

- Positive same-PID promotion with complete current-data consumer reload; negative stale grant/identity/format refusal.
- Adversarial live write/signal/proxy/socket/FD/mapping denial and aggregate fork/CPU/memory pressure with primary completed work preserved.
- All native/async/plugin/settings/Motor/transport owners release; any unknown/pending operation refuses.
- Crash/failure injection around every staging, sync and publication phase, including postpublication failed activation and latest-data down-migration fallback.
- 10x current data and descendants respect owner capacity/ceilings; sealed code mismatch, escape and broker forgery refuse.

These are proposed future scenarios, not executed tests. Record order, flags, mtimes and exit codes cannot substitute. Source checks apply now; product/mutation/native suites and heavy CI remain unrun/N/A for this documents-only deliverable. Automatic transition document gate absent. Fresh different-model review records blockers and their targeted disposition separately. Implementation .4–.7 remains coarse/unstarted; .8 does not assert those stages ready.

## Run limitations

Two fresh exact `shady2k-gateway/glm-5.3-flash` workers produced raw reports. Coordinator rejected weaker cap/durability/path claims; corrected retained contracts are the result, not raw proposals. Fresh `openai-codex/gpt-6-sol` reviewer independently found the same blocking categories. The 10:30Z promise was missed during idle fan-in; tracker records that, no new ETA invented. Authority malformed claim prefix was inert and exact body reposted; handoff first wrong-session claim voided, late corrected claim omits earlier interval. That earlier time is uncounted, not fabricated. No operational proof, product changes or constants.
