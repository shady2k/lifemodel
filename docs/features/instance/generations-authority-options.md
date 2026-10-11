# Generation candidate authority — worked options

Status: supporting source-only design proposal; no enforcement implemented or accepted.
Change: lifemodel-b0r-design. Task: lifemodel-b0r.8.1. Source baseline: 78a5dca.
Input: fresh `shady2k-gateway/glm-5.3-flash` report; coordinator rejected its watchdog-as-ceiling alternative. Raw report `/tmp/lifemodel-b0r-authority-options.md` is not an acceptance contract.

## Drivers and inventory

The initialized candidate must remain the same process at promotion. During rehearsal, primary service must continue; candidate must not write live data, signal primary, use external credentials/network, or exhaust primary resources. Dynamic import/activation is denied/deferred unless separately verified restricted. Grants follow exclusive verified release, not cooperative mute flags.

Current loader spawns one uid/gid child with allowlisted environment (`loader/src/supervisor.ts`); uid-scoped egress accepts named loopback services before external REJECT (`loader/src/egress.ts`). `DATA_PATH` chooses a destination, not authority. The root loader owns its record directory. Build tree ownership is granted to the child by `chownFreshTree`, not sealed (`loader/src/fs.ts`). Neither aggregate candidate cgroup control nor second slot exists. Historical executor observations in `lifemodel-653` are not current environment proof.

## Options and consequences

| Option / named pattern | Mechanism | Scenario result / consequence |
|---|---|---|
| A: distinct candidate identity + trusted grants + kernel bulkhead | Loader creates distinct unprivileged uid, restricted data/rehearsal ownership, sealed code, uid-keyed network denial, authenticated grant and non-escapable per-candidate cgroup v2 subtree. | Recommended direction **conditional on proof/owner deployment decision**. Full CPU/memory/pid tree ceilings, process authority and open-handle isolation must be proven. No launch authorized today. |
| B: same uid with Landlock mandatory filesystem confinement | Rejects the assumption that a second identity is required. Landlock alone cannot supply aggregate resource limits or primary signal denial; network ABI and policy unverified. | Rejected standalone under fixed requirements. It may add defense in depth only; this is not a claim that all possible same-uid security mechanisms are impossible. |
| C: uid-accounted watchdog / load shedding | Samples `/proc`, sums RSS/pids/CPU and kills offending identity. RSS is not cgroup accounting; churn and scheduler starvation allow overshoot before detection. | Rejected as hard aggregate ceiling or primary-service protection. No proven overshoot bound; cannot authorize staged launch before kernel enforcement. May be diagnostics/defense in depth after hard controls exist. |
| D: whole-container caps / rlimits only | Container caps share primary budget; most rlimits are per process, NPROC has uid semantics. | Rejected standalone; cannot discharge aggregate candidate contract. |

A must prove real/effective/saved credentials, capabilities, supplementary groups, no setuid escalation and inherited descriptors/socket authority, not just a numeric uid difference. The chosen unprivileged process cannot elevate itself; this is a **required policy**, not a universal POSIX credential immutability claim. Child environment is mutable, but never a trusted grant.

The loader changes **external** filesystem/network/broker policy after verified release; it does not rewrite the running child's spawn environment. Activation delivers an authenticated attempt/epoch/root/config payload to the same process, which closes its private graph and constructs fresh consumers. Existing sockets, descriptors, writable mappings, helper processes and in-flight broker requests are separate owners: chmod/chown/firewall edits do not retroactively close them. Deny capability inheritance and prove grant/revocation behavior. No trusted credential is delivered before authorization; removing its environment variable alone is not isolation. Pinned vault listener authorization remains unverified.

## Worked owner trade and invalidation gates

Hard aggregate enforcement needs writable delegated cgroup controls or another separately proven equivalent. The existing default container has not been shown to offer them. Recommendation: investigate a narrowly delegated trusted-loader cgroup subtree, preserving primary reservation and excluding child access to controls, **without** broad privileged-container or owner-socket access. Deployment permission/operability/security cost must be shown before owner approves any change. Alternative is retain current deployment and do not launch concurrent candidate rehearsal; it preserves present service but does not deliver the fixed outcome. Watchdog is not a third acceptance alternative.

Delegation grant must cover descendant containment, migration/escape denial, CPU throttling, memory and pid caps, primary reserved headroom, cleanup on failure and kernel/platform support. Numerical ceilings/health thresholds remain unset. A proposal fails if these cannot be enforced in the approved deployment. No new privileges, mounts, resource spend or runnable verification is authorized by this design.

At steady state A adds trusted identity/policy maintenance. At 10x descendants, aggregate controls must remain preventative rather than sampled. Crash/panic invalidates pending grants; uncertainty refuses activation. Security trade is a larger trusted control surface in exchange for isolated kernel accounting; operational cost is deployment compatibility and lifecycle cleanup, not an invented duration. Coordinate shared primitive ownership with `lifemodel-653`; do not implement or duplicate its executor system. `lifemodel-ww8` still owns vector persistence decisions.

## Proposed checks, not executed

Adversarial live file/mapping/FD write denial; primary-signal denial across credential/capability variants; all-network/proxy/bind/broker denial including inherited connections; sealed identity mismatch refusal; descendant/fork/escape CPU-memory-pid enforcement while primary completed-work service continues; cleanup and stale-attempt refusal on crash. Observing file mtimes or record order alone proves none of these. Each needs implementation and separately authorized runtime boundary. Source-only gate remains open.
