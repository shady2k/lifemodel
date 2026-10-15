# Independent architecture review — ADR-010 container generations

Task: lifemodel-b0r.9.3. One review round of the proposed ADR-010 and its design
views. Method: scenario walk in the ATAM manner, with STRIDE prompts for the
security boundaries. This is a review, not an alternative design.

## Scope and evidence

The fixed inputs are `docs/charters/instance-1.md:30-51` and outcomes 4 and 5
(`:69-90`). No finding rejects the loader-only Docker topology, generation
containers, Valkey snapshot/bus, Postgres/pgvector, OpenBao, the tick boundary,
greenfield start, or the separately designed web channel. Findings concern whether
the proposed mechanisms can meet those inputs.

Read: ADR-010, `containers-design.md`, `containers-inventory.md`, the charter,
and the cited loader, core, storage, image/front-door and first-start fixture
sources. Three independent read-only lanes cross-checked security, state and
switch behavior; their load-bearing citations were checked here. Existing code is
evidence of the carried contract and conversion work, not a demand that this
proposed architecture already be implemented.

No runtime probes, Docker, npm or product tests ran. The automatic transition
document gate did not run. External engine behavior, resource use and startup
latency remain unverified; neither assumptions nor unchecked fixture candidates
are acceptance evidence. Evidence references below are repository paths and line
ranges at the reviewed checkout.

Severity: **BLOCKING** means an F*/Q* scenario fails as written, or a stated claim
is false. **COMMENT** records a sensitivity, trade-off or unresolved validation
risk without asserting such a failure.

## Scenario walk

This table walks every inventory requirement and scenario. “Supported” means the
written mechanism addresses the scenario; it is not a runtime PASS.

### Functional requirements F1–F7

| Requirement | Walk and result |
|---|---|
| F1 — candidate beside running generation | Supported by sealed per-commit trees and separate containers (ADR O1-A; views planned-switch sequence). Docker bootstrap still needs C02 validation. |
| F2 — ready before epoch switch | The 5 s probe / 60 s window is named and orders readiness before the bump. Readiness state is provisional, but activation does not replace it with the final snapshot (B02). |
| F3 — current conversation, no loss/double answer | Blocked by stale hydrated state (B02), incomplete effect/idempotency protocol (B03–B04), and unavailable pause intake (B07). Atomic Valkey offsets alone do not prove this contract. |
| F4 — unhealthy candidate replaced automatically, with report | The one-fallback policy addresses the normal case. Downgrade execution and crash-safe transition/report ownership do not (B05–B06); rollback drain ordering is inconsistent (B02). |
| F5 — maintenance boot of older generation | Same authenticated UI and current-data policy are appropriate. Converter ownership and outstanding newer event formats block the older boot (B05). |
| F6 — reversible breaking migrations | Per-store versions and refusal are useful, but cannot implement the written older-code DOWN path or recover a partially converted multi-store transition (B05). |
| F7 — re-walk outcome 4 | Model keys behind the proxy and persistent panic are retained requirements, not new findings. The one-command authority path needs C02 validation; recovery and credentials need B01/C01 and the extended first-start walk. |

### Quality scenarios Q1–Q13

| Scenario | Sensitivity point | Trade-off and residual risk / result |
|---|---|---|
| Q1 — planned switch | Final-snapshot rehydration, durable intake, 90 s drain / 110 s stop | Bounded pause trades availability for finishing paid work. B02/B03/B07 break the message guarantee; migration/activation time is not covered by the stop budget (B06). |
| Q2 — never ready | Effects suppressed before authority; 12 probe intervals over 60 s | Supported normal failure path: no epoch bump and N continues. Startup must not mutate shared PG/plugin/schedule state during its dry tick (B04). |
| Q3 — ready but unhealthy | Completed commits plus signal outcomes; one fallback; durable report | Avoiding retry churn trades automatic availability for maintenance. B02/B05/B06 block the rollback proof; C01 covers crash reconciliation. A health-window duration is not a bound on completed rollback. |
| Q4 — generation crash | Snapshot/outbox commit and receiver effect acknowledgement | Per-tick commit limits uncommitted tick work, not the lifespan of a cognition turn. B03/B04 show committed effects can be repeated or lost; B02 affects switch recovery. |
| Q5 — loader crash | Reconciliation of epoch, container identity, activation, routes, migrations, panic | Re-adoption avoids killing healthy work but requires durable transition intent. C01 identifies the mid-switch gap; labels alone are not a switch transaction. |
| Q6 — Valkey restart | One non-HA store, AOF persistence of epoch and transaction, durable acknowledgement | Fsync-always exchanges latency for durability. Single-store serialization can fence concurrent compliant CAS calls, including after restart, if epoch and full transaction persist together. Engine acknowledgement/rewrite/restart behavior and visible downtime remain to verify (C02); B01 still permits unguarded writes. |
| Q7 — stale generation | Actual mutation privileges, not a cooperative epoch watch | CAS is a sound comparison for callers that use it, but raw bus/script authority bypasses it (B01). PG operations need their own active-generation/effect protocol (B04). Revocation is defense in depth, not proof for a live connection. |
| Q8 — credentials | Scoped store leases, per-generation proxy token, proxy-only listener exposure | TTL bounds exposure but renewal and revocation must survive loader/engine restarts (C01). Auto-unseal exchanges secrecy for unattended recovery. Model-key absence must be re-walked from each generation; private-network API exposure is not equivalent to loopback (security walk below, C02). |
| Q9 — Docker confinement | No socket/CLI/DOCKER_HOST in generations; constrained broker requests | The proposed generation boundary meets the direct-path measure. The trusted loader remains daemon-root authority; an endpoint proxy does not change that by itself (B08). A broker must not delegate arbitrary Docker specifications. |
| Q10 — UI/report operations | One durable switch identity and same-login maintenance | Supported UI direction, but a crash between bump and record can omit/duplicate a report (C01). Reports must include refused writes and migration/lease failures, not only the final verdict. |
| Q11 — shared-machine resources | Peak overlap, retained releases, stream/ring retention, fsync write rate | Sealed trees buy isolation with disk cost; stores and a candidate buy recoverability with RAM cost. No measured margin exists (C02). Two failures to maintenance bounds retry churn, not build overlap or accumulated volumes/streams. |
| Q12 — build/start duration | 20 min isolated build, seal/publish, container start/readiness | The build budget is cited correctly. 60 s readiness covers probes after start, not the full publish/start path. Measured startup and failure-cleanup costs remain open (C02). |
| Q13 — tick-only async boundary | Every cross-tick writer becomes durable event/state; stop obeys same boundary | Bus result and post-commit command directions are appropriate. B03/B04 require the tick boundary to include effect settlement and PG changes, not callback saves. The inventory's delayed `SCHEDULE_EVENT` timers also need a durable representation; the events table does not name that conversion explicitly (C02). |

## Findings — fencing and handoff

### B01 — BLOCKING: generation privileges bypass the Valkey fence

- **Scenarios:** Q7 (zero stale bus/snapshot writes); Q8 (compromised generation).
- **Evidence:** `docs/adr/010-container-generations.md:157-158,204,224-228`;
  `docs/features/instance/containers-design.md:130-133,166-170,221-225`.
- **What fails:** the epoch comparison guards the chosen Lua call, not all mutation
  authority. O2-B explicitly grants a generation bus `XADD`. After the bump and
  before revocation, N can use its live connection to append directly, without
  comparing epochs. The bus position changes although Q7 requires it unchanged.
  More generally, Valkey command/key ACLs do not restrict `EVAL`/`EVALSHA` to one
  trusted script: granting the commands/keys the script mutates also allows those
  mutations through another script or directly. “No epoch writes” protects the
  epoch key, not the snapshot and bus from bypass. Killing or disabling connection
  authority later does not repair the accepted stale write.
- **Resolution direction:** define an enforceable mutation boundary that permits
  only the trusted epoch-checked operation for generation-owned bus/snapshot
  changes. Separate external ingress/actuator authority from generation authority.
  Show a stale live connection cannot mutate any guarded key, including with raw
  commands or arbitrary scripts. Keep CAS and revocation, but prove their actual
  permissions rather than assuming script-only ACL capability.

### B02 — BLOCKING: the snapshot handoff and rollback ordering disagree

- **Scenarios:** F2/F3, Q1/Q4; Q3 rollback; stated fencing claim.
- **Evidence:** `docs/features/instance/containers-design.md:120,125-132,146-152,
  166-168,189-195`; `docs/charters/instance-1.md:42-44,82-84`.
- **What fails:** C hydrates snapshot S0 at readiness while N still serves. N then
  finishes an answer and commits S1, including its inbound outcome. The views'
  activation step verifies the epoch and optionally migrates, but does not require
  discarding readiness state and re-hydrating S1 in a SAME-FORMAT rollout.
  ADR O8-A (`:211`) does mention reading/converting the snapshot for an UP; that
  does not explicitly cover normal activation when no migration is required.
  Retaining the described readiness state lets C commit S0-derived state under
  the valid new epoch, restoring an old offset and answering an already answered
  message again. Readiness-time checks cannot certify the final handoff state.

  The rollback diagram has a separate false ordering claim: B's final CAS is said
  to refuse at line 191, while the stored epoch is still B's N+1; the bump happens
  only at line 192. Equality makes that CAS succeed. The panic sequence correctly
  names bump-before-drain as a different policy; rollback must not silently mix
  that policy with drain-before-bump.
- **Resolution direction:** make the final authoritative snapshot, not the dry
  readiness copy, the activation input before any new-epoch state write. Specify
  revalidation if its format changed. Make rollback's drain/exit/bump ordering and
  expected final-write result consistent, including overrun and exit confirmation.

## Findings — effects and state

### B03 — BLOCKING: the outbox does not prove once-only answering

- **Scenarios:** F3, Q1/Q3/Q4 (drain overrun, crash and replay); Q13 settlement.
- **Evidence:** ADR-010 O4-A (`docs/adr/010-container-generations.md:174,233-235,
  255-257`); `docs/features/instance/containers-design.md:221-225,232-233,253-255`;
  `the former file-based inbound implementation:7-15,28-41`; `src/core/core-loop.ts:661-687,720-757`;
  `src/core/container.ts:341-349`.
- **What fails:** atomically publishing a send command with a snapshot does not
  atomically deliver the answer and record its outcome. Trace: the command commits;
  the actuator delivers the answer; the generation crashes or reaches its drain
  deadline before a later tick commits `send.settled`. The inbound entry still has
  no outcome, so it replays. The actuator's durable dedup/effect record and how a
  replacement learns the already delivered result are unspecified. The stated
  applied-key ring is in the loop snapshot, not an atomic receiver-side effect
  transaction. This is the carried crash window, not a window the outbox has closed.

  The specified send key is “turn commit + seq”, yet an abandoned turn's re-issued
  commands are promised the SAME keys. A re-run may have another turn/commit,
  epoch, tool sequence or model answer; no persisted mapping establishes sameness.
  A bounded ring also cannot absorb arbitrary delayed redelivery after eviction
  without a retention/reclaim rule. At-least-once delivery plus a named key is not
  sufficient for exactly-once effects.
- **Resolution direction:** define stable logical effect identity across the
  original turn and its replay, durable receiver-side dedup with effect/result
  recovery, and when the inbound outcome becomes final. Define the dedup horizon
  relative to stream retention and pending commands. Show crash cuts before/after
  delivery, acknowledgement and settlement commit, including drain timeout. For
  this milestone the web receiver can provide the needed contract; no Telegram
  protocol or journal replay is requested.

### B04 — BLOCKING: Postgres effects sit outside the tick commit and fence

- **Scenarios:** F3, Q2/Q4/Q7/Q13; restart-safe schedules.
- **Evidence:** `docs/adr/010-container-generations.md:174,187,204`;
  `docs/features/instance/containers-design.md:88-100,120,221-225,243-245`;
  `src/core/scheduler-service.ts:262-263,321-330`;
  `src/core/scheduler-primitive.ts:359-377`;
  `src/storage/conversation-manager.ts:245-261`;
  `src/storage/soul-provider.ts:927-934`.
- **What fails:** the atomic operation includes Valkey snapshot, events and
  offsets, but PG holds conversations/completed actions, soul, schedules and motor
  transitions. “Transactional” PG rows and epoch stamps do not give those changes
  atomic causality with the Valkey commit or reject stale PG transactions.

  For example, the carried schedule path marks a fire and advances/removes its
  schedule before emitting the signal. Moving that save to PG and the signal to
  the Valkey outbox creates a crash cut: PG commits the advance, Valkey never
  commits the fire; activation reloads PG and never produces the lost fire. Reversing
  the stores' order instead permits redoing a PG effect. Similarly, a conversation
  row can survive an abandoned tick whose inbound position replays. The design
  gives no idempotent/reconciliation protocol for these PG writes. Lease revocation
  after a switch is not an active-epoch check on an already executing transaction.
  A readiness dry tick must not advance these live rows either.
- **Resolution direction:** define how each PG mutation is staged, keyed, applied
  and reconciled through the tick's durable command/result protocol, including stale
  transactions and effect-suppressed readiness. Account for every PG writer before
  claiming one-envelope recovery. Keep the owner-selected stores; do not assume a
  cross-store transaction that is not present.

## Findings — migrations and control lifecycle

### B05 — BLOCKING: downgrade execution cannot handle current data and events

- **Scenarios:** F4/F5/F6, Q3; F3 continuity across rollback.
- **Evidence:** `docs/adr/010-container-generations.md:211,248-250`;
  `docs/features/instance/containers-design.md:132,146-148,193-195,205-210`;
  `docs/charters/instance-1.md:26-27,49-50,85-88`.
- **What fails:** O8-A says the DOWN belongs to the newer code being left and that
  unknown-newer formats refuse activation. The rollback sequence instead starts
  older A and asks A's activation to run the DOWN. A cannot contain converters
  introduced by the failed newer generation. Maintenance boot has the same problem,
  especially after several intervening versions. Its format-accepted readiness
  also has no ordering relative to those required conversions.

  The bus rule accepts only a consumer's v and v−1, and never rewrites streams.
  A v2 command outstanding when v1 is restored is a newer event to v1, not its
  accepted previous version. Old-code rollback therefore cannot consume it;
  booting further back widens the problem. Snapshot/schema DOWNs do not convert
  those outstanding event payloads. Discarding them would violate F3/F6.

  Separate activation conversions also need a defined recovery/refusal boundary:
  a successful snapshot UP followed by a failed PG UP, or a crash between DOWN
  steps, must not leave an older holder selected against mixed formats. An
  individual PG transaction does not resolve the other two version surfaces.
- **Resolution direction:** specify loader-controlled execution of the retained,
  code-owned migration chain before the target is admitted. Include outstanding
  newer bus envelopes and every supported older boot, without restoring old data
  or replaying a journal. Define resumable/refusable transitions for mixed-store
  versions and verify up/down against data written while the newer code ran.

### B06 — BLOCKING: there is no named bound on completed rollback

- **Scenarios:** F4, Q1/Q3 (bounded rollback and once-only continuity).
- **Evidence:** `docs/features/instance/containers-inventory.md:249`;
  `docs/features/instance/containers-design.md:129,159-161,189-196,265`.
- **What fails:** Q3 requires rollback to COMPLETE within a named window. The
  design names 120 s for health observation and a stop budget for draining B, but
  no overall rollback deadline covers start, DOWN migrations, activation, route
  switch and fallback disposition. At t=120 s detection, an allowed 110 s stop
  alone can reach t=230 s before restored service starts. Activation or migration
  can then wait indefinitely. The check stub's “rollback inside the window” has
  no defined window in which that sequence can pass. This is not a finding against
  the owner's health-window value; detection and restoration are different bounds.
- **Resolution direction:** name the rollback completion deadline, the operations
  it covers, and the safe report/maintenance disposition when it expires. Make it
  compatible with drain safety and migration recovery, rather than treating the
  stop or health-observation clock as the whole rollback clock.

### C01 — COMMENT: loader-crash reconciliation needs an explicit crash-cut walk

- **Scenarios:** Q5; Q3/Q10 reports; F7 panic across restarts.
- **Evidence:** `docs/adr/010-container-generations.md:166,195`;
  `docs/features/instance/containers-design.md:118,130-139,196,199-217`;
  `loader/src/state.ts:28-32,176-188`; `the former instance supervisor:300-319`.
- **Risk:** the written intention is idempotent adoption by labels and records,
  but the sequence records the completed switch only after activation/routing and
  the health window. Crash immediately after the durable epoch bump: N has exited,
  C has not received its admitted epoch, and the last completed-holder record can
  still name N. The design does not say which evidence wins or how activation,
  revocation, health timing, failure count and the single report resume. Existing
  `builtCommit` and process-race guards supply no such inherited protocol. This
  is an unresolved recovery risk, not proof that a correct reconciler is impossible.
- **Resolution direction:** walk every loader crash cut against a durable switch
  identity/desired holder and the authoritative Valkey epoch. Specify deterministic
  resume/refusal, exactly-one report/count updates, orphan cleanup and panic
  precedence, including a Valkey restart during reconciliation. Show a live stale
  connection remains fenced while the fresh loader catches up.

## Findings — intake and Docker authority

### B07 — BLOCKING: the pause has no continuously available durable intake path

- **Scenarios:** F3, Q1; Q3/Q4 recovery; outcome 4 front-door re-walk.
- **Evidence:** `docs/features/instance/containers-design.md:25,41,71-74,124-134,
  151-152,171-175,229`; `the former Caddy configuration:101-105`.
- **What fails:** the root-host upstream is the generation's web channel at
  `current`. N stops intake, exits, and only later is that alias moved after C
  activates. C explicitly does not serve during readiness. A POST in that interval
  reaches nonaccepting/dead N and gets a refusal/502, not an `inbound` stream entry.
  The bus table calls the front door the producer, but no always-on submission
  handler or pause routing edge exists in the container/sequence view. This
  contradicts the prose guarantee that all pause input is durable before any
  generation sees it. Client retry is neither stated nor a server durability point.
- **Resolution direction:** identify the submission owner and route that stay
  available during drain, activation, rollback and a holder crash, and the durable
  acknowledgement point. That contract belongs in the generation architecture;
  it does not require designing outcome 8's UI.

### B08 — BLOCKING: endpoint filtering does not bound Docker compromise

- **Scenarios:** Q9 security analysis; STRIDE elevation/tampering of the Docker
  trust boundary; the stated security claim in O6-D.
- **Evidence:** `docs/adr/010-container-generations.md:195,198,241-244`;
  `docs/features/instance/containers-design.md:19,42-44,246-248`.
- **What fails:** O6-D says an endpoint-allowlist socket proxy bounds the loader's
  compromise to the endpoints it needs. The loader needs container create/start.
  Those permitted requests can create a root container with a host-root or Docker
  socket bind mount, or privileged/host namespace options, then start it. Merely
  filtering endpoint names does not restrict these request bodies. The compromise
  still obtains daemon-root authority. A “private” network is not a restriction
  on Docker create options. The loader being trusted is an accepted input; the
  reduced blast-radius claim about the proxy is false.
- **Resolution direction:** either state the request-content/authority restrictions
  that actually constrain create/start and the broker, or explicitly acknowledge
  daemon-root trust for both proxy and direct-socket variants. Keep Docker in the
  trusted loader boundary; do not present a convenience endpoint filter as a
  security boundary it cannot enforce.

## Finding — owner trades and validation

### C02 — COMMENT: separate fixed constraints from open values and measured risks

- **Scenarios:** Q4/Q5/Q8/Q11/Q12/Q13; F7 outcome-4 re-walk.
- **Evidence:** `docs/adr/010-container-generations.md:20-51,134-136,187,273-287`;
  `docs/charters/instance-1.md:37-44`;
  `docs/features/instance/containers-design.md:86,94,218-239,257-275`;
  `src/layers/aggregation/persistent-ack-registry.ts:27-29,76-89`;
  `src/core/intent-applicator.ts:513-521`;
  `README.md:189-196`;
  `the removed Docker instance first-start fixture:1117-1139,1847-1864`.
- **Risk and classification:**
  - Trade 1 (drain time versus redo) and trade 4 (health duration versus detection)
    are genuine open values within the charter. Neither alone provides B03's
    once-only effects or B06's completed-rollback bound.
  - Trade 2 is not an open owner trade: ONE current snapshot committed each tick
    is already fixed. The chosen per-tick default complies, but “every N ticks”
    must not be left as an equally admissible implementation setting. Also, one
    second of tick-state loss is not a bound on abandoned cognition-turn duration.
  - Trade 3 (unseal custody) is open security policy, but the manual-unseal option
    explicitly fails unattended Q5 recovery. It needs an explicit requirement
    change if selected, not treatment as a compliant variant. The two-failure
    maintenance threshold is a separate reliability policy, not the health-window
    length that the views label it as (`containers-design.md:199-202`).
  - The “tens of KB” snapshot / light 1 Hz fsync premise is unmeasured. Bus,
    ingress, commands and settlements also write AOF; cost is not just one
    snapshot per second. Name peak RAM margin, stream/pending retention,
    release/workspace volume retention, disk exhaustion behavior and startup
    measurements. Do not infer durable ack latency from the 500 ms debounce:
    the cited current registry also has DeferredStorage's 30 s disk batching.
  - The one-command concept is possible, but the actual bootstrap command and
    socket/proxy authority path are not given. The current command and fixture
    mount no socket. Specify how authority, satellite/proxy pins, instance labels
    and private-network/volume adoption arrive with that one command; re-walk
    clean start, recreation and panic in the CI-only fixture. No extra host
    service or pre-installed compose/proxy should become an unstated prerequisite.
  - Alias movement needs acceptance for DNS caching, persistent Caddy upstream
    connections and retries, not just a new alias target. “Caddy unchanged” can
    mean unchanged authentication/pinned hosts; its root upstream must change
    from `127.0.0.1:7100` (`the former Caddy configuration:104`) to the new service.
  - The inventory's delayed `SCHEDULE_EVENT` timeout needs an explicit durable
    event/due-time mapping; the general events rule could cover it, but the table
    omits it. Check the entire span-tick inventory, including stop-time result
    processing, rather than retaining inline callback mutation as a drain shortcut.
- **Resolution direction:** correct the open/fixed classification, then fill the
  candidate checks with bounded measurements and fault cases in the permitted
  test environment. These are validation and coverage risks, not findings against
  the owner-selected stores, container shape or tick boundary.

## Security walk (STRIDE)

The private Docker network removes an external route; it does not authenticate
peers, hide listeners, or limit container-create privileges. The security proof
must include the following boundaries. This table elaborates findings and open
risks; it adds no separately counted findings.

| Boundary | STRIDE prompts and consequence | Review result / needed evidence |
|---|---|---|
| Docker socket / broker | Elevation and tampering through allowed create/start bodies; denial of service by arbitrary resource requests; spoofed instance/run identity | B08 rejects the reduced-blast-radius claim. Prove the broker's allowed request shape, labels and limits; generations must still lack direct Docker paths (Q9). |
| OpenBao | Spoofed issuance client, overbroad PG/Valkey role grants, lease renewal/revocation failure, unseal-key disclosure | Loader-only token is a useful boundary. Engine availability is A7, not evidence. Verify scopes, renewable lifetime, maximum effective access and termination of live sessions, including engine/loader restarts (Q8; C01/C02). TTL metadata alone does not prove database-side expiry. |
| Valkey ACLs / epoch | Tampered bus/snapshot via raw mutations; forged command producers; replay after dedup eviction; denial of service via untrimmed streams | B01/B03 require enforceable authority and retention. One durable epoch prevents compliant stale CAS commits across a single-store restart, not malicious writes outside CAS. Keep refusal counts observable without mutating the protected snapshot/position. |
| Agent Vault leaving loopback | Management/API bypass, proxy-token theft/reuse, model-key disclosure and unallowlisted relay | The source uses one server `--host 127.0.0.1` (`the former instance Agent Vault integration:222-232`) and reuses one proxy agent/token (`:506-536`). Verify proxy-only exposure versus management binding, distinct generation tokens/revocation, mounted public CA and named direct private-store routes (`:766-797`). The accepted key-absence fixture does not prove these new boundaries. |
| Shared private network | Lateral access to Bao/admin/control listeners; spoofed `/activate` or `/drain`; network/resource denial of service | Do not rely on absent internet routing for internal authorization. Define allowed callers/authentication on generation control and trusted management listeners. Re-derive IPv4/IPv6 direct-egress and loader-login tests on the new network; never infer them from the old uid-only iptables rule. |

## Disposition

Recorded by the resolution pass (lifemodel-b0r.9.4), one entry per finding.

### B01 — resolved

- **What changed:** ADR-010 O2-B row (scoped FCALL-only users, the engine bound,
  the admission token), new assumption A8 (ACLs fence commands, not intentions),
  Decision outcome item 2 (fencing: token in every committed envelope), O7-A row
  (stale raw write refused by the token, not only the CAS). containers-design.md
  contract points 5-6 (mutation authority in three layers; separate ingress
  authority), point 7 renumbered, container-view hard edges (credential split at
  the Valkey edge).
- **Why it holds:** Valkey ACLs fence commands, not intentions — verified against
  valkey.io docs (`server.acl_check_cmd` checks the connecting user; inner NOPERM
  → "ACL failure in script"; first-arg rules deprecated) and engine source
  (`src/modules/lua/script_lua.c`, unstable). So the design no longer claims
  raw-write prevention: generations get no `inbound`/epoch write pattern at all,
  guarded-key writes are pattern-scoped (usable raw — stated), and ACCEPTANCE of
  any guarded write requires the per-epoch admission token the loader mints at
  each bump and every consumer verifies. A stale live connection can transmit
  bytes but cannot get a write applied. Ingress (`+xadd inbound` only, held in
  the trusted container) is a different credential from generation authority.
- **What remains unverified:** actual behavior on the pinned Valkey version
  (token-copy atomicity is inside the one Lua call, but FUNCTION LOAD REPLACE
  semantics, ACL LOG volume under refusal storms, and CAS+token round-trip
  latency are Q6/C02 measurements, not doc facts). The engine-source reading is
  from `unstable`, not the release this milestone pins — the first Q7 check must
  assert "raw guarded-key write is transmitted but never applied" on the pinned
  image.

### B02 — resolved

- **What changed:** containers-design.md planned-switch diagram (activate step now
  discards readiness state and re-hydrates from the post-bump snapshot), contract
  point 1 (readiness hydration is provisional) and new point 8 (the activation
  input rule, UP conversion at re-hydration, refusal ordering), rollback diagram
  and bullets (drain → final CAS succeeds → confirmed exit → bump → refuse;
  overrun = the crash path; panic's bump-first named as the deliberate opposite),
  ADR-010 O8-A (activation ALWAYS re-reads after the bump; readiness copy never
  the input) and Decision outcome item 3 (rollback ordering).
- **Why it holds:** the stale-hydration accident is closed by construction: C's
  readiness S0 is discarded and the authoritative post-bump S1 (with N's final
  answer and inbound offsets) is the activation input, in BOTH the rollout and
  rollback paths, with the UP conversion run at that single re-hydration point.
  The rollback diagram no longer claims B's CAS refuses while B still owns the
  epoch: drain-before-bump is now written, the panic policy's bump-first is named
  as its opposite, and the overrunning case degrades explicitly to the crash path.
- **What remains unverified:** that the loader enforces "no intake before activate
  returns success" as an ordering test (Q1 check), and that a mid-re-hydration
  crash of C re-runs activation cleanly (Q4/Q5 checks). The 90 s/110 s values
  stay owner trades (ADR-010 trades 1-2); B06 names the missing rollback clock.

### B03 — resolved

- **What changed:** containers-design.md bus-events table (send keys → stable
  send effect id), the abandoned-turn rule, and a new "Effect identity and
  once-only settlement (B03)" subsection (stable ids minted at first decision
  and persisted with the turn; receiver-side Postgres effect records with
  in-flight/terminal states and result recovery; inbound outcome finality;
  dedup horizon = stream retention; five crash cuts walked). ADR-010 O4-A row,
  Decision outcome item 4, and the F3 Good-consequence line rewritten (the
  outbox alone no longer claimed to close the crash window).
- **Why it holds:** the re-issue sameness the old text promised ("SAME keys")
  now has a persisted source — ids assigned with the deciding tick's commit and
  re-read on replay — and the delivered-but-unsettled window, which the outbox
  cannot close by itself, is closed receiver-side: the web receiver's durable
  effect record is written before the delivery attempt and answers every
  redelivery from its recorded result, so each cut (pre-delivery, mid-delivery,
  post-delivery/pre-settlement, drain abandonment, Valkey restart) yields at
  most one owner-visible delivery and exactly one inbound outcome.
- **What remains unverified:** the Postgres effect-record schema and its
  pruning against actual stream retention (a Q11/Q13 measurement, C02); the web
  receiver is this milestone's contract holder — outcome 8's design inherits
  it; browser-upsert behavior under a partially completed delivery is asserted
  by a check, not yet run.

### B04 — resolved

- **What changed:** containers-design.md new subsection "Postgres mutations
  through the tick boundary (B04)" (full writer accounting; keyed `pg.apply`
  commands in the outbox; per-key `applied(key, epoch)` record — skip on hit,
  refuse on newer, apply+stamp otherwise; conversations append-only with id
  upsert; schedules' fire/advance convergence rules; total readiness
  suppression including PG; lease-vs-fence distinction), `pg.apply` added to the
  event table. ADR-010 O5-A cell and Decision outcome item 5 carry the same
  discipline.
- **Why it holds:** every PG writer the state table names is enumerated and
  routed through the tick's durable command/result protocol; the applied
  record gives PG changes causality with the epoch fence without inventing a
  cross-store transaction; both crash orders of the schedule fire/advance pair
  converge (applied-record skip on one side, reload-on-activation on the
  other); the readiness dry tick cannot advance live rows because it emits no
  commands at all.
- **What remains unverified:** the `applied` table's growth/retention (a Q11
  measurement, C02); the schedule convergence assertions need their Q13 check;
  applier serialization (one applier per holder) is asserted by a check, not
  yet run.

### B05 — resolved

- **What changed:** containers-design.md new contract point 9 (loader-executed
  downgrade before admission of the older target; migration container from the
  leaving sealed tree; all three version surfaces including outstanding newer
  bus envelopes — downgraded copies appended, streams never rewritten; durable
  resumable/refusable transition record; refusal leaves the instance down
  rather than mixed-format), rollback diagram line replaced (no more "A runs
  the DOWNs"), maintenance bullet updated. ADR-010 O8-A cell and Decision
  outcome item 8 rewritten to the loader-executed chain.
- **Why it holds:** the leaving code owns its converters and the loader is the
  only Docker client, so a short-lived migration container from the leaving
  sealed tree is the one place the DOWN chain can run; running it BEFORE
  admission means the older holder never faces a format it does not know,
  including outstanding bus envelopes past its offsets (copies appended,
  offsets advanced — no journal replay, no old-data restore, F3/F6 intact);
  the transition record makes partially applied chains resumable (idempotent
  steps) or refusable (instance stays down, loudly) — never silently mixed.
- **What remains unverified:** down-converter coverage for every future
  version pair is a per-change gate (the checks section names it); the bus
  downgrade pass's entry-id skip record and retention interplay need the Q13
  check; migration-container image seam is asserted by a check.

### B06 — resolved

- **What changed:** containers-design.md rollback bullets: a new "Rollback
  completion deadline (B06)" bullet — 300 s (proposal) from failure detection to
  service restored behind `current`, one clock covering drain/exit, downgrade,
  start, activation and routing; expiry → best-effort stop, token/lease
  revocation, maintenance, report naming the overrunning step; detection named
  a different clock. ADR-010: new owner trade 5, Decision outcome item 3 updated.
- **Why it holds:** the window Q3 asks for now exists and names its operations;
  the check stub's "rollback inside the window" has a defined window to pass
  in; expiry disposes safely (maintenance + report) instead of leaving a
  half-rollback or starting an unbounded chain.
- **What remains unverified:** 300 s vs the real drain budget and real
  downgrade duration is exactly what the Q3 check must measure (and trade 5 is
  the owner's to reset); nothing else. The health-window VALUE stays its own
  trade (now trade 2) — untouched.

### B07 — resolved

- **What changed:** the earlier resolution put the intake handler inside the
  trusted container; the owner rejected any intake/gateway lifemodel cannot
  change itself — every part of the channel path must be lifemodel's own code,
  updated by generations. Corrected: the submission OWNER is the INTAKE ROLE of
  every running generation container (an ingress-only Valkey user from OpenBao,
  per generation; append to `inbound` through its own function, nothing else);
  the ROUTE is a Caddy upstream pool of every intake-ready generation with
  health checks (UI/session stays on `current`). containers-design.md contract
  points 6-7, the container-view diagram edge, the front-door edge and the
  event table producer; ADR-010 A5 and Decision outcome item 6.
- **Why it holds:** a candidate is intake-ready from its start, BEFORE
  activation (its intake role needs no epoch), and the leaving generation
  accepts intake while it drains and until it exits — so switch and rollback
  have no instant without an intake-ready container, and the durability point
  (the fsync'd `inbound` XADD, 202 after it) is independent of who serves. The
  one uncovered window — a holder crash with no candidate running — is covered
  by client retry with an idempotency key (the browser keeps the unsent
  message), bounded by the loader's restart time; the retry dedups through the
  existing inbound ring.
- **What remains unverified:** Caddy's upstream connection reuse across alias
  moves and DNS caching for the UI route remain C02 items (they affect the
  serving route, not the submission route); the exact intake surface (auth
  seam, body limits) is outcome 8's to design within this contract.

### B08 — resolved

- **What changed:** ADR-010 O6-D row rewritten (daemon-root trust stated for
  BOTH variants; endpoint filtering explicitly NOT a body inspector; proxy =
  defence in depth + operability), Decision outcome item 6 reworded,
  containers-design.md diagram edge caption and a new "Docker authority is
  daemon-root trust, stated (B08)" bullet listing the broker's concrete
  defence-in-depth restrictions (fixed image allowlist, loader-owned labels,
  no host publish/privileged/host-namespace options, broker-built request
  shape, per-run named workspace volumes).
- **Why it holds:** the false reduced-blast-radius claim is gone; the trust
  statement matches what create/start authority actually means; the broker's
  real restrictions are enumerated as hardening rather than sold as a
  boundary, and the actual boundary (socket only in the trusted container,
  none in generations) is unchanged and checkable.
- **What remains unverified:** which proxy implementation is pinned and which
  verbs its allowlist drops (an implementation-stage choice; the Q9 check
  asserts generations lack Docker paths either way).

### C01 — resolved

- **What changed:** containers-design.md new subsection "Loader crash
  reconciliation (Q5, C01)": the durable records named (switch record with
  phases, registry, panic, epoch+token); the crash-cut walk (pre-bump resume;
  the bump cut resolved by READING the epoch — redo if old, continue if aimed;
  post-bump idempotent continuation; foreign epoch → refuse + maintenance);
  orphan/candidate cleanup; single report keyed by the switch id; Valkey-loss
  refusal; stale-connection fencing while the fresh loader catches up. ADR-010
  O6-A evaluation updated (labels are identity, not decision).
- **Why it holds:** the cut the review named (crash right after the bump) now
  has a deterministic resolver — the epoch record itself says whether the bump
  committed, and the switch record says what to do next; activation, revocation
  and report-writing are idempotent or keyed, so resume neither duplicates nor
  omits; the empty-store case refuses instead of guessing.
- **What remains unverified:** switch-record schema and fsync placement are
  implementation-stage; the Q5 check must exercise the bump cut and the
  empty-store refusal against the real launcher; OpenBao lease
  revoke/re-issue behavior across loader restarts stays a Q8/C01 measurement.

### C02 — resolved

- **What changed:** ADR-010 trades list restructured: snapshot frequency
  REMOVED as a trade (charter-fixed; "every N ticks" named a requirement
  change, and the one-second/tick-state vs turn-duration conflation
  corrected); unseal custody renumbered and marked "choosing manual unseal =
  requirement change, not a compliant variant"; the two-failure threshold is
  its own trade 3 (no longer labeled as the health window); health window
  trade 2; rollback deadline trade 5; the pending measurements are named in
  the Checks section (RAM peak, stream/record retention, startup, fsync cost —
  all as bounded checks, not premises). containers-design.md references
  renumbered; the health-window label no longer calls the threshold a
  health-window length.
- **Why it holds:** the open/fixed classification now matches the charter:
  per-tick snapshot is fixed, drain/health/threshold/unseal/rollback-deadline
  are the owner's; manual unseal is out unless the requirement changes; the
  unmeasured premises are converted into named checks rather than left as
  assumptions inside trades.
- **What remains unverified:** every measurement itself — RAM peak margin,
  bus/pending retention and applied-record growth, release/workspace volume
  retention, startup and fsync latency, alias-move acceptance (DNS caching,
  persistent upstream connections), the one-command authority path, the
  delayed SCHEDULE_EVENT durable mapping, the extended CI-only fixture walk.
  These are the Checks section's job; none is claimed done here.

## Summary

- **8 BLOCKING findings:** B01–B08.
- **2 COMMENT findings:** C01–C02.
- **Verdict: BLOCK.**

The chosen owner shape remains the input. Its compliant single-store CAS is a
useful fence, and the normal readiness-failure path is coherent. The current
write authority, handoff state, effect receipts, PG causality, downgrade path,
rollback bound and pause intake do not yet establish F1–F7/Q1–Q13. The Docker
proxy also claims a security boundary that endpoint filtering cannot supply.
Resolve these findings in the design before treating the candidate checks as an
acceptance plan. This review does not require different stores, hot standby,
journal replay, a split core, or Telegram.

Unverified: actual Valkey/OpenBao engine and ACL/session behavior, Agent Vault's
cross-network listener/token isolation, Docker alias/connection behavior, memory
and disk margins, startup/fsync latency, and the extended outcome-4 CI fixture.
No runtime or test result is claimed.

## Verification (round 2)

Task: lifemodel-b0r.9.4. Verified the dispositions against the original scenarios
using `git log --oneline 74e3fcb..HEAD` and `git diff 74e3fcb..HEAD -- docs/`
through 9d2bce1. The owner's loader-configuration values and generation-owned
intake are fixed inputs. CLOSED means the written mechanism addresses the original
finding, not runtime acceptance. Evidence below names sections of ADR-010 and
`containers-design.md`; inventory F*/Q* measures remain the bar. No probes, Docker,
npm or product tests ran. The automatic transition document gate did not run.

- **B01 — STILL BLOCKING:** ADR-010 O2-B/Decision outcome 2 and design contract point 5 still permit raw `XADD bus`/`SET snapshot`; reader rejection cannot keep Q7's stored snapshot and bus position byte-identical or undo an overwritten snapshot. The token is readable in committed envelopes (and used against the readable epoch record), so a stale live connection can copy the current token into a raw write and pass the stated acceptance check. Neither original Q7 nor the compromised-generation Q8 boundary is established.
- **B02 — CLOSED:** ADR-010 O8-A and design contract point 8 explicitly discard all readiness state and load the final post-bump snapshot even without a format change; the rollback diagram and drain-before-bump bullet now let B's final CAS succeed, confirm exit, then fence. These correct both original ordering defects; the added token rule's interaction with this handoff is NEW-1 below.
- **B03 — STILL BLOCKING:** ADR-010 O4-A/Decision outcome 4 and design “Bus events” now persist stable ids, receiver results and crash-cut recovery, but “Dedup horizon = stream retention” permits pruning after a retention window without a final-settlement/pending-effect guard. A delivered send whose settlement never committed can remain in the snapshot during maintenance longer than that window; replay then re-issues its id after the receiver record was pruned. This is a new delivery attempt from pending state, not redelivery of a retained stream entry; browser upsert does not recover the pruned terminal result. The original delayed-replay/reclaim case remains unproved (F3/Q3/Q4).
- **B04 — STILL BLOCKING:** ADR-010 O5-A/Decision outcome 5 and design “Postgres mutations through the tick boundary” add causal outbox commands and total readiness suppression, but `applied(key, epoch)` is deduplication, not an active-holder fence. An N transaction already in flight for a never-applied key has no newer per-key record to reject it when the loader bumps to N+1, so it can still mutate the live row; N+1's different effect key does not protect that row either. No atomic active-epoch/transaction barrier is specified, so the original stale-PG-transaction Q7 case remains.
- **B05 — STILL BLOCKING:** ADR-010 O8-A/Decision outcome 8 and design rollback point 9 correct converter ownership and name resumable/refusable transitions, but copying only newer outstanding envelopes and moving consumed offsets past their originals can discard compatible unconsumed events in the same total-order bus (state row 1). With offset 10, compatible settlement 11 and newer command 12, appending converted 12 as 13 and advancing past the originals skips settlement 11; retaining the old cursor instead exposes unsupported 12. No selective-skip or complete-suffix preservation rule is stated, so the original outstanding-events continuity case still fails F3/F6/Q3.
- **B06 — CLOSED:** ADR-010 “Owner decisions” item 5 and design “Rollback completion deadline”/“Loader configuration” name one `rollbackDeadlineMs` clock (default 300 000 ms) from failure detection through drain, confirmed exit, downgrade, start, activation and routing, with maintenance and a step-specific report on expiry. This supplies the originally missing completion bound without confusing it with health observation; actual duration remains the Q3 check's job.
- **B07 — STILL BLOCKING:** ADR-010 A5/Decision outcome 6 and design point 7 provide generation-owned pooled intake and a fsync-before-202 acknowledgement for the planned overlap, but the rollback diagram exits B before starting A, and point 9 requires DOWN before any older target runs. During that exit/downgrade/start interval no intake-ready generation exists, so a POST still reaches a dead/empty pool instead of `inbound`. The retry exception names only a holder crash, not this normal rollback; point 7's continuous-rollback-intake claim therefore does not hold (F3/Q3). No trusted-layer intake is requested.
- **B08 — CLOSED:** ADR-010 O6-D/Decision outcome 6 and design “Docker authority is daemon-root trust, stated” explicitly acknowledge daemon-root authority for proxy and direct-socket variants, deny endpoint filtering as a compromise boundary, and list broker-built request restrictions as hardening. This removes the original false security claim while retaining Q9's generation/loader boundary.
- **C01 — CLOSED (comment):** Design “Loader crash reconciliation (Q5, C01)” and ADR-010 O6-A now name durable intent before action, resolve the bump cut from the authoritative epoch, key reports by attempt, reconcile orphans/leases, honor panic and refuse a foreign epoch or empty store. This addresses the original unspecified reconciliation risk at design level; real crash-cut and lease behavior remain unverified in Q5/Q8.
- **C02 — CLOSED (comment):** ADR-010 “Owner decisions” separates charter-fixed per-tick snapshots from the owner's decided loader settings and marks manual unseal a requirement change; design “Loader configuration” and “Checks” assign the bootstrap/first-start, resource, retention, timing, credential and span-tick validation work to named lanes. These are an acceptance plan, not measured results: the original runtime/resource/coverage risks remain explicitly unverified.

- **NEW-1 — BLOCKING (F2/F3/Q1):** B01's new acceptance rule (design point 5; ADR-010 Decision outcome 2) requires every snapshot/event token to match the current epoch token. N's final snapshot S1 carries T_N; the bump installs fresh T_N+1 without rewriting S1; point 8 then requires C to discard readiness state and read S1 after that bump. The universal reader rule rejects precisely the authoritative handoff snapshot, even in a same-format switch. No trusted previous-epoch admission/re-attestation step is specified; outstanding pre-bump committed events face the same mismatch. This is a defect introduced by the fix, not a new design topic.

**Final verdict: BLOCK.** B01, B03, B04, B05 and B07 remain blocking; B02,
B06 and B08 are closed on their original scenarios; C01/C02 are closed as design
comments with runtime validation pending. NEW-1 additionally blocks the handoff.
The owner's topology, intake placement and configuration decisions are unchanged.


## Disposition (round 2)

Task: lifemodel-b0r.9.4. One commit per item; docs only; the owner's fixed
inputs (topology, intake in the generations, loader configuration values) are
unchanged. Each entry states what changed and why the reviewer's stated
failure no longer happens.

- **B01 — fixed:** ADR-010 O2-B/Decision outcome 2 and design contract point 5
  no longer permit raw writes: a generation Valkey user carries NO raw write
  commands at all (no XADD/SET/DEL on `bus` or the snapshot keys) — every
  guarded mutation is FCALL of the epoch-checked library. The fence no longer
  relies on a readable token: the loader REVOKES the old generation's user
  (ACL SETUSER off + CLIENT KILL USER) and confirms the revocation BEFORE the
  epoch bump; the function's epoch check is the second layer. The
  token-equality acceptance rule is removed, so a stale live connection cannot
  copy a token into a raw write — it has no raw write grant at all, and after
  the confirmed revocation no connection either. The Q7 check asserts the
  revocation-before-bump ordering and the FCALL-only grant set.
- **NEW-1 — fixed:** design point 8 and Decision outcome 2 no longer demand
  token equality for the handoff. The loader's durable switch record names
  which epoch's snapshot is the handoff input; the candidate loads that
  recorded pre-bump snapshot by position, and its first commit writes under
  its own epoch — the previous-epoch input is admitted exactly once, by
  record, never by token. The authoritative handoff snapshot is no longer
  rejected.
- **B03 — fixed:** design "Bus events" (replacing "Dedup horizon = stream
  retention" as the safety rule) and ADR-010 O4-A/Decision outcome 4 state the
  pruning rule: receiver effect records and pending effects are pruned ONLY
  after their settlement is committed in a snapshot — never by time or
  retention alone — and maintenance holds pruning. A delivered send whose
  settlement never committed keeps its record for any length of maintenance,
  so replay recovers the result from the record instead of re-delivering.
- **B04 — fixed:** design "Postgres mutations through the tick boundary" and
  Decision outcome 5 add the database-side fence the per-key record could not
  provide: every `pg.apply` transaction first takes `SELECT epoch FROM
  active_holder FOR SHARE` and aborts on mismatch; the loader's bump is
  `UPDATE active_holder SET epoch = N+1`, whose row lock waits out every
  in-flight epoch-N transaction, after which none can commit under N. The
  reviewer's stale in-flight transaction on a never-applied key is now fenced
  by the database itself; `applied(key, epoch)` stays for dedup only.
- **B05 — fixed:** design point 9 and Decision outcome 8 now convert the WHOLE
  unconsumed suffix in order: every entry past the consumed offset is appended
  again (compatible ones copied unchanged, newer ones downgraded), then the
  offset advances past ALL originals — nothing is skipped. The reviewer's
  example is stated in both documents: offset 10, compatible settlement 11,
  newer command 12 — the pass appends 11 and downgraded 12, then moves past
  12; neither skipping 11 nor exposing 12 happens.
- **B07 — fixed:** the rollback diagram now starts the older target A FIRST in
  intake-only mode (its intake role needs no data or DOWN), joining the Caddy
  intake pool and intake-ready BEFORE B stops accepting; B then drains and
  exits, the loader runs DOWN, and A activates as holder. Design points 7 and
  9 state the same rule for maintenance boots. No POST can reach a dead or
  empty pool during a rollback; the same continuity as the planned switch now
  covers the unplanned one.
- **Final verdict input:** with these six edits, the round-2 blocking findings
  B01, B03, B04, B05, B07 and NEW-1 each have a written mechanism addressing
  the stated failure; B02, B06, B08, C01 and C02 were already closed in round
  1 and are unchanged by this pass.

## ADR rewritten 2026-10-12

ADR-010 (`docs/adr/010-container-generations.md`) and the views
(`containers-design.md`) were rewritten on the owner's point-by-point decisions
of 2026-10-12 (OWNER-DECISIONS.md, points 1-8 of 2026-10-12). The rewrite kept
fencing, the recorded-handoff-snapshot activation and the tick-boundary
discipline this review forced, and REMOVED mechanisms: sealed per-commit release
trees (decision 1 replaced them with per-module images built in a BuildKit
sandbox); down migrations entirely (decision 3 = expand/contract with the
build-checked invariant "the predecessor reads everything I write"; decision 8 =
AsyncAPI + JSON Schema with FULL both-ways compatibility at build); the bus
suffix conversion; the UP/down conversion at activation; the 90 s turn-drain
(decision 4 = the core makes no external calls; an executor module runs them);
and loader-injected environment (decision 7 = OpenBao Agent in Process
Supervisor mode, per-module roles).

Everything above the note stands as history and is unchanged. The round 1-2
dispositions whose resolved MECHANISM the rewrite removed (the scenario they
served is answered differently by the rewritten ADR):

- **B05 — superseded in full, both rounds.** Round 1 resolved it with the
  loader-executed downgrade chain (a migration container from the leaving
  sealed tree; a durable resumable/refusable transition record); round 2
  refined it to the whole-unconsumed-suffix bus conversion (compatible entries
  copied, newer ones downgraded, the offset advanced past all originals). The
  downgrade machinery and the migration transition record no longer exist;
  there is no down path and no conversion pass. Decision 3 answers F5/F6/Q3 at
  BUILD time: expand/contract plus the predecessor-reads-everything-I-write
  build check, automatic rollback on CURRENT data, snapshot copies as manual
  maintenance recovery; decision 8 answers the outstanding-events case with
  FULL both-ways event compatibility during a switch. The disposition's
  unverified items (down-converter coverage, the skip record, the
  migration-container image seam, the sealed-tree migration container) are moot.
- **B02 — superseded in part.** The activation re-read of the recorded handoff
  snapshot survives (decision 2 and design point 8 keep it, by record, never by
  token — NEW-1's fix carried). Its UP conversion at re-hydration does not:
  decision 8 makes the envelope a Tolerant-Reader read-or-refuse story, so the
  "UP conversion run at that single re-hydration point" clause is superseded.
- **B06 — superseded in part.** The single rollback completion clock survives
  (`rollbackDeadlineMs`, proposal 300 s), but its covered set no longer
  contains a downgrade step (decision outcome 3): the clock now covers drain,
  confirmed exit, expanding migrations, start, activation and routing only.
- **B07 — superseded in part.** The intake-continuity mechanism survives
  (the older target starts FIRST, intake-ready, in the fallback pool — A5,
  design intake points), but round 2's rollback sequence ran "the loader runs
  DOWN" between the old generation's exit and the older target's activation;
  that step and its timing contribution are superseded (no DOWN exists).
- **B03 — superseded in part.** Round 1's receiver-side durable effect record
  as the WEB delivery proof is superseded by decision 5: the web-chat delivery
  proof is the message row itself, inserted by key in the conversation table;
  no separate receipt record exists for web sends. Keyed side-effect done
  records survive for every other side-effecting call (decision 4), and round
  2's pruning rule (records pruned only after their settlement is committed in
  a snapshot) is carried into the rewritten views.
- **B04 — superseded in part.** Round 1's per-key `applied(key, epoch)` record
  as the general idempotency mechanism is superseded by decision 5: Postgres
  commands applied after the tick commit are idempotent by NATURAL keys; the
  generic applied table is the documented exception only. Round 2's
  database-side fence (`SELECT epoch FROM active_holder FOR SHARE` before every
  `pg.apply` transaction, the bump waiting out in-flight transactions) survives
  unchanged — decision 2 keeps the `active_holder` row.

Surviving without change (decision 2 keeps fencing as reviewed): B01's
FCALL-only grants with revocation confirmed BEFORE the epoch bump, B04's
database-side fence and out-of-tick `pg.apply`, B07's generation-owned pooled
intake, B08's stated daemon-root trust through the socket proxy, C01's loader
crash reconciliation, NEW-1's record-named handoff snapshot.

The rewritten ADR is the source of truth for these sections; where a
disposition text above contradicts the rewritten ADR, the ADR governs.


## Round 3 (rewrite review, 2026-10-12)

Reviewer model: **openai-codex/gpt-6.1-sol** (independent reviewer session;
two same-model read-only cross-check lanes). Task: **lifemodel-b0r.9.6**.
Method: one ATAM-style scenario walk, with cost, reliability, operations,
performance and security prompts.

Scope: the fixed points 1–8 in `OWNER-DECISIONS.md`, the rewritten ADR-010,
container design views and Checks, inventory F1–F7/Q1–Q13, the charter, and
selected current loader/core/plugin sources. The owner’s choices are not
re-opened. Current code establishes carried behavior and conversion obligations,
not a requirement that the proposed implementation already exist. Evidence is
from base `2f8b7a29971095c03a320a12520d86f8322b7384`.

**Summary: 14 BLOCKING findings, 10 COMMENT findings. Verdict: BLOCK.**
BLOCKING means the work plan cannot safely rely on the written mechanism;
COMMENT marks a sensitivity, validation gap or inconsistency to carry forward.
No npm, Docker, runtime probes or product tests ran. The automatic transition
document gate did not run. Proposed checks are not acceptance evidence.

### Scenario walk and sensitivities

“Addressed” below means a written direction exists, not a runtime PASS.

| Scenario | Sensitivity / result |
|---|---|
| F1 — candidate beside holder | Per-module immutable artifacts address separation. Reuse/check admission and function conversion remain incomplete (R3-06, R3-10, R3-18). |
| F2 — ready before epoch | Normal readiness-before-bump ordering is explicit. A usable commit permission set, two-store barrier and bounded activation are not (R3-02, R3-03, R3-13). |
| F3 — no lost/double answer | Message-row idempotency is a useful local proof. Grace authority, recovery state, pending-command transfer and remote effects still break the wider claim (R3-01, R3-03–R3-09). |
| F4 — automatic fallback/report | One fallback on current data and one report id are addressed. Non-core health and unsafe re-activation can defeat restoration (R3-04, R3-07, R3-12). |
| F5 — older maintenance boot | The fixed read-or-refuse window is retained. Window membership, governing charter and manual-copy limits need definition (R3-07, R3-22, R3-24). |
| F6 — expand/contract | No down path is the correct fixed direction. Generation-specific build admission and actual snapshot/bus/PG reader compatibility are not proved (R3-06, R3-07). |
| F7 — one command, key absence, panic | Compose and persistent panic retain the direction. Bootstrap, internal authorization and secret-specific checks need completion (R3-11, R3-16, R3-17, R3-19). Grace capabilities must also die on panic (R3-01). |
| Q1 — bounded switch | A short local tick trades pause time for background completion. Drain alone bounds neither revocation nor activation; route convergence also needs validation (R3-01, R3-13, R3-15). |
| Q2 — never ready | Effect suppression and no-bump discard address the normal case. The named probe/window values are missing and function readiness has no complete contract (R3-10, R3-13). |
| Q3 — unhealthy rollback | The 300 s restoration deadline is distinct from health detection. Its usefulness turns on compatible current data, whole-generation health and fenced completion (R3-01, R3-03, R3-07, R3-12). |
| Q4 — holder crash | Snapshot/outbox plus keyed local rows address basic cuts. Durable job ownership, external ambiguous effects and delayed timers remain uncovered (R3-08, R3-09, R3-14). |
| Q5 — loader crash | Intent-before-action and foreign/empty-epoch refusal are useful. Two-store reconciliation and activation-after-first-commit are unsafe as written (R3-03, R3-04, R3-16). |
| Q6 — Valkey restart | Single-store AOF-always is the right fixed durability policy. Successful commits with real ACLs, ack/error behavior, rewrite and storage-pressure cuts need proof (R3-02, R3-21). |
| Q7 — zero stale writes | Store-enforced mutation privileges, BOTH epoch stores and authorized old-job completions are the load-bearing points (R3-01–R3-03, R3-11). |
| Q8 — scoped credentials | Agent injection avoids Docker-inspect disclosure but adds bootstrap/rotation cost. Internal caller identity and secret-specific tests are missing (R3-11, R3-16, R3-17). |
| Q9 — loader-only Docker | Daemon-root loader trust is now honestly stated; no new blast-radius claim is made. Peer-to-proxy isolation and the actual lifecycle verb set remain to prove (R3-11, R3-19). |
| Q10 — UI/reports | Same-login reports/maintenance are addressed. Reports must expose module outages, route convergence, uncertain effects and restore limits (R3-08, R3-12, R3-15, R3-22). |
| Q11 — measured resource need | No dev-machine budget is reintroduced. Grace overlap, restart storms, queued egress, retention and synchronized measurement matter (R3-16, R3-20–R3-23). |
| Q12 — build/start time | Content reuse buys speed but cannot substitute for predecessor-specific checks. Selector identity, bootstrap and bounded readiness affect the measured path (R3-06, R3-13, R3-18, R3-19). |
| Q13 — tick-only boundary | Bus commands/results and post-commit PG application address the direction. Job state, credential-free function APIs and delayed timers have incomplete event/state mappings (R3-05, R3-09, R3-10, R3-14). |

Main trade-offs: reuse saves build cost but requires fresh compatibility admission;
least privilege must coexist with narrowly authorized grace completion; short
core drains move latency and cost into durable executor queues; one egress door
concentrates policy and failures; longer compatibility retention buys rollback
availability at artifact/storage cost. None justifies changing the fixed owner
choices. The findings below specify the missing safety mechanisms or evidence.

### R3-01 — Revocation disables the promised executor grace

- **Severity:** BLOCKING.
- **Scenario:** F3/F4, Q1/Q3/Q4/Q7: the loader revokes every N lease before the epoch bump while an N job is running. During the promised grace, N cannot heartbeat, publish its result or write its done record; the current-epoch PG fence also rejects its old-epoch apply. The work either fails or is taken over before the advertised grace finishes.
- **Evidence:** OWNER-DECISIONS.md:4,6,16; docs/adr/010-container-generations.md:275,324-349; docs/features/instance/containers-design.md:184-187,235-238,271-277,506-515.
- **Suggested fix:** Define a separate, revocable completion capability for already-issued jobs, with a bounded job/version allowlist and no authority to mutate tick state or accept new work. Specify result admission, dependent door/adapter lifetime and confirmed executor exit before takeover; preserve both the stale-writer fence and the owner’s grace mechanism.

### R3-02 — FCALL-only ACLs cannot execute their own guarded writes

- **Severity:** BLOCKING.
- **Scenario:** F2/F3, Q6/Q7: an activated core calls the commit function with SET/XADD denied. The design itself says inner commands are ACL-checked as the caller, so the valid commit fails with NOPERM; granting those commands instead restores raw mutation authority and defeats the stated zero-stale-write boundary.
- **Evidence:** OWNER-DECISIONS.md:4; docs/adr/010-container-generations.md:274-275; docs/features/instance/containers-design.md:224-240,676; this review’s prior engine evidence at :363-378.
- **Suggested fix:** Name a store-enforced implementation that separates the permitted guarded operation from raw mutation privileges; a readable admission token is not that separation. Make the pinned-engine check prove BOTH a successful normal commit and refusal of raw writes on an authorized live connection, as well as stale-call refusal.

### R3-03 — The two epoch stores and pending PG commands have no handover protocol

- **Severity:** BLOCKING.
- **Scenario:** F3/F4, Q1/Q3/Q5/Q7: the loader commits the Valkey bump and crashes before updating Postgres active_holder (or updates PG first and crashes before Valkey). The reconciler reads only Valkey and can activate a holder whose PG writes all abort, or leave the other store accepting the wrong epoch. A committed but unapplied N pg.apply command also remains pending after the bump, yet its old epoch is rejected with no stated transfer of authority.
- **Evidence:** docs/adr/010-container-generations.md:265-270,516-520; docs/features/instance/containers-design.md:184-186,299-300,363-395,440,497-515.
- **Suggested fix:** Record and reconcile an ordered, fail-closed two-store epoch barrier, including bounded lock waits and crash cuts between the stores. Define how the new holder validates and re-authorizes previously committed commands with their original natural keys, without letting an old writer self-authorize.

### R3-04 — Re-activation can erase already committed new-holder state

- **Severity:** BLOCKING.
- **Scenario:** F3, Q4/Q5: C activates, commits several ticks and answers a message; the loader crashes in routing or health-wait. Recovery re-activates C by discarding state and loading the pre-bump handoff snapshot, restoring old offsets and losing committed work. With ONE mutable current snapshot, the recorded epoch/format alone may not even locate the overwritten handoff input.
- **Evidence:** docs/features/instance/containers-design.md:140,254-270,365-368,390-393; docs/adr/010-container-generations.md:65-66.
- **Suggested fix:** Persist activation completion and distinguish “never activated” from “already committed under the aimed epoch”; the latter resumes from the current committed snapshot, never the handoff again. Define a stable handoff reference retained only until first activation, and test loader death after first commit and after a settled answer.

### R3-05 — Executor writes cross the promised per-module schema boundary

- **Severity:** BLOCKING.
- **Scenario:** F3, Q4/Q8/Q13: the executor send worker inserts a web reply into conversations owned by the core, or writes an effect record into another module’s schema. Its own-schema-only role cannot do this, and the role table does not grant the executor any bus/PG capabilities; silently adding cross-schema rights violates the fixed isolation decision.
- **Evidence:** OWNER-DECISIONS.md:16,19; docs/adr/010-container-generations.md:449-454,489-491; docs/features/instance/containers-design.md:142,440,490-500,524-525,574-578.
- **Suggested fix:** Complete the executor role and schema ownership map, explicitly deciding whether core/executor are two roles of ONE schema-owning module. Route every cross-module mutation through its owner’s keyed bus command and define which store writer owns send delivery and settlement.

### R3-06 — Image reuse can bypass the required compatibility build gate

- **Severity:** BLOCKING.
- **Scenario:** F1/F6, Q3/Q12: a module image is reused because its source inputs are unchanged, but the previous healthy generation/readers or shared AsyncAPI contract changed. No build runs, so the predecessor-dependent checks do not run; even on a new image, an editable Dockerfile can omit an unselected or cached check stage. “The checks are a build stage” does not establish that every admitted generation passed them against its actual predecessor.
- **Evidence:** OWNER-DECISIONS.md:3,5; docs/adr/010-container-generations.md:219-222,237-247,283-287; docs/features/instance/containers-design.md:172,662,688-690.
- **Suggested fix:** Keep source-addressed image reuse, but require a trusted admission result bound to the full generation manifest, actual previous healthy readers, contract set and checker version. Specify how the loader selects/enforces the check stage on reused artifacts and prevents an unrun or cached stage from satisfying a new compatibility pair.

### R3-07 — Manifest compatibility is not the predecessor-reads-writes invariant

- **Severity:** BLOCKING.
- **Scenario:** F4/F5/F6, Q3/Q13: B emits a schema-valid new event type that A ignores, writes an incompatible PG value, or increments snapshot version for an additive change. A then rolls back onto current data and loses the pending job, misreads its row, or refuses the newer snapshot. Synthetic reader-manifest/schema comparisons cover neither actual producer output nor PG readers, and unknown-new-event handling and the compatibility-window boundary are undefined.
- **Evidence:** OWNER-DECISIONS.md:5,19; docs/adr/010-container-generations.md:283-289,479-494; docs/features/instance/containers-design.md:300-311,418-427,662,689-690.
- **Suggested fix:** Define compatibility epochs/window membership, safe snapshot-version changes, and old-consumer handling of new event types, including dual publication without duplicate effects. Check actual candidate writes against retained predecessor readers for snapshot, bus AND PG data/schema; choose the FULL-compatibility tooling and demonstrate positive and negative runtime-reader fixtures, not only manifest comparison.

### R3-08 — A local done record cannot recover an ambiguous external effect

- **Severity:** BLOCKING.
- **Scenario:** F3, Q3/Q4: an external tool applies an effect, then the executor dies before recording its result in Postgres. Takeover sees in-flight and “completes the delivery” by retrying; a destination that does not honor the key performs the effect twice. The message-row proof works for local web sends but does not make arbitrary remote effects once-only.
- **Evidence:** docs/adr/010-container-generations.md:339-346; docs/features/instance/containers-design.md:568-575,603-608; OWNER-DECISIONS.md:6.
- **Suggested fix:** Keep the key/done protocol, but require destination-side idempotency or a query/reconciliation contract for every once-only external effect. For an ambiguous unsupported destination, persist and report an uncertain outcome rather than automatically retrying and claiming no duplicate application.

### R3-09 — Job claims, zombie takeover and suspended waits lack a durable state machine

- **Severity:** BLOCKING.
- **Scenario:** F3/F4, Q4/Q5/Q13: an executor is paused or cannot renew a heartbeat, while another executor declares its job a zombie and starts it. The first resumes before confirmed death; both run the same job, and there is no atomic claim/attempt fence or durable continuation protocol. A suspended model request also cannot be resumed merely from a completion event unless a named component retains the request/correlation and accepts that completion.
- **Evidence:** docs/adr/010-container-generations.md:329-338,535-540; docs/features/instance/containers-design.md:271-277,329-333,424-442,634-636.
- **Suggested fix:** Define durable job/attempt states, atomic claim and takeover rules, heartbeat versus suspension semantics, result dedup and the completion-ingress owner. Specify how takeover executes a job pinned to an older version (retained image or proven compatible runner), and test delayed heartbeats, simultaneous claimers and completion after executor death.

### R3-10 — The five function plugins have no state or tool request path

- **Severity:** BLOCKING.
- **Scenario:** F1/F6, Q13: reminder receives a create request, or news must resume from lastFetchedAt after a switch. Functions have no credentials and may influence the body only with signals, but no input/read-projection, keyed state/schedule command or response protocol replaces their current storage, scheduler and tool APIs; their old behavior therefore cannot be ported using the written adapter contract.
- **Evidence:** OWNER-DECISIONS.md:10,13; docs/adr/010-container-generations.md:373-386,420-425; docs/features/instance/containers-design.md:149-154,429-442; src/plugins/reminder/index.ts:116-123,224-260; src/plugins/news/index.ts:169-202; src/plugins/calories/index.ts:100-104.
- **Suggested fix:** Define credential-free function inputs, state projections and correlated tool/result signals, with keyed state/schedule requests applied by the owning tick/module. Specify adapter acknowledgement/redelivery and function failure handling so a crashed HTTP invocation cannot lose or repeat a state transition.

### R3-11 — The shared internal network does not enforce caller identity

- **Severity:** BLOCKING.
- **Scenario:** F7, Q7/Q8/Q9: compromised generation code reaches a peer’s :7400/activate or /drain, claims another module’s name at the door, or calls Agent Vault’s network-visible injection/management surface directly. All peers share one internal network; removing internet routes neither authenticates callers nor enforces “only the door reaches injection” or “no module reaches the proxy/admin surfaces.”
- **Evidence:** docs/adr/010-container-generations.md:405-425,454-465; docs/features/instance/containers-design.md:31-41,53-66,92-105,678,693; the former instance Agent Vault integration:201,222-232; the former Caddy configuration:93-99.
- **Suggested fix:** Define authenticated workload identity bound to module/generation and loader-only control authorization, plus network/listener isolation for management, Docker proxy and vault injection. Derive door policy from that identity, not a caller-supplied name, and test a malicious peer bypassing Caddy and spoofing an allowed module.

### R3-12 — Core-only health can accept a generation that cannot do its work

- **Severity:** BLOCKING.
- **Scenario:** F4, Q3/Q10: the new workerd host, adapter or egress door fails after readiness while the core keeps committing empty ticks. With no inbound message the window passes; with an inbound message even a failed-turn disposition qualifies as a recorded outcome. The loader retains a whole generation whose executor/plugins cannot complete useful work, contrary to automatic fallback for an unhealthy generation.
- **Evidence:** docs/adr/010-container-generations.md:195-197,420-425; docs/features/instance/containers-design.md:200-223,281-294,660,672.
- **Suggested fix:** Keep tick commits as the core liveness proof, but add module/adapter/door/executor completed-work and failure signals to whole-generation health with explicit slow-job exclusions. Test a core that keeps ticking while each non-core module wedges or produces only failures, and distinguish common infrastructure outage from candidate-code failure.

### R3-13 — The planned pause is not bounded by the tick drain alone

- **Severity:** BLOCKING.
- **Scenario:** F2/F3, Q1/Q2/Q12: N drains on time, then lease revocation confirmation, the PG fence lock or C activation stalls. The holder has left and UI/conversation processing can pause indefinitely; switchDrainMs bounds only one phase, while Q1’s check merely measures other phases. Q2 also requires a named probe multiple, but the rewrite gives neither interval nor readiness deadline.
- **Evidence:** docs/features/instance/containers-inventory.md:247-248; docs/features/instance/containers-design.md:180-189,200-216,317-328,625-636,670-671; docs/adr/010-container-generations.md:99-107.
- **Suggested fix:** Give the planned handover one overall deadline covering drain, confirmed revocation, both fences, activation and routing, with a recorded rollback/maintenance disposition on expiry. Name the readiness interval/window and bound each wait by its remaining budget; preserve the separately decided rollback deadline.

### R3-14 — Delayed core.schedule events still have no durable home

- **Severity:** BLOCKING.
- **Scenario:** F3, Q4/Q13: a delayed SCHEDULE_EVENT is accepted, then the generation switches before it is due. The existing path is a process-local timeout, distinct from persisted scheduler fires; the rewritten event/state tables do not assign its due time or re-dispatch responsibility, so that event can disappear at exit despite Q13 promising coverage of every span-tick item.
- **Evidence:** docs/features/instance/containers-inventory.md:181,185-189; src/core/intent-applicator.ts:499-520; docs/features/instance/containers-design.md:429-442,682,702.
- **Suggested fix:** Map this path to a durable keyed due-time command handled through later ticks, with a named owner and restart-safe claim/advance rule. Add the delayed-event-before-switch/crash check and complete the event catalog for cognition/tool commands, job heartbeats and takeover control.

### R3-15 — Caddy pool discovery and current-route cutover are unspecified

- **Severity:** COMMENT.
- **Scenario:** F3/F4, Q1/Q3/Q10: a candidate becomes intake-ready or the current alias moves while Caddy retains an old upstream connection/DNS result. Without a pool membership/discovery mechanism, submissions can still reach a revoked old intake and UI traffic a dead holder; alias movement alone does not update a list of every intake-ready generation.
- **Evidence:** docs/features/instance/containers-design.md:54-55,118-125,241-253,295-302; the former Caddy configuration:101-105; this review’s pending validation at :510-513,574-575.
- **Suggested fix:** Name dynamic upstream discovery, membership removal ordering and connection/DNS refresh semantics, keeping the accepted authentication surface. Extend switch/rollback checks with persistent connections and a POST whose fsync succeeds but HTTP response is lost; verify retry uses the same key.

### R3-16 — Single-use bootstrap and lease rotation need a restart lifecycle

- **Severity:** COMMENT.
- **Scenario:** F7, Q5/Q8/Q11: OpenBao Agent or its container restarts after consuming the wrapped secret-id, or many module leases reach max TTL together. The reused bootstrap cannot authenticate a fresh agent, and simultaneous credential changes can restart the whole module set; the ADR says a restarted module re-authenticates but only loader-crash reconciliation describes re-issuance. Lease metadata also does not prove an existing PG/Valkey session expires when Bao is unavailable.
- **Evidence:** docs/adr/010-container-generations.md:43-47,456-469; docs/features/instance/containers-design.md:85-91,400-403,627,677; OWNER-DECISIONS.md:16.
- **Suggested fix:** Define loader-mediated replacement delivery, Agent token/secret-id custody and independent Agent/module restart behavior without persisting a reusable workload bootstrap. Test max-TTL rotation, renewal outages, live-session expiry/revocation and synchronized restarts; report the availability cost and stagger issuance where compatible with the owner’s policy.

### R3-17 — The Q8 check forbids the scoped secrets it deliberately injects

- **Severity:** COMMENT.
- **Scenario:** F7, Q8: a correct core starts with env_template-injected Valkey/PG credentials. Q8’s “no secret value in any module’s environ/data/logs” fails that correct implementation, although the owner forbids model keys in lifemodel and explicitly requires scoped-store credentials in its environment.
- **Evidence:** OWNER-DECISIONS.md:16; docs/adr/010-container-generations.md:456-465; docs/features/instance/containers-design.md:85-91,663,677,691.
- **Suggested fix:** Separate model-key absence in workload environment/data/logs from store-credential absence in docker inspect, and positively verify the approved scoped credentials in each role. Test that unvetted children get a scrubbed environment, while explicitly identifying the trusted Agent-supervised child that must receive it.

### R3-18 — Build-input identity omits manifest selector changes

- **Severity:** COMMENT.
- **Scenario:** F1, Q12: a commit changes the manifest’s Dockerfile selector from A to B while both files already exist in the same unchanged build context, or swaps named additional-context bindings. The stated context-tree hash can remain unchanged and reuse the wrong module artifact without a cryptographic collision; the “full input set” assumption overclaims what the described key contains.
- **Evidence:** docs/adr/010-container-generations.md:219-222,237-246,512-515; docs/features/instance/containers-design.md:113-117,688.
- **Suggested fix:** Define the canonical build identity to include the selected Dockerfile path/content and named additional-context mapping, not just their tree hashes. Test manifest-only selector/mapping changes and any admitted Compose build option while retaining the fixed no-build-args and digest-pin rules.

### R3-19 — Clean Compose start and proxy verbs need an ordered bootstrap contract

- **Severity:** COMMENT.
- **Scenario:** F1/F7, Q2/Q5/Q9/Q12: docker compose up -d starts empty PG, Valkey and sealed Bao volumes. The loader cannot yet issue module roles, use active_holder, load the commit library or run schema migrations; restart policies alone do not order or initialize those dependencies. A proxy configured for only create/start can also deny the build, inspect, network-alias, stop/kill and cleanup operations the controller needs.
- **Evidence:** docs/adr/010-container-generations.md:398-409,456-465,489-494; docs/features/instance/containers-design.md:20-23,70-71,81,106-112,173-174,491-495,700.
- **Suggested fix:** Write an idempotent bootstrap DAG for seed/Compose acquisition, store readiness, Bao initialization/unseal/engines, PG extension/schema/fence grants and Valkey library loading, including credentials and failure recovery. Pin a proxy verb/endpoint list for the complete build-and-controller lifecycle and verify clean-volume start and interrupted bootstrap with no manual preparatory step.

### R3-20 — The door is an availability and cost sensitivity point

- **Severity:** COMMENT.
- **Scenario:** Q1/Q3/Q11/Q12: the generation’s only egress door or Agent Vault stalls while many executor/function calls accumulate. Core ticks can remain cheap, but one unavailable chokepoint blocks every external job and retries can amplify paid calls and queued memory; nothing names timeout/backpressure, request-body limits or the component that reports this outage.
- **Evidence:** docs/adr/010-container-generations.md:414-425,437,594-597; docs/features/instance/containers-design.md:37-41,61-67,96-105,221-223,680.
- **Suggested fix:** Keep the single owned door and deferred rate limits, but define bounded queues/timeouts and failure reporting with keyed retry behavior across its restart. Measure door/vault latency, concurrency and outage recovery separately from tick latency and include their memory and duplicate-call cost in the reported load profile.

### R3-21 — Valkey durability and retention checks omit failure-pressure cuts

- **Severity:** COMMENT.
- **Scenario:** F3, Q6/Q11: disk fills or fsync stalls during inbound/commit traffic, or a slow adapter/executor still needs entries after the core’s offsets advance. AOF-always states the durability policy, but normal process restart alone does not prove the ack/failure boundary, and “trimmed as offsets advance” does not identify the minimum safe offset across all consumers and pending jobs.
- **Evidence:** docs/adr/010-container-generations.md:65-66,185-188,631; docs/features/instance/containers-design.md:137,245-246,424-427,594-612,675,680.
- **Suggested fix:** Define the pinned Valkey persistence/ack/error contract, including rewrite, disk exhaustion and visible write failure, and test those cuts rather than only restart. Specify trim eligibility across all consumer groups, outstanding job/result references and pending effects, with durable rebuild of consumers after restart and measured disk/write amplification.

### R3-22 — Manual snapshot copies have no capture or recovery consistency rule

- **Severity:** COMMENT.
- **Scenario:** F5/F6, Q3/Q10/Q11: a human restores an older tick snapshot after PG migrations or job effects have advanced. The design neither defines which snapshot is copied at every planned switch nor how offsets, trimmed streams and current PG rows remain usable with that copy; rollback creates its copy only after activation. “Manual recovery” can therefore leave unexplained missing events or replays, not a usable older boot.
- **Evidence:** OWNER-DECISIONS.md:5; docs/adr/010-container-generations.md:288-290,308; docs/features/instance/containers-design.md:181-193,303,342-355,365-368.
- **Suggested fix:** Define copy timing, immutable identity, contents, retention and prerequisites against the current PG/bus compatibility window, plus the warnings and refusal checks for manual restore. State what the artifact can and cannot recover without implying a PG rollback, and provide an owner-visible restore/refusal walk.

### R3-23 — The Q11 source scan and peak method cannot prove their stated check

- **Severity:** COMMENT.
- **Scenario:** Q11: the proposed source scan rejects “11 GB” anywhere, but the rewritten design/ADR themselves use that phrase to explain the removed constraint. Separately, summing independently measured per-container lifetime peaks is not a measurement of simultaneous aggregate use during a switch, and can miss the prolonged executor-grace overlap.
- **Evidence:** docs/features/instance/containers-design.md:30,649-651,680; docs/adr/010-container-generations.md:76-77,167-171,632-634; docs/features/instance/containers-inventory.md:257,278-279.
- **Suggested fix:** Check that no operative dev-machine memory limit remains, not that the amendment’s words disappear. Sample synchronized aggregate usage through candidate build/start, switch and executor grace, report per-container peaks separately, and name BuildKit/cache/volume costs rather than summing incomparable maxima.

### R3-24 — The charter and inventory still prescribe superseded choices

- **Severity:** COMMENT.
- **Scenario:** F1/F5/F6/F7, Q11/Q13: a planner follows the charter or inventory constraints and produces sealed/no-rebuild delivery, down migrations, no functions, or no current module split. Those sources still state these requirements even though the fixed decisions and rewritten ADR prescribe per-module images, expand/contract and five function plugins; the inventory also still asks whether the old legacy Docker instance command must work.
- **Evidence:** OWNER-DECISIONS.md:3,5,10,13,19; docs/charters/instance-1.md:15-27,45-50,85-88,129-132; docs/features/instance/containers-inventory.md:21-23,230,263,278-279; docs/adr/010-container-generations.md:8-13,152-170.
- **Suggested fix:** In the authorized amendment pass, sync the charter and inventory constraints with the fixed decisions and distinguish historical FACTs from target constraints. Explicitly state how the versioned static Compose file is shipped/updated without allowing a self-change to silently rewrite the trusted running infrastructure; this review changes neither input file.

### Round 3 dispositions

Recorded by the resolution pass (lifemodel-b0r.9.7), one entry per finding,
appended per part. The owner's eight decisions of 2026-10-12 are unchanged;
every fix below operates inside them. Part 1 (R3-01, R3-02, R3-03, R3-04,
R3-13) is first.

- **R3-01 — fixed:** ADR-010 Q4 (the grace is now a revocable COMPLETION
  CAPABILITY, not the general credential: at the switch the loader issues the
  old executor a `grace.<epoch>` Valkey ACL user carrying only `fence.complete`
  plus a done-record-only PG role, BEFORE revoking the general roles; the
  fence module admits completions only against the loader-loaded grace
  allowlist — the outbox's in-flight set committed in the leaving core's
  final snapshot — and the pinned version; takeover on both paths requires
  CONFIRMED executor exit first; dependent door/adapter lifetime dies with
  the executor, never before it), O4-2026 row, Q7 role table (executor
  general + completion-capability rows), Q7 delivery paragraph (revocation
  order), Decision outcome item 4. containers-design.md: contract point 7
  (the capability, its bounds, confirmed-exit takeover, dependent lifetime),
  hard edge 1 (capability named), planned-switch sequence (issue-then-revoke
  ordering; grace note), rollback bullets/diagram. Check: N-8 (new, walk
  `generations/executor-handover` + launcher unit); F2/F5(Q5) reference it.
- **R3-02 — fixed:** the guarded commit is no longer an FCALL'd Lua library —
  Valkey ACL-checks a script's inner commands as the caller, so the old claim
  was unsatisfiable. ADR-010 Q2 preamble (the COMMIT-FENCE MODULE: loaded by
  the loader on its `+@admin` connection, module version pinned with the
  loader release; internal writes execute under the module's OWN module user
  — the engine's module-user API, new assumption A8 — so a generation role
  carries `+fence.commit` and NO raw write command, and commit succeeds while
  raw writes are refused on the same authorized live connection), O2-A/O2-B
  rows, assumption A8 rewritten (with the recorded commit-gate fallback if
  module-user semantics change), Decision outcome item 2(a),
  consequences/Bad. containers-design.md: contract point 4 (fence module +
  the why + the pinned-engine three-way proof), hard edge 1, container view
  (fence.commit labels). Check: Q7 rewritten — proves commit-succeeds,
  raw-write-refused (NOPERM/ACL LOG), stale-call-refused on ONE live
  connection, on the pinned engine.
- **R3-03 — fixed:** ADR-010 Q2 preamble + new assumption A8b (the ordered,
  fail-closed two-store bump barrier: Valkey epoch FIRST, Postgres
  `active_holder` SECOND; sub-phases `bumping-valkey`/`bumping-pg` in the
  switch record; both steps idempotent; between them — and on any store
  disagreement — every `pg.apply` aborts; the PG lock wait bounded by
  `pgFenceLockTimeoutMs`), Decision outcome item 2(b) (a committed pre-bump
  `pg.apply` is re-applied by the NEW holder under its own epoch from the
  committed handoff record with its original natural key — never re-authorized
  by an old writer). containers-design.md: "Postgres mutations" (the barrier
  bullet), loader-crash reconciliation (`bumping-valkey`/`bumping-pg` cut
  branches), planned-switch and rollback diagrams (the PG step). Check: N-9
  (barrier walker + mid-barrier cut in `generations/loader-crash-cuts`).
- **R3-04 — fixed:** containers-design.md contract point 6 (activation is
  discriminated by a snapshot committed under the AIMED epoch: none → never
  activated → discard-and-rehydrate from the handoff; one exists → already
  activated/committed → resume from the LATEST aimed-epoch snapshot, NEVER
  the handoff again; the handoff input is POSITION-ADDRESSED — the leaving
  core's final `fence.commit` writes `handoff:aimed-<N+1>`, the switch record
  names it, the loader deletes it at `done`/`refused`), loader-crash
  reconciliation (post-bump branch follows the discrimination), rollback
  diagram (R3-04 note). ADR-010 Decision outcome item 2(b) and Q2 refinement
  carry the same rule. Check: N-10 (post-first-commit and post-settled-answer
  cuts in `generations/loader-crash-cuts` + launcher unit).
- **R3-13 — fixed:** ADR-010 open questions 5-7 (proposed values:
  `switchDeadlineMs` 120 000 — the planned handover's ONE overall deadline
  from drain to routing, expiry pre-bump aborts / post-bump hands to the
  rollback path bounded by the unchanged `rollbackDeadlineMs` 300 s;
  `readinessProbeIntervalMs` 2 000 + `readinessWindowMs` 60 000 — Q2's named
  fixed multiple, 30 × the interval; `pgFenceLockTimeoutMs` 5 000) and value
  decision 1 (the drain is one phase of the bounded handover).
  containers-design.md: contract point layout keeps the sequence in points
  1-7 with the overall deadline note in the planned-switch diagram and the
  expiry dispositions; loader-configuration table gains the four settings;
  every wait bounded by its remaining budget. Checks: Q1 rewritten
  (`switchDeadlineMs` asserted + expiry cases, walk
  `generations/switch-timeout`), Q2 rewritten (the named numbers), N-11 (the
  deadline state machine with the two expiry dispositions), F8 carries the
  new settings.

**Part 2 (R3-05, R3-08, R3-09, R3-14):**

- **R3-05 — fixed:** the executor's PG surface is now fully decided, with no
  cross-schema right added. ADR-010 Q7 role table (executor — general row
  rewritten: Valkey surface = `fence.complete` only — result/heartbeat/job
  publication, no `fence.commit`, no raw writes — and PG = three scoped
  grants), O2-B row (the same coherence), Q7 NEW paragraph "Schema ownership
  and the executor's grants": core and executor are TWO ROLES of ONE
  schema-owning module (the core module's `core` schema — message rows, done
  records, job records, schedules, delayed-event rows, motor registry, config
  rows); the executor's grants are EXACTLY `job`/`done_record` INSERT/UPDATE +
  `conversation_message` INSERT-by-key; every OTHER module's data is mutated
  only by its owner's keyed command (function modules' owning writer deferred
  to R3-10's path); send delivery (executor send worker, insert-by-key +
  `send.settled`) and inbound-outcome settlement (the holder's tick) have one
  writer each. containers-design.md: done records moved OUT of "the schema the
  effect belongs to" into the core schema's one `done_record` table; the
  Postgres-mutations writer list names the executor's complete scoped surface;
  the container-view module-set note carries the shared-schema rule. Check:
  N-12 (new — grant audit + cross-schema refusal + delivery/settlement
  ownership, unit + `generations/credentials` walk case).
- **R3-08 — fixed:** once-only for external effects is re-homed from the
  sender's key to a DESTINATION contract. ADR-010 Q4 side-effecting bullet
  (the effect manifest declares, per side-effecting command type, its
  destination idempotency class — `keyed` (the web reply's insert-by-key row
  is the model) / `query` (a reconciliation answer about the key) /
  `unprotected` (explicit, reviewable); UNDECLARED fails the build-stage
  manifest check; default side-effecting = yes unchanged; an ambiguous
  `unprotected` attempt is recorded `uncertain` and reported, NEVER
  automatically re-delivered — re-issue is the owner's decision from the
  report). containers-design.md: new "Destination idempotency classes" bullet
  (done-record states `in-flight | delivered | uncertain | settled`; no
  disposition claims "no duplicate application" for an unprotected ambiguous
  effect — it claims "reported as uncertain"), crash cut (2) gains the
  unprotected branch. Check: N-13 (new — manifest checker unit + both
  destination cases in `generations/executor-handover`).
- **R3-09 — fixed:** jobs now have a durable state machine. ADR-010 Q4 NEW
  bullet "Durable job/attempt state machine": durable `job` rows in the core
  schema (id = the effect id; states issued → claimed → running → settled |
  failed | suspended; attempt + lease owner), the claim = the consumer-group
  PEL entry (store-enforced, one consumer at a time), the heartbeat = a
  `fence.complete` form refreshing the claim's idle (interval + zombie
  threshold = loader settings), takeover = the loader's confirmed-exit
  sequence + `fence.claim` (the module's XAUTOCLAIM, min-idle = the threshold;
  refused on a fresh heartbeat and on a lost race), suspension = a registry
  row + XACK (no process held), the COMPLETION-INGRESS OWNER = the holder's
  tick loop (a completion event matches the suspended row by correlation id →
  re-issue under the same id; settled → no-op; unknown → counted + reported),
  result dedup by attempt, and pinned-version takeover via contract-compatible
  re-run or a one-shot retained-image container, named per job. Check: N-14
  (new — delayed heartbeats, simultaneous claimers, completion after executor
  death; unit + walk `generations/job-takeover`). containers-design.md:
  contract point 7 carries the same machine; the event table gains
  `control.takeover` and the heartbeat rule.
- **R3-14 — fixed:** delayed `core.schedule` events are durable due-time rows,
  not process timers. ADR-010 Q4 NEW bullet: the delay is committed with the
  tick's outbox as a keyed command; the holder's applier writes the
  delayed-event row (id minted at the decision, persisted with that commit;
  `due_at`; the event body) into the core schema; the tick's scheduler scan
  advances BOTH schedules and delayed events; a due row fires through the
  same fire-exactly-once pair as a schedule fire; due-at-past fires as seen at
  activation (principle 7); a switch or crash before due loses nothing (the
  row is current data the next holder's scan picks up). containers-design.md:
  event table gains `delayed.fired` (and `cognition.command`, completing the
  catalog per the finding's suggestion); the schedules rule extends to
  delayed-event rows; a catalog rule states every inventory-2.2 item maps to
  one event row or one named non-bus durable mechanism and none to a
  process-local timer. Check: N-15 (new — no `setTimeout` source scan, the
  switch-before-due and crash-before-due cases; unit +
  `generations/switch-messages` and `generations/holder-crash` walk cases).
**Part 3 (R3-06, R3-07, R3-18):**

- **R3-06 — fixed:** compatibility admission is decoupled from build reuse.
  ADR-010 Q1 (the tag = hash of the CANONICAL build identity, R3-18; the
  REUSE-DOES-NOT-SKIP-THE-CHECKS rule: an unchanged module is not rebuilt, but
  the loader derives the check stage separately from the build and re-runs it
  bound to the new generation's full manifest, the ACTUAL previous healthy
  generation's recorded readers, the current contract set and the checker
  version, even on a reused image; the pass is recorded as an ADMISSION RECORD
  keyed (image tag, manifest hash, predecessor set, contract set, checker
  version) and a reused image without a passing record for the NEW pair refuses
  admission; a cached or inherited result never satisfies a new pair), O1-2026
  option row + Serves paragraph, NEW assumption A11 (an image's compatibility
  is a property of its admission, not of its bytes; recorded forced-rebuild
  fallback if check stages stop being reproducible outside a build), Decision
  outcome item 1, consequences/Good. containers-design.md: NEW section
  "Compatibility admission and the window" (the admission record: fresh-build,
  reused-image, EDITABILITY guard — the check runner is loader-pinned content,
  NOT a stage of the contributor's Dockerfile, so a removed/omitted stage
  changes nothing and a cached stage cannot satisfy a new pair — and
  loader-crash-mid-check admits nothing), planned-switch diagram (the check
  stage re-run on reused images + the admission-record pass), container view
  (module-set bullet). Checks: N-16 (new — admission calculus unit:
  key derivation, stale-key refusal, no-record-on-interruption, Dockerfile
  with/without a check stage; walk `generations/reused-image-admission`);
  F1, F6(a/e), N-2, Q12 rewritten to reference the admission stage.
- **R3-07 — fixed:** the invariant is extended from manifest comparison to
  actual writes, and the window is decided. ADR-010 Q8 (unknown event types
  are a READER rule — ACK + drop by default, a consumer that could double-apply
  declares a contract EXCLUDE list checked both directions; dual publication
  shares the effect key so the destination contract absorbs the second
  delivery — publish twice, apply once; snapshot version changes are NAMED —
  minor = additive-with-default (old readers accept and ignore, proved by
  fixtures), major/removed/renamed/re-typed = format break refused at build;
  the compatibility window is EPOCH-STAMPED in the generation registry
  (snapshot version, contract set hash, PG schema version per generation),
  membership decided by admission runs against recorded readers, never commit
  distance; PG readers checked against DATA — the loader provisions a throwaway
  Postgres beside the build, seeded with the predecessor's captured row shapes
  (fixtures captured from the running predecessor's writes at commit time), and
  a read the rows do not satisfy fails), O8-2026, Decision outcome items 3
  and 8. containers-design.md: "Compatibility admission and the window" (the
  window's three uses: automatic rollback target refusal, maintenance boot
  pre-check, manual snapshot-copy restore re-check; the reader rules), the
  rollback bullets ("when the fallback cannot serve" now cites the decided
  membership and names the failing registry row), maintenance-mode bullet
  (registry shows admission records, version stamps, window membership).
  Checks: N-17 (new — RUNTIME-READER fixtures on actual candidate output for
  snapshot, bus AND PG: positive + negative pairs; PG leg on the real
  throwaway Postgres in `generations/predecessor-reads`, serialized legs unit
  in the launcher), N-18 (new — window membership decided by the registry,
  in-window boot serves / out-of-window refuses before any start, a
  rollback-target-outside-window opens maintenance with the named row;
  `generations/maintenance-boot-older` extended), F6 rewritten (five checks;
  the unknown-event rule exercised both directions).
- **R3-18 — fixed (COMMENT):** the build identity covers the manifest's
  selectors. ADR-010 A10 (the tag hashes the FULL CANONICAL build identity:
  selected Dockerfile PATH and content, each named additional context by NAME
  and tree id, and the resolved values of every admitted Compose build option,
  canonically serialized — a manifest-only selector/rebinding/option change
  changes the identity without a source change), Q1 tag formula, Decision
  outcome item 1. containers-design.md: container view module-set bullet, N-1
  rewritten (tag = hash of the canonical JSON; the selector-A→B,
  context-rebinding and build-option-change cases build a NEW image with
  unchanged trees; no-build-args and digest-pin rules retained). Check: N-1
  (rewritten) + the unit cases named there.

**Part 4 (R3-10, R3-11, R3-12):**

- **R3-10 — fixed (BLOCKING):** the five function modules have a complete
  credential-free input/read-projection/keyed-state contract replacing today's
  plugin storage, scheduler and tool APIs. ADR-010 Q6 (the adapter contract
  carries the state paths: input envelope with idempotency key + correlation
  id; reads = MANIFEST-DECLARED push projections (the owning module's
  `state.projection` events, latest held by the adapter, delivered inside the
  function envelope); writes = declared `state.set`/`state.delete`/
  `schedule.set`/`schedule.cancel` command forms keyed by the natural key,
  applied by the OWNING module's keyed-command applier — the core module's
  tick applier for all five, whose role already reaches its own schema; the
  correlated `state.applied` result is the function's acknowledgement), Q5
  amendment 2 (the port-form list; reminder's schedules become schedule-row
  writes the SAME scan advances), NEW assumption A12 (one synchronous answer
  per adapter delivery is enough; its invalidator and the named fallback),
  Decision outcome item 6, consequences/Bad. containers-design.md: container
  view (function state bullet), state-ownership row 18 (function-held state
  removed), the event table (`state.command`, `state.applied`, `state.projection`) +
  the catalog rule, F5 (the boot answers a live create through the new
  surface). Check: N-19 (new: fragment check + idempotency/dedup units +
  `generations/function-state` walk with switch-survives and
  crash-mid-invocation cases) and F5 (rewritten).
- **R3-11 — fixed (BLOCKING):** the shared internal network now authenticates
  its callers and its sensitive surfaces are structurally out of reach. ADR-010
  Q6 (NEW bullet "Internal caller identity is authenticated, not assumed":
  loader-minted SPIFFE-like WORKLOAD IDENTITY mTLS certificates naming module
  AND generation; the door/adapter/control surfaces validate the peer and
  derive policy from the VERIFIED identity, never a caller-supplied name; a
  separate per-surface LISTENER NETWORK set — loader control leg (containers'
  `/activate`/`/drain`/probes: loader identity only), the Docker-proxy leg
  (socket only in the loader's container), and the Agent Vault injection leg
  (the door's role only, never a network-visible Agent Vault surface); no
  peer can claim another module's name), the door bullet (vault reached
  THROUGH the door over the door-only leg), the Q6 title paragraph, O6-2026
  (pattern + evaluation), consequences/Good, Decision outcome item 6.
  containers-design.md: container view (hard edge "Internal caller identity"
  + diagram leg annotations), Q8/Q9 checks rewritten (structural
  unreachability, authenticated peers). Check: N-20 (new — container-spec
  unit: one network attachment + identity files; the authorization matrix
  unit: identity→policy, name/identity mismatch, foreign-generation
  certificate; walk `generations/internal-identity`: no-cert, spoofed-name,
  stale-cert, control-leg, proxy/vault-unreachable cases).
- **R3-12 — fixed (BLOCKING):** health is WHOLE-GENERATION. ADR-010 Q3 option
  O3-2026 (failure sentence: health reads the executor's, the adapter's and
  the door's LOCAL work-and-failure counts; upstream excluded; a static
  infra outage holds the window rather than triggering rollback), Decision
  drivers bullet F4, Decision outcome item 3, consequences/Good.
  containers-design.md: contract point 3 rewritten ("Completed work" for the
  health window): core tick commits stay the core liveness proof, but
  executor settled/failed LOCAL-job counts (from the done records,
  R3-05/R3-09), adapter/function-host delivered/failed invocation counts,
  and door served/refused counters are the window's failure surface — N
  consecutive LOCAL failures with zero successes since activation = wedge →
  window fails; a live heartbeat (a slow/suspended job) is the EXCLUSION
  (named in the takeover report); an idle module is health-neutral; an
  UPSTREAM-classified failure never fails the window; a failed send/turn is
  failure evidence while the inbound clause requires a POSITIVE outcome; a
  static component outage (observed on the loader's own admin connections)
  HOLDS the window's clock and past it opens maintenance with the outage
  named (a rollback never runs healthy code onto a broken store); planned-
  switch diagram note. Checks: N-21 (new — the health classifier unit +
  `generations/whole-health` with the seven wedge/exclusion/upstream/
  infra-hold cases), F4 rewritten (whole-generation cases named), Q3
  extended (the trigger's provenance).


**Part 5 (the COMMENT findings R3-15..R3-24, R3-18 resolved in part 3).**

- **R3-15 — fixed (cheap docs change):** Caddy's upstreams are DISCOVERED, not
  pinned lists. containers-design.md container view, NEW hard edge "Caddy's
  upstreams are DISCOVERED": both routes resolve through Docker network aliases
  read by Caddy's dynamic upstreams (`dynamic a <alias>` — per-request
  resolution, no stale list, no reload); the submit route's MEMBERSHIP is
  loader-ordered — the candidate's `intake-ready` alias published at its
  intake-ready pass, the leaving generation's removed only AFTER its confirmed
  exit (removal never precedes the stop it implies); the alias move IS the
  cutover, so persistent upstream connections and DNS caching cannot pin a
  route to a dead/revoked container; the lost-response POST retries with the
  SAME idempotency key and is absorbed by the inbound dedup ring. The accepted
  authentication surface (pinned hosts, forward_auth) is unchanged. Check:
  N-22 (new — membership ordering unit + `generations/switch-messages`
  extended with the persistent-connection and lost-HTTP-response cases).
- **R3-16 — fixed (cheap docs change):** ADR-010 Q7, NEW bullet "Bootstrap and
  lease rotation have a RESTART lifecycle": the single-use wrapped secret-id is
  CONSUMED at first authentication and no container spec carries a reusable
  bootstrap — the loader's reconciliation re-issues a FRESH wrapped secret-id
  for every module it (re)starts (an Agent crash takes its supervised module
  down; restart policy + reconciliation re-bootstrap); renewal/expiry are
  INDEPENDENT of OpenBao's availability (a pre-outage lease serves its term,
  so existing PG/Valkey sessions do not expire because Bao is down; an expired
  renewal fails VISIBLY and re-bootstraps when Bao returns); issuance is
  STAGGERED by the new loader setting `leaseIssueStaggerMs` (30 000, proposal),
  so the module set's leases do not all reach max TTL together, and a
  synchronized rotation is a named, measured availability event. Check: N-23
  (new — `generations/credential-rotation`: max-TTL rotation, renewal outage,
  Agent-restart re-authentication with no persisted bootstrap, staggered
  issuance, session expiry observability) + the loader-configuration table row
  and F8's setting list.
- **R3-17 — fixed:** Q8 rewritten to be scoped BY KIND instead of forbidding
  the approved injections. containers-design.md Checks, Q8: (i) MODEL-KEY
  absence — the made-up key's value in NO module's environ/data/logs (the
  owner's rule); (ii) STORE-CREDENTIAL visibility — OpenBao-issued credentials
  in NO `docker inspect`, no data file, no log, while VERIFIED PRESENT,
  positively and per role, in exactly the TRUSTED Agent-supervised module
  process environment the owner's policy names, and every OTHER child process
  sees a SCRUBBED environment (the spawned-child fixture now asserts the
  distinction); (iii)-(v) the function zero-credential, structural-surface and
  switch-revocation assertions unchanged. `docker inspect` invisibility stays
  N-4. The prior blanket "no secret value in any module's environ" — which
  failed the owner-approved envconsul delivery — is gone.
- **R3-19 — fixed (cheap docs change):** containers-design.md container view,
  NEW hard edge "Clean-start bootstrap is an ordered, IDEMPOTENT DAG": the six
  ordered steps (compose seed → store readiness → OpenBao init/unseal/engines →
  PG extensions/schemas/DDL-role migrations/fence grants → Valkey fence
  module/epoch record/ACL users → module-role re-issuance + generation
  re-creation from durable records), each idempotent, the loader's bootstrap
  progress recorded so an interrupted bootstrap RESUMES from the record (no
  manual preparatory step, no partial store presented as ready). ADR-010 Q6's
  loader/proxy bullet gains the PINNED verb/endpoint list for the complete
  lifecycle (build, create, start, inspect, network attach/alias, stop, kill,
  remove, logs) — not just create/start. Checks: N-24 (new — clean-volume
  start + interrupted-mid-DAG resume + zero proxy refusals across every
  generation walk) and the proxy verb-list human judgement extended to the
  full lifecycle list.
- **R3-20 — answered with design text (no mechanism change):** the single
  owned door and the deferred rate limits stand (owner decisions); what was
  missing is named. ADR-010 Q6's door bullet: per-module BOUNDED queues and
  request timeouts (settings) + a request-body limit at the door's ingress; a
  full/waiting queue is a VISIBLE failure reported by the door itself, and the
  outage is NAMED by the whole-generation health window's door counters
  (R3-12/N-21 case d) and the loader's observations; retries carry the job's
  idempotency key, so a retry across a door/vault restart is absorbed by the
  destination contract (R3-08: reported, never silently re-fired). Q11 now
  measures door/vault latency, concurrency and outage recovery SEPARATELY from
  tick latency, with queued/retried calls' memory and duplicate-call cost in
  the reported load profile. No new check id: the proof rides N-21(d) (wedged
  door → window fails) and the extended Q11 measurement.
- **R3-21 — fixed (cheap docs change):** containers-design.md "Bus events",
  NEW paragraph "The Valkey persistence and retention contract under
  pressure": `appendfsync-always` is the ACK boundary in BOTH directions — a
  stalling fsync (disk pressure, AOF rewrite collision) or disk exhaustion is
  a VISIBLE write failure (intake's non-202, the tick's paused commit), the
  loader treats it as a static-infrastructure outage (window holds →
  maintenance with the outage named, R3-12); TRIM eligibility = the MINIMUM
  SAFE OFFSET across ALL consumer groups AND outstanding references (claimed
  or suspended jobs' input entries, unsettled pending effects' done records,
  un-XACKed parked function deliveries) — never the holder's progress alone;
  consumer groups rebuild from the snapshot's recorded offsets (Q6). Check:
  Q6 extended with the failure-pressure cuts (stall, disk-full, trim-floor
  with a slow consumer + suspended job, consumer rebuild) in
  `generations/valkey-restart`.
- **R3-22 — fixed (cheap docs change):** containers-design.md rollback
  section, NEW bullet "The snapshot COPY is an atomic, immutable capture":
  WHICH snapshot is copied is decided — the FINAL PRE-BUMP handoff snapshot
  (`handoff:aimed-N+1`) WITH its matching PG dump taken during the pause, the
  pair consistent at one logical point (the dump covers every keyed mutation
  applied through the handoff position; committed-but-unapplied effects ride
  the snapshot's outbox and re-apply idempotently via the R3-03 mechanism);
  the copy is an immutable PAIR (`copy-<generation>-<epoch>`: content hash,
  generation id, epoch, format versions, bus position), never split — a
  restore refuses a half-pair and refuses to run while any generation serves;
  retention = `snapshotCopyRetention` (new loader setting, 3, proposal);
  prerequisites checked at RESTORE time (the window re-check already in
  place); stated plainly what it can and cannot recover (post-copy bus
  entries are LOST, listed as unreconciled in the restore report; no PG
  schema rollback is implied). Check: N-25 (new — pair-consistency calculus +
  `generations/snapshot-copy-restore`) and the loader-configuration row.
- **R3-23 — fixed:** Q11's method corrected. containers-design.md Checks,
  Q11: the source check asserts NO OPERATIVE dev-machine memory LIMIT remains
  (no memory cap on the generation set in compose/loader/motor surfaces) —
  not that the amendment's explanatory words disappear, since the documents
  legitimately mention the dropped 11 GB premise; the measurement is a
  SYNCHRONIZED sampler recording the AGGREGATE memory continuously through
  candidate build/start, switch and executor grace (peak aggregate from
  simultaneous samples — never a sum of independently measured per-container
  maxima, which misses simultaneous use and the grace overlap), with
  per-container peaks reported separately and BuildKit/builder-cache/volume
  costs named as line items. Walk leg unchanged (`generations/peak-memory`),
  method changed.
- **R3-24 — OWNER (charter amendment; not edited here):** the charter still
  prescribes superseded choices (no functions, no module split, reversible
  up/down migrations, sealed/no-rebuild delivery implied) and the inventory
  quotes them. The four inventory lines that quote the superseded charter text
  — the status paragraph's "the core is not cut into modules"/"reversible
  format migrations" (inv :21-23), constraint 1's charter quotation (inv
  5.1), the section-3.2 "must keep working legacy Docker instance command" question (inv :230)
  and the open-question "11 GB machine" item (inv :278-279) — are each marked
  **PENDING CHARTER AMENDMENT — R3-24** with the superseded facts named and a
  "plan from the decisions and the rewritten ADR" pointer; nothing else in
  the inventory was changed, and the CHARTER ITSELF is untouched (the
  coordinator amends it with the owner). The Compose-file shipping/updating
  question is answered in the design where the decision already lives: the
  compose file is versioned IN THE REPO and changes to it arrive only through
  a commit + generation — the loader never silently rewrites the running
  infrastructure (ADR-010 O6-2026; the old O6-A rejection's reason dissolved).
  OWNER QUESTION for the amendment pass: confirm the charter's outcome-5/
  delivery wording is rewritten to the per-module-image, expand/contract,
  five-function shape at the same pass that syncs the inventory's marked
  lines.

### Round 3 verification

Verification of **aafa644..2f41701**, against `bb36b96`, for
**lifemodel-b0r.9.7**. One document verification pass, with two read-only
cross-check lanes; no new review round. The owner's eight decisions remain
fixed. CLOSED means the written mechanism handles the original scenario and
its proposed check exercises that mechanism; it does **not** mean runtime
acceptance. No product tests, Docker walks or runtime probes ran. The automatic
transition document gate did not run.

**Verdict: BLOCK — 6 CLOSED, 8 STILL OPEN; 3 additional blocking regressions.**
References below are to the reviewed design and ADR at `2f41701`.

- **R3-01 — STILL OPEN:** grace grants only done-record PG writes, so an in-flight web send cannot INSERT its delivery row; the retained adapter's general lease is also revoked without replacement authority, and direct PG grants lack the Valkey completion allowlist (design:274-279,425-440,956-963); N-8 must prove slow send/parked function completion after general revocation, reject non-allowlisted PG writes, and preserve the ongoing executor through credential handoff rather than an Agent-triggered restart.
- **R3-02 — CLOSED:** the pinned commit-fence module executes guarded writes as its own module user while the caller lacks raw-write authority (ADR:A8, design:350-371); Q7 explicitly checks normal commit success, raw-write ACL refusal and stale-call refusal on the same authorized live connection.
- **R3-03 — STILL OPEN:** the ordered bump/reconciliation and pending-command transfer are specified, but disagreement refusal is only asserted: the concrete PG transaction checks only `active_holder`, allowing an old transaction to finish while that row still holds N after the Valkey bump (design:699-705,866-875); define a store-enforced closed-apply barrier and make N-9 cut with an already-open old transaction, not just disagreeing scalar records.
- **R3-04 — CLOSED:** aimed-epoch snapshot existence selects latest committed state instead of reloading handoff, whose input now has a stable key (design:395-420); N-10 covers loader death after first commit and after a settled answer; the separately introduced killed-drain missing-key case is R3-V2 below.
- **R3-05 — CLOSED:** core/executor are explicitly two roles of the one `core` schema owner, with a complete three-table executor grant and separate delivery/settlement writers (ADR:759-775); N-12 audits that map and proves cross-schema/other-table refusal; grace remains independently blocked by R3-01.
- **R3-06 — CLOSED:** loader-pinned admission runs against every fresh or reused image, bound to the full manifest, actual predecessor readers, contracts and checker version, independently of contributor Dockerfile stages (design:468-500); N-16 tests stale admission, interruption, all-image reuse and omitted check stages.
- **R3-07 — STILL OPEN:** the actual PG check runs CANDIDATE readers on PREDECESSOR rows, the reverse of predecessor-reads-candidate-writes (design:540-545, N-17); run retained predecessor readers on actual candidate-produced PG data after candidate migrations, with positive/negative fixtures and semantic recovery of pending events, not only schema decoding or unknown-type ACK/drop.
- **R3-08 — STILL OPEN:** unprotected ambiguity now correctly becomes `uncertain`, but the accepted `query` class does not require terminal proof: a negative query can precede a killed sender's still-running remote effect (ADR:529-539); require definitive non-application or keyed retry protection, otherwise uncertainty, and extend N-13 beyond keyed/unprotected to query-positive, terminal-negative and still-in-flight-negative cuts.
- **R3-09 — CLOSED:** durable job/attempt/correlation rows, PEL claims, heartbeat refresh, confirmed exit before takeover, suspended-row-before-XACK, holder-owned completion ingress and pinned-runner selection address the original race/continuation scenario (ADR:455-491); N-14 directly exercises delayed heartbeats, simultaneous claimers and completion after executor death; task criteria must also assert keyed dedup on duplicate logical-job entries.
- **R3-10 — STILL OPEN:** state/tool forms exist, but projections publish only on content change and latest state lives in the adapter, with no named fresh-adapter reconstruction/readiness barrier (ADR:697-712); N-19 assumes re-publication rather than defining it; specify core-owned bootstrap projections and correlated external-tool routing, then check unchanged news `lastFetchedAt` across restart, distinct updates to one natural key, and web-search request/result as well as reminder create.
- **R3-11 — STILL OPEN:** verified identity fixes spoofing, but every module is restricted to exactly one internal attachment while the door must reach a separate injection leg unreachable from that network (design:105-123, N-20); name a role-specific attachment/listener matrix and pair the malicious-peer refusals with a successful authorized-door injection call.
- **R3-12 — STILL OPEN:** lifetime zero-success predicates admit a module that succeeds once and then wedges while the core keeps ticking (design:324-337); suspended waits also cannot supply the claimed live PEL heartbeat after XACK (design:326-328,455-456); use rolling failure/staleness bounds and durable suspension/expiry evidence, and add success-then-wedge plus suspended-without-heartbeat cases to N-21.
- **R3-13 — STILL OPEN:** deadlines/readiness values now exist, but pre-bump expiry promises N serves on even after N's core has exited and its leases may be revoked (design:272-276,1015, N-11); specify bounded post-drain compensation/restart with fresh roles or recovery/maintenance, and test expiry after core exit and during revocation, not just stalled post-bump activation.
- **R3-14 — CLOSED:** delayed intents have a keyed core-schema due-time row, holder scan and outbox/fire-advance recovery pair rather than a process timer (ADR:504-517, design:889-904); N-15 covers switch-before-due, crash-before-due and same-id replay with exactly one fire.

**Additional blocking problems introduced by the fixes** (not new rounds of
unrelated review; defects already covered by an OPEN finding stay under that
finding's id):

- **R3-V1 — Mandatory full-database backup on the handover path:** R3-22 now requires a matching whole-Postgres dump during EVERY switch/rollback pause (design:575-603), without a capture step/budget in the sequence or a consistent cut against continuing executor PG writes; N-25's pair/position assertions do not define that synchronization. This is disproportionately heavy for manual tick-snapshot recovery. Lighter alternative: keep the immutable tick copy, permit restoration only against compatible current PG and retained bus positions, and refuse/report unrecoverable cuts; offer a separately coordinated full-data backup/restore in owner-controlled maintenance if needed. If the full pair is retained, explicitly bound capture, coordinate all writers and preserve later-effect evidence before restoring it.
- **R3-V2 — No handoff key after a killed drain:** only the leaving core's FINAL commit creates `handoff:aimed-<epoch>` (design:415-418), yet a drain overrun may kill it before that commit (design:273,643-645); activation unconditionally needs that key when no aimed-epoch snapshot exists. Lighter alternative: before bump, have the loader pin the last existing committed snapshot as the recorded handoff on this branch; extend N-10/Q4 with kill-before-final-commit, then activation and first commit, asserting no lost or repeated outcome.
- **R3-V3 — Minor-version acceptance contradicts decision 8:** the owner requires a NEWER snapshot version to refuse; the fix instead lets old readers accept a MINOR version bump (ADR:837-844, design:534-539). Lighter alternative: leave the snapshot format version unchanged for additive/defaulted fields; use a separate schema/release revision if needed, and preserve strict newer-format refusal. Add a higher-minor-version refusal fixture alongside unchanged-version additive-field acceptance.

**Checks readiness for `to-stages`: NOT COMPLETE.** F1-F8, Q1-Q13 and
N-1..N-25 now have useful execution-placement mappings, including CI-only real
engines and named human judgements. Placement is not behavioral completeness.
The OPEN lines above name the missing mechanisms and checks; R3-V1..R3-V3 add
capture/concurrency, killed-drain and owner-version cases. Stage criteria must
pair successful authorized/normal operation with each refusal/failure cut and
must not treat synthetic state-machine predicates as proof of live store,
credential or routing behavior. Settle those contracts before tasks rely on
them. The owner-required executor research and outcome-6 Motor authority decision
remain explicit prerequisites, and R3-24's governing charter amendment remains
pending; inventory warning labels do not substitute for that amendment.


### Round 3 verification dispositions

Recorded by the round-3 verification pass 2 (lifemodel-b0r.9.7, part 6), one
entry per STILL OPEN finding and per verification problem assigned to the
part, in the order R3-01, R3-03, R3-13, R3-V2. The owner's eight decisions of
2026-10-12 are unchanged; every fix below operates inside them. Sections are
cited as design (`containers-design.md`) / ADR (`adr/010-container-generations.md`).

- **R3-01 — FIXED:** the grace authority now covers every write an in-flight
  job needs, on both stores, and reaches the running processes without a
  restart. design contract point 7 (the capability is the Valkey
  `grace.<epoch>` user carrying only `+fence.complete` PLUS a Postgres role
  with EXECUTE on two loader-created SECURITY DEFINER grace functions —
  `grace.done_record` and `grace.send_row` — with NO direct table grants;
  the send-row leg is REQUIRED because a slow web send's delivery IS the
  `conversation_message` insert-by-key row and its done record lands in the
  same transaction, B04); the allowlist backs BOTH stores (the fence module
  reads it in Valkey; the loader's DDL role writes a `grace_allowlist` table
  in the bump transaction for the PG functions), so a non-allowlisted PG
  write is refused by the store like a non-allowlisted Valkey completion;
  the retained old channel adapter gets a matching capability at the same
  step (XREAD on `bus` + a `fence.complete`-scoped append) — its general
  lease is revoked with the rest, so the consumer kept alive now holds
  replacement authority; delivery is the one narrow exception to decision
  7's envconsul rule — loader-minted, handed to the RUNNING executor and
  adapter over the loader-authenticated control leg (`:7400/grant`), never
  through the Agent's `env_template`, so restart-on-credential-change never
  fires and the running old executor is preserved through the handoff.
  ADR: Q4 grace bullet, Q7 role table (executor completion-capability row
  rewritten; new channel-adapter completion-capability row), Q7 delivery
  paragraph, Q4 dependent-lifetime bullet, Decision outcome item 4.
  design: planned-switch sequence (issue/revoke lines, grace note),
  contract point 4 (revocation exceptions), contract point 7, B04
  done-record bullet. Check: N-8 extended — slow send settles during the
  grace after general revocation (`grace.send_row` + done record in one
  transaction), parked function completion through the retained adapter's
  capability after general revocation, non-allowlisted PG write refused,
  the old executor's container asserted un-restarted across the grant
  (`generations/executor-handover` + launcher unit on both stores).
- **R3-03 — FIXED:** the bump is now a store-enforced CLOSED-APPLY barrier
  whose closure precedes the fence, because the applier's `active_holder`
  check alone cannot stop a transaction already holding its FOR SHARE.
  design B04 "Database-side active-epoch fence, closed into a barrier" and
  ADR Q2 barrier paragraph + new assumption A8b: phase `closing-apply` —
  the loader takes and HOLDS the exclusive `active_holder` row lock
  (`lock_timeout = pgFenceLockTimeoutMs`), waiting out every already-open
  epoch-N apply transaction (it commits pre-bump under the still-consistent
  epoch N, or the hold times out and the switch aborts pre-bump); with the
  hold granted no epoch-N apply transaction is open and no new one can take
  FOR SHARE — the apply path is closed BY THE ROW LOCK; then
  `bumping-valkey` (the fence point, hold kept open across it), then
  `bumping-pg` (the held transaction commits epoch N+1 and blocked appliers
  wake, see N+1, abort — fail closed). Sub-phases
  `closing-apply|bumping-valkey|bumping-pg`; all idempotent; a fresh loader
  re-enters the barrier AT THE HOLD at any mid-barrier cut (the crash
  released it; no epoch-N applier is alive — the old core exited before the
  bumps). ADR: open question 7 (the setting bounds hold AND update), Q2,
  Decision outcome item 2(b). design: planned-switch and rollback diagrams,
  B04 fence bullet, loader-crash reconciliation (phase list; the
  `bumping-valkey`/`bumping-pg` cut branches re-enter the barrier).
  Check: N-9 extended — the ALREADY-OPEN OLD TRANSACTION cut (an old applier
  open mid-DML at barrier start: the hold waits it out or aborts pre-bump;
  no old apply commits between the bumps; blocked appliers abort after the
  PG bump) plus the mid-barrier re-entry cut (`generations/loader-crash-cuts`
  with an open old transaction + launcher barrier-walker fixture); Q5's
  branch list carries `closing-apply`.
- **R3-13 — FIXED:** pre-bump expiry is no longer one disposition, and "N
  serves on" is never promised after N's core has exited. ADR open question
  5 and design (planned-switch deadline note; loader-configuration
  `switchDeadlineMs` row): expiry BEFORE the core's exit (drain or earlier)
  aborts the switch — candidate discarded, epoch never moved, N serves on;
  expiry AFTER the exit but pre-bump (during revocation confirmation, the
  barrier hold or activation prep) is bounded POST-EXIT COMPENSATION — the
  loader revokes/drops the completion capabilities, re-issues N's module
  roles through the normal bootstrap path (fresh single-use wrapped
  secret-ids, R3-16), restarts generation N under the SAME epoch
  intake-first — ONE attempt inside a fresh `switchDeadlineMs` window;
  that expiry, or a compensation that cannot restart N (a failed role
  re-issue), opens MAINTENANCE with the report naming the step. Expiry
  at/after the bump unchanged (fence stands, rollback path bounded by
  `rollbackDeadlineMs`). ADR Q2's barrier step 1 cross-references the same
  disposition for a timed-out barrier hold after core exit. Check: N-11
  extended — four cases (stalled drain, expiry during revocation
  confirmation, post-exit pre-bump expiry with the compensation observed,
  stalled post-bump activation), unit state machine + walk
  (`generations/switch-timeout`); Q1's expiry list carries the
  post-exit case.
- **R3-V2 — FIXED (the lighter alternative, taken):** the loader PINS the
  last existing committed snapshot as the recorded handoff on the
  killed-drain branch. design contract point 6 pin rule: a drain overrun
  SIGKILLs the leaving core before its final `fence.commit`, so the
  dedicated `handoff:aimed-<N+1>` key may not exist; on that branch —
  confirmed kill, BEFORE the bump — the loader copies the current epoch-N
  snapshot key to the handoff key atomically (no concurrent writer), and
  the switch record names the handoff SOURCE (`final-commit` vs
  `pinned-pre-bump`); the abandoned tick replays once from the pinned
  snapshot's offsets, sends and effects settle from done records, and
  activation follows the SAME discrimination rule. design: planned-switch
  SIGKILL note, rollback drain-overrun bullet (same pin). ADR: Q4 drain
  bullet, Decision outcome item 4. Check: N-10 extended with the
  KILL-BEFORE-FINAL-COMMIT cut — pin, bump, activation, first commit, the
  abandoned tick replaying exactly once with no lost or repeated outcome;
  Q4's row carries the same cut on the switch path
  (`generations/loader-crash-cuts` / `generations/switch-messages` + the
  launcher walker's pin fixture).


Round-3 pass-2 additions (part 7), one entry per item assigned to the part, in
the order R3-07, R3-08, R3-V1, R3-V3. The owner's eight decisions are
unchanged; the lighter alternative is TAKEN where the verification line
offers one.

- **R3-07 — FIXED:** the PG compatibility check now runs BOTH directions on
  the same loader-provisioned throwaway Postgres seeded with the
  predecessor's captured row-shape fixtures: leg 1 keeps the candidate's
  reader queries against predecessor rows; leg 2 (the invariant's own
  direction) applies the candidate's expanding migrations, drives the
  candidate's recorded write paths over the same fixtures, and runs the
  RETAINED predecessor's recorded reader queries against that
  candidate-written data — positively (every recorded predecessor read still
  succeeds) and negatively (a candidate removal/rename/narrowing that breaks
  a recorded predecessor read fails the admission). Beyond the envelope
  rules (decode, ACK+drop, EXCLUDE), pending-event fixtures prove SEMANTIC
  RECOVERY: a pending record written by either side (suspended job,
  unsettled effect + done record, delayed row) is re-read and re-issued
  exactly once under the same effect id by the other generation's readers;
  a shape that decodes but loses a key/correlation or double-issues fails.
  ADR: Q8 Tolerant Reader bullet (decoding-is-not-recovery note), Q8 PG
  readers bullet (both directions), Decision outcome item 3. design: "Reader
  rules for cross-generation data" (PG bullet restructured into both legs +
  new pending-events bullet), F6 (a) extended, N-17 (c)+(d) extended.
  Check: N-17.
- **R3-08 — FIXED:** the `query` idempotency class now requires TERMINAL
  proof for its negative answer. ADR Q4's once-only bullet and design's
  destination-idempotency bullet: a `query` declaration carries a
  TERMINALITY assertion naming which answers are DEFINITIVE (a negative
  answer is definitive only where the destination guarantees no
  still-running effect can apply LATER); a `query` entry without the
  assertion is refused at the manifest check. An ambiguous query attempt
  resolves three ways: "applied" → recover the result, settle, no
  re-delivery; DEFINITIVE negative → re-deliver once under the same key;
  non-terminal negative (the killed sender's request may still land) → done
  record `uncertain` + report, exactly like `unprotected` — never an
  automatic re-delivery behind a possibly-still-running remote effect.
  design's crash-cut (2) carries the same three-way split. ADR: Q4 once-only
  bullet, Decision outcome item 4's R3-08 reference unchanged. design:
  destination idempotency classes, crash cuts (2). Check: N-13 extended —
  missing-terminality build refusal + the three query cuts (query-positive,
  terminal-negative, still-in-flight-negative), each paired with its
  success/refusal side.
- **R3-V1 — FIXED (the lighter alternative, taken):** the mandatory
  full-Postgres dump per switch/rollback pause is REMOVED. The snapshot COPY
  is now the immutable tick snapshot alone (the final pre-bump handoff
  snapshot, identified with the PG schema/version stamp read at the copy
  instant) — no dump step, no capture budget on the switch/rollback path.
  Restoration runs only against compatible CURRENT Postgres (the restored
  snapshot's committed outbox re-applies keyed mutations onto current data
  idempotently by natural key, the R3-03 re-apply mechanism; replayed
  entries settle from the CURRENT done records/message rows, the R3-V2
  replay rule — nothing external re-delivers) and retained bus positions; an
  unrecoverable cut — a copy whose bus position lies outside retained bus
  retention, or a PG stamp the restored outbox cannot restore against — is
  REFUSED and reported, not guessed. The FULL-DATABASE backup/restore is
  specified as an OWNER-RUN maintenance action only: a separately
  coordinated, bounded capture at one consistent cut (intake stopped, core
  drained, executor PG writes paused at the recorded cut), later-effect
  evidence preserved before restore — never a switch step, never automatic.
  ADR: Q3 decided paragraph (snapshot-only copy), Decision outcome item 3.
  design: rollback intro (the loader prepares only the tick copy), the
  rewritten snapshot-COPY bullet + new owner-run-backup bullet, loader
  configuration `snapshotCopyRetention` (copies, not pairs). Check: N-25
  rewritten — snapshot-only capture asserted in the recorded sequence (no
  dump phase), restore-onto-current-PG re-apply idempotency, retention-
  position recoverability refusal, and the owner-run maintenance backup as a
  separately coordinated capture.
- **R3-V3 — FIXED (the lighter alternative, taken):** the snapshot format
  version NO LONGER moves for additive/defaulted fields — the version moves
  ONLY on a format break. Fields added with defaults keep the version (old
  readers accept and ignore, proved by the UNCHANGED-version additive
  fixture); a MINOR bump, a MAJOR bump, or a field removed/renamed/re-typed
  is a format break; a candidate that moves the version without a breaking
  change fails the build (bump-without-break refusal); a reader seeing a
  NEWER version of ANY kind — a higher minor exactly like a major — refuses
  with the reason (the strict newer-refuses rule of decision 8 is
  preserved). A separate release/schema revision may track additive drift in
  the generation registry for observability, never read as compatibility.
  ADR: Q8 snapshot-envelope bullet rewritten, Decision outcome item 8
  unchanged. design: "Reader rules" snapshot-version bullet rewritten, F6
  (a) unchanged in shape. Check: N-17 (a) extended — the unchanged-version
  additive-field acceptance fixture alongside the higher-minor-version
  refusal fixture (refused exactly like a major).


Round-3 pass-2 additions (part 8), one entry per item assigned to the part, in
the order R3-10, R3-11, R3-12, followed by the Checks audit. The owner's eight
decisions are unchanged.

- **R3-10 — FIXED:** the function read/write surface is now closed against a
  FRESH adapter and a restart. Content-derived projection versions: the
  `version` of `(module, projection, version)` is a hash of the projection's
  CONTENT, so re-publishing unchanged content is the same versioned key (no
  restart manufactures a spurious update) and two distinct updates to ONE
  natural key are two distinct entries, latest wins. Core-owned BOOTSTRAP
  projections: at activation the OWNING module's applier publishes every read
  set it owns from its own durable rows under the content-derived version,
  and the ADAPTER's readiness REQUIRES the declared read set complete (the
  loader's probe reads the projection-complete flag, bounded by
  `readinessWindowMs`) before its function leg serves any delivery. Correlated
  external-tool routing: a function's tool need is a declared `tool.request`
  form; the adapter holds the delivery un-XACKed in its PEL, publishes the
  request as a normal keyed executor job, and re-invokes the function with
  the executor's `tool.result` under the SAME effect id — two invocations per
  round trip, one synchronous answer each (A12 unchanged); the parked legs
  ride the existing at-least-once machinery, count as outstanding references
  in trimming, and an unknown or late result is counted and reported. New
  `tool.request`/`tool.result` rows added to the bus-catalog table (the
  function surface is four event types, counted under the catalog rule).
  ADR: Q6 read-path bullet + two new sub-bullets, the TODAY-tool paragraph,
  A12 (two-invocations note), Decision outcome item 6. design: function
  bullet (content-derived version; bootstrap + barrier; tool routing), the
  two new event-table rows, the catalog-rules sentence. Check: N-19 extended
  — unchanged news `lastFetchedAt` across restart (same content-derived
  version, cache value unchanged), two distinct updates to one natural key,
  the fresh-adapter readiness barrier, and web-search request/result as well
  as reminder create.
- **R3-11 — FIXED:** the one-attachment rule is now a ROLE-SPECIFIC
  ATTACHMENT/LISTENER MATRIX: every module carries exactly ONE network
  attachment (the internal one), and the EGRESS DOOR alone carries the
  vault-injection leg as its second attachment — the only module crossing in
  the topology — reaching ONLY Agent Vault's injection listener; no other
  module holds a second attachment, and a container spec outside its role's
  matrix row fails the check. The static set's attachments are the compose
  file's (loader: front + internal; Caddy: front + internal; stores:
  internal; Agent Vault: front + injection leg + its own egress leg). ADR:
  Q6 internal-identity bullet, Decision outcome item 6. design: the
  "Internal caller identity" bullet (matrix replacing the flat rule).
  Check: N-20 extended — per-spec matrix assertion (one attachment per
  module; the door's two), and EVERY refusal pair paired with its authorized
  positive: a SUCCESSFUL authorized-door injection call (a real egress
  through the door with the Agent Vault key injection completing), so the
  refusals do not stand in for the door's own working path.
- **R3-12 — FIXED:** the wedge predicates are no longer lifetime
  zero-success counts. ROLLING bounds: executor, adapter/function-host and
  door wedges count N consecutive LOCAL failures with zero successes WITHIN
  a rolling failure window (`healthFailureWindowMs`, proposal 60 000, <
  `healthWindowMs`, loader configuration) instead of "since activation" — a
  module that succeeds once at activation and then wedges is caught. Durable
  suspension/expiry evidence: a CLAIMED long-running job is excluded by its
  live PEL heartbeat (R3-09), but a SUSPENDED wait — XACKed, no PEL entry,
  no process to heartbeat — is excluded by its DURABLE suspension row,
  which carries the waiter's bounded expiry; past the expiry without the
  completion event the holder's tick scan re-issues the job under the SAME
  effect id (the suspended-row recovery) and its outcome counts like any
  other job's. ADR: Decision drivers item 4 (the new setting), Decision
  outcome item 3, Consequences Good bullet. design: contract point 3
  (rolling bounds; the suspension-evidence rule replacing the heartbeat
  claim), loader configuration `healthFailureWindowMs` row. Check: N-21
  extended — (h) success-then-wedge (one settled job, then only local
  failures: the rolling predicate fails the generation where the lifetime
  one would not — the unit asserts the two predicates disagree on that
  input) and (i) suspended-without-heartbeat (XACK + registry row, no PEL
  entry: the window does not fail within the row's expiry; the scan
  re-issues once past it; a module whose suspensions only ever expire is
  caught by the re-issued outcomes' local-failure counts), plus the
  nine-case walk and the
  rolling-window classifier fixtures.

Checks audit (part 8): every check case named in the verification lines of
the STILL OPEN findings R3-01, R3-03, R3-07, R3-08, R3-10, R3-11, R3-12,
R3-13 and of the problems R3-V1, R3-V2, R3-V3 was verified PRESENT in the
matching row of the design's Checks tables — row-scoped, not
document-scoped. Full row/case map: N-8 (slow send, parked function,
non-allowlisted PG refusal, un-restarted executor); N-9 (already-open old
transaction) with Q5 (`closing-apply` branch) and F2 (revocation confirmed
before the bump); N-17 (both PG directions, positive/negative fixtures,
semantic pending-event recovery, unchanged-version additive acceptance,
higher-minor refusal); N-13 (missing-terminality refusal, keyed,
query-positive, terminal-negative, still-in-flight-negative); N-19
(lastFetchedAt across restart, distinct updates to one natural key,
readiness barrier, web-search round trip, reminder create); N-20 (matrix
rows, successful door injection against the refusals); N-21 (success-then-
wedge, suspended-without-heartbeat); N-11/Q1 (expiry during revocation,
post-exit compensation, stalled post-bump); N-10/Q4 (kill-before-final-
commit pin cut); N-25 (snapshot-only capture, restore-onto-current-PG
re-apply, retention-position refusal, owner-run maintenance backup). No
gaps remained; the only edits in that pass were the R3-10/R3-11/R3-12 row
extensions N-19, N-20, N-21 themselves.


### Round 3 final confirmation

Narrow confirmation of `git diff 3bfa8ea..183c74c` for
**lifemodel-b0r.9.7**, against "Round 3 verification" and "Round 3
verification dispositions", limited to the eleven previously OPEN/new items.
CLOSED confirms the written mechanism and proposed check, not runtime
acceptance. No new review round, product tests, Docker walks or runtime probes;
the automatic transition document gate did not run.

**Verdict: BLOCK — 9 CLOSED, 2 STILL OPEN.** References are to
`containers-design.md` (design) and `adr/010-container-generations.md` (ADR)
at `183c74c`. No new unrelated findings.

- **R3-01 — STILL OPEN:** grace credentials are explicitly loader-minted and delivered outside OpenBao Agent (`design:494-533`, ADR Q4/Q7), contradicting OWNER-DECISIONS.md point 7's OpenBao-issued module roles and envconsul delivery; an owner-compliant handoff preserving the running executor/adapter, or explicit owner approval of that exception, is missing despite N-8's added completion/refusal cases.
- **R3-03 — CLOSED:** the exclusive `active_holder` hold waits out old apply transactions before the Valkey bump and stays held through the PG bump; N-9 checks an already-open old transaction and mid-barrier recovery (design B04, N-9; ADR Q2/A8b).
- **R3-07 — CLOSED:** retained predecessor readers now run on candidate-written PG data after candidate migrations, with positive/negative fixtures and bidirectional semantic pending-record recovery (design reader rules, N-17; ADR Q8).
- **R3-08 — CLOSED:** query retries require definitive non-application; a non-terminal negative becomes reported `uncertain`, and N-13 includes query-positive, terminal-negative and still-in-flight-negative cuts (design destination-idempotency/crash-cut rules, N-13; ADR Q4).
- **R3-10 — STILL OPEN:** bootstrap publication occurs only at activation, but adapter readiness requires those projections before activation, while the candidate cannot consume the bus pre-bump (`design:171-181,306-321,335-344`, ADR Q6); a non-circular fresh-adapter bootstrap order and a check that reaches readiness through that order are missing from N-19.
- **R3-11 — CLOSED:** the role-specific network matrix gives only the door the injection attachment, and N-20 pairs malicious-peer refusals with successful authorized-door injection (design internal caller identity, N-20; ADR Q6).
- **R3-12 — CLOSED:** rolling failure windows replace lifetime success counts, and durable suspended-row expiry replaces the impossible post-XACK heartbeat; N-21 includes success-then-wedge and suspended-without-heartbeat cases (design contract point 3, N-21; ADR decision drivers).
- **R3-13 — CLOSED:** post-core-exit pre-bump expiry now runs one bounded same-epoch restart with fresh roles or opens maintenance, rather than promising N still serves; N-11/Q1 include revocation and post-exit expiry (design planned-switch deadline/configuration, N-11/Q1; ADR open question 5).
- **R3-V1 — CLOSED:** the switch copies only the immutable tick snapshot; restore checks compatible current PG and retained bus positions, while full-data backup is a separate coordinated owner-run maintenance action, all covered by N-25 (design snapshot-copy/backup rules, N-25; ADR Q3).
- **R3-V2 — CLOSED:** after confirmed kill and before bump the loader pins the last committed snapshot as the handoff; N-10/Q4 cover kill-before-final-commit through activation and first commit without lost/repeated outcomes (design contract point 6, N-10/Q4; ADR Q4).
- **R3-V3 — CLOSED:** additive/defaulted fields keep the format version, and every newer version, including a higher minor, refuses older readers; N-17 pairs unchanged-version additive acceptance with higher-minor refusal (design reader rules, N-17; ADR Q8).

## Simplification 2026-10-12

The owner's simplification review (OWNER-DECISIONS.md, 2026-10-12 15:47-16:39
UTC, points 0-6 plus the values) was decided AFTER this record's round 3 —
and after round 3's final confirmation (which left R3-01 and R3-10 open). It
stay-reviewed mechanism, not verdicts: nothing below re-argues the round-3
findings. ADR-010 and containers-design.md were rewritten FROM SCRATCH on
these decisions (lifemodel-b0r.9.8); the round-3 dispositions above remain
the record of how the OLD shape reached where it was. This section records,
per round-3 finding, whether the simplification SUPERSEDES the round-3
fix (the mechanism is removed), AMENDS it, or whether the finding REMAINS a
requirement inside the simplified shape — with where each requirement now
lives. Point numbers are the simplification review's.

### Superseded — the round-3 mechanism is removed by the simplification

| Finding | What round 3 fixed | Superseded by | The requirement now lives in |
|---|---|---|---|
| R3-01 | The executor grace COMPLETION CAPABILITY (allowlist-checked completions during the grace, confirmed-exit takeover, capability issued before revocation) | point 4 (NO executor module — the fix's object is gone) + point 1 (grace = the Compose `stop_grace_period`) + point 3 (no capabilities, no controller-delivered credentials) | In-flight sends settle within the gateway's grace and unfinished PEL entries re-run under the SAME effect id (design keyed-job rules; checks N-12/N-13); leases revoked when the old module's exit is confirmed (design); the walk legs `generations/switch-messages`, `generations/job-takeover`. |
| R3-02 | The commit-fence Valkey MODULE (module-user FCALL gate so a generation role could commit but not raw-write) | point 1 (no Valkey module) + point 3 (the epoch key is writable ONLY by the loader role; the Lua epoch check stays a cheap guard) | The core role carries its commit script (normal commit proven on the live connection, stale commit refused) — Q7/N-11 of the rewritten Checks; `generations/stale-writes`. |
| R3-03 | The two-store epoch barrier (hold-then-fence-then-bump with bounded PG lock wait) | point 1 (ONE host: the stop-first CONFIRMED EXIT gives one writer; no second epoch store; no already-open old transaction to race) | The fence is confirmed exit + epoch CAS + `active_holder` guard, the bump pair idempotent and re-run by the loader's epoch-vs-record reconciliation (Q5, Q7; `generations/loader-crash-cuts`); `active_holder` stays ONLY as a cheap loader-bug guard (A2). |
| R3-04 | Activation-state discrimination + the position-addressed handoff key | point 1 (stop-first: the old core exits CONFIRMED BEFORE the bump — there is no second snapshot source and no pre-bump candidate commit) | Re-hydration reads the LATEST snapshot under the current epoch, no handoff key anywhere (design stop-first sequence; Q4/Q5 cuts in `generations/holder-crash`, `generations/loader-crash-cuts`). |
| R3-05 | The executor's exact scoped PG grant set (done-record/job rows in the core schema) | point 4 (no executor) | The per-schema barrier REMAINS (points 0/5) and its one named cross-schema exception is now the INGRESS GATEWAY's scoped SELECT + INSERT-by-key on `conversation_message` (the web delivery proof) — N-11's grant audit; `generations/credentials`. |
| R3-06 | Admission records decoupled from build reuse (every candidate re-admitted, stale keys refused) | point 5 ("the check is bound to the COMMIT PAIR, not the image": the loader compares schema/migration files at EVERY rollout, even when all images are reused; dropped: image-bound admission records) | N-2 (the commit-pair schema check) — the requirement "reuse buys build cost, never a skipped check" is fully kept; `generations/timing`'s all-reused case. |
| R3-07 (runtime half) | Throwaway-Postgres predecessor-reader runs + the registry-decided window | point 5 (compatibility checked on SCHEMA FILES, FULL both ways; no reader runs on data; the window decided from files and the stores' stamped versions) | The FILE-level checks N-2/N-3/N-4 + the reader rules (see Remains) + the expanding-only invariant (N-6) — the running old code tolerates the candidate's writes BY CONSTRUCTION from the schema pair; `generations/maintenance-boot-older`. |
| R3-08 (query class) | The three-way destination classes with a RECONCILIATION query class (query-positive / terminal-negative / still-in-flight-negative) | point 2 (the manifest declares `keyed`/`unkeyed` only; an ambiguous attempt against either records its disposition and reports — no query round trips) | The two-class contract with `uncertain` + "no automatic re-delivery" (N-12, N-5); a `keyed` ambiguous attempt recovers through its destination contract; the report is the owner's re-issue surface. |
| R3-09 | The durable job state machine (job rows, heartbeats, zombie takeover, suspension rows, pinned-version takeover) | point 2 (jobs = consumer-group semantics ONLY: XACK after the result, XAUTOCLAIM, done records; no state machine, no heartbeats, no retained-image runners) | N-12/N-13 (done records, XAUTOCLAIM min-idle above every grace, keyed re-runs); jobs issued by the old version run under the new one via bus FULL compatibility; `generations/job-takeover`. |
| R3-11 | mTLS workload identity, listener-network matrix, verified-identity doors | point 3 (Docker networks + identity = the stream a module wrote to; mTLS DEFERRED to the backlog — returns when modules span machines or come from foreign sources, the point-0 invalidator) | Structural unreachability (N-8), identity by stream (N-9), the container-spec unit (Q9's unit); no certificate machinery anywhere. |

Partially superseded, whose remainder is recorded under Remains:

- **R3-13** — the planned-handover deadline machinery (`switchDeadlineMs`,
  `pgFenceLockTimeoutMs`, the phase-expiry dispositions) dies with the
  barrier and the 90 s drain (the values: `coreStopDeadlineMs` 5 s; no
  overall switch deadline — the bounded pause is the stop deadline plus
  `readinessWindowMs`, never unbounded by construction). The ROUND-3
  REQUIREMENTS survive: the readiness window is the named fixed multiple 30×
  of the probe interval; every wait bounded; the rollback deadline 300 s
  unchanged (B06).
- **R3-17** — only its (iv) mTLS peer-authentication clause is superseded
  (point 3: structural unreachability replaces authenticated peers); the
  scoped-KIND credential method (model-key absence; store credentials
  invisible to `docker inspect` yet present per role in the Agent-supervised
  environment; scrubbed child environments) is unchanged by the
  simplification and carried whole.
- **R3-22** — the snapshot+Postgres STAMP PAIR and its dump-during-the-pause
  consistency bookkeeping is removed by point 6 (the copy is the final
  snapshot ALONE, taken only at a core replacement); every OTHER round-3
  requirement is kept in the point-6 form (see Remains).
- **R3-12** — the whole-GENERATION verdict becomes PER MODULE (point 1:
  module-by-module rollout and rollback; the design reads each module's own
  done records); the classifier requirements survive in full (see Remains).

### Remains as requirements inside the simplified shape

Verified carried by the rewritten ADR + design (ADR wins on conflict); each
names its check in the design's Checks section:

- **R3-07's reader rules** — Tolerant Reader ACK + drop by default,
  EXCLUDE lists checked in BOTH directions, dual publication sharing the
  minted effect key (publish twice, apply once), the snapshot format
  additive-with-newer-refuses — N-3, N-4.
- **R3-10 — carried whole** (an adopted requirement, not a concession):
  the adapter contract — input envelope with idempotency key + correlation
  id, the four declared command forms, a bounded read set, push projections
  with content-derived versions, the correlated `tool.request`/`tool.result`
  round trip under one effect id, the adapter's bounded-retry ack rule, and
  THE BOOTSTRAP ORDER: the owning module publishes bootstrap projections for
  every read set it owns BEFORE its first real tick, and the adapter's
  readiness REQUIRES the read set complete before its function leg serves a
  delivery. The round-3 open item (the candidate could not consume the bus
  before the bump to publish them) DISSOLVES in the simplified switch: the
  new core starts AFTER the bump and publishes from its own durable rows
  under epoch N+1 before its first tick — no pre-bump consumption is needed.
  Check: N-14; walk `generations/function-state`.
- **R3-12's classifier requirements** — rolling failure window (60 000,
  never lifetime), LOCAL vs UPSTREAM vs INFRA-attributed failure classes,
  idle = healthy, durable exclusion evidence (a live PEL entry / a parked
  un-XACKed delivery) instead of heartbeats, the infra-outage hold ending in
  maintenance — re-homed PER MODULE as N-16; the wedge walk
  `generations/whole-health` keeps its local-failure/upstream-burst/infra-
  hold cases, now per module (the core still committing ticks throughout).
- **R3-13's survivors** — `rollbackDeadlineMs` 300 s as ONE clock (B06),
  `readinessWindowMs` = 30 × interval (R3-13's number), every wait bounded,
  ONE automatic fallback then maintenance (B0R-R06) — Q3, F8, N-16.
- **R3-14 — carried in full** — delayed events as durable rows in the same
  keyed-apply transaction as the schedule advance, the scan's
  fire-exactly-once pair, no process timer anywhere — N-15.
- **R3-15 — carried in full** — Caddy's upstreams DISCOVERED via network
  aliases; a leaving instance's alias removed only AFTER confirmed exit;
  persistent connections and lost-response POSTs resolved by the moved alias
  + the same idempotency key + the dedup ring — N-17.
- **R3-16 — carried in full** — fresh single-use wrapped secret-id per
  (re)start, renewal/expiry INDEPENDENT of OpenBao's availability, visible
  expiry, staggered issuance, max-TTL rotation restarting only the affected
  module — N-18; `generations/credential-rotation`.
- **R3-17's method** — scoped-kind credentials (see above) — Q8's row;
  `generations/credentials`.
- **R3-18 — carried in full** — the tag hashes the FULL canonical build
  identity (selected Dockerfile path + content, named additional contexts,
  admitted build options) — N-1.
- **R3-19 — carried in full** — the ordered IDEMPOTENT bootstrap DAG (the
  fence-module step drops out with point 1; the epoch-record and ACL-user
  steps remain) and BOTH proxies' verb allowlists covering the complete
  lifecycle — N-19; `generations/clean-bootstrap` + the proxy human
  judgement.
- **R3-20 — carried in full** — the egress gateway run as the availability
  and cost chokepoint: bounded queues with a VISIBLE backlog, a full queue
  as a NAMED outage in the health path, its latency/concurrency measured
  separately from tick latency (Q11's method) — N-16's wedge cases + the
  Q11 measurement.
- **R3-21 — carried in full** — `appendfsync-always` as the ACK boundary in
  both directions, visible pressure failures, the trim floor = minimum safe
  offset across ALL groups + outstanding references, durable consumer
  groups — N-21; `generations/valkey-restart`.
- **R3-22's survivors** — the copy's immutable identity and retention 3
  (values), the restore REFUSALS (copy's schema not readable by the current
  core; bus position trimmed), the restore report's unreconciled listing,
  the owner-commanded full backup as a separate maintenance action — N-20.
- **R3-23 — carried in full** — the synchronized sampler method (aggregate
  from simultaneous samples, per-container peaks, BuildKit line items), the
  operative-limit source scan — the Q11 row; `generations/peak-memory`.

### Still open before this section

Round 3's final confirmation left exactly two findings open; the
simplification resolves both without a further fix:

- **R3-01 (STILL OPEN)** — the open item was the grace capability, which
  contradicted the OpenBao/envconsul delivery model. Point 4 removes the
  executor, so no grace capability exists to deliver; the closure is by
  REMOVAL, superseding the item (see the Superseded table). No replacement
  handoff was needed: stop-first + per-module graces + XAUTOCLAIM close the
  in-flight-work question it served.
- **R3-10 (STILL OPEN)** — the open item was the bootstrap-order
  circularity; it is resolved structurally by the simplified switch order
  and carried as a requirement with its check N-14 (see Remains).

### Unchanged by the simplification

- **R3-24** — the charter amendment remains an OWNER-pending item (the
  coordinator amends the charter with the owner); it now needs to rewrite
  the charter to the SIMPLIFIED shape (per-module replacement, no executor,
  schema-file compatibility, copies only at core replacement), and the
  inventory's four PENDING-CHARTER-AMENDMENT markers stay until then.
- **B01-B08, C01-C02** — resolved dispositions whose mechanisms survive the
  simplification unchanged in effect (the epoch fence, the outbox commit,
  the bounded rollback, durable intake, Docker authority stated as
  daemon-root trust) are unaffected; where a resolution's mechanism was
  removed, the fate is recorded in the Superseded table above.
- The inventory's F*/Q* rows carry inline AMENDED notes naming the
  simplification point that changed each driver (containers-inventory.md,
  2026-10-12).

## Round 4 (simplified ADR review, 2026-10-12)

**Reviewer model:** `openai-codex/gpt-6.1-sol` (high reasoning). Independent
of the design author; two read-only, same-model scoped reviewers assisted this
one round. The reviewer consolidated and checked the findings against the inputs.

**Scope:** HEAD `007112b137e7ab019fb115b2da47802e73c5f945`; every F1–F8 and
Q1–Q13, OWNER-DECISIONS.md (later comments amend earlier ones), ADR-010,
containers-design.md including Checks, containers-inventory.md, the review
history including “Simplification 2026-10-12”, the instance-1 charter, and the
existing loader persistence code where a claim depends on it. In evidence below,
`ADR-010` means `docs/adr/010-container-generations.md`; the three
`containers-*.md` files are under `docs/features/instance/`.

**Threat model:** trusted against malice, not against bugs. These findings
concern honest crashes, hangs, restart races, power loss, missing normal-path
permissions and inconsistent checks. They do not ask for mTLS, a commit gateway,
a two-store closed-apply barrier, grace capabilities, an executor/job engine,
heartbeats, retained-image runners, admission records, predecessor-reader runs
or snapshot+Postgres stamp pairs. Schema-only semantic compatibility risk and
the fixed module/runtime choices remain accepted owner trades.

**Summary: 10 BLOCKING, 6 COMMENT.** The work plan cannot yet be built on the
normal startup and recovery contracts. BLOCKING means the written contract or
its safety mechanism must be settled first; COMMENT marks a sensitivity,
trade-off, unnecessary mechanism or check correction. This is a source/design
review, not runtime acceptance: no product suite, engine experiment or CI-only
walk was run.

### Scenario walk, sensitivity points and trade-offs

“Specified” means a written mechanism exists, not a runtime PASS.

| Scenario | Walk result / sensitivity | Findings |
|---|---|---|
| F1 | Selective images/unchanged modules are the right unit; adapter-only readiness and restart policy remain blockers. | R4-04, R4-08, R4-16 |
| F2 | Core stop-first is fixed; readiness tests must distinguish it from start-first and allow the required routes/grants. | R4-04–R4-06, R4-08, R4-11 |
| F3 | Web insert-by-key is a sound destination proof; ambiguous dispatch, takeover and retained proof still break recovery. | R4-01, R4-02, R4-07, R4-10, R4-12, R4-14 |
| F4 | One fallback on current data is retained; no-progress health and durable controller intent are load-bearing. | R4-03, R4-09, R4-13 |
| F5 | Schema/read-or-refuse and manual-only recovery are accepted; retained-copy proof and contract retirement are sensitivities. | R4-10, R4-12, R4-15 |
| F6 | Schema-only review residue, dbmate/squawk and no downs are fixed trades, not requests for predecessor-reader runs. | R4-01, R4-10, R4-15 |
| F7 | Compose/static bootstrap and scoped secrets retain the intent; topology, lease ordering, restart gates and power loss do not yet cohere. | R4-05–R4-09 |
| F8 | Walked as the design's configuration check (inventory lists F1–F7); cross-setting checks do not prove takeover or restoration timing. | R4-02, R4-13, R4-16 |
| Q1 | Durable ingress closes the input gap; core availability and old-instance lease order need strategy-specific evidence. | R4-07, R4-11 |
| Q2 | The 2 s/60 s readiness numbers are named; fresh-adapter bootstrap and the core never-ready assertion are not executable as stated. | R4-04, R4-11 |
| Q3 | Completed-work health and the 300 s rollback clock are sensitivity points; maintenance-on-expiry is not restored service. | R4-03, R4-13 |
| Q4 | Atomic snapshot/outbox and persisted keys are sound directions; before-dispatch and result-before-XACK cuts are incomplete. | R4-01, R4-02, R4-08, R4-10 |
| Q5 | Intent-before-action, foreign/empty-epoch refusal and one report id are useful; durable records and restart ownership are required. | R4-04, R4-08, R4-09, R4-14 |
| Q6 | AOF-always, pressure failures, durable PEL and all-group trim floors are specified, not runtime-verified here. Restore/pruning must retain effect proof. | R4-05, R4-10, R4-12 |
| Q7 | Single-host confirmed exit is accepted in place of the rejected barrier; live takeover, automatic revival and server-side SQL completion limit its claim. | R4-02, R4-08, R4-14 |
| Q8 | Model-key absence versus scoped store credentials is the right distinction; the endpoint role map and lease ordering contradict it. | R4-05–R4-08 |
| Q9 | Motor's own narrow proxy is decided, not a reason to demand loader-only authority again; the paths/check exceptions are missing. | R4-06 |
| Q10 | Same-login registry, reports and maintenance are specified; reports must expose silent hangs, uncertain work and actual restore loss. | R4-03, R4-09, R4-12 |
| Q11 | Synchronized aggregate sampling, individual peaks and no 11 GB cap are correct. Grace overlap, backlog and proof retention remain measured costs. | R4-02, R4-13, R4-16 |
| Q12 | Canonical build identity and commit-pair checks even on reuse are retained. Bootstrap, health and serial rollback timing affect the observed path. | R4-03, R4-04, R4-13, R4-15, R4-16 |
| Q13 | Bus-first results and delayed-event rows retain tick-only intent; adapters/endpoints and proof lifetime need the concrete rules below. | R4-01, R4-04–R4-06, R4-10, R4-15 |

The principal trade-offs are short core pauses versus queued background work;
start-first availability versus simultaneous attempts; image reuse versus fresh
commit-pair checks; and manual old-copy recovery versus retained proof/storage
cost. No new disproportionate platform mechanism is justified: where a gap needs
repair, use the existing done record, stream/group metadata, controller or scoped
network edge. R4-12 names a lighter alternative to the added destructive bus rewind.

The charter mismatch is already explicitly pending as R3-24
(containers-design-review.md:1896-1902): instance-1.md:23-27, 30-51, 78-95,
129-132 still prescribe superseded choices. It must be amended before the work
plan, as already agreed; it is not counted again as a new round-4 finding.

### Findings

### R4-01 — Unkeyed dispatch has no durable before-effect marker

- **Severity:** BLOCKING
- **Scenario:** F3, F6; Q4, Q13
- **Evidence:** ADR-010:423-427; containers-design.md:686-702, 732-741.
- **Risk / inconsistency:** An honest consumer can complete an unkeyed external effect and crash before the prescribed AFTER-effect done write. Recovery then sees no record and follows cut (1), dispatching again instead of reporting `uncertain`; the mid-delivery cut assumes an `in-flight` record without specifying how it becomes durable.
- **Fix:** Commit the existing done record as `in-flight` before dispatch, with atomic same-key admission. Test death after dispatch but before the completion write: recovered unkeyed attempts must be reported as uncertain and never automatically dispatched again.

### R4-02 — PEL idle is not a live-consumer fence

- **Severity:** BLOCKING
- **Scenario:** F3, F8; Q4, Q7, Q11
- **Evidence:** ADR-010:47-50, 419-446; containers-design.md:301-308, 681-685, 852, 981 (N-13).
- **Risk / inconsistency:** XAUTOCLAIM idle starts at delivery, not at SIGTERM or actual HTTP-call start. Prefetch, a parked function waiting in an egress queue, or a process pause can exceed min-idle while its consumer remains alive; min-idle greater than stop grace does not prove the promised absence of a concurrent old attempt.
- **Fix:** Use confirmed Docker exit to authorize reclaim from the retiring consumer, and bound delivery-to-result time including queue and parked time. Keep XAUTOCLAIM and the existing done record; test a paused consumer and a parked delivery beyond min-idle, not only a short slow call.

### R4-03 — Silent consumer hangs pass the completed-work gate

- **Severity:** BLOCKING
- **Scenario:** F4; Q3, Q10, Q12
- **Evidence:** containers-design.md:500-542, 984 (N-16); ADR-010:265-270.
- **Risk / inconsistency:** A consume loop wedged before reading commands or recording an outcome produces neither successes nor LOCAL failure records. The rolling failure-count predicate never fires, and a PEL exclusion can also outlast the 120 s health window because min-idle exceeds the gateway grace; a green probe plus growing demand can therefore be accepted as healthy.
- **Fix:** Fail on aged outstanding demand without progress outside explicitly bounded legitimate waits, using existing stream/group and result records. Test an unread backlog and a claimed delivery that produces no result or failure, while keeping idle, upstream and infrastructure exemptions.

### R4-04 — Fresh adapters cannot bootstrap from an unchanged core

- **Severity:** BLOCKING
- **Scenario:** F1, F2, F4; Q2, Q5, Q12, Q13
- **Evidence:** ADR-010:638-643, 689-697; containers-design.md:209, 293-300, 356-368, 402-405, 982 (N-14).
- **Risk / inconsistency:** A function-host-only replacement or credential restart creates an empty projection cache, but bootstrap is emitted only when the owning core activates, and unchanged modules are not restarted. The new adapter must be ready before joining its group; even after joining, two members of group `adapter` compete for projections rather than both receiving a complete cache.
- **Fix:** Define a bounded bus-based bootstrap for every fresh adapter, from current durable projections, independently of readiness for work delivery. Test host-only replacement and restart after the old adapter has ACKed and trimmed the bootstrap events; do not restart the core or give functions store access.

### R4-05 — The role and stream matrices prohibit required endpoints

- **Severity:** BLOCKING
- **Scenario:** F2, F3, F7; Q6, Q8, Q13
- **Evidence:** ADR-010:638-643, 744-750; containers-design.md:106-120, 209-215, 227-229, 686-698, 958, 978 (N-10).
- **Risk / inconsistency:** The adapter and workerd are one function-host module, yet that host must have no credentials or store connection; the egress gateway gets Agent Vault only, yet it must consume Valkey commands, publish results and write Postgres done records. The `bus` writer list also omits the ingress and egress producers of `send.settled` and `http.result`. Enforcing Q8/N-10 makes the required normal path fail.
- **Fix:** Apply zero credentials to the function/workerd process with a scrubbed environment, not to its bus adapter. Publish one consistent per-process role/stream/schema matrix granting each adapter and gateway its required scoped consume, ACK, result-publication and done-record operations, and test the positive path as well as refusals.

### R4-06 — The network view omits required routes and decided exceptions

- **Severity:** BLOCKING
- **Scenario:** F2, F7; Q8, Q9, Q13
- **Evidence:** OWNER-DECISIONS.md:31, 34; ADR-010:578-602, 615-618; containers-design.md:47, 67-105, 165-170, 959, 976 (N-8).
- **Risk / inconsistency:** Caddy routes `current` to the core, but front-web contains only ingress and the core must be reachable only through the bus. Motor has a decided private proxy exception but no network row provides that path, while Q9 forbids Docker-path facts in ANY module. Agent Vault must be the last internet hop, but its outbound path is not specified; a non-internal front-vault would instead contradict N-8's membership assertion.
- **Fix:** Route the owner's web surface through ingress as decided, and provide an explicit allowed-path table for Motor-to-private-proxy and Agent Vault's last-hop egress. Update the confinement checks to exempt only those required endpoints; no certificates or new isolation engine are needed.

### R4-07 — ADR lease ordering contradicts start-first replacement

- **Severity:** BLOCKING
- **Scenario:** F1, F3, F7; Q1, Q8
- **Evidence:** OWNER-DECISIONS.md:25; ADR-010:359-375, 760-762; containers-design.md:9, 402-409, 494-498, 958.
- **Risk / inconsistency:** The governing ADR still revokes the OLD GENERATION before the new module set starts, while start-first requires the replacement to become ready before the old instance finishes with its normal leases. Following ADR precedence revokes unchanged modules and disables old in-flight work, contradicting the later owner decision and the design's per-instance after-exit sequence.
- **Fix:** Replace the generation-wide revoke-before-start clause with revocation of only the retired instance after confirmed exit. Assert this ordering for a gateway-only rollout while unchanged modules and the old gateway's in-flight delivery retain their leases.

### R4-08 — Independent module restarts bypass the controller stop gate

- **Severity:** BLOCKING
- **Scenario:** F2, F7; Q4, Q5, Q7, Q8
- **Evidence:** containers-design.md:129-134, 427-435, 589-591, 605-608, 647-654, 986 (N-18); ADR-010:769-775.
- **Risk / inconsistency:** Module restart policies can revive containers on a daemon restart before the loader reads panic or maintenance state. A daemon restart in the stop-first crash window can also revive the stopped old core beside the new one; both self-read the current epoch, so confirmed exit is not a permanent singleton fence. Docker restart policies also restart an existing container, not recreate it with a fresh one-use bootstrap.
- **Fix:** Reserve independent Docker restart policies for static infrastructure and the loader; make the controller gate every module start/restart on durable panic, maintenance and rollout intent. Test a daemon restart after old-core exit and during panic/maintenance, including fresh secret-id delivery.

### R4-09 — Write-ahead loader records lack power-loss durability

- **Severity:** BLOCKING
- **Scenario:** F4, F7; Q5, Q10
- **Evidence:** containers-design.md:351, 613-625; containers-inventory.md:54; loader/src/fs.ts:132-137; loader/src/state.ts:160-162, 182-188.
- **Risk / inconsistency:** Reconciliation treats JSON intent and panic as durable authority, but the retained loader writer uses writeFile, rename and chmod without syncing file contents or the parent directory. A power cut can preserve the Docker/store action while losing its preceding record, or lose an acknowledged panic; the crash-cut tests described only around process death cannot prove the power-loss scenario.
- **Fix:** Require synced temporary contents, atomic rename and parent-directory sync before dependent actions or owner acknowledgements, including durable latch removal. Add a storage-failure/power-loss persistence cut to reconciliation and panic checks instead of treating rename alone as durable.

### R4-10 — Settlement alone permits pruning still-needed effect proof

- **Severity:** BLOCKING
- **Scenario:** F3, F5, F6; Q4, Q6, Q13
- **Evidence:** containers-design.md:475-485, 681-702, 725-738, 819-827, 980 (N-12), 988 (N-20).
- **Risk / inconsistency:** A consumer can publish a result and die before XACK; the core settles it and the stated pruning rule then permits deleting its done record before PEL redelivery. Likewise a retained snapshot copy can still contain a pending effect whose proof was pruned after settlement in the newer snapshot. Recovery sees absence and dispatches an already completed effect; for unkeyed destinations this also defeats the uncertain/report promise.
- **Fix:** Keep settlement tombstones and report metadata while any command/PEL entry or retained copy can re-issue the key, or refuse a copy whose required proof is missing. Test result-before-XACK followed by settlement/pruning, and old-copy restore after a normal pruning opportunity; no backup pair or job state machine is required.

### R4-11 — The never-ready check still assumes start-first core availability

- **Severity:** COMMENT
- **Scenario:** F2; Q1, Q2
- **Evidence:** OWNER-DECISIONS.md:25; containers-inventory.md:256; containers-design.md:427-436, 952.
- **Risk / inconsistency:** Q2 still asserts zero epoch changes and N answering throughout a never-ready candidate. A never-ready CORE is reached only after stop-first has exited N and bumped the epoch; the check cannot pass for the decided strategy and could hide this by exercising only a gateway.
- **Fix:** Split Q2 into the keyed-module zero-bump case and the core stop-first failure case, with bounded fallback on current data and durable intake throughout. Keep the owner's strategy; amend the scenario and its check rather than adding a pre-activation core.

### R4-12 — Snapshot restore adds an unrequested destructive bus rewind

- **Severity:** COMMENT
- **Scenario:** F3, F5, F6; Q6, Q10
- **Evidence:** OWNER-DECISIONS.md:40; containers-design.md:475-485, 988 (N-20).
- **Risk / inconsistency:** The owner decided restoration of a snapshot copy with schema/trim checks, not deletion of later bus entries. The design says those entries are LOST and reports them from later done records, which cannot identify accepted but not yet processed inbound messages or commands with no done record. Rewinding the journal is extra destructive machinery and weakens recovery unnecessarily.
- **Fix:** The lighter option is to keep the current bus and restore only the snapshot, replaying retained entries under their keys. If destructive truncation is genuinely required, obtain an explicit owner decision and enumerate all discarded accepted input and pending work from the streams, not only completed effects.

### R4-13 — Rollback grace can consume the whole restoration budget

- **Severity:** COMMENT
- **Scenario:** F4, F8; Q3, Q11, Q12
- **Evidence:** containers-design.md:565-584, 842, 855; containers-inventory.md:257; ADR-010:41-46.
- **Risk / inconsistency:** The proposed gateway grace is 300 s and Motor grace follows its run limit, but rollback must restore all changed modules within one 300 s clock including readiness/start. A legitimate in-flight gateway call can consume that entire clock, and multiple serial replacements compound it; the expiry-to-maintenance mechanism bounds abandonment, not guaranteed restoration.
- **Fix:** State restoration versus maintenance-on-expiry as distinct measured outcomes and test a maximum-duration call during multi-module rollback. Name the budget allocation and any safe early-stop policy instead of claiming the removed downgrade step provides sufficient slack.

### R4-14 — Container exit does not prove Postgres server work ended

- **Severity:** COMMENT
- **Scenario:** F3; Q5, Q7
- **Evidence:** ADR-010:230-238, 384-392, 407; containers-design.md:429-432, 494-498, 773-780, 860.
- **Risk / inconsistency:** An already submitted SQL statement or COMMIT can still execute in a Postgres backend after the client container dies. The text concludes no old transaction can remain solely from Docker exit, and does not specify backend termination/confirmation or bounded SQL waits; an old apply that already checked active_holder can therefore outlive the point called its fence.
- **Fix:** Make stop-first also confirm the retired core's database sessions have ended, using its existing per-instance lease/session cleanup with bounded waits, and test a delayed old transaction. This is a database completion sensitivity, not a request to restore the rejected two-store epoch barrier.

### R4-15 — Later contract steps have no admissible retirement rule

- **Severity:** COMMENT
- **Scenario:** F5, F6; Q12, Q13
- **Evidence:** OWNER-DECISIONS.md:19, 37; ADR-010:809-843; containers-design.md:379-390, 781-789, 971, 974.
- **Risk / inconsistency:** The documents promise removal in a later contract commit but every rollout comparison is FULL against the running commit and the migration gate bans drop/rename/type changes without a contract exception. Merely waiting another commit does not change either predicate or prove that pending old command types/readers no longer need the deprecated shape.
- **Fix:** Specify when a later contract step is admissible and how the compatibility window and outstanding bus references retire the old shape. If contraction is outside this implementation, say so explicitly and keep the milestone's gate expand-only.

### R4-16 — The gateway-only copy check freezes a snapshot that must keep ticking

- **Severity:** COMMENT
- **Scenario:** F1, F8; Q11, Q12
- **Evidence:** OWNER-DECISIONS.md:25, 40; containers-design.md:463-465, 988 (N-20).
- **Risk / inconsistency:** N-20 asserts the snapshot is unchanged across a gateway-only rollout, although the unchanged core must keep committing a new snapshot every tick. This check proves the wrong property and would fail a correct selective rollout or encourage stopping the core.
- **Fix:** Assert no snapshot COPY was taken and no core instance/epoch was replaced, not byte equality of the live snapshot. Observe continued tick commits during the gateway-only rollout.

### Round 4 dispositions

Recorded by the resolution pass (lifemodel-b0r.9.10), one entry per
finding; FIXED names the sections changed and the check ids. `ADR-010` =
`docs/adr/010-container-generations.md`; `design` =
`containers-design.md`; checks live in the design's Checks tables. Each
check extension pairs its success path with the named failure cut, per
the round-4 rule.

- **R4-01 — FIXED** (ADR-010 point-2 done-record rule; design "Keyed job
  rules" done-record bullet and crash cuts; check N-12): the done record
  is now ADMITTED in `in-flight` BEFORE dispatch — a same-key atomic
  insert, a re-delivery can neither overwrite it nor mint a second one —
  and UPDATED after the effect applies. Crash cut (1) is narrowed to
  death BEFORE the admission (no record, the effect never started — safe
  to deliver once); cut (2) now explicitly covers death after dispatch
  and before the completion write: the recovered unkeyed attempt is
  recorded `uncertain` and reported, never automatically dispatched
  again; the recovered keyed attempt completes under the same id (N-12's
  cut pairing).
- **R4-02 — FIXED** (ADR-010 values item 8, the start-first replacement
  sequence, and the point-2 rules; design "Keyed job rules" XACK/claim
  and timeout bullets, the parked-delivery rule, the loader settings
  table; checks N-13, N-5): min-idle is restated as the crash-takeover
  trigger, NOT a live-consumer fence, and sits above every module's newly
  declared DELIVERY-TO-RESULT bound (queue wait + held call + parked
  wait, a manifest field build-checked with N-5). Reclaim from a retiring
  instance is authorized by CONFIRMED Docker exit — the idle clock never
  delays a confirmed-dead consumer's entries. N-13 now tests a paused
  consumer and a parked delivery taken past the bound, with the outcome
  deterministic through R4-01's admission.
- **R4-03 — FIXED** (ADR-010 A8; design "Per-module health window" new
  aged-demand bullet; check N-16): the window now also fails a module on
  AGED OUTSTANDING DEMAND with no progress — demand older than the
  module's declared delivery-to-result bound (unread `cmd.<module>`
  entries, claimed PEL entries, parked deliveries) with no settled job,
  no local failure and no claim/ack movement. The kept exemptions are
  restated: idle (no demand at all) is healthy, upstream failures count
  separately, a static-infrastructure outage holds the clock. N-16's walk
  gains the two wedge cuts (an unread backlog; a claimed delivery with
  neither result nor failure) against the green exemption cases.
- **R4-10 — FIXED** (design pruning rule, trimming floor, checks N-12 and
  N-20; the ADR's done-record rule names the retention): pruning now
  requires settlement committed in a snapshot AND no remaining re-issue
  path (a live PEL entry, an undelivered command entry, a parked
  delivery, a retained snapshot copy naming the key); the settled record
  is the tombstone the redelivery dedups against and is kept until every
  re-issue path ends. N-20's restore check gains a refusal for a copy
  whose pending effects' proof records are missing, tested with
  result-before-XACK followed by settlement/pruning and an old-copy
  restore after a normal pruning opportunity. No backup pair and no job
  state machine were added, per the finding's own bound.
- **R4-04 — FIXED** (ADR-010 Q6's bootstrap bullet; design "Bootstrap
  order", the `cmd.state` stream row, check N-14): bootstrap is now a
  bounded bus REQUEST/RESPONSE taken from the CURRENT durable rows — every
  fresh adapter instance joins its group first, publishes a keyed
  `bootstrap.request` into `cmd.state`, and the core's applier re-publishes
  a complete `state.projection` packet per `(module, projection)` of the
  requested read set from its serialized outbox (content-derived
  versions). The emission at the owning core's activation is gone — the
  mechanism is independent of the core's restart and of readiness for work
  delivery, requires no core restart and no adapter/function store access.
  The trim hazard the finding named is the design's ordering guarantee: a
  predecessor-PEL claim runs only after the repair completes, and a claimed
  pre-repair packet for a repaired key is dropped and counted (never
  applied backward; identical content is the identical key). N-14's walk
  gains both named cuts: a HOST-ONLY replacement (unchanged core, not
  restarted) and a sole-adapter restart after the predecessor ACKed and
  trimmed the projection history, each reaching a complete declared read
  set; an unanswered request past `readinessWindowMs` is failed readiness,
  never an empty cache served. No job state machine was added, per the
  finding's own bound.

- **R4-05 — FIXED** (ADR-010 Q7's role map rewritten as a per-process
  process/produce/schema matrix and the point-7 summary; design "Credentials
  at the store edges" reworded per PROCESS, the `bus` stream writer list,
  the identity paragraph, the container-view boxes; checks N-9, N-10, Q8
  (iii)): zero credentials now attach to the PROCESS, not the container —
  the workerd process runs with a scrubbed environment and nothing, while
  the adapter process of the same container carries exactly the adapter
  matrix row (bus consume incl. `http.result`, produce `cmd.state` +
  `cmd.egress.<function-host>`, its own schema for its done records). The
  gateways' required endpoints are granted and stated: the egress gateway
  consumes every `cmd.egress.<module>` stream, publishes `http.result` on
  the bus, keeps its own Postgres schema for done records, and holds Agent
  Vault for key injection; the ingress gateway publishes `send.settled` on
  the bus after its insert-by-key (the `bus` writer list now names both
  producers). Producer-side stream identity is restated: consuming another
  module's stream grants nothing; group `egress` over `cmd.egress.*` is the
  one designed cross-consume. N-9 tests the positive path of every granted
  endpoint alongside the refusals (a missing required endpoint fails the
  check); N-10 and Q8 assert both the workerd process's scrubbed zero and
  each gateway's exact matrix row. No new isolation engine and no
  certificate machinery, per the finding's own bound.

- **R4-06 — FIXED** (ADR-010 Q5's network table, the touch-the-world
  exceptions and the point-5 summary; design: the network table, the new
  allowed-path table, the container view, the Caddy-routing bullet, the
  stop-first/rollback sequences, `rollbackDeadlineMs`'s row and the
  architecture-rules exceptions; checks N-8, Q9): the owner's web surface
  is routed THROUGH the ingress gateway exactly as decided — the whole
  root host (UI/session, POST submit, transcript, reply pull) terminates
  on the ingress gateway's pool on `intake-ready`, and the Caddy-facing
  `current` alias into generation containers is retired (the core is
  bus-reachable only; a core replacement and rollback now move NO alias,
  which Q3, N-17 and the `rollbackDeadlineMs` row state). The two decided
  cross-network exceptions got their network rows and an explicit
  allowed-path table: `vault-egress` (Agent Vault ALONE — the egress
  path's last hop ends with the vault's own outbound leg, without making
  `front-vault` non-internal), and `motor-sandbox` (internal — the
  sandboxes' only route is the egress gateway as `HTTPS_PROXY` under the
  motor policy, with no bus, store or Docker path). N-8 now asserts the
  membership claim as amended (non-internal members are only Caddy, the
  egress gateway and Agent Vault), keeps every other confinement attempt
  failing by unreachability, and exercises positively ONLY the two exempted
  paths; Q9 asserts the sandboxes hold no network beyond `motor-sandbox`.
  No certificates and no new isolation engine, per the finding's own bound.

- **R4-07 — FIXED** (ADR-010 Q7's revocation bullet, the point-7 summary and
  the O7 option rows; design "Leases at a replacement" and the container
  view; checks Q8(v) and N-18): the generation-wide revoke-before-start
  clause is replaced by revocation of the RETIRED instance only, at its
  CONFIRMED exit — a start-first replacement's old instance keeps its
  leases until then and finishes its in-flight work on them, unchanged
  modules' leases are untouched, and for the stop-first core the confirmed
  exit already precedes the new core's start, so the revocation lands
  immediately before it (the enforcement half of stop-first, unchanged for
  the core). Q8(v) now asserts the ordering with the gateway-only rollout
  lease diff (exactly the two gateway instances move); N-18 carries the
  same ordering and its unit tests the recorded revoke-after-confirmed-exit
  sequence.

- **R4-08 — FIXED** (ADR-010 Q5's decided paragraph, Q7's lease-lifecycle
  bullet and the point-5 summary; design: the container-spec rules in
  "Architecture rules", the lease-lifecycle bullet, a new reconciliation
  step 4 (daemon restarts revive nothing by policy), the panic bullet;
  checks Q5, F7, Q9, N-18): independent Docker restart policies are
  reserved for static infrastructure and the loader container; MODULE
  containers carry none. Every module (re)start is the loader's controller
  action, gated on its durable state — panic.json first in precedence,
  maintenance mode, and the rollout record's intent — and re-creation
  always makes a FRESH container with a fresh wrapped secret-id, never the
  old container revived in place. Q5's walk gains the daemon-restart cut
  in the stop-first crash window (the stopped old core is not revived
  beside the new one; the reconciler completes the switch from the
  record) and the panic/maintenance no-revival assertion; F7 asserts the
  same across its fixture; Q9's spec builders assert the absence of
  module restart policies; N-18's re-issuance branch follows the
  loader-driven re-creation. No new singleton machinery and no
  certificates, per the finding's own bound.

- **R4-09 — FIXED** (ADR-010 point-2 summary; design: the reconciliation
  intro's new durability rule, the panic bullet; checks Q5, F7 (the
  resume case), N-19 (the bootstrap resume); inventory 1.1 row 54's
  decision cell): every loader record write is durable before its
  dependent action — fsynced temporary contents, atomic rename, fsynced
  parent directory — before a Docker or store call, an epoch step, an
  owner acknowledgement or a panic latch's removal; a storage failure
  at any step leaves the record ABSENT and the loader treats it as never
  written; rename alone is never treated as durability. Q5 gains the
  POWER-LOSS/STORAGE-FAILURE persistence cut (no durable record → no
  dependent action, no acknowledgement; a cut between a latch's removal
  and its acknowledgement leaves the panic block standing), and the
  design separates the process-death crash cuts from the power-loss
  persistence cut so the latter is never claimed proven by the former.
  No storage engine change and no journal format, per the finding's own
  bound.

- **R4-11 — FIXED** (design: the Q2 check row SPLIT, the inventory's Q2
  scenario/measure amended; the owner's stop-first strategy is kept, no
  pre-activation core added): Q2 is split into its two cases — (a) the
  KEYED-MODULE never-ready case keeps the zero-bump / N-answers-throughout
  assertions the strategy can actually deliver; (b) the CORE stop-first
  readiness-failure case asserts what that strategy can deliver: the
  epoch moved EXACTLY once and never again, durable intake throughout
  (the ingress gateway kept accepting and XADDing to `inbound`), and the
  bounded FALLBACK ON CURRENT DATA — the previous commit's core restores
  under the stop-first rules, the epoch value never reused, never a
  frozen instance. `generations/never-ready` runs BOTH cases (a gateway
  AND the core), so the core case can no longer hide behind a
  gateway-only exercise.

- **R4-12 — FIXED** (design: the snapshot-copy paragraph in the stop-first
  contract points, the N-20 row and its walk cell): the restore NO LONGER
  treats post-copy bus entries as LOST-by-truncation — the destructive
  rewind the finding named is gone. The restore replaces the SNAPSHOT
  ALONE and keeps the current bus: no rewind, no deletion; retained
  entries after the copy instant replay under their keys, so
  accepted-but-not-yet-processed inbound messages and commands with no
  done record re-deliver normally (post-offset minus dedup) and done
  records settle duplicates; only entries the retention has ALREADY
  trimmed cannot replay and are listed as unreconciled in the restore
  report. N-20's walk asserts zero stream entries deleted and that an
  accepted-but-unprocessed inbound message reaches the
  answered-exactly-once contract through the replay.

- **R4-13 — FIXED** (design: the rollback-deadline bullet, the Q3 check
  row and its walk; inventory Q3's measure): restoration and
  maintenance-on-expiry are stated as TWO DISTINCT measured outcomes and
  never conflated — expiry opens maintenance with the report naming the
  ran-over step, which is not restored service. The budget allocation is
  NAMED instead of assumed: the clock's largest claimant is a module
  stop grace at its declared maximum plus the replacement's readiness
  bound, and Q3's walk now measures a MAXIMUM-DURATION in-flight call
  during a MULTI-module rollback, reporting its share of the 300 s
  against that allocation. An early-stop policy is stated: a stop grace
  too long for the clock makes the loader refuse the rollback at entry
  into maintenance rather than time out mid-drain.

- **R4-14 — FIXED** (ADR-010 the Fencing paragraph; design: the
  stop-first sequence, contract point 7's lease bullet, the Q7 check's
  new case (v) and its walk cut): stop-first now CONFIRMS the fence's
  server-side half — after the confirmed Docker exit the loader revokes
  the retired core's per-instance leases (revocation kills its
  connections) and WAITS, bounded, until no live Postgres backend of
  the retired core remains before the snapshot copy and the bump are
  taken; an already-submitted statement dies undecided with the revoked
  session, and an old apply that already checked `active_holder` cannot
  outlive the fence point. Q7's case (v) tests the
  delayed-old-transaction cut; the bounded wait's overrun names the
  step in the report. No two-store epoch barrier was restored, per the
  finding's own bound.

- **R4-15 — FIXED** (ADR-010 the point-8 contract-steps bullet; design:
  the new "Contract retirement has a rule" bullet in the bus-contract
  rules and the N-3 check's retirement arm): the removal half of
  expand/contract is stated to be OUTSIDE this milestone explicitly —
  the gate stays expand-only FULL compatibility and deprecated items are
  only marked. A later contract step that removes a deprecated shape is
  admissible only when BOTH arms hold, checked by the same point-5
  comparison at its rollout: no commit the compatibility window could
  still boot consumes or produces the old shape, and no outstanding bus
  reference can still deliver under it (the trim floor passed; no
  retained snapshot copy's pending-effect list names it). Failing
  either, the trimming candidate is refused with the diff as the report.

- **R4-16 — FIXED** (design: the snapshot-copy paragraph and the N-20
  row): the wrong property is replaced — the gateway-only rollout
  assertion is NO snapshot COPY taken, no core instance/epoch replaced,
  and the core's tick commits CONTINUED through the rollout, not byte
  equality of the live snapshot (an unchanged core keeps committing a
  fresh snapshot every tick, as it must).

### Round 4 confirmation

Confirmation of `git diff 766ecd0..30db2597aae33870033abebd28b52ac00e232ce2`
(`HEAD` when checked) against R4-01..R4-10 and “Round 4 dispositions”,
under OWNER-DECISIONS.md's point-0 threat model. This is not another review
round. CLOSED below means the written mechanism covers the original cut
and the named check specifies its proof; it is not a runtime PASS. No
product suite or CI-only walk ran. The automatic document-readiness gate
is not installed and did not run.

References: `ADR-010` = `docs/adr/010-container-generations.md`; `design` =
`docs/features/instance/containers-design.md`. Line numbers refer to the
checked revision.

- **R4-01 — CLOSED:** atomic, durable `in-flight` admission precedes dispatch (ADR-010:443-462; design:848-864); N-12 pairs death before admission with death after dispatch/before completion, proving unkeyed uncertainty without redispatch and keyed recovery under the same id.
- **R4-02 — CLOSED:** the job rules distinguish idle from fencing, authorize retiring-instance reclaim only after confirmed exit, and bound queue/call/parked time (design:833-847, 885-892); N-5/N-13 check the bound and paused/parked overruns, with same-key destination dedup for keyed work and no automatic redispatch for an admitted unkeyed attempt.
- **R4-03 — STILL OPEN:** missing a health decision/check for demand arriving at window start when the declared delivery-to-result bound exceeds the 120 s window (design:593-594, 621-636; N-16): the allowed 300 s call bound lets both original silent-wedge cases be accepted before demand becomes aged.
- **R4-04 — STILL OPEN:** missing instance-specific delivery of bootstrap packets and subsequent projections during old/new adapter overlap (design:348-362 still uses competing members of group `adapter`), plus a readiness-check exception for the required bootstrap command/rows (N-14 versus F2/N-22's zero-write assertions).
- **R4-05 — STILL OPEN:** missing required endpoints in the exact per-process matrix (ADR-010:830-837): core reads of `inbound`, adapter publication of function signals on `bus`, and Motor publication of `motor.result` on `bus` (design:245-246); N-9/N-10 cannot both enforce the exact matrix and pass those normal paths.
- **R4-06 — STILL OPEN:** missing the Motor-to-private-proxy network/allowed-path row and its Q9 exemption (design:68-100, 1185 still forbids a proxy path from any module), plus explicit internal flags for `front-web`/`front-loader` consistent with N-8's exclusion of ingress and loader from non-internal networks.
- **R4-07 — CLOSED:** the governing ADR now revokes only the retired instance after confirmed exit (ADR-010:855-863; design:573-589); Q8(v)/N-18 assert the gateway-only lease diff, unchanged leases, and the old gateway's in-flight completion before revocation.
- **R4-08 — CLOSED:** module specs have no independent restart policy; every fresh-container restart is controller-gated on panic, maintenance and rollout intent (design:797-806, 1105-1118); Q5/F7/Q9/N-18 cover daemon restart in the stop-first cut, no revival under panic/maintenance, and fresh secret-id delivery.
- **R4-09 — STILL OPEN:** missing a recoverable rule/check for directory-sync failure after rename (design:752-754 incorrectly assumes the record is absent) and an achievable panic-resume cut assertion (design:735-738; F7/Q5 expect the block to stand even after durable deletion but before acknowledgement).
- **R4-10 — CLOSED:** settlement alone cannot prune proof while a PEL, undelivered command, parked delivery or retained copy can re-issue the key (design:906-921); N-12 proves result-before-XACK tombstone retention/redelivery and N-20 proves kept-proof restore after pruning opportunities and refusal of missing-proof copies.

**Summary: 5 CLOSED, 5 STILL OPEN. Checks ready for to-stages: NO.**
Resolve R4-03's window/bound decision, R4-04's per-instance projection
route and readiness-write exception, R4-05's complete positive grant
matrix, R4-06's required routes/internal flags and matching exceptions,
and R4-09's persistence-failure/resume semantics; make their named checks
prove those same scenarios without contradictory assertions. The already
recorded charter amendment remains a separate prerequisite; it is not a
new finding here. No new finding or rejected anti-malice mechanism is added.


### Round 4 confirmation dispositions

Recorded by the gap-closing pass (lifemodel-b0r.9.10), one entry per
STILL OPEN line of the confirmation above. Each entry adds exactly what
its line names — the ADR section, the design section and the check — and
nothing more. `ADR-010` = `docs/adr/010-container-generations.md`;
`design` = `containers-design.md`.

- **R4-03 — CLOSED** (ADR-010 A8's window-length sentence; design: the
  window's opening paragraph and the aged-demand bullet, the
  `healthWindowMs` settings row, F8's invariant list; check N-16): a
  module whose declared delivery-to-result bound exceeds
  `healthWindowMs` EXTENDS the window to that bound — demand arriving at
  the window's start ages past the bound INSIDE the window, so the ~300 s
  call bound can no longer accept the two silent-wedge cuts at the 120 s
  mark. N-16 walks the extension cut (a 300 s-bound wedge failing at
  bound expiry inside the extended window) beside its GREEN exemption (a
  legitimate parked call within its bound).
- **R4-04 — CLOSED** (ADR-010 Q6's bootstrap steps (1)-(2); design: the
  bootstrap bullet, the `state.bootstrap.<adapter-instance>` stream row,
  the core/adapter credential paragraphs; checks N-14, N-22, F2): the
  `bootstrap.request` carries the fresh adapter's INSTANCE id and the
  applier answers on the INSTANCE-ADDRESSED
  `state.bootstrap.<instanceId>` stream — never on the shared group
  route, which the old/new overlap's competing members could drain — and
  appends every subsequent projection change to that stream until the
  retiring instance's confirmed exit (content-derived keys absorb the
  dual delivery; the stream is removed at the exit). N-22 and F2's
  zero-write assertions gain their ONE named exception: the fresh
  adapter's keyed `bootstrap.request` and the instance-addressed answer
  packets are the readiness's own required material, carry no effect,
  and are asserted present for a replaced function host and absent
  everywhere else. N-14's walk gains the old/new-overlap case (both
  instances reach complete read sets; the stream removed at the old
  instance's confirmed exit).
- **R4-05 — CLOSED** (ADR-010: the role-matrix rows and the point-7
  summary; design: the core/adapter/Motor credential paragraphs; check
  N-9): the exact per-process matrix now grants the three missing
  required endpoints — the core's plain `inbound` read (offsets riding
  the snapshot), the adapter's publication of the function's declared
  `signal.<kind>` on the `bus`, and Motor's publication of
  `motor.result` on the `bus` (the Motor row split from "every other
  module"). N-9's positive-path assertion covers every granted endpoint,
  so enforcing the exact matrix and passing the normal paths no longer
  contradict.
- **R4-06 — CLOSED** (ADR-010: the network table, the port-publish note,
  the point-5 summary; design: the network table, the `motor-docker` row
  in the allowed-path table, the Motor-exception paragraph, N-8, Q9):
  the Motor module's route to ITS OWN Motor socket proxy has its
  network (`motor-docker`, internal, those two members alone) and its
  allowed-path row (motor-labelled containers ONLY — the narrow motor
  verb allowlist), and Q9 states it as the ONE named proxy-path
  exemption instead of forbidding a proxy path from every module. The
  `front-web` and `front-loader` rows carry explicit `internal: yes`
  flags consistent with N-8's exclusion of the ingress gateway and the
  loader from non-internal networks; Caddy's published port
  (127.0.0.1:8080) rides the one non-internal front leg, `front-vault`
  (a port cannot publish from an internal network). N-8 inspects the
  extended internal list and exercises the three allowed paths.
- **R4-09 — CLOSED** (ADR-010's point-2 summary; design: the
  reconciliation intro's durability rule and the panic bullet; checks
  Q5, F7): the three record-write failures are SEPARATED — a failed
  contents-fsync or rename leaves the record absent (assumed never
  written); a failed parent-directory sync after a COMPLETED rename is
  RECOVERABLE by re-read (a complete read-back proceeds, an incomplete
  one is rewritten through the same fsync → rename → dir-sync cycle),
  never assumed absent. The panic-resume cut is restated as the
  ACHIEVABLE pair — the owner's authorization recorded durably FIRST,
  then the latch removed durably: a cut before the durable removal
  leaves the block standing (the latch IS the block), a cut after the
  durable removal leaves the block clear with the lost owner
  acknowledgement harmless (the durable resume record carries the
  authorization), and the unachievable standing-block-after-durable-
  removal is never asserted.

**Summary: 5 CLOSED (R4-03, R4-04, R4-05, R4-06, R4-09).** The Checks
section is consistent with the five fixes and FINAL for to-stages: every
check this part touched is named where it runs (isolated launcher unit
and CI-only walk) or a named human judgement, and no check's assertions
contradict the written mechanism.

## Platform decision 2026-10-12 (k3s + GitOps)

The owner's platform decision (OWNER-DECISIONS.md, last entry, 19:32 UTC)
was made AFTER round 4 and its confirmation dispositions. Like the
simplification section above, it re-reviews MECHANISM, not verdicts: ADR-010
and containers-design.md were rewritten FROM SCRATCH on k3s + GitOps
(lifemodel-b0r.9.11, parts 1-4); the round-3 and round-4 dispositions above
remain the record of how the Compose shape reached where it was. This
section records, per surviving finding, whether the platform decision
SUPERSEDES the recorded fix (the mechanism is re-homed), AMENDS it, or
whether the finding REMAINS a requirement unchanged. The noun map is in the
rewritten design's Checks section (the mechanism noun map).

### Superseded — the recorded fix's mechanism is re-homed by the platform

| Finding (fix's home) | What the recorded fix relied on | Superseded by | The requirement now lives in |
|---|---|---|---|
| R3-01 / R3-09 (keyed-job rules; in-grace completion) | Compose `stop_grace_period`, container stop/exit confirmation, no module restart policy (R4-08's instrument) | the platform decision: Deployments with `terminationGracePeriodSeconds`, RollingUpdate/Recreate strategies, CONFIRMED POD TERMINATION (observed, never assumed — A12), in-place restarts as fresh bootstraps | The same keyed-job rules (consumer groups, XAUTOCLAIM above the declared bounds, done records) — unchanged; the checks N-12/N-13, walks `generations/job-takeover`, `generations/switch-messages`. |
| R3-02 / R3-03 (the fence's shape) | the loader's epoch write and confirmed container exit; the `active_holder` UPDATE by the loader | the platform decision's Q2 wording: the NEW CORE takes the epoch itself (the Lua CAS) and sets `active_holder` at takeover; the operator GATES (HelmRelease suspend/resume, scale to 0) and VERIFIES the post-conditions; the fence's server-side half is the bounded lease-revocation/backend drain (R4-14, carried) | The design's stop-first sequence; checks Q7 (stale writes, including case v), F2, walk `generations/stale-writes`. |
| R3-04 (re-hydration) | no handoff key after stop-first | unchanged in substance; the gated window and the new core's self-activation restate it | The design's stop-first sequence; Q5's epoch-vs-record branches. |
| R3-06 / R3-07 / R3-18 (checks bound to the commit pair; build identity) | the loader's build stage and schema-file comparison | the operator's build stage: rootless BuildKit pods into the local registry, tag = build-input hash; the commit-pair comparison unchanged, run at every rollout regardless of reuse | Checks N-1/N-2/N-3, walks `generations/timing`, `generations/candidate-beside`. |
| R3-11 (identity/containment) | Docker `internal: true` networks + the stream-name identity; mTLS deferred | namespaces + default-deny NetworkPolicy (the P1-P16 rows — unreachability by absence of a row) + the Valkey ACL stream identity, carried unchanged | Checks N-8/N-9, Q8(iv), walk `generations/internal-egress`. |
| R3-15 (front-door cutover) | Caddy dynamic upstreams over the `intake-ready` alias | Traefik Services whose Endpoint membership follows pod readiness; the whole root-host surface terminates on the ingress gateway's Service; a core replacement moves no Service (R4-06, carried) | Check N-17, walk `generations/switch-messages`. |
| R3-16 / R3-17 (credential lifecycle and visibility) | wrapped single-use AppRole secret-ids, envconsul agents, `docker inspect` invisibility | Kubernetes auth (the service-account projected JWT is the ONLY bootstrap material — nothing is delivered to the pod) + Agent Injector process supervision — AMENDED 2026-10-13, R5-04: the supervising agent is the Bank-Vaults secrets webhook's vault-env in daemon mode; the pod spec carries no credential material; operator-rendered env is a recorded posture downgrade, never a default (A5) | Checks N-7/N-10/N-18, Q8, walk `generations/credentials`; the per-process matrix (R4-05) carried verbatim. |
| R3-19 (bootstrap; proxy verbs) | `docker compose up -d`, the loader's bootstrap DAG, BOTH proxies' pinned verb allowlists | ONE command = k3s install + Flux bootstrap (clean VM) / `helm install` (existing cluster); the idempotent bootstrap DAG carried, recorded in the rollout records; the verb-allowlist duty is gone with the proxies | Check N-19, walk `generations/clean-bootstrap`; the RBAC table replaces the allowlists. |
| R3-21 / R3-22 (durability; copies) | the loader's fsync/rename/dir-sync record durability; panic.json | rollout records + panic/maintenance state as CLUSTER RESOURCES, write-and-read-back-complete (etcd quorum commit); panic = Flux suspend + scale to zero, durable cluster state, NO panic.json (F7 amended); the snapshot-copy rules unchanged (taken only at a core replacement, manual maintenance-only restore, no bus rewind — R4-10/R4-12 carried) | Checks Q5, F7, N-20, walks `generations/operator-crash-cuts`, `generations/snapshot-copy-restore`. |
| B08 (Docker authority) | the socket proxies as defence in depth; the daemon-root-trust statement | NO Docker anywhere in the cluster; RBAC is the authorization model — the operator's row is the whole lifemodel mutation surface, Motor's Jobs row is the ONE module exception, module service accounts grant NOTHING; the blast-radius statement carries (the operator's rights are the widest mutation surface; the cheap guards go exactly as far as the owner asked, A2) | Q9's RBAC check, the design's RBAC table, N-8; the allowlist human judgement is replaced by the RBAC-posture judgement. |
| R4-08 (independent restarts bypass the controller stop gate) | "no module carries a restart policy" as the instrument | on k3s a pod RESTARTS IN PLACE by restartPolicy — the rule is restated, not the instrument: an in-place restart is a FRESH bootstrap (re-authenticated, rejoins its group), new CODE arrives by no path other than an operator rollout through the deploy branch, and panic/maintenance hold scale-0 cluster state a node restart revives nothing of | The design's reconciliation step 4 and architecture rules; checks Q5 (node-restart cut), N-18, F7. |
| R4-09 (write-ahead records lack power-loss durability) | the fsync → rename → dir-sync triple on loader files | etcd's quorum commit: a record is WRITTEN AND READ BACK COMPLETE before anything acts on it; a record not read back complete is rewritten before anything acts; the panic/resume cuts are the same ACHIEVABLE pair over the durable record | Checks Q5, F7, N-19/N-20; walk `generations/operator-crash-cuts`. |
| B05 / B06 / B07 / C01 / C02 | the Compose-era mechanisms they were resolved with | their REQUIREMENTS carry whole (expand/contract with no down path; the 300 s rollback deadline with distinct outcomes; durable intake through the serving gap; the crash-cut walk; measured values); the mechanisms are the platform's above | F5/F6/Q3/Q4/Q5 checks as rewritten; `rollbackDeadlineMs` 300 s unchanged. |

### Remains as requirements inside the k3s shape

- **The round-4 set (R4-01..R4-16)** — every requirement survives; the
  checks are rewritten with the platform's nouns (the design's Checks
  section names the walk for each): R4-01 (the `in-flight` admission), R4-02
  (the delivery-to-result bound above min-idle; termination-authorized
  reclaim), R4-03 (aged demand + the window extension), R4-04
  (instance-addressed adapter bootstrap + the N-22 exception), R4-05 (the
  per-process matrix), R4-06 (no front route to the core; vault last hop;
  the sandbox proxy path), R4-07 (revoke-after-confirmed-termination),
  R4-10 (prune only past the last re-issue path), R4-11 (the Q2 split; the
  never-frozen/never-reused-epoch fallback), R4-12 (restore keeps the bus),
  R4-13 (rollback's two distinct outcomes), R4-14 (the server-side fence:
  the bounded backend drain), R4-15 (contract retirement's two arms),
  R4-16 (gateway-only: no copy, tick commits continue).
- **The kept-mistake-barrier and stated-trade posture** — the cheap guards
  (epoch CAS, `active_holder`) defend against controller bugs, not hostile
  modules; RBAC and NetworkPolicy are mistake barriers, not blast-radius
  bounds; no mTLS (deferred, returns when modules span machines or come
  from foreign sources — the point-0 invalidator).
- **Q11 stays a measurement** (the measured set now names the platform's
  members, including a BuildKit build pod); the egress gateway's grace
  stays the measured value against the 300 s target (open question 1).

### Still open (unchanged, now owned by the rewritten documents)

Open questions 1-7 in the rewritten ADR (the egress grace measurement, the
XAUTOCLAIM min-idle default, the Windmill/Temporal research before outcome
6, the local registry implementation/persistence, the deploy branch's home,
the in-cluster build budget, and — DECIDED by part 4 — the k3d walk scope,
settled in the Checks intro). The charter amendment (R3-24) is still
OWNER-PENDING and now needs the k3s shape (per-module HelmReleases, no
executor, no down path, the platform's door/network shape); the inventory's
PENDING-CHARTER-AMENDMENT markers stay until it lands.


## Round 5 (k3s ADR review, 2026-10-12)

**Reviewer model:** `openai-codex/gpt-6.1-sol`. Independent of the design
author; two read-only, same-model scoped reviewers assisted this ONE round.
Findings were consolidated and checked against the inputs and upstream
platform documentation. No fix or confirmation round is included.

**Scope:** HEAD `1170b2427050c654333af85f95285b8e5aad57c8`; OWNER-DECISIONS.md (later
comments amend earlier ones), ADR-010, containers-design.md including Checks,
containers-inventory.md, this review history including “Simplification
2026-10-12” and the platform dispositions, docs/charters/instance-1.md, and
the cited existing loader/auth/first-start surfaces. Every F1–F8 and Q1–Q13
was walked. F8 is the design’s configuration check; the inventory itself
lists F1–F7. `ADR-010` below means `docs/adr/010-container-generations.md`;
`design` means `docs/features/instance/containers-design.md`; `inventory`
means `docs/features/instance/containers-inventory.md`. Line references are
to the reviewed revision, before this appendix.

**Threat model:** trusted against malice, not against bugs. The platform
(k3s on a VM, Flux, Helm, CNPG, Traefik, OpenBao Injector/Kubernetes auth — the Injector mention superseded by the R5-04 owner decision: the Bank-Vaults secrets webhook)
is fixed and is not re-argued. Risks below require only honest bugs,
crashes, hangs, slow dependencies or reboot. They do not request mTLS,
commit gateways, two-store fencing barriers, executor engines, heartbeats,
reader-on-data runs or admission records binding images to compatibility.
Schema-only semantic compatibility remains the owner’s accepted residue.

**Summary: 13 BLOCKING, 7 COMMENT.** The work plan cannot yet be
built on the written rollout, normal bootstrap and recovery contracts.
BLOCKING means the mechanism or contract needs settlement before planning;
COMMENT names a sensitivity, trade-off or check clarification. This is a
design/source review, not runtime acceptance: no suite, live engine/cluster
experiment, clean-VM install or CI-only acceptance walk was run. The
automatic document-readiness gate is not installed and did not run.

### Scenario walk, sensitivity points and trade-offs

“Specified” below is not a runtime PASS.

| Scenario | Walk result / sensitivity | Findings |
|---|---|---|
| F1 | Input-hash reuse is specified; serial Git/Flux ownership, build rights and projection overlap are unresolved. | R5-01, R5-07, R5-08, R5-10, R5-13 |
| F2 | The singleton fence and readiness/group-join predicate depend on real controller semantics, not noun substitution. | R5-01, R5-03, R5-05, R5-15 |
| F3 | Keyed message rows and persisted effect ids remain appropriate; singleton overlap, copy fallback and stale projections undermine continuation. | R5-03, R5-12, R5-13 |
| F4 | Completed-work analysis and one fallback are retained; Git gating and full launch-state rollback are required. | R5-01, R5-10, R5-12, R5-14 |
| F5 | Schema-only read-or-refuse on current data is accepted; boot must select the complete older release, not only its images. | R5-10 |
| F6 | Commit-pair FULL schema comparison, expand-only SQL, no downs and semantic-review residue remain fixed trades. SQL grant ownership needs precision. | R5-16 |
| F7 | One-command and persistent panic do not yet have complete bootstrap, credential, routing and crash-convergence mechanisms. | R5-02, R5-04–R5-09, R5-17–R5-20 |
| F8 | Walked as design’s configuration check (inventory defines F1–F7); rendered seconds differ from millisecond defaults. | R5-11, R5-14, R5-15 |
| Q1 | Durable ingress remains the accepted pause mechanism; the pause equation omits platform waits. | R5-01, R5-11, R5-14 |
| Q2 | Never-ready cases are split, but startup predicates and latest-snapshot fallback need correction. | R5-08, R5-12, R5-14, R5-15 |
| Q3 | 300 s restoration versus maintenance-on-expiry is explicit; restoration must include launch state and no copy rewind. | R5-01, R5-10–R5-12, R5-14 |
| Q4 | Snapshot/outbox, before-effect admission and natural-key replay remain specified; native replacement and adapter restart are sensitivities. | R5-03, R5-04, R5-12, R5-13, R5-15, R5-20 |
| Q5 | Write-ahead intent and epoch reconciliation are useful; panic partial writes, Flux ownership and datastore assumptions need evidence. | R5-01–R5-03, R5-06, R5-08, R5-10, R5-18 |
| Q6 | AOF-always, pressure failure and all-group trim floors are specified, not runtime-proved here; required store/auth paths must work. | R5-05 |
| Q7 | One-node confirmed termination is accepted instead of the rejected barrier, but Recreate/API absence is not that confirmation. | R5-01, R5-03 |
| Q8 | Model-key absence is distinct from scoped store credentials; launch, auth/network, grants and expiry are load-bearing. | R5-04–R5-06, R5-16, R5-19, R5-20 |
| Q9 | RBAC replaces Docker, but build rights and Job-template admission are different duties; node/API exceptions need concrete tests. | R5-05, R5-07, R5-09 |
| Q10 | Same-login reports and maintenance remain specified; usable setup/key-entry routes and complete panic state are missing. | R5-02, R5-05, R5-19 |
| Q11 | Synchronized aggregate sampling and named platform line items remain correct; no 11 GB constraint is reintroduced. Job-volume lifetime affects the measured cost. | R5-09 |
| Q12 | Build/input reuse and commit-pair timing remain useful; cold pulls, rendered grace and workload-only changes need coverage. | R5-07, R5-08, R5-10, R5-11 |
| Q13 | Bus-only async results and durable delayed rows retain tick-only intent; projection fan-out/handoff does not preserve the promised read state. | R5-13 |

The main trades remain short core pauses versus queued background work;
start-first availability versus overlapping consumers; image reuse versus
fresh commit-pair checks; manual recovery versus retained proof/storage;
and local GitOps autonomy versus Git/registry/controller dependencies.
The selected platform is not called disproportionate merely because it has
more components. Within it, R5-04 names standard tmpfs delivery instead of
cross-container supervision, R5-08 a single-node registry instead of
replicated storage, R5-13 ordinary projection fan-out instead of an
exit-switched dual route, R5-18 the actual single-node datastore instead of
adding HA solely for wording, and R5-19 reuse of the authenticated Vault UI
instead of a new key-management interface.

The charter mismatch is already pending as R3-24, now explicitly carried
by the platform disposition (this file:2531-2534). The charter still says
Docker-only delivery, whole generations, no module split and reversible
downs (docs/charters/instance-1.md:15-51, 69-90, 112-132); the inventory’s
AMENDED notes correctly warn against planning from those prescriptions.
Amendment remains a prerequisite to the work plan, not a newly counted
finding in this round.

### Findings

### R5-01 — The serial rollout gate has two conflicting owners

- **Severity:** BLOCKING.
- **Scenario:** F1/F2/F4; Q1/Q3/Q5/Q7.
- **Evidence:** ADR-010:400-417, 463-469; design:506-536, 569-579, 789-798, 957-965; [Flux apply ownership](https://fluxcd.io/flux/components/kustomize/kustomizations/#controlling-the-apply-behavior) and [HelmRelease suspension](https://fluxcd.io/flux/components/helm/helmreleases/#suspending-and-resuming).
- **Risk / sensitivity:** When one deploy-branch commit contains several changed tags, Flux can reconcile their releases concurrently. Conversely, the operator’s direct values/suspend patches can be overwritten by source-owned fields; suspending a release also does not cancel an already-running Helm action. One release per module is not a serial or stop-first gate.
- **Fix:** Choose one protocol: publish each gated step through Git, or explicitly separate source-owned fields from operator-owned gates with revision-aware dependencies. Require acknowledgement/quiescence of the relevant Flux controllers before scale-down, and test concurrent reconcile and operator-crash cuts against real Flux.

### R5-02 — Panic is a multi-resource transition, not an atomic durable latch

- **Severity:** BLOCKING.
- **Scenario:** F7; Q5/Q10.
- **Evidence:** ADR-010:604-611; design:877-904, 927-941, 969-978; F7/Q5 checks at design:1353, 1364.
- **Risk / sensitivity:** An operator crash after recording panic or suspending one release, but before suspending/scaling the remaining workloads, leaves some modules running. Reconciliation only says to read the suspend/scale state first and keep it standing; it does not define how a partial panic becomes the complete block. A parent Flux Kustomization can also restore a child’s source-declared suspend field.
- **Fix:** Make the already-recorded panic intent authoritative and reconcile every release/workload to the stopped state before reporting completion, with parent-controller ownership settled as in R5-01. Cut the operator after each resource mutation, including during a running Helm action, and prove convergence without any start.

### R5-03 — Recreate and API disappearance do not prove at-most-one core

- **Severity:** BLOCKING.
- **Scenario:** F2/F3; Q4/Q5/Q7.
- **Evidence:** ADR-010:291-300, 359-367, 456-462; design:150, 528-536, 948-951; [Deployment Recreate](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#recreate-deployment), [forced Pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#forced-pod-termination).
- **Risk / sensitivity:** Recreate waits for old Pods on upgrades only: a ReplicaSet replaces a deleted Pod immediately even while it is Terminating. Force deletion removes the API object without proving process death. A discard/recovery bug outside the scale-0 gate can therefore create overlapping cores; the documented same-aimed-epoch restart then gives both writers the same accepted token.
- **Fix:** Use the owner-approved one-replica StatefulSet for the at-most-one identity, or apply the explicit stop-first gate to every Pod replacement path. Forbid force deletion/API absence as fence evidence; require observed terminal container status from the kubelet and refuse into maintenance if termination cannot be confirmed.

### R5-04 — Agent Injector is not the application-process supervisor described here

- **Severity:** BLOCKING.
- **Scenario:** F7; Q4/Q8; N-7/N-10/N-18.
- **Evidence:** ADR-010:952-968, 1001-1008, 1024-1038; design:209-234, 1388, 1392, 1401; [OpenBao supervisor](https://openbao.org/docs/agent-and-proxy/agent/process-supervisor/), [official injector sidecar](https://github.com/openbao/openbao-k8s/blob/main/agent-inject/agent/container_sidecar.go), [injector configuration](https://github.com/openbao/openbao-k8s/blob/main/agent-inject/agent/config.go).
- **Risk / sensitivity:** The official injector adds Agent init/sidecar containers and normally renders files into shared memory volumes. Supervisor env_template/exec changes only the Agent’s own child, not an app in another container; it requires exactly one exec and is incompatible with ordinary file templates. It cannot implicitly scrub workerd’s environment or kill the app when the sidecar crashes.
- **Fix:** Keep Kubernetes auth, but specify a real launch contract: Agent as parent inside each application container with a scrubbed launcher, or standard injector tmpfs files plus explicit reload/restart and crash behavior. The latter is a lighter option than inventing cross-container supervision or the unnecessary pod-spec-env downgrade; amend the visibility checks to the chosen mechanism.

### R5-05 — The exhaustive network policy excludes required platform traffic

- **Severity:** BLOCKING.
- **Scenario:** F1/F2/F7; Q6/Q8/Q9/Q10.
- **Evidence:** ADR-010:725-741; design:109-140, 1389; [k3s NetworkPolicy controller](https://docs.k3s.io/networking/networking-services#network-policy-controller), [OpenBao Kubernetes auth](https://openbao.org/docs/auth/kubernetes/). See also [NetworkPolicy node exceptions](https://kubernetes.io/docs/concepts/services-networking/network-policies/#the-two-sorts-of-pod-isolation).
- **Risk / sensitivity:** Normal bootstrap needs cluster DNS, OpenBao→stores for dynamic credentials, a Kubernetes-auth reviewer, injector/CNPG/Traefik control-plane access and webhook admission, and Agent Vault’s outbound hop. The exhaustive P1-P16 table omits these infrastructure dependencies; state/OpenBao are declared inbound-only and N-8 even requires module DNS resolution to fail. k3s has an embedded kube-router policy controller, but NetworkPolicy has node-traffic exceptions and does not turn namespace names into routes; bundled Traefik is normally in kube-system, not the pictured traefik namespace.
- **Fix:** Write the missing infrastructure and cluster-DNS policy rows against the actual installed namespaces/ports, keeping direct external DNS/internet denied to plain modules and Bao reviewer privilege on Bao’s service account. Pin enforcement-enabled k3s settings and test store issuance, auth, webhooks, route discovery and node/API exceptions positively, with sensitive paths and unauthorized mutations tested negatively.

### R5-06 — Clean bootstrap has no initial OpenBao trust and unseal path

- **Severity:** BLOCKING.
- **Scenario:** F7; Q5/Q8; N-19.
- **Evidence:** ADR-010:785-791, 1022-1023; design:241-244, 285-299, 1233, 1402; [OpenBao seal configuration](https://openbao.org/docs/configuration/seal/).
- **Risk / sensitivity:** The DAG expects initialized/unsealed Bao before the operator starts, then expects the operator to configure its roles. “Official chart’s auto-unseal under operator custody” names neither a seal backend nor persistent bootstrap authority outside Bao; the default without seal configuration is Shamir/manual unseal. A clean VM or reboot can therefore deadlock before module login.
- **Fix:** Name the initialize-once credential and operator-held unseal material’s persistent custody outside Bao, the actual seal mechanism, and the authenticated hand-off to steady-state roles. Define idempotent interrupted-init and sealed-reboot recovery without requiring a manual preparatory command.

### R5-07 — The operator’s RBAC cannot create its BuildKit workloads

- **Severity:** BLOCKING.
- **Scenario:** F1/F7; Q9/Q12.
- **Evidence:** Design:68-70, 142-157, 1347, 1382; ADR-010:389-402.
- **Risk / sensitivity:** On a first build the API server refuses the operator’s Pod/Job creation in lifemodel-system: its exhaustive row grants Pod reads/DELETE and migration Job creation in lifemodel-state, but no build workload creation. Diffing the rendered roles against this same incomplete table can pass while every real build fails.
- **Fix:** Add narrowly namespaced create/read/watch/delete rights for disposable build Jobs and their required resources in lifemodel-system. Add a positive operator-identity build/cleanup test, alongside refusal outside that namespace and the existing no-rights test for the build Pod itself.

### R5-08 — An in-cluster registry Service is not a node image-pull mechanism

- **Severity:** COMMENT.
- **Scenario:** F1/F7; Q2/Q5/Q12.
- **Evidence:** ADR-010:65-74, 401-417; design:69-70, 125-140, 285-303; [k3s private registries](https://docs.k3s.io/installation/private-registry).
- **Risk / sensitivity:** BuildKit can push to a Service, but kubelet/containerd pulls from the node network, not from a module Pod or its DNS/policy context. The proposed private registry has no settled node-resolvable address, TLS/trust or registries.yaml setup; a clean VM can complete the push and still fail every candidate with ImagePullBackOff. This choice is not merely persistence as the open question suggests.
- **Fix:** Specify a stable registry endpoint reachable/resolvable by both builds and the node, plus trust/auth and any registries.yaml configuration/restart in the one-command installer; a single registry volume on the sole node is lighter than replicated storage. Test a cold containerd pull after reboot with no preloaded module images, and record registry persistence/recovery separately.

### R5-09 — Jobs-only RBAC does not constrain a Motor Job’s Pod specification

- **Severity:** BLOCKING.
- **Scenario:** F7; Q9/Q11.
- **Evidence:** ADR-010:147-152, 782-784; design:150-178, 245, 501, 1368.
- **Risk / sensitivity:** An honest Job-builder bug can request privileged execution, hostPath mounts, an unintended service account, or no run deadline: RBAC authorizes Job creation, not those fields. The resulting Job controller can create that Pod despite Motor having only Jobs rights. Job workspaces/PVCs also do not automatically disappear just because the Job is deleted, and scaling Motor to zero does not stop its existing Jobs.
- **Fix:** Enforce restricted Pod Security in lifemodel-motor and validate the Job template’s service account, run limit and resource/volume policy before submission. Define tracked sandbox/volume cleanup, including panic, and test that invalid Jobs are refused and an interrupted cleanup leaves neither running sandboxes nor retained unowned volumes.

### R5-10 — Image-only rollback does not restore the previous desired state

- **Severity:** BLOCKING.
- **Scenario:** F1/F4/F5; Q3/Q5/Q12.
- **Evidence:** ADR-010:282-289, 397-400, 597-603; design:252-266, 506-515, 789-814, 863-870.
- **Risk / sensitivity:** A candidate can change probes, grace, environment, strategy, NetworkPolicy or RBAC while reusing all image tags. The operator selects replacements by image change, but Flux can apply the changed chart; reverting tags then leaves the bad launch configuration. Maintenance boot likewise combines older images with newer launch semantics instead of the selected commit’s desired state.
- **Fix:** Pin and record the complete release revision, including chart/templates and launch values; gate workload-affecting changes even when images are reused. Roll back that complete revision through Git and test a chart-only, readiness-breaking candidate whose image tags are unchanged.

### R5-11 — Kubernetes grace defaults are written in the wrong unit

- **Severity:** BLOCKING.
- **Scenario:** F8; Q1/Q3/Q12.
- **Evidence:** OWNER-DECISIONS.md:43; ADR-010:189-201; design:1220, 1354, 1386.
- **Risk / sensitivity:** terminationGracePeriodSeconds is labelled seconds, but the row assigns 300000 to egress and 30000 to other modules. Rendered literally, these are 83 hours 20 minutes and 8 hours 20 minutes, not 300 s and 30 s. The same-unit-looking grace/timeout inequality can also accept an invalid conversion.
- **Fix:** Render seconds as 300/30 (and the core’s 5 s bound), with explicit rounded ms→s conversion where the input setting uses ms. Assert the actual rendered Pod fields and timeout inequalities, not only OperatorConfig defaults.

### R5-12 — Never-ready fallback introduces an automatic snapshot restore

- **Severity:** BLOCKING.
- **Scenario:** F3/F4; Q2/Q3/Q4.
- **Evidence:** OWNER-DECISIONS.md:40; ADR-010:628-635; design:705-716 versus 820, 1350, 1403.
- **Risk / sensitivity:** The never-ready fallback starts the restored core “from the snapshot copy the window already took” (design:715). A failed candidate can have taken the epoch and committed work before readiness fails; restoring the earlier copy rewinds its committed offsets/pending state. It also directly contradicts manual-maintenance-only restore and the F4 assertion of no data-restore step.
- **Fix:** Every automatic fallback must hydrate the latest current snapshot on current Postgres data, taking a never-reused epoch; keep copies exclusively on the owner’s manual maintenance path. Add a readiness-failure cut after a candidate commit and assert that no copy is restored and no committed outcome is replayed.

### R5-13 — The projection handoff can lose updates and regress the cache

- **Severity:** BLOCKING.
- **Scenario:** F1/F3; Q4/Q13; N-14.
- **Evidence:** ADR-010:865-909; design:321, 327, 415-449, 1396.
- **Risk / sensitivity:** During overlap, both adapters compete in group adapter, while only the fresh instance receives the addressed projection copy; a projection consumed from the shared route by the fresh instance never reaches the still-serving old instance. At old termination the addressed stream is deleted without a final consumed-watermark barrier. A fresh-boot crash before draining it loses changes, and content hashes alone cannot order claimed old packets against newer repairs.
- **Fix:** Use ordered projection positions and a consume-through-watermark barrier before retiring any addressed history. A lighter mechanism than dual routing plus exit-time switching is a dedicated projection stream with independent per-instance read positions/fan-out; test a projection change and fresh-adapter crash exactly at the old-exit handoff, not just complete initial read sets.

### R5-14 — The stated 65-second serving gap omits the new platform waits

- **Severity:** COMMENT.
- **Scenario:** Q1/Q2/Q3; F8.
- **Evidence:** Design:600-615, 626-632, 827-852, 1360; ADR-010:212-216.
- **Risk / sensitivity:** A slow lease revocation/backend drain, snapshot-copy write, Git/source reconcile, scheduling or image pull sits between the old stop and first new commit. The equation “5 s + start-to-first-commit ≤ 60 s” excludes those waits, so its timing check cannot prove the claimed total pause even with a fast application boot.
- **Fix:** Name bounded waits and failure outcomes for those phases and report their sum as the actual pause; define when readinessWindowMs starts. Keep the owner’s short core-stop deadline and maintenance-on-expiry trade rather than hiding infrastructure time inside it.

### R5-15 — Readiness, consumer join and liveness need one coherent startup predicate

- **Severity:** COMMENT.
- **Scenario:** F2; Q2/Q4.
- **Evidence:** ADR-010:446-455; design:518-527, 573-576, 633-648, 1361; [Kubernetes probes](https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/).
- **Risk / sensitivity:** RollingUpdate may terminate the old Pod as soon as the new Pod is Ready; the written sequence joins its consumer group only afterward. The core’s last-commit liveness threshold is 15 s while initialization/readiness may take 60 s, with no startupProbe or activation gate specified; an honest slow boot can be restarted repeatedly before its first permitted real commit.
- **Fix:** Make successful group join and required bootstrap state part of the readiness predicate before Ready becomes true. Gate liveness with a startupProbe/explicit activated state, and test a valid boot longer than 15 s plus a slow group join against the real Deployment controller.

### R5-16 — CNPG manages roles, while SQL grants enforce schema containment

- **Severity:** COMMENT.
- **Scenario:** Q8; N-11.
- **Evidence:** ADR-010:159-160, 685-689, 990-994; design:149, 285-295, 1130-1131, 1393; [CNPG role management](https://cloudnative-pg.io/docs/devel/declarative_role_management/).
- **Risk / sensitivity:** The bootstrap already names SQL grant seeding, but the repeated claim that CNPG declarative roles enforce schema containment hides the distinction. Dynamic Bao login names and newly created DDL-owned tables need actual schema/table/default privileges; declared role attributes alone prove neither usable access nor refusal.
- **Fix:** Specify fixed per-module NOLOGIN grant roles managed by CNPG, leased LOGIN users inheriting them, and migration-owned GRANT/ALTER DEFAULT PRIVILEGES SQL. Check a newly migrated table with a newly rotated login positively and cross-schema access negatively.

### R5-17 — The clean-VM and existing-cluster checks are replaced by an empty k3d test

- **Severity:** COMMENT.
- **Scenario:** F7; N-19.
- **Evidence:** Design:285-303, 1326-1336, 1353, 1402; OWNER-DECISIONS.md:46.
- **Risk / sensitivity:** An empty, already-created k3d cluster does not execute a clean VM’s k3s installation, registry/containerd setup or reboot behavior. The named N-19 walk exercises Flux bootstrap only; no named walk exercises the separate helm install path. A green test therefore cannot establish either delivery entrypoint as written.
- **Fix:** Keep k3d for cluster mechanics, but add a bounded disposable clean-VM installer/reboot acceptance walk and a separate existing-cluster Helm walk, or explicitly mark those scenarios unproved. State required VM privileges, Git bootstrap inputs and supported existing-cluster prerequisites as command inputs, not hidden manual steps.

### R5-18 — The durability evidence assumes a datastore the installer never selects

- **Severity:** COMMENT.
- **Scenario:** F7; Q5.
- **Evidence:** Design:885-924, 1402, 1422; ADR-010:706-719; [k3s datastore defaults](https://docs.k3s.io/datastore).
- **Risk / sensitivity:** All cluster-resource durability is justified as etcd quorum commit, but a default single-server k3s installation uses SQLite, not embedded etcd. Read-back completeness is useful reconciliation evidence but does not select the datastore or prove its power-loss behavior; the k3d restart cuts do not supply that proof.
- **Fix:** Choose embedded etcd explicitly in bootstrap or document/test the actual SQLite-backed durability contract and persistent cluster-state storage. Do not add an HA datastore solely to preserve the word “quorum”; the lighter single-node datastore is acceptable if its required durability is established.

### R5-19 — The owner’s authentication and model-key entry routes are incomplete

- **Severity:** BLOCKING.
- **Scenario:** F7/Q10.
- **Evidence:** Design:268-284, 140, 1369, 1400; inventory section 3.2 (outcome-4 key entry); the former Caddy configuration:39-56, 81-104; loader/src/http.ts:604-634.
- **Risk / sensitivity:** The new design explicitly removes the Vault UI route but supplies no replacement key-provisioning route or operator→Vault access. The accepted first-start walk cannot put in its made-up model key. ForwardAuth is also unnamed on the root route and has no stated boot setup/login exception; applying it everywhere blocks first login, while applying it only to boot leaves chat/transcript unguarded.
- **Fix:** Map the setup/login/assets exceptions and protect every other owner router with ForwardAuth. Preserve the existing narrowly authenticated Vault UI as the lighter option, or name a replacement operator key-entry path and its network grant; test first setup, key entry, anonymous route denial and the model call end to end.

### R5-20 — Lease expiry during a Bao outage needs a local failure mechanism

- **Severity:** COMMENT.
- **Scenario:** Q4/Q8; N-18.
- **Evidence:** ADR-010:1024-1038; design:222-234, 1401; [OpenBao supervisor configuration](https://openbao.org/docs/agent-and-proxy/agent/process-supervisor/).
- **Risk / sensitivity:** The contract promises expiry independently of Bao availability and visible module failure, but does not name a local lease-age deadline or renewal-failure policy. An issued PG session does not end merely because its password’s lease expires, and server-side revocation cannot be relied on while Bao is down; default sidecar/file delivery also does not stop an app at expiry.
- **Fix:** Define a local lease-validity/renewal-failure rule for the chosen Agent launch contract, stopping work visibly at its deadline and re-authenticating on recovery. Test Bao-down-past-expiry with an already-open PG/Valkey session rather than only observing lease metadata after Bao returns.


### Round 5 dispositions

Resolution of the "## Round 5" findings, part 1 (task
lifemodel-b0r.9.13): R5-01, R5-02, R5-03, R5-10, R5-12. Each suggested fix
was taken, the lighter option where the finding offered one (R5-03: the
owner-approved one-replica StatefulSet instead of gating every Recreate
path; R5-01: gated steps published through Git instead of
field-separation machinery). R5-04 (credential delivery) was WAITING FOR THE
OWNER then — untouched in this part; now decided and FIXED (see the R5-04
disposition below).

- **R5-01 — the serial rollout gate has two conflicting owners — FIXED.**
  One protocol is chosen: every gated step is PUBLISHED THROUGH GIT. A
  rollout of a candidate is a sequence of deploy-branch commits, one per
  changed module in manifest order; each step closes only when the Flux
  controller is ACKed at the RECORDED revision (the release's status
  names the step's revision, never an earlier one) AND the module has
  passed its strategy-specific acceptance. The operator's two non-Git
  mutations (suspend, panic/maintenance scale) have settled single
  ownership: the source declares neither (`spec.suspend`, no gate scale —
  a build-stage lint refuses them) and no parent Kustomization
  re-declares the lifemodel Flux resources; a scale-down waits for the
  suspend ACK and for NO in-flight Helm action. Sections: ADR-010 Q2
  (the replacement-protocol bullets, one is now the Git-step gate,
  ownership, ACK/quiescence) and its rejected option O2-L (direct
  mid-rollout patching); containers-design.md "Module rollout sequences"
  (the gate is a Git step), the start-first and stop-first sequence
  diagrams (commit/ACK arrows), the operator-crash reconciliation load
  step; the RBAC table row (HelmRelease suspend/resume is the operator's
  gate field, values travel through the branch). Check: F1 (the gate
  step and its ACK pair), F2 (gate state machine), Q5 (a concurrent
  reconcile cannot move a second module; a crash between a step commit
  and its acceptance resumes at that step).
- **R5-02 — panic is a multi-resource transition, not an atomic durable
  latch — FIXED.** The panic intent is a durable record written and read
  back complete BEFORE any mutation, and it is AUTHORITATIVE: the
  operator reconciles EVERY lifemodel release to the stopped state,
  release by release — suspend (ACK; an in-flight Helm action is awaited
  to its outcome), scale to zero (ACK), the stopped state OBSERVED — and
  panic is COMPLETE only at the observed all-stopped state; a crash
  after any single mutation (or mid a Helm action) is re-driven by the
  recorded intent toward stopped, never starting anything; the
  parent-controller ownership is settled with R5-01 (no source-declared
  suspend, no re-declaring parent). Sections: ADR-010 Q3 (the panic
  bullet rewritten as the recorded-intent reconciliation), the
  decision-outcome summaries; containers-design.md "Rollback and
  maintenance" (the panic paragraph's transition rules) and the
  operator-crash reconciliation step 1 (an incomplete panic state is
  re-driven, completion is the observed all-stopped state). Check: F7
  (the transition walked release by release, an operator cut after EVERY
  mutation — including mid a running Helm action — ends in the
  all-stopped convergence with no start; the ownership lint), Q5 (the
  panic-convergence cuts and re-drive named in the walker).
- **R5-03 — Recreate and API disappearance do not prove at-most-one
  core — FIXED (the lighter option).** The core runs as a ONE-REPLICA
  STATEFULSET — Kubernetes' own at-most-one identity: no replacement pod
  before the previous pod's fully kubelet-observed termination (Recreate
  is rejected — its upgrade-only wait lets a ReplicaSet replace a
  deleted pod immediately while it terminates). Fence evidence is
  OBSERVED termination only, NEVER API-object absence: no force deletion
  is issued on a core pod, and an API object gone without observed
  process death refuses into maintenance — no successor starts. The
  operator's gated window keeps the fence's STORE half (lease revocation
  + the bounded backend drain). Sections: ADR-010 Q2 (the stop-first
  bullet), A12 (the assumption now names StatefulSet semantics and
  excludes Recreate), rejected option O2-M; containers-design.md
  "Module rollout sequences" (the stop-first bullet), both core sequence
  diagrams, the container view captions, the operator-crash bullets, the
  noun map. Check: Q7 extended (case vi) — the evidence cut: a core API
  object removed without observed termination is refused into
  maintenance with nothing fenced.
- **R5-10 — image-only rollback does not restore the previous desired
  state — FIXED.** The generation registry pins, per generation, the
  deploy-branch REVISION of its COMPLETE desired state (chart templates
  + values); rollback = ONE git revert to that recorded revision (launch
  state — probes, grace, environment, strategy, NetworkPolicy, RBAC —
  reverts WITH the tags), re-applied by Flux with only the modules whose
  rendered release changed being re-replaced. Symmetrically, a rollout
  is triggered by ANY workload-affecting change in the rendered desired
  state: a candidate that changes chart/values while reusing every image
  tag still runs the full gated rollout and the health window; the
  maintenance boot restores the recorded full revision, never a tag set.
  Sections: ADR-010 Q3 (the "Rollback is a git operation" bullet and the
  Q3/Q1 summaries), O1-2026 and O3-2026 rows, Q2's rollback clause;
  containers-design.md "Module rollout sequences" (the head, the
  commit-pair check's rendered diff), the rollback section and its
  sequence, the maintenance boot, the generation registry record. Check:
  F1 (the all-reused, chart-changed candidate still passes the gate),
  F4 (the revert restores the complete revision; the walk's failed
  candidate is a chart-only readiness-breaking commit with reused tags),
  Q3 (the rollback target assertion).
- **R5-12 — never-ready fallback introduces an automatic snapshot
  restore — FIXED.** The fallback hydrates the LATEST CURRENT snapshot
  on CURRENT Postgres data, taking the next epoch value (never reused);
  NO retained COPY is ever restored by an automatic path — the copy a
  core replacement takes is a named observation point, and automatic
  restore is stated absent in no uncertain terms (rewinding to it would
  discard the failed candidate's possibly committed work; copies restore
  only through the owner's manual maintenance path). No committed
  outcome is replayed: a re-run executes only the abandoned tick's
  still-pending effects under their persisted ids, settled by the done
  records and message rows. Sections: containers-design.md stop-first
  contract point 8 (rewritten), N-20 (the automatic-path exclusion).
  Check: Q2's core branch (b) — the readiness-failure cut after a
  candidate commit asserts NO copy restored and NO committed outcome
  replayed.

Owner questions: none — every fix fits OWNER-DECISIONS.md (the
simplification point 1 strategy fields, the platform decision's Flux/
GitOps shape, and the point-6 manual-only copy rule), so no OWNER entry
was needed.

Resolution of the "## Round 5" findings, part 2 (task
lifemodel-b0r.9.13): R5-05, R5-06, R5-07, R5-09, R5-19. Each suggested fix
was taken, the lighter option where the finding offered one (R5-19: the
Vault UI kept as the owner's key-entry surface instead of a new operator
key-entry path). R5-04 (credential delivery) was WAITING FOR THE OWNER
then — untouched in this part; now decided and FIXED (see the R5-04
disposition below).

- **R5-05 — the exhaustive network policy excludes required platform
  traffic — FIXED.** The policy is still exhaustive AND it now names its
  infrastructure: new rows P17 (cluster DNS — every namespace resolves
  through CoreDNS only; no external-resolver or direct DNS-to-the-world
  row from a plain module), P18 (OpenBao server → the stores, dynamic-
  credential issuance), P19 (OpenBao → the Kubernetes API, the
  Kubernetes-auth TokenReview), P20 (Traefik → the Kubernetes API, route/
  endpoint discovery), P21 (the CNPG operator → the API and its Postgres
  instances), the Agent Vault outbound leg as its own numbered row (P22 —
  R5-05's named omission), the admission webhooks stated as ingress (the
  injector's and CNPG's), the plain-module DNS/internet cut kept, and the
  TokenReview privilege kept ON BAO'S service account. The two Network-
  Policy facts are stated where the rows are read — no node-to-pod
  filtering, a namespace NAME is not a route (rows select pods/Services
  by label; the review diff checks the rendered rows against the ACTUAL
  installed namespaces and ports, and the chart pins the bundled
  Traefik's namespace) — and enforcement is a pinned k3s setting
  (`--disable-network-policy` never set; the bootstrap asserts it).
  Stated negatively unchanged: the sensitive paths (module → operator/
  registry/BuildKit/Agent Vault/other namespace) and unauthorized
  mutations have no row and no right. Sections: ADR-010 Q5 (the
  namespace table row set, the "platform's own traffic" bullet, kube-system
  row); containers-design.md the container-view namespace table, the
  P-table (P16 amended for R5-19's vault route, P17-P22 added, the
  node-traffic/namespace-name note). Check: N-8 extended — the positive
  exercise of every named row INCLUDING the platform rows (store issuance
  end-to-end through P18, a module login through P19, a route resolved
  through P20, CoreDNS) with the negative set (sensitive paths, module API
  attempts) and the node/API exceptions stated in the walk output;
  the noun map's P1-P22.
- **R5-06 — clean bootstrap has no initial OpenBao trust and unseal path
  — FIXED.** The seal mechanism is NAMED (the official chart's default
  SHAMIR seal — no seal backend configured) and the custody is the
  OPERATOR: it initializes Bao exactly once on first boot, writes the
  initial root token and the key share to its `lifemodel-system` custody
  Secret, written AND read back complete (the R4-09 record rule) before
  anything acts on them, auto-unseals from that custody at every (re)start
  including a sealed reboot, and REVOKES the initial root token when the
  bootstrap DAG's Bao step completes — the steady-state operator identity
  is its Kubernetes-auth Bao role like every module. Interrupted-init and
  the one unresolved window (initialized WITHOUT a custody record) refuse
  VISIBLELY into maintenance naming the window — never silently retried;
  a re-run of the step re-reads custody, never re-initializes; no manual
  preparatory command exists anywhere on the one-command path ('manual'
  custody stays the requirement change — the owner holds the shares and
  the operator reports SEALED as the blocking state). Sections: ADR-010
  Q5 (the decided paragraph), Q7 (the new "Bao's own trust and unseal
  path" block), the consequences "Good" bullet, the Q3 summary row;
  containers-design.md the volumes/state-homes bullet, the bootstrap DAG
  step 1, the `unsealCustody` operator-configuration row. Check: N-19
  extended (the init/custody/unseal window cuts in the launcher unit; the
  k3d walk adds the sealed-reboot cut and the
  initialized-without-custody-refusal case, and asserts no sealed Bao is
  presented as ready).
- **R5-07 — the operator's RBAC cannot create its BuildKit workloads —
  FIXED.** The operator's cluster row gains the DISPOSABLE BUILD WORKLOADS
  narrowly in `lifemodel-system` ONLY: build Jobs
  create/get/list/watch/delete, their pods get/list/watch/DELETE, and the
  build's required resources (its service account, ConfigMap inputs, the
  build-cache volume) in the same namespace; the RBAC diff in Q9's unit
  check runs against the AMENDED table, so the rendered roles and the
  table cannot agree on an incomplete surface. Sections: ADR-010 the
  threat-model RBAC bullet and Q1's decided text; containers-design.md
  the RBAC table's operator row. Check: Q12 extended (the
  operator-identity build/cleanup case in `generations/timing` — the
  build runs, pushes, is deleted with pod and cache — plus the
  wrong-namespace refusal; the build pod's own no-rights assertion stays
  in Q9's `generations/no-docker`).
- **R5-09 — Jobs-only RBAC does not constrain a Motor Job's Pod
  specification — FIXED.** `lifemodel-motor` is PSA `restricted` (chart
  labels) and a ValidatingAdmissionPolicy bound to Jobs there refuses a
  template the policy disallows: the sandbox's zero-rights ServiceAccount
  only, `activeDeadlineSeconds` from the declared Motor run limit,
  requests/limits required, ephemeral-type volumes only; the per-run
  workspace is a GENERIC EPHEMERAL VOLUME in the pod template so no PVC
  outlives its Job; Motor validates the same template before submission
  (belt — the API server is the enforcement point); cleanup is TRACKED in
  the run registry (finished Jobs deleted; the PANIC deletes the running
  sandbox Jobs before the all-stopped state — scaling Motor to zero stops
  no existing Job); an interrupted cleanup is re-driven at Motor start
  from the registry. Sections: ADR-010 the threat-model bullet, Q5's
  Motor bullet, the Q2/Q9 decision-outcome rows; containers-design.md the
  Motor hard edge, inventory row 18, the RBAC hard edge's no-mounts
  clause. Checks: Q9 extended (the invalid-Job cases — privileged,
  hostPath, no deadline, foreign service account — each refused by the
  live API server and counted; the PSA labels and the VAP diffed in the
  launcher unit), Q5's panic-convergence and its walk extended (the
  all-stopped state counts NO sandbox Job running; the R5-09 cleanup cut
  — Motor killed mid-cleanup, restarted: no running sandbox, no retained
  unowned volume).
- **R5-19 — the owner's authentication and model-key entry routes are
  incomplete — FIXED (the lighter option).** The entry is NAMED route by
  route instead of a ForwardAuth blanket: the ForwardAuth LOGIN page and
  the static ASSETS are the unauthenticated exception routers; the
  first-boot SETUP router (set the operator's login password — the
  outcome-4 walk's "sets the loader password") is unguarded ONLY while
  the bootstrap record shows setup incomplete and CLOSES at the record's
  completion; every OTHER owner router — the ingress gateway's UI/session/
  submit/transcript/reply surface AND the operator's boot/panic UI and
  API — carries ForwardAuth to the operator from the start, so chat and
  transcript are guarded ALWAYS, not only at boot. The KEY-ENTRY route is
  the preserved narrowly authenticated Vault UI (the lighter option): the
  `vault.` host, ForwardAuth-guarded on a pinned host, the ONE published
  vault route (P16 amended from "no published route"). Sections: ADR-010
  Q5 (the decided paragraph and the touch-the-world exception (a), the
  Q5 decision-outcome row); containers-design.md the Traefik upstreams
  bullet (the new route-by-route block), the touch-the-world rules bullet,
  the container-view vault caption, P16. Check: Q10 extended — first
  setup, the setup router's closure, key entry through the vault UI,
  anonymous denial on every non-exception owner router, and the model
  call end to end with the vault-injected key and no key in any module
  pod.

Owner questions: none — R5-06's mechanism (the chart's default Shamir
seal under operator custody) implements the OWNER-DECISIONS platform
entry ("OpenBao via its official Helm chart ... service account login
replaces wrapped AppRole secret-ids") and the ADR's standing "the unseal
key is operator-held"; R5-19's lighter option reuses the Compose shape's
own Vault-UI posture; R5-05/R5-07/R5-09 tighten mechanisms the owner
already chose (NetworkPolicy, RBAC, Jobs). R5-04 was WAITING FOR THE OWNER then,
untouched; now decided and FIXED (see the R5-04 disposition below).


Resolution of the "## Round 5" findings, part 3 (task
lifemodel-b0r.9.13): R5-11, R5-13, and the COMMENTs R5-08, R5-14,
R5-15, R5-16, R5-17, R5-18, R5-20. Each suggested fix was taken, the
lighter option where the finding offered one (R5-13: the dedicated
projection stream with per-instance read positions instead of dual
routing plus exit-time switching; R5-08: a single registry volume on
the sole node with node-local trust; R5-18: the lighter single-server
datastore chosen EXPLICITLY — embedded etcd — instead of an HA
addition). R5-04 (credential delivery) was WAITING FOR THE OWNER then
— untouched in this part, its check amendments landing with part 4; now
decided and FIXED (see the R5-04 disposition below, which carries those
check amendments). After
these fixes the Checks section of containers-design.md is FINAL: every
check added in parts 1-3 is present, and every row is mapped to where
it runs (launcher unit / k3d walk / a named clean-VM walk marked
UNPROVED-in-CI until first run) or to a named human judgement.

- **R5-11 — Kubernetes grace defaults were written in the wrong unit —
  FIXED.** The pod field's unit is authoritative: the chart carries an
  ms input, converted ONCE in one reviewed place (ms / 1 000, rounded
  UP — grace never renders shorter than the deadline it covers), and
  the values are stated in seconds — egress 300 (rendered `300`), other
  modules 30, the core's grace ≥ the 5 s deadline. The grace invariant
  is asserted in ONE converted unit against the RENDERED pod field,
  never the pre-conversion chart input, so a same-unit-looking
  inequality cannot hide a bad conversion. Sections: ADR-010 open
  question 1, the Owner-values items 1-2, Q2's call-manifest bullet,
  assumption A8's neighbor (the values); containers-design.md the
  operator-configuration table's grace row (unit column now names the
  conversion), the Keyed-job-rules call-manifest bullet, N-5. Check:
  F8 extended (the unit renders the chart, asserts the ACTUAL pod
  fields 300/30 and the core's ≥ 5, and the timeout inequalities in one
  unit — never only `OperatorConfig` defaults); N-5 extended (a
  conversion rendering grace SHORTER than its deadline or timeout is a
  build refusal); Q12's egress measurement asserts on the rendered
  field.
- **R5-13 — the projection handoff could lose updates and regress the
  cache — FIXED (the lighter option).** Projections are ORDERED BY
  POSITION: the applier stamps every `state.projection` event and every
  bootstrap packet with a monotonic position (it is the only writer),
  each instance consumes at its own recorded position and applies a
  packet only at a position GREATER than its consumed watermark —
  ordering and staleness ride the position, never the content hash
  (hashes decide equality, not order). The handoff is a DEDICATED
  PROJECTION STREAM with per-instance read positions (no group
  competitor can drain it during an old/new overlap) and a
  CONSUME-THROUGH WATERMARK BARRIER: the instance stream is trimmed
  only after the fresh instance consumed through the applier's head, so
  a fresh-adapter crash at the old-exit handoff resumes from its
  recorded position and loses no change. Sections: ADR-010 Q6 (the
  state.projection bullet and the bootstrap block rewritten), the
  Q7 role-map core/adapter rows; containers-design.md the container
  view's per-process paragraph, the bus/bootstrap stream-table rows,
  the adapter contract's read path and bootstrap order, N-14. Check:
  N-14 extended (the position-ordering rule) and its walk extended with
  the two handoff cuts — a projection change published exactly at the
  old instance's confirmed exit reaches the fresh cache through the
  barrier, and a fresh-adapter crash at the handoff loses nothing.
- **R5-08 — an in-cluster registry Service is not a node image-pull
  mechanism — FIXED.** The registry runs at a STABLE endpoint
  resolvable by BOTH BuildKit (push, P13) and the NODE's containerd
  (pull is node-side traffic the policy rows do not carry — stated on
  P13); the one-command installer writes the node's trust
  (`registries.yaml` with TLS trust, or plain HTTP on a node-local
  address — the lighter option, no certificate machinery) BEFORE any
  module pod is scheduled; the registry persists in ONE volume on the
  sole node (the lighter option), its persistence/recovery recorded and
  checked separately from image delivery. Sections: ADR-010 open
  question 4 (rewritten), Q1's build paragraph; containers-design.md
  the container-view registry caption, the module-set/images bullet,
  the bootstrap DAG step 1, P13. Check: F1 extended (trust present
  before the first module pod; a COLD containerd pull on a rebooted
  node with no preloaded images reaches Running), N-19 (the trust
  assertion in the DAG), Q11 (registry persistence named in the
  measurements).
- **R5-14 — the stated 65-second serving gap omitted the new platform
  waits — FIXED.** The serving gap is the SUM of NAMED PHASES, each
  with its own bound and failure outcome: the 5 s stop deadline (forced
  stop on overrun), the fence waits (lease revocation + the bounded
  backend drain — overrun names the step and rolls back), the
  snapshot-copy write (failure stops before the resume — maintenance),
  the resume + Flux reconcile and revision ACK (past the window —
  rollback), node scheduling and image pull (ImagePullBackOff past the
  window — failed readiness, rollback), and start-to-first-commit
  bounded by `readinessWindowMs` 60 s, whose clock starts at the
  RESUME. The walk reports the observed per-phase timings and their sum
  as the actual pause — never the application boot alone; the owner's
  short core-stop deadline and the maintenance-on-expiry trade stand
  (infrastructure time is named, not hidden inside the deadline).
  Sections: containers-design.md the stop-first contract point 2
  (rewritten), the stop-first sequence's phase-timing note, Q1; ADR-010
  the consequences "switch pause" bullet and Q2's Serves line. Check:
  Q1 rewritten (phase-named, sum reported, timings from the rollout
  record + Q11's sampler).
- **R5-15 — readiness, consumer join and liveness needed one coherent
  startup predicate — FIXED.** ONE predicate gates Ready: required
  bootstrap state complete AND the consumer-group JOIN OBSERVED — the
  RollingUpdate controller cannot terminate the old pod while the new
  pod has not taken over its group. Liveness is gated behind a STARTUP
  probe (or the chart's explicit activated gate) whose allowance is
  `readinessWindowMs` — the core's 15 s last-commit gap counts only
  AFTER activation, so an honest slow boot or slow group join is never
  liveness-killed before its first permitted real commit. Sections:
  ADR-010 Q2's start-first bullet, the Owner-values item 7, assumption
  A8 (rewritten); containers-design.md the start-first bullet, the
  stop-first contract points 3-4 (rewritten). Check: F2 extended (the
  predicate checker: Ready cannot report true with a missing join or
  bootstrap item), and `generations/switch-happy` extended with the two
  cuts — a valid boot longer than 15 s is not restarted; a slow group
  join keeps the pod NotReady with the old pod serving, against the
  real Deployment controller.
- **R5-16 — CNPG manages roles, while SQL grants enforce schema
  containment — FIXED.** The enforcement chain is named: CNPG
  declaratively manages each module's FIXED NOLOGIN group role; the
  MIGRATION SET owns the GRANT/ALTER DEFAULT PRIVILEGES SQL (a table a
  migration creates is granted by that same migration, so a newly
  migrated table is usable the moment it exists); OpenBao issues a
  leased LOGIN user that INHERITS the group role — declared attributes
  alone prove neither access nor refusal. Sections: ADR-010 the
  threat-model kept barrier, Q4's Postgres bullet, Q7's Serves line;
  containers-design.md the container-view Postgres caption, the RBAC
  table's CNPG row, the bootstrap DAG step 3, the Postgres rules.
  Check: N-11 extended — the R5-16 pair: a newly migrated table is
  usable by a NEWLY ROTATED login of its module (positive), cross-
  schema access refused (negative, NOPERM, counted); the unit diffs
  the migration set's GRANT SQL against the declared role set (an
  ungranted new table fails the build).
- **R5-17 — the clean-VM and existing-cluster checks were replaced by
  an empty k3d test — FIXED (the gaps named and the walks added).** k3d
  stays for CLUSTER MECHANICS, and the two delivery entrypoints each
  have their OWN named bounded disposable clean-VM walk:
  `generations/clean-vm-install` (the real k3s install + registry
  trust + Flux bootstrap + the reboot cut) and
  `generations/existing-cluster-helm` (the separate `helm install`
  path — never covered by an empty k3d cluster). Required VM
  privileges, Git bootstrap inputs and existing-cluster prerequisites
  are COMMAND INPUTS of the walk commands, stated in the walks' README
  — never hidden manual steps; until each walk's first recorded run its
  scenario is marked UNPROVED-in-CI in the row that cites it. Sections:
  containers-design.md the Checks intro's where-form 2 (rewritten), F7,
  N-19, the bootstrap bullet, the human-judgements row; ADR-010 open
  question 7; the inventory's constraint-2 amendment. Check: the two
  walk cases named in F7's where-cell; the UNPROVED-in-CI marking is
  the honest statement the finding asked for ("or explicitly mark
  those scenarios unproved").
- **R5-18 — the durability evidence assumed a datastore the installer
  never selected — FIXED.** The installer SELECTS the datastore
  explicitly: embedded etcd (`--cluster-init` on the single server), so
  the record-write rule's read-back completeness is the replicated-log
  write-through of a NAMED datastore — not a default the installer
  never named. The lighter SQLite default stays acceptable only with
  its own documented and tested contract, which this design does not
  claim (no HA datastore was added to preserve the word "quorum" — the
  single-server etcd IS the lighter explicit choice that keeps the
  contract real). Sections: ADR-010 Q5's one-command paragraph and the
  Q5 decision-outcome row; containers-design.md the panic section's
  resume rule, the operator-crash records paragraph, the noun-map row,
  F7, N-19. Check: Q5's walk extended — the server is asserted to run
  the installer-selected etcd and a rollout record is re-read across a
  node reboot on it; N-19's DAG refuses a default SQLite-backed server.
- **R5-20 — lease expiry during a Bao outage needed a local failure
  mechanism — FIXED.** Expiry is enforced LOCALLY: the supervising
  vault-env/agent tracks each lease's issue time and term and enforces
  a LOCAL validity deadline on the process's own clock; renewals are
  attempted on schedule, and a RENEWAL FAILURE past the deadline stops
  the supervised work VISIBLY — the process exits nonzero naming the
  expired lease, Kubernetes restarts it, and the fresh process
  re-authenticates when Bao returns. The mechanism is the stop, never
  an assumed server-side revoke: an open Postgres/Valkey session does
  not end merely because its lease expired and Bao cannot revoke it.
  Sections: ADR-010 Q7's lease-lifecycle bullet; containers-design.md
  the container view's lease-lifecycle bullet, N-18. Check: N-18
  extended — the Bao-down-past-expiry cut with an ALREADY-OPEN
  PG/Valkey session: work stops at the local deadline with the expiry
  named, the session's fate observed in the store's connection list,
  resumption by re-authentication — the cut reads the module's stop,
  never only lease metadata after Bao is back.

- **R5-04 — Agent Injector is not the application-process supervisor
  described here — FIXED (the owner decided the mechanism).** The owner's
  comment of 2026-10-12 ("Owner decision, credentials on k8s", R5-04)
  names the Bank-Vaults secrets webhook (bank-vaults/secrets-webhook) with
  OpenBao — the exact setup the owner runs in their own cluster, OpenBao
  supported. The mutating webhook adds an init container that copies the
  `vault-env` binary into a shared volume and wraps the module container's
  command; vault-env logs in with Kubernetes auth (the service-account
  JWT — unchanged, no wrapped secret-id), resolves the pod's secret
  references into environment variables, flushes the login token before
  the module process starts, and in DAEMON MODE stays the process's
  PARENT: it execs the module process and renews the dynamic
  Postgres/Valkey leases. Exit-on-failure replaces the injector's
  supposed cross-container supervision: a renewal failure past the local
  deadline (R5-20's rule, unchanged) or a credential change makes
  vault-env EXIT, so Kubernetes restarts the container and the fresh
  process re-authenticates (= restart on change, owner decision 7 kept).
  No agent is baked into module images; the workerd scrub is stated
  structurally (vault-env execs only its own module process; workerd's
  environment is credential-free in the pod spec and asserted by the
  spawned-child fixture) instead of attributed to an injector
  supervisor. The Agent Injector is RECORDED as a rejected option
  (rejected by the owner, 2026-10-13). Sections: ADR-010 (part 5 of the
  split, committed 50fb96f: the platform context, context, Q7 decision,
  assumptions A5/A13, the NetworkPolicy rows, the rejected options O7-D
  and O7-A/O7-A2, decision 7); containers-design.md: the header context,
  the deployment-view Bao node and edge, the namespace table (P3 row, the
  `lifemodel` and `openbao` rows), P21, the RBAC table, the container
  view (secret delivery, lease lifecycle), the bootstrap DAG step 4, the
  operator-crash reconciliation step 3, the named-rows list, the values
  row `leaseMaxTtl`, the former instance-image CI job surface list, the noun-map row; the
  review document's noun-map and platform-shape rows and the inventory's
  F7/Q8/Q11 amendments note the same replacement in place.
  Checks: N-7 (pod spec AND Kubernetes Secrets/etcd carry no credential;
  the positive per-role assertions read the vault-env-wrapped processes'
  environments), N-8 (the secrets webhook named among the exercised
  admission-webhook rows), N-10 (workerd zero restated on the new
  mechanism), N-18 (fresh vault-env login per start; renewal failure =
  vault-env exit + Kubernetes restart; max-TTL change restarts only the
  affected container), Q8 (credential absence extended to Secret objects
  and etcd; daemon-mode renewals named in the lease observations),
  Q11 (the webhook in the measured memory line items), F7 (the no-key
  guarantee stated through vault-env's parenthood).

Owner questions: none — R5-17's disposable clean-VM walks and their
UNPROVED-in-CI marking implement the review's own suggested fix within
the accepted platform and test-isolation decisions, R5-18's explicit
embedded-etcd choice is the review's lighter option, and R5-13/R5-08's
mechanisms are the findings' lighter options; no decision changed.
R5-04 was decided by the owner (the comment of 2026-10-12) and is FIXED
above across ADR-010 (part 5) and containers-design.md (this part, part
6 of the split); implementation must still VERIFY vault-env's
daemon-mode renewal of the dynamic Postgres/Valkey credentials and the
clean exit on a renewal failure, as the owner's comment directs.

### Round 5 confirmation

Task lifemodel-b0r.9.10. Narrow confirmation of the 13 BLOCKING findings
only, against `git diff c43c37e..32316e0c1172d693969a522a4a698f41992796b1`
and "Round 5 dispositions". OWNER-DECISIONS.md's later amendments govern;
point 0 applies: trusted against malice, not against bugs. This is not a
new review round. CLOSED means the written mechanism answers the original
scenario and a named check specifies its proof; it is NOT a runtime PASS.
No suite, cluster walk or installer acceptance was run. The automatic
document-readiness gate is not installed and did not run.

**Result: 9 CLOSED, 4 STILL OPEN.** `design` below means
containers-design.md; `ADR` means ADR-010.

| Finding | Confirmation | Mechanism and check, or exactly what is missing |
|---|---|---|
| R5-01 | CLOSED | ADR Q2 and design Module rollout sequences publish one Git step per module, closing it only on the recorded-revision ACK plus acceptance; suspend/scale have single ownership and wait for Helm quiescence. F1/F2 and Q5 specify stale-ACK, concurrent-reconcile and crash-between-step/acceptance checks. |
| R5-02 | CLOSED | ADR Q3 and design Rollback and maintenance / Operator crash reconciliation make read-back panic intent authoritative and re-drive partial mutations to observed all-stopped completion. F7/Q5 cut after each mutation and during a running Helm action, proving convergence without a start. Sandbox deletion's missing execution edge remains R5-09 below, not a new finding. |
| R5-03 | CLOSED | ADR Q2 and design Module rollout sequences select the one-replica StatefulSet, forbid operator force deletion and require observed process termination, never API absence, before takeover. Q7's evidence cut removes the API object without observed death and requires maintenance with no successor and no fence. |
| R5-04 | CLOSED | The owner's Bank-Vaults secrets webhook decision is implemented in ADR Q7 and design Secret delivery / Lease lifecycle: vault-env is the in-container daemon parent, authenticates at each start, renews leases and exits for restart on failure/change; workerd's environment is separately scrubbed. N-7/N-10/N-18 and Q8 specify visibility, per-process grants, dynamic renewal and failure/restart checks. The owner's implementation verification remains required, not claimed as run here. |
| R5-05 | CLOSED | ADR Q5 and design P17-P22 name CoreDNS, Bao store issuance/TokenReview, Traefik discovery, CNPG/API/webhook traffic and Agent Vault's outbound hop, with actual namespace/port matching, enabled enforcement and node exceptions. N-8 exercises these paths positively and sensitive paths/unauthorized API attempts negatively. |
| R5-06 | STILL OPEN — RESOLVED after this confirmation — see the confirmation dispositions (operator-first DAG, verified hand-off before revocation; N-19 extended). Correct the bootstrap DAG: run the Bao-independent operator bootstrap before Bao init/unseal, and revoke root authority only after roles/policies and authenticated steady-state hand-off; design:393-407 still initializes/revokes in step 1, starts the operator in step 2 and configures roles in step 3, contradicting ADR Q7's hand-off and leaving N-19 without a runnable order. |
| R5-07 | STILL OPEN — RESOLVED after this confirmation — see the confirmation dispositions (the refusal re-aimed at `lifemodel-motor`; the `lifemodel-state` case stays positive). Correct Q12's wrong-namespace refusal check to use a namespace where operator Job creation is actually ungranted: design:170 grants migration Job creation in `lifemodel-state`, while Q12 requires the same identity's build Job creation there to be refused without a template admission rule; the positive build rights are fixed, but this stated check cannot pass. |
| R5-09 | STILL OPEN — RESOLVED after this confirmation — see the confirmation dispositions (Motor is the named cleanup principal, before the release scale; Q5/Q9/F7 updated). Name an authorized panic sandbox-deletion actor and ordering, with observed cleanup before Motor scale-zero or a narrowly authorized cleanup principal: design:192-214/1090-1105 forbids operator Job access and scales Motor down, so the promised running-Job deletion and Q5/Q9 all-stopped assertions have no execution edge. |
| R5-10 | CLOSED | ADR Q3 and design rollout/rollback/maintenance sections pin and restore the complete desired-state revision, including chart and values; rendered workload changes trigger the gate even with reused tags. F1's chart-only candidate and F4/Q3's readiness-breaking, tags-unchanged rollback assert the whole rendered prior revision is restored. |
| R5-11 | CLOSED | ADR Owner-values 1-2 and design Operator configuration render grace in seconds (300/30, core at least 5), with one rounded-up ms conversion and same-unit comparisons. F8/N-5 assert actual rendered Pod fields and reject grace shorter than its deadline/timeout. |
| R5-12 | CLOSED | Design stop-first contract point 8 and N-20 exclude every automatic copy restore: fallback takes a never-reused epoch and hydrates the latest current snapshot on current Postgres data. Q2(b), together with its Round 5 disposition's explicit after-candidate-commit cut, asserts no copy restored and no committed outcome replayed. |
| R5-13 | STILL OPEN — RESOLVED after this confirmation — see the confirmation dispositions (dual append through the overlap; N-14's overlap fan-out cut). Fan-out to the still-serving old adapter is missing: design:229-231/436/539-564 and ADR Q6 still let fresh and old compete for shared-group projections while only fresh gets the addressed stream; N-14 must prove both live caches receive a change when fresh wins shared-group delivery, not only fresh-cache handoff/order. |
| R5-19 | CLOSED | ADR Q5 and design Owner entry / P16 name login/assets exceptions, setup closure and ForwardAuth on every other owner router, restoring the guarded Vault UI key-entry route. Q10 checks first setup, closure, key entry, anonymous denial and the model call/key-absence end to end. |

**Checks ready for to-stages: NO — as of this confirmation.** The four
named gaps (R5-06's bootstrap/authority order and its N-19 walk,
R5-07's contradictory Q12 refusal, R5-09's panic cleanup execution edge
and its Q5/Q9 cuts, and R5-13's old-instance projection delivery and
N-14 assertion) were resolved AFTER this confirmation — see
"### Round 5 confirmation dispositions" below; the NO verdict is this
confirmation's own dated record, and readiness is re-judged from the
dispositions, not from this paragraph. The named checks for the closed
items are design proof obligations, not executed acceptance evidence;
the delivery walks' UNPROVED-in-CI marks remain honest. This confirmation
adds no finding beyond the original blockers and finds no direct
contradiction of OWNER-DECISIONS.md. The already-pending charter amendment
remains a separate prerequisite to the work plan, not a new finding.

### Round 5 confirmation dispositions

Resolution of the four STILL OPEN lines of "### Round 5 confirmation"
above (task lifemodel-b0r.9.13): R5-06, R5-07, R5-09, R5-13. Each line
named exactly what was missing; exactly that was added — no new
mechanism beyond it.

- **R5-06 — the bootstrap DAG initialized/revoked in the wrong order —
  FIXED.** The operator's own bootstrap is BAO-INDEPENDENT and runs
  FIRST: its chart stack (workload, Kubernetes RBAC, steady-state
  config) reconciles before the Bao step, so starting the operator never
  waits on Bao. The root token is REVOKED only after the roles/policies
  exist AND the operator's steady-state Kubernetes-auth login is
  VERIFIED — the authenticated steady-state hand-off, never a revocation
  that could leave the bootstrap without a working identity — and no
  module pod starts before the hand-off completes. Sections:
  containers-design.md the bootstrap DAG (operator-first step 1; the
  revocation-after-hand-off wording on step 3), N-19; ADR-010 Q7's
  "Hand-off to steady-state roles". Check: N-19 extended (the DAG order
  asserted and an EARLY REVOCATION cut — a root token revoked without
  the verified operator login — refused, never a completed bootstrap).
- **R5-07 — Q12's wrong-namespace refusal could not pass — FIXED.** The
  refusal case is re-aimed at a namespace the operator holds NO Job-create
  grant in: `lifemodel-motor` (Motor's namespace, no operator rights).
  `lifemodel-state` is named as UNSUITABLE for the refusal case — the
  operator's migration Job lives there by design, so its creation is
  granted and MUST succeed. Sections: containers-design.md Q12's build
  case. The positive build rights were already fixed in the Round 5
  dispositions (the operator row's disposable build workloads). Check:
  Q12 extended (the refusal exercised in `lifemodel-motor`; the
  `lifemodel-state` migration-Job creation stays a positive case).
- **R5-09 — the panic's sandbox cleanup had no execution edge — FIXED.**
  MOTOR is the named authorized cleanup principal: the panic
  transition's `lifemodel-motor` step is MOTOR'S OWN CLEANUP — Motor's
  registered identity deletes the release's RUNNING sandbox Jobs under
  its own RBAC row (the only principal that may), OBSERVED gone, BEFORE
  that release's scale to zero; the step is ordered by the rollout
  record (written and read back complete — R4-09) so a cut between
  cleanup and scale is re-driven; the operator stays control-only, never
  a Job deleter. Sections: containers-design.md the Motor hard edge, the
  panic transition, F7, Q5, Q9; ADR-010 Q5's Motor bullet. Checks: Q5
  (the cleanup step named as Motor's own, before the scale) and the
  existing R5-09 cleanup cut (Motor killed mid-cleanup, restarted: no
  running sandbox, no retained unowned volume) already prove the edge —
  they now have the authorized actor to run it.
- **R5-13 — the still-serving old adapter could miss shared-route
  projections — FIXED.** DUAL APPEND through the overlap: until the
  retiring instance's confirmed exit the applier appends EVERY
  subsequent projection change to BOTH routes — the instance stream AND
  the shared group route — so a change the fresh instance consumes from
  the shared route still reaches the still-serving old instance's cache,
  and the fresh cache stays current regardless of which member wins the
  group delivery. The consume-through watermark barrier and the position
  ordering stand unchanged. Sections: ADR-010 Q6 (the overlap block
  rewritten) and the Q7 role-map core/adapter rows;
  containers-design.md the container view's per-process paragraph, the
  `bus` and `state.bootstrap.<adapter-instance>` stream-table rows, the
  adapter contract's bootstrap order, N-14. Check: N-14 extended (the
  OVERLAP FAN-OUT cut — a group-won change still reaches the old cache;
  BOTH live caches asserted carrying the change after the overlap
  window).


## Round 6 (Gitea amendment review, 2026-10-13)

**Verdict: BLOCK.** Six blocking findings and four comments.

**Scope:** `git diff design/b0r-containers-simplify..HEAD`, reviewed at
`fb5e0157bb9b250b5aa9996ee4d8e87486224eb2` (nine amendment commits), and
only the accepted design context needed to assess that amendment.
`ADR` below means `docs/adr/010-container-generations.md`; `design` means
`docs/features/instance/containers-design.md`. Line numbers refer to that
revision. Gitea, the same-repository deploy branch, operator-only protected
branch writes, read-only Flux, task PRs, optional outward mirroring, and
Gitea Issues not being the tracker are fixed owner inputs. No settled
Round 5 decision is reopened.

**Review method:** independent architecture/source review; one read-only,
same-model scoped assistant checked bootstrap, lifecycle and recovery.
The official chart index confirms chart `12.7.0` / Gitea `1.27.0`. Token
claims were checked against that Gitea tag, not inferred from generic
current documentation. No builds, tests, cluster walks or installer walks
were run. The automatic document-readiness gate did not run. No tracker
operation or `.beads/` modification was made. The local commit hook is
not used for this report because it invokes `br`; the commit retains the
leaf-task link required by the brief.

**Consistency checks:** the active external “git remote” descriptions in
these two documents have been replaced; the ADR and design namespace
tables agree on `lifemodel-git`, P24, P26 and P27. Policy row ids P1–P27
and check ids G1–G5 are unique. G1–G4 name useful positive walks, and
G3/N-19 honestly retain the delivery walks' UNPROVED-in-CI status. These
are specified checks, not runtime passes. The remaining problems are
below; naming an implementation verification does not establish a
missing credential or ownership mechanism.

### R6-01 — Gitea recovery must not restart an expired rollback

- **Severity:** blocking.
- **Place:** ADR:760–770; design:1064–1072, 1101–1129; G5 at design:1735.
- **Failure:** the amendment says rollback waits for Gitea and G5 says it
  reverts when Gitea returns. An outage longer than 300 s therefore permits
  either an unbounded attempt or an automatic restart after maintenance.
  Both contradict the accepted ONE rollback clock, maintenance-on-expiry
  and no second automatic try. Restoring a deferred backup cannot provide
  a bounded availability guarantee. A running *healthy* generation can
  continue during an outage; that is not recovery of a broken generation.
- **Fix:** charge every Gitea wait/retry to `rollbackDeadlineMs`. Recovery
  before expiry may resume the recorded attempt; expiry must durably enter
  the existing suspend/scale-zero maintenance fallback, report the blocked
  Git step, and require owner authorization to start after recovery. Extend
  G5 with recovery before/after expiry and an operator-restart cut, asserting
  no late automatic revert/start. This preserves the accepted Git-only
  rollback. If restored service despite a source outage is mandatory, the
  owner must explicitly accept a cached-last-good recovery exception
  (suspend Flux, use the retained complete revision, reconcile Git before
  resuming); do not silently introduce that forbidden imperative path.

### R6-02 — Task tokens need a different Gitea account, not just a scope

- **Severity:** blocking.
- **Place:** ADR:1312–1316; design:36–46, P10/P24 at 168/182; G2 at 1732.
- **Failure:** minting a token does not specify its user identity. A token
  minted for the operator remains the operator for push/merge allowlists,
  so branch protection cannot distinguish it from the sole allowed writer.
  “Repository-scoped” also is not a selected-repository restriction in the
  pinned personal-token API: `CreateAccessTokenOption` accepts `name` and
  category `scopes`, not repository ids. A leaked or wrongly delivered
  operator token can therefore write protected branches or change repository
  administration, depending on its scopes. P24 grants a port, not a
  clone/push/PR method filter.
- **Fix:** mint for a named NON-ADMIN task account with access to only this
  repository, distinct from the operator account. State the authentication
  used to mint for that account and the minimum Git/PR API scopes. Pin
  operator-only direct-push AND merge allowlists for `main`/deploy, rule
  priority, no task admin bypass, and no unprotected-file escape. State the
  residual ability to alter other unprotected branches/tags/PR metadata;
  either accept it or constrain it with Gitea rules. G2 must use the real
  task identity and reject direct/force pushes, API file writes and PR
  merges to protected branches, protection edits, credential minting and
  access to a second private repository, while proving task push/PR success.
- **Primary evidence:** [Gitea 1.27.0 token request type](https://github.com/go-gitea/gitea/blob/v1.27.0/modules/structs/user_app.go),
  [token creation uses the target user's UID](https://github.com/go-gitea/gitea/blob/v1.27.0/routers/api/v1/user/app.go),
  [protected-branch push and merge controls](https://docs.gitea.com/usage/access-control/protected-branches/).

### R6-03 — Run-end deletion is not a crash-safe token lifetime

- **Severity:** blocking.
- **Place:** ADR:1316; design:38–46; G2 at design:1732; operator recovery
  records at design:1210–1229.
- **Failure:** the pinned Gitea personal access token has no expiry field.
  Storing it in OpenBao does not turn it into a Gitea lease. A lost mint
  response, operator crash, cancelled/deadline-expired Job, panic cleanup
  or Gitea outage during deletion can leave the token valid indefinitely.
  The current G2 happy-path run-end revoke does not prove “short-lived”.
- **Fix:** specify an operator-managed lifetime honestly: durable per-run
  issuance intent, unique token name/id, maximum run lifetime and pending
  revocation state, written before delivery; recover a lost mint response
  by identity/name rather than blindly minting again. Reconcile cleanup on
  all run outcomes and operator restart, retry failed deletion visibly,
  remove the Bao value, and admit no new self-change run while required
  cleanup is unresolved. Do not claim server-enforced expiry during an
  operator outage unless a supported expiring credential flow is selected.
  Extend G2 with these cuts and test that a copied token is refused for
  BOTH Git and API operations after confirmed revocation, not just absent
  from Bao or the Job template.
- **Primary evidence:** [Gitea 1.27.0 access-token model and lookup](https://github.com/go-gitea/gitea/blob/v1.27.0/models/auth/access_token.go)
  and the request type cited in R6-02 contain no expiration field.

### R6-04 — P27 has no per-run OpenBao authorization contract

- **Severity:** blocking.
- **Place:** ADR:955, 1315–1316; design:P12/P27 at 170/185,
  OpenBao-role row at 206, sandbox admission at 234–243; G2 at 1732.
- **Failure:** P27 opens the OpenBao endpoint but cannot enforce “per-run
  token only”. The existing sandbox account/admission contract names one
  zero-rights ServiceAccount, while no Bao role/policy maps a particular
  run to its particular secret. A shared login with access to run paths can
  read another run's token or, if wrongly scoped, the operator's Gitea
  administrator credential. Conversely, the exhaustive operator Bao role
  lists revocation/unseal but no read/write grant for these new secrets,
  so the described issuance/delivery can simply be denied.
- **Fix:** name the operator's narrow Bao paths/verbs and a run-isolated
  sandbox auth binding and policy, including teardown. For example, a
  run-specific zero-RBAC ServiceAccount and exactly bound Bao role must
  have named provisioning rights and matching Job-admission rules; this
  adds neither sandbox cluster authority nor operator Job authority.
  Explicitly include sandbox Jobs in webhook mutation and check the final
  mutated template against its resource/admission rules. G2 must prove two
  concurrent runs cannot read each other's values, neither can read admin
  or module secrets or list a broader subtree, and cleanup removes access.
  Verify P27 auth/retrieval positively under default-deny, not merely the
  token's eventual presence in the child environment.

### R6-05 — The pre-Flux bootstrap lacks initial Gitea authority

- **Severity:** blocking.
- **Place:** ADR:306–310, 914–918, 1057–1068, 1304–1316;
  design:422–469; G3/N-19 at design:1733/1783.
- **Failure:** CNPG → Gitea → seed → Flux resolves the source-fetch cycle
  only in outline. Gitea's bootstrap admin credential is held in OpenBao,
  but OpenBao and its Bao-independent operator bootstrap run AFTER Flux.
  The installer therefore has no named authority to create the repository,
  seed branches, install protection or create Flux's read-only credential.
  The existing-cluster command also starts with Gitea without consistently
  specifying CNPG readiness. A chart pin alone is not the stated topology:
  chart 12.7.0 defaults enable bundled PostgreSQL HA and Valkey cluster and
  set an admin password in values, unlike the selected CNPG/no-values-secret
  shape.
- **Fix:** name a trusted pre-Flux installer phase from the pinned release
  bundle: CNPG operator/CRDs, Cluster and dedicated Gitea database/role,
  explicit database/cache chart overrides, Gitea readiness and generated
  bootstrap authority in an explicit temporary custody location. Seed and
  protect the repo, create read-only Flux auth, then bootstrap Flux; transfer
  steady-state credentials to Bao only when Bao is ready and revoke/retire
  temporary authority after verified hand-off. State how this bootstrap-only
  writer fits the operator-only steady-state rule. Align both entrypoints
  and make G3/N-19 cut/resume before seeding, after seeding and at credential
  hand-off, with no overwrite of an already established repo.
- **Primary evidence:** [official pinned chart archive](https://dl.gitea.com/charts/gitea-12.7.0.tgz),
  `gitea/values.yaml`: `gitea.admin`, `postgresql-ha.enabled`,
  `valkey-cluster.enabled`; [official chart index](https://dl.gitea.com/charts/index.yaml).

### R6-06 — A namespace does not put Gitea outside generation changes

- **Severity:** blocking.
- **Place:** ADR:935–948; design:20–30, 422–438, 466–469,
  695–715, 1068–1070; G3 at design:1733.
- **Failure:** Gitea is part of the Flux-applied static chart stack in the
  same deploy branch, yet the installer first manages it with Helm and the
  existing-cluster path installs the remaining stack after Flux bootstrap.
  No release adoption/single-owner hand-off is named. More importantly,
  candidate chart/values changes have no stated exclusion for Gitea or its
  database and required policies. A normal chart-only generation can thus
  change or stop its own Git source, making its own revert unavailable.
  An application rollback must also not implicitly downgrade Gitea after
  a Gitea database migration.
- **Fix:** select one lifecycle owner for each bootstrap-created release
  and record the Helm-to-Flux adoption, or retain explicitly owner-managed
  source infrastructure outside generation reconciliation. Exclude Gitea's
  release, PVC, database/role and essential routes from application candidate
  and rollback mutations. Give Gitea upgrades a separate owner-authorized
  lifecycle with a pinned upgrade path, backup prerequisite and failure
  recovery; no automatic database downgrade. Add G3/N-19 hand-off/restart
  cuts and a chart-only candidate that attempts to change Gitea, proving
  refusal before source infrastructure changes. This realizes, rather than
  reopens, the accepted static-infrastructure boundary.

### R6-07 — Deferred backup is not an available Gitea restore path

- **Severity:** comment.
- **Place:** ADR:768, 941–948; design:692, 1211–1218, 1268–1276.
- **Failure:** the outage text invokes a “filed backup path”, but backup is
  explicitly deferred. An older/lost repository PVC or Gitea database can
  lack recorded rollback commits, protections or auth, while Flux still has
  cached desired state. Automatically reseeding the release or accepting an
  old deploy head can silently regress the established instance. An optional
  outward Git mirror does not back up Gitea accounts, protection or DB state.
- **Fix:** state the current recovery limitation without bringing the
  deferred automatic-backup feature into scope. Refuse auto-reseed of an
  established instance; on source-identity/revision loss hold reconciliation
  and report owner recovery required. The backup feature must pair repository
  data and Gitea DB/config, verify required recorded commits and auth/rules
  after restore, and restore Gitea's DB without rewinding the shared CNPG
  application dataset. Add missing/older-revision refusal and restore checks
  when that recovery feature is implemented.

### R6-08 — Polling needs candidate/ref separation and rollback precedence

- **Severity:** comment.
- **Place:** ADR:469–476; design:1211–1218, 1232–1244; G1 at design:1731.
- **Failure:** “poll the repository” does not distinguish candidate `main`
  from operator-authored deploy steps/reverts. After rollback, `main` still
  points to the failed candidate; comparing it to currently deployed code
  can enqueue that candidate again. Treating any new repository commit as
  a candidate can also consume the operator's own revert. The existing
  durable attempt records provide the guard, but G1 does not exercise it.
- **Fix:** poll `main`/PR refs for candidates; deploy refs are reconciliation
  inputs, never candidate events. Dedup by durable source SHA and outcome,
  serialize selection behind active rollback, and retry a refused SHA only
  on explicit owner authorization or a new SHA. Specify the poll interval
  as config, not a hidden delay in the rollback clock. Extend G1/G5 with a
  poll during rollback, after revert, and after operator restart, asserting
  no duplicate generation or automatic reapplication of the failed SHA.

### R6-09 — P26 needs actual Git-proxy wiring, not just a route

- **Severity:** comment.
- **Place:** ADR:960, 970–973; design:P26 at 184; G4 at 1734.
- **Failure:** allowing Gitea to reach the gateway does not make Gitea's Git
  mirror subprocess use that proxy or select its new caller policy. A mirror
  can simply fail under default-deny despite a correct NetworkPolicy. The
  gateway is replaceable and stops in maintenance, so mirroring is not an
  independently available recovery channel.
- **Fix:** specify the pinned chart/Git proxy settings, Gitea caller-policy
  binding and supported mirror protocol (the documented HTTP(S) push mirror
  fits the existing HTTP proxy), outside-remote credential custody, and
  retry/report behavior while the gateway is down. Keep internal Gitea/Bao
  clients off the proxy with explicit direct-service/NO_PROXY wiring where
  needed. G4 must observe an actual commit arriving at the allowed remote,
  deny another remote and direct internet access, and exercise mirror off
  and gateway-unavailable cases; rendered-policy inspection alone is not
  delivery proof. Mirroring failure must never gate rollout or rollback.

### R6-10 — Remaining route summaries and UI checks need the new exceptions

- **Severity:** comment.
- **Place:** design:P16 at 174, sandbox hard edge at 230–231,
  architecture rule at 1590–1591; ADR:1609; design:P25 at 183 and Q10 at 1750.
- **Failure:** P16 still calls its older list “the only ingress routes”, the
  sandbox hard edge still says its only egress is P8, the architecture rule
  calls P24 its only internal exception despite P27, and the ADR summary
  still says exceptions a–d despite the mirror's exception e. Implementing
  those summaries loses Gitea/Bao access. P25 describes ForwardAuth, but
  G1–G5 do not explicitly prove owner UI denial/login or usable PR links.
- **Fix:** align those summaries with P24–P27 and exception e. Explicitly
  extend Q10/N-8 to the pinned `git.` host: anonymous UI/API denial,
  authorized owner viewing a task PR, correct external URL/redirects and
  Gitea login/provisioning, with internal Flux/operator/task Git traffic
  continuing through authenticated internal Services rather than public
  ForwardAuth. These are amendment checks, not a new public Git endpoint.


## Round 6 dispositions (2026-10-13)

- R6-01 — fixed in ADR-010 rollback rules and design G5: one deadline, durable resume before expiry, maintenance and owner-authorized restart after expiry.
- R6-02 — fixed in ADR-010 Gitea credentials and design P10/G2: non-admin repository-only task account, scopes, protected-branch allowlists, and residual rights.
- R6-03 — fixed in ADR-010 Gitea credentials and design G2: durable issuance intent, operator-managed lifetime, crash-safe revocation and run admission block during unresolved cleanup.
- R6-04 — fixed in design P12/P27, sandbox admission and G2: narrow Bao paths and per-run ServiceAccount/role/policy binding, admission checks and teardown.
- R6-05 — fixed in ADR-010 F7/bootstrap and design bootstrap/G3/N-19: trusted pre-Flux installer phase, explicit chart overrides, temporary authority and verified Bao hand-off.
- R6-06 — fixed in ADR-010 and design Gitea ownership/G3/N-19: installer-Helm retains the source-infrastructure release; Flux does not adopt it; candidate mutations are refused and upgrades are separate owner-authorized work.
- R6-07 — answered in ADR-010 and design Gitea recovery rules: backup remains deferred; missing/older source revisions hold reconciliation, never auto-reseed; future backup scope and restore invariants are stated.
- R6-08 — fixed in ADR-010 polling rules and design config/G1/G5: candidate refs, durable SHA/outcome dedupe, rollback precedence and configured poll interval.
- R6-09 — fixed in ADR-010 mirror rules and design P26/G4: proxy/caller-policy wiring, credential custody, retry behavior and actual delivery checks.
- R6-10 — fixed in ADR-010 route summary and design P16/P27/Q10/N-8: route exceptions and the pinned Gitea UI/authentication checks.

## Round 6 confirmation (2026-10-13)

**Verdict: BLOCK.** R6-04, R6-05 and R6-06 still have blocking mechanism
or ownership gaps. R6-09 and R6-10 remain open comments.

**Scope and method:** confirmation of `a329f15..105f534` against the ten
Round 6 failures and only the nearby ADR/design contracts those fixes affect.
`ADR` and `design` retain the Round 6 path abbreviations; line references below
are at `105f534`. Two read-only, same-model assistants independently checked
task credentials and bootstrap/source ownership. The official pinned chart
archive was read, not rendered or installed. No builds, tests, cluster walks,
installer walks or automatic document-readiness gate ran. No `br` operation or
`.beads/` modification was made. Commit hooks are bypassed for this scoped
report because the commit-message hook invokes `br`; the required leaf-task
link remains in the subject. CLOSED means the design addresses the failure,
not that its proposed checks have passed. The fixed strict rollback decision
and installer-Helm Gitea ownership decision are not reopened.

### R6-01 — CLOSED

ADR:780–790 and design:1099–1110 charge every Gitea rollback wait/retry to
the one deadline. Recovery before expiry resumes the recorded attempt;
expiry holds durable maintenance and requires owner authorization. G5
(design:1775) explicitly covers before/after-expiry recovery and restart,
including no late automatic revert/start. This agrees with the existing
maintenance/no-second-try rules (design:1139–1173). No cached-revision
imperative recovery path is introduced.

### R6-02 — CLOSED

ADR:1365 and design:44–51 now name the separate non-admin `lifemodel-task`
account, access to only this repository, authentication as that account,
Git/PR scopes, highest-priority operator-only push AND merge allowlists,
no admin bypass, and accepted residual branch/tag/PR rights. G2
(design:1772) names the required real-identity positive/negative checks.
Tokens inherit the target user's UID, and the target is now explicit;
category scopes are no longer claimed to select repository ids.

Consistency comment: design:162 still says issuance uses the admin
credential, contrary to design:45–46/P12's task-account authentication.
Align that summary and explicitly name Basic or supported reverse-proxy
login for minting, as required by the pinned token endpoint. Admin
authentication alone does not imply an admin-owned token: the endpoint
allows an admin to act for the named task user. This stale authentication
summary is therefore not evidence that the original wrong-UID failure
remains under the explicit task-identity contract.

### R6-03 — CLOSED

ADR:1365 and design:52–59 record intent before mint/delivery, unique token
identity, maximum run lifetime and pending revoke; lost mint responses are
reconciled by identity/name. Every outcome/restart drives cleanup, failed
revokes retry visibly, Bao values are removed, and unresolved cleanup blocks
new self-change runs. The lack of server expiry during an operator outage is
now explicit. G2 names the crash/cancellation/deadline/outage cuts and refusal
of a copied token for both Git and API after confirmed revoke. Older
“short-lived” labels (design:129,162) must be read as operator-managed,
not as a Gitea lease.

### R6-04 — STILL OPEN (blocking)

P27 (design:201) and admission (design:252–254) specify a useful run-specific
zero-RBAC ServiceAccount and exact Bao role/policy/path, but no principal can
provision or remove that binding under the exhaustive grants. Operator
ServiceAccount rights at design:221 cover build resources in
`lifemodel-system` only; Motor at design:225,243–245 can manage Jobs and read
pods/logs, not ServiceAccounts in `lifemodel-motor`. P12/design:186 and the
operator Bao role/design:222 grant KV paths and the older module-lease
revocation, not provisioning/deletion of `auth/kubernetes/role/<run>`,
`sys/policies/acl/<run>` or the run auth-token teardown that P27 promises.
Thus issuance/delivery still fails before the run-isolated happy path.
Name one lifecycle actor and its narrow namespace/Bao provisioning and
teardown rights, without granting operator Job authority or sandbox RBAC.
G2's new isolation/cut checks do not supply those missing grants.

There is also a mutation/admission mismatch: P27/G2 promise validation of a
“final mutated Job template”, but the selected Bank-Vaults vault-env webhook
mutates the generated Pod, not the Job. Design:228 still describes Pod
mutation, while the ValidatingAdmissionPolicy at :250 is bound to Jobs.
Job admission cannot check containers/resources/secret references injected
later into its Pod. Include sandbox Pods in the webhook's selectors and
validate the final mutated Pod against the run/resource rules, retaining
Job validation; or select a real Job-template mutation mechanism. Merely
saying that the webhook includes sandbox Jobs does not supply one.

### R6-05 — STILL OPEN (blocking)

The order, chart pin, temporary custody, resume cuts and verified Bao hand-off
are now named (ADR:307–318,934–948; design:440–457; G3/N-19), but an
installer-host file is not yet a credential for an existing Gitea identity.
No step creates the account matching that file or delivers its input through
a supported chart/CLI mechanism. In chart 12.7.0, `gitea.admin.password`
defaults to a nonempty value and `passwordMode` to `keepUpdated`;
`templates/gitea/init.yaml:82–137` creates/updates the account only from
`existingSecret` or username/password inputs, and
`templates/gitea/deployment.yaml:272–290` consumes those inputs. Keeping
defaults violates the no-values-secret rule and can reset retired authority;
clearing them without another creation mechanism leaves no bootstrap admin.

Likewise “CNPG readiness” does not name the pre-Flux operator/CRDs, Cluster,
dedicated Gitea database/LOGIN role or external database connection/credential
binding. Disabling `postgresql-ha` does not configure external CNPG:
chart `_helpers.tpl:479–497` supplies PostgreSQL settings only for enabled
bundled databases; external `gitea.config.database` must be supplied.
Design:460–464 still has Flux reconciling CNPG later. Specify the complete
pre-Flux database/account creation and credential transport, including
restart-safe retirement. The cache disable itself is valid: the chart falls
back to memory cache/session and a level queue.

### R6-06 — STILL OPEN (blocking; chosen lifecycle owner retained)

ADR:974–980 and design:31–37 correctly keep Gitea installer-Helm owned,
exclude its release/PVC/database-role/policies/routes, refuse candidates that
touch them, and require separately authorized upgrades with backup and no
automatic database downgrade. However design:20–22 expressly leaves CNPG
as generation-managed platform infrastructure, while design:30–31/ADR:971–973
put Gitea on that same shared Cluster. The excluded Gitea database/role is not
the shared CNPG Cluster/controller/global settings. A chart-only candidate
can still break its own Git source by changing that substrate without
editing a listed Gitea resource. This also contradicts the nearby “like CNPG
... outside generation reconciliation” statement (design:1096–1098;
ADR:777–778). Settle the source-critical shared-CNPG ownership/exclusion and
bootstrap-to-steady-state ownership, and make G3 cover indirect/shared
rendered changes. This implements the fixed source-infrastructure boundary;
it does not ask Flux to adopt Gitea.

### R6-07 — CLOSED

ADR:785–790,981–984 and design:720,1099–1110 now honestly name deferred
backup, owner recovery on source identity/revision loss or regression, and
no auto-reseed of an established instance. G3 includes the refusal check.
Future backup pairs repository data and DB/config, verifies required
commits/auth/rules, and cannot rewind shared application Postgres data.
Neither the optional mirror nor a filed backup task is claimed as an
available restore path.

### R6-08 — CLOSED

ADR:483–489, design's `repositoryPollIntervalMs` setting (:1593), and G1/G5
(:1771,1775) separate candidate `main`/PR refs from deploy reconciliation
refs, deduplicate by durable SHA/outcome, serialize behind rollback, and
require owner authorization or a new SHA after refusal. Polls during
rollback, after revert and after restart are now explicit negative checks.
The failed `main` SHA and the operator's revert cannot automatically become
another generation; the configured cadence does not reset the rollback clock.

### R6-09 — STILL OPEN (comment)

The protocol, caller-policy name, direct-service exclusions, retry/report
behavior and actual-delivery G4 check are now stated. But P26 (design:200)
uses the pinned chart's purported `extraEnvVars` input. Chart 12.7.0 has no
such input: its workload environment is rendered from `deployment.env`
(`templates/gitea/deployment.yaml:350–352`). Following the specified key
therefore injects no proxy and leaves the original delivery failure under
default-deny. Also libcurl accepts only lowercase `http_proxy` for HTTP,
not the specified uppercase `HTTP_PROXY`; `HTTPS_PROXY` alone covers HTTPS,
not the stated HTTP(S) protocol set. Use a supported chart/Git setting and
working variables (or explicitly support HTTPS only), and make the named
proxy caller binding and Bao-held mirror credential delivery concrete.
G4's real-commit assertion and non-gating mirror behavior are appropriate,
but they do not establish missing wiring.

### R6-10 — STILL OPEN (comment)

P16/P25, the architecture rule and ADR exceptions a–e now agree; Q10/N-8
explicitly cover anonymous `git.` UI/API denial, authorized PR viewing,
external URLs/redirects/login/provisioning, and authenticated internal Git.
However the sandbox hard edge (design:245–247) still says its “only egress
is the proxied path (P8)”, contradicting P24/P27 and the corrected Q9.
The diagram's sandbox label (design:97) has the same proxy-only summary.
Align these remaining operative summaries so implementation does not drop
Gitea/Bao access.

**Primary evidence for remaining mechanisms:**
[official chart 12.7.0 archive](https://dl.gitea.com/charts/gitea-12.7.0.tgz)
(the internal files/lines cited above), and
[curl proxy environment contract](https://everything.curl.dev/usingcurl/proxies/env.html#http_proxy-in-lower-case-only),
[Gitea 1.27.0 token routing/authentication](https://github.com/go-gitea/gitea/blob/v1.27.0/routers/api/v1/api.go)
and [target-user token creation](https://github.com/go-gitea/gitea/blob/v1.27.0/routers/api/v1/user/app.go),
and the [Bank-Vaults Pod webhook registration](https://github.com/bank-vaults/secrets-webhook/blob/ae4a6589400d75fe64faab22a1c3c67a39dc09df/deploy/charts/secrets-webhook/templates/apiservice-webhook.yaml#L127-L140)
(source revision pinned for this observation; no deployment version claim).

**New blocking findings:** none. The remaining mechanism/consistency gaps
belong to the original R6-04, R6-05 and R6-06 failures; no settled Round 5
or coordinator decision is reopened.


## Round 6 dispositions, second pass (2026-10-13)

- R6-01 — CLOSED; rollback waits and retries remain charged to the single deadline.
- R6-02 — CLOSED; corrected the stale admin-auth summary to identify Basic or supported reverse-proxy login as `lifemodel-task` for minting.
- R6-03 — CLOSED; durable, operator-managed token issuance and revocation remain unchanged.
- R6-04 — CLOSED; the generation operator has narrow run-binding rights, durable teardown, and final post-webhook Pod validation.
- R6-05 — CLOSED; bootstrap uses a generated Secret through chart `existingSecret`, then deletes it after verified Bao hand-off; chart-supported `initialOnlyNoReset` is used because `initialOnly` is not accepted.
- R6-06 — CLOSED; Gitea uses SQLite on its own repository PVC, not shared CNPG, and both entrypoints omit CNPG readiness as a Gitea prerequisite.
- R6-07 — CLOSED; backup remains deferred, with repository data and SQLite DB/config paired on one volume for future backup.
- R6-08 — CLOSED; candidate/deploy-ref separation and rollback deduplication remain unchanged.
- R6-09 — CLOSED; HTTPS-only mirrors use chart `deployment.env`, paired proxy variables, Bao-held credentials delivered by the operator through the mirror API, and internal no-proxy names.
- R6-10 — CLOSED; the sandbox diagram and hard edge name P8, P24, and P27 without claiming proxy-only egress.


## Round 6 confirmation, second pass (2026-10-13)

**Verdict: BLOCK.** R6-04 and R6-05 still have blocking mechanism gaps.
R6-09 remains an open comment. R6-06 and R6-10 are closed; no previously
closed finding is reopened and there is no new blocking finding.

**Scope and method:** confirmation of `736f9c4..881b900` against the first
pass, `## Round 6 confirmation (2026-10-13)`, and the second-pass
dispositions. `ADR` and `design` retain the Round 6 path abbreviations;
line references below are at `881b900`. Two read-only, same-model assistants
checked run authorization and bootstrap/source ownership. The official
chart `12.7.0` archive and OpenBao primary documentation/source were read;
nothing was rendered or installed. No builds, tests, cluster/installer walks
or automatic document-readiness gate ran. CLOSED means the design addresses
the stated failure, not that its proposed checks passed. No `br` operation
or `.beads/` modification was made. Commit hooks are bypassed because the
commit-message hook invokes `br`; the required leaf-task link is retained.
The strict rollback deadline, SQLite on Gitea's own PVC, installer-Helm
ownership, no Flux adoption and owner-authorized upgrades are fixed inputs,
not questions reopened by this confirmation.

### R6-01 — CLOSED

ADR:791–796, design:1120–1125 and G5 (:1796) retain one rollback deadline,
charging Gitea waits/retries to it. Before-expiry recovery resumes the recorded
attempt; expiry holds maintenance and requires owner authorization. There is
no late automatic revert/start or cached-last-good recovery exception.

### R6-02 — CLOSED

Design:45–53, ADR:1391 and G2 (design:1793) retain the distinct non-admin
`lifemodel-task` identity, this-repository access, minimum category scopes,
operator-only protected push/merge rules and accepted residual rights. The
stale summary is corrected at design:162: minting authenticates with Basic
or supported reverse-proxy login **as that task account**, not the operator.
The second pass does not restore the wrong-UID failure.

### R6-03 — CLOSED

Design:53–61, ADR:1391 and G2 retain durable issuance intent, unique token
identity, lost-response recovery, outcome/restart cleanup, visible retries
and run admission blocked by unresolved cleanup. The lack of Gitea-enforced
expiry during an operator outage remains explicit. G2 still requires copied
credentials to fail both Git and API access after confirmed revocation.
The new binding record supplements, rather than replaces, this lifecycle.

### R6-04 — STILL OPEN (blocking)

ADR:182–194 and design:245–269 now supply the generation operator as the
binding lifecycle actor, its separate namespace ServiceAccount role,
record-before-provisioning and crash-safe teardown. Motor retains Job
ownership; the operator gains no Motor Job authority. P27 (design:201),
design:264–269 and Q9 (:1810) correctly retain Job validation and add final
post-webhook **Pod** validation, fixing the old object mismatch.

The remaining provisioning gap is the Bao grant: ADR:187–188 and
design:253–254 permit **create/delete only** on `sys/policies/acl/run-*`.
OpenBao's ACL-policy endpoint uses `UpdateOperation` even to add a NEW
policy. An ACL implementing those stated capabilities cannot provision the
run policy, so the original delivery failure remains. Name the narrow
`update`/write capability and the exact recovery operations required on the
run role/policy paths; keep parent/list and module-secret access denied.
If “create” names a business action rather than an ACL capability, record
that translation explicitly instead of calling this grant complete.

Align the exhaustive RBAC/Bao rows (design:221–222/P12:186) with those new
grants. Explicitly include sandbox Pods in the webhook scope (:228 still
says module pods), and update G2 (:1793), which still asks to inspect final
mutated Job templates. Teardown also says “revoke the run auth role”
(:256): deleting an auth role prevents further login but does not revoke
already issued tokens. Deleting the run ACL policy and KV value does remove
secret access, so this wording is not evidence of a separate cross-run leak
or a regression in Gitea-token revocation; distinguish these operations.

### R6-05 — STILL OPEN (blocking)

Design:464–472 and ADR:950–956 now connect a generated `username`/`password`
Secret to actual chart account creation. `existingSecret` and the supported
`initialOnlyNoReset` mode fix the original missing-account mechanism.
SQLite removes the pre-Flux CNPG dependency by the fixed owner decision.

However design:473–474, ADR:957–958 and G3 (design:1794) delete that Secret
after Bao hand-off without retiring its chart references. In chart 12.7.0,
`templates/gitea/deployment.yaml:272–282` puts non-optional `secretKeyRef`
inputs in the configure-Gitea init container of every new Pod. A restart or
replacement after deletion therefore cannot start that init container
(`CreateContainerConfigError`). `initialOnlyNoReset` skips password sync
inside the script; it does not bypass Kubernetes Secret resolution.
Bao-held operator API access does not satisfy that Pod input.

Specify a durable installer-Helm hand-off that removes `existingSecret` and
disables bootstrap admin configuration before deletion, explicitly clearing
the nonempty chart-default password rather than falling back to it. Verify
a replacement Pod and Bao-held API login, and cut/resume across the chart
transition and Secret deletion. Chart `values.yaml:478–484` retains a default
password unless overridden; Secret precedence alone is not the asserted
no-password-in-values contract. This is the same restart-safe bootstrap
failure under R6-05, not a new lifecycle-owner decision.

### R6-06 — CLOSED

Design:20–38 and ADR:984–1001 put SQLite, repository data and config on
Gitea's own PVC, outside the shared generation-managed CNPG substrate.
P23 (design:197) removes the Gitea-to-CNPG route. Installer-Helm remains the
sole lifecycle owner; candidate/rollback exclusions and separate authorized
upgrade/backup/no-downgrade rules remain explicit. G3/N-19 (:1794/:1844)
retain source-infrastructure edit refusal before mutation. The indirect
shared-CNPG failure is removed, not merely renamed.

Consistency comment: design:1116–1118 still says “like CNPG and OpenBao”
outside generation reconciliation, contrary to design:20–22 and corrected
ADR:788. Align that stale analogy with the explicit SQLite/ownership
contract; it no longer establishes a Gitea dependency on shared CNPG.

### R6-07 — CLOSED

ADR:797–801/998–1001 and design:740/1125–1130 retain deferred backup,
owner recovery on source identity/revision loss or regression, and no
auto-reseed. Future backup now pairs repository data and SQLite DB/config
on one volume and verifies required commits/auth/rules. Neither mirroring
nor the filed backup feature is treated as an available restore path.

### R6-08 — CLOSED

ADR:494–500, design's `repositoryPollIntervalMs` (:1613), and G1/G5
(:1792/:1796) retain candidate/deploy-ref separation, durable SHA/outcome
deduplication, rollback precedence and explicit owner retry/new-SHA retry.
The second pass does not allow the failed `main` SHA or operator revert
to enqueue another generation automatically or reset the rollback clock.

### R6-09 — STILL OPEN (comment)

P26 (design:200), ADR:1027–1035 and G4 (design:1795) now use the real chart
`deployment.env` input, paired `HTTPS_PROXY`/`https_proxy`, HTTPS-only
mirrors, and `NO_PROXY`/`no_proxy` for internal clients. The operator's
Bao read and remote-credential delivery through the Gitea mirror API are
also named. These fix the unsupported chart key and HTTP variable failures.

The proxy **caller** binding is still only the name `gitea-push-mirror`:
G4 says authenticated proxy, but no proxy credential delivery or restricted
listener/verified caller mapping is specified. The mirror's remote
credential authenticates to the outside Git server, not to the gateway.
The existing stream-derived identity (design:549–557) cannot identify a
Gitea Git subprocess using CONNECT, and Gitea has no bus route. Name the
concrete proxy-side binding without adding bus/store authority, and have
G4 verify this caller cannot select another policy. Actual commit delivery,
remote denial, gateway-down reporting and non-gating mirror failure remain
appropriate checks, not evidence of the missing binding.

### R6-10 — CLOSED

The sandbox diagram (design:97) and hard edge (:258–260) now name proxy
P8 and internal exceptions P24/P27, matching the architecture rule
(:1648–1653) and Q9 (:1810). The old proxy-only summaries no longer exclude
Gitea/Bao delivery. P16/P25, ADR exceptions a–e and Q10/N-8
(design:1811/:1831) retain the owner UI denial/login/PR-viewing and external
URL checks, separate from authenticated internal Git clients.

**Primary evidence:** [official Gitea chart 12.7.0 archive](https://dl.gitea.com/charts/gitea-12.7.0.tgz)
(the internal files/lines cited above);
[OpenBao policy capabilities](https://openbao.org/docs/concepts/policies/),
[ACL-policy API and deletion semantics](https://openbao.org/docs/api/system/policies/),
[ACL-policy UpdateOperation](https://github.com/openbao/openbao/blob/ad64d389cb66023521c4228dc9f1149400d87351/internal/vault/logical_system_paths.go#L3880-L3888),
and [Kubernetes auth role deletion](https://github.com/openbao/openbao/blob/ad64d389cb66023521c4228dc9f1149400d87351/internal/builtin/credential/kubernetes/path_role.go#L246-L262).
The OpenBao source is pinned for this observation, not a claim about a
deployed version.

**New blocking findings:** none. R6-04/R6-05 remain under their original
failure boundaries; the fixed Round 5 and coordinator decisions stand.

## Round 6 dispositions, third pass (2026-10-13)

- **R6-04 — CLOSED:** Per-run OpenBao grants now use `create`, `update`, and `delete` on exact role/policy/KV paths; final mutated sandbox Pods, webhook scope, and token teardown/expiry are explicit.
- **R6-05 — CLOSED:** Installer Helm removes bootstrap Secret references and clears admin username/password values before verifying a replacement Pod and Bao-held API login; only then is the Secret deleted, with cut/resume points.
- **R6-09 — CLOSED:** A dedicated NetworkPolicy-restricted mirror listener is bound to the fixed `gitea-push-mirror` CONNECT policy, with no proxy credential or bus/store authority; G4 checks caller and listener/policy confinement.


## Round 6 confirmation, third pass (2026-10-13)

**Verdict: PASS WITH COMMENTS.** All ten Round 6 findings are CLOSED at
design level. No closed finding regressed and no new blocking finding was
found. Nonblocking summary corrections remain under R6-05 and R6-06.

**Scope and method:** confirmation of `f830a92..0743db2` (the three
third-pass fix commits) against the second-pass confirmation and third-pass
dispositions. `ADR` and `design` retain the Round 6 path abbreviations;
line references below are at `0743db2`. Two read-only, same-model assistants
checked run authorization and bootstrap hand-off. The official Gitea chart
`12.7.0` archive and OpenBao primary sources were read, not rendered or
installed. No builds, tests, cluster/installer walks or automatic
document-readiness gate ran. CLOSED means the design addresses the stated
failure, not that its proposed checks passed. No `br` operation or `.beads/`
modification was made. Commit hooks are bypassed because the commit-message
hook invokes `br`; the required leaf-task link is retained. The strict
rollback deadline, SQLite on Gitea's own PVC, installer-Helm ownership,
no Flux adoption and owner-authorized upgrades remain fixed inputs.

### R6-01 — CLOSED

ADR:795–808, design:1126–1137 and G5 (design:1803) retain the single
300 s rollback clock, including all Gitea waits/retries. Before-expiry
recovery resumes the recorded attempt; expiry durably holds maintenance
and requires owner authorization. No late automatic revert/start or
cached-last-good exception was introduced.

### R6-02 — CLOSED

ADR:1417, design:45–61/P10 and G2 (design:1800) retain the distinct,
non-admin, this-repository task identity, task-account authentication for
minting, minimum category scopes, operator-only protected push/merge rules
and accepted residual rights. The third pass does not change Gitea token
ownership or restore the wrong-UID failure.

### R6-03 — CLOSED

ADR:1417, design:53–61 and G2 retain durable issuance intent, unique token
identity, lost-response recovery, outcome/restart cleanup, visible revoke
retries and the admission block while cleanup is unresolved. The lack of
Gitea-enforced expiry during operator outage remains explicit. Bao token TTLs
added by R6-04 do not replace Gitea token revocation; G2 still requires a
copied Gitea token to fail both Git and API after confirmed revoke.

### R6-04 — CLOSED

ADR:182–201 and design:P12/P27, :222, :245–276 now grant the operator
`create`, `update`, `delete` on the run role/policy and exact run KV paths.
The grant explicitly accounts for OpenBao's `UpdateOperation` when creating
ACL policies; deterministic run names and the durable binding record permit
idempotent write/delete reconciliation without parent listing. Narrow
ServiceAccount provisioning remains separate from Motor's Job authority;
the sandbox account gains no RBAC. The webhook scope now includes sandbox
Pods, and G2 (design:1800) inspects the final mutated Pod, retaining Job
validation and post-mutation Pod validation.

Teardown distinguishes deleting the auth role (no further login) from
deleting the ACL policy/KV value (no further secret access by issued tokens).
Run auth tokens have `token_ttl`/`token_max_ttl` bounded by the run limit;
they are not claimed to be revoked merely by deleting their role. The
original provisioning and mutation-object failures are addressed, with
cross-run isolation and crash/cleanup checks still required by G2.

### R6-05 — CLOSED

ADR:964–979 and G3/N-19 (design:1801/:1851) now require installer-Helm
to remove `gitea.admin.existingSecret` and explicitly clear BOTH admin
username and password after verified Bao hand-off. In chart `12.7.0`,
`deployment.yaml:272–288` then emits no admin `secretKeyRef`;
`init.yaml:82–83,137–138` skips admin configuration. Explicit empty values
override the nonempty chart defaults. The installer verifies the rendered
release, a REPLACEMENT Pod and Bao-held API login before deleting the Secret.
Durable phase/identity and cut/resume checks cover upgrade, verification and
deletion; a still-referenced Secret must never be deleted. The retention
fallback does not reassign lifecycle ownership. SQLite still removes the
pre-Flux CNPG dependency.

**Nonblocking consistency comments:** design:480–481 and F7 (:1792) still
summarize deletion immediately after Bao hand-off, omitting the mandatory
Helm transition and replacement-Pod check. N-19 (:1851) also omits the
explicit Flux-bootstrap step between creating Flux auth and verifying the
Bao-held credential, making its inline sequence appear circular. Align
these summaries with ADR:952–979 and G3. These are not missing mechanisms:
design:14 explicitly gives the ADR precedence, and G3/N-19's detailed
hand-off/cut checks forbid the original restart failure.

### R6-06 — CLOSED

ADR:1002–1022 and design:20–38/P23 retain SQLite, repository data and
config on Gitea's own PVC, outside shared CNPG. Installer-Helm remains the
single owner, with no Flux adoption, candidate/rollback exclusions and
separate owner-authorized upgrades with backup and no automatic downgrade.
G3's refusal-before-mutation check remains. The bootstrap Helm transition
is that installer's hand-off, not an application generation mutation.

**Nonblocking consistency comment retained:** design:1123–1125 still says
“like CNPG and OpenBao” outside generation reconciliation. Align it with
ADR:795 and design:20–38. This was already noted in the second pass; it
neither restores a shared-CNPG dependency nor regresses the closed finding.

### R6-07 — CLOSED

ADR:804–808, :1019–1022 and design:1132–1137 retain deferred backup,
owner recovery for source identity/revision loss or regression, and no
auto-reseed. Future backup pairs repository data and SQLite DB/config and
verifies recorded commits/auth/rules. Neither the mirror nor a filed backup
task is presented as an available restore path.

### R6-08 — CLOSED

ADR:501–507, design:1620 and G1/G5 (:1799/:1803) retain candidate
`main`/PR refs separate from deploy reconciliation refs, durable SHA/outcome
deduplication, rollback precedence and explicit owner/new-SHA retry.
The third pass does not permit automatic reapplication of a failed SHA,
selection of an operator revert as a candidate, or a reset rollback clock.

### R6-09 — CLOSED

ADR:1034, :1044–1061 and P26/G4 (design:200/:1802) specify a dedicated
mirror listener on its own gateway port. NetworkPolicy admits only Gitea
Pods in `lifemodel-git`; Gitea cannot reach other listeners. That listener
selects one fixed `gitea-push-mirror` policy, allowing CONNECT only to the
configured remote host on 443. Caller binding is therefore the restricted
listener, not an unavailable stream identity, a selectable caller header,
or the outside-remote credential. No proxy credential or bus/store authority
is required or introduced.

The supported `deployment.env`, paired HTTPS proxy variables, internal
no-proxy settings and operator-delivered remote credential remain. G4 now
requires actual commit delivery, another caller's listener denial and
Gitea's inability to select another policy/listener, alongside remote/direct
internet denial and mirror-off/gateway-down cases. The gateway remains
replaceable; mirror failure is non-gating and not a recovery channel.

### R6-10 — CLOSED

Design:97, :265–276, P16/P25, Q9/Q10 (:1817–1818) and ADR:1711 retain
P8/P24/P27 and exception e without proxy-only sandbox summaries. Owner UI
anonymous denial, login/PR viewing and external URL checks remain distinct
from internal authenticated Flux/operator/task Git. The new mirror listener
adds no public ingress or sandbox bus/store route.

**Primary evidence:** [official Gitea chart 12.7.0 archive](https://dl.gitea.com/charts/gitea-12.7.0.tgz)
(the source files/lines cited above),
[OpenBao ACL-policy API](https://openbao.org/docs/api/system/policies/),
[ACL-policy UpdateOperation](https://github.com/openbao/openbao/blob/ad64d389cb66023521c4228dc9f1149400d87351/internal/vault/logical_system_paths.go#L3880-L3888),
and [Kubernetes auth role deletion](https://github.com/openbao/openbao/blob/ad64d389cb66023521c4228dc9f1149400d87351/internal/builtin/credential/kubernetes/path_role.go#L246-L262).
The OpenBao source revision is evidence for this observation, not a deployed
version claim.

**New blocking findings:** none. No R6-11 is opened. The retained comments
are summary alignment under the existing findings, not a reopening of the
fixed coordinator or Round 5 decisions.


## Round 7 (two-layer GitOps review, 2026-10-13)

**Verdict: BLOCK.** Six blocking findings and three comments.

**Scope:** `git diff abb057a..239754d` (the six rewrite commits), reviewed
at `239754d4ab87a9c205b2e19390f968e5490df1bd`, in
`docs/adr/010-container-generations.md` (ADR) and
`docs/features/instance/containers-design.md` (design). Line numbers below
refer to that revision. The owner's 2026-10-13 decisions are fixed: signed
OCI platform source through Flux; application generations from Gitea's deploy
branch; installer limited to k3s, Flux and the platform source; loader
initialization; platform-owned Gitea on its own SQLite PVC; dedicated VM only.
No rejected installer-Helm or existing-cluster option is reopened.

**Method:** independent architecture/source review, assisted by two read-only,
same-model scoped reviewers. The official Gitea chart `12.7.0` archive and
Flux primary documentation were read, not rendered or installed. No builds,
tests, cluster/installer walks or automatic document-readiness gate ran.
Specified checks are not passes. No `br` operation or `.beads/` modification
was made. Commit hooks are bypassed because the commit-message hook invokes
`br`; the required leaf-task link remains in the subject.

**Round 6 regression check:** R6-01/02/03/04/07/08/09/10 retain their design
mechanisms: one rollback clock; distinct task identity; durable token cleanup;
exact Bao write grants and final Pod admission; no auto-reseed; candidate/deploy
ref separation; fixed mirror listener; and complete sandbox/UI route summaries.
R6-05's live-Secret retention rule is now explicit and sound. However its
reference-retirement conditions have been weakened, and the R6-05/06 explicit
Gitea chart overrides and R6-06 upgrade backup prerequisite were dropped
(R7-03/R7-05). Gitea's platform lifecycle owner and separation from shared CNPG
are correct decisions, but the selected chart values must actually implement
them. These are design conclusions, not runtime acceptance.

### R7-01 — Application scope needs effective, transitive enforcement

- **Severity:** blocking.
- **Place:** ADR:933–937, 1011–1020; design:22–27, 167–173, 241,
  799–818, 1159–1163; F7/G3/N-19 at design:1815/1824/1874.
- **Failure:** namespace restrictions are asserted, but neither application
  Kustomization nor module HelmRelease has a required apply identity and
  corresponding enforcement contract. Both layers use the same Flux
  controllers. Flux defaults to controller authority, normally cluster-admin;
  restricting kustomize-controller alone does not restrict helm-controller
  when it consumes a namespaced HelmRelease. An ordinary candidate chart can
  therefore render platform or cluster-scoped resources through Helm. Also,
  platform policies/accounts exist inside `lifemodel` and `lifemodel-motor`:
  namespace-only rights do not stop a candidate overwriting them or adding an
  allow-all NetworkPolicy (allow policies are additive). The retained full
  generation rollback of NetworkPolicy/RBAC has no precise boundary against
  those platform-owned objects.
- **Fix:** declare platform-owned restricted apply ServiceAccounts and
  RoleBindings for both application Kustomizations and HelmReleases. Require
  and protect `spec.serviceAccountName`, with fail-closed enforcement for
  omitted or privileged identities. Constrain remote `kubeConfig`, nested
  reconcilers, cross-namespace references and target/storage namespaces. Define
  per-kind/name/field ownership inside the two shared namespaces, including
  allowed application policy/RBAC changes; protect platform isolation objects.
  Check rendered outputs, hooks and CRDs, not just candidate file paths.
  Exercise real Flux/Helm refusals for a cluster object, a Gitea object and
  an in-namespace platform-policy/account change, alongside a valid rollout.
- **Primary evidence:** [Flux Kustomization RBAC](https://fluxcd.io/flux/components/kustomize/kustomizations/#role-based-access-control),
  [HelmRelease RBAC](https://fluxcd.io/flux/components/helm/helmreleases/#role-based-access-control),
  [multi-tenancy lockdown](https://fluxcd.io/flux/installation/configuration/multitenancy/).

### R7-02 — The new loader has no complete bootstrap authority contract

- **Severity:** blocking.
- **Place:** design:205–208, 239–250, 407–415, 494–510, 540–542,
  554–557; ADR:1366–1403, 1411–1412.
- **Failure:** first start now belongs to the loader, which must create custody
  and credential Secrets, create the application GitRepository/Kustomization,
  and later patch the platform pin. The exhaustive mutation/route tables name
  only the generation operator, with none of the necessary Secret/source/pin
  grants in `lifemodel-git` or `flux-system`. The retained Bao-independent
  startup, init/unseal and custody contract belongs to that operator. No
  loader identity or explicit process relationship resolves this. A separate
  loader can be denied or depend on Bao before initializing it; treating it
  as the generation writer implicitly gives that writer the platform pin
  authority the rewrite explicitly forbids.
- **Fix:** name the loader/operator process and privilege boundary. Supply a
  platform-declared, Bao-independent loader bootstrap identity, exact API/Bao/
  Gitea routes, narrow Secret/record/source/pin grants, pre-Bao custody location,
  phase ownership and verified steady-state credential hand-off. Keep
  bootstrap Secrets/records outside Flux prune/overwrite inventories. Make
  the loader runnable before Gitea readiness and Bao unseal; neither
  platform aggregate readiness nor a Bao-dependent webhook may create a
  cycle. Walk positive operations under the real loader identity and denied
  platform operations under the generation writer's identity. The existing
  ADR:1378–1382 init-to-custody crash limitation is retained, not newly absent.

### R7-03 — Gitea's effective chart configuration regressed

- **Severity:** blocking; regression under R6-05/06.
- **Place:** ADR:318–323, 998–1010, 1152–1157; design:29–44,
  485–492, 512–529; G3/N-19 at design:1824/1874.
- **Failure:** the rewrite removed every explicit bundled-database/cache
  disable. Chart `12.7.0` enables `postgresql-ha` and `valkey-cluster` by
  default; `_helpers.tpl:480–487` overwrites `DB_TYPE` with `postgres` when
  HA is enabled, even if the input says `sqlite3`. The stated configuration
  thus does not produce the owner's SQLite-on-one-PVC shape, and its DB/cache
  traffic has no allowed Gitea route. The optional later removal of
  `existingSecret` also dropped explicit empty admin username/password and
  Bao-held login verification. Removing the reference alone permits the
  chart's default admin configuration to run; with a different bootstrap
  username it can create a default administrator. A replacement Pod can be
  healthy and reference-free while that unintended account exists.
- **Fix:** restore signed platform values explicitly disabling
  `postgresql-ha`, `postgresql`, `valkey-cluster` and `valkey`, selecting
  SQLite and built-in queue/cache behavior. Explicitly empty
  `gitea.admin.username` and `gitea.admin.password` while using the generated
  Secret. A later reference-retirement release must disable admin
  configuration and verify no fallback password/admin input, a replacement
  Pod and Bao-held API login before deleting the Secret, with durable resume
  cuts. Check effective rendered configuration and absence of bundled
  database/cache workloads/PVCs, not merely the requested `DB_TYPE` value.
- **Primary evidence:** [official chart archive](https://dl.gitea.com/charts/gitea-12.7.0.tgz),
  `values.yaml` (bundled-service and admin defaults),
  `templates/_helpers.tpl:479–497`, `templates/gitea/deployment.yaml:272–288`,
  `templates/gitea/init.yaml:82–83, 105–137`. Retaining a live Secret is
  correct; this finding does not require its deletion.

### R7-04 — Root trust and owner-selected pin lack exclusive ownership

- **Severity:** blocking.
- **Place:** ADR:940–946, 975–995, 1011–1012;
  design:167–169, 554–557.
- **Failure:** the installer-bundled identity matcher must not come from the
  artifact it authenticates, yet the platform layer is also said to own the
  root OCIRepository/Kustomization, while the loader changes that root's pin.
  There is no root inventory/field exclusion separating those owners. If
  the artifact renders the old root reference, its reconcile can undo an
  owner-selected pin; if it manages verification fields, the external trust
  root is no longer external. The text forbids the latter but does not
  specify how its conflicting ownership statements are realized.
- **Fix:** put the root source and verification policy outside the authenticated
  artifact's managed inventory, or specify enforceable exclusive field
  ownership: installer/root-policy authority owns verification, authorized
  loader owns the selected digest, artifact cannot overwrite either. Name
  the root Kustomization lifecycle and how pin changes persist across Flux,
  loader and node restart. Check an owner repin under competing reconciliation
  and reject a release that attempts to change its verifier or selected pin.
  This is an unresolved ownership contract, not evidence that an artifact
  has already taken over trust.

### R7-05 — Platform upgrades lack a safe recovery protocol

- **Severity:** blocking; includes R6-06 backup-prerequisite regression.
- **Place:** ADR:939–950, 1005–1010; design:34–36, 554–565;
  checks at design:1805–1874.
- **Failure:** changing the digest and reporting a failed resource does not
  define recovery of a partially applied platform release. Gitea can migrate
  SQLite before another component fails, and the same update can replace
  the loader/Traefik that provides the only owner recovery UI. The former
  verified backup prerequisite is gone while backup/restore remains deferred.
  “No automatic DB downgrade” does not make an old-pin rollback safe. The
  application source supposedly stays at its current revision, but remains
  branch-tracking and no gate prevents the generation operator committing
  another deploy step concurrently. No platform/app compatibility preflight,
  durable upgrade attempt or platform-upgrade walk supplies these mechanisms.
- **Fix:** define a recorded owner-commanded upgrade with exact old/new
  digests, supported component upgrade paths, compatibility preflight against
  the running application, bounded phases and crash reconciliation. Serialize
  application selection/deploy writes at the recorded revision while leaving
  its reconciliation active, as the owner requires. Preserve reachable owner
  recovery. Define when a verified previous pin is safe, and otherwise use
  explicit forward/owner recovery without DB downgrade or pruning durable
  state. Require verified recovery material before irreversible Gitea/storage
  upgrades; if unavailable in this milestone, refuse/defer those upgrades
  rather than imply the deferred backup exists. Specify Helm remediation
  so it cannot silently downgrade a migrated database. Add real walks for
  success, partial failure, loader restart/UI failure, concurrent app writes,
  safe pin rollback and unsafe-downgrade refusal.

### R7-06 — The complete network policy omits the new platform fetch

- **Severity:** blocking.
- **Place:** ADR:1034; design:188, P15 at 211, N-8 at 1861.
- **Failure:** the namespace summary adds signed OCI access, but P15 still
  permits Flux only the Kubernetes API and Gitea. N-8 demands exactly P1–P27
  and enumerates world-facing surfaces without Flux. Under that default-deny
  policy, once the platform applies its policies the source controller
  cannot fetch the next platform release or recover an uncached source.
  A successful initial fetch before policy application is not proof of
  continuing GitOps operation.
- **Fix:** add the concrete platform-source network paths: OCI registry,
  required registry auth/signature endpoints, and any trust-verification
  endpoints the selected Flux/Cosign version needs. Make them independent of
  the replaceable application egress gateway. Include controller-to-source
  artifact delivery if required by the installed Flux topology. Align the
  complete policy table and N-8, and prove an actual signed fetch/reverification
  after default-deny is installed and after source-controller restart.
  Do not assume every keyless verification needs online Rekor: state and
  test the selected verifier/bundle behavior.

### R7-07 — Signing identity transitions and source outages are unspecified

- **Severity:** comment.
- **Place:** ADR:969–987; design:F7/G3/N-19 at 1815/1824/1874.
- **Failure:** the keyless issuer/workflow/tag restriction, digest pin and
  tampered/unsigned refusal are useful, but no identity/trust-root transition
  or registry/verifier outage contract is recorded. A workflow rename can
  strand installed roots, and clean install versus cache-loss restart have
  different availability consequences. Ordinary short-lived certificate
  renewal is not a publisher-identity change.
- **Fix:** record an owner-authorized, separately authenticated root-policy
  transition with narrow old/new identity overlap and retirement, not a
  matcher supplied by the release being verified. State whether clean install
  requires network access; fail closed when required artifacts/signatures/
  trust evidence are unavailable, with no tag or unsigned fallback. Define
  existing-workload and previously verified artifact behavior during outage
  and cache loss. Check allowed/denied identities before/after transition,
  refusal cases, registry outage and controller/cache restart.
- **Primary evidence:** [Flux OCI verification](https://fluxcd.io/flux/components/source/ocirepositories/#verification)
  defines `matchOIDCIdentity` issuer/subject regexes evaluated in OR fashion,
  and default Fulcio/Rekor trust.

### R7-08 — Panic needs an explicit two-layer stop set

- **Severity:** comment.
- **Place:** ADR:615–620, 801–826, 931–937;
  design:503–508, 815–819, 1268–1303; Q5 at design:1836.
- **Failure:** panic still names per-module HelmRelease suspend/scale, while
  the retained gate rule says those Flux resources are bootstrap roots with
  no parent Kustomization. The new installer creates only the platform root,
  and the loader adds an application Kustomization; their actual inventory
  and panic behavior are not mapped. Suspending all Flux indiscriminately
  could stop control-plane repair, while allowing a parent to own gate
  fields could undo the stop. Neither unsafe behavior is established by the
  current text: source omission of operator-owned fields can preserve them
  under server-side apply, and the per-release ACK/quiescence/Motor-cleanup
  rules remain valuable.
- **Fix:** name the application Kustomization/HelmRelease stop set and the
  platform Kustomization/control-plane leave-running set. State explicitly
  whether the application Kustomization continues with protected gate fields
  or is also suspended. Replace the obsolete bootstrap-root exclusion with
  the actual inventory and field-ownership rule. Define platform-upgrade
  precedence during panic and durable owner resume. Extend cuts with competing
  app/platform reconciles and an upgrade during panic, proving no module or
  sandbox restart and a reachable owner UI.

### R7-09 — Check claims must retain their limits

- **Severity:** comment.
- **Place:** ADR:1378–1382; design:1788–1789, F7 at 1815,
  G3 at 1824, N-19 at 1874.
- **Failure:** the detailed ADR still admits Bao initialization interrupted
  before custody persistence as visible owner recovery, not automatic safe
  resume. The rewritten checks promise no lost credentials across every
  action without that exception. Also the clean-VM rows no longer carry the
  explicit UNPROVED-in-CI marker required by their own scope paragraph. Such
  assertions can obscure an accepted crash limitation or imply delivery
  evidence not yet recorded.
- **Fix:** make the init-to-custody cut assert the named visible recovery
  outcome and no second init; do not claim automatic credential preservation
  there. Restore UNPROVED-in-CI directly in F7/G3/N-19 until a recorded
  dedicated-VM run exists. Include the new upgrade, source-outage, identity-
  transition and two-layer panic checks requested above; do not substitute
  synthetic source lint or an empty k3d cluster for those real walks.


## Round 7 confirmation (2026-10-13)

**Verdict: BLOCK.** R7-01, R7-02, R7-05 and R7-06 remain blocking.
R7-03, R7-04, R7-07, R7-08 and R7-09 are CLOSED at design level.
No new blocking finding is opened. R7-08 retains consistency comments.

**Scope and method:** confirmation of `605e884..913ad09`, using the five
fix commits as dispositions: `9b04984` (R7-01/02), `14b7305` (R7-03/04),
`6a16bed` (R7-05/06), `f86524f` (R7-07/08), and `913ad09` (R7-09).
`ADR` and `design` retain the Round 7 path abbreviations; line references
below are at `913ad09`. Two read-only, same-model assistants independently
checked authority and lifecycle contracts. The official Gitea chart
`12.7.0` archive and Flux primary documentation were read, not rendered or
installed. No builds, tests, cluster/installer walks or automatic
document-readiness gate ran. CLOSED means that the design addresses the
stated failure, not that its proposed checks passed. No `br` operation or
`.beads/` modification was made. Commit hooks are bypassed because the
commit-message hook invokes `br`; the required leaf-task link is retained.
The two GitOps layers, signed OCI platform through Flux, k3s/Flux/source-only
command, loader first start, platform Gitea on SQLite, dedicated VM and
Cosign keyless GitHub OIDC are fixed inputs, not decisions reopened here.

### R7-01 — STILL OPEN (blocking)

ADR:1625–1627 and design:1809 now require BOTH controllers to impersonate
restricted accounts, reject omitted/privileged identities and remote
kubeconfigs, and protect platform objects through admission, including
rendered hooks. These are substantive improvements, but the actual
application apply topology is still inconsistent.

The loader creates one application Kustomization in `flux-system`
(ADR:1633; design:506–508). ADR:1625 requires that Kustomization to pin
`targetNamespace` to `lifemodel` OR `lifemodel-motor`, with its apply Role
only in that target. Flux Kustomization `targetNamespace` overrides output
namespaces; this single restricted object cannot apply the required
resources/releases in both namespaces. No per-namespace arrangement or
permitted reconciler/reference edges are specified. The blanket rejection
of nested reconcilers also needs an explicit exception for the intended
Kustomization-to-HelmRelease relationship. Name the actual object/account/
RoleBinding arrangement and its permitted edges, rather than opening a
controller-authority fallback.

The ownership boundary is also unfinished: ADR:1627 refers to a versioned,
explicitly enumerated kind/name/field allowlist but supplies no enumeration.
Design:1159–1163 still restores generation NetworkPolicy/RBAC with the full
previous chart. Define which application-owned policy/RBAC objects and
fields may change and revert, or explicitly exclude them while keeping
platform isolation immutable. The named real refusal/valid-rollout checks
do not supply that missing boundary. This is not a demand for runtime
acceptance before implementation.

### R7-02 — STILL OPEN (blocking)

ADR:1631–1635 now separates the loader from the generation operator, gives
it Bao-independent startup and Kubernetes custody/source/pin operations,
excludes its records/Secrets from pruning, and names durable phases and
readiness/webhook-cycle refusal. However the routable identity and custody
hand-off are not complete.

The exhaustive policy still names only the operator for API, Gitea and Bao
access (design:P9/P10/P12 at :205–208); the separate loader has no named
routes under default-deny. Add its exact routes without giving generation
writers platform authority. The detailed Bao lifecycle still assigns init,
every-restart unseal, root-token retirement and steady-state login to the
operator (ADR:1366–1403; design:407–415,540–541), while ADR:1633 denies the
generation writer bootstrap custody grants. Name the steady-state custodial
actor, its retained key-read/unseal authority on a sealed restart, and the
verified bootstrap-to-steady-state hand-off. “Named bootstrap setup paths”
at ADR:1633 does not actually name those paths/operations.

ADR:1625 also lets the loader create/change application apply accounts,
bindings and policy, while :1633 expressly forbids it from changing
ServiceAccounts/Roles/RoleBindings. Settle that provisioning owner and align
the exhaustive grants. The original missing-authority failure remains;
the accepted init-to-custody crash limitation is not reopened.

### R7-03 — CLOSED

ADR:1639 and design:1811 restore all four explicit bundled database/cache
disables, SQLite/built-in behavior, and empty admin username/password values
while the generated Secret supplies the credential. They require effective
rendered configuration and absence of bundled workloads/PVCs. Reference
retirement now disables admin configuration, proves no fallback inputs,
checks a replacement Pod and Bao-held API login, and persists each cut
before deleting an unreferenced Secret.

Chart `12.7.0` supports this mechanism: `_helpers.tpl:479–497` overrides
SQLite when either bundled PostgreSQL is enabled; `init.yaml:82–138`
configures an admin only with `existingSecret` or nonempty username AND
password; `deployment.yaml:272–288` resolves the referenced Secret until
that reference is removed. The new explicit values and retirement sequence
address both regressions. Design:527–528 remains an abbreviated retirement
summary; read it with the mandatory ADR:1639 conditions, not as permission
to skip Bao login or fallback-input checks.

### R7-04 — CLOSED

ADR:1641 explicitly chooses the outside-artifact-inventory solution for
BOTH root OCIRepository and root Kustomization. It separates installer/
root-policy verifier ownership from owner-authorized loader digest
selection, forbids artifact declaration/adoption/patch/prune of the roots,
and records etcd persistence plus durable selected-digest reconciliation
after restart. Design:1812 checks competing reconciliation and rejection of
release-supplied verifier/pin changes. The original conflicting root
inventory ownership is resolved. Broad platform-layer placement at
ADR:1011–1013/design:167–169 must be read with this explicit root exception.
Field-limited patch rights require enforcement beyond ordinary RBAC; the
outside-inventory decision does not make an RBAC verb field-selective.

### R7-05 — STILL OPEN (blocking)

ADR:1645–1647/design:1813 now specify old/new digests, versions, application
revision, compatibility, durable lock/phases/outcome, safe prior-pin
conditions and no implicit Helm rollback/uninstall after migration. They
restore the recovery prerequisite honestly: Gitea/storage upgrades requiring
recovery material are refused/deferred while backup/restore is unavailable.
The migration, unsafe-downgrade and backup-regression portions are addressed.

Reachable recovery is still an assertion without a platform apply protocol.
The loader's only release-changing grant patches the root digest
(ADR:1633); the single platform root then reconciles the whole release
(ADR:939–946; design:554–565). No staged inventory/dependency/gate arrangement
holds Flux from replacing the loader, Traefik route or required policy
before independent replacement health and owner access are verified, as
ADR:1645 requires. A partial apply can therefore still remove the only UI
needed to resolve the failed durable lock. Name the bounded apply phases,
the mechanism that enforces their order, and the recovery access that
survives each cut; do not rely on a future walk to provide the mechanism.

Also specify lock acquisition against an already-open application step or
active rollback. Existing step ACK/next-commit sequencing (ADR:603–627)
is not mapped to the new prohibition of deploy writes until durable success
or owner-resolved failure (:1645). Define quiescence/arbitration and failure
precedence without resetting the existing rollback clock. No measured
rollback regression is asserted here; this is the original upgrade/
concurrent-application protocol gap.

### R7-06 — STILL OPEN (blocking)

P15 and the namespace summaries (design:188,211; ADR:1034,1649) now include
registry/authentication, verifier and internal artifact-delivery route
categories, independently of the replaceable application egress gateway.
But the concrete verifier/network choice remains postponed. ADR:1649 says
“State and pin” bundle/Rekor behavior, and design:1814 says “Pin verifier
versions and state whether” inclusion evidence or an online endpoint is
required. Neither selects a Flux/Cosign version/mode or names the actual
registry/authentication/Sigstore hosts and delivery ports needed by it.

Choose that topology and verification behavior, then record the complete
routes. N-8 (design:1875) still enumerates its ONLY world-facing surfaces
without Flux and omits the signed fetch from its positive route walk;
ADR:193–197 retains the same old exclusive outbound summary. Align both
with P15. The new after-policy/restart signed-fetch checks are appropriate,
but missing runtime evidence is not the reason this finding remains open:
the route and verifier decision itself is still unspecified. Keyless GitHub
OIDC is retained; no alternative signing scheme is requested.

### R7-07 — CLOSED

ADR:1653–1655/design:1815 record a separately authenticated root-policy
transition outside the artifact, exact old/new identity overlap and later
retirement, and distinguish certificate renewal from identity change.
Clean install requires network and fails closed without artifact/signature/
required trust evidence, with no tag, unsigned or broader-matcher fallback.
Outage preserves running workloads/last applied state; cached verified use
requires intact artifact/evidence and unchanged trust, while cache loss
blocks fetch/reconciliation. Identity, retirement, outage and restart cuts
are specified. The concrete verifier mode/endpoints remain under R7-06,
not a reopening of this transition/outage contract.

### R7-08 — CLOSED

ADR:1657/design:1816 now explicitly keep the application Kustomization
reconciling, suspend every application HelmRelease in both application
namespaces, protect source-omitted operator suspend/scale fields through
admission/field ownership, and leave the platform roots/controllers,
loader/owner routes, Gitea and Bao running. Conflicting platform upgrades
pause and cannot clear panic; owner resume is durable. Competing app/
platform reconciliation and upgrade-during-panic cuts are specified.
The existing suspend ACK, in-flight action quiescence, per-release observed
zero state and Motor-owned sandbox cleanup remain binding.

**Consistency comment:** ADR:619–620,817–819 and design:817–818 still say
that application Flux resources have no parent Kustomization. Replace
these obsolete summaries with the actual parent inventory and protected
field rule. ADR:1657 expressly removes the bootstrap-root exclusion and
provides the replacement rule, so this is not a missing stop mechanism.
Upgrade recovery enforcement remains the separate R7-05 gap.

### R7-09 — CLOSED

F7/G3/N-19 (design:1829,1838,1888) now explicitly mark the dedicated-VM
walks **UNPROVED-IN-CI**. The Bao init-success/before-custody-write cut
asserts visible owner recovery, no second init and no automatic credential-
preservation claim. Design:1813–1817 includes the requested upgrade,
source/cache/reverification, identity-transition and two-layer panic cases
and rejects synthetic lint/empty k3d as VM delivery evidence. These are
specified checks, not recorded passes; no automatic safe-resume claim is
made for the accepted crash window.

**Round 6 regression check:** R6-01/02/03/04/07/08/09/10 retain their
closed mechanisms: one rollback clock and maintenance-on-expiry
(ADR:790–800/G5), distinct task identity and durable revoke
(ADR:1413/G2), exact Bao `update` grants, final mutated-Pod validation and
run teardown (ADR:177–191; design:P12/P27), no auto-reseed, candidate/deploy
ref separation (ADR:492–498/G1), the fixed mirror listener (design:P26/G4),
and sandbox/UI route exceptions. R7-03 restores the R6-05/06 effective
chart and safe credential-retirement conditions. R7-05 restores the R6-06
recovery prerequisite by refusing irreversible upgrades while recovery is
deferred. SQLite remains independent of shared CNPG. No additional closed
Round 6 mechanism regressed in these five fixes; unresolved two-layer
bootstrap/apply/upgrade/network gaps remain under the original R7 findings.

**Primary evidence:** [official chart 12.7.0 archive](https://dl.gitea.com/charts/gitea-12.7.0.tgz)
(the source files/lines cited above),
[Flux Kustomization target namespace and RBAC](https://fluxcd.io/flux/components/kustomize/kustomizations/#target-namespace),
[HelmRelease target/storage namespace and RBAC](https://fluxcd.io/flux/components/helm/helmreleases/),
and [Flux multi-tenancy lockdown](https://fluxcd.io/flux/installation/configuration/multitenancy/).
Primary-source reading establishes the specified API behavior, not a deployed
version or acceptance run.

**New blocking findings:** none. No R7-10 is opened. The remaining gaps
belong to R7-01/02/05/06; fixed owner decisions are unchanged.


## Round 7 dispositions, second pass (2026-10-13)

- R7-01 — Resolved by `09ca3a0`, `32a10d0` and `4679bc3`: two per-target application Kustomizations, explicit same-namespace HelmRelease edge, enumerated generation ownership, and platform-owned immutable policy/RBAC; not runtime-verified.
- R7-02 — Resolved by `206c596`: loader owns Bao init, sealed-restart unseal, custody and root retirement with a verified hand-off; applier RBAC is platform-release-owned; loader routes P28-P30 are enumerated; runtime-verified checks remain outstanding.
- R7-03 — Closed at design level by `14b7305`; rendered chart and replacement/login checks remain unverified.
- R7-04 — Closed at design level by `14b7305`; competing reconciliation and restart checks remain unverified.
- R7-05 — Resolved by `fdaa27e`: ordered A/B/C platform Kustomizations and health gates, `lifemodel doctor` SSH recovery/check, and quiescence/rollback-clock arbitration; dedicated-VM check remains unrun.
- R7-06 — Resolved by `4f5234e` and `1a63298`: pinned Flux minimum and keyless online Cosign identity, exact signed-fetch endpoints, P15 and N-8 aligned; live signed-fetch verification remains unrun.
- R7-07 — Closed at design level by `f86524f`; identity-transition and outage walks remain unverified.
- R7-08 — Closed at design level by `f86524f`; stale parent-Kustomization summary corrected in `32a10d0`; runtime panic/reconcile walk remains unverified.
- R7-09 — Closed at design level by `913ad09`; dedicated-VM evidence remains absent.


## Round 7 confirmation, second pass (2026-10-13)

**Verdict: BLOCK.** R7-01, R7-02 and R7-06 are STILL OPEN (blocking).
R7-05 is CLOSED on its upgrade scenarios; R7-03, R7-04 and R7-07–09
remain CLOSED. No previously closed Round 6 finding regressed. No new
blocking finding is opened; the new first-start cycle belongs to R7-02.
Nonblocking summary corrections remain.

**Scope and method:** confirmation of `1545e39..a296a2a`, including the
second-pass dispositions, against the precise gaps in the first Round 7
confirmation. `ADR` means `docs/adr/010-container-generations.md`; `design`
means `docs/features/instance/containers-design.md`. Line references below
are at `a296a2a004f24478554e01d2bec864f8f7653e34`. Two read-only,
same-model assistants checked authority and lifecycle contracts. Their
findings and load-bearing Flux/Helm behavior were checked here against
primary documentation and pinned source. CLOSED means the written mechanism
addresses the finding, not that its proposed checks passed.

The owner's decisions and the coordinator's second-pass choices are fixed
inputs: two application Kustomizations and per-target appliers; enumerated
application-owned kinds with platform-owned NetworkPolicy/RBAC; loader Bao
custody; ordered A/B/C platform upgrades; SSH `lifemodel doctor` recovery;
quiescence arbitration; and online Sigstore verification. The gaps below
concern their realization, not alternatives to those choices. No builds,
tests, rendering, cluster/installer walks or automatic document-readiness
gate ran. No `br` operation or `.beads/` modification was made. Commit hooks
are bypassed because the commit-message path invokes `br`; the required
leaf-task link remains in the subject.

### R7-01 — STILL OPEN (blocking)

ADR:935–942,1988–2006 and design:509–515,1944–1956 now explicitly supply
the two target-specific Kustomizations, the permitted Kustomization-to-
HelmRelease edge, the application kind enumeration and immutable platform
policy/RBAC. Rollback no longer restores NetworkPolicy/RBAC
(ADR:770–777; design:1167–1174). These address the previous ownership gap.
The effective identity/reference/grant arrangement still cannot perform a
valid rollout:

- Both Kustomizations are in `flux-system`, but their referenced applier
  ServiceAccounts and RoleBindings exist only in the target namespaces
  (ADR:1988–1996; design:1944–1948). Flux resolves `serviceAccountName`
  using the Kustomization's **object namespace**, not `targetNamespace`.
  Thus it impersonates `system:serviceaccount:flux-system:<name>`, not the
  account granted rights in `lifemodel` or `lifemodel-motor`. The pinned
  controller passes `obj.GetNamespace()` to its impersonator, whose user
  string uses exactly that namespace. No target RoleBinding for that actual
  principal is specified. Provide the Kustomization-namespace identities
  and correctly scoped RoleBinding subjects, separately from the target-
  namespace HelmRelease identities. Keep both Kustomizations and narrow
  grants; no controller-authority fallback is needed.
- The only application GitRepository is in `flux-system`
  (ADR:1624,1632–1633; design:P28 at :224), while HelmReleases are in the
  target namespaces. With `--no-cross-namespace-refs` (ADR:1616), those
  HelmReleases cannot fetch charts from that source. The sole permitted
  reconciler/reference edge at ADR:1995–1997 does not supply a chart source
  in either target namespace. Name the platform-owned local chart-source/
  artifact arrangement and its permitted edges, without broadening
  generation-owned kinds or reopening cross-namespace controller authority.
- The applier Role grants **only** the listed application-owned kinds
  (ADR:1993–2000); Secrets are absent. Mandatory Helm impersonation still
  needs Helm release-history storage. Helm defaults to Secrets in the
  release storage namespace; Flux defaults that namespace to the
  HelmRelease namespace. No alternative backend or narrowly protected
  controller-storage grant is stated. Define that storage authority
  separately from application workload ownership; arbitrary platform
  Secret access is not required.

These are missing usable permissions/topology, not missing runtime evidence.
The positive real-rollout check remains necessary after the arrangement is
made internally consistent.

### R7-02 — STILL OPEN (blocking)

The original custodial actor, hand-off, routes and provisioning-owner gaps
are addressed by ADR:1369–1394,1616,1622–1639 and
design:P28–P30 (:224–226),407–416,543–548,1676. The separate loader
initializes Bao, persists/read-backs custody, unseals every sealed restart,
verifies its Kubernetes-auth login and retires the initial root token.
Generation writers hold no custody or platform-pin authority. The signed
platform alone provisions application applier RBAC.

However the new structural apply order creates the forbidden first-start
cycle. ADR:1659–1664/design:1960–1963 put Bao and Gitea in A with
`wait: true`, B after healthy A, and the loader in C after healthy B.
Bao cannot become ready before that loader initializes/unseals it
(ADR:1371–1394). Gitea cannot start its bootstrap admin path before that
loader creates its referenced Secret (design:503–505,518–531). Therefore
A cannot become healthy, so C cannot apply the sole actor needed to make
A healthy. No clean-install exception or independent bootstrap-loader
inventory is specified. This contradicts ADR:1626/design:1819's explicit
loader-before-readiness/no-cycle rule.

Retain the fixed A/B/C **upgrade** order, but specify the first-start
bootstrap inventory/dependencies that let the Bao-independent loader run.
SSH owner recovery does not replace the promised automatic clean first
start. The accepted init-to-custody crash window is unchanged.

### R7-03 — CLOSED

ADR:1643/design:1820 retain all four bundled database/cache disables,
SQLite/built-in behavior, explicit empty admin fallback values, and the
reference-retirement sequence: no fallback inputs, replacement Pod,
Bao-held API login, durable cuts, then deletion only when unreferenced.
Design:530–535 still retains a live referenced Secret. No effective-chart
or credential-retirement regression was found. The actual render and
replacement/login walks remain unrun.

### R7-04 — CLOSED

ADR:1645/design:1821 retain both root objects outside artifact inventory,
separate verifier ownership from owner-authorized digest selection, and
persist/reconcile the selection across Flux/loader/node restart. The new
child platform Kustomizations do not reassign root ownership. The previous
field-selective-enforcement caution remains: ordinary RBAC alone cannot
make an OCIRepository patch digest-only.

### R7-05 — CLOSED

The previously missing upgrade apply/recovery mechanism is now named:
A/B/C Kustomizations with dependency and health gates
(ADR:1659–1664; design:1960–1963), plus an independent SSH
`lifemodel doctor` surface when the loader UI/route fails
(ADR:1666–1675; design:1965–1972). The doctor diagnoses both layers,
seal state and the upgrade lock, and offers pin/reconciliation recovery.
ADR:1649–1651 retains bounded durable phases, compatibility preflight,
safe-pin conditions, refusal of irreversible storage upgrades without
verified recovery material, and no implicit Helm downgrade/uninstall.
Doctor recovery inherits those safe-pin conditions; it is not an unsafe
DB-downgrade exception.

ADR:1677–1681/design:1974–1978 now require quiescence before the lock,
exclude open rollout steps/active rollback, prohibit deploy writes while
held, and make a newly necessary rollback fail the upgrade into maintenance
without resetting its existing clock. The original upgrade-specific gaps
are addressed. The unconditional reuse of this topology at first start is
recorded under R7-02, not counted again as an upgrade finding.

Nonblocking precision: explicitly make A/B/C use the same root OCI source.
On the named minimum controller, dependencies sharing that source are
checked against its current artifact revision as well as Ready and observed
generation. Absence of `readyExpr` alone is not an ordering defect. The
upgrade/partial-failure/SSH recovery walks remain unrun.

### R7-06 — STILL OPEN (blocking)

ADR:1653/design:P15 (:211) now choose online Cosign keyless verification,
the GitHub OIDC matcher, a Flux/source-controller feature-version floor,
and GHCR/blob/token/TUF/Rekor hosts on TCP 443, independently of application
egress. P17 supplies DNS. N-8 (:1884) now includes Flux among world-facing
surfaces and positively exercises signed fetch and online verification.
These are substantive fixes.

The previously requested internal delivery topology/ports remain unnamed:
ADR:1653 says only “source-controller-to-artifact-consumer in-cluster
delivery”; P15 says only “internal source-controller artifact delivery”.
For the named source-controller `v1.2.0` topology, artifact consumers fetch
from the `source-controller` Service on TCP 80, targeting its HTTP pod port
9090. Name the initiating kustomize/helm consumers, Service/port and target
port (or the selected override) in the exhaustive policy. External HTTPS
and DNS do not supply this internal default-deny route.

Also align the publisher and verifier identity: ADR:974–983 specifies
`platform-release.yml`, while ADR:1653/P15's exact subject accepts only
`release.yml`. A signature from the former workflow fails the latter
matcher. One consistent workflow must be recorded; neither widening the
matcher nor changing keyless signing is requested. The actual installed
Flux/Cosign release pin must still be fixed and endpoint behavior checked
before implementation acceptance; a minimum version is not that pin.

Nonblocking summary drift remains at ADR:193–197, whose exclusive outbound
list still omits Flux. The after-policy/restart/cache-loss signed-fetch
checks are specified, not run. Runtime absence is not the reason this item
remains open.

### R7-07 — CLOSED

ADR:1685–1687/design:1824 retain separately authenticated root-policy
identity transitions, exact overlap/retirement, fail-closed clean install,
existing-workload preservation, and cache-loss refusal. Online verification
is now selected. R7-06's conflicting workflow descriptions do not remove
this transition/outage mechanism; they must be aligned before its walks.

### R7-08 — CLOSED

ADR:1689/design:1825 retain both application namespaces' stop set,
protected suspend/scale fields, platform leave-running set, conflicting-
upgrade pause and durable owner resume. Design:820–825 now maps the actual
parent Kustomizations. **Consistency comment:** ADR:620–621 and :819–820
still call application Flux resources parentless bootstrap roots. Correct
those stale summaries to the explicit rule at ADR:1689. No closed stop
mechanism is reopened.

### R7-09 — CLOSED

The visible owner-recovery/no-second-init cut remains at
ADR:1377–1379/design:1826. F7/G3/N-19 remain **UNPROVED-IN-CI**
(design:1838,1847,1897). No safe-resume, VM delivery or runtime PASS is
claimed. The stated check limits survived this pass.

### Round 6 regression check

All ten items retain design-level closure:

- **R6-01 — CLOSED:** one rollback deadline, before-expiry resume and
  owner-authorized maintenance recovery (ADR:792–796; design:G5 :1849).
- **R6-02 — CLOSED:** distinct non-admin task identity, account-authenticated
  minting and protected-branch controls (ADR:1404; design:G2 :1846).
- **R6-03 — CLOSED:** durable intent, lost-response reconciliation, revoke
  retries and new-run admission block survive at the same credential/G2
  contracts; no server-enforced Gitea expiry is claimed.
- **R6-04 — CLOSED:** exact Bao `update` grants, run identity/teardown and
  final mutated-Pod validation (ADR:173–191; design:P12/P27 :208/:223).
- **R6-05 — CLOSED:** effective chart overrides and no deletion of live
  references remain (ADR:1643; design:530–535,1820).
- **R6-06 — CLOSED:** platform-owned SQLite/PVC independent of shared CNPG,
  generation exclusion, and recovery-material prerequisite/refusal remain
  (ADR:1001–1015,1651). The bootstrap cycle is under R7-02.
- **R6-07 — CLOSED:** deferred paired backup, owner recovery on source loss,
  no automatic reseed (ADR:1012–1015; design:1190–1195).
- **R6-08 — CLOSED:** candidate/deploy-ref separation, durable SHA/outcome
  deduplication and rollback precedence (ADR:493–499; design:G1 :1845).
- **R6-09 — CLOSED:** fixed, restricted mirror listener/caller policy,
  HTTPS wiring and non-gating failure (design:P26 :222/G4 :1848).
- **R6-10 — CLOSED:** complete sandbox internal exceptions and separate
  owner UI/internal Git authentication (design:P24/P25/P27, N-8).

Additional nonblocking summary corrections: design:F8 (:1839) still asks
for `unsealCustody='operator'`, contrary to fixed loader custody at :1676;
F4 (:1835) still includes “policy” among generation rollback examples;
R7-01's check row (:1818) still blanket-rejects nested reconcilers rather
than preserving the named HelmRelease edge. Platform-owned RBAC summaries
should preserve the explicitly authorized dynamic run/build-account
provisioning exceptions. The specific contracts remain present.

**Primary evidence:**
[Flux Kustomization RBAC](https://fluxcd.io/flux/components/kustomize/kustomizations/#role-based-access-control),
[pinned Kustomization impersonation and dependency checks](https://github.com/fluxcd/kustomize-controller/blob/v1.2.0/internal/controller/kustomization_controller.go#L352-L361),
[pinned impersonator namespace](https://github.com/fluxcd/pkg/blob/runtime/v0.43.2/runtime/client/impersonator.go#L226),
[Flux HelmRelease source/storage rules](https://fluxcd.io/flux/components/helm/helmreleases/),
[Helm storage backends](https://helm.sh/docs/topics/advanced/#storage-backends),
[pinned source Service](https://github.com/fluxcd/source-controller/blob/v1.2.0/config/manager/service.yaml)
and [HTTP container port](https://github.com/fluxcd/source-controller/blob/v1.2.0/config/manager/deployment.yaml).
Pinned source establishes the cited API behavior, not a deployed version or
an acceptance run.

**New blocking findings:** none. No R7-10 is opened. Remaining failures
belong to R7-01/02/06; all fixed owner/coordinator decisions remain inputs.


## Round 7 dispositions, third pass (2026-10-13)

- R7-01 — Fixed: target-namespace Kustomizations and appliers, per-namespace platform GitRepositories and loader-written credentials, local-only references, and Helm release-storage permissions are specified; real valid/denied rollout checks remain unverified.
- R7-02 — Fixed: the Bao-independent loader and its route/policies apply first without depending on A or B; loader first-start work completes backing-service readiness, with SSH `lifemodel doctor` re-pinning a prior release if the new loader is broken. R7-05 quiescence lock and rollback-clock arbitration are unchanged.
- R7-06 — Fixed: P15 defines one `release.yml` keyless identity and P31/P32 name Flux artifact-fetch and Kubernetes-API routes; pinned runtime versions and live signed-fetch/policy checks remain unverified.


## Round 7 confirmation, third pass (2026-10-13)

**Verdict: BLOCK.** R7-01 is STILL OPEN (blocking): the Helm storage
permission is not restricted to release-history Secrets by the stated
mechanism. R7-02 and R7-06 are CLOSED. All previously CLOSED Round 6–7
findings remain CLOSED. No NEW independent blocking finding is opened.
Nonblocking summary corrections remain.

**Scope and method:** confirmation of `e97822e..0dcbb92` against the
second-pass gaps and third-pass dispositions. `ADR` means
`docs/adr/010-container-generations.md`; `design` means
`docs/features/instance/containers-design.md`. Line references below are at
`0dcbb92`. Two read-only, same-model assistants independently checked
application authority and closed-item regressions. Kubernetes primary
admission/RBAC documentation and pinned Flux/Helm source were read, not
rendered or installed. CLOSED means the written mechanism addresses the
finding, not that its proposed runtime checks passed.

The coordinator decisions are fixed: target-namespace application
Kustomizations, same-namespace appliers and local deploy-branch
GitRepositories; loader-first A0 with no A/B dependency; SSH
`lifemodel doctor` recovery instead of recovery-surface-last; and one
`release.yml` signing identity. No alternative to those decisions is
requested. All other fixed inputs stand. No builds, tests, rendering,
cluster/installer walks or automatic document-readiness gate ran. No `br`
operation or `.beads/` modification was made. Commit hooks are bypassed
because the commit-message path invokes `br`; the required leaf-task link
is retained.

### R7-01 — STILL OPEN (blocking)

The identity and source-topology gaps are addressed by ADR:935–950,
1621–1623,2007–2017 and design:511–521,1949–1958. Each Kustomization now
lives in its target namespace, so Flux resolves its ServiceAccount in the
namespace containing the granted applier. Each target has a platform-created
GitRepository and loader-written credential Secret. Kustomizations and
HelmReleases use local sources under disabled cross-namespace references.
The permitted same-namespace HelmRelease edge and immutable platform
policy/RBAC boundary remain explicit.

The Helm storage grant still lacks its promised authorization boundary.
ADR:1623,2019–2023 and design:1823,1960–1964 grant appliers
`get/list/create/update/delete` on namespace Secrets and say admission
restricts Secret access to type `helm.sh/release.v1`. Kubernetes admission
cannot intercept or deny `get`, `list` or `watch`: reads bypass admission.
RBAC has no Secret-type or label predicate. The stated combination therefore
permits reading non-release Secrets in the same namespace, including the
platform-owned deploy-source credential placed there by this very fix
(ADR:1623,1629; design:1953–1954). Calling this controller bookkeeping does
not constrain that effective authority.

An admission type check can constrain mutations, not supply the missing
read restriction. Helm's Secret driver performs namespace `List` calls with
label selectors, so simply adding `resourceNames` is not a working repair:
RBAC name-restricted listing requires a matching `metadata.name` field
selector. A client-selected label filter is not authorization.

Specify an enforceable release-storage authorization/isolation mechanism
that supports the selected Helm lifecycle without arbitrary platform-Secret
reads, while retaining the fixed application topology. Extend the real
identity checks with denied non-release Secret `get/list` alongside successful
Helm install, upgrade, history and cleanup. This remains the original
R7-01 effective least-privilege/storage gap, not a new task or a demand for
runtime proof before the design can close.

### R7-02 — CLOSED

ADR:1669–1677 and design:1973–1979 now place the Bao-independent loader,
its route and policies in A0, sharing the root OCI source and depending on
neither A nor B. A follows A0; the already-running loader initializes/unseals
Bao and supplies Gitea bootstrap inputs so A can become ready. B follows A.
This removes the prior A-readiness → C-loader → A-readiness cycle.

ADR:1376–1399,1629–1649 and design:P28–P30 (:225–227) retain separate
loader authority, custody/read-back, sealed-restart unseal, verified
Kubernetes-auth/root-token hand-off, protected records and no Bao-dependent
webhook or aggregate-readiness startup gate. Source creation now belongs to
the platform; loader grants cover local credentials, verification and the
two local Kustomizations. Generation writers gain no platform-pin/custody
rights. The accepted init-to-custody visible-recovery limit is unchanged.

### R7-03 — CLOSED

ADR:1653 and design:1825 retain all four bundled database/cache disables,
SQLite/built-in behavior, explicit empty admin fallback values, replacement
Pod and Bao-held login verification, and durable reference retirement.
Design:534–540 still forbids deletion while referenced. No effective-chart
or credential-retirement regression was introduced.

### R7-04 — CLOSED

ADR:1655 and design:1826 retain root objects outside artifact inventory,
separate verifier/pin owners, artifact exclusion and durable selection across
Flux/loader/node restarts. Local application sources do not reassign root
ownership. The existing implementation caution remains: ordinary RBAC alone
cannot restrict an OCIRepository patch to its digest field.

### R7-05 — CLOSED

ADR:1669–1694 and design:1973–1991 explicitly replace C-last with A0-first
and independent SSH doctor recovery if the new loader or UI is broken. The
same-root-source ordering precision requested last pass is now explicit.
Doctor actions remain subject to ADR:1659–1661: compatible prior pin only
before irreversible migration, no database downgrade/prune, and refusal of
storage upgrades without verified recovery material. SSH recovery is not an
exception to those safety conditions.

ADR:1696–1700 and design:1993–1997 retain quiescent lock acquisition, no
application deploy writes while held, maintenance if rollback becomes
necessary, and the existing rollback clock without reset. No closed upgrade
mechanism regressed under the fixed coordinator choice.

### R7-06 — CLOSED

ADR:978–990,1663 and design:P15/P31/P32 (:212,:228–229),1828 now define
one `release.yml` publisher/verifier identity and concrete internal routes.
Kustomize-controller and helm-controller fetch from the source-controller
Service in `flux-system` on TCP 80, forwarded to HTTP container port 9090.
The named minimum source-controller's Service/deployment source confirms
that mapping. P32 retains all Flux-controller API access after narrowing
P15 to source-controller. P17 supplies DNS. Registry/auth/blob/TUF/Rekor
HTTPS routes remain independent of application egress.

The two stated second-pass gaps are addressed. The actual installed
Flux/Cosign version pin, endpoint behavior and after-policy/restart/cache-loss
signed-fetch walks remain implementation acceptance work, not claimed passes.
N-8's obsolete row-count summary is a nonblocking correction below; the
required routes themselves are now explicit.

### R7-07 — CLOSED

ADR:1704–1706 and design:1829 retain separately authenticated root-policy
identity transitions, bounded overlap/retirement, fail-closed clean install,
existing-workload preservation and cache-loss refusal. Aligning the single
publisher identity does not weaken those transition/outage mechanisms.

### R7-08 — CLOSED

ADR:1708 and design:826–830,1830 retain both application namespaces' explicit
panic stop set, protected operator gate fields, platform leave-running set,
conflicting-upgrade pause and durable owner resume. Moving the two parents
into their target namespaces does not remove them from that contract.

### R7-09 — CLOSED

ADR:1382–1384 and design:1831 retain visible owner recovery and no second
init at the init-success/custody-write cut. F7/G3/N-19
(design:1843,1852,1902) remain **UNPROVED-IN-CI**. No VM delivery or safe-resume
runtime PASS is claimed.

### Round 6 regression check

All ten findings retain design-level closure:

- **R6-01 — CLOSED:** one rollback deadline, before-expiry resume,
  maintenance on expiry and owner-authorized recovery (ADR:792–796;
  design:G5 :1854).
- **R6-02 — CLOSED:** distinct non-admin task identity, account-authenticated
  minting, protected push/merge rules and accepted residual rights
  (ADR:1409; design:G2 :1851).
- **R6-03 — CLOSED:** durable intent, lost-response reconciliation,
  outcome/restart revocation, visible retries and unresolved-cleanup admission
  block remain at those credential/G2 contracts; no server expiry is claimed.
- **R6-04 — CLOSED:** exact Bao `update` grants, run-isolated binding,
  teardown/TTL and final post-webhook Pod validation remain
  (ADR:173–191; design:P12/P27 :209/:224).
- **R6-05 — CLOSED:** effective chart overrides, replacement/login checks
  and no deletion of live Secret references remain (ADR:1653;
  design:534–540,1825).
- **R6-06 — CLOSED:** platform-owned Gitea SQLite/PVC independent of shared
  CNPG, generation exclusions and migration-recovery prerequisite/refusal
  remain (ADR:1006–1020,1661).
- **R6-07 — CLOSED:** deferred paired backup, owner recovery on source
  identity/revision loss and no automatic reseed remain
  (ADR:1017–1020; design:1195–1200).
- **R6-08 — CLOSED:** candidate/deploy-ref separation, durable SHA/outcome
  deduplication and rollback precedence remain (ADR:493–499;
  design:G1 :1850).
- **R6-09 — CLOSED:** fixed restricted mirror listener, HTTPS/proxy wiring,
  no bus/store authority and non-gating failure remain
  (design:P26 :223/G4 :1853).
- **R6-10 — CLOSED:** sandbox P8/P24/P27 exceptions and owner UI versus
  internal authenticated Git distinctions remain (design:P24/P25/P27
  :221–224, N-8 :1889).

### Nonblocking summary corrections

- Design:N-8 (:1889) still requires exactly P1–P30, and the noun map (:1916)
  still says P1–P27. Include new P31/P32 in those summaries; keep the positive
  policy walks aligned with the now-explicit routes. ADR:193–197 still omits
  Flux from its exclusive outbound summary.
- Design:F7/G3 (:1843/:1852) and the phase summary (:545) still describe
  loader creation/addition of the source. Align them with platform-created
  local GitRepositories and loader-written credentials/Kustomizations.
- Design:F8 (:1844) still says operator unseal custody instead of loader
  custody (:1681); F4 (:1840) still lists policy among generation rollback
  examples, despite immutable platform policy/RBAC.
- ADR:620–621,819–820 retain parentless bootstrap-root summaries despite
  the explicit two-parent panic contract. R7-01's general/check summaries
  (ADR:1621; design:1823) still blanket-reject nested reconcilers; preserve
  the expressly permitted local HelmRelease edge.
- Exhaustive RBAC summaries must retain the explicit dynamic run/build
  provisioning exceptions and separate loader/applier identities. The
  specific lifecycle grants remain present; this is not a closed-item
  regression.

**Primary evidence:**
[Kubernetes admission scope](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/#what-are-they)
(reads bypass admission),
[Kubernetes RBAC resource restrictions](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#referring-to-resources),
[pinned Helm Secret storage driver](https://github.com/helm/helm/blob/v3.13.1/pkg/storage/driver/secrets.go)
(label-selected namespace listing),
[pinned Flux Kustomization impersonation](https://github.com/fluxcd/kustomize-controller/blob/v1.2.0/internal/controller/kustomization_controller.go),
[pinned HelmRelease source/storage API](https://github.com/fluxcd/helm-controller/blob/v0.37.0/api/v2beta2/helmrelease_types.go),
[source-controller Service](https://github.com/fluxcd/source-controller/blob/v1.2.0/config/manager/service.yaml)
and [HTTP container port](https://github.com/fluxcd/source-controller/blob/v1.2.0/config/manager/deployment.yaml).
These source pins establish the cited behavior, not a deployed version or
an acceptance run.

**NEW blocking findings:** none. No R7-10 is opened. The remaining storage
read-authorization failure belongs to R7-01. No CLOSED Round 6–7 finding
is reopened, and all fixed owner/coordinator decisions stand.


## Round 7 dispositions, fourth pass (2026-10-13)

- R7-01 — Fixed: HelmReleases use dedicated platform-owned release-storage namespaces with applier-only Secret RBAC; source-controller alone reads deploy credentials; lifecycle and denied target-namespace Secret checks remain unverified.


## Round 7 confirmation, fourth pass (2026-10-13)

**Verdict: PASS WITH COMMENTS.** R7-01 is CLOSED at design level. All
previously CLOSED Round 6–7 findings remain CLOSED. No NEW blocking finding
is opened. A superseded Secret-grant summary and earlier nonblocking summary
corrections remain; no runtime acceptance is claimed.

**Scope and method:** confirmation of `8ed0826..c619f53` against the
third-pass R7-01 gap and fourth-pass disposition. `ADR` means
`docs/adr/010-container-generations.md`; `design` means
`docs/features/instance/containers-design.md`. Line references are at
`c619f53`. Primary Flux/Kubernetes documentation and pinned Flux/Helm source
were read, not rendered or installed. One read-only, same-model assistant
independently checked CLOSED-item regressions. CLOSED means the written
mechanism addresses the finding, not that its proposed checks passed.

The coordinator's dedicated platform-owned Helm storage namespaces are
fixed, as are target-namespace Kustomizations/appliers/local sources,
loader-first A0, SSH `lifemodel doctor` recovery and the single `release.yml`
signing identity. No owner/coordinator decision is reopened. No builds,
tests, rendering, cluster/installer walks or automatic document-readiness
gate ran. No `br` operation or `.beads/` modification was made. Commit hooks
are bypassed because the commit-message path invokes `br`; the required
leaf-task link is retained. The ADR and design are not edited here.

### R7-01 — CLOSED

ADR:1626–1630,2024–2042 and design:173–178,187–188,253–255,525–529,1833
now separate Helm bookkeeping from target-namespace Secrets. Each
HelmRelease explicitly selects `lifemodel-releases` or
`lifemodel-motor-releases` through `spec.storageNamespace`. Its mandatory
same-target-namespace applier has Secret get/list/watch/create/update/delete
only in its corresponding storage namespace, via a platform-owned Role and
RoleBinding naming that ServiceAccount. Neither applier has Secret rights
in either working namespace. Source-controller reads the local deploy
credential under its own identity, not the applier identity.

This is an enforceable namespace boundary, not an admission read filter or
a client-selected label filter. Flux documents the separate storage namespace
and HelmRelease impersonation; Kubernetes binds a namespaced Role's rights
to a named ServiceAccount subject even when that account lives elsewhere.
Helm's label-selected Secret listing can operate within the dedicated
namespace without exposing working-namespace credentials. The platform owns
both storage namespaces, reserves them for release Secrets, runs no workloads
there and supplies default-deny policy. Generation-rendered objects/hooks
cannot target them or change their RBAC. Same-namespace source/reconciler
edges, fail-closed identity enforcement and immutable platform isolation
remain intact. The RoleBinding subject exception grants storage access;
it does not open cross-namespace Flux source references.

Design:1833 explicitly requires successful Helm install, upgrade, history
and cleanup under each real applier, plus denied non-release Secret get/list
in both working namespaces and denied deploy-credential access. These checks
remain implementation acceptance work. They have not run.

### CLOSED-item regression check

- **R7-02–09 — remain CLOSED:** the diff preserves loader-only custody and
  bootstrap grants, A0-first startup, Gitea's effective chart overrides and
  live-Secret retirement checks, root trust/pin exclusions, quiescent upgrade
  locking and SSH recovery, signed-fetch/artifact/API routes P15/P31/P32,
  identity-transition/outage behavior, the two-layer panic boundary and
  UNPROVED-IN-CI/visible-recovery limits. Storage grants give neither loader
  nor generation writers new platform administration rights.
- **R6-01–10 — remain CLOSED:** one rollback clock; distinct task identity;
  durable token cleanup; exact Bao grants and final Pod validation; chart and
  live-Secret safeguards; platform-owned Gitea SQLite/PVC and upgrade-recovery
  refusal; no automatic reseed; candidate/deploy separation; fixed mirror
  listener; and sandbox/owner-UI route distinctions remain unchanged.
  Dedicated storage namespaces add no workload or network allow path.
- N-8 and the noun map now include P31/P32 (design:1899,1926), resolving
  that prior row-count correction without weakening the network contract.

### Nonblocking comments

Design:1970–1974 still repeats the superseded target-local Secret grant and
admission-type read restriction in the second-pass decision summary. Align
it with ADR:1626–1628,2024–2034 and design:1833: no working-namespace Secret
rights, explicit dedicated `storageNamespace`, and namespace-scoped storage
RBAC. It is not an alternative authorization mechanism. Closure rests on
the fixed fourth-pass contract, not this obsolete paragraph. The remaining
third-pass summary corrections stand: ADR:193–197 omits Flux from the
exclusive outbound summary; design:F7/G3 and the bootstrap phase summary
still assign source creation to the loader; F8 retains operator unseal
custody and F4 includes policy rollback; ADR:620–621,819–820 retains
parentless-root wording; and broad operator-only/RBAC summaries must retain
the separate loader/applier and dynamic run/build exceptions. The P1–P32
row counts and expressly permitted HelmRelease edge are corrected by this
pass and are not outstanding comments.

**Primary evidence:**
[Flux storage namespace](https://fluxcd.io/flux/components/helm/helmreleases/#storage-namespace),
[HelmRelease impersonation](https://fluxcd.io/flux/components/helm/helmreleases/#service-account-reference),
[Kubernetes RoleBinding scope](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#rolebinding-and-clusterrolebinding)
and [ServiceAccount subjects](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#referring-to-subjects),
[pinned HelmRelease storage API](https://github.com/fluxcd/helm-controller/blob/v0.37.0/api/v2beta2/helmrelease_types.go),
[pinned Helm Secret listing](https://github.com/helm/helm/blob/v3.13.1/pkg/storage/driver/secrets.go),
and [source-controller credential reads](https://github.com/fluxcd/source-controller/blob/v1.2.0/internal/controller/gitrepository_controller.go)
(`getAuthOpts`/`getSecretData` use the controller client). These source pins
establish behavior, not a deployed version or an acceptance run.

**NEW blocking findings:** none. No R7-10 is opened. R7-01 is CLOSED and no
previously CLOSED finding is reopened.
