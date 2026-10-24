# ADR-010: Module containers for the instance (rewritten on k3s + GitOps)

Date: 2026-10-12 (rewritten 2026-10-12 on the owner's platform decision).

## Status

Task-specific proposed amendment (2026-10-20):
[ADR-014](014-task-runtime.md) records core-started Jobs, core-owned task
registry, two harnesses, task identity and two Stops; [ADR-015](015-storage-module.md)
records the separate platform storage module and retained SeaweedFS output.
Their named amendments replace this record's older Motor-specific ownership/
credential/output shape, not the unrelated rollout/bootstrap rules below.

Accepted 2026-10-13 by the owner's merge of PR #28 (295f067).

Proposed (rewritten 2026-10-13 on the owner's fixed two-layer GitOps
architecture, task lifemodel-b0r.9.16). The platform layer is installed
from a per-release signed OCI artifact through a signature-verifying Flux
OCIRepository; generations remain in the in-cluster Gitea deploy branch.
The clean-VM command installs only k3s, Flux and the pinned platform source.
The Flux-deployed loader performs resumable first-start custody and account
initialization, seeds the matching release into Gitea, and adds the second
Flux source for application generations. Gitea is a platform component,
not generation-managed, and upgrades only with an owner-commanded platform
version change. This milestone is dedicated-VM only; existing-cluster
installation is deferred to lifemodel-xc9. These decisions amend every
prior installer-owned Helm/bootstrap and existing-cluster path below; the
rejected options are recorded, not re-argued.

Everything that does not depend on Docker/Compose carries over unchanged:
the threat model, the bus and the AsyncAPI contract, keyed jobs (consumer
groups, XAUTOCLAIM, done records, `uncertain`, mandatory timeouts), schema
compatibility (AsyncAPI FULL, JSON Schema snapshot, dbmate + squawk), state
homes, the function host (workerd + Channel Adapter, bootstrap), the
ingress/egress-only rule, snapshot copies, the owner values, the health
window semantics, and the round-4 fixes that are not Docker-specific
(R4-02, R4-03, R4-04, R4-05, R4-07, R4-09, R4-11, R4-13, R4-14).

Supersedes the previous full text of this ADR (the post-simplification
rewrite of 2026-10-12, lifemodel-b0r.9.11's parent) and, through it, the
Compose/Docker direction of `docs/features/instance/generations-design.md`.
**Supersedes ADR-005 (LanceDB vector store):** the vector store moves to
Postgres with pgvector (charter: "Postgres with pgvector holds memory and
configuration"); ADR-005's local-ONNX embedder decision stands, only its
storage leg is superseded — now served by CloudNativePG.

Affects: docs/features/instance/containers-design.md (the views), the
future implementation stages of instance-1 outcome 5.

## Amendment: zot workbench delivery (2026-10-24)

The owner chose **password-protected zot, then TLS** on 2026-10-19
(lifemodel-pwe: “zot по паролю, но потом TLS”), and moved zot into the
current task workbench delivery on 2026-10-24 (lifemodel-653.8.13:
“Ну это же глупость. Подними zot сейчас” / “Да, давай”). This closes
question 4 below: zot replaces `registry:2`, not a second registry beside it.
TLS remains lifemodel-pwe.2. The interim trusted single-node network uses
plain HTTP, anonymous pull, and one password-authenticated push identity.

The immutable task repository is
`zot.lifemodel-system.svc:5001/lifemodel/workbench`. In-cluster pushers resolve
the Service name. The installer writes the same authority into k3s
`registries.yaml`, resolving it to `http://10.43.0.51:5001`, zot's fixed
ClusterIP in the explicitly pinned `10.43.0.0/16` service CIDR. Containerd
uses node kube-proxy routing, not cluster DNS; default registry endpoint
fallback is disabled. This is node-local delivery on the sole node, without
an externally exposed hostPort or a Pod Security exception. It does not use
port 5000 (the disposable VM walk's platform-artifact registry).

zot v2.1.22 is the current upstream stable main line at implementation
(2026-10-06 release), pinned by its OCI index digest in platform step A.
It has one retained local-path PVC; GC and dedupe retain upstream defaults.
A0 precreates its htpasswd Secret. After Bao policy handoff the loader stores
one random 256-bit `loader` password in OpenBao, verifies its read-back,
and projects only a bcrypt hash to zot. No task or node receives that
password. Anonymous authorization grants `read` only; the one push user is
restricted to the workbench repository. Default-deny and zot ingress admit
only loader pods; node-origin traffic uses Kubernetes' node-network exception.
Future pwe builder admission is a commented slot, not a permission today.

Final step order stays **instance → A0 → A → B → C → D**. Zot waits only
for its A0 Secret to be filled by the post-Bao custody phase, not Gitea or
SQL. First-start order after Bao init/unseal/policy is **Seaweed custody →
zot custody → workbench import → Gitea bootstrap/application sources →
Postgres credential copy → Valkey credential copy**. Application sources
are not created before a verified import, so core cannot start tasks before
that boundary. No phase waiting on C is moved in front of A's readiness.

The release still publishes the workbench to its public digest-pinned origin.
Before creating application sources, the loader copies the exact manifest,
index, config and layer bytes into zot, verifies SHA-256 on both sides, and
keeps the original release digest. Existing verified objects are resume keys.
A failed/mismatched/unreachable import retries with safe codes; there is no
public-origin fallback in the Job path. Import requests have deadlines and
size/count bounds; temporary bytes use the loader's disk-backed volume.
The dedicated import egress policy is enabled only around the phase and reset
on process restart. Kubernetes policies are additive: the pre-existing loader
public-model-check grant also reaches public HTTPS. Therefore fixed-origin
application validation, not DNS filtering by NetworkPolicy, confines import
requests. A kill can leave the dedicated grant until restart resets it.

k3s, Flux, zot itself and the loader remain release-pinned bootstrap images
outside zot. Serving core/web/loader/gateway, air-gap installation, and in-cluster
build/push credentials are not part of this amendment. Future pwe builds use
the same zot, with their own least-privilege identity and explicit network row.

## Open questions for the owner

The eight decision points of the morning, the six simplification points
plus the values, and the platform decision are decided. What remains, to be
measured or confirmed before outcome 5 implementation (every one a setting
or a measurement; none changes a mechanism below):

1. **The egress gateway's `terminationGracePeriodSeconds` target.** The
   owner fixed the rule ("target 300 s, to measure") and the invariant
   (grace >= the module's longest declared sync call timeout — a build
   check, simplification point 2); the MEASUREMENT of the longest realistic
   call sets the actual value. Proposed target: 300 s, rendered as the
   pod-field integer `300` (R5-11's unit rule). Motor's grace
   follows its run limit (an existing runtime setting); every other module
   30 s (rendered `30`).
2. **XAUTOCLAIM min-idle default.** Must sit ABOVE every module's
   declared delivery-to-result bound (a live-but-slow old pod must not
   have entries stolen mid-run); the exact default is an operator setting
   named at outcome-5 implementation.
3. **The Windmill vs Temporal vs own-executor research** (owner,
   2026-10-12): filed BEFORE outcome 6 is designed, not blocking this
   milestone. The job mechanics here (consumer groups + XAUTOCLAIM + done
   records) are deliberately plain so the research can move them wholesale
   to a dedicated engine without touching the core.
4. **The local registry — CLOSED (owner, 2026-10-19 and 2026-10-24).**
   zot, password push from OpenBao, anonymous node pull, interim plain HTTP.
   The amendment above records the stable node/pusher endpoint, one retained
   volume, bootstrap order and the separate TLS task. Persistence/recovery
   remains separately checked from cold-node image delivery (R5-08).
5. **The deploy branch's shape and home — CLOSED (owner, 2026-10-13,
   "Gitea").** The deploy branch is a branch of the SAME repository, held
   by an internal Gitea running in the cluster. The operator is the only
   writer of `main` and of the deploy branch (both protected branches in
   Gitea); Flux reads the deploy branch with a read-only credential;
   self-change tasks clone from Gitea, push `task/*` branches and open
   pull requests; the operator merges after the gates. An optional push
   mirror to an outside remote is the owner's setting, off by default
   (Gitea mirror documentation: https://docs.gitea.com/usage/repository/repo-mirror/).
   The remaining question is the mirror's TARGET remote, an owner setting
   at implementation.
6. **The build budget on k3s.** The Compose shape carried
   `buildTimeoutMs` 20 minutes (loader/src/config.ts:174); the in-cluster
   BuildKit build of one module inside the cluster's 2-CPU envelope needs
   its own measurement. The rule carries: the operator refuses a build that
   writes no image.
7. **VM delivery acceptance (owner, 2026-10-13).** The supported shapes
   are NixOS first, through the repository flake's `services.lifemodel`
   module (`nixos-rebuild switch`), and generic Linux (Ubuntu/Debian), through
   `scripts/install.sh`. Both install only k3s with embedded etcd, pinned
   Flux, and the root OCIRepository plus platform Kustomization, rendered
   from the same `deploy/root/` templates (byte-equal, checked by
   `nix flake check`). The coordinator performs the end-to-end
   `generations/clean-vm-install` manual acceptance check over SSH on
   owner-provided test VMs: NixOS first, then Ubuntu for the script. The
   owner restores each VM's clean hypervisor snapshot before the
   from-scratch check. This is not a CI walk or a k3d delivery walk;
   k3d remains for dev/CI cluster-mechanics checks. Existing-cluster
   installation and its `helm install` walk are removed from this milestone
   and deferred to lifemodel-xc9.

The migration tool is NOT open: simplification point 5 picks dbmate +
squawk. The core stop deadline is NOT open: the values fix 5 s
(`LIFEMODEL_CORE_STOP_DEADLINE_MS`). The platform is NOT open: k3s + Flux +
CNPG + Traefik + OpenBao chart are the owner's choices, 19:32 UTC; the
git server is NOT open: Gitea in the cluster, the owner's choice,
2026-10-13. Gitea Issues is NOT the work tracker — the tracker is a
separate owner decision.

## Context and problem

The instance's code is a git repository; a self-change is a commit that
becomes a new generation of lifemodel (charter "Delivery"; inventory row
20). The owner has fixed the shape (docs/charters/instance-1.md
"Generations as containers"): the instance runs as containers on a
platform that supports readiness and liveness probes, an epoch switch, a
health window measured in completed work, rollback with a report, and
maintenance mode. Valkey holds the event bus (streams) and ONE current
tick snapshot, committed atomically with an epoch check, flushed to disk
on every write. Postgres with pgvector holds memory and configuration —
now as a CloudNativePG cluster. OpenBao issues credentials (the
Bank-Vaults secrets webhook wrapping each module container with
vault-env, Kubernetes auth). The tick is the only boundary for async
results. The channel of this milestone is a web interface; Telegram is
out.

The shape was decided in three passes on 2026-10-12, each amending the
last:

- **Owner review, points 1-8 (07:33-08:13).** Generation = commit;
  per-module images tagged by build-input hash; no down migrations;
  keyed jobs; state homes; networks instead of mTLS; OpenBao per-module
  roles; AsyncAPI FULL compatibility.
- **Simplification review, points 0-6 (15:47-16:39).** The threat model
  (trusted against malice, not bugs); per-module replacement; no executor
  module; schema-file compatibility checks instead of reader runs; copies
  only at core replacement; the values.
- **Platform decision (19:32).** k3s + GitOps instead of Docker/Compose:
  the desired state lives in the deploy branch, Flux applies it, and the
  loader becomes a GENERATION OPERATOR running in the cluster with RBAC
  rights — it sees a new lifemodel commit, runs the checks and the
  in-cluster BuildKit builds, writes new tags to the deploy branch,
  computes the completed-work health window, rolls back via git, holds
  maintenance mode, panic, and the owner's web UI/login.

Today nothing exists to migrate: greenfield (inventory 1). The FACTs of
absence remain the problem statement: the running process builds dist/ in
place (overwriting the running tree); lifemodel's mutable state is JSON
files with no inter-process safety (two writers clobber whole documents);
there are no probes, health window or maintenance mode anywhere. Running a
second generation against that stack would corrupt it.

## Threat model (simplification point 0, carried on k3s)

Module code is trusted against MALICE, not against BUGS (the owner's
words, simplification point 0: written by us or by lifemodel itself). We
defend against a broken generation — crash, hang, corrupting data by
mistake, writing what the predecessor cannot read. We do NOT defend
against a module deliberately bypassing rules.

Kept, because they are cheap structural barriers against MISTAKES:

- **RBAC instead of socket proxies:** the generation operator is the only
  workload with cluster mutation rights (lifemodel deployments and
  statefulsets, leases, rollout records, HelmRelease suspend/resume, the
  migration Job in `lifemodel-state`, and the DISPOSABLE BUILD WORKLOADS —
  build Jobs and their pods and build resources, narrowly in
  `lifemodel-system` only — R5-07); Motor holds RBAC rights ONLY on Jobs
  in its own namespace. For per-run Bao bindings, the generation operator
  is the sole provisioning actor: its namespace-scoped role creates/gets/
  deletes only `run-*` ServiceAccounts in `lifemodel-motor`, and a
  ValidatingAdmissionPolicy (RBAC cannot constrain create by name prefix)
  admits only operator-created `run-*` ServiceAccounts with zero bindings.
  Its OpenBao ACL grants `create`, `update`, and `delete` only on
  `auth/kubernetes/role/run-*`, `sys/policies/acl/run-*`, and each exact
  per-run KV value path; it has no `list`/`read` on parent paths and no
  module-secret access. OpenBao writes ACL policies through the API's
  `UpdateOperation`, including when creating a new policy
  ([ACL policy API](https://openbao.org/docs/api/system/policies/); pinned
  source: [logical_system_paths.go, UpdateOperation](https://github.com/openbao/openbao/blob/ad64d389cb66023521c4228dc9f1149400d87351/internal/vault/logical_system_paths.go#L3880-L3888)),
  so `update` is required alongside `create` and `delete`. Each run role sets
  `token_ttl` and `token_max_ttl` no longer than that run's limit. The same
  durable issuance record as the task token drives teardown on every outcome
  and after crashes. The Bank-Vaults webhook mutates Pods, including sandbox
  Pods, not Jobs: retain Job-template validation and add a Pod
  ValidatingAdmissionPolicy in `lifemodel-motor` that validates the final
  mutated Pod against those same run, resource, deadline and volume rules
  (R5-09); no module holds cluster-admin or any Docker equivalent;
- **NetworkPolicy default-deny:** every namespace denies egress by
  default; a module cannot casually reach Agent Vault, the operator, or
  the registry — only the policy rows below open routes (the pods that
  leave the cluster are exactly the named rows: the egress gateway, the
  BuildKit build pods and Agent Vault's own leg, R5-05);
- Agent Vault reachable only through the egress path's last hop (the
  vault policy rows), never from a module directly;
- per-module Postgres credential on its own schema only — the schema
  containment is the SQL GRANTS, not the role declaration (R5-16): CNPG
  declaratively manages the module's NOLOGIN group role, the migration
  set owns the GRANT/ALTER DEFAULT PRIVILEGES SQL that scopes it to its
  schema, and OpenBao's per-module role logs in as a leased LOGIN user
  that INHERITS it;
- per-role Valkey ACL, snapshot writes through an epoch check — a stale
  snapshot write is refused, not evaluated for intent.

Dropped, because they defend against deliberate bypass (unchanged from
point 0; the platform does not re-add them):

- mTLS workload identity / SPIFFE certificates between modules (simplification
  point 3 — NetworkPolicy + RBAC replace the Docker-network barrier and
  stay mistake-scoped);
- the Valkey commit-fence module and commit gateway (the Lua epoch check
  itself STAYS — see A2);
- grace capabilities, i.e. switch-time allowlist-scoped completion
  credentials (the per-module strategy makes the surface unnecessary);
- admission records binding check results to image tags (point 5);
- throwaway Postgres reader runs against candidate-written data (point 5);
- the snapshot+PG stamp pair with per-switch capture (point 6);
- HTTP control endpoints on modules (`/activate`/`/drain`, `:7400/grant`);

Invalidator: when modules come from foreign sources (third-party plugins),
or scale to several machines, this model is no longer the shared premise
and the dropped candidates are re-evaluated — that revisit is a design
action, not a patch.

## Owner values (decided 2026-10-12; every value is a Kubernetes field or an operator setting)

Simplification point "values", 16:39 UTC, translated to the platform's
fields, plus the points these came from:

1. Core stop deadline `coreStopDeadlineMs`: 5 s (finish tick + commit
   snapshot), then a forced stop; the unfinished tick re-runs by key.
   Setting `LIFEMODEL_CORE_STOP_DEADLINE_MS`, default 5 000, integer, ms.
   The core pod's `terminationGracePeriodSeconds` is set to cover it:
   grace >= `coreStopDeadlineMs` (a pod killed at its grace point is the
   forced stop the deadline names).
2. `terminationGracePeriodSeconds` per module (the pod field; replaces
   Compose `stop_grace_period` — platform decision): set per module in the
   chart, RENDERED IN SECONDS — the field is `terminationGracePeriod`-
   `Seconds`, so the chart's value is the ms input converted once, in one
   reviewed place, with the rounding stated (ms/1 000, rounded UP — grace
   never renders shorter than the deadline it covers) (R5-11). Egress
   gateway >= its longest declared sync call timeout — proposed target
   300 s (rendered `300`), MEASURED down to the longest realistic call
   ("target 300 s, to measure"); Motor >= its run limit; every other
   module 30 s (rendered `30`). The egress value is justified by the
   build-check invariant (grace >= the longest declared timeout, both
   sides converted to the same unit BEFORE the comparison — a same-unit-
   looking inequality never hides a bad conversion, R5-11), not by the
   number.
3. OpenBao lease max TTL: 7 days (`LIFEMODEL_LEASE_MAX_TTL`, days). A
   credential CHANGE restarts a module pod; a renewal does not.
4. Snapshot copies retained: 3 (`LIFEMODEL_SNAPSHOT_COPY_RETENTION`;
   DECIDED — not an open question).
5. Health window: 120 000 ms (`LIFEMODEL_HEALTH_WINDOW_MS`), with
   `LIFEMODEL_FIRST_COMMIT_DEADLINE_MS` 30 000 < window. Unchanged. The
   operator computes it from completed work (done records), not from
   probe liveness — the charter's definition survives the platform move.
6. Failed-commit count to open maintenance: 2
   (`LIFEMODEL_MAX_FAILED_GENERATIONS`). Unchanged.
7. `readinessProbeIntervalMs` 2 000, `readinessWindowMs` 60 000 (R3-13's
   named multiple is 30x interval, kept — the readiness rules are
   unchanged by the platform move). The pod's Kubernetes readiness probe
   interval is derived from the first; the operator's readiness WINDOW is
   the gate for "a module that never becomes ready"; the same window
   bounds the STARTUP probe's allowance (R5-15) — liveness (the core's
   15 s last-commit gap) begins counting only after activation, never
   during the bounded initialization it would cut short.
8. XAUTOCLAIM min-idle: above every module's declared delivery-to-result
   bound (queue wait + sync call + parked correlation wait), not merely
   its stop grace; the exact default an operator setting. Min-idle is the
   CRASH-takeover trigger, NOT a live-consumer fence (R4-02): reclaim
   from a RETIRING pod is authorized by its CONFIRMED pod termination,
   not by idle. The job rules themselves are pure consumer-group
   semantics, no tuning parameter of their own.

## Decision drivers

Functional requirements F1-F7 and quality scenarios Q1-Q13 are stated with
measures in docs/features/instance/containers-inventory.md sections 3-4;
they are cited by number and not re-argued. The strongest, with the
owner's 2026-10-12 amendments named inline:

- **Threat model (point 0) is the FIRST driver**, ahead of the functional
  list: every mechanism below is measured against "defends against a
  broken generation", and anything that only pays for the deliberate-bypass
  case was removed. This is why the rejected-option list below is long.
- **F1/F2** (a container beside the running one; readiness before the
  switch) and **F3** (the conversation continues from the snapshot, no
  message lost, none answered twice) force the per-module rollout
  machinery, the confirmed pod termination of the stop-first writers and
  the snapshot contract (Q1, Q7). The unit is the MODULE: the operator
  replaces only the modules whose image tag changed, ONE by ONE in
  manifest order; the core's stop-first replacement IS the epoch switch
  point.
- **F4** (an unhealthy generation replaced by the previous healthy one,
  with a report) forces the health window and the durable report (Q3).
  The window starts after ALL changed modules of the commit are replaced,
  and per-module readiness is the gate.
- **F5** (maintenance boot of an older generation within the compatibility
  window; older ones refuse with the reason) unchanged; the
  schema-version refusal mechanics carry (Q8).
- **F6** (migrations) unchanged in substance: expand/contract, no down
  migrations; the "predecessor reads everything I write" check runs on
  SCHEMAS (AsyncAPI/JSON Schema compared at every rollout between the
  running commit and the candidate; Postgres migrations linted by squawk).
- **F7** (one clean-VM command, no key in lifemodel's process, panic
  across restarts) AMENDED 2026-10-13: the command installs only k3s, Flux
  and the verified signed platform OCI source. Flux deploys the platform,
  including the loader and Gitea. On its first start, the loader runs an
  idempotent, durable, resumable initialization: initialize/unseal OpenBao
  and establish custody; create the Gitea administrator through the chart's
  supported initial-admin mechanism; seed the repository from the same
  pinned release; protect branches; create Flux's read-only credential; and
  add the application-layer Flux source. Gitea chart 12.7.0 supports
  `gitea.admin.existingSecret` and `passwordMode: initialOnlyNoReset`
  (`values.yaml` and `templates/gitea/init.yaml` in the official chart
  package: https://dl.gitea.com/charts/gitea-12.7.0.tgz). The loader creates
  the referenced Secret and retains it for as long as any rendered chart
  object references it (R6-05); it does not delete a live reference. The
  first generation follows only after the second source is healthy. Gitea
  uses SQLite on its own PVC. Platform upgrades are owner-commanded pin
  changes; generation candidates cannot change Gitea or other platform
  objects. Existing-cluster install is deferred to lifemodel-xc9. The no-key
  guarantee carries (OpenBao per-module roles, vault-env via the
  Bank-Vaults secrets webhook); panic semantics carry, now durable as Flux
  suspend + scale to zero.
- **Q1** (bounded switch pause), **Q4** (crash mid-tick: at most one
  replay), **Q7** (zero accepted stale writes), **Q13** (the tick is the
  only boundary) unchanged as drivers; their mechanisms are the same on
  k3s.
- **Q9** (Docker access confined) AMENDED, platform decision: no Docker
  socket, CLI or DOCKER_HOST exists anywhere in the cluster; the platform
  access control is RBAC — the operator's rights (build workloads
  included, R5-07) and Motor's Jobs-in-its-namespace rights are the whole
  surface; Motor's Job templates are additionally constrained by PSA
  restricted + a ValidatingAdmissionPolicy, since RBAC authorizes the
  verb, not the fields (R5-09). Q8's network leg is now
  NetworkPolicy (default-deny egress, the platform's own traffic named —
  R5-05).
- **Q11** stays a measurement, not a constraint: dev-machine limits are
  NOT design drivers; the two-generation (and two-pod) overlap is measured
  in the test environment.
- Constraints (inventory section 5): the 19-case first-start fixture
  (tests/integration/instance-first-start.test.ts) was the accepted outcome-4
  walk. Amended 2026-10-14 (owner, lifemodel-avy): the docker-run instance
  image and this fixture are removed; outcome 4 is re-walked on the k3s shape
  by the manual clean-VM check. Design principles carry (signals not events; restart-safe
  scheduling; plugin isolation; no backward-compat shims; no
  attribute-prefix routing).

## Assumptions this decision rests on (each with what invalidates it)

- **A1 — the repo's manifests are expressive enough, and launch semantics
  live in Git.** The repo declares, per module, its build (context +
  Dockerfile) AND its application-owned workload (the Helm chart: image,
  probes, `terminationGracePeriodSeconds`, strategy). NetworkPolicy and RBAC
  are platform-owned and never appear in generation authority or rollback. The
  operator derives what it needs (call manifest, delivery-to-result
  bound, rollout order) from the chart's values/annotations, never from
  code introspection. Invalidated if a module needs a workload property
  the chart cannot carry: the chart grows — a change in the repo, not a
  fork of the format.
- **A2 — one node, one writer: a confirmed pod termination is a fence.**
  There is exactly one machine (k3s single node), so for every singleton
  state writer the old pod is TERMINATED before the new one starts
  (stop-first) and no foreign writer exists on the store. The Valkey Lua
  epoch check stays anyway as a cheap guard against OPERATOR bugs (the
  Kubernetes controllers themselves could crash-loop two writers into
  existence without it), not against pod-level writers. Invalidated by
  modules spanning several machines, where two live writers can legally
  exist at a switch: fencing returns then — the owner said so explicitly
  — and the closed-apply barrier across Valkey and Postgres that was
  dropped here becomes required again (rejected option O2-B).
- **A3 — trusted against malice (point 0).** Module code is ours in
  substance (we committed it, or the agent that wrote it committed inside
  a walk whose gates, checks and reviews the owner runs). The design
  accounts for MISTAKEN access — contained to one store, refused by the
  role, unreachable by policy — not for deliberate bypass. Invalidated by
  any module from a foreign source (third-party plugin code): the threat
  model then re-opens and the dropped defences are re-evaluated (point
  0's named invalidator).
- **A4 — no streaming.** No model call, tool call or page fetch in this
  milestone returns a stream; every external call is a request/response
  the egress gateway can hold, cut and report. Invalidated by a streaming
  protocol arriving later: the stream leg becomes a per-destination
  question at the gateway, not a core redesign.
- **A5 — the Bank-Vaults secrets webhook with vault-env and OpenBao
  Kubernetes auth behaves on k3s.** Each module pod authenticates with
  its Kubernetes service account (JWT, no wrapped AppRole secret-id to
  deliver), and vault-env — placed in the container by the webhook's
  mutating admission — is the process's PARENT: it resolves the pod's
  secret references into environment variables and execs the module
  process. Invalidated by a webhook, vault-env or auth-method gap on
  the deployed versions: the fallback is operator-injected environment
  (visible to anyone who can read the pod spec) — a recorded posture
  downgrade, never a silent one.
- **A6 — Postgres serves conversational state at personal scale**
  (CloudNativePG, pgvector). Invalidated at a 10x conversation size
  making JSONB rewrite latency visible in ticks; partition then.
- **A7 — consumer-group job semantics hold on the wired Valkey engine.**
  XAUTOCLAIM with min-idle-time, PEL idle semantics and XACK behave as
  documented on the engine version the chart pins; this IS the takeover
  surface now. Invalidated by an engine change in these semantics: a
  deeper break re-opens the standalone claim machinery — recorded, not
  silent.
- **A8 — probe and health truthfulness.** "Ready" is read from the pod's
  readiness probe, and the readiness predicate is the ONE COHERENT
  startup contract (R5-15): bootstrap state complete AND the consumer-
  group join observed before Ready; liveness is gated behind a startup
  probe sized to the initialization bound, so the strategies and the
  kubelet act on the same signal at the same time; the health window
  reads completed work (done records), not probes.
  Invalidated if a module's probe can pass while its work is wedged — the
  module then needs a work-counting probe (the R3-12 rule carries into
  the Checks, plus R4-03's aged-demand wedge predicate — a consumer
  wedged SILENTLY, producing neither successes nor failures, fails the
  window on its aged outstanding demand). A module whose declared
  delivery-to-result bound exceeds `healthWindowMs` extends the window to
  that bound (R4-03; the design states the extension, N-16 walks it).
- **A9 — one synchronous answer per adapter delivery is enough for a
  function module** (R3-10, kept). A function answers synchronously
  inside the adapter's HTTP round trip; anything longer is a command
  event (Q2 rule) or a correlated two-invocation round trip. Invalidated
  by a function whose logic genuinely needs seconds-long state flowing
  between its answers: such logic moves INTO the owning module's
  keyed-command applier; the seam is the adapter contract.
- **A10 — input-hash image tags collide only when the inputs are equal.**
  The tag hashes the module's canonical build identity (context tree id,
  Dockerfile path and content, named additional contexts, admitted build
  options). Invalidated only by a hash collision — practically none.
- **A11 — the point-5 schema check is reproducible at any rollout**, even
  when every image is reused, because it reads FILES (schemas, migrations,
  manifests) from the running and candidate commits, not data. Invalidated
  if a needed property cannot be seen in files at all: the owner's rule is
  then "a new meaning = a new column, caught by review" and the residual
  risk is carried by the health window — named here so it is a decision,
  not an oversight.
- **A12 — Kubernetes rollout and StatefulSet semantics are honored by the
  deployed k3s.** Deployment RollingUpdate (maxSurge 1 /
  maxUnavailable 0) and — for the core — one-replica STATEFULSET
  semantics behave as documented on the pinned k3s version (R5-03): a
  StatefulSet creates no replacement pod before the previous pod's
  termination is fully observed by the kubelet, readiness gates a
  RollingUpdate's surge, and the operator can OBSERVE confirmed pod
  termination (not assume it). Recreate is NOT relied on anywhere (its
  upgrade-only wait is the stateful rejection of O2-M). Invalidated by a
  platform drift (a k3s/Kubernetes version change in these semantics):
  the behavior is re-proved in the acceptance walk, and a drift re-opens
  the fencing question (A2) as a design action.
- **A13 — privileged-free.** No pod in the design needs
  `privileged: true`, a host mount of cluster state, or the Docker/Kube
  socket: builds run in rootless BuildKit pods, Motor sandboxes are
  Kubernetes Jobs under RBAC, credential delivery is a mutating webhook
  (the Bank-Vaults secrets webhook). This
  is why k3s-in-Docker was refused by the owner (a privileged container)
  and why the shape holds on a clean VM. Invalidated by a needed
  component demanding privilege — a design action to re-shape it, never
  a silent grant.

## Considered options

Options are named patterns, evaluated on steady state, failure, security
and operability against the drivers. Per question, one option carries the
decision and the scenario set it serves; the rejected ones keep their
reasons. The mechanisms the platform decision replaced are REJECTED
options, marked "rejected by the owner, 2026-10-12 (platform decision)",
with the owner's reason; the mechanisms earlier decisions removed keep
their original rejection marks.

### Q1 — how code becomes a module image

**Decided (owner point 1, carried onto k3s by the platform decision; the
repository's home named by the owner, 2026-10-13, "Gitea"): the source
repository lives in an internal Gitea running in the cluster; a
generation = a commit = the GitOps desired state; the repo declares each
module's build (build context + Dockerfile) and its workload (the Helm
chart); the GENERATION OPERATOR watches that Gitea repository, builds
each module image IN-CLUSTER with
BuildKit into the LOCAL REGISTRY — creating the disposable build
workloads under its NARROWLY NAMESPACED build rights (a build Job and its
pod in `lifemodel-system` ONLY, R5-07) — and tags it with the hash of the
module's build inputs; an unchanged module is NOT rebuilt; the operator
writes the new tags to the deploy branch (with the commit's chart/values
launch change, if any), and Flux applies them. The operator watches the
Gitea repository by POLL, not webhook: a webhook needs Gitea to reach the
operator over the cluster network and a second, deliverable notification
path to stay correct when a hook is lost, while the operator already
polls for its other duties on the sole node — a missed poll
self-corrects on the next one, and "the deploy branch is ahead of the
cluster" is exactly the drift GitOps already reconciles. Candidate events
come only from `main`/PR refs; deploy refs are reconciliation inputs, never
candidate events. A configured poll interval is separate from the rollback
clock. Selection deduplicates by durable source SHA and outcome, waits behind
any active rollback, and retries a refused SHA only after explicit owner
authorization or a new SHA. Polling after revert or operator restart cannot
reapply the failed SHA.**

The build declaration describes, per module, its build context and
Dockerfile — and nothing of its launch: the launch shape (probes, grace,
strategy, network policy, RBAC) lives in the Helm chart in the same
commit, and Flux is the only applier. The operator builds each module
image with BuildKit inside the cluster — a rootless BuildKit pod with NO
cluster mutation rights, normal network — pushing to
zot with a scoped push identity supplied from OpenBao in pwe. This amends
the earlier “NO credentials” wording: password push requires a registry
credential, never a cluster-mutation or module credential. The image tag is the hash of the module's CANONICAL
BUILD IDENTITY — the git tree id of the build context, the selected
Dockerfile's path and content, each named additional context's name and
tree id, and the admitted build options (the R3-18 rule, kept) — so an
unchanged module resolves to its previous tag and builds zero times. Base
images are pinned by digest; the operator passes no build args. Checks
are a build stage: the compatibility checks (bus FULL compatibility, the
predecessor-reads-my-schema rules, squawk's expanding-only migration
lint, the call-manifest timeout/class check — Q8) run inside the build,
and a failed check fails the build before any tag is written. The
operator then writes the changed tags into the deploy branch's chart
values (with any chart/values launch change the commit carries); Flux
reconciles the cluster toward that commit — the deploy branch it reads
from Gitea with a read-only credential (owner, 2026-10-13, "Gitea";
Flux GitRepository auth: SSH deploy keys and token auth are both
supported, https://fluxcd.io/flux/components/source/gitrepositories/). The REGISTRY is a node-image-
pull mechanism, not only a push target (R5-08): it runs at a STABLE
endpoint resolvable from BOTH the build pods and the NODE's containerd —
the kubelet pulls from the node network, never from a module pod's DNS
or policy context — and the one-command installer writes the node's
trust for that endpoint (`registries.yaml` carrying the TLS trust, or
plain HTTP on a node-local address on the single-node deployment — the
lighter option, no certificate machinery) BEFORE the first module pod is
scheduled; a cold containerd pull on a rebooted node with NO preloaded
module images is the acceptance proof (Q12's walk), and the registry
volume's persistence/recovery is recorded and checked separately from
image delivery. Point 1's
per-module replacement is thereby a precondition the build already
satisfies: per-module images with input-hash tags are the unit Flux
rolls.

Serves: F1/F2 — a candidate module's readiness no longer contains an
npm ci (the build is before readiness); Q12 — build time is proportional
to the modules a commit changes; Q11 as amended — image churn is bounded
by module-change rate and measured, not assumed.

| Option | Pattern | Evaluation | Verdict |
|---|---|---|---|
| **O1-2026: commit -> per-module images built by the OPERATOR in-cluster (BuildKit, local registry, input-hash tags); workload declared in the repo's Helm chart; Flux applies the deploy branch (the commit's full desired state: tags AND chart/values launch change — R5-10)** | Phoenix/immutable-server taken literally; twelve-factor build once per changed input; content-addressed artifacts; GitOps as the delivery | Steady state: the chart IS the topology and the desired state; the operator's build is a pure function of (commit, module) — same inputs, same tag, no build. Failure: a broken build refuses before any tag is written (checks are a build stage); the running set is untouched by construction. Security: no credentials inside the build pod; base images digest-pinned; the operator is the only writer of the deploy branch. Operability: unchanged module = zero build work; `kubectl get` + Flux status IS the state. | **Chosen** |
| **O1-2026c: the same build done by the LOADER on the host with docker build, per the pre-platform decision (Compose subset, socket proxy)** | the simplified Compose shape | Rejected by the owner, 2026-10-12 (platform decision): "better to switch to k3s now than suffer with Docker"; the build moves in-cluster with the operator, the Compose subset becomes the Helm chart. | Rejected by the owner, 2026-10-12 (platform decision) |
| **O1-CI: host-side CI builds and pushes to an external registry; the operator only writes tags** | classic CI/CD | Rejected (platform decision consequences): the one-command clean-VM path has no host CI in it, and an external registry adds a dependency and credentials the platform decision avoids with a local registry; the in-cluster build keeps the self-change loop entirely inside the instance's own boundary. | Rejected |
| **O1-A: one runtime image; sealed per-commit release tree mounted read-only** | twelve-factor release tree; Capistrano releases directory | Stores build OUTPUTS instead of images; npm ci inside the build path with no reuse across commits; cannot express per-module artifacts or reuse by hash; a single same-for-everyone artifact is the wrong unit once modules deploy separately. | Rejected (superseded by the owner, 2026-10-12) |
| **O1-B: one per-generation image built by the operator from the commit** | immutable server taken literally | Right direction, wrong grain: a self-change touching one plugin would rebuild one generation-wide image. Per-module images with input-hash tags keep churn bounded AND give the per-module rollout its unit. | Rejected (superseded by the owner's per-module pick) |
| **O1-C: shared mutable tree — modules run from the volume repo as today** | status quo | The build overwrites the running tree; two writers on one tree hit the no-inter-process-safety FACT; unsealed code is rewriteable by the process running it. | Rejected |
| **O1-D: the candidate builds itself at boot (init container in the new pod)** | Kubernetes init container | The build sits inside the readiness window (Q2's bounded time-to-declared-failed) and broken code builds itself with broken tooling; the build belongs to the operator's controlled stage — checks included. | Rejected |
| **O1-E: admission records — check results re-run per switch and recorded per image tag** | cached build outputs vs re-verification; the round-3 answer to R3-06 | Rejected by the owner, 2026-10-12 (simplification point 5): compatibility is checked on SCHEMAS — the schema and migration FILES of the running commit compared with the candidate's at EVERY rollout, even when all images are reused — bound to the COMMIT PAIR, not to the image. | Rejected by the owner, 2026-10-12 (simplification point 5) |
| **O1-F: throwaway Postgres reader runs against candidate-written data** | consumer-driven contract testing on real data | Rejected by the owner, 2026-10-12 (simplification point 5): schema compare + squawk replace the runs; a column's meaning never changes; a new meaning = a new column. Semantic drift beyond schemas is caught by review and the health window — a named, accepted residual (A11). | Rejected by the owner, 2026-10-12 (simplification point 5) |

### Q2 — the replacement protocol: per-module strategies and fencing

**Decided (simplification point 1, carried onto k3s by the platform
decision): the unit of replacement is the MODULE, not the generation.**
The generation is the commit = the DESIRED STATE in the deploy branch
(like a Deployment revision); Flux applies it and the GENERATION OPERATOR
is the controller that observes, gates and rolls back — it replaces only
the modules whose image tag changed, unchanged modules are not touched.
The strategy is the Kubernetes workload type and update strategy:

- **START-FIRST (Deployment, RollingUpdate maxSurge 1 / maxUnavailable
  0)** — for modules whose writes are keyed consumers (intake, functions/
  adapter, ingress, egress gateway): the new pod starts, and its ONE
  COHERENT readiness predicate (R5-15) is: required bootstrap state
  complete (stores reachable, the adapter its full read set) AND its
  consumer-group JOIN observed — Ready becomes true only after the join,
  so the RollingUpdate controller cannot terminate the old pod while the
  new pod has not taken over its group; LIVENESS is gated behind a
  STARTUP PROBE (or the equivalent explicit activated gate in the chart)
  whose failureThreshold covers the whole initialization bound
  (`readinessWindowMs` 60 s, the values) — an honest slow boot is never
  liveness-restarted before its first permitted real commit (the 15 s
  last-commit liveness threshold applies only AFTER activation, R5-15).
  Only then the old
  pod receives termination and finishes within its
  `terminationGracePeriodSeconds` (in-flight messages settle; after the
  old pod's termination is CONFIRMED, its unfinished PEL entries are
  reclaimed immediately by the new pod — the confirmed termination
  authorizes the reclaim, the idle clock does not delay it, R4-02). No
  writer gap, no reader gap, no epoch for these modules.
- **STOP-FIRST — the core runs as a ONE-REPLICA STATEFULSET (R5-03), the
  at-most-one identity Kubernetes itself enforces: the StatefulSet
  creates a replacement pod only after the previous pod's termination is
  fully observed by the kubelet.** Recreate is rejected for the core: it
  waits for old pods on upgrades only — a ReplicaSet replaces a DELETED
  pod immediately even while it is Terminating, which would open an
  overlap outside any rollout. The old pod finishes its tick, commits its
  snapshot, takes termination, and its termination is CONFIRMED
  (kubelet-observed; the operator observes it, never the workload's
  intent), then the new pod starts and takes the epoch and the snapshot.
  Confirmed termination on one node is the fence (A2). The fence EVIDENCE
  is the observed termination, NEVER API-object absence: the operator
  never force-deletes a core pod (a force deletion removes the API
  object without proving process death), and a state where the API object
  is gone without an observed process death REFUSES into maintenance —
  no successor starts from it (R5-03). The operator's gated window (the
  lease revocation plus the bounded Postgres backend drain, R4-14) stays:
  the StatefulSet settles the POD half of the fence structurally, the
  gate settles the STORE half.
- Changed modules are replaced ONE BY ONE IN MANIFEST ORDER (the
  chart's declared rollout order), and EVERY gated step is PUBLISHED
  THROUGH GIT (R5-01): a rollout of a candidate is a sequence of
  deploy-branch commits, one per changed module, pushed by the operator
  from its rollout record; each step closes only when the Flux controller
  has ACKNOWLEDGED the step — the release observed APPLIED at the
  RECORDED revision (the release's status naming that revision, never an
  earlier one) — and the module has passed its strategy-specific
  acceptance (readiness; for the core the whole gated window), and only
  then the operator commits the next module's change. At every moment the
  branch carries exactly one uninstructed step, so Flux can never mutate
  two state-carrying modules at once, and no source-owned field can
  overwrite a gate. The operator mutates exactly two fields outside Git,
  with their ownership EXPLICITLY settled: the SUSPEND gate and the
  panic/maintenance SCALE — the source declares neither (`spec.suspend`
  nor a gate-relevant replicas value; a build-stage lint refuses it, R5-01
  and R5-02), and the lifemodel Flux resources are bootstrap ROOTS no
  parent Kustomization re-declares, so each operator-owned field has
  exactly one writer. Direct mid-rollout values patches are NOT steps —
  a patch is forked state the next sync overwrites (O3-E's argument,
  extended to rollout steps). A scale-down is issued only AFTER the
  controller's acknowledgement and quiescence: the suspend ACK plus the
  ABSENCE of an in-flight Helm action (a suspend does not cancel one —
  the running action's outcome is awaited before anything is replaced or
  stopped). A readiness failure stops the rollout and rolls back (the
  previous generation's complete desired state: the operator reverts the
  deploy branch to the generation registry's recorded revision — R5-10;
  only the modules whose rendered release the revert changes move back).
- The health window starts after ALL changed modules of the commit are
  replaced; rollback restores the previous generation's COMPLETE desired
  state (the recorded revision — R5-10).
- Cluster mutation is RBAC-scoped: the operator's ServiceAccount carries
  the controller verbs; no module pod can mutate a workload, and no
  socket proxy exists to reach (the socket proxies of the Compose shape
  are rejected with the platform).

**Fencing.** The snapshot write stays epoch-checked: the new core
increments the epoch in Valkey (Lua CAS — cheap, operator-role-guarded)
as part of taking over after the old core's CONFIRMED termination; a
stale writer (one that somehow survived) fails its epoch check and is
refused (Q7's zero accepted stale writes, on one node now guaranteed
structurally — A2). Postgres `active_holder` keeps the same meaning for
keyed `pg.apply` writes (the core module's apply path checks it). One
Postgres fact is carried by the same fencing half (R4-14): pod termination
is the CLIENT's death — an already-submitted statement or COMMIT can
still run in the server's backend after the pod that sent it is gone, so
"the old writer is dead" is CONFIRMED, not assumed: the operator's
stop-first step between the confirmed termination and the bump revokes
the retired core's per-instance leases (OpenBao revocation kills its
connections) and WAITS — bounded — until no live backend of the retired
core remains before the fence is relied on. An old apply that already
passed its `active_holder` check therefore cannot outlive the fence
point. Stop-first remains a database-completion confirmation with bounded
waits, not a two-store epoch barrier (rejected below).

Mixed old/new modules during a rollout rely on the bus contract (FULL
compatibility both ways, Q8) and expand-only Postgres — the previous
module's readers tolerate the new module's writes by construction
(Q8's check).

Serves: F2 (readiness before switch, per module), F3 (no lost message,
no twice-answered — orderings above), Q1 (the pause's core work shrinks
to the stop-first window; the platform waits around it are named phases
with their own bounds, R5-14), Q7 (zero accepted stale writes), Q12 (one
changed module = one replaced module).

| Option | Pattern | Evaluation | Verdict |
|---|---|---|---|
| **O2-2026: per-module rollout keyed by workload type (RollingUpdate for keyed writers; a ONE-REPLICA STATEFULSET for the singleton core), gated Git steps replaced one by one in manifest order under the operator's gate; health window after the commit's last replacement; kubelet-observed pod termination = the core's fence evidence (A2), never API-object absence (R5-03); RBAC instead of socket proxies** | Kubernetes controller reconcile; pisces/brutal rollouts refined to writes-are-keyed | Steady state: a one-module change touches one module — the rest keep running (Q12, Q1). Failure: a readiness failure stops the rollout before more damage; rollback is the previous desired state via git. Security: only the operator mutates workloads; modules get lifecycle ONLY through Flux/controller semantics, never ad-hoc endpoints. Operability: `kubectl get pods` + Flux status IS the state; the chart IS the plan. | **Chosen** |
| **O2-M: the core as a Recreate Deployment (or any path where a deleted pod is replaced while still Terminating; force deletion countable as fence evidence)** | singleton writer by Deployment strategy | Rejected (R5-03): Recreate waits for old pods on upgrades only — a ReplicaSet replaces a DELETED pod immediately even while it is Terminating, and a force-deleted API object proves nothing about the process. The one-replica StatefulSet carries the at-most-one identity in Kubernetes semantics (no replacement before the previous pod's fully observed termination); fence evidence is kubelet-observed termination alone; an API object gone without observed process death refuses into maintenance instead of starting anything. | Rejected (R5-03) |
| **O2-B: two-store closed-apply epoch barrier across Valkey and Postgres** | fencing token with an ordered, store-enforced barrier; the round-3 answer to R3-03 | Rejected by the owner, 2026-10-12 (simplification point 1): on ONE node the old core is CONFIRMED TERMINATED before the new one takes the epoch (stop-first), so there is no already-open old transaction to race. Keep: the Lua epoch CAS and the `active_holder` guard as cheap operator-bug guards. Invalidator: modules on several machines re-open the two-writer window and this option returns with it (A2). | Rejected by the owner, 2026-10-12 (simplification point 1; returns with its invalidator) |
| **O2-C: generation-wide switch — the whole generation stops, the new one starts and takes the epoch** | blue/green with an epoch handover | Rejected by the owner, 2026-10-12 (simplification point 1): it pays the full switch cost for any change, even one plugin; per-module rollout keeps unchanged modules in service. The old reasons for a whole-generation atom are met instead by stop-first for the core and per-module readiness (R3-12's per-module health). | Rejected by the owner, 2026-10-12 (simplification point 1) |
| **O2-D: epoch only in process memory (today's counters)** | none | A fence the fenced party forgets at restart; the Lua CAS key in Valkey is one GETSET away and survives restarts. | Rejected |
| **O2-E: mTLS workload identity / SPIFFE between modules** | zero-trust mesh | Rejected by the owner, 2026-10-12 (simplification point 3): NetworkPolicy + RBAC reach the same "module cannot reach vault, operator, registry" goal structurally at zero certificate machinery; identity-binding every peer defends against a malicious module the threat model excludes. Deferred to the backlog for a later multi-machine or foreign-source shape (A3's invalidator). | Rejected by the owner, 2026-10-12 (simplification point 3); deferred, not deleted |
| **O2-F: HTTP control endpoints on modules (`/activate`, `/drain`, `:7400/grant`)** | control-plane RPC to the workload | Rejected by the owner, 2026-10-12 (simplification points 3 and 4): the operator talks workload lifecycle and reads probes; the epoch key is operator-role-writable in Valkey. No module exposes an HTTP control surface because no module needs one. | Rejected by the owner, 2026-10-12 (simplification points 3, 4) |
| **O2-L: the operator patches one release's values directly mid-rollout and treats the release as the only serial gate** | controller-patched rollout gate, no Git | Rejected (R5-01): a source-owned values/suspend field can be overwritten by the release reconcile, suspending a release does not cancel an already-running Helm action, and a direct patch is forked state Flux's next sync re-applies — one release per module is not a serial or stop-first gate. The gate travels through the deploy branch instead (the steps above), and the operator's two non-Git fields have settled single ownership. | Rejected (R5-01) |
| **O2-K: let Flux alone own the rollout (no operator gate; image automation + HelmRelease as-is)** | pure GitOps | Rejected (platform decision consequences): Flux has no notion of the singleton core's stop-first EPOCH handover, the consumer-group join before the old pod stops, or the completed-work health window — Flagger/Argo Rollouts do not cover it either (the owner's named reason for a bespoke operator). Flux applies; the operator DECIDES when the desired state may move. | Rejected |

### Q2 continued — the job mechanics (simplification point 2, unchanged by the platform)

A JOB is a keyed command event in a Valkey stream, consumed through a
consumer group. This is the ENTIRE in-flight/async machinery:

- **XACK only after the result is recorded.** A dead consumer's pending
  job is claimed by another instance of the same module via XAUTOCLAIM
  (built-in) — NO own zombie takeover, NO job heartbeat, NO durable
  per-job state machine, NO grace allowlist.
- **Done record by key, ADMITTED BEFORE dispatch**: the consumer's first
  write for a delivery is the per-effect-key done record itself, inserted
  in state `in-flight` BEFORE the effect is dispatched — a same-key
  ATOMIC insert (the key is the record's identity; a re-delivery cannot
  overwrite it or mint a second one), so the marker is durable before any
  external call starts. The record is then UPDATED after the effect
  applies (`delivered`/`uncertain`, later `settled`) and is checked
  BEFORE the effect re-runs — a recovered attempt is never blind, it
  follows the recorded state. Crash between effect and the completion
  write leaves the record `in-flight`: a keyed destination retries safely
  under the same id (the destination dedups); an unkeyed destination is
  recorded `uncertain`, reported, and does NOT retry (R3-08's class
  system). A settled record is RETAINED while any delivery path can still
  re-issue its key (a live PEL entry, an undelivered command entry, a
  parked delivery, a retained snapshot copy naming the key) — the
  design's pruning rule.
- **Jobs issued by an older version are run by the new module** (the bus
  contract's FULL both-ways compatibility, Q8). NO retained-image
  one-shot runners.
- **The core is fully async** (owner decision 4, kept): a command event
  goes out, a result event comes in, the tick never blocks on a round
  trip.
- **A call whose answer arrives on the bus later** (webhook, human reply,
  timer fire): send, record the correlation as ordinary state, XACK, be
  done — the answer arrives as a future event. NO special suspension
  mechanism.
- **A call answered on the same connection** (model HTTP call, page
  fetch, a Motor step) is held by the consumer module for the duration
  (Half-Sync/Half-Async — the external protocol's fact).
- **Timeouts (Release It!): EVERY sync call declares a timeout per
  destination in the module's call manifest**, with its keyed/unkeyed
  class; a call without a declared timeout FAILS THE BUILD. The consumer
  module cuts the connection at the timeout; after a cut: keyed ->
  retry, unkeyed -> `uncertain`. Build check: the module's
  `terminationGracePeriodSeconds` >= its longest declared timeout — the
  manifest declares the timeout in ms and the pod field is SECONDS, so
  the check converts once (ms / 1 000, rounded UP) and asserts the
  inequality in ONE unit, against the RENDERED pod field, never the
  pre-conversion chart input (R5-11). The
  egress gateway also enforces a per-request timeout on its side.
- **A delivery-to-result bound per module (R4-02).** The call manifest
  ALSO declares, once per module, the maximum time from a command's
  DELIVERY to its result — covering the queue wait, the held sync call
  AND a parked correlated round trip; a parked `tool.request` whose
  result has not arrived within the bound is released, counted and
  reported (N-14's unknown/late-result rule). A missing bound FAILS THE
  BUILD (checked with the timeouts, N-5). The XAUTOCLAIM min-idle sits
  above this bound — it is the crash-takeover trigger; reclaim from a
  retiring pod is authorized by confirmed pod termination, not by idle.
- NO unbounded sync calls.

A job's key (the effect key) is minted at the deciding tick's commit and
rides the command event; the done record is keyed by it; the re-run after
a cut or a takeover is deduped by it. This is distributed consumer-group
mechanics, applied identically by every non-core module.

| Option | Pattern | Evaluation | Verdict |
|---|---|---|---|
| **O2-G: keyed jobs through consumer groups; XAUTOCLAIM takeover; done records by key; mandatory call-manifest timeouts; `uncertain` for unkeyed ambiguity** | competing consumers (EIP Message Endpoint, Competing Consumers); idempotent receiver; Half-Sync/Half-Async; Release It! timeouts as build-checked manifest entries | Steady state: the consumer-group machinery a queue engine would give us arrives for free with Valkey streams; a module that owns work owns its whole consume-settle loop. Failure: a killed consumer's work is claimed after min-idle; an ambiguous unkeyed effect is REPORTED, never silently re-delivered. Operability: every call's timeout is linted in; the call manifest is the audit of who reaches outside. | **Chosen (point 2; carried to k3s unchanged)** |
| **O2-H: durable job/attempt state machine — a `job` row per job, heartbeats, loader-driven atomic takeover, suspension registry** | workflow-engine semantics (Temporal/Windmill) on own machinery; the round-3 answer to R3-09 | Rejected by the owner, 2026-10-12 (simplification point 2): consumer groups + XAUTOCLAIM give the claim and the takeover; the owner kept from it only "done record by key" and the bus-first rule. | Rejected by the owner, 2026-10-12 (simplification point 2) |
| **O2-H2: executor module — one module consumes every command job; heartbeats, grace capability, allowlist** | the round-3/owner-decision-4 shape | Rejected by the owner, 2026-10-12 (simplification point 4): NO executor module. Work goes to the module that OWNS it (each a consumer group under point 2's rules, replaced under point 1's strategy). Kept from decision 4: the core makes no external calls, keyed jobs, both-ways event compatibility. | Rejected by the owner, 2026-10-12 (simplification point 4) |
| **O2-I: grace capabilities — switch-time revocable completion credentials, allowlist-checked** | the round-3 answer to R3-01 | Rejected by the owner, 2026-10-12 (simplification points 1 and 4): "finish in grace" is simply the old pod's `terminationGracePeriodSeconds` plus XAUTOCLAIM min-idle-taking. R3-01's underlying instinct (whichCredentialCanFinish is narrow) is satisfied by the SAME normal credentials, held exactly to the grace deadline. | Rejected by the owner, 2026-10-12 (simplification points 1, 4) |
| **O2-J: dedicated async-workflow engine now (Temporal/Windmill) for jobs** | external workflow engine | NOT for this milestone; the owner's research (Windmill vs Temporal vs own) is filed BEFORE outcome 6 and does not block this shape, because nothing above hides a WAIT. The job surface is deliberately plain so that research can move it wholesale. | Deferred (research before outcome 6; not a decision today) |

### Q3 — rollback, maintenance mode, failed-generation count, panic (simplification points 1 and 6, reshaped by the platform decision)

**Decided (owner point 3 + simplification points 1 and 6, on k3s): NO down
migrations; expand/contract with the invariant "the predecessor reads
everything I write", checked on SCHEMAS at every rollout plus as a
build-stage check; automatic rollback = REVERT THE DEPLOY BRANCH to the
previous generation's recorded FULL revision (chart and values, not the
tags alone — R5-10), applied by Flux on
CURRENT data; panic = a durable recorded intent reconciled release by
release to suspend + scale to zero, complete only at the observed
all-stopped state (R5-02); 2 consecutive failures -> maintenance; panic
overrides.**

The platform reshapes the mechanics, not the substance:

- **Rollback is a git operation that restores the COMPLETE previous
  generation-owned desired state (R5-10).** The generation registry pins, per
  generation, the deploy-branch REVISION it was built from — its application
  chart templates and values, not merely module tags. The operator reverts
  the branch to that recorded revision (one ordinary git revert: image tags
  AND launch state — probes, grace, environment and strategy — revert
  TOGETHER, never the tags alone); platform-owned NetworkPolicy and RBAC
  remain unchanged. Flux applies the reverted
  commit under the same per-module strategies, and a module whose
  rendered release the revert does not change keeps its release revision
  and is not re-replaced. Symmetrically, a CANDIDATE is gated by its
  whole rendered desired state, not only by new tags: a candidate that
  changes chart/values while reusing EVERY image tag still passes the
  full gated rollout and the health window — image reuse buys build cost
  (Q12), never a skipped rollout gate or window. The deploy branch is the
  single source of truth — there is no imperative path to roll back
  along, and `kubectl` drift outside it is forbidden (rejected option
  O3-E below). A rollback is a git revert of the deploy branch in Gitea.
  Gitea is platform-owned source infrastructure, outside generations;
  CNPG is also platform-owned, but Gitea does not use or depend on it: a
  generation must not be able to break its own source of truth. If Gitea
  is down, running generations continue; no new generation can be built or
  selected until it returns. Every Gitea wait and retry in rollback is charged
  to the single 300 000 ms `rollbackDeadlineMs`. Recovery before expiry resumes
  the durable recorded attempt; expiry enters the existing maintenance fallback (Flux suspended and module
  workloads scaled to zero), reports the blocked Git step, and requires explicit owner authorization before
  any start after Gitea returns. Nothing restarts automatically after recovery.
  The cached-last-good recovery exception is not adopted; it would need the
  owner's explicit acceptance. The current backup feature is deferred: loss or
  regression, missing revision, or revision older than the recorded deploy head
  holds reconciliation for owner recovery, never auto-reseeds. Gitea repository
  data and SQLite DB/config share one PVC; a future one-volume backup verifies
  required commits/auth/rules before restore.
- **Panic is a durable multi-resource transition whose RECORDED INTENT is
  authoritative (R5-02).** The owner's panic (web UI or command) is first
  a DURABLE RECORD — written and read back complete BEFORE any mutation
  (R4-09's rule); the record, not a partial step, is what means "the
  instance is panicking". The operator then RECONCILES every resource to
  the stopped state, release by release in manifest order: for each
  lifemodel release — (a) the Flux suspend ACKed (the desired state stops
  reconciling), with any in-flight Helm action AWAITED to its completion
  (a suspend does not cancel one; its outcome is recorded, and the
  workload it produced is then taken to (b)), then (b) that release's
  workloads SCALED TO ZERO and the stopped state OBSERVED — and only then
  the next release. PANIC IS COMPLETE only when every lifemodel release is
  suspended AND every module workload is OBSERVED at zero; until that
  point the recorded intent re-drives. The suspend + scale state is
  CLUSTER STATE, so panic holds across operator restarts, Flux restarts
  and node reboots, with no time limit; and the ownership is settled as in
  R5-01 — the source declares no suspend and no gate scale, no parent
  Kustomization re-declares the lifemodel Flux resources — so nothing
  reconciles the panic state away or restores a source-declared suspend.
  A crash after ANY single mutation (or mid a Helm action) is the named
  cut: a fresh operator reads the panic record FIRST (panic precedence)
  and re-drives the remaining releases toward stopped — always toward
  stopped, never starting anything — so a partial panic becomes the
  complete block deterministically. Resumption unsuspends Flux and
  restores the deploy branch's desired state, after the durable resume
  record (below). Panic overrides every other path, including a rollback
  in flight.
- **Maintenance mode** is the operator's gate: within it the owner can
  boot an older generation (F5) and restore a snapshot copy. Outside it
  no manual boot is offered.
- **Postgres is NOT rolled back:** the instance continues on CURRENT
  data, and re-applied commands are keyed (the done-record check makes
  re-delivery a no-op). CNPG's own declarative backup support is the
  natural home for the filed backlog item (automatic regular Postgres
  backups) — configured by the owner, outside this milestone's
  switch/rollback machinery.
- Snapshot copies (simplification point 6, carried):
  - a copy is taken ONLY when the CORE is replaced (stop-first): by the
    OPERATOR right after the old core committed its last tick and its
    termination was confirmed — the point the new core starts from;
    other module replacements do not touch the snapshot.
  - the last N copies (N = `snapshotCopyRetention`, DECIDED = 3) are kept
    in Valkey beside the current snapshot.
  - a restore is MANUAL, MAINTENANCE MODE ONLY: the operator first checks
    the copy's snapshot schema is readable by the CURRENT core (Q8's
    schema rule) and that the copy's stream positions are not trimmed;
    otherwise it REFUSES with the reason.
  - NO snapshot+PG stamp pair, no consistency rules for pairs, no
    automatic-restore path.
  - FULL backup (Postgres dump + Valkey copy) ONLY on the owner's command
    in maintenance mode, NEVER part of a switch or rollback.

Charter outcome-5 check changes (owner, unchanged): the owner boots an
older generation within the compatibility window; older ones refuse with
the reason; "brought back by breaking migration" is dropped. The
compatibility window is decided by the schema comparison plus the
snapshot format version rule (a generation seeing a NEWER snapshot
version refuses to start and reports why).

Serves: F4 (one automatic fallback with a report, now per-commit-module
scope), F5 as amended, F6 as reshaped, Q3 (restoration bound), Q11 as
amended.

| Option | Pattern | Evaluation | Verdict |
|---|---|---|---|
| **O3-2026: expand/contract with schema checks; automatic rollback = git revert to the previous generation's recorded FULL revision (chart and values — R5-10), applied module-by-module on CURRENT data; snapshot copies as manual maintenance recovery taken only at core replacement; 2 failures -> maintenance; panic = recorded intent reconciled release-by-release to suspend + scale to zero (R5-02), durable** | expand/contract (parallel change); circuit breaker; GitOps rollback (revert the declared state) | Steady state: every change lands in two safe shapes — additive first, removal later by a contract step. Failure: never-ready discards the candidate with a report; ready-but-unhealthy reverts the CHANGED modules on current data; the schema checks move format mistakes to build/rollout time where the report is a diff. Operability: no converter chain, no transition record, no down path to test; panic survives anything that survives the cluster. Cost: old generations beyond the schema window refuse to boot (recovery past the window is manual — named, not hidden). | **Chosen** |
| **O3-B: automatic fallback chains (try N-1, then N-2, ...)** | retry-with-backoff down a list | Each try spends the budget and produces indistinguishable reports; the breaker covers the same ground in one try. | Rejected |
| **O3-C: automatic rollback by restoring an old snapshot** | point-in-time restore | Rejected for AUTOMATIC use (resurrects answered messages — F3's twice-answered accident). The manual form is adopted as maintenance recovery (a copy at core replacement, restored by a human in maintenance only). | Rejected for automation; adopted as manual maintenance recovery |
| **O3-D: snapshot + Postgres STAMP pair at every switch — hash-pinned pair, restore refuses a half-pair** | consistent paired capture; the round-3 answer to R3-22 | Rejected by the owner, 2026-10-12 (simplification point 6): copies only at core replacement; a FULL backup is an owner-commanded MAINTENANCE action, never part of a switch or rollback. | Rejected by the owner, 2026-10-12 (simplification point 6) |
| **O3-E: imperative rollback — the operator (or the owner) reapplies old images with kubectl, outside the deploy branch** | CLI-driven rollback | Rejected (platform decision consequences): the deploy branch is the single desired state; an imperative path forks the state and breaks Flux's reconcile (its next sync re-applies the branch). Rollback IS a commit. | Rejected (platform decision consequences) |

### Q4 — where every "unclear" state row goes; where plugins live (owner point 5, kept; the platform adds CloudNativePG)

**Decided (owner point 5, kept with the simplification amendments): the
state split stands — tick working state in the Valkey snapshot; inbound
as a Valkey stream with offsets in the snapshot; long-lived
memory/conversations/soul/registries/schedules/config in Postgres. No
executor module exists: the module that owns the work consumes the
command stream and answers on the bus, per Q2's rules.** Postgres is now
a CloudNativePG cluster (pgvector in the image, declarative roles per
module schema, backups declarative) — the stores' NAMES do not change,
their PROVISIONING becomes GitOps.

Amendments carried:

1. **Neurons are CORE plugins**: they stay in the core process behind the
   plugin API. Extracting them into isolated modules is DEFERRED — the
   options (sensor containers publishing to the bus / a WASM sandbox
   in-core / one neuron-host process) are recorded, none chosen. Until
   then "a neuron cannot crash the core" rests on error handling, NOT
   physical isolation — the claim is not made stronger anywhere.
2. **Feature plugins (calories, reminder, news, web-search, web-fetch)
   become FUNCTION IMAGES (Nuclio-style) in this milestone, all five.**
   Their influence on the body = signals on the bus — no in-process
   import, no direct call, no shared state. Their state and schedules
   have NO function-held storage (the adapter's state paths, Q6).
3. **A new or changed plugin goes only through a commit and a
   generation**: no hot reload.
4. **Skills as instructions = data in Postgres**, loaded into the tick's
   context, never code.
5. **Postgres writes are keyed commands applied AFTER the tick commit,
   epoch-checked, idempotent by natural keys**; the generic
   `applied(key, epoch)` table exists only where no natural key can be
   minted. Roles are declared per module schema through CNPG (the chart
   owns them; a module's role has rights on ITS schema only).
6. **Web-chat delivery proof = the message row itself** (insert by key).
   The Motor module writes its Motor result rows under the same rules
   (the run registry); on k3s Motor's sandboxes are Kubernetes JOBS in
   Motor's own namespace under RBAC (Q9's amended mechanism) — the result
   path (bus event + keyed row) is unchanged from the Compose shape.

| Option | Pattern | Evaluation | Verdict |
|---|---|---|---|
| **O4-A: each row to the store whose failure semantics it needs** | data classification (durability class -> store); Release It! "trade-offs are per-property" | The split above, with the five amendments. Natural-key idempotency keeps the generic applied table the documented exception. | **Chosen** |
| **O4-B: everything unclear into Postgres** | one-store reductionism | Pushes tick-speed state behind a network round-trip per tick and splits the loop's cross-tick mind across stores — the snapshot commit would no longer carry it whole. | Rejected |
| **O4-C: everything unclear into the snapshot** | one-writer reductionism | Unbounded snapshot growth; history reads in the hot path. | Rejected |
| **O4-D: shared volume trees for skills/plugins/logs** | today's layout | Two writers (the switch window) plus no inter-process safety equals clobber; plugin CODE is already in the image, skills are Postgres data. | Rejected |
| **O4-E: extract neurons into isolated modules NOW** | sensor containers / WASM sandbox / neuron-host process | Deferred by the owner, 2026-10-12 (decision 5): the three options are named, none chosen, and the design must not promise the isolation they would give. | Deferred |
| **O4-F: tickets/job state/attempt machines in a dedicated executor module's own schema and tables** | workflow-engine state model | Rejected with the executor module itself (point 4): a job's continuation is a done-check + a done-record write (Q2), and long waits are recorded as ordinary correlation state. | Rejected by the owner, 2026-10-12 (simplification point 4) |
| **O4-G: etcd/ConfigMaps/a dedicated operator CRD as the instance's state store** | Kubernetes-native state | Rejected (platform decision consequences): the tick snapshot's write pattern (atomically committed, epoch-checked, fsynced per write, stream offsets beside it) is Valkey's, not a ConfigMap's (1 MiB limit, no atomic CAS-with-data) and not a CRD's (API-server write amplification per tick). The epoch CAS uses Valkey, not a resource version. | Rejected (platform decision consequences) |

### Q5 — the static topology, the one command, and the networks (owner point 6; networks by simplification point 3, reshaped by the platform decision)

**Decided (owner point 6, amended 2026-10-13): the topology has two
GitOps layers.** The trusted **platform layer** is an OCI artifact built
from the platform manifests for each release, published and signed by CI.
A Flux `OCIRepository` in `flux-system` pins that release and verifies its
Cosign signature before a Flux `Kustomization` applies the platform. The
installer's sole platform source is this pinned OCI source and its
Kustomization; the installer does not install Helm releases or keep
credentials. The **application layer** is the Gitea deploy branch. Flux's
second source reads that branch, and the generation operator alone writes
it. Each target namespace (`lifemodel` and `lifemodel-motor`) has its own
platform-created GitRepository for that deploy branch, with its read-only
credential Secret in that namespace (the loader writes the credential; the
signed platform release creates the source). The application layer has one
Kustomization in each target namespace, referencing only that namespace's
GitRepository and using that namespace's platform-provisioned applier
ServiceAccount, Role and RoleBinding. Each may reconcile only a same-namespace
HelmRelease; that HelmRelease's chart source is the same namespace's
GitRepository and its path in the deploy branch. No cross-namespace references are allowed
except the platform RoleBinding subject that grants the Helm applier access to
its dedicated storage namespace; the same-namespace Kustomization-to-HelmRelease
edge is the only permitted nested reconciler. Generations own only
Deployments, StatefulSets, Services, ConfigMaps, module HelmReleases and Motor
Job templates in those two namespaces. Platform policies and RBAC are
immutable across generation rollback; the full ownership boundary is in the
R7-01 third-pass decision.

Platform source changes are release changes, not generation changes. The
owner commands an upgrade through the loader UI by selecting a new pinned
platform release; CI verifies and signs that release artifact, then the
loader updates the pin. During reconciliation, Flux applies the platform
release while the application source remains pinned to its current deploy
branch revision. The application layer is neither rewritten nor suspended
by a platform upgrade; Flux continues reconciling it, and incompatibility
or platform readiness failure blocks completion and is reported without
silently advancing the application source. Gitea is itself platform-owned,
so no candidate or rollback can change it. The existing-cluster
`helm install` entrypoint is removed from this milestone; it is deferred to
lifemodel-xc9 (own namespace, each platform dependency switchable to an
external one such as `openbao.enabled=false`, with no Flux and no
cluster-scoped resources).

The chart declares every workload, probe,
`terminationGracePeriodSeconds`, strategy, NetworkPolicy and RBAC binding;
Kubernetes namespaces with default-deny NetworkPolicy replace Docker
networks; RBAC replaces socket proxies; Traefik (bundled with k3s) is the
only port-published surface. Owner routes retain the named ForwardAuth
rules (R5-19), including the bounded first-start setup exception; Agent
Vault retains its guarded `vault.` UI route. OpenBao uses its chart's
Shamir seal with custody managed by the loader's first-start workflow.
The loader initializes and stores custody idempotently; no manual
preparatory command exists. The clean VM uses explicitly selected embedded
etcd for the single server (R5-18). k3d remains only the dev/CI test
environment. Kubernetes restarts crashed containers in place under their
restartPolicy; generation replacements remain the operator's action through
the deploy branch.**

- **Platform artifact signing and verification.** The repository's
  `release.yml` workflow renders the platform manifests, publishes the OCI
  artifact with `flux push artifact`, then signs the pushed artifact digest
  with Cosign keyless signing using GitHub Actions OIDC. Keyless is chosen
  over a managed signing key because the release workflow needs no exportable
  long-lived private key; the certificate is short-lived and tied to the
  workflow identity. The bootstrap `OCIRepository.spec.verify` pins
  supports both verification modes: keyless `matchOIDCIdentity` (the
  default) and key verification via `secretRef` to a public key. The selected
  verification policy is part of the installer-bundled root source manifest
  and cannot be supplied by the artifact it authenticates. The installer
  also pins the release OCI reference/digest; Flux refuses an unsigned
  artifact, a changed digest, or a signature that does not match the selected
  policy before applying manifests. During development, tests sign with a
  throwaway cosign key and use a registry local to the test VM; nothing is
  published. The keyless `release.yml` path is first proven at the first real
  platform release through ship-release (owner, 2026-10-13). Flux
  OCIRepository/Cosign verification:
  https://fluxcd.io/flux/components/source/ocirepositories/;
  artifact publication:
  https://fluxcd.io/flux/cmd/flux_push_artifact/; Cosign container
  signing: https://docs.sigstore.dev/cosign/signing/signing_with_containers/.

- **Where the topology lives.** Platform desired state is the signed OCI
  release; application desired state is the Gitea deploy branch. The
  `flux-system` OCIRepository and platform Kustomization are the only
  install-time Flux roots. Flux reports each source and reconciliation
  status; an imperative change outside the owning source is forbidden.
  The operator may write only the application branch, never the platform
  artifact or its pin.
- **Gitea is a platform source-of-truth component, not a generation module
  (R6-06 lifecycle owner: platform layer).**
  The signed platform release and Flux own its chart and resources in
  `lifemodel-git`; it remains outside the deploy branch's candidate paths.
  The official chart is pinned at `12.7.0` (Gitea `1.27.0`; chart index:
  https://dl.gitea.com/charts/index.yaml). SQLite
  (`database.DB_TYPE=sqlite3`) and repository data share one PVC in
  `lifemodel-git`. Gitea on shared CNPG is rejected. Candidates and
  rollbacks that touch Gitea, its PVC, policies or routes are refused before
  mutation. Only an owner-commanded platform release may upgrade Gitea; no
  automatic DB downgrade is allowed. Gitea Issues is NOT the
  work tracker. Backup/restore remains deferred; on source identity or revision
  loss hold reconciliation for owner recovery and never auto-reseed. A future
  one-volume backup of repository data and SQLite DB/config verifies required
  commits/auth/rules before restore.
- **Namespace ownership by layer.** The platform layer owns `flux-system`
  (including the root OCIRepository/Kustomization), `lifemodel-system`,
  `lifemodel-state`, `lifemodel-git`, `lifemodel-releases`,
  `lifemodel-motor-releases`, `openbao`, `traefik`, and the required
  `kube-system` platform configuration. The application layer owns only
  generation workloads and their scoped namespaced resources in `lifemodel`
  and `lifemodel-motor`. The application layer cannot create or modify
  namespaces, CRDs, cluster-scoped resources, platform RBAC, the registry,
  OpenBao, CNPG, Traefik, or Gitea. All namespace names/policies below are
  platform-release resources except the explicitly scoped application
  resources.

- The namespace table (every namespace denies EGRESS by default; the
  rows below are the whole policy):

  | Namespace | Members | Outbound routes (the NetworkPolicy rows) |
  |---|---|---|
  | `lifemodel` | core, ingress gateway, egress gateway, function host, Motor module | modules -> Valkey and their store/schema surface (Q4, Q7); every module -> cluster DNS (CoreDNS, resolution only — R5-05); every module -> OpenBao (the vault-env Kubernetes-auth login); the Motor module -> `lifemodel-motor` (create Jobs) and -> the egress gateway (proxy hop); the egress gateway -> the world AND Agent Vault |
  | `lifemodel-motor` | Motor's sandbox Jobs | the egress gateway only, as `HTTPS_PROXY` under the motor policy (R4-06's mechanism, carried); cluster DNS; the explicitly named sandbox-to-Gitea exception on Gitea's HTTP(S) port for this-repository clone, `task/*` push and PR only; and OpenBao via a unique per-run zero-RBAC ServiceAccount and exactly bound auth role/policy to read only that run's task-token secret; no list, admin/module secret, bus or store route |
  | `lifemodel-releases` | no workloads; platform-owned Helm release Secrets only | no egress; default-deny NetworkPolicy; generation sources cannot create or modify this namespace or its contents |
  | `lifemodel-motor-releases` | no workloads; platform-owned Helm release Secrets only | no egress; default-deny NetworkPolicy; generation sources cannot create or modify this namespace or its contents |
  | `lifemodel-state` | Valkey, the Postgres cluster (CloudNativePG) | inbound-serving only — no egress rows open |
  | `lifemodel-system` | the generation operator, the CNPG operator, the local registry, BuildKit build pods, Agent Vault | operator -> the Kubernetes API, Gitea (read; write `main`/deploy and merge PRs after gates), the stores, OpenBao; the CNPG operator -> the Kubernetes API and its Postgres instances (R5-05's control-plane row); BuildKit pods -> the registry and the base-image sources (Q1's "normal network", a named row); Agent Vault -> the world (the egress path's LAST hop — its own named row) |
  | `openbao` | OpenBao (official chart) + the Bank-Vaults secrets webhook | OpenBao server -> the stores (dynamic-credential issuance) and -> the Kubernetes API (the Kubernetes-auth TokenReview); cluster DNS; the secrets webhook SERVES the API server's admission calls (ingress, never an egress row) |
  | `traefik` (the chart pins the bundled Traefik's namespace — k3s normally bundles it in `kube-system`) | Traefik | the Kubernetes API (route/endpoint discovery — R3-15) and the ingress routes below |
  | `lifemodel-git` | Gitea (official pinned Helm chart), repository + SQLite database PVC | Gitea -> cluster DNS; optional HTTPS push mirror -> the egress gateway's dedicated mirror listener on its own port, reachable by NetworkPolicy only from Gitea pods in `lifemodel-git`, then fixed `gitea-push-mirror` policy (CONNECT only to the configured remote host on 443) -> outside remote; Gitea cannot reach any other gateway listener |
  | `flux-system` | Flux controllers, the pinned platform `OCIRepository` and its root `Kustomization` | Flux controllers → Kubernetes API; source-controller HTTPS to `ghcr.io`, `pkg-containers.githubusercontent.com`, the configured GHCR token endpoint, `tuf-repo-cdn.sigstore.dev` and `rekor.sigstore.dev`; kustomize-controller and helm-controller fetch artifacts from the source-controller Service (TCP 80 → container HTTP 9090); source-controller reads each target namespace's local Gitea deploy-branch source. These platform-owned routes are independent of application egress. Online Cosign keyless verification is required; TUF and Rekor must be reachable. |
  | `kube-system` (the platform's own) | CoreDNS, the k3s agents, the API server, the bundled Traefik if not relocated | no lifemodel row routes INTO it except the DNS row; its pods ride the kubelet/node plane — the NetworkPolicy NODE-TRAFFIC EXCEPTION, stated and never relied on for lifemodel's isolation (R5-05) |

  Only Traefik publishes a port (its LoadBalancer service). It also routes
  the owner's Gitea UI on a new pinned host such as `git.` through
  ForwardAuth, like the existing `boot.` and `vault.` hosts; Git traffic
  from Flux, the operator, and the sandbox uses the internal Service, not
  that public route. The old "one non-internal front leg" rule becomes:
  every cross-namespace route is an explicit policy row, and nothing outside
  the cluster reaches anything but Traefik. The optional Gitea push mirror
  does not get its own direct internet route: its `HTTPS_PROXY` names a dedicated
  egress-gateway mirror listener on its own port. NetworkPolicy permits that
  listener only from Gitea pods in `lifemodel-git`; Gitea cannot reach other
  gateway listeners. The listener is bound to the one fixed `gitea-push-mirror`
  policy, which permits CONNECT only to the configured remote host on 443. It
  uses no proxy credential and grants no bus or store authority. This keeps
  world access on the established choke point and makes the mirror's destination
  auditable. The
  chart 12.7.0 `deployment.env` configures `HTTPS_PROXY` and lowercase
  `https_proxy` for HTTPS mirror subprocesses, and `NO_PROXY`/`no_proxy` for
  internal service URLs (`values.yaml:338-341`;
  `templates/gitea/deployment.yaml:350-352`). HTTP mirrors are not supported.
  The operator reads `secret/data/gitea/mirror` from OpenBao and delivers the
  configured HTTPS remote credential to Gitea through Gitea's mirror API;
  the gateway caller policy is
  `gitea-push-mirror`. Gateway-down failures retry and report; mirroring never gates rollout or
  rollback and is not a recovery channel.
- **The platform's own traffic is NAMED, not implied (R5-05).** The
  exhaustive table is the whole policy INCLUDING the infrastructure the
  bootstrap needs: cluster DNS (every namespace resolves through CoreDNS
  only — no external-resolver or DNS-to-the-world row from a plain
  module), OpenBao's issuance legs (server -> Postgres/Valkey for dynamic
  credentials; server -> the Kubernetes API for the Kubernetes-auth
  TokenReview), the admission webhooks (the API server's calls INTO the
  Bank-Vaults secrets webhook's and CNPG's webhook Services — ingress,
  unaffected by the egress deny), the CNPG operator's control plane
  (the Kubernetes API and its Postgres instances) and Traefik's
  discovery leg to the Kubernetes
  API. Two NetworkPolicy facts are stated where the rows are read: it
  does not filter NODE-to-pod traffic (the kubelet's probes and the k3s
  agents' plane — observation only, O2-F), and a namespace NAME is not a
  route — every row selects pods and Services by label, and the review
  diff checks the rendered rows against the ACTUAL installed namespaces
  and ports. Enforcement is pinned: k3s's embedded NetworkPolicy
  controller stays ENABLED (`--disable-network-policy` never set) — the
  one command's step 1 asserts the setting, and a cluster without it
  refuses the bootstrap. Direct external DNS and internet stay denied to
  plain modules, and the Kubernetes-auth reviewer privilege stays ON
  BAO'S service account (a TokenReview is Bao's act, never a module's).
- **RBAC instead of socket proxies** (the threat model's first kept
  barrier): the OPERATOR is the only workload with cluster mutation
  rights (lifemodel workloads, leases, rollout records, suspensions);
  Motor holds rights ONLY on Jobs in `lifemodel-motor`; every other
  module's service account grants NOTHING. There is no Docker socket,
  CLI or `DOCKER_HOST` anywhere in the cluster (Q9 as amended). A socket
  proxy's pinned verb allowlist — and the re-check-every-lifecycle-change
  duty it carried — is gone with it: RBAC verbs ARE the allowlist, and
  the operator's RBAC row is itself a chart-declared, reviewable
  surface.
- Modules talk only through the bus; language, process and machine are
  each module's own business; the bus contract (AsyncAPI + JSON Schema,
  Q8) is the load-bearing standard.
- The touch-the-world rule (point 4), exceptions adapted: (a) Traefik is
  infrastructure in front of the ingress gateway — the owner's WHOLE web
  surface terminates on the ingress gateway's pool, which is the web
  module's UI/session/submit/transcript/reply service; the core is
  bus-reachable only and holds NO front route; the operator's
  boot/panic web UI is reached through Traefik with ForwardAuth to the
  OPERATOR (replaces Caddy's `forward_auth` to the loader), with the
  route-by-route mapping and its named exceptions in the design (R5-19) —
  and the owner's key entry runs through Agent Vault's own published,
  ForwardAuth-guarded UI route on a pinned host, the ONE published vault
  route in the shape (P16), alongside Gitea's ForwardAuth-guarded `git.`
  UI (P16/P25); (b) Agent
  Vault is the last hop of the egress path (egress gateway -> Agent
  Vault -> internet): the gateway reaches the vault on the vault policy
  row only, and a module reaching Agent Vault on anything else has NO
  route — structurally, with no certificate machinery (point 0's
  mistake barrier); (c) Motor sandbox traffic goes through the egress
  gateway acting as an HTTP proxy (`HTTPS_PROXY`) under a motor policy,
  on the `lifemodel-motor` rows — the sandboxes hold NO bus or store
  route; (d) the operator's BuildKit builds use the network (Q1), outside
  the rule — they may later go via the gateway or a package mirror; (e) the
  optional Gitea HTTPS push mirror uses P26 through the egress gateway only,
  with no direct Gitea internet route.
- The egress gateway (unchanged from the Compose shape): it consumes
  `HTTP request` command events (timeout and destination class declared,
  point 2) from the bus, runs them, and puts responses back on the bus.
  The requester's identity IS the stream it wrote to (Valkey ACL: a
  module writes only its own streams) — identity without certificates.
  It enforces its own per-request timeout, carries per-module policy and
  logging; rate limits are added there when needed. It is an
  AVAILABILITY AND COST chokepoint and is run like one: bounded queues
  with a visible backlog, so a stalled gateway or Agent Vault is NAMED
  as the outage by the health window's counters, never just a slow tick
  downstream (carried requirement).
- Motor: its sandboxes are KUBERNETES JOBS created by the Motor module in
  `lifemodel-motor` under its RBAC row — no Docker access at all (Q9 as
  amended); the operator stays control-only and never touches them.
  RBAC authorizes the CREATE verb, not the Job's fields (R5-09), so the
  namespace is Pod Security Admission RESTRICTED and a
  ValidatingAdmissionPolicy refuses a Job template the policy disallows —
  the sandbox's own zero-rights service account, a run deadline from the
  declared Motor run limit, requests/limits required, ephemeral-type
  volumes only (the per-run workspace is a GENERIC EPHEMERAL VOLUME, so
  no PVC outlives its Job); Motor validates the same template before
  submission, cleanup is TRACKED in its run registry (finished Jobs
  deleted; the PANIC'S `lifemodel-motor` step is MOTOR'S OWN CLEANUP —
  Motor deletes the release's RUNNING sandbox Jobs under its own RBAC
  row BEFORE the release's scale to zero: scaling Motor to zero stops
  no existing Job, and the operator stays control-only, never a Job
  deleter), and an interrupted cleanup is re-driven from the registry
  with the cut walked.
- **The one command (F7, amended 2026-10-13; VM shapes and acceptance by
  owner, 2026-10-13).** NixOS is first: the repository flake exports
  `services.lifemodel`, and `nixos-rebuild switch` is the one command.
  Generic Linux (Ubuntu/Debian) uses `scripts/install.sh`. Both install
  only k3s with embedded etcd, pinned Flux, and the root OCI artifact's
  pinned `OCIRepository` plus platform `Kustomization` in `flux-system`,
  rendered from the same `deploy/root/` templates (byte-equal, checked by
  `nix flake check`). The coordinator runs the end-to-end check manually
  over SSH on owner-provided test VMs (NixOS first; Ubuntu for the script);
  the owner restores the clean hypervisor snapshot before each from-scratch
  check. There is no CI walk and no k3d delivery walk. The OCIRepository
  verifies the artifact signature before
  Flux applies it. There is no installer-owned Helm release and no
  installer-held credential. Flux then installs all platform resources,
  including the loader and Gitea. The loader's first start performs the
  resumable initialization described below and adds a second Flux source
  for the Gitea deploy branch; only then can the application Kustomization
  reconcile and the first generation run. Platform and application sources
  use the same release's code seed and pinned revision; no second code
  source is introduced. Dev/CI may use k3d for cluster-mechanics walks.
  Existing-cluster installation is not delivered here: it is deferred to
  lifemodel-xc9, which will use its own namespace and allow each platform
  dependency to be external (for example `openbao.enabled=false`); it has
  no Flux and creates no cluster-scoped resources.
  Nothing in lifemodel's process holds a long-lived key.
- **In-place restarts vs the no-revival rule (R4-08, adapted).**
  Kubernetes restarts a crashed container in place under the pod's
  restartPolicy — ALLOWED, because desired state comes from the branch:
  a restarted process is a FRESH bootstrap (it re-authenticates through
  its service account, holds no persisted material, rejoins its consumer
  group under Q2's rules), and a panic (scale to zero) or a Flux suspend
  leaves nothing to restart. What the rule keeps refusing: new CODE
  arriving by any path other than a rollout the operator drives through
  the deploy branch.

Serves: F7 as amended (one command; no key in lifemodel's process; panic
durable), Q9 as amended (zero Docker facts anywhere), Q8 (the model
key's value appears nowhere in a module pod — the egress/vault split is
the mechanism), Q11 as amended (the static set's memory is a measured
fact), Q13 (the tick is the only boundary; modules only through the
bus).

| Option | Pattern | Evaluation | Verdict |
|---|---|---|---|
| **O5-2026: the Flux-applied Helm chart is the static topology; namespaces + default-deny NetworkPolicy; RBAC (the operator; Motor's Jobs); Traefik with ForwardAuth; egress only through the egress gateway; Motor sandboxes as Kubernetes Jobs** | infrastructure-as-code (GitOps); namespace segmentation; RBAC as the authorization model | Steady state: the chart IS the topology; the policy rows are visible in `kubectl get networkpolicy,rolebinding -A`. Failure: a module cannot reach a surface it does not need — refused by absence of a policy row, not by a certificate check. Security: keys behind Agent Vault one hop off the egress path; no module holds cluster mutation rights. Operability: no cert rotation anywhere, no proxy allowlist to keep current. | **Chosen** |
| **O5-2026d: installer-owned Helm releases for platform components** | installer-managed bootstrap | Rejected: the installer must not own release lifecycle, hold component credentials, or create state outside Flux. All platform components, including Gitea and the loader, come from the signed platform release. | Rejected by owner, 2026-10-13 |
| **O5-2026e: Flux reads the platform source from Gitea** | single Git source | Rejected: Gitea is itself a platform component installed by that source, creating a bootstrap cycle and making platform trust depend on the application Git server. Platform is independently fetched as verified signed OCI; only generations come from Gitea. | Rejected by owner, 2026-10-13 |
| **O5-2026f: install into an existing cluster in this milestone** | Helm entrypoint | Deferred to lifemodel-xc9: this milestone proves only a dedicated VM. The future path has its own namespace, switchable external dependencies, no Flux and no cluster-scoped resources. | Out of scope by owner, 2026-10-13 |
| **O5-2026c: the Compose subset with the ten-network layout, loader-only Docker authority through socket proxies, and Caddy (the pre-platform shape)** | the simplified Compose shape | Rejected by the owner, 2026-10-12 (platform decision): "better to switch to k3s now than suffer with Docker"; the networks become namespaces + NetworkPolicy, the proxies become RBAC, Caddy becomes Traefik, the loader becomes the operator. | Rejected by the owner, 2026-10-12 (platform decision) |
| **O5-A: one trusted supervisor container also running the edge, the vault and the operator** | trusted-supervisor monolith | Superseded by the owner, 2026-10-12 (point 6): separate official-image components — Traefik and Agent Vault leave the operator's pod. | Rejected (superseded by the owner, 2026-10-12, point 6) |
| **O5-B: one flat network (namespace), mTLS workload identity for segmentation** | zero-trust mesh | Rejected by the owner, 2026-10-12 (simplification point 3, same as O2-E): NetworkPolicy + RBAC reach the same isolation goal structurally; mTLS defended deliberate bypass, which the threat model excludes; deferred to the backlog (A3). | Rejected by the owner, 2026-10-12 (simplification point 3) |
| **O5-C: iptables egress rules / NET_ADMIN on module pods** | firewall capability | Superseded by NetworkPolicy: a missing policy row IS the missing route; the capability has no equivalent needed anywhere in the shape (A13). | Rejected (superseded by the owner, 2026-10-12, point 6) |
| **O5-D: a control path outside the deploy branch — a raw Docker socket yesterday, imperative kubectl today** | CLI-driven control | Rejected: the platform decision removes Docker from the cluster entirely (no socket exists to expose); an imperative kubectl path forks the desired state and breaks Flux's reconcile (O3-E). | Rejected (platform decision consequences) |
| **O5-E: modules with direct internet access, no egress chokepoint** | none | Model keys would leave through every module; the egress gateway is the one accountable surface (Q8, F7's no-key rule). | Rejected |

### Q6 — the function engine and the adapter (owner point 6; R3-10 carried)


**Decided: workerd is the first, replaceable function engine; functions use
only the WinterTC common API (lint-checked); engine configuration is
generated from the Helm chart by ONE engine driver in the OPERATOR;
egress routing and bus I/O live OUTSIDE the function — a Channel Adapter
(EIP) between Valkey and the function over HTTP, inside one function-host
module (adapter + workerd). No multi-engine abstraction yet.**

- Taken now because the core will be split into ~30 modules: the
  chart-and-operator seam, the driver pattern, the egress gateway and the
  bus contract are the seams the split will use (point 6).
- Replacing workerd later means writing a second engine driver; the ADR
  records what that takes — the driver reads the manifest's engine block
  and generates the engine's own config; nothing else in the operator
  changes. No abstraction hides this cost today (point 6's explicit
  choice).
- **Function input/output and state are part of the adapter contract
  (R3-10, kept as a requirement).** A function receives EVERYTHING
  through the adapter's delivery of the input event and answers on the
  same delivery (one synchronous answer per invocation, A9): the envelope
  carries the event body, the event's idempotency key, the function's
  declared input schema version, and a correlation id. A function's only
  published influence is `signal.<kind>` events handed back through the
  adapter (the WORKERD process: the zero-credential grant is PER PROCESS,
  R4-05 — the adapter process of the same container carries the adapter
  row's grants). It holds NO credential and makes NO store connection
  (Q7); a long effect is a keyed command event under point 2's rules,
  never a session. What today are plugin storage and scheduler APIs (reminder's
  reminder rows and schedules, news's per-source state with
  `lastFetchedAt`, calories' user properties, web-search/web-fetch's
  settings) become two credential-free paths served BY THE OWNING MODULE
  through the same adapter envelope:

  - **Keyed state/schedule command (write path).** The function returns,
    in its delivery response, a command form DECLARED in its contract
    fragment — `state.set`, `state.delete`, `schedule.set`,
    `schedule.cancel` — each carrying the natural key and the
    correlation id. The adapter publishes it to the bus as the function
    module's keyed command (point 2's rules: done record by key, XACK
    after the result). For all five function modules the owning writer is
    the core module's keyed-command applier (the role reach is already
    there; Q7 adds NO new grant). The applied result event, correlated by
    the same id, is the function's acknowledgement, delivered by the
    adapter on a later call.
  - **State projection (read path).** The function's manifest declares,
    per function, a bounded READ SET — the projection name and the
    natural keys it needs. The owning module publishes a
    `state.projection` bus event — keyed `(module, projection, version)`,
    carrying the applier's MONOTONIC projection position (the shared
    serialization order every consumer orders by, R5-13) — whenever that
    content changes, and the adapter holds the LATEST projection per
    module and attaches it to the delivery envelope. The function never
    polls and never opens a store connection: reads are pushed. The
    projection `version` is CONTENT-DERIVED (a hash of the content), so
    re-publishing unchanged content is the same versioned key and two
    distinct updates of one key cannot collapse; ordering NEVER relies
    on the hash — a hash equal or different says nothing about which
    packet is older, the position does.
  - **Bootstrap projections and the fresh-adapter barrier (R3-10,
    carried; R4-04 decides who serves it).** Every FRESH adapter instance
    — a new instance born at a replacement, or the sole instance after a
    restart — holds no projection cache, and the stream history it might
    otherwise replay is ALREADY ACKED AND TRIMMED by whichever
    predecessor served the group before it. Bootstrap is therefore a
    bounded REQUEST/RESPONSE over the bus, taken from CURRENT DURABLE
    ROWS — never from retained events, never gated on the owning
    module's activation or readiness for work delivery:
    (1) the fresh adapter JOINS its consumer group first, then publishes
    a keyed `bootstrap.request` into `cmd.state` (the stream its
    functions already command on — no new ACL grant) carrying its
    INSTANCE id;
    (2) the OWNING module's keyed-command applier answers on
    `state.bootstrap.<adapter-instance>`, a DEDICATED PROJECTION STREAM
    with the fresh instance's OWN read position (R5-13's lighter
    mechanism — not dual routing over the shared group route): a
    per-instance plain-read fan-out cannot be drained by a competing
    member of group `adapter` during an old/new OVERLAP, so no
    addressed packet can be stolen from the instance it names. The
    applier writes one packet per `(module, projection)` covering the
    requested read set, each packet carrying a MONOTONIC projection
    POSITION (the applier's serialization order — the applier is the
    only writer); every instance records the position it last CONSUMED
    per key, and a later packet is applied only when its position is
    GREATER than the consumed one — ordering and staleness are decided
    by position, never by content hash (a hash says only whether content
    differs, never which of two claimed old packets is older — R5-13).
    Until the retiring instance's confirmed exit (the overlap) the
    applier appends EVERY subsequent `state.projection` change to BOTH
    routes — the instance stream AND the shared `bus` group route —
    DUAL APPEND: a change consumed from the shared route while the fresh
    instance won the group delivery still reaches the STILL-SERVING OLD
    instance (its cache never misses an overlap-window change), and the
    instance stream keeps the fresh cache current through the overlap
    regardless of which member the group's delivery lands on (R5-13);
    RETIRING the stream is a consume-through barrier, not a
    deletion: the instance stream is trimmed only after the fresh
    instance has CONSUMED THROUGH the applier's current position — the
    consumed-position watermark reaching the writer's head — so a
    fresh-adapter crash before the barrier leaves the undelivered
    packets in place for its restart to consume (a crash at the old
    instance's exit loses nothing, R5-13); after the barrier the fresh
    instance reads projections from the shared group route from then on
    (R4-04);
    (3) the ordering is deterministic by construction: the applier's
    publications are serialized and position-stamped, the repair batch
    follows the fresh adapter's join in stream order, and the fresh
    adapter claims a PREDECESSOR's PEL entries only AFTER the repair
    completes AND its watermark has reached the barrier — a claimed
    pre-repair packet for a key the repair already filled is ordered by
    POSITION against the repair's: a position at or below the consumed
    one is DROPPED, counted, never applied backward (a newer repair
    cannot be regressed by an older claimed packet — R5-13); identical
    content is the identical key anyway.
    The ADAPTER's readiness still REQUIRES its declared read set complete
    before its function leg serves any delivery (bounded by the readiness
    window, point 1); a request unanswered past the window is a failed
    readiness reported like any other — never an empty cache presented as
    complete. This order is a named requirement of the design, not an
    optimization (an unchanged core is NOT restarted by it and no
    function or adapter gains store access).
  - **Correlated external-tool routing (`tool.request` / `tool.result`).**
    A function that must reach outside its read set (web-search) returns
    a declared `tool.request` form in its delivery response; the adapter
    holds the delivery un-XACKed, publishes the request as a normal keyed
    command event (the egress gateway takes it, point 2's rules), and
    re-invokes the function with the correlated result — two invocations,
    not a session. A parked delivery counts as an outstanding reference
    in trimming, and an unknown or late result is counted and reported.
- **Function failure handling and adapter acknowledgement (R3-10,
    carried).** The adapter XACKs a Valkey delivery only when the
    function answered (a signal or a response) or when a deliberately
    bounded number of attempts (an operator setting, named at outcome-6
    design time) ended unavailable. A crashed HTTP invocation loses
    nothing: the delivery stays in the consumer-group PEL, re-delivers,
    and every function output carries the input event's idempotency key,
    so a re-run is absorbed idempotently — the same at-least-once + keyed
    contract as every other bus path (point 2). A permanently failing
    function's failure is a counted output (a completed-work/failure
    datum for the health window) and appears in the rollout report.

Serves: F6 as reshaped (point 5 — the five plugins become function
images), Q13 (signals only on the bus), Q12 (one changed plugin = one
function module rebuilt), Q11 as amended.

| Option | Pattern | Evaluation | Verdict |
|---|---|---|---|
| **O6-2026: workerd first, one engine driver, Channel Adapter inside the function host; push projections + declared keyed commands; correlated tool routing** | engine-driver pattern; EIP Channel Adapter; published-read-set (star topology around the owning module) | Steady state: a function is pure compute over (event, projection) -> (signal, command); no credential, no connection. Failure: the adapter's ack rule makes a crashed invocation a re-delivery under the same key. Operability: the WinterTC lint is mechanical; the read set is declared, auditable. | **Chosen** |
| **O6-A: functions as normal Node modules inside the core image (today's plugins)** | status quo | Rejected by the owner, 2026-10-12 (point 5): the five feature plugins become function images in this milestone, all five; their influence on the body = signals on the bus. | Rejected (superseded by the owner, 2026-10-12, point 5) |
| **O6-B: a function holds its own store credentials and manages its own rows** | self-service state | The point-2/point-4 shape removes it: a function's whole influence is the adapter envelope; store access would add a credential and a writer to every function (Q7's role map refuses it). | Rejected |
| **O6-C: a multi-engine abstraction now** | portability layer | No second engine exists; the abstraction would be written against one engine (point 6's "no multi-engine abstraction yet"). | Rejected (deferred by design: the driver seam IS the extension point) |
| **O6-D: functions poll the owning module for their read set** | polling | Violates emergence-over-polling (design principle 2); the push projection plus bootstrap barrier answers the fresh-adapter case without a poll. | Rejected |

### Q7 — how credentials reach a module, and revocation at the switch
(owner point 7; the platform decision replaces the delivery mechanism)

**Decided (owner point 7; the R5-04 owner decision of 2026-10-12 names
the mechanism): OpenBao issues short-lived Postgres and Valkey
credentials per MODULE ROLE with least privilege, delivered by the
Bank-Vaults secrets webhook's vault-env in DAEMON MODE — the webhook's
mutating admission adds an init container that copies the `vault-env`
binary into a shared volume and wraps the module container's command;
vault-env authenticates with the pod's KUBERNETES SERVICE ACCOUNT
(Kubernetes auth; the projected JWT is the only bootstrap material,
nothing is delivered to the pod), resolves the pod's secret references
into environment variables, flushes the login token, and stays the
process's PARENT: it execs the module process, renews leases, and exits
— so Kubernetes restarts the container — when a renewal fails or a
credential actually changes (never into the pod spec, never a Kubernetes
Secret, never etcd).**

**Bao's own trust and unseal path (R5-06) is part of the decision, not an
assumption.** OpenBao uses the chart's default Shamir seal. The loader is the
sole steady-state custodian; the owner decision is “OpenBao unseal key held
by the loader.” On first boot the loader calls `sys/init` (one Shamir key
share, threshold 1), immediately writes the unseal key and initial root token
to its platform-owned Kubernetes custody Secret in `lifemodel-system`, and
verifies complete read-back before continuing. The accepted crash window
between init and custody write fails visibly into maintenance for owner
recovery; the loader never silently initializes a second time. On every
restart where Bao is sealed, the loader reads its custody Secret and calls
`sys/unseal`; missing custody or failed unseal stops visibly in maintenance.

The loader uses the initial root token only to install required auth methods,
policies and roles, then verifies its own steady-state Kubernetes-auth role
and successful login before revoking the root token. This verified
bootstrap-to-steady-state hand-off is: Bao root bootstrap -> loader's
Kubernetes-auth role and policy installed -> login verified -> root token
revoked. Thereafter the loader uses its normal role for permitted loader
paths while retaining only the separate ability to read its unseal key and
unseal on sealed restart. The generation operator uses Bao only through its
normal Kubernetes-auth role for runtime operations; it never initializes,
unseals, holds custody, or retires the root token. The loader starts before
Bao is ready and has no Bao dependency during bootstrap. No module pod starts
before the verified hand-off.

**Gitea credentials (owner, 2026-10-13, "Gitea").** These are repository
roles, separate from the module-role table below:

| Identity | Gitea authority and delivery |
|---|---|
| Flux | Read-only deploy key or token for the repository, used by the Flux `GitRepository` source; no write credential. Flux supports GitRepository authentication with SSH keys and tokens (https://fluxcd.io/flux/components/source/gitrepositories/). |
| Loader (first start) | Creates the chart-supported initial Gitea administrator using a generated Secret referenced by chart 12.7.0 `gitea.admin.existingSecret` with `initialOnlyNoReset`; retains the Secret while any rendered chart object references it (R6-05). Platform chart owns Gitea thereafter. |
| Generation operator | Sole writer of protected `main` and deploy branches and merger of task PRs after gates. The administrator credential is held in OpenBao for authorized operator use; no credential is placed in chart values or a Job. |
| Self-change task | A separate named non-admin account `lifemodel-task` has access only to this repository. The operator authenticates to the Gitea API as that account to mint a per-run token with the `read:repository`, `write:repository`, `read:issue` and `write:issue` scopes (repository Git and pull-request API; no admin/account scopes) (the 1.27.0 personal-token API has scopes, not repository-id selection or server expiry). The task can push `task/*` and open/update PRs. Operator-only direct-push AND merge allowlists protect `main` and deploy at the highest-priority branch rules; tasks have no admin bypass. Rules also refuse protection edits and unprotected-file writes. The accepted residual authority is task-account writes to other unprotected branches/tags and PR metadata in this repository; access to any second private repository is denied. Durable per-run issuance intent, unique token name/id, maximum lifetime, and pending revocation are recorded before delivery; after a lost mint response, recover by account/name identity, never blindly mint again. On every run outcome and operator restart, reconcile revocation; retry visibly and remove the OpenBao value. No new self-change run starts while cleanup is unresolved. Gitea itself has no token expiry: lifetime is operator-managed and is not server-enforced during operator outage. A copied token must fail both Git and API access after confirmed revoke. |

The role map is PER PROCESS, not per container (R4-05): one container may
host processes of different reach — the function host holds the adapter
process and the workerd process — and zero credentials attach to the
PROCESS: a process runs with a SCRUBBED environment unless its row below
grants something (the OpenBao Agent supervises each process environment;
a container is not a credential boundary, a process is). Simplified: no
executor, no fence module, no completion capabilities — the roles the
removed machinery held are gone with it:

| Process | Valkey consume (group) | Valkey produce | Postgres | Other |
|---|---|---|---|---|
| core | `bus` (`core`), `cmd.state` (`state`), `inbound` (plain read; the offset rides the snapshot) | its commit outbox onto `bus`, `cmd.send`, `cmd.motor`, its own `cmd.egress.<core>`, and the addressed `state.bootstrap.<adapter-instance>` repair/overlap streams — position-stamped, dual-appended to `bus` through the overlap, trimmed behind the instance's consume-through watermark (R4-04, R5-13) | epoch-checked tick snapshot commit (the Lua CAS, Q2) + `pg.apply` on ITS OWN schema | — |
| adapter (the function host's bus process) | `bus` (`adapter`, incl. `http.result` for its parked deliveries and `state.projection` — dual-appended through an overlap, R5-13) and its own `state.bootstrap.<self>` (plain read at the instance's OWN position, R4-04; consumed-through watermark before the stream's trim, R5-13) | `cmd.state` (`state.command` forms + `bootstrap.request`), `cmd.egress.<function-host>` (`tool.request`), and the function's declared `signal.<kind>` on `bus` | ITS OWN schema only (the adapter's done records) | ACK + XAUTOCLAIM its group's entries |
| workerd (the function-host's engine process) | NOTHING | NOTHING | NOTHING | NO credential of any kind; sources no store client |
| ingress gateway | `cmd.send` (`send`) | `inbound` (the ingress-only user) + `send.settled` on `bus` | its own schema; PLUS the two named narrow grants (SELECT transcript, INSERT-by-key `conversation_message` in the core's schema) | extract + insert-by-key per R4-01 |
| egress gateway | EVERY `cmd.egress.<module>` stream (`egress`) | `http.result` on `bus` | its own schema only (its done records) | Agent Vault for key injection |
| Motor | its own `cmd.motor` stream | `motor.result` on `bus` + its own stream and its own `cmd.egress.<motor>` | its own schema only | — |
| every other module | its own `cmd.<module>` stream | its own stream + its own `cmd.egress.<module>` | its own schema only | — |

The identity rule is unchanged and stays PRODUCER-side: a process XADDs
only its OWN stream, so the command's stream name remains the caller's
verified identity. Consuming another module's command stream is not
publishing and grants no identity: the egress gateway's group membership
on the `cmd.egress.*` set is the one designed cross-consume, and its
producer identity on the bus is its XADD of `http.result` (the ACL grant
names the exact stream, not a wildcard).

Per-module Postgres credential on its own schema only (point 0's kept
barrier; the roles are declared per module schema through CNPG, Q4): a
bug is contained to one schema; a mutation of data another module owns
is a keyed bus command applied by THAT module's writer, never a
cross-schema grant.

- **Secret zero.** No component delivers a secret to a module: the pod's
  ONLY bootstrap material is its Kubernetes service account (a projected
  JWT the kubelet rotates); OpenBao authenticates it through Kubernetes
  auth and issues the module role's leases. There is no wrapped
  secret-id to capture, replay or expire on a delivery path.
- **Credential visibility.** Credentials live in the MODULE PROCESS's
  environment, resolved by vault-env at runtime — the pod spec carries
  only the webhook's secret-reference annotations and NO credential
  material (no `env` secret values, no `envFrom` secret references, no
  volumes of secrets, nothing in etcd-backed Secret objects).
  The old named leak surface (`docker inspect`) becomes the pod spec;
  the same guarantee carries in the platform's terms. The one fallback
  that would put a credential in the pod spec (operator-rendered env,
  A5) is a RECORDED POSTURE DOWNGRADE, never a default.
- Revocation is PER RETIRED INSTANCE, never generation-wide (R4-07): the
  operator REVOKES a replaced module's leases only when the operator
  CONFIRMS that pod's termination. A start-first replacement keeps the
  old pod's leases until then — its in-flight work runs on them — and
  every UNCHANGED module's leases are untouched by the rollout. For the
  core (stop-first) the confirmed exit already precedes the new core's
  start, so the revocation immediately precedes it — the enforcement
  half of the stop-first order, Q2. A revoked lease's connections die
  with it.
- Max lease TTL: 7 days (`LIFEMODEL_LEASE_MAX_TTL`, DECIDED). A
  credential CHANGE restarts the supervised process; a renewal does not.
- Rule: a module does not start unvetted child processes inheriting its
  environment.
- Model keys stay behind Agent Vault via the egress gateway; the unseal
  key is loader-held — the chart's default Shamir seal, initialized ONCE by
  the loader on first boot with key and initial root token in the platform
  `lifemodel-system` custody Secret, auto-unsealed by the loader on every
  sealed restart, and the initial root token revoked after the verified
  loader-role hand-off (R5-06).
- **Lease lifecycle (R3-16, carried as a requirement, re-mechanized).**
  A pod never authenticates from persisted material: at every process
  start — including Kubernetes' in-place restart of a crashed container
  (Q5) — the agent re-authenticates with the service account and
  re-issues fresh leases; an Agent crash takes its supervised process
  down with it and the same restart supplies a fresh boot. A
  REPLACEMENT (new code) is never Kubernetes self-healing: it arrives
  only through a rollout the operator drives through the deploy branch
  (Q5's adapted rule). Renewal and expiry are INDEPENDENT of OpenBao's
  availability — by a LOCAL rule, not by Bao-side grace (R5-20): the
  supervising agent (vault-env in daemon mode, the R5-04 owner decision)
  holds the lease's ISSUE TIME and TERM and enforces a LOCAL
  lease-validity deadline (issue time + term,
  on the process's own clock); renewals are attempted on their schedule,
  and a RENEWAL FAILURE past that deadline is a VISIBLE LOCAL failure —
  the process STOPS WORK at the deadline (it exits nonzero, naming the
  expired lease; Kubernetes restarts it and the fresh process
  re-authenticates when Bao returns). This is what makes expiry real:
  an issued Postgres or Valkey session does NOT end merely because its
  lease expired, and server-side revocation cannot be relied on while
  Bao is down — stopping work at the local deadline is the mechanism,
  never an assumed revoke; the module fails VISIBLY (counted
  and reported, never a silent degradation), and the operator
  re-bootstraps it when Bao returns. Lease issuance at a generation
  start is STAGGERED (an operator setting bounds the spread), so the
  module set's leases do not all reach max TTL together.

Serves: Q8 (no key in any lifemodel process; injection invisible to the
pod spec), Q9 as amended (per-module least privilege; the identity rule
without certificates), point 0's kept barriers (the SQL grants — owned
by the migration set over CNPG-managed group roles — enforce the schema
containment, R5-16).

| Option | Pattern | Evaluation | Verdict |
|---|---|---|---|
| **O7-2026: per-module OpenBao roles; Kubernetes auth by service account (projected JWT); the Bank-Vaults secrets webhook placing vault-env in each module container, daemon mode (parent + exec, lease renewal, exit on failure); revoke the RETIRED pod's leases at its confirmed exit (R4-07)** | leased credentials / dynamic secrets; workload identity via platform-native tokens; an in-container daemon supervisor (vault-env), placed by webhook mutation | Steady state: least privilege is per module — a function cannot read Valkey or Postgres at all; the egress gateway touches only Agent Vault. Failure: a restarted process re-authenticates through its service account; a renewal failure exits the process and Kubernetes restarts it; a revoked pod's connections die with its leases. Security: the pod spec carries no credential material; the only bootstrap material is platform-rotated. Chosen by the owner, 2026-10-12 (R5-04): the exact setup the owner runs. | **Chosen** |
| **O7-D: the official chart's OpenBao Agent Injector — agent init/sidecar containers rendered by webhook mutation, file templates in a shared volume** | per-pod injected agent sidecar | Rejected by the owner, 2026-10-13 (R5-04): the injector is not a supervisor of the application process (its `exec` covers only its own agent child) and normally renders files, not the environment contract this design states; the Bank-Vaults secrets webhook with vault-env in daemon mode is what the owner runs in their own cluster, OpenBao supported — the Kubernetes-auth service-account login carries over unchanged. | Rejected by the owner, 2026-10-13 (R5-04) |
| **O7-2026c: the same roles delivered by OPERATOR-GENERATED single-use response-wrapped AppRole secret-ids (the pre-platform mechanism)** | wrapped bootstrap tokens | Rejected by the owner, 2026-10-12 (platform decision): "service account login replaces wrapped AppRole secret-ids"; delivering a secret to a pod — however single-use — is the leak surface the platform removes. | Rejected by the owner, 2026-10-12 (platform decision) |
| **O7-A: credentials in Kubernetes Secret objects referenced from the pod (`envFrom`/`env`), static or externally synced** | platform-native secret volume/env | Rejected: the pod spec is a READABLE surface (RBAC for it is easy to over-grant) and a referenced Secret is not per-process scoped and not short-lived by default; vault-env keeps every credential dynamic, per process, and out of the spec. | Rejected |
| **O7-A2: OpenBao dynamic credentials per GENERATION, injected by the OPERATOR as environment** | loader/issuer-mediated injection | Superseded by the owner, 2026-10-12 (point 7) on both halves: scope moves from generation to module role (finer), and injection moves from operator-set env (readable in the pod spec, a leak surface the owner named) to in-container vault-env injection (daemon mode). The revocation rule carries over, now shaped per retired pod at confirmed exit (R4-07). | Rejected (superseded by the owner, 2026-10-12, point 7) |
| **O7-B: static shared credentials in the chart values/environment** | shared secret | One leaked static password is eternal and unscoped; short-lived, scoped, revocable expiry fails outright — and chart values are read surfaces too. | Rejected |
| **O7-C: the module holds an OpenBao token and fetches its own secrets** | self-service workload identity | Functions hold NOTHING and even the core holds no OpenBao token beyond the service-account login the agent performs; a compromised module cannot mint credentials. | Rejected |

### Q8 — format migrations and the bus contract (owner point 8; point 5; unchanged by the platform decision except who applies)


**Decided: no down migrations; the bus contract is AsyncAPI + JSON Schema
in the repo, checked FULL-compatible (both directions) at build; Postgres
migrations are expanding-only, linted by squawk; the compatibility check
is bound to the COMMIT PAIR — schema FILES compared at every rollout, not
data exercised through throwaway readers (point 5).**

- **FULL compatibility, both directions, at build** — because old and new
  read each other's events during a per-module rollout (point 1's mixed
  old/new window relies on it). The check compares the schema FILES of
  the running commit and the candidate (Confluent Schema Registry style),
  not only manifests.
- **A breaking change = a new event type** published beside the old one
  for a while; the old is removed by a later contract step. Every
  "would be breaking" change becomes non-breaking this way.
- **Unknown event types are a READER rule, not a crash:** a consumer that
  receives an event type it does not know ACKs it and drops it by
  default (Tolerant Reader); a consumer whose semantics could
  double-apply another reader's effect carries an EXCLUDE list in the
  contract, checked in BOTH directions by the build-stage contract
  check. Dual publication never fires a duplicate effect: every command
  event keeps its minted effect key, and the destination contract
  (keyed/unkeyed classes, point 2) absorbs the re-delivery — the old and
  new publications share the key, so the done record answers the second
  delivery; it is not a new effect.
- **Snapshot envelope: versioned, additive fields, Tolerant Reader**
  (owner point 8). A generation seeing a NEWER snapshot version refuses
  to start and reports why; "the predecessor reads my snapshot" is
  checked at build. The version moves ONLY on a format break: fields
  added with defaults do NOT change it (old readers accept and ignore
  them); a removed, renamed or re-typed field is a break. A candidate
  that moves the version without a breaking change fails the build.
- **The compatibility window is decided by the point-5 comparison, not by
  a registry.** An older generation is INSIDE the window iff its schema
  and snapshot-version rules accept the current dataset — checked at its
  boot by the same file comparison (candidate files vs the versions the
  running stores carry) and by the snapshot version rule; outside it,
  the boot REFUSES with the reason naming the failing comparison. F5's
  "older generation boots within the window; others refuse with the
  reason" is exactly this rule.
- **Postgres: one schema per module** (`CREATE SCHEMA`); the module's
  OpenBao role has rights ONLY on its schema (Q7). WHO enforces that
  containment is named, not implied (R5-16): CNPG's declarative role
  management manages each module's FIXED NOLOGIN group role; the
  migration set owns the GRANT and ALTER DEFAULT PRIVILEGES SQL that
  gives that role its schema/table/default privileges (tables a
  migration creates are granted by the SAME migration, so a newly
  migrated table is usable by the module role the moment it exists); the
  OpenBao database role for a module is a leased LOGIN user with
  `INHERIT` on the group role — the declared role ATTRIBUTE alone proves
  neither usable access nor refusal, the grants do. Migrations are
  expanding-only — squawk bans drop/rename of column or table, type
  change, and NOT NULL without default — and are applied by the OPERATOR
  before the rollout (a dbmate run under a DDL role separate from every
  module role — on k3s a Job the operator executes, recorded in the
  rollout record).
  Contract steps (the removal half of expand/contract) come in later
  commits — NOT in this milestone (R4-15): the milestone's gate is
  expand-only FULL compatibility and deprecated items are marked now,
  never removed. A later contract step that REMOVES a deprecated shape is
  admissible only when BOTH hold, checked by the same point-5 comparison
  at its rollout: (a) the compatibility-window rule can no longer admit
  any generation that still consumes or produces the old shape — every
  commit the window could boot reads the new shape only; (b) no
  outstanding bus reference can still deliver under the old shape — every
  retained stream entry naming it has passed the trim floor (N-21) and no
  retained snapshot copy's pending-effect list still names the old type
  (R4-10's re-issue paths). Failing either, the trimming candidate is
  refused with the diff as the report, exactly like any other break.
- **The migration tool is DECIDED: dbmate + squawk** (point 5 closes the
  old open question): language-neutral plain SQL, behind a narrow
  interface, replaceable.
- **The commit-pair rule (point 5) closes R3-06 without admission
  records:** the operator compares the running commit's and the candidate's
  schema and migration FILES at EVERY rollout, even when every image is
  reused — a reused image cannot carry stale compatibility because the
  check rides the commit pair, not the image. What the removed
  predecessor-reader runs caught beyond this (semantic drift inside a
  column) is caught by review and the health window — the owner's rule:
  a column's meaning never changes; a new meaning = a new column (A11).

Serves: F6 as reshaped (migrations expanding-only), point 1's mixed
old/new window, Q13 (the contract files are the interface review reads),
A11.

| Option | Pattern | Evaluation | Verdict |
|---|---|---|---|
| **O8-2026: AsyncAPI + JSON Schema with FULL both-ways file comparison at build; breaking = a new event type beside old; additive tolerant-reader snapshot with newer-refuses; per-module PG schemas; expanding-only squawk-linted migrations applied by the operator under a DDL role; dbmate + squawk** | consumer-driven contract testing (AsyncAPI); Tolerant Reader (Hohpe); expand/contract; per-module schema isolation | Steady state: the contract file IS the bus standard ("the load-bearing standard", point 6); a module's schema is its own. Failure: format mistakes are build/rollout failures with a diff for a report, never a guess. Operability: the migration tool is swappable; no down path exists to maintain. | **Chosen** |
| **O8-A: versioned up/down on snapshot, schema and envelope; operator-executed downs; whole-suffix bus conversion; durable resumable transition record** | expand/contract WITH downgrade | Superseded by the owner, 2026-10-12: the down machinery existed to let old code follow new data, which the predecessor-reads-everything-I-write invariant plus FULL both-ways event compatibility answer at build time. Its useful halves are retained: versioned additive snapshot with newer-refuses, expansion preferred. | Rejected (superseded by the owner, 2026-10-12; halves retained) |
| **O8-B: forward-only migrations + data regenerated on demand** | event sourcing rebuild | The journals a rebuild needs do not exist (bus journal replay is explicitly out; conversation rows and memory have no rebuild source). | Rejected |
| **O8-C: best-effort in-place conversion without version refusal** | none | "Refuse when uncertain" is a carried owner rule; a guessing converter writes garbage with epoch authority behind it. | Rejected |
| **O8-D: throwaway Postgres reader runs against candidate-written data (the round-3 PG check)** | consumer-driven contract testing against real data | Rejected by the owner, 2026-10-12 (simplification point 5; same decision as O1-F): schema FILES compared commit-pair-wise plus squawk's expanding-only lint replace running readers on data. | Rejected by the owner, 2026-10-12 (simplification point 5) |

## Round 7 enforcement contracts (2026-10-13)

These contracts resolve R7-01 and R7-02. They refine the two fixed GitOps layers; they do not add an installer or reopen the owner decisions.

### Application-layer authority (R7-01)

Each application `Kustomization` object lives in its target namespace (`lifemodel` or `lifemodel-motor`), and its explicit `spec.serviceAccountName` names the platform-created applier ServiceAccount in that same namespace. Each application `HelmRelease` also lives in its target namespace and sets its own explicit `spec.serviceAccountName` to that namespace's platform-created applier. Flux impersonates based on the namespace of each API object; a targetNamespace field does not move the Kustomization's identity. Each target applier has a platform-owned Role and RoleBinding in its target namespace for application resources, and has NO Secret permissions there. For Helm storage only, its ServiceAccount is separately named as the subject of a RoleBinding in the corresponding dedicated storage namespace, where a Role grants Secret get/list/watch/create/update/delete. A RoleBinding can bind a ServiceAccount from another namespace; the subject is the target namespace's applier, not either Flux controller identity. The storage namespaces (`lifemodel-releases` and `lifemodel-motor-releases`) are created and owned by the signed platform release, contain only Helm release Secrets, have default-deny policy and no workloads, and are inaccessible to generation sources. Missing, unknown, cross-namespace, or privileged identities fail closed at admission and source validation. Pin the Kustomization targetNamespace to its own namespace, pin the in-cluster kubeconfig, and reject remote `kubeConfig`, cross-namespace object references except the explicit storage RoleBinding subject, nested reconcilers except the same-namespace HelmRelease edge, and namespace/CRD/cluster-scoped output. Run Flux with multi-tenancy lockdown, including `--no-cross-namespace-refs`; the controller service accounts are restricted as documented by Flux. The signed platform release declaratively provisions these identities, bindings, storage namespaces and policies. The loader cannot create or change them and has no RBAC-writing grant.

Each target namespace also has its own platform-created GitRepository for the deploy branch, and the loader writes the read-only credential Secret in that namespace. Source-controller reads that credential under its own controller identity; the applier never reads it. The two Kustomizations reference only their local source. Their only permitted nested edge is to a same-namespace HelmRelease; each HelmRelease obtains its chart from that namespace's same GitRepository, at the chart path in the deploy branch. Each HelmRelease explicitly sets `spec.storageNamespace` to its dedicated storage namespace: `lifemodel-releases` or `lifemodel-motor-releases`. Flux documents `spec.storageNamespace` as the namespace where Helm stores release information, defaulting to the HelmRelease namespace, and documents that `spec.serviceAccountName` is impersonated while reconciling the HelmRelease ([HelmRelease storage namespace](https://fluxcd.io/flux/components/helm/helmreleases/#storage-namespace); [service account reference](https://fluxcd.io/flux/components/helm/helmreleases/#service-account-reference)). The dedicated RoleBinding in that storage namespace binds the HelmRelease's applier ServiceAccount from its target namespace and grants Secret get/list/watch/create/update/delete there. The applier has no Secret rights in `lifemodel` or `lifemodel-motor`; no admission policy is claimed to filter reads.

The HelmRelease impersonation identity is mandatory independently of the Kustomization identity: the latter cannot confer its authority on `helm-controller`. Platform-owned admission policy validates rendered objects and hooks as well as source paths and rejects protected kinds, protected names, disallowed fields, and any cross-namespace/storage target. Inside the two shared namespaces, platform-owned namespace accounts, default-deny/allow NetworkPolicies, isolation labels, and RBAC are reserved objects: application roles may change only the explicitly enumerated generation workload objects and fields. They cannot alter platform policy, add an allow-all policy, or edit platform accounts, Roles, RoleBindings, or ServiceAccounts. A versioned ownership allowlist defines permitted resource kinds/names/fields; no unlisted object is permitted. Flux references: [Kustomization ServiceAccount reference](https://fluxcd.io/flux/components/kustomize/kustomizations/#service-account-reference) and [RBAC](https://fluxcd.io/flux/components/kustomize/kustomizations/#role-based-access-control); [HelmRelease ServiceAccount reference](https://fluxcd.io/flux/components/helm/helmreleases/#service-account-reference) and [RBAC](https://fluxcd.io/flux/components/helm/helmreleases/#role-based-access-control); [multi-tenancy lockdown](https://fluxcd.io/flux/installation/configuration/multitenancy/).

### Loader bootstrap identity and phases (R7-02)

The loader is a separate first-start process in the platform release, not the generation operator. Its platform-declared `lifemodel-system` ServiceAccount has only the bootstrap grants listed here; it is available before Bao is initialized and does not authenticate to Bao to bootstrap Bao. The loader writes Shamir/root custody to a platform-owned Kubernetes Secret in `lifemodel-system` and verifies read-back before continuing. That custody, the generated initial-admin Secret in `lifemodel-git`, the two read-only deploy-branch credential Secrets in `lifemodel` and `lifemodel-motor`, and the loader's phase record are outside both Flux prune inventories and are protected from overwrite by either GitOps layer. The signed platform release creates a `GitRepository` in each target namespace, referencing its local credential Secret and the deploy branch.

The loader's Kubernetes grants are narrowly scoped: create/read/update its own phase record, the named custody/admin Secrets, and one read-only source credential Secret in each target namespace; create/read/update exactly two application `Kustomization` objects, one in each target namespace; and patch only the selected digest field of the installer-owned root `OCIRepository` after explicit owner authorization. The platform release, not the loader, creates the two local `GitRepository` source objects. It cannot change the root verifier, source URL, service accounts, Roles, RoleBindings, platform Kustomization inventory, or arbitrary Secrets. Its Bao grants start only after Bao custody is persisted and Bao is unsealed, and then cover the named bootstrap setup paths and verification operations; its Gitea credentials are limited to initial administrator setup, repository seed/protection and creation of the read-only source account. The generation writer has none of the root pin, root verifier, bootstrap custody, platform source, or platform-secret grants.

The phase order is durable and idempotent: (1) establish/read back Bao custody without a Bao dependency; (2) unseal Bao; (3) create the chart admin Secret and await Gitea, without requiring aggregate platform readiness that waits on the application source; (4) verify administrator login; (5) seed and protect the repository; (6) establish and verify both read-only source credentials; (7) verify the platform-created local GitRepositories and create the two local application Kustomizations; (8) verify healthy source and Kustomization reconciliation before admitting the first generation. The loader runs before Gitea readiness and Bao unseal. Neither platform aggregate readiness nor a Bao-dependent webhook may gate loader startup. The hand-off to steady-state Bao identity is verified before bootstrap authority is retired. All grants and phase cuts are exercised under the actual loader ServiceAccount; denied platform operations are exercised under the generation writer identity. The known init-to-custody crash window remains the visible owner-recovery case stated in this ADR, not an automatic retry.

### Loader policy routes (R7-02)

The loader's exhaustive network and API grants are enumerated as P28-P30 in
the design. Kubernetes API authority is limited to its phase/custody Secrets,
the owner-authorized root OCIRepository digest pin field, creation/read-back
of two application Kustomizations (one in each target namespace), and
verification of the platform-created deploy-branch GitRepositories there.
The loader writes only the read-only credential Secrets referenced by those
local sources. Gitea authority is limited to admin bootstrap, release
seeding, branch protection, and creation/verification of the read-only
deploy-source credential. Bao
authority is limited to initialization, seal status/unseal and bootstrap
`sys/`/auth/policy paths, followed by its own steady-state role. The
`loader-model` policy grants create/update/read on
`lifemodel/data/model/primary`, create/update/read/delete only on
`lifemodel/data/model/reserve`, and read-only model metadata; it is provisioned
and verified before root revocation. Loader model-check egress is `0.0.0.0/0`
except pod CIDR `10.42.0.0/16`, Service CIDR `10.43.0.0/16`, and
`169.254.0.0/16`, without port restrictions; TCP 11434 to namespace `ollama`
is the only in-cluster model exception. No loader route grants a generation writer platform authority, and no loader route
creates or edits RBAC.

### Gitea chart and root-source ownership (R7-03, R7-04)

The signed platform values for the official Gitea chart `12.7.0` MUST set `postgresql-ha.enabled=false`, `postgresql.enabled=false`, `valkey-cluster.enabled=false`, and `valkey.enabled=false`; select `gitea.config.database.DB_TYPE=sqlite3` and the chart-supported built-in queue/cache behavior. These are explicit overrides, not inferred defaults. Rendered output must contain no bundled PostgreSQL/Valkey workloads or PVCs. Set `gitea.admin.username: ""` and `gitea.admin.password: ""` explicitly while the generated `gitea.admin.existingSecret` supplies the initial admin credential. Any reference-retirement release first disables admin configuration, proves no fallback admin/password input exists, renders and starts a replacement Pod, and verifies login using Bao-held credentials before retiring the old Secret. Persist and verify each cut; never delete a Secret while any live rendered object references it. The official chart archive and templates named above are the configuration evidence.

The trust root is not in the authenticated artifact's inventory. The installer creates the root `OCIRepository`, its Cosign verification identity and the root `Kustomization` outside the signed artifact inventory. The root source is pinned by digest; its `verify` issuer/subject matchers are installer/root-policy-owned and cannot be changed by the loader or artifact. The owner-authorized loader alone may change the selected digest through its narrow patch permission; the artifact cannot declare, adopt, patch, or prune either root object. The root Kustomization inventory is restricted to platform resources and excludes the root source and Kustomization themselves. Kubernetes etcd persists the root objects across Flux, loader and node restarts; the loader's durable owner-selection record reconciles the authorized digest after restart. A competing artifact apply cannot revert a pin or replace the verifier. Exercise an owner repin while Flux reconciles, reject artifacts attempting to change the verifier or pin, and verify the selected digest after all three restart cuts.

### Platform-upgrade recovery and source networking (R7-05, R7-06)

A platform upgrade is a durable, owner-commanded attempt record containing exact previous and target OCI digests, chart/component versions, supported upgrade path, current application deploy-branch revision, compatibility result, recovery-material evidence, phase, deadlines and outcome. Before changing the pin, the loader verifies the target signature, supported component paths and compatibility with the running application; it acquires a durable upgrade lock only after confirming application quiescence (no open rollout step or active rollback), then prevents generation selection/deploy-branch writes while leaving application source reconciliation active at the recorded revision. The lock is released only after durable success or an owner-resolved failure. Each bounded phase is reconciled from recorded state after crash. The loader and owner recovery UI remain reachable: upgrades may not replace their only access route until the replacement is independently healthy and owner access is verified.

A prior digest is safe to select only when the attempt proves no irreversible schema/data migration occurred and component compatibility remains valid. Otherwise the system refuses pin rollback and holds for explicit forward repair or owner recovery; it never downgrades Gitea/SQLite or prunes durable state to recover. Helm failure remediation is configured to retry/report without implicit Helm rollback or uninstall after a potentially irreversible migration; owner recovery is required. Any upgrade that can migrate Gitea SQLite or other durable storage requires verified, restorable recovery material for the exact source revision before execution. Since the one-volume Gitea backup/restore is deferred, such Gitea/storage upgrades are refused/deferred in this milestone. Walk success, partial apply, crash/restart, loader/UI loss, concurrent app writes, a safe prior-pin return, and refusal of an unsafe downgrade.

P15 is the complete Flux source path under default-deny egress. The Flux release pinned by the installer at implementation must be at least Flux 2.2.0 (source-controller 1.2.0), which supports `OCIRepository.spec.verify.matchOIDCIdentity`. For keyless verification, the root `OCIRepository` uses `spec.verify.provider: cosign` and the single identity: issuer `^https://token\.actions\.githubusercontent\.com$`; subject regexp `^https://github\.com/shady2k/lifemodel/\.github/workflows/release\.yml@refs/tags/v.*$`. The `release.yml` publisher signs the same artifact digest with this identity; no second keyless publisher/verifier identity is permitted. The installer also supports public-key verification through `secretRef`. Keyless verification uses the Sigstore public-good instance, online; Rekor and TUF must be reachable. The exact world-facing signed-fetch hosts on TCP 443 are `ghcr.io`, GHCR's blob host `pkg-containers.githubusercontent.com`, `tuf-repo-cdn.sigstore.dev`, and `rekor.sigstore.dev`, plus the configured GHCR token endpoint (normally `ghcr.io`). DNS is also required. For in-cluster delivery, `kustomize-controller` and `helm-controller` fetch artifacts from the `source-controller` Service in `flux-system` on TCP 80, forwarded to container port 9090. These platform-owned routes do not traverse application egress. Test a real signed artifact fetch and re-verification after policy installation and source-controller restart, plus cache-loss behavior. Sources: [Flux OCIRepository verification/keyless docs](https://fluxcd.io/flux/components/source/ocirepositories/#verification); [source-controller Service, port 80](https://github.com/fluxcd/source-controller/blob/v1.2.0/config/manager/service.yaml) and [container port 9090](https://github.com/fluxcd/source-controller/blob/v1.2.0/config/manager/deployment.yaml); feature commit https://github.com/fluxcd/source-controller/commit/d855805b8f6f85ce07224052455fb925a05e6149 and minimum Flux distribution release https://github.com/fluxcd/flux2/releases/tag/v2.2.0; GitHub container-registry and hosted-runner network docs https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry and https://docs.github.com/en/actions/concepts/runners/github-hosted-runners; Sigstore public-good/TUF docs https://docs.sigstore.dev/cosign/system_config/installation/.



#### R7-05 second-pass — platform upgrade order, recovery and arbitration

The platform root uses the same root OCI source for these ordered Flux
`Kustomization` objects. A0 applies the loader, its Traefik route and its
policies first, with `wait: true`; A0 starts without OpenBao or Gitea and has
no `dependsOn` on A or B. A applies backing services (OpenBao, Gitea, registry,
CNPG operator and Agent Vault), has `dependsOn: A0` and `wait: true`; the
loader's first start initializes/unseals OpenBao and bootstraps Gitea so A's
readiness completes. The loader's A0 egress also permits the model checker to
reach public HTTP(S) and RFC1918 LAN endpoints, excluding configured pod
(`10.42.0.0/16`), service (`10.43.0.0/16`) and link-local CIDRs, plus TCP 11434 only to the named `ollama` namespace; its
application checker validates destinations before connecting. B applies the generation operator with `dependsOn: A`
and `wait: true`. The loader's bootstrap inventory and dependencies therefore
have no first-start readiness cycle.

A broken newly applied loader is recovered through the owner's SSH entry
point on the dedicated VM, `lifemodel doctor`, which diagnoses both platform
and application layers and can re-pin the previous platform release digest
and resume Flux. This SSH recovery replaces the former C-last ordering; the
loader and its route/policies are not postponed until after A and B.

Last-resort recovery is the owner's SSH entry point on the dedicated VM,
`lifemodel doctor`. It diagnoses both platform and application layers—the
Flux sources and Kustomizations, loader, Gitea, OpenBao seal state and
platform-upgrade lock—and offers recovery actions, including re-pinning the
previous platform release digest and resuming Flux. This shell entry point
remains available when a partial apply breaks the loader UI or route. The
`generations/platform-upgrade-recovery` dedicated-VM check breaks the loader
route during a partial apply, invokes `lifemodel doctor` over SSH, verifies
all listed diagnostics, re-pins the prior digest, resumes Flux, and verifies
healthy recovery without resetting application rollback timing.

Acquire the platform-upgrade lock only when the application layer is
quiescent: no rollout step is open and no application rollback is active.
While held, the generation operator makes no deploy writes. If an application
rollback becomes necessary during upgrade, mark the upgrade failed and enter
maintenance; preserve and continue the existing rollback clock without reset.

### Signing identity transitions and two-layer panic (R7-07, R7-08)

A keyless publisher identity transition is a root-policy operation, not a release change. The owner authorizes it through a separately authenticated root-policy change outside the artifact being verified. The transition temporarily accepts only the exact old and new repository/workflow/tag identities (issuer and subject matchers); after the new identity has produced and verified a release, the old identity is retired in a second separately authenticated change. Ordinary short-lived certificate renewal under the same identity is not a transition. Clean installation requires network access to retrieve the pinned artifact, signature and whatever trust evidence the pinned verifier mode requires; it fails closed if any are unavailable and never falls back to a tag, unsigned artifact, or broader matcher.

During registry or verifier outage, already-running workloads and the last successfully applied platform state continue; no new or changed release is accepted without signature verification. A previously verified artifact may be reused only while its locally cached artifact and verification evidence remain intact and the pinned identity is still trusted. Cache loss removes that availability exception and blocks re-fetch/reconciliation until verification service returns. Root trust is not rotated on an outage. The transition/outage checks prove old/new identity allow and deny behavior before/after overlap and retirement, unsigned/wrong identity/digest refusal, outage, and source-controller/cache restart.

Panic has two explicit stop domains. **Application stop set:** the application Kustomization remains reconciling its pinned deploy revision, but only the generation objects and protected operator-owned gate fields; every application HelmRelease in both `lifemodel` and `lifemodel-motor` is suspended and its module workloads are scaled to zero after any in-flight Helm action settles. The generation source declares neither the suspend nor operator-owned scale fields, and admission/field ownership prevents the parent Kustomization from claiming or clearing them. The generation HelmRelease inventory is explicit; no per-module bootstrap-root exclusion remains. **Platform leave-running set:** the platform root OCIRepository/root Kustomization, Flux controllers, loader, Traefik/owner recovery route, Gitea, Bao and required control-plane services remain running and are not suspended by panic. Platform reconciliation cannot remove or reset the application gate fields. A platform upgrade that conflicts with panic, touches the application stop set, or risks the recovery path pauses at its recorded phase; it cannot clear panic or advance app state. Resume is owner-authorized, durable, and removes application gates only after all observations and the recorded resume intent. Cut across competing app/platform reconciles and an upgrade during panic; prove no module or sandbox Job restarts and owner UI remains reachable.

## Decision outcome

One decision per question; the views in docs/features/instance/
containers-design.md implement them:

1. **Code (Q1):** a generation = a commit = the GitOps desired state in
   the deploy branch; the repo declares each module's build (context +
   Dockerfile) and its workload (the Helm chart), never a launch detail
   outside the chart; the generation operator builds per-module images
   IN-CLUSTER with BuildKit into the local registry, the tag the hash of
   the module's canonical build identity, so an unchanged module builds
   zero times; the operator writes the changed tags to the deploy
   branch (with its chart/values launch change, if any) and Flux applies
   them; base images digest-pinned, no build
   args; the compatibility checks (bus FULL compatibility,
   predecessor-reads-my-schema, squawk lint, call-manifest
   timeout/class check) run INSIDE the build and a failed check fails
   the build before any tag is written.
2. **Replacement and jobs (Q2):** the unit of replacement is the MODULE;
   the operator replaces only the modules whose tag changed, one by one
   in manifest order, with Deployment RollingUpdate (maxSurge 1 /
   maxUnavailable 0) for keyed writers — the new pod joins its consumer
   group before the old one's confirmed termination — and a
   ONE-REPLICA STATEFULSET for the singleton state writer (the core:
   confirmed kubelet termination, then the new core takes the epoch and
   the snapshot — R5-03: Recreate is rejected for the core);
   a readiness failure stops the rollout and rolls back; the health
   window starts after the commit's last replacement. Jobs are keyed
   command events through consumer groups: XACK only after the result,
   XAUTOCLAIM takeover, done records by key, `uncertain` reported for
   unkeyed ambiguity, declared timeouts per destination in the call
   manifest (missing timeout fails the build; grace >= longest timeout,
   build check). The XAUTOCLAIM min-idle sits above every module's
   delivery-to-result bound; reclaim from a retiring pod is authorized
   by confirmed pod termination, not by idle. No executor module, no
   job state machine, no heartbeats, no grace capabilities. The epoch
   CAS and `active_holder` stay as cheap operator-bug guards (A2); the
   two-store barrier does not.
3. **Rollback/maintenance/panic (Q3):** no down migrations; expand/
   contract with the invariant checked on schemas at every rollout;
   automatic rollback = git revert to the previous generation's recorded
   FULL revision (chart and values — R5-10), applied module-by-module by
   Flux on CURRENT data
   (`rollbackDeadlineMs` unchanged); snapshot copies (3) taken ONLY at
   core replacement, restored only by a human in maintenance after a
   schema-and-trim check; 2 consecutive failures open maintenance;
   panic = a durable recorded intent reconciled per release to suspend +
   the module workloads scaled to zero, complete only at the OBSERVED
   all-stopped state — cluster state, durable across restarts and
   reboots, re-driven after any crash (R5-02), overriding every
   other path; full backup is an owner-commanded maintenance action
   only; CNPG's declarative backup support is the natural home for the
   filed automatic-backlog item.
4. **State homes and plugins (Q4):** tick working state in the snapshot;
   inbound as a Valkey stream with offsets in the snapshot; long-lived
   memory/conversations/soul/registries/schedules/config in Postgres —
   now a CloudNativePG cluster (pgvector in the image, declarative
   per-module roles, declarative backups); neurons stay core plugins
   (isolation deferred, three options named); the five feature plugins
   become function images; PG writes are keyed commands applied after
   the tick commit, idempotent by natural keys; web delivery proof =
   the message row; Motor's sandboxes are Kubernetes Jobs in Motor's
   own namespace under RBAC, constrained externally by PSA restricted and
   a Job-template ValidatingAdmissionPolicy (R5-09) — the result path
   (bus event + keyed row) unchanged.
5. **Topology, two GitOps layers, one command, networks (Q5):** the clean
   VM command installs only k3s, Flux, and the signed OCI platform source
   (`OCIRepository` + root `Kustomization`); the source verifies Cosign
   keyless identity pinned to the release workflow. Flux owns all platform
   resources, including Gitea (SQLite on its own PVC), loader, OpenBao,
   webhook, CNPG, Agent Vault, registry, Traefik and policies. The loader's
   idempotent first start initializes custody, creates the Gitea admin by
   the chart 12.7.0 `existingSecret`/`initialOnlyNoReset` mechanism, seeds
   the same release into Gitea, protects branches, creates Flux read-only
   auth and adds the application source. Only the generation operator
   writes the deploy branch; its Kustomization is restricted to
   `lifemodel` and `lifemodel-motor`. Platform resources, Gitea, namespaces,
   CRDs and cluster-scoped resources are unreachable to candidates and
   rollbacks. The owner commands platform upgrades by changing the pinned
   release through the loader UI; the application source remains at its
   current revision while platform reconciliation proceeds. Existing
   cluster installation is deferred to lifemodel-xc9. Namespace policy,
   Traefik, RBAC and traffic boundaries remain as stated above.
6. **Function engine (Q6):** workerd first and replaceable; WinterTC API
   only, lint-checked; one engine driver in the operator reading the
   chart; Channel Adapter inside the function host; push projections
   with bootstrap barriers; declared keyed state/schedule commands;
   correlated `tool.request` / `tool.result` routing; the adapter XACKs
   only after the function answered.
7. **Credentials (Q7, per process — R4-05):** OpenBao per-process grants
   (zero credentials attach to the PROCESS, not the container/pod:
   core: epoch commit + pg.apply on its schema + the plain `inbound`
   read and the addressed `state.bootstrap` produce; adapter: its own
   streams + `signal.<kind>` on the bus + its own schema; workerd:
   none, scrubbed environment; ingress gateway: inbound + `send.settled`
   + its own schema + the two named narrow grants; egress gateway:
   consume the `cmd.egress.*` set, `http.result` on the bus, its own
   schema, Agent Vault; Motor: `motor.result` on the bus), delivered by
   the Bank-Vaults secrets webhook's vault-env in daemon mode from
   Kubernetes-auth service-account logins (no secret is ever delivered
   to a pod; the pod spec carries no credential material); separately,
   Flux has read-only Gitea auth, the operator holds its Gitea admin
   bootstrap credential in OpenBao and alone writes protected `main` and
   deploy, and the operator mints and revokes each task's short-lived Gitea
   repository token through the API, delivered via OpenBao/vault-env;
   branch protection blocks task writes to protected branches. Module
   credentials are injected into the module process's environment by
   vault-env, the process's parent; leases revoked PER RETIRED POD at its confirmed
   termination, never before the replacement started (R4-07); max TTL
   7 days; a renewal failure or a credential change ends the process
   (Kubernetes restarts it), a renewal that lands does not.
8. **Migrations/contract (Q8):** AsyncAPI + JSON Schema, FULL compatible
   both ways, compared commit-pair-wise at every rollout by the
   operator; breaking = a new event type beside the old; tolerant reader
   with EXCLUDE lists; snapshot versioned and additive, newer refuses;
   per-module PG schemas; expanding-only squawk-linted migrations
   applied by the operator before the rollout under a DDL role (a
   recorded Job); dbmate + squawk.

## Consequences

### Good

- The switch pause shrinks from "drain a turn's sends" (90 s) to "finish
  one local tick and commit the snapshot" (5 s deadline, values) — the
  core's external latency leaves the pause entirely: it makes no external
  calls (point 4) (Q1, inventory). The reported pause is the SUM of the
  named phases around that core work — the fence waits, the copy write,
  the resume/reconcile, scheduling and image pull, start-to-first-commit
  — each with its own bound and failure outcome, reported from the
  rollout record's timings (R5-14): infrastructure time is named, not
  hidden inside the 5 s stop deadline, and the maintenance-on-expiry
  trade stands.
- A one-module change touches one module: unchanged modules are neither
  rebuilt nor restarted, and the per-module strategies are standard
  Kubernetes fields (`type: RollingUpdate` or a one-replica StatefulSet
  for the core), not a bespoke state machine (Q12, point 1).
- Build-time checks move format and contract mistakes to where they fail
  loudly and cheaply: a failed build produces a compiler-grade report,
  never a rollback, a partial rollout, or a degraded generation (Q12,
  Q8).
- Image reuse by input hash makes the common self-change build only what
  changed — and the commit-pair schema check rides every rollout anyway,
  so reuse buys build cost, never a skipped check (Q12, point 5).
- The two-store epoch barrier, the commit-fence module, admission
  records, throwaway reader runs, the stamp pair, grace capabilities, the
  executor module and its state machine, and the mTLS identity layer are
  GONE from the steady-state operation list: what remains is a Helm
  chart reconciled by Flux, Kubernetes rollout semantics, and consumer
  groups plus file comparisons — each visible in `kubectl get`, Flux's
  status, or a git diff (point 0, points 1-6).
- NetworkPolicy default-deny plus RBAC are structural egress and
  authority confinement: no iptables chains, no NET_ADMIN, no
  certificates, no socket-proxy allowlists to maintain; a module that
  must not reach a surface HAS NO POLICY ROW to it, and egress, secrets
  and cluster mutation have one accountable surface each — the egress
  gateway, OpenBao, the operator (Q8, Q9).
- The desired state, the health window and panic are durable CLUSTER
  state applied by Flux and the operator: panic (suspend + scale to
  zero) survives operator restarts, Flux restarts and node reboots with
  no time limit, and its RECORDED INTENT re-drives the per-release
  transition to the stopped state after any crash (R5-02); a rollback is
  a git commit with the same review trail as the forward change (Q3).
- Per-module credential roles and per-module Postgres schemas (CNPG
  declarative roles) turn "module isolation" from a convention into a
  grant (Q7, Q8); the platform's Kubernetes auth removes the whole
  bootstrap-secret delivery surface (no secret is ever handed to a pod).
- The job machinery is consumer-group semantics a queue engine would give
  anyway — so the Windmill/Temporal research can move it wholesale to a
  dedicated engine without touching the core (point 2, open question 3).
- The chart-and-operator seam, the engine-driver pattern, the egress
  gateway and the bus contract are exactly the seams the later
  ~30-module core split will use (point 6).
- Per-module readiness-probe gates plus per-module rollouts give F4's
  gate its unit: a pod that passes its readiness probe is ready; a
  module whose work wedges behind a green probe is answered by A8's
  work-counting health rule, checked per module (R3-12 carried).
- A clean VM has one trust root: k3s, Flux, and the signature-verifying
  OCI platform source. Flux owns every platform lifecycle, while the loader
  performs only resumable first-start setup; no installer credential or
  imperative Helm lifecycle persists. Existing-cluster installation is
  intentionally absent from this milestone (lifemodel-xc9).
- Internal Gitea keeps the source of truth inside the instance; self-changes
  arrive as reviewable pull requests in the owner's UI, while an optional
  push mirror gives an owner-controlled outside copy.

### Bad

- Every core->world interaction is now a bus event: the AsyncAPI contract
  becomes the load-bearing artifact and its FULL-both-ways check gates
  every commit — a wide, permanent review surface.
- Five feature plugins become separately deployed function images with a
  WinterTC-restricted API; anything outside the common API must move into
  a core module or be declared a command.
- workerd is a new runtime to operate, and its replacement later means a
  second engine driver; no abstraction hides that cost today.
- The platform brings FIVE new managed components — k3s, Flux,
  CloudNativePG, Traefik, OpenBao (chart + the Bank-Vaults secrets
  webhook) — plus the local registry and BuildKit: each is an upgrade,
  CVE and configuration surface the Compose shape did not carry; the
  secrets webhook and vault-env especially are components to keep
  current (A5's invalidator names the fallback). Gitea adds another
  stateful component, repository-volume backup/restore, and its own upgrade
  and security maintenance burden.
- The topology now lives in the deploy branch and the operator's
  behavior in the operator image — chart/operator drift is a new review
  surface the old single-command shape did not have.
- The no-unvetted-children rule (Q7) needs enforcement, not just a
  written rule — A5's invalidator names the fallback.
- The structural fence is CONFIRMED POD TERMINATION on one node:
  everything rests on A2 and A12 (single node; k3s/Kubernetes rollout
  semantics honored). Several machines or a platform drift re-open
  fencing and the dropped barrier options — named invalidators, not
  hidden ones.
- An operator bug is now the widest blast radius in the cluster: the
  operator holds RBAC mutation rights over lifemodel's workloads, and
  RBAC is not a fence against a WRONGLY-INTENDING writer — the cheap
  guards (the Lua CAS, `active_holder`) are exactly as far as the owner
  asked the guards to go, and no further.
- A stale writer that somehow survives the confirmed termination is
  caught only by those cheap guards — as above.
- An old generation beyond the compatibility window cannot be booted at
  all — it refuses with the reason; recovery past the window is manual
  (snapshot copy in maintenance), i.e. human work by decision.
- `maxFailedGenerations` = 2 still stops automatic delivery after one
  unlucky pair; maintenance entry remains a page to the owner
  (unchanged, kept).
- Per-tick snapshot commits keep the fsync-per-second load on Valkey for
  the instance's whole life (charter-fixed; the cost is measured, not
  assumed — carried).
- In-cluster builds consume the cluster's own CPU (the 2-CPU envelope):
  the build budget must be measured, not assumed (open question 6); a
  build storm from a bad commit can starve the workload the cluster is
  for.
- Debugging moves one abstraction up: `docker ps` and `docker logs`
  become `kubectl get pods/events`, Flux's reconciliation status,
  HelmRelease conditions, and OpenBao lease views — an operability
  learning cost, named, not hidden.
- Q11's memory need is UNMEASURED: the ADR claims no bound; the
  measurement is a required outcome of the test environment (Q11 as
  amended).

## Why the rejected options lost (summary)

| Option | Lost because |
|---|---|
| O1-A sealed release trees | Stores build outputs per commit, no per-module reuse; superseded by the owner, 2026-10-12. |
| O1-B one image per generation | Right direction, wrong grain — per-module images with input-hash reuse keep churn bounded and give point 1 its unit. |
| O1-C shared mutable tree | N+1's build overwrites N's running tree; two writers, no safety. |
| O1-D self-building candidate | Puts the build inside the readiness bound; the build is an operator-controlled stage. |
| O1-CI host-side CI builds to an external registry | The one-command clean-VM path has no host CI in it; an external registry adds credentials the local registry avoids. |
| O1-2026c loader-on-host `docker build` per the Compose shape | Rejected by the owner, 2026-10-12 (platform decision); the build moved in-cluster with the operator. |
| O1-E admission records | Rejected by the owner, 2026-10-12 (point 5): the commit-pair file comparison closes R3-06 without per-image records. |
| O1-F/O8-D throwaway reader runs | Rejected by the owner, 2026-10-12 (point 5): schema files compared commit-pair-wise plus squawk replace readers-on-data; semantic drift is review's and the health window's residue (A11). |
| O2-B closed-apply two-store barrier | Rejected by the owner, 2026-10-12 (point 1): one node + confirmed pod termination IS the barrier; returns with its invalidator (A2). |
| O2-C whole-generation switch | Rejected by the owner, 2026-10-12 (point 1): pays the full rollout cost for any change; per-module rollout replaced it. |
| O2-D in-memory epoch | A fence the fenced party forgets at restart. |
| O2-E mTLS workload identity | Rejected by the owner, 2026-10-12 (point 3): NetworkPolicy + RBAC isolate structurally; mTLS defended the excluded deliberate-bypass case; deferred to the backlog (A3). |
| O2-F HTTP control endpoints on modules | Rejected by the owner, 2026-10-12 (points 3, 4): Kubernetes lifecycle + readiness probes + the operator-role epoch key cover control; no module needs an HTTP control surface. |
| O2-H durable job state machine | Rejected by the owner, 2026-10-12 (point 2): consumer groups + XAUTOCLAIM are the claim and the takeover; kept only the done record by key. |
| O2-H executor module | Rejected by the owner, 2026-10-12 (point 4): work goes to the owning module; kept the core-makes-no-external-calls half of the original decision. |
| O2-I grace capabilities | Rejected by the owner, 2026-10-12 (points 1, 4): `terminationGracePeriodSeconds` + min-idle taking is the whole handover surface. |
| O3-B fallback chain | Guesses down a list, burns the budget; the breaker covers it in one try. |
| O3-C automatic snapshot restore | Resurrects answered messages; adopted ONLY as manual maintenance recovery (point 6). |
| O3-D snapshot+PG stamp pair | Rejected by the owner, 2026-10-12 (point 6): copies only at core replacement; a full backup is owner-commanded maintenance, never rollout machinery. |
| O3-E imperative rollback outside the deploy branch | The deploy branch is the single desired state; an imperative path forks the state and re-applies the branch on the next sync (platform decision consequences). |
| O4-B/O4-C single-store reductionism | Either drags tick-speed state over a network per tick, or grows the snapshot unboundedly. |
| O4-D shared volume trees | Two writers in the rollout window plus no inter-process safety equals clobber. |
| O4-E neuron extraction now | Deferred by the owner; the design must not promise the isolation it would give. |
| O4-F executor-owned job tables | Die with the executor module itself (point 4). |
| O4-G etcd/ConfigMaps/CRDs as the instance state store | The snapshot's write pattern (atomic commit, epoch CAS, fsync per write, offsets beside it) is Valkey's, not a ConfigMap's or CRD's (platform decision consequences). |
| O5-A trusted-supervisor monolith | Superseded by the owner, 2026-10-12 (point 6): Traefik and Agent Vault are separate official-image components. |
| O5-B flat namespace + mTLS | See O2-E. |
| O5-C iptables/NET_ADMIN egress | Superseded by NetworkPolicy: the missing policy row IS the missing route. |
| O5-D raw Docker socket / imperative kubectl as a control path | No Docker socket exists in the cluster (platform decision); an imperative kubectl path forks the desired state (O3-E). |
| O5-2026c the Compose ten-network shape, socket proxies, Caddy | Rejected by the owner, 2026-10-12 (platform decision): namespaces + NetworkPolicy, RBAC and Traefik replace its three mechanisms. |
| O5-E modules with direct internet access | Model keys would leave through every module; the egress gateway is the one accountable surface. |
| O6-A plugins in the core image | Superseded by the owner, 2026-10-12 (point 5): the five become function images. |
| O6-B function-held store credentials | The role map refuses it; a function's whole influence is the adapter envelope. |
| O6-C multi-engine abstraction now | No second engine exists; the driver seam is the extension point (point 6). |
| O6-D functions poll for their read set | Violates emergence-over-polling; push projections + the bootstrap barrier answer the fresh-adapter case. |
| O7-A2 loader-injected env (generation scope) | Superseded by the owner, 2026-10-12 (point 7): per-module roles; the pod spec was a named leak surface. |
| O7-A pod-spec Secret env/volume references | Readable surface, static net; vault-env keeps credentials dynamic, per process, out of the spec. |
| O7-D official chart's Agent Injector | Not the application-process supervisor the contract needs (R5-04); Bank-Vaults secrets webhook + vault-env daemon mode is the owner's setup, rejected by the owner, 2026-10-13. |
| O7-2026c wrapped AppRole secret-ids | Rejected by the owner, 2026-10-12 (platform decision): service-account login replaces bootstrap-secret delivery. |
| O7-B static credentials | Not short-lived, not scoped, not revocable. |
| O7-C module-held vault token | A compromised module could mint credentials; service-account login means it cannot. |
| O8-A down machinery | Down paths existed for old-reads-new; expand/contract + FULL both-ways checks answer that at build; superseded by the owner, 2026-10-12. |
| O8-B forward-only rebuild | The journals a rebuild needs do not exist in this milestone. |
| O8-C guess-the-format | Violates the carried "refuse when uncertain" rule with epoch authority behind it. |
| k3s-in-Docker as the platform | Rejected by the owner, 2026-10-12 (platform decision, A13): a privileged container; the clean-VM path needs no privilege anywhere. |

Builder convenience was not used as a reason anywhere above; every verdict
cites a scenario, a carried rule, a named invalidator, or an owner
decision of 2026-10-12.
### Round 7 second-pass decision (R7-01) — application apply topology and ownership

The application Kustomizations `lifemodel` and `lifemodel-motor` live in
their respective target namespaces, not `flux-system`. Each Kustomization's
`spec.serviceAccountName` names its platform-provisioned applier ServiceAccount
in the Kustomization object's own namespace; its targetNamespace is pinned to
that namespace. Each target namespace has a platform-created GitRepository for
the deploy branch and a read-only credential Secret written there by the
loader. The Kustomization references only its local GitRepository. The only
permitted nested reconciler edge is each Kustomization to a HelmRelease in the
SAME target namespace; that HelmRelease independently impersonates its own
same-namespace applier and gets its chart from the local GitRepository at its
chart path in the deploy branch. Cross-namespace refs remain disabled.

The platform release declares each applier ServiceAccount and target-namespace
Role/RoleBinding for application resources, with no Secret rights in either
target namespace. Each HelmRelease sets `spec.storageNamespace` to
`lifemodel-releases` or `lifemodel-motor-releases`; a Role and RoleBinding in
that platform-owned, workload-free, default-deny storage namespace grants
Secret get/list/watch/create/update/delete to the corresponding applier from
the target namespace. Source-controller reads the deploy credential under its
own identity. Flux documents `spec.storageNamespace` as the release-information
namespace and `spec.serviceAccountName` as the impersonated ServiceAccount
([storage namespace](https://fluxcd.io/flux/components/helm/helmreleases/#storage-namespace),
[service account reference](https://fluxcd.io/flux/components/helm/helmreleases/#service-account-reference)). Application-owned
kinds are exactly Deployments, StatefulSets, Services, ConfigMaps, the module
HelmReleases, and the Job templates Motor uses, all only in `lifemodel` and
`lifemodel-motor`. The signed platform release owns NetworkPolicies, RBAC
(including ServiceAccounts, Roles and RoleBindings), PSA labels, admission
policies, applier accounts and GitRepositories. These platform objects are
immutable to generations. A generation rollback restores only
generation-owned desired state; it never restores, changes or rolls back
NetworkPolicies or RBAC.

## Round 7 dispositions (2026-10-13)

- R7-01 — Fixed: target-namespace application appliers have no Secret rights; each HelmRelease stores release Secrets in its dedicated platform-owned, workload-free default-deny namespace, where a storage RoleBinding grants only the matching applier access; source-controller alone reads deploy credentials. Helm lifecycle and denied target-namespace Secret access remain acceptance evidence.
- R7-02 — Fixed: separate Bao-independent loader identity, scoped grants, prune exclusions, phase ownership and hand-off checks recorded; runtime walks remain unverified.
- R7-03 — Fixed: explicit chart overrides and safe admin-Secret retirement sequence recorded; rendered chart and replacement/login checks remain unverified.
- R7-04 — Fixed: installer-owned root trust, loader-only digest pin, artifact exclusion and restart persistence recorded; competing reconciliation remains unverified.
- R7-05 — Fixed: durable upgrade, serialization, compatibility, recovery-material and no-unsafe-downgrade contract recorded; dedicated upgrade walks remain unverified.
- R7-06 — Fixed: P15 includes registry/auth/verifier/internal delivery paths independent of app egress; exact pinned endpoint/bundle validation and live signed-fetch walk remain unverified.
- R7-07 — Fixed: separately authenticated identity transition, strict outage/cache behavior and fail-closed clean install recorded; transition/outage walks remain unverified.
- R7-08 — Fixed: application stop set and platform leave-running set, field ownership and upgrade precedence recorded; competing reconcile/panic walk remains unverified.
- R7-09 — Fixed: init-to-custody visible-recovery limit restored; F7/G3/N-19 await the manual acceptance check on the owner's test VM.
