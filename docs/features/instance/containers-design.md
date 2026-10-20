# Containers design — the views behind ADR-010 (rewritten on k3s + GitOps)

Reconciled 2026-10-13 to the owner's fixed two-layer GitOps decision
(lifemodel-b0r.9.16). A signed per-release OCI artifact owns platform
manifests; a separate Flux source reads generations from Gitea. The supported
VM shapes (owner, 2026-10-13) are NixOS first, through the flake's
`services.lifemodel` module (`nixos-rebuild switch`), and generic Linux
(Ubuntu/Debian), through `scripts/install.sh`. Both install only k3s with
embedded etcd, pinned Flux and the root OCIRepository + platform
Kustomization, rendered from the same `deploy/root/` templates (byte-equal,
checked by `nix flake check`). The coordinator's end-to-end clean-VM check is
manual acceptance over SSH on owner-provided test VMs; the owner restores the
clean hypervisor snapshot before each from-scratch check. NixOS is first,
then Ubuntu for the script. There is no CI walk and no k3d delivery walk. The
Flux-deployed loader performs idempotent first-start setup and adds the
application source. Gitea remains in the platform layer and outside
candidate/rollback authority. This milestone is dedicated-VM only;
existing-cluster installation is deferred to lifemodel-xc9. ADR-010 wins
wherever this document and the ADR disagree. The Checks section maps every
F*/Q* driver and every rule of this document to its check.

## Container view (C4, level 2)

The topology has two GitOps layers. The **platform layer** is the trusted
signed OCI release, applied by Flux from a pinned `OCIRepository` and root
`Kustomization` in `flux-system`. The platform release owns the loader,
Gitea, OpenBao and Bank-Vaults webhook, CNPG, Agent Vault, local registry,
Traefik configuration, policies and platform RBAC. A release change is
owner-commanded through the loader UI; generations cannot write or repin the
platform source. The **application layer** is the deploy branch in in-cluster
Gitea, written only by the generation operator. The platform release creates
one local GitRepository per target namespace, and one application
Kustomization lives in each of `lifemodel` and `lifemodel-motor`; they manage
only generation-scoped resources in their own namespace. Platform resources,
CRDs, namespaces and cluster-scoped objects are denied. Candidates and
rollbacks are refused before touching any platform object.

Gitea is in the platform layer, not installer-owned or generation-owned. The
signed release owns the official Gitea Helm chart pinned at `12.7.0`
(Gitea `1.27.0`; official chart index:
https://dl.gitea.com/charts/index.yaml). It uses SQLite
(`database.DB_TYPE=sqlite3`) and stores the database and repository data on
its own PVC in `lifemodel-git`. Its release, PVC, policies and routes are
outside candidate paths. Only an owner-commanded platform release upgrades
Gitea; no automatic database downgrade is allowed. Gitea's administrator is
created during the loader's resumable first-start workflow using the chart's
`gitea.admin.existingSecret` and `initialOnlyNoReset` mechanism (chart 12.7.0
source: https://dl.gitea.com/charts/gitea-12.7.0.tgz, `values.yaml` and
`templates/gitea/init.yaml`). The loader creates and owns the referenced
Kubernetes Secret. It never deletes a Secret while the chart still renders a
reference to it (R6-05). The loader transfers durable credential custody to
OpenBao; Flux's read-only account is distinct. Gitea on shared CNPG is
rejected. The optional push mirror is off by default and exits only through
its named egress gateway row. Backup/restore of its single PVC remains
deferred.

Every namespace denies EGRESS by default; the
policy rows below are the whole policy — a module cannot reach a surface it
has no row to, structurally, by absence of a route (simplification point
0's kept mistake barrier). Only Traefik publishes a port (its LoadBalancer
service). The Gitea UI uses a new `git.` host behind ForwardAuth. The
owner's decision (2026-10-13, "Gitea") is fixed: Flux has read-only deploy
branch auth; the operator alone writes protected `main` and deploy and merges
task PRs after gates. Tasks use the separate non-admin `lifemodel-task` account,
which can access only this repository. The operator uses the task-account credential at `secret/data/gitea/task-account`
to authenticate as that account and mint a per-run token with minimum `read:repository`, `write:repository`, `read:issue` and `write:issue`
scopes (Git and PR API only; no admin/account scopes); the Gitea 1.27.0 personal-token API does not select repository ids
or provide token expiry. Operator-only direct-push AND merge allowlists, highest
rule priority and no task admin bypass protect `main`/deploy; protection edits
and unprotected-file writes are refused. Accepted residual rights are writes to
other unprotected branches/tags and PR metadata in this repository; a second
private repository remains inaccessible. The operator records durable issuance
intent, unique token name/id, maximum lifetime and pending revocation before
mint/delivery. It recovers lost mint responses by identity/name, never blindly
re-mints; reconciles revocation on every outcome and restart, retries visibly,
removes Bao values, and blocks new self-change runs until cleanup settles.
Lifetime is operator-managed, not server-enforced during operator outage. The
task token is delivered by a run-specific OpenBao binding/vault-env into the
task process environment, never the Job spec. A copied token must fail Git and
API access after confirmed revoke. The administrator credential remains in
OpenBao (https://docs.gitea.com/usage/access-control/protected-branches/;
https://docs.gitea.com/development/api-usage/#token-api).
The optional push mirror is off by default and exits only through its named
egress gateway row (Gitea mirror documentation:
https://docs.gitea.com/usage/repository/repo-mirror/). Gitea's SQLite database and repository data share its own PVC; backup and
restore of that single volume remains deferred.

```mermaid
flowchart LR
    owner["Owner<br/>(browser, one person)"]
    uplink["(machine uplink)"]
    subgraph cluster["k3s cluster — one node (A2)"]
        direction TB

        subgraph fluxns["flux-system"]
            flux["Flux controllers<br/>verified OCIRepository → signed platform release ·<br/>GitRepository → Gitea deploy branch (generation scope only)"]
        end

        subgraph gitns["lifemodel-git (static)"]
            git["Gitea · official Helm chart 12.7.0<br/>repository + SQLite database on one PVC<br/>protected main + deploy branches"]
        end

        subgraph trafns["traefik (k3s-bundled)"]
            tr["Traefik<br/>LoadBalancer service — the only published port ·<br/>pinned hosts + ForwardAuth to the operator"]
        end

        subgraph lmns["lifemodel — generation N (a commit = the deploy branch's desired state;<br/>per-module HelmReleases, images tagged by build-input hash, unchanged modules reused by tag)"]
            coreN["CORE<br/>one-replica StatefulSet (the operator's gated switch; at-most-one identity, R5-03)<br/>tick loop, 1 s · epoch-checked snapshot commit (Lua CAS) · takes the epoch at takeover<br/>keyed-command applier (own schema) · bus-reachable ONLY (R4-06)"]
            ingressN["INGRESS GATEWAY<br/>Deployment, RollingUpdate maxSurge 1 / maxUnavailable 0<br/>browser → Traefik → Service → bus: XADD `inbound` (ingress-only user) + `send.settled`;<br/>serves the WHOLE root-host surface: UI/session + POST submit + transcript + reply pull;<br/>send applier: INSERT conversation_message BY KEY (scoped grant) + done record"]
            egressN["EGRESS GATEWAY<br/>Deployment, RollingUpdate<br/>the only internet route from a module; consumes every `cmd.egress.<module>` stream<br/>(per-process grant, R4-05); `http.request` commands (declared timeout + class);<br/>per-module policy, logging; `http.result` back on the bus + own-schema done records;<br/>Agent Vault client (key injection — the vault is the egress path's LAST hop)"]
            fnhostN["FUNCTION HOST<br/>Deployment, RollingUpdate<br/>Channel Adapter (Valkey ↔ HTTP; per-process grants, R4-05) + workerd<br/>five feature plugins as functions (WinterTC API only, lint-checked)<br/>workerd PROCESS: zero credential, zero store connection (scrubbed environment)"]
            motorN["MOTOR<br/>Deployment, RollingUpdate<br/>runs agentic sandboxes as Kubernetes JOBS in `lifemodel-motor` under its RBAC row<br/>(no Docker access at all — Q9 as amended)<br/>sandbox HTTP via the egress gateway (HTTPS_PROXY)"]
        end

        subgraph motorns["lifemodel-motor"]
            sbx["Motor sandbox Jobs (per run)<br/>no mounts, no privileges; proxy egress via the egress gateway (P8); internal exceptions P24 (Gitea) and P27 (OpenBao task-token delivery)"]
        end

        subgraph statens["lifemodel-state (static)"]
            valkey["Valkey (PVC)<br/>AOF appendfsync-always · bus + command streams · inbound stream ·<br/>ONE current snapshot + 3 copies · epoch record (operator- and core-writable)"]
            pg["Postgres + pgvector — a CloudNativePG Cluster<br/>per-module schemas · CNPG-managed NOLOGIN group roles + migration-owned GRANT SQL (R5-16) · declarative backups · active_holder"]
        end

        subgraph openbaons["openbao (static)"]
            bao["OpenBao (official chart)<br/>short-lived per-MODULE-ROLE credentials · Kubernetes auth<br/>Bank-Vaults secrets webhook (mutates module pods; vault-env is the process's parent)"]
        end

        subgraph systemns["lifemodel-system (static)"]
            op["GENERATION OPERATOR<br/>Deployment, 1 replica + leader-election Lease · web UI (Traefik ForwardAuth)<br/>polls the Gitea repository → runs checks + in-cluster BuildKit builds →<br/>writes new tags to the deploy branch → gates the rollout one module at a time ·<br/>health window · rollback (git revert) · maintenance · panic · snapshot copies"]
            registry["Local registry (OCI `registry:2`, one volume on the sole node)<br/>module images tagged by build-input hash<br/>stable node-resolvable endpoint — the kubelet PULLS from here (R5-08)"]
            bk["BuildKit build pods (rootless, per build)<br/>no cluster mutation rights, no credentials"]
            records["Rollout records + generation registry<br/>(cluster resources in this namespace, operator-written)"]
            vault["Agent Vault (static)<br/>MITM proxy holding the MODEL keys<br/>its own outbound leg — the egress path's LAST hop (R4-06) ·<br/>the owner's key-entry UI: ONE published, ForwardAuth-guarded route (R5-19)"]
        end
    end

    owner -->|"https (the LoadBalancer service)"| tr
    tr -->|"root host: UI/session + POST submit<br/>(the INGRESS GATEWAY's whole-surface Service — no front route to the core)"| ingressN
    tr -->|"`boot.` host + ForwardAuth"| op
    tr -->|"`vault.` host + ForwardAuth — the owner's key entry (R5-19)"| vault
    tr -->|"`git.` host + ForwardAuth"| git
    flux -->|"reconcile generation Kustomization only"| lmns
    flux -->|"reconcile signed platform Kustomization"| systemns
    flux -->|"reconcile signed Gitea platform release"| gitns
    git -->|"read-only deploy-branch source for application layer"| fluxns
    op -->|"write deploy-branch rollout steps only · suspend/resume + scale · rollout records"| git
    op -->|"never writes or changes the platform OCI source"| fluxns
    op -->|"epoch writes (panic) · ACL admin · health/reconciliation reads"| valkey
    op -->|"health reads (cross-schema) · active_holder verify"| pg
    op -->|"revoke a retired pod's leases (confirmed exit, R4-07)"| bao
    op -->|"poll source repo · read and write protected branches · merge gated task PRs"| git
    sbx -->|"clone · push task/* · open PR (short-lived token)"| git
    flux -->|"read deploy branch with read-only auth"| git
    git -->|"optional mirror through named egress gateway leg"| egressN
    git -->|"database"| pg
    bk -->|"push module images (tag = build-input hash)"| registry
    bk ---|"base images, packages (Q1's normal network)"| uplink
    coreN -->|"snapshot commit (epoch-checked Lua CAS) · reads/writes own schema"| valkey
    coreN -->|"keyed pg.apply on its own schema · active_holder check"| pg
    coreN -->|"answer a fresh adapter's repair: `state.bootstrap.<instanceId>`"| valkey
    ingressN -->|"`+xadd inbound` only + `send.settled` (per-process grant, R4-05)"| valkey
    ingressN -->|"send applier: row + done record"| pg
    egressN -->|"`http.request` consume (consumer group); result events → bus"| valkey
    egressN -->|"key injection (vault API — the egress path's last hop, R4-06)"| vault
    vault ---|"the vault's own outbound leg"| uplink
    fnhostN -->|"consumer group: function deliveries, projections, tool routing"| valkey
    motorN -->|"`motor.command` consume → create sandbox Jobs → `motor.result`"| valkey
    motorN -->|"Job create/get/delete in `lifemodel-motor` ONLY"| sbx
    sbx -->|"HTTPS_PROXY (motor policy)"| egressN
    sbx -.->|"vault-env auth + per-run task token only (P27)"| bao
    bao -.->|"issues leases + scoped credentials FOR the declared module roles"| valkey
    bao -.->|"issues leases + scoped credentials FOR the declared module schemas"| pg
```
    lmns -.->|"vault-env: Kubernetes-auth service-account login"| bao

Namespace ownership is split at the same boundary. The platform layer owns
`flux-system` (the OCIRepository and root Kustomization), `lifemodel-system`,
`lifemodel-state`, `lifemodel-git`, `openbao`, `traefik`, and the required
`kube-system` configuration. The application layer owns only generation
resources in `lifemodel` and `lifemodel-motor`. The platform also owns the
workload-free `lifemodel-releases` and `lifemodel-motor-releases` namespaces,
which hold only Helm release Secrets and have default-deny egress. Application
generations cannot create or modify either storage namespace or its contents.
They cannot create namespaces, CRDs, cluster-scoped objects, platform RBAC, or
resources in platform namespaces.

The namespace table (simplification point 3, on the platform's primitives;
every namespace denies EGRESS by default — the rows below are the whole
policy):

| Namespace | Members | Outbound routes (the NetworkPolicy rows) |
|---|---|---|
| `lifemodel` | core, ingress gateway, egress gateway, function host, Motor module | modules → Valkey and their store/schema surface (Q4, Q7); every module → cluster DNS (CoreDNS, resolution only — R5-05); every module → OpenBao (the vault-env Kubernetes-auth login); the Motor module → `lifemodel-motor` (create Jobs) and → the egress gateway (proxy hop); the egress gateway → the world AND Agent Vault |
| `lifemodel-motor` | Motor's sandbox Jobs | the egress gateway only, as `HTTPS_PROXY` under the motor policy (R4-06's mechanism, carried); cluster DNS; named Gitea HTTPS access only for clone, push `task/*`, and open PR (P24); and OpenBao only for vault-env's Kubernetes-auth and task-token injection (P27); no bus or store route |
| `lifemodel-releases` | no workloads; platform-owned Helm release Secrets only | no egress; default-deny NetworkPolicy; generation sources cannot create or modify this namespace or its contents |
| `lifemodel-motor-releases` | no workloads; platform-owned Helm release Secrets only | no egress; default-deny NetworkPolicy; generation sources cannot create or modify this namespace or its contents |
| `lifemodel-state` | Valkey, the Postgres cluster (CloudNativePG) | inbound-serving only — no egress rows open |
| `lifemodel-system` | loader, generation operator, CNPG operator, local registry, BuildKit build pods, Agent Vault | operator → the Kubernetes API, Gitea (read; write protected `main`/deploy and merge PRs after gates); the operator mints/revokes task credentials through Gitea using the non-admin `lifemodel-task` account credential from Bao; it authenticates with Basic or supported reverse-proxy login as that named account; the stores, OpenBao; the CNPG operator → the Kubernetes API and its Postgres instances (P21 — R5-05); BuildKit pods → the registry and the base-image sources (Q1's "normal network", a named row); Agent Vault → the world (the egress path's LAST hop) |
| `openbao` | OpenBao (official chart) + the Bank-Vaults secrets webhook | OpenBao server → the stores (dynamic-credential issuance, P18) and → the Kubernetes API (the Kubernetes-auth TokenReview, P19); cluster DNS; the secrets webhook SERVES the API server's admission calls (ingress — never an egress row) |
| `traefik` (the chart pins the bundled Traefik's namespace — k3s normally bundles it in `kube-system`) | Traefik | the Kubernetes API (route/endpoint discovery, P20 — R3-15); to the ingress gateway, operator UI, Vault UI, and Gitea `git.` UI — the complete named ingress routes (P16/P25) |
| `lifemodel-git` | Gitea (official chart 12.7.0), repository + SQLite database on one PVC | cluster DNS; optional HTTPS push mirror through the egress gateway (P26) only |
| `flux-system` | Flux controllers, verified platform OCIRepository and root Kustomization | Flux controllers → Kubernetes API (P32); source-controller HTTPS to `ghcr.io`, `pkg-containers.githubusercontent.com`, configured GHCR token endpoint, `tuf-repo-cdn.sigstore.dev`, `rekor.sigstore.dev`; kustomize-controller and helm-controller fetch from the source-controller Service (P31); source-controller reads each target namespace's local GitRepository for the Gitea deploy branch (P15). Cosign keyless verification is online and the platform policy is independent of application egress. |
| `kube-system` (the platform's own) | CoreDNS, the k3s agents, the API server, the bundled Traefik if not relocated | no lifemodel row routes INTO it except the DNS row; its pods ride the kubelet/node plane — the NetworkPolicy NODE-TRAFFIC EXCEPTION, stated and never relied on for lifemodel's isolation (R5-05) |

The NetworkPolicy rows (a module cannot reach a surface it has no row to —
UNREACHABILITY, not a refused connection; every OTHER module-to-surface path
is refused by absence, and no check exempts anything beyond these rows):

| # | From (namespace / pod) | To | Purpose / bound |
|---|---|---|---|
| P1 | `lifemodel` — every module pod | `lifemodel-state` / Valkey | bus, command streams, `inbound`, snapshot + copies; per-process scoping rides the Valkey ACL (R4-05) |
| P2 | `lifemodel` — every module pod | `lifemodel-state` / Postgres | the route; the OpenBao credential scopes the session to the module's OWN schema (point 0's kept barrier is the ROLE, the policy row is only the route) |
| P3 | `lifemodel` — every module pod | `openbao` / OpenBao | vault-env's Kubernetes-auth login and lease renewals only |
| P4 | `lifemodel` / egress gateway | the world | the only internet route from a module namespace |
| P5 | `lifemodel` / egress gateway | `lifemodel-system` / Agent Vault | key injection; the vault's own outbound leg is the egress path's LAST hop (R4-06) |
| P6 | `lifemodel` / Motor module | the Kubernetes API endpoint | create/get/list/watch/delete Jobs — the verbs are RBAC's, this row is only the route |
| P7 | `lifemodel` / Motor module | `lifemodel` / egress gateway | the Motor module's own proxied HTTP (a named row of the ADR's namespace table) |
| P8 | `lifemodel-motor` / sandbox Jobs | `lifemodel` / egress gateway | `HTTPS_PROXY` under the motor policy (R4-06); no bus or store route |
| P9 | `lifemodel-system` / operator | the Kubernetes API | the controller verbs of the RBAC table |
| P10 | `lifemodel-system` / operator | `lifemodel-git` / Gitea | read source/task PRs; write protected `main`/deploy and merge PRs after gates. Highest-priority rules allow only operator direct push and merge; task identity has no admin bypass, no protection edits or unprotected-file writes. |
| P11 | `lifemodel-system` / operator | `lifemodel-state` (Valkey + Postgres) | epoch writes (panic), Valkey ACL administration, cross-schema health/reconciliation reads (a named narrow grant), `active_holder` verify |
| P12 | `lifemodel-system` / operator | `openbao` / OpenBao | operator auth and retired-module lease revoke (R4-07); Gitea task lifecycle reads `secret/data/gitea/task-account` (the non-admin account's API-auth credential) and `secret/data/gitea/mirror` (the configured HTTPS remote credential), reads `secret/data/gitea/admin` only for separately authorized source-infrastructure lifecycle, and reads/writes/deletes `secret/data/gitea/task-runs/<run-id>` plus reads/deletes matching `secret/metadata/gitea/task-runs/<run-id>`. Per-run provisioning has ACL capabilities `create`, `update`, `delete` only on `auth/kubernetes/role/run-*`, `sys/policies/acl/run-*`, and that run's exact KV path; OpenBao ACL policy writes use `UpdateOperation`, including new policies ([API](https://openbao.org/docs/api/system/policies/), [pinned source](https://github.com/openbao/openbao/blob/ad64d389cb66023521c4228dc9f1149400d87351/internal/vault/logical_system_paths.go#L3880-L3888)). No `list`/`read` on parent paths and no module-secret access. |
| P13 | `lifemodel-system` / BuildKit build pod | `lifemodel-system` / registry | push module images; the kubelet's pull is NODE-side traffic outside these rows (R5-08) — the node's trust for the registry endpoint is installer-written (`registries.yaml` or plain HTTP node-locally) |
| P14 | `lifemodel-system` / BuildKit build pod | the world | base images and package sources, digest-pinned (Q1's "normal network" — the touch-the-world rule's exception d) |
| P15 | `flux-system` / source-controller | Kubernetes API; `ghcr.io`, `pkg-containers.githubusercontent.com`, configured GHCR token endpoint, `tuf-repo-cdn.sigstore.dev`, `rekor.sigstore.dev`; Gitea HTTPS read-only deploy-branch sources in both target namespaces | Platform OCI source fetch/reverification and reads of the two platform-created local GitRepositories. The installer-pinned Flux release must be at least 2.2.0/source-controller 1.2.0 (the `matchOIDCIdentity` fields are documented in https://github.com/fluxcd/source-controller/blob/v1.2.0/CHANGELOG.md). The one keyless publisher/verifier identity is defined in ADR 010 P15: issuer `^https://token\.actions\.githubusercontent\.com$`, subject `^https://github\.com/shady2k/lifemodel/\.github/workflows/release\.yml@refs/tags/v.*$`; `release.yml` signs, and the root OCIRepository verifies, that same identity and artifact digest. All world-facing signed-fetch endpoints are TCP 443. Platform-owned direct route, independent of application egress. (Flux verification: https://fluxcd.io/flux/components/source/ocirepositories/#verification.) |
| P16 | `traefik` | `lifemodel` / ingress gateway; `lifemodel-system` / operator (`boot.` host); Agent Vault (`vault.` host); `lifemodel-git` / Gitea (`git.` host, P25) | all named ingress routes, each with its stated ForwardAuth/setup exception; nothing outside the cluster reaches anything but Traefik |
| P17 | every namespace's module and platform pods | `kube-system` / CoreDNS :53 | cluster DNS ONLY — name resolution rides this row; a plain module has NO external-resolver row and NO direct DNS-to-the-world row (R5-05) |
| P18 | `openbao` / OpenBao server | `lifemodel-state` (Postgres :5432, Valkey :6379) | dynamic-credential issuance — the database engines' connect/audit legs (Q7); the ISSUED credentials' sessions ride P1/P2, never this row |
| P19 | `openbao` / OpenBao server | the Kubernetes API | the Kubernetes-auth TokenReview of a module's service-account login (Q7) |
| P20 | `traefik` | the Kubernetes API | route and endpoint discovery — Traefik's upstreams follow Endpoints by watching the API (R3-15); the routes it serves ride P16 |
| P21 | `lifemodel-system` / CNPG operator | the Kubernetes API; its Postgres instances in `lifemodel-state` | the CNPG control plane (its standard rights): Cluster reconciliation, instance management, declarative backups; the API server's calls INTO the CNPG and secrets-webhook Services are admission INGRESS, unaffected by the egress deny — the webhook endpoints only ANSWER on the same connections |
| P22 | `lifemodel-system` / Agent Vault | the world | the vault's own outbound leg — the egress path's LAST hop (R4-06); the vault reaches nothing else inside the cluster (R5-05's named omission) |
| P23 | REMOVED (R6-06) | No Gitea-to-CNPG route or database/role exists; SQLite and repository data share Gitea's own PVC. |
| P24 | `lifemodel-motor` / sandbox Jobs | `lifemodel-git` / Gitea HTTPS port | named sandbox exception: clone this repository, push `task/*`, open/update PR; no other internal route. Task account access is limited to this repository. |
| P25 | `traefik` | `lifemodel-git` / Gitea UI | owner UI on pinned `git.` host with ForwardAuth; Git clients use internal service instead |
| P26 | `lifemodel-git` / Gitea | `lifemodel` / egress gateway | chart 12.7.0 `deployment.env` sets `HTTPS_PROXY` and lowercase `https_proxy` for HTTPS push mirrors only, plus `NO_PROXY` and `no_proxy` for internal services (`values.yaml:338-341`; `templates/gitea/deployment.yaml:350-352`). HTTP mirrors are not supported. The operator reads `secret/data/gitea/mirror` from Bao and delivers the outside-remote credential to Gitea through Gitea's mirror API. The proxy caller binding is a dedicated gateway mirror listener on its own port, reachable by NetworkPolicy only from Gitea pods in `lifemodel-git`; Gitea cannot reach other gateway listeners. That listener is fixed to policy `gitea-push-mirror`, which permits CONNECT only to the configured remote host on 443. No proxy credential, bus authority or store authority is granted. Gateway-down failures retry and report; mirroring never gates rollout/rollback. Gitea has no direct internet route. |
| P27 | `lifemodel-motor` / sandbox Jobs | `openbao` / OpenBao | the generation operator provisions a unique zero-RBAC `run-*` ServiceAccount and matching `run-*` Bao role/ACL policy; each run reads only `secret/data/gitea/task-runs/<run-id>`, with no list, parent, admin or module-secret access. Its operator ACL has `create`, `update`, `delete` on only the run role, run policy, and exact run KV path (`update` is required because OpenBao writes ACL policies through `UpdateOperation`, including new policies; [API](https://openbao.org/docs/api/system/policies/), [pinned source](https://github.com/openbao/openbao/blob/ad64d389cb66023521c4228dc9f1149400d87351/internal/vault/logical_system_paths.go#L3880-L3888)). The run role sets `token_ttl` and `token_max_ttl` no longer than the run limit. Job-template validation is retained, and Pod admission checks the final post-webhook Pod against the same run identity/resource/deadline/volume rules. The durable token-issuance record drives teardown on every outcome and after crashes: delete the run auth role (stopping new logins), delete the run ACL policy and KV value (removing secret access for already-issued tokens), and delete its ServiceAccount; leftover sandbox tokens expire within the run limit. |
| P28 | `lifemodel-system` / loader | Kubernetes API | Create/read/update only its durable phase record, named custody/admin Secrets, and one read-only deploy-source credential Secret in each target namespace; patch only the owner-authorized digest field of the installer-owned root OCIRepository; create/read back exactly two application Kustomizations, one in each target namespace, and verify the platform-created GitRepository sources there. No GitRepository creation or ServiceAccount, Role, RoleBinding, NetworkPolicy, PSA label, admission policy, or applier-account write. |
| P29 | `lifemodel-system` / loader | `lifemodel-git` / Gitea HTTPS API | Initial administrator bootstrap, seed the repository from the pinned release, configure/verify protected branches, and create/verify the read-only deploy-source account. No generation writer receives these routes or credentials. |
| P30 | `lifemodel-system` / loader | `openbao` / OpenBao API | First-boot `sys/init`; custody-backed `sys/seal-status` and `sys/unseal` on every sealed restart; bootstrap `sys/auth`, `sys/policies/acl`, Kubernetes-auth config/role and named `secret/data/gitea/admin`, `secret/data/gitea/task-account`, `secret/data/gitea/mirror`, and `lifemodel/data/model/{primary,reserve}` operations; verify loader Kubernetes-auth login and revoke initial root token. The `loader-model` policy grants create/update/read on primary, create/update/read/delete on reserve only, and read-only metadata. Thereafter only loader-role grants plus custody-secret read/unseal. Loader model-check egress is `0.0.0.0/0` except pod CIDR `10.42.0.0/16`, Service CIDR `10.43.0.0/16`, and metadata/link-local `169.254.0.0/16`, without a port restriction; the only in-cluster model exception is TCP 11434 to namespace `ollama`. The generation operator's normal role never performs init/unseal/root retirement. |
| P31 | `flux-system` / `kustomize-controller`, `helm-controller` | `flux-system` / `source-controller` Service | Fetch Flux source artifacts over TCP 80 to the Service, forwarded to the source-controller container's HTTP port 9090. Source Service and deployment port mapping: https://github.com/fluxcd/source-controller/blob/v1.2.0/config/manager/service.yaml and https://github.com/fluxcd/source-controller/blob/v1.2.0/config/manager/deployment.yaml. |
| P32 | `flux-system` / Flux controllers | Kubernetes API | Flux source, Kustomization, HelmRelease reconciliation and status; the controller API connection required by the platform. |

Two platform facts bound what the rows promise (R5-05): NetworkPolicy does
not filter NODE-to-pod traffic (the kubelet's probes and the k3s agents'
plane reach pods regardless of the rows — observation only, O2-F's probe
exception), and a namespace NAME is not a route — every row selects pods
and Services by label, and the review diff checks the rendered rows
against the ACTUAL installed namespaces and ports, never the picture's
names. Enforcement is a pinned k3s setting: the embedded NetworkPolicy
controller stays ENABLED (`--disable-network-policy` is never set) — a
cluster without it refuses the bootstrap (N-19 asserts the setting).

The RBAC table (the socket proxies' replacement; the threat model's first
kept barrier — the operator is the only workload with cluster mutation
rights, and no module holds cluster-admin or any Docker equivalent):

| Principal | Rights | Notes |
|---|---|---|
| Flux controllers | platform root: verified signed OCI release; application source: generation-scoped namespaced objects only | the application source cannot modify platform resources, namespaces, CRDs, cluster-scoped objects, or platform RBAC |
| Application applier ServiceAccount (`lifemodel`) | generation-scoped application resources in `lifemodel`; no Secret permissions there | its HelmRelease impersonates this account; a separate RoleBinding in `lifemodel-releases` grants Secret get/list/watch/create/update/delete for Helm storage only |
| Application applier ServiceAccount (`lifemodel-motor`) | generation-scoped application resources in `lifemodel-motor`; no Secret permissions there | its HelmRelease impersonates this account; a separate RoleBinding in `lifemodel-motor-releases` grants Secret get/list/watch/create/update/delete for Helm storage only |
| Flux source-controller | read the local deploy-branch GitRepository credential Secret under source-controller's own identity | source-controller reads credentials; the application appliers do not; no applier Secret rights in either target namespace |
| CloudNativePG operator | standard CNPG rights in `lifemodel-state` | declarative Cluster, per-module NOLOGIN group roles, backups — the roles' SCHEMA grants come from the migration set's GRANT SQL, not the role declaration (R5-16) |
| Generation operator (cluster) | lifemodel workloads: Deployments/StatefulSets get/list/watch/patch/scale; pods get/list/watch/DELETE (confirmed pod termination is OBSERVED, never assumed — A12); HelmRelease get/list/watch + suspend/resume (the operator's OWNED gate field — the per-step VALUES change travels through the deploy branch as a Git commit, R5-01); Coordination Leases (leader election); the rollout records and generation registry in its own namespace; a migration JOB (create Jobs in `lifemodel-state`, running dbmate under the DDL role, Q8); the DISPOSABLE BUILD WORKLOADS in `lifemodel-system` ONLY — build Jobs create/get/list/watch/delete, their pods get/list/watch/DELETE, and the build's required resources (its own service account and ConfigMap inputs, the build-cache volume) in the SAME namespace — R5-07 | the WHOLE lifemodel mutation surface; there is no socket proxy and no Docker API anywhere in the cluster (Q9 as amended) |
| Generation operator (OpenBao role) | module-role lease revoke; exact Gitea paths: `secret/data/gitea/task-account` (read), `secret/data/gitea/mirror` (read), `secret/data/gitea/admin` (read only for separately authorized source-infrastructure lifecycle), `secret/data/gitea/task-runs/<run-id>` (read/write/delete), matching `secret/metadata/gitea/task-runs/<run-id>` (read/delete); per-run `auth/kubernetes/role/run-*`, `sys/policies/acl/run-*`, and exact run KV path (ACL `create`, `update`, `delete`) | no `list`/`read` on parent paths and no module secrets; ACL policy writes use OpenBao `UpdateOperation`, including new policies ([API](https://openbao.org/docs/api/system/policies/), [pinned source](https://github.com/openbao/openbao/blob/ad64d389cb66023521c4228dc9f1149400d87351/internal/vault/logical_system_paths.go#L3880-L3888)); task account is non-admin and distinct from the admin credential |
| Generation operator (Valkey user) | the `+@admin`-class user: epoch record writes (the panic bump), ACL administration, cross-schema health/reconciliation reads | the epoch CAS at a NORMAL switch is the new core's write, not the operator's (Q2) |
| Generation operator (Postgres role) | SELECT across the module schemas (done records, health evidence) + the `active_holder` verify-read | the named narrow reconciliation grant; writes go through the DDL role's migration Job only |
| Motor module ServiceAccount | Jobs create/get/list/watch/delete in `lifemodel-motor` ONLY; pods + pod logs read in the same namespace | the ONE named exception to operator-only mutation (Q9); any other verb or namespace is refused by the API server and counted |
| Every module pod's ServiceAccount | NOTHING (no cluster API rights) | the pod's only bootstrap material is this service account's projected JWT — OpenBao Kubernetes auth exchanges it for STORE credentials (Q7) |
| BuildKit build pod | NOTHING (no mutation, no credentials) | pushes to the registry; base images digest-pinned |
| Bank-Vaults secrets webhook | chart-managed mutating rights over module pods and sandbox Pods (adds the vault-env init container and wraps each module container's command) | official chart; not a lifemodel-written surface |

Hard edges of the view:

- **The operator is the only cluster-mutation surface, and RBAC verbs ARE
  the allowlist.** The pinned verb/endpoint allowlist the socket proxies
  carried — and the re-check-every-lifecycle-change duty (R3-19) — is gone
  with them: the operator's RBAC row above is a chart-declared, reviewable
  surface, and a module pod's service account grants it NOTHING. The
  boundary for modules is structural: no module reaches the operator, the
  registry, BuildKit, Agent Vault or another namespace's members beyond the
  policy rows — attempted, the connection is UNREACHABLE (N-8's method,
  carried).
- **Motor is the module exception to operator-only mutation — narrow and
  separate.** The Motor module runs agentic sandboxes as Kubernetes JOBS in
  `lifemodel-motor` under its own RBAC row (create/get/list/watch/delete of
  Jobs there; pods + logs read; nothing else, no other namespace). The
  generation operator stays control-only and never touches Motor's Jobs. The
  generation operator is the sole provisioning actor for per-run bindings: it
  creates/deletes ServiceAccounts only in `lifemodel-motor`, named `run-*`, with
  zero RBAC bindings. Because RBAC cannot constrain create by name prefix, a
  ValidatingAdmissionPolicy on ServiceAccounts in that namespace permits only
  the generation operator to create `run-*` accounts with zero bindings; its
  separate role grants create/get/delete only there, and its reconciler deletes
  only `run-*` names present in the durable issuance records (RBAC cannot express
  a dynamic prefix restriction on delete either). Its OpenBao ACL grants
  `create`, `update`, and `delete` only on `auth/kubernetes/role/run-*`,
  `sys/policies/acl/run-*`, and that run's exact KV path; OpenBao writes ACL
  policies through `UpdateOperation`, including new policies ([API](https://openbao.org/docs/api/system/policies/),
  [pinned source](https://github.com/openbao/openbao/blob/ad64d389cb66023521c4228dc9f1149400d87351/internal/vault/logical_system_paths.go#L3880-L3888)).
  There is no `list`/`read` on parent paths or module-secret access. Each run
  role sets `token_ttl` and `token_max_ttl` no longer than its run limit. The
  durable issuance record used for the task token records this binding before
  provisioning; teardown deletes the run auth role (stopping new logins),
  deletes the run ACL policy and KV value (removing secret access for already-
  issued tokens), and deletes the ServiceAccount on every outcome, with
  crash-safe reconciliation from that same record after operator restart;
  leftover sandbox tokens expire within the run limit. A sandbox Job carries no host
  mounts, no privileges, no bus or store route; its named routes are proxy egress P8 and internal exceptions P24 (Gitea)
  and P27 (OpenBao task-token delivery). **RBAC
  authorizes the CREATE verb, not the Job's fields (R5-09)** — so the namespace
  is PSA `restricted` (the chart pins
  `pod-security.kubernetes.io/enforce=restricted` and the warn label); admission
  also validates final Pods, after webhook mutation. A ValidatingAdmissionPolicy
  on Jobs validates the Job template, and one on Pods in `lifemodel-motor`
  refuses the final mutated Pod unless it follows those same run identity,
  resource, deadline, and ephemeral-volume rules. The Pod policy checks that
  the pod's ServiceAccount is the run-specific zero-RBAC account and its
  OpenBao role/policy and task-token path match the run id. A sandbox Job
  admission verifies the ServiceAccount and secret path match the run id,
  `activeDeadlineSeconds` set from the declared Motor run limit
  (no Job without a deadline), requests/limits REQUIRED on every
  container, and volumes LIMITED to the ephemeral types (the per-run
  workspace is a GENERIC EPHEMERAL VOLUME in the pod template — it lives
  and dies with the pod, so no PVC outlives its Job). Motor validates the
  SAME template against the SAME rules before submission (belt, not the
  boundary — the API server is the enforcement point), and CLEANUP IS
  TRACKED in the run registry: finished Jobs are deleted by Motor, and
  MOTOR IS THE PANIC'S AUTHORIZED SANDBOX-CLEANUP ACTOR — the panic
  transition's `lifemodel-motor` step is MOTOR'S OWN CLEANUP JOB, run by
  Motor's registered identity BEFORE that release's scale to zero
  (scaling Motor to zero alone stops no existing Job, and only Motor's
  row may DELETE a sandbox Job — the operator stays control-only): the
  job is narrowly authorized by the SAME RBAC row, ordered by the rollout
  record (written and read back complete — R4-09) so a cut between the
  cleanup and the scale is re-driven, and an interrupted cleanup is
  re-driven from the registry at Motor start; the walk asserts NO running
  sandbox and NO retained unowned volume survive a cut. Motor authority is scoped by the API
  server's RBAC — stated plainly: the operator's rights are the wider
  blast radius (the ADR's "Bad" consequences), and Motor's narrow row is
  the module-side limit (Q9's one named exemption).
- **Credentials at the store edges, per PROCESS (R4-05).** OpenBao issues
  short-lived Postgres and Valkey credentials per module ROLE with least
  privilege (decision 7) — one pod may host processes of different reach
  (the function host's adapter and workerd), so zero credentials attach to
  the PROCESS: a process runs with a scrubbed environment unless the
  per-process matrix below grants something. The core gets the epoch-checked
  snapshot commit (the Lua CAS script, granted to the core role alone) and
  `pg.apply` on its own schema, and answers a fresh adapter's repair on the
  addressed `state.bootstrap.<instanceId>` streams (R4-04) — position-
  stamped, trimmed only behind the instance's consume-through watermark,
  DUAL-APPENDED to the shared group route through the overlap so the
  still-serving old instance never misses a change (R5-13); the ADAPTER
  process consumes group `adapter` on the bus (projections, `http.result`
  for its parked deliveries) and its own `state.bootstrap.<self>` stream
  at its own recorded position,
  produces `cmd.state`, the function host's own `cmd.egress.<function-host>`,
  and the function's declared `signal.<kind>` on the bus, with its done
  records in the function host's own Postgres schema; the WORKERD process
  holds NOTHING (no credential of any kind, no store connection —
  vault-env execs only its own module process, and the spawned-child
  fixture asserts the workerd environment scrubbed of every
  OpenBao-issued value — N-10); the INGRESS GATEWAY
  consumes `cmd.send` and produces `inbound` plus `send.settled` on the
  bus, keeps its own schema, and carries ONLY the two named narrow grants
  (SELECT transcript; INSERT-by-key `conversation_message` — the message
  row is the web delivery proof, decision 5); the EGRESS GATEWAY consumes
  every `cmd.egress.<module>` stream as group `egress`, produces
  `http.result` on the bus, keeps its own schema (its done records), and
  holds Agent Vault for key injection; Motor holds its own Postgres schema,
  its own command stream, and publishes its `motor.result` on the bus; every
  other module holds its own Postgres schema and its own command stream
  only. The OPERATOR connects with an `+@admin`-class Valkey user (epoch
  writes at panic, ACL changes, cross-schema reads for health and
  reconciliation) and a cross-schema Postgres health role — the two
  operator reconciliation grants. A bug is contained to one schema.
- **Secret delivery is invisible to the pod spec (the platform's
  replacement of "invisible to the Docker API"; the R5-04 owner decision
  of 2026-10-12 names the mechanism).** The Bank-Vaults secrets webhook's
  mutating admission adds an init container that copies the `vault-env`
  binary into a shared volume and wraps the module container's command:
  vault-env authenticates with the pod's service account (Kubernetes
  auth), resolves the pod's secret references into environment variables,
  flushes its login token, and stays the process's PARENT — it execs the
  module process (daemon mode). Credentials live in the module process's
  environment AFTER start —
  `kubectl get pod -o yaml` carries NO credential material (no `env`
  secret values, no `envFrom` references, no secret volumes, nothing in
  etcd-backed Kubernetes Secrets), leases
  renew, and vault-env EXITS — Kubernetes restarts the container — when a
  renewal fails or a credential actually changes (max TTL 7 days,
  `LIFEMODEL_LEASE_MAX_TTL`; a renewal that lands does not). There is
  no wrapped AppRole secret-id anywhere: the pod's ONLY bootstrap material
  is its service account's projected JWT (Kubernetes auth). The one
  fallback that would put a credential in the pod spec (operator-rendered
  env, A5) is a RECORDED POSTURE DOWNGRADE, never a default.
  **Lease lifecycle (R3-16, carried, re-mechanized):** at every process
  start — including Kubernetes' in-place restart of a crashed container
  (Q5) — vault-env re-authenticates with the service account and issues
  fresh leases; a vault-env crash (or its exit on a renewal failure or a
  credential change) takes the module process down with it and the same
  restart supplies a fresh boot. A REPLACEMENT (new code) is
  never Kubernetes self-healing: it arrives only through a rollout the
  operator drives through the deploy branch. Renewal and expiry are
  INDEPENDENT of OpenBao's availability by a LOCAL rule (R5-20): the
  supervising agent (vault-env in daemon mode, the R5-04 owner decision)
  tracks each
  lease's issue time and term and
  enforces a LOCAL validity deadline on its own clock — renewals are
  attempted on schedule, and a renewal failure past the deadline stops
  the supervised work VISIBLY (the process exits naming the expired
  lease; the restart re-authenticates when Bao returns). An open
  Postgres/Valkey session does not die merely because its lease expired
  and Bao cannot revoke it — the local stop-at-deadline rule is the
  expiry mechanism, never an assumed server-side revoke; the module's
  failure is counted and reported, and the operator re-bootstraps it when
  Bao returns. Lease issuance at a generation start is STAGGERED
  (`leaseIssueStaggerMs`), so the module set's leases do not all reach max
  TTL together.
- **Modules talk only through the bus.** Language, process and machine are
  each module's own business; the bus contract (AsyncAPI + JSON Schema) is
  the load-bearing standard (decision 8): FULL-compatible both directions,
  checked at build. The core makes no external call: everything outbound is
  a keyed command event the owning module runs, with results coming back as
  bus events.
- **Volumes and state homes on k3s.** Valkey's AOF on a PVC; Postgres on
  CNPG's declaratively managed volumes; OpenBao state per its chart —
  the chart's default SHAMIR seal with LOADER CUSTODY: the loader initializes
  Bao once, persists and reads back the key share and initial root token in
  its platform-owned `lifemodel-system` custody Secret, unseals on every
  sealed restart, verifies its Kubernetes-auth role, then revokes the root
  token through the verified bootstrap-to-steady-state hand-off (R5-06);
  the generation operator uses only its normal Kubernetes-auth role and
  never holds the unseal key or performs init/unseal/root retirement;
  the snapshot + its 3 copies in Valkey (unchanged);
  Motor's per-run workspaces are GENERIC EPHEMERAL volumes in the sandbox
  pod template — no PVC outlives its Job, cleanup tracked in the run
  registry (R5-09);
  skills are Postgres ROWS, never materialized or executed as files; the
  ONNX embedder is baked into the core image; logs are stdout (kubectl
  logs). NO shared module volume carries memory, configuration or source:
  Gitea's separate PVC is the source-of-truth repository, and module code
  lives in IMAGES. A shared runtime volume tree would reintroduce the
  two-writer clobber the whole design exists to remove (O4-D's rejection
  carries).
- **The module set and images (A1, R3-18 carried).** A generation = a
  commit = the deploy branch's desired state: a set of per-module images,
  each tagged with the hash of its CANONICAL BUILD IDENTITY — the git tree
  id of the build context, the selected Dockerfile's path and content, each
  named additional context's name and tree id, and the admitted build
  options. An unchanged module's tag resolves from the previous commit and
  is reused without a build; the commit-pair schema check still runs at
  EVERY rollout (point 5), so reuse buys build cost, never a skipped
  check. Base images are pinned by digest; the operator passes no build
  args. The registry is a NODE pull surface (R5-08): one stable endpoint
  serves BuildKit's push (P13) and the node's containerd pull; the
  installer writes the node's trust for that endpoint
  (`registries.yaml`, or plain HTTP on a node-local address on the
  single-node deployment — the lighter option) before any module pod is
  scheduled, and the registry's one volume on the sole node has its
  persistence/recovery checked separately (Q12's cold-pull case). The Compose-shape rule "launch rights/flags are the loader's, never
  the file's" is SUPERSEDED by A1: the application workload declaration — probes,
  `terminationGracePeriodSeconds` and strategy — lives in the repo's Helm
  chart (a reviewed file in the commit); NetworkPolicy and RBAC are
  platform-owned, not generation declarations, and the operator
  derives what it needs (call manifest, delivery-to-result bound, rollout
  order) from the chart's values/annotations, never from code
  introspection.
- **Traefik's upstreams are DISCOVERED, not pinned lists (R3-15, carried).**
  Every route resolves through a Kubernetes Service whose Endpoints follow
  pod readiness — per-request resolution, no stale list, no reload. The
  WHOLE root-host surface — UI/session AND submit — terminates on the
  ingress gateway's Service, whose membership is readiness-gated (the
  `intake-ready` pool's analog); the web content itself is served by the
  ingress gateway (transcript rows it reads with its scoped grant; replies
  pulled from it), so the surface UPDATES ITSELF only when an INGRESS
  instance is replaced; a core replacement moves no Service at all (the
  core is bus-reachable — R4-06). A replaced gateway's endpoint leaves the
  Service only when its readiness drops / the pod terminates — removal
  never precedes the stop it implies, so a submission in flight lands on an
  intake that is still accepting. A POST whose server-side write succeeded
  but whose HTTP response was lost retries with the SAME idempotency key
  against the moved route (the inbound dedup ring absorbs it).
- **The owner's entry is NAMED route by route, not a ForwardAuth blanket
  (R5-19).** The root host carries two unauthenticated exception routers
  and one boot exception, and everything else is guarded FROM THE START:
  the ForwardAuth LOGIN page and the static ASSETS are the unauthenticated
  exception routers; the first-boot SETUP router (set the operator's
  login password — the outcome-4 walk's "sets the loader password")
  is unguarded ONLY while the bootstrap record shows setup incomplete,
  and it CLOSES at the record's completion (the walk asserts the
  closure); every OTHER owner router — the ingress gateway's UI/session/
  submit/transcript/reply surface AND the operator's boot/panic UI and
  API — carries ForwardAuth to the operator's auth endpoint WITHOUT a
  boot exemption, because applying it everywhere would block the first
  login while applying it only to boot leaves chat and transcript
  unguarded. The `boot.` host is the operator UI's ForwardAuth route; the
  `vault.` host keeps Agent Vault's OWN narrowly authenticated UI (the
  lighter option — the same auth posture the Compose shape gave it) as
  the owner's KEY-ENTRY surface: the key provisioning that ran "through
  the loader" runs through the vault UI route, and the vault holds NO
  other published route. Traefik's SECURITY surface: pinned hosts,
  per-router ForwardAuth with the two named exception routers plus the
  closing setup exception, no admin dashboard exposed.
- **Clean-start bootstrap is two-layer GitOps from the first second (F7,
  R6-05/R6-06).** The one command installs only k3s, Flux and the pinned
  platform source: a signature-verifying `OCIRepository` plus its root
  `Kustomization` in `flux-system`. The installer supports keyless
  `matchOIDCIdentity` verification (default) and key verification through
  `secretRef` to a public key. During development, tests use a throwaway
  cosign key and a registry local to the test VM; nothing is published. The
  keyless `release.yml` path is first proven at the first real platform
  release through ship-release (owner, 2026-10-13). No workload, Helm release, or credential
  is installed or held imperatively. Flux reconciles the signed platform
  release, including the loader and Gitea. The Gitea chart is platform-owned,
  pinned at 12.7.0, uses SQLite (`database.DB_TYPE=sqlite3`), and stores
  repository data and the database on one PVC in `lifemodel-git`.

  The loader's first start performs only the initialization that cannot be
  declared as platform desired state. It is a durable, idempotent state
  machine; it records each completed phase before moving on and re-verifies
  the phase's identity on resume. Its ordered phases are: (1) initialize
  OpenBao once when uninitialized, persist and read back the Shamir
  unseal/root custody material, and unseal from that custody on every sealed
  restart;
  (2) create the initial Gitea administrator by creating the namespaced
  Kubernetes Secret consumed by chart 12.7.0's admin setup; (3) wait for
  Gitea readiness and verify that administrator authentication works; (4)
  seed the repository from the exact same pinned release/revision that
  supplied the platform artifact; (5) configure branch protection and
  verify it; (6) create the read-only deploy-branch credential Secrets in
  both target namespaces; and (7) verify the platform-created GitRepository
  source in each target namespace and create one application Kustomization
  there, named for `lifemodel` or `lifemodel-motor`. Each Kustomization's
  `serviceAccountName` names its platform-provisioned applier in the same
  namespace. Each may reference only a same-namespace HelmRelease; that
  HelmRelease uses its own same-namespace applier identity, sets
  `spec.storageNamespace` to its dedicated platform-owned release namespace,
  and obtains its chart from the local GitRepository at the chart path in the
  deploy branch.
  The first generation is accepted only after both Kustomizations and their
  application resources reconcile. No generation can
  write the platform artifact, pin, source, or platform objects.

  **Gitea administrator mechanism (verified against the official 12.7.0
  chart):** the loader-generated Secret is named by
  `gitea.admin.existingSecret`; the chart's init template calls its
  `configure_admin_user` routine when that reference exists. Set
  `gitea.admin.passwordMode: initialOnlyNoReset`, not `initialOnly`; this
  creates the account initially without later password synchronization.
  Source: official chart package
  https://dl.gitea.com/charts/gitea-12.7.0.tgz (`values.yaml`,
  `templates/gitea/init.yaml`, `templates/gitea/deployment.yaml`,
  `templates/_helpers.tpl`); version and digest are listed in the official
  chart index https://dl.gitea.com/charts/index.yaml. The chart renders a
  Secret reference in the Gitea Deployment while `existingSecret` is set.
  The loader therefore retains the Secret for the lifetime of that
  reference. R6-05 remains binding: never delete a Secret while a live
  rendered object refers to it. If a later platform release removes the
  reference, first verify the new rendered workload and replacement Pod,
  then delete the no-longer-referenced Secret. The read-only Flux credential
  Secret follows the same rule while its source object refers to it.

  These phases resume safely after interruption before and after each
  persisted action: OpenBao init/custody write and read-back; unseal; admin
  Secret creation and Gitea readiness/authentication; repository seed;
  branch protection; Flux credential creation; and second-source creation
  and reconciliation. A retry verifies the existing identity/revision and
  continues; it never reinitializes Bao, overwrites an established
  repository, rotates credentials blindly, or deletes a referenced Secret.
  Missing custody, changed source identity, partial seed, or a failed
  verification stops visibly at that phase for recovery; it is not reported
  as ready. The loader's steady-state OpenBao identity is established and
  verified before any one-time root authority is retired. The loader does
  not imperatively install or upgrade platform dependencies.

  **Delivery boundary (owner, 2026-10-13).** The coordinator runs
  `generations/clean-vm-install` as a manual acceptance check over SSH on
  owner-provided test VMs (NixOS first, then Ubuntu for `scripts/install.sh`).
  The owner restores the VM's clean hypervisor snapshot before each
  from-scratch check. This is not a CI walk or a k3d delivery walk.
  Existing-cluster installation (`helm install`) is removed and deferred to
  lifemodel-xc9: its future installer will use an owned namespace, allow
  each platform dependency to be switched to an external service (for
  example `openbao.enabled=false`), and use no Flux or cluster-scoped
  resources. It is not a second entrypoint here. The manual acceptance
  check is `generations/clean-vm-install`; k3d is not a substitute for it.

### Platform upgrades and rejected delivery choices

A platform upgrade is an owner-commanded change of the pinned signed release
through the loader UI. CI publishes and signs the new artifact; the loader
changes the root `OCIRepository` reference/digest only after the owner
selects that release. Flux verifies the pinned publisher identity and
reconciles the platform. During this operation the application source stays
at its current deploy-branch revision: it is neither rewritten, suspended,
nor advanced by the platform upgrade. A Gitea outage leaves already-running
generations serving; Flux reports the unavailable application source and
starts no new generation until Gitea is healthy. A failed platform
reconciliation does not silently change the app source or roll the platform
back to an unverified artifact. The upgrade reports its failed resource and
holds for owner recovery.

The following alternatives are rejected or deferred:

- **Installer-owned Helm bootstrap:** rejected. The clean-VM command installs
  only k3s, Flux, and the single pinned platform OCI source; it owns no Helm
  release and holds no credentials.
- **Flux reading platform manifests from Gitea:** rejected. Gitea is itself
  installed by the platform, so this creates a bootstrap cycle and makes the
  trust root depend on a service it must create. Generations alone use Gitea.
- **Existing-cluster installation in this milestone:** deferred to
  lifemodel-xc9. That feature will use an owned namespace, optional external
  dependencies (including `openbao.enabled=false`), no Flux, and no
  cluster-scoped resources. There is no existing-cluster `helm install`
  check or walk here.

## Streams and the bus contract (Q13 — the tick is the only boundary)

The events below are the BUS CONTRACT (decision 8): each event type is an
AsyncAPI document with JSON Schema payloads in the repo, FULL-compatible in
BOTH directions — old and new modules read each other's events during a
per-module rollout — checked at build; a breaking change is a NEW event type
published beside the old one, the old removed by a later contract step.
Delivery is at-least-once (stream consumer groups); every consumer is
idempotent by the event's own key. The core's event publications are part of
its tick commit (the outbox IS the commit): a committed snapshot and its
events are one atomic, epoch-checked write.

### Streams

| Stream | Written by (Valkey ACL) | Consumed by | Contents |
|---|---|---|---|
| `bus` | the core (its commit outbox) and Motor (`motor.result`), the adapter (function signals, `state.projection` forwards + the applier's overlap DUAL APPEND — R5-13), the ingress gateway (`send.settled`), the egress gateway (`http.result`) | the core's tick loop (group `core`), the adapter (group `adapter`) | `signal.<kind>`, `send.settled`, `state.applied`, `http.result`, `motor.result`, `state.projection` (each carrying the applier's monotonic projection position — R5-13) |
| `inbound` | the ingress gateway ONLY (ingress-only user, `+xadd`) | the core's tick loop (plain read; offsets in the snapshot) | `inbound.message` |
| `cmd.egress.<module>` | one stream per requesting module; a module's ACL grants XADD on ITS OWN only | the egress gateway (group `egress`) | `http.request` keyed commands |
| `cmd.send` | the core (its commit outbox) | the ingress gateway (group `send`) | `send.command` keyed commands |
| `cmd.motor` | the core (its commit outbox) | the Motor module (group `motor`) | `motor.command` keyed commands |
| `cmd.state` | the adapter only | the core's keyed-command applier (group `state`) | function `state.command` / `schedule.set` / `schedule.cancel` forms; the adapter's keyed `bootstrap.request` (R4-04) |
| `state.bootstrap.<adapter-instance>` | the core's applier (its commit outbox) | the ONE addressed adapter instance (plain read — the instance's OWN read position, no group competitor); through the overlap every change is ALSO appended to `bus` (dual append — R5-13) | `state.projection` completion packets and (until the consume-through watermark barrier) every subsequent projection change, position-stamped — instance-specific delivery through an old/new adapter overlap (R4-04); trimmed only after the addressed instance CONSUMED THROUGH the applier's head (a crash before the barrier resumes from its recorded position — R5-13) |

The per-requester command stream is the identity mechanism (point 3): the
requester's identity IS the stream it wrote to — a module's ACL refuses
XADD on another module's command stream, so the egress gateway's per-module
policy and logging derive the caller from the stream name (verified origin,
not a header). Identity names PRODUCTION only: consuming another module's
command stream grants no identity and no producing right — the one
designed cross-consume is group `egress` over the `cmd.egress.*` set, whose
produce rights on the bus are the exact `http.result` grant (R4-05). No
mTLS anywhere.

| Event (type) | Producer | Consumer | Idempotency key |
|---|---|---|---|
| `inbound.message` | ingress gateway | the core's tick loop | channel message id (client idempotency key or minted uuid; dedup ring in snapshot) |
| `signal.<kind>` (internal signals: neurons, reactions, thoughts — and the five function plugins' signals) | the core's tick work and neurons (core plugins); function plugins via the adapter | the core's tick loop | signal id (producer-assigned, uuid) |
| `http.request` | the core (model calls: the request built in the tick, `src/llm/provider.ts`'s shape); the adapter (a function's declared `tool.request` routed as a normal keyed command) | the egress gateway | the effect id minted at the deciding tick (declared timeout + keyed/unkeyed class ride the command) |
| `http.result` | the egress gateway | the requesting module's consumer (the core, or the adapter for a parked function delivery) | the request's effect id |
| `send.command` | the core's intent application, post-commit | the ingress gateway's send applier | send effect id (minted with the send decision, persisted with the tick) |
| `send.settled` | the ingress gateway's send applier (result after the insert-by-key) | the core's tick loop (turn settlement → inbound outcome) | send effect id |
| `schedule.fired` | the core's scheduler tick | the core's tick loop | fire id = `scheduleId:nextFireAt-ms` (exact today's, scheduler-primitive.ts:333) |
| `delayed.fired` | the core's scan (delayed-event rows, R3-14) | the core's tick loop | delayed-event id (minted at the deciding tick, persisted with its commit) |
| `state.command` (`state.set`, `state.delete`, `schedule.set`, `schedule.cancel`) | a function module, via the adapter | the core's keyed-command applier | state key = the command's natural key + correlation id |
| `state.applied` | the core's applier (its commit outbox) | the function module (delivered by the adapter on a later call) | the command's natural key + correlation id |
| `state.projection` | the core's applier (its commit outbox) | the adapter (holds the LATEST per `(module, projection)` — latest by the event's monotonic position — and attaches it to the delivery envelope) | `(module, projection, version)`; the version is CONTENT-DERIVED (a content hash), so unchanged content re-publishes the SAME key and two distinct updates of one key cannot collapse; ORDER rides the applier's monotonic position, never the hash (R5-13) |
| `tool.request` / `tool.result` | function → adapter → `cmd.egress.<function-host>`; result back through the adapter | the egress gateway; then the adapter re-invokes the function | the adapter-minted effect id (same id both legs; two invocations, not a session) |
| `motor.command` | the core's motor tool, post-commit | the Motor module | `runId:step` |
| `motor.result` | the Motor module | the core's tick loop | `runId:transition-seq` |

Rules the tables encode:

- **External actions run after the tick commits, from command events**
  (charter and decision 4, kept by point 4 minus the executor): the core
  makes NO external call — sends, model and tool requests, motor runs are
  command events the OWNING module runs, with results coming back as bus
  events; the loop never calls out mid-tick.
- **Both event directions are compatible across a rollout** (decision 8):
  the FULL both-ways build check is what lets an old and a new module read
  each other's events during the mixed window.
- **Unknown event types are a READER rule, not a crash:** ACK + drop by
  default (Tolerant Reader), counted in the consumer's log; a consumer that
  could double-apply another reader's effect declares an EXCLUDE list in the
  contract, checked in BOTH directions at build. Dual publication never
  double-fires: the parallel old/new publications share the minted effect
  key, and the destination's done record answers the second delivery —
  publish twice, apply once.
- **Contract retirement has a rule (R4-15), not a promise.** This
  milestone contracts NOTHING: the gate is expand-only FULL compatibility
  and a deprecated event or field is only MARKED. A later contract step
  that removes an old shape is admissible only when (a) no commit the
  compatibility window could still boot consumes or produces the old
  shape (the point-5/boot comparison reads the window's commits), and
  (b) no outstanding bus reference can still deliver under it — retained
  entries naming the old type have passed the trim floor (N-21) and no
  retained snapshot copy's pending-effect list names it (the R4-10
  re-issue paths). Failing either, the same build comparison refuses the
  trimming candidate with the diff as the report.
- **A turn abandoned at a switch or crash replays its inbound entries once**
  (offsets and the dedup ring live in the snapshot) and re-runs; its
  re-issued commands carry the SAME effect ids, so no send, fire or motor
  run happens twice.
- **Delayed `core.schedule` events have a durable home (R3-14, carried):**
  a delayed event is a delayed-event ROW written by the core's applier in
  the same keyed-apply transaction as the schedule advance; the core's scan
  produces `delayed.fired` when due — the same fire-exactly-once pair as
  scheduler fires; no process timer holds a delayed event anywhere.

### The function adapter contract (R3-10, carried as requirements)

A function receives EVERYTHING through the adapter's delivery of the input
event and answers on the same delivery (one synchronous answer per
invocation, A9): the envelope carries the event body, the event's
idempotency key, the function's declared input schema version, the
correlation id, and the LATEST `state.projection` content for the
function's declared read set. A function's only published influence is
`signal.<kind>` events handed back through the adapter — plus, in the
delivery response, the declared command forms of its contract fragment:

- **Write path:** `state.set` / `state.delete` / `schedule.set` /
  `schedule.cancel`, each with its natural key and the correlation id. The
  adapter publishes the form on `cmd.state` as a keyed command (done record
  by key, XACK after the result); the core's applier applies it to the
  core-schema rows (reminder rows, news per-source state with
  `lastFetchedAt`, calories user properties, web-search/web-fetch settings)
  and emits `state.applied` (same correlation id) — the function's
  acknowledgement, delivered by the adapter on a later call. Reminder's
  schedules become `schedule.set` writes of the SAME schedule rows the
  tick's scan already advances — no parallel scheduler anywhere.
- **Read path:** the function's manifest declares a bounded READ SET
  (projection name + the natural keys it needs). The core's applier
  publishes a `state.projection` event whenever that content changes,
  each event carrying the applier's MONOTONIC projection position; the
  adapter holds the LATEST per `(module, projection)` — latest by
  POSITION, a packet applied only when its position is greater than the
  consumed one (R5-13) — and attaches it to every delivery envelope. The
  function never polls and never opens a store connection: reads are
  pushed.
- **Bootstrap order (a named requirement, not an optimization).** A FRESH
  adapter instance — a replacement's new instance or a restarted sole one
  — holds no projection cache, and its predecessor has already ACKed and
  trimmed the projection history, so the fresh cache is REPAIRED FROM
  CURRENT DURABLE ROWS over the bus: the adapter joins group `adapter`
  first, publishes a keyed `bootstrap.request` into `cmd.state` carrying
  its INSTANCE id, and the core's keyed-command applier answers on
  `state.bootstrap.<instanceId>` — a DEDICATED projection stream whose
  read position belongs to THAT instance alone (R5-13's lighter
  mechanism, replacing dual routing plus exit-time switching): a
  per-instance fan-out has no competing group member to drain it during
  an old/new OVERLAP, so a projection addressed to the fresh instance
  always reaches the fresh instance. The applier — the only writer,
  serialized — re-publishes a complete `state.projection` packet per
  `(module, projection)` of the requested read set (content-derived
  versions, monotonic positions) and, until the retiring instance's
  confirmed exit, appends EVERY subsequent projection change to BOTH
  routes — the instance stream AND the shared group route (DUAL APPEND,
  R5-13): a change the fresh instance consumes from the shared route
  still reaches the STILL-SERVING OLD instance's cache, so no
  overlap-window change is missed by whichever instance keeps serving;
  the fresh instance consumes at its own position,
  applying a packet only at a position GREATER than its consumed
  watermark for that key — position, never content hash, orders claimed
  old packets against newer repairs. The stream is retired through a
  CONSUME-THROUGH WATERMARK BARRIER, not deleted at the exit: the
  instance stream survives until the fresh instance's consumed-position
  watermark reaches the applier's current head (its complete read set
  consumed), and only then is it trimmed while the fresh instance reads
  projections from the shared group route from then on — a fresh-adapter
  crash BEFORE the barrier finds its undelivered packets in place and
  resumes from its recorded position, losing no change (R5-13). EVERY
  fresh adapter bootstraps this way at its own start,
  INDEPENDENT of the owning module's activation and of any readiness for
  work delivery (R4-04: an unchanged core is not restarted, and neither
  the adapter nor a function gets store access). The fresh adapter claims
  a predecessor's PEL entries only AFTER the repair completes — a claimed
  pre-repair packet for a repaired key is dropped, counted, never applied
  backward. The ADAPTER's readiness REQUIRES its declared read set
  complete before its function leg serves any delivery (bounded by
  `readinessWindowMs`; an unanswered request past the window is failed
  readiness, reported, never an empty cache presented as complete). A
  function never sees an EMPTY read set.
- **Correlated tool routing:** a function that must reach outside its read
  set (web-search) returns a declared `tool.request` form; the adapter
  holds that delivery un-XACKed in its PEL, publishes the request as a
  normal keyed `http.request` command (the egress gateway takes it), and
  re-invokes the function with the correlated result on `tool.result` —
  two invocations, not a session. A parked delivery counts as an
  outstanding reference in trimming; its parked wait is BOUNDED by the
  module's declared delivery-to-result bound (R4-02) — past it the
  delivery is released, counted and reported, never parked unbounded; an
  unknown or late result is counted and reported, never silently dropped.

### The egress gateway is an availability and cost chokepoint

It is run like one: bounded queues with a VISIBLE BACKLOG, so a stalled
gateway or Agent Vault is NAMED as the outage by the health window's
counters, never just a slow tick downstream (carried requirement). Its
per-request timeout is enforced on its own side; per-module policy and
logging are its own; rate limits are added there when needed. Its restart
loses nothing: commands are keyed, its done records dedup re-runs, and
in-flight HTTP requests cut at its termination grace period re-run by the new instance
under the same effect id.

## State ownership (every inventory 1.3 row)

Task-specific amendment, 2026-10-20: proposed
[ADR-014](../../adr/014-task-runtime.md) replaces row 17's separate Motor owner
with core-owned keyed task registry/mailbox/outbox rows. Proposed
[ADR-015](../../adr/015-storage-module.md) adds the platform storage module and
SeaweedFS for retained output/marked files; private ephemeral work volumes still
die with their Jobs. The [task views](../motor/tasks-design.md) carry the new
component/lifecycle interaction. These decisions are not built behaviour; the
older table below remains the ADR-010 baseline where not expressly amended.

Decided by ADR-010 question 4 as amended 2026-10-12 (neurons stay core
plugins; the five feature plugins become function images; plugins change
only via commit + generation; skills = Postgres data). Charter-fixed rows
restated. "Snapshot" = the ONE epoch-checked Valkey envelope (versioned,
additive fields, Tolerant Reader — decision 8; NO conversion step exists in
either direction). Postgres is ONE SCHEMA PER MODULE; "core schema" below is
the core module's schema.

| # | Inventory 1.3 row | New owner | Notes |
|---|---|---|---|
| 1 | Event bus | Valkey stream `bus` | one stream, total order; trimmed as offsets advance (journal replay is charter-out) |
| 2 | Queued internal signals | Valkey stream `bus` (signal events) | the `pendingSignals` FIFO (core-loop.ts:315) becomes stream entries; offsets in the snapshot; recomputable classes stay recomputable |
| 3 | Event queue class | deleted | the dead `InMemoryEventQueue` (event-queue.ts:12) is replaced by the stream consumer; no shim (design principle 5) |
| 4 | Tick snapshot | Valkey snapshot envelope | agent state, sleepState, energy mirror + cross-tick fields of inventory 2.1 + inbound offsets/dedup + the applied ring (a FAST PATH only — Postgres idempotency is by natural key); committed every tick (charter-fixed) |
| 5 | UserModel | snapshot | rides the envelope (today state-manager.ts:61-67); tick-speed mutations, loop-consistent |
| 6 | Conversation history + statuses + completed actions | **Postgres, core schema** | append-only message rows end the whole-file rewrite (conversation-manager.ts:77-102); read at turn build; not rolled back; the ingress gateway holds the scoped INSERT-by-key/SELECT grant (the web delivery proof) |
| 7 | Vector memory | Postgres pgvector | charter; supersedes ADR-005's storage leg; LanceDB path deleted |
| 8 | Memory graph | Postgres (core schema) | consolidator writes transactionally |
| 9 | Soul | Postgres (core schema) | one JSONB document + version (shape of soul-provider.ts:48 kept) |
| 10 | Durable inbound log | Valkey stream `inbound` + snapshot | entries XADD'd by the ingress gateway (AOF fsync = today's awaited flush, the former file-based inbound implementation:609-617); per-recipient offsets + dedup ring INSIDE the snapshot commit; replay = post-offset minus dedup |
| 11 | Recipient registry | Postgres (core schema) | small routing table; survives switches |
| 12 | Ack registry | snapshot | aggregation-layer cross-tick state (inventory 2.1's persisted exception); snapshot-per-tick ≥ today's 500 ms debounce |
| 13 | Plugin enable/disable | Postgres configuration (core schema) | (intent-applicator.ts:1179-1199 moves to a store row) |
| 14 | Plugin keys + schedules | Postgres configuration (core schema) | schedules reload at activation (`nextFireAt <= now` fires as seen — restart-safe scheduling, principle 7); the five functions' schedule writes arrive as `schedule.set` commands for the SAME rows |
| 15 | Config file | Postgres configuration | charter explicit; the settings interface writes through; a config-changed event reloads the running generation |
| 16 | LLM keys / Telegram token | OpenBao + Agent Vault | model keys behind Agent Vault via the egress gateway; Telegram later (inbound via ingress webhook or egress polling, sending via egress — point 4's stated path) |
| 17 | Motor run registry | Postgres, MOTOR module's schema | Motor writes its result rows under the same rules as every keyed writer (its own applier, done records, natural key `runId:step`); results as keyed bus events |
| 18 | Motor artifacts/workspaces, skills/plugins dirs, ONNX cache, logs | **split** | workspaces: per-RUN GENERIC EPHEMERAL volumes in the sandbox pod template — they live and die with the pod, no PVC outlives its Job, finished Jobs are deleted and cleaned up through the run registry's tracked cleanup (R5-09); skills: Postgres DATA, loaded into the tick's context, never materialized or executed as files; the five feature plugins: function IMAGES built from the repo's build declaration — a plugin change is a commit + generation, never a hot reload, NO function-held state (their rows are core-schema state owned by the core's applier: keyed state commands and push projections through the adapter contract); ONNX model: baked into the core image (code-pinned); logs: stdout, kubelet-rotated container logs |
| 19 | Operator records + vault store | **split, platform-owned** | the GENERATION OPERATOR's rollout records + generation registry: cluster resources in `lifemodel-system`, written by the operator's RBAC surface before any action (the record-write rule below); panic and maintenance are CLUSTER state (Flux suspend + scale to zero — no panic.json exists on k3s, F7 amended); Agent Vault's store: its own chart-managed state in `lifemodel-system` |
| 20 | Repository | in-cluster Gitea (static, `lifemodel-git`) | R6-06 lifecycle owner is the platform layer: signed release + Flux owns the Gitea chart, release, PVC, policies and routes; generations cannot mutate them. Protected `main` and deploy branches, with only the operator writing either; Flux reads deploy with read-only auth; tasks push `task/*` and open PRs with operator-managed task credentials; module images live in the LOCAL REGISTRY tagged by build-input hash. Gitea uses SQLite and repository data on one PVC. Backup is deferred. On source identity/revision loss, hold reconciliation for owner recovery; never auto-reseed. A future one-volume backup verifies required commits/auth/rules before restore. |
## Module rollout sequences (F1-F3; simplification point 1)

The generation is the commit = the DESIRED STATE in the deploy branch (the
per-module HelmRelease image tags together with their chart/values launch
state — R5-10); Flux applies it; the GENERATION
OPERATOR is the controller that OBSERVES, GATES and ROLLS BACK — it
replaces only the modules whose rendered desired state changed (image tag
OR chart/values launch state), ONE BY ONE IN MANIFEST
ORDER (the chart's declared rollout order, carried by each module's
HelmRelease). THE GATE IS A GIT STEP (R5-01): a rollout of a candidate is
a sequence of deploy-branch commits, one per changed module, pushed by the
operator; each step closes only when the Flux controller has ACKNOWLEDGED
the step — the release observed applied at the RECORDED revision (its
status naming that revision, never an earlier one) — and the module has
passed its strategy-specific acceptance below (readiness + the old pod's
confirmed termination; the core the whole gated window), then the operator
commits the next module's change — Flux can never mutate two state-carrying
modules at once, because the branch carries exactly one uninstructed step;
the operator's ONLY non-Git mutations are the suspend gate and the
panic/maintenance scales, whose ownership is settled (the source declares
neither — the build lint refuses it — and the two parent application
Kustomizations reconcile only their named same-namespace HelmReleases; the
platform admission policy protects the operator-owned gate fields); a
scale-down waits for the
suspend ACK and the absence of an in-flight Helm action. The strategy is the module's Kubernetes kind and update strategy
(A1 — the chart declares it):

- **START-FIRST (Deployment, RollingUpdate maxSurge 1 / maxUnavailable
  0)** — every module whose writes are keyed consumers: the ingress
  gateway, the function host, the egress gateway, Motor. The new pod
  starts into ONE COHERENT startup predicate (R5-15): required bootstrap
  state complete AND ITS VALKEY CONSUMER-GROUP JOIN OBSERVED — the
  readiness probe passes only after the join, so the RollingUpdate
  controller cannot declare the new pod Ready (and terminate the old one)
  before the new pod has taken over its group; liveness is gated behind a
  STARTUP probe (or the chart's explicit activated gate) whose allowance
  covers `readinessWindowMs` — the 15 s last-commit liveness gap counts
  only AFTER activation, never against an honest slow boot; and only
  then the old pod receives termination and finishes within its
  `terminationGracePeriodSeconds` (in-flight deliveries settle; after the
  old pod's termination is CONFIRMED, its unfinished PEL entries are
  reclaimed immediately by the new pod — the confirmed termination
  authorizes the reclaim, the idle clock does not delay it, R4-02). No
  writer gap, no reader gap, no epoch for these modules.
- **STOP-FIRST (a ONE-REPLICA STATEFULSET — R5-03:
  the at-most-one identity Kubernetes enforces, no replacement pod before
  the previous pod's kubelet-observed termination; Recreate is rejected —
  it waits for old pods on upgrades only, and a ReplicaSet replaces a
  deleted pod immediately even while Terminating)** — for the SINGLETON
  STATE WRITER, today the core only. StatefulSet semantics ALONE do not
  give the operator its fence's STORE half, so the operator GATES the
  core's replacement with the suspend/resume it holds: the suspend lands FIRST (durable intent, the
  suspend ACK awaited, no in-flight Helm action — R5-01/R5-02), then the
  core's new tag is COMMITTED to the deploy branch (unapplied while
  suspended, so Flux cannot roll the core outside the window), the core
  StatefulSet is scaled to 0, the fence steps run on the CONFIRMED
  (kubelet-observed) pod termination, then the release is resumed (the
  recorded intent applied) — the StatefulSet at one replica creates the
  new core pod from the committed values, with no predecessor behind it
  that has not fully terminated (R5-03). The sequence below.

A readiness failure of any replaced module stops the rollout and rolls
back (the previous generation's COMPLETE desired state — the operator
reverts the deploy branch to the generation registry's recorded revision;
only the modules whose rendered release the revert changes move back). The health window starts after ALL changed modules of the commit
are replaced.

### The commit-pair schema check runs at every rollout (point 5)

Before the first module is replaced, the operator compares the RUNNING
commit's and the CANDIDATE commit's schema FILES — the AsyncAPI/JSON Schema
contracts, the snapshot JSON Schema, the Postgres migration set — regardless
of how many images are reused: the check is bound to the COMMIT PAIR, not to
the image, so a reused image cannot carry stale compatibility (closes R3-06
without admission records). A failing comparison refuses the rollout with
the diff as the report. The same commit-pair comparison covers the WHOLE
rendered workload state (R5-10): the chart templates and values are
rendered for BOTH commits and DIFFED, and a workload-affecting change —
probes, grace, environment, strategy, and any other generation-owned spec a
pod carries — selects the module for replacement EXACTLY as an image-tag change
does, even when every image tag is reused (image reuse buys build cost
only, never a skipped gate). The RENDERED diff, not the tag set, is what
the rollout record's per-module status names as changed. Because migrations are expanding-only, the operator
applies the candidate's NEW migrations BEFORE replacing any module — a
dbmate run under a DDL role separate from every module role, executed as a
JOB the operator creates in `lifemodel-state` (Q8's recorded mechanism) — and
the running old code tolerates the expanded schema by construction (the
invariant "the predecessor reads everything I write").

### Start-first sequence (keyed-writer modules)

```mermaid
sequenceDiagram
    participant OP as Operator
    participant F as Flux (M's HelmRelease)
    participant O as Module M, old pod
    participant N as Module M, new pod
    participant V as Valkey

    OP->>OP: commit-pair schema check (FILES) · DDL-role migration Job
    OP->>OP: write the rollout record (durable) BEFORE acting
    OP->>F: COMMIT M's new tag to the deploy branch (the step is a Git commit, R5-01)
    F->>OP: reconcile → HelmRelease APPLIED at the recorded revision (the step's ACK)
    F->>N: RollingUpdate: create the new pod (maxSurge 1 / maxUnavailable 0)
    OP->>OP: observe the readiness probe (readinessWindowMs bound)
    N->>V: join M's consumer group
    F->>O: terminate (grace = terminationGracePeriodSeconds)
    O->>O: finish in-flight deliveries; results recorded; XACK
    O-->>OP: termination CONFIRMED (pod gone — observed, never assumed, A12)
    OP->>OP: revoke O's leases (R4-07); O's PEL entries reclaimable (R4-02)
    OP->>F: next module in manifest order — never two state-carrying at once
    Note over N,V: unfinished PEL entries of the dead consumer are taken<br/>by N via XAUTOCLAIM after min-idle (above every module's declared<br/>delivery-to-result bound); done records dedup any re-run by effect key
```

### Stop-first: the core replacement, the epoch switch, the snapshot copy

The core's stop-first replacement IS the epoch switch point. There is no
`/activate` or `/drain` endpoint (O2-F rejected): the drain is the pod's
termination itself, bounded by `coreStopDeadlineMs` (5 s, values); the new
core self-activates by TAKING THE EPOCH — the Lua CAS the ADR gives the new
core at takeover ("the new pod starts and takes the epoch and the
snapshot"), a cheap operator-bug guard (A2) whose key nothing but the core
and operator roles may write.

```mermaid
sequenceDiagram
    participant OP as Operator
    participant O as Core, old pod (epoch N)
    participant V as Valkey / Postgres
    participant N as Core, new pod

    OP->>OP: commit-pair schema check · migrations (DDL-role Job, before any replace)
    OP->>OP: rollout record durable: phase `core-window`
    OP->>OP: record the SUSPEND intent durable (R5-02) · SUSPEND the core release ×<br/>wait for the suspend ACK and NO in-flight Helm action (R5-01)
    OP->>F: COMMIT the core's new tag to the deploy branch (a Git step; unapplied while suspended, R5-01)
    OP->>O: scale the core StatefulSet to 0 — SIGTERM, grace covers coreStopDeadlineMs 5 s
    O->>V: finish the CURRENT tick; final epoch-checked snapshot commit under epoch N<br/>(snapshot + outbox events + inbound offsets/dedup + pending effects, one atomic write)
    O-->>OP: termination CONFIRMED (pod gone — observed, never assumed, A12)  ★ the fence's first half ★
    OP->>OP: revoke O's per-instance leases; WAIT (bounded) until no live<br/>Postgres backend of the retired core remains (R4-14: an already-submitted<br/>statement dies undecided with the revoked session — the fence is<br/>server-side confirmed, not assumed from pod termination)
    OP->>V: take the SNAPSHOT COPY of the final snapshot (point 6):<br/>record = content hash, commit, epoch, snapshot format version, bus position;<br/>the last `snapshotCopyRetention` = 3 copies are kept beside the current snapshot
    OP->>OP: RESUME the core release (the recorded intent applied) — Flux applies the committed tag, the StatefulSet starts N<br/>(the step's release ACK arrives with N's readiness, F2)
    N->>V: read the epoch record (still N); hydrate from the CURRENT snapshot (epoch N's final commit —<br/>no handoff key, no provisional hydration, no discard dance)
    N->>N: self-check: snapshot format accepted (a NEWER version refuses loudly),<br/>config + skills loaded (PG), ONE dry tick with ALL effects suppressed
    N->>V: TAKE THE EPOCH: Lua CAS N → N+1 ★ THE FENCE ★ then set `active_holder` = N+1 at takeover
    Note over V: a stale old core that somehow survived now fails its epoch CAS<br/>and its active_holder check — refused, counted, reported (Q7, A2)
    N->>V: first real tick commits under epoch N+1 (epoch-checked Lua CAS)
    OP->>OP: verify the post-conditions — epoch moved EXACTLY once, `active_holder` agrees —<br/>proceed to the health wait; a post-condition miss is maintenance, not a guess
    OP->>OP: NO Traefik/Service move — the web surface never left the ingress Service<br/>(the core is bus-reachable, R4-06); the serving gap is the core's stop window (Q1)<br/>recorded per phase: stop deadline · lease-revoke + backend drain · copy write ·<br/>resume/reconcile · schedule+pull · start-to-first-commit (the sum is the reported pause, R5-14)
```

Contract points, in prose:

1. **The drain is bounded twice.** The core's stop deadline is 5 s
   (`coreStopDeadlineMs`, DECIDED — finish tick + commit snapshot), then a
   forced stop; the unfinished tick re-runs by key (its pending effects and
   inbound offsets are in the last committed snapshot). The old
   `switchDrainMs` 90 s pause is gone entirely: the core's external latency
   leaves the pause because the core makes no external calls.
2. **The bounded pause (Q1; its phases are named, R5-14).** The core
   replacement's serving gap is the WHOLE time from the old core's stop
   to the new core's first commit, and every phase in it is named with
   its own bound and failure outcome: (a) the stop deadline
   (≤ `coreStopDeadlineMs` 5 s — overrun = the forced stop);
   (b) the fence waits INSIDE the gated window — lease revocation and the
   bounded backend drain (R4-14; overrun names the step in the report and
   rolls back); (c) the snapshot copy write (Valkey; a failed write stops
   the window before the resume — maintenance, never a start from an
   unverified point); (d) the resume + Flux reconcile and the Git step's
   revision ACK (R5-01; a reconcile that exceeds `readinessWindowMs` is
   the never-ready case — rollback); (e) scheduling and image pull on the
   node (the pull rides the registry contract, R5-08; ImagePullBackOff
   past `readinessWindowMs` is failed readiness — rollback);
   (f) the new core's start-to-first-commit, bounded by
   `readinessWindowMs` (60 s) — the window's clock starts at the RESUME
   (the release ACK request to Flux), so the waits (a)-(e) sit OUTSIDE it
   and are reported in the rollout record's phase timings. The pause the
   walk reports is the SUM of the observed phases (the record's per-phase
   timings, Q11's synchronized sampling method) — never the application
   boot alone; the owner's short core-stop deadline (5 s) and the
   maintenance-on-expiry trade stand unchanged (infrastructure time is
   named, not hidden inside the deadline). Owner input is NEVER dropped in
   that window: the ingress gateway (old or new, per its own start-first
   replacement) keeps accepting and XADDing to `inbound` — a switch moves
   who READS `inbound`, never who accepts it; the browser retries with the
   same idempotency key and the dedup ring absorbs a lost response.
3. **What the new core's readiness checks (F2, per module; the ONE
   coherent predicate, R5-15).** Stores
   reachable, the snapshot of epoch N hydrated and its format accepted (a
   NEWER version refuses here, before serving anything), config + skills
   loaded from Postgres, functions registered with the adapter (for the
   function host: the read set complete — the adapter contract below), ONE
   dry self-check tick with ALL effects suppressed — no bus command, no
   `pg.apply`, no schedule advance, no egress call; for a keyed consumer
   the CONSUMER-GROUP JOIN OBSERVED is part of the same predicate, and
   the probe flips Ready only when the WHOLE predicate holds. Readiness
   proves
   initialization, never live-service health (B0R-R02).
4. **What liveness checks:** a committed tick — and it is GATED behind
   initialization (R5-15): the chart sets a STARTUP probe (or an explicit
   activated gate) whose allowance is `readinessWindowMs`, so liveness
   begins counting only after activation. The holder's every completed
   tick ends in the epoch-checked snapshot commit (charter-fixed per-tick
   rule), so "last commit age" is the liveness signal. Each module exposes
   a PROBE endpoint to the kubelet — readiness and liveness, HTTP GET,
   observation only, NO control verbs (O2-F's rejection stands: a probe
   observes; it does not command); the core's liveness probe is the commit
   age. A liveness gap of 15 s (15 missed 1-s ticks) after activation
   opens the Q4 crash
   path; two consecutive gaps after activation open rollback. An honest
   boot longer than 15 s is never liveness-killed before its first
   permitted real commit — the startup allowance covers it.
5. **Snapshot copies (point 6).** Taken ONLY when the core is replaced —
   by the operator, right after the old core committed its last tick and
   its termination is CONFIRMED, the point the new core starts from.
   Replacements of other modules touch no snapshot COPY and replace no core
   instance (R4-16) — the live snapshot itself keeps ADVANCING: an
   unchanged core keeps committing a fresh snapshot every tick through any
   gateway-only rollout, so the gateway-only assertion is "no COPY taken,
   no core instance/epoch replaced, tick commits CONTINUE", never byte
   equality of the live snapshot. Copies are identified
   (`copy-<commit>-<epoch>`) and immutable; the last 3
   (`LIFEMODEL_SNAPSHOT_COPY_RETENTION`, DECIDED) are kept in Valkey beside
   the current snapshot. A restore is MANUAL, MAINTENANCE MODE ONLY: the
   operator first checks the copy's snapshot schema is readable by the
   CURRENT core (the point-5 schema rule) and that the copy's recorded bus
   position is not trimmed; otherwise it REFUSES with the reason. What a
   copy can and cannot recover: it restores the instance to the copy
   instant. The restore does NOT touch the bus (R4-12): no entry is
   deleted, no journal is rewound — the SNAPSHOT alone is replaced, and the
   current bus is kept, so retained entries after the copy instant REPLAY
   from the copy's recorded position under their existing keys: accepted
   but not yet processed inbound messages and commands with no done record
   re-deliver like any other delivery (the natural post-offset minus dedup
   replay), and done records settle the duplicates. Only an entry the
   retention has ALREADY trimmed cannot replay — those are listed in the
   restore report as unreconciled, named from the later done records where
   one exists (the restore's own check refuses a copy whose recorded bus
   position is already trimmed). Postgres is NOT rolled back — the replayed
   tick state settles against current rows by natural key; replayed inbound
   entries and pending effects settle from the current done records /
   message rows. NO snapshot+PG stamp pair exists (O3-D rejected): a FULL
   backup (Postgres dump + Valkey copy) is an owner-commanded maintenance
   action only, never part of a switch or rollback; automatic regular
   Postgres backups are CNPG's declarative backup support, configured
   by the owner outside this milestone's switch/rollback machinery.
6. **The mixed old/new window relies on decision 8.** Modules replaced
   before and after the core run old and new code side by side; the FULL
   both-ways bus compatibility and expanding-only Postgres are what make
   the window safe (the previous module's readers tolerate the new module's
   writes by construction).
7. **Leases at a replacement.** Revocation is PER RETIRED INSTANCE and
   happens when the OLD INSTANCE's termination is CONFIRMED — never before
   the replacement started (R4-07; the start-first sequence above shows
   exactly this order). A start-first module's old pod finishes its
   in-flight deliveries on its UNREVOKED leases; unchanged modules' leases
   are untouched by the switch. For the core (stop-first) the confirmed
   termination precedes the new core's start, so the revocation lands
   inside the operator's gated window — the enforcement half of stop-first.
   A revoked lease's connections die with it — and that is what CONFIRMS
   the fence's server-side half (R4-14): the client-death fact is that an
   already-submitted SQL statement can still execute in a Postgres backend
   after the pod that sent it is gone, so the stop-first sequence WAITS —
   bounded — after the confirmed termination and the revocation until no
   live backend of the retired core remains, BEFORE the snapshot copy is
   taken and the fence relied on; an old apply that already checked
   `active_holder` cannot outlive that point. A restarted module
   re-authenticates through its service account (R3-16, re-mechanized).
8. **The new core never becoming ready is a named case, never a guess.**
   If the new core fails to start (image pull) or fails its self-check, no
   pre-activation core exists to keep zero bumps (Q2b): the epoch stays
   exactly where the new core left it (N if it never took the CAS, N+1 if
   it did), the instance is DOWN, and the rollback machinery's stop-first
   leg runs — the failed core pod is discarded under confirmed
   termination, the previous commit's desired state is restored in the
   deploy branch (the recorded revision, R5-10), and the restored core
   goes through the SAME gated window: it takes the NEXT epoch value
   idempotently by CAS (N+1 after an untaken N; N+2 after the failed
   core's N+1 — a value never reused), and hydrates from the LATEST
   CURRENT snapshot on CURRENT Postgres data — the running snapshot's
   last commit (epoch N's, or the failed core's N+1 where its CAS
   landed). NEVER a retained COPY: an automatic sequence has NO
   snapshot-restore step — the copy the gated window took is a named,
   immutable observation point, not a restore source, and rewinding to it
   would DISCARD the failed candidate's possibly committed work (the work
   its epoch N+1 committed between the copy instant and the readiness
   failure — inbound offsets, done records, committed tick state).
   Copies restore only through the owner's manual maintenance path
   (point 6, N-20). Never a frozen instance, never a reused epoch, never
   an automatic copy restore — and no committed outcome is replayed: a
   re-run re-executes only the abandoned tick's still-PENDING effects
   under their persisted ids, and the done records and message rows
   settle everything else (the keyed rules).

### Per-module health window (F4; R3-12 carried)

The window starts after ALL changed modules of the commit are replaced and
lasts `healthWindowMs` (120 000 ms) — EXTENDED, per changed module whose
declared delivery-to-result bound exceeds it, to that module's bound
(R4-03): demand arriving at the window's start must be able to age past
the bound INSIDE the window, or a bound longer than the window (the egress
gateway's measured call can be ~300 s) would accept both silent-wedge
cases before the demand ever became aged. Health is COMPLETED WORK counted from
durable records, per module — never a live process alone; a module whose
work wedges behind a green probe is caught by the failure counts, and the
design answers this per module (A8's work-counting rule):

- **core:** commits its first tick snapshot within `firstCommitDeadlineMs`
  (30 s) and keeps committing within the liveness gap (15 s). "Last commit
  age" is read from the snapshot header.
- **every keyed consumer** (ingress gateway, function host, egress gateway,
  Motor): its settled-work and FAILURE counts come from the done records it
  already writes in its own schema — the operator reads them with its health
  role (the cross-schema reconciliation grant). A failure on a LOCAL cause (the module itself, its own crash before
  any result) counts against the module; a failure classified UPSTREAM
  (the remote endpoint refused, unreachable, rate-limited) is recorded on
  the done record and counted SEPARATELY, never against the generation.
  The wedge predicates are ROLLING, never lifetime: N consecutive local
  failures with zero settled jobs WITHIN the rolling failure window
  (`healthFailureWindowMs` = 60 000) fail the module — one success then a
  wedge is caught. A long-running job counts NOTHING against health: the
  exclusion proof is DURABLE EVIDENCE — the job's live PEL entry (a claimed
  job within min-idle) or its parked, un-XACKed delivery (a correlated
  round trip); past their bounds without a result, the XAUTOCLAIM/retry
  machinery re-runs them and the outcome counts like any other.
- **ingress gateway additionally:** accepted submissions are visible as
  `inbound` stream entries (the stream length grows); a gateway that stops
  accepting while its readiness probe stays green fails
  the window (the readiness probe EXERCISES the accept path).
- **Aged outstanding demand fails the window (R4-03).** The failure counts
  catch a wedge that ERRORS; a consumer wedged SILENTLY — wedged before
  reading its commands, or holding a claimed delivery that produces
  neither a result nor a failure — writes no failure record and would pass
  the counts behind a green probe. The window therefore also fails a
  module on AGED OUTSTANDING DEMAND with no progress: demand older than
  the module's declared delivery-to-result bound (R4-02's manifest field —
  unread `cmd.<module>` stream entries, age from the bus entry; claimed
  PEL entries; parked un-XACKed deliveries) with NO settled job, NO local
  failure record, and no claim/ack movement attributable to it. The
  exclusion proofs (a live PEL entry, a parked delivery) hold only WITHIN
  the declared bounds; past them the demand is outstanding and the
  XAUTOCLAIM/retry machinery's outcome counts like any other. The window's
  length covers at least one such bound for every changed module (the
  extension at the section head) — a bound the window could not cover
  would leave its demand un-ageable and the wedge accepted. The
  exemptions stand: NO demand at all is HEALTHY (idle); upstream
  failures are counted separately, never against the module; a
  static-infrastructure outage holds the clock (below).
- **No idle demand:** a module with no work to do in the window completes
  nothing and is HEALTHY — the wedge proofs are about repeated LOCAL
  failures and zero successes, not about throughput.
- **Static infrastructure outage (hold, not rollback):** when a STATIC
  chart component (Valkey, Postgres, OpenBao, Traefik, Agent Vault, the
  registry, Flux) is itself unavailable — observed on the OPERATOR's own
  connections — the health window's clock HOLDS and the observed failures
  are marked infra-attributed, not candidate failure; the window resumes on
  recovery, and if the outage outlasts the window the attempt is
  BROKEN-INTO-MAINTENANCE (reported, named outage — not a rollback of
  healthy code onto a broken store).
- A permanently failing function's failure output is counted by the adapter
  (a completed-work/failure datum) and appears in the rollout report.


## Rollback and maintenance (F4-F6, Q3 as reshaped by points 1 and 6)

Rollback restores the previous generation-owned desired state (R5-10)
— a GIT REVERT of the deploy branch in Gitea to the revision the generation
registry recorded for it (generation chart templates and values: launch
state — probes, grace, environment and strategy — revert WITH the image tags,
never behind them). Platform-owned NetworkPolicies and RBAC are immutable
to generations and are never restored or changed by rollback, applied module-by-module
under the SAME per-module strategies; a module whose rendered release the
revert does not change keeps its current release revision and is not
re-replaced. Postgres is NOT rolled back: the instance continues on CURRENT
data; re-applied commands are keyed (the done-record check makes
re-delivery a no-op). There is no downgrade step anywhere. The deploy
branch in Gitea is the single source of truth — there is no imperative path
to roll back along, and cluster drift outside the branch is forbidden
(O3-E: Flux's next sync re-applies the branch; a change made by hand is
FORKED state and is reverted, not adopted). Gitea is owner-managed source
infrastructure outside generation reconciliation, like CNPG and OpenBao, so
candidates and rollbacks cannot replace or break their own source of truth. If
Gitea is down, running generations continue and no new generation can be built
or selected. Every Gitea wait and retry in rollback consumes
`rollbackDeadlineMs`. Recovery before expiry resumes the durable recorded
attempt; expiry enters maintenance, reports the blocked Git step, and requires
explicit owner authorization before any start after Gitea returns. Nothing
starts automatically after recovery. The cached-last-good exception is not
adopted; it would need the owner's explicit acceptance. Established Gitea
source identity/revision loss, a missing revision, or a revision older than the
recorded deploy head holds reconciliation for owner recovery and never
auto-reseeds. A future one-volume backup pairs repository data with the SQLite
database/config and verifies required recorded commits, auth and rules before
restore.

Trigger: the activated set fails its health window, or the core's liveness
fails twice consecutively after activation, or a replacement's readiness
failed mid-rollout.

```mermaid
sequenceDiagram
    participant OP as Operator
    participant B as Failed commit's module (unhealthy)
    participant A as Previous commit's image for that module
    participant V as Valkey / Postgres

    OP->>OP: health-window or liveness failure → rollback, report opened
    OP->>OP: the rollback target is the PREVIOUS GENERATION'S RECORDED revision —<br/>its full chart+values desired state; a module whose rendered release the<br/>revert does not change is untouched
    OP->>OP: revert the deploy branch to that recorded revision (an ordinary git commit<br/>with the same review trail — launch state reverts WITH the tags, R5-10) ·<br/>hold every reverted module's HelmRelease SUSPENDED
    OP->>A: resume module by module in manifest order, under its strategy:<br/>start-first: A's pod starts, passes readiness, joins the group<br/>(an ingress gateway is Service-admitted BEFORE B stops accepting — no lost submission)
    OP->>B: terminate (bounded by the module's terminationGracePeriodSeconds)
    B-->>OP: termination confirmed; leases revoked
    Note over B,V: unfinished PEL entries → XAUTOCLAIM by A; done records dedup re-runs
    OP->>B: if the CORE is being rolled back: stop-first — the gated window:<br/>drain ≤ 5 s, final snapshot commit under epoch N+1, termination CONFIRMED
    OP->>V: snapshot COPY taken (a rollback's core replacement is a core replacement, point 6)
    OP->>A: resume the core HelmRelease — Flux starts A's core from the final snapshot on CURRENT data<br/>(same self-activation: A takes the epoch — CAS N+1 → N+2, a value NEVER reused —<br/>and sets `active_holder`)
    Note over A,V: if A's commit cannot read the current data (a newer snapshot format<br/>than A reads — possible when B served in that window), A REFUSES with the<br/>reason; the operator holds MAINTENANCE and names the refusal in the report
    OP->>OP: no Service step (the restored core is bus-reachable — R4-06; when the<br/>rolled-back module IS a gateway, A's readiness admits it back into the Service)
    OP->>OP: health window again (ONE fallback only)
    OP->>OP: report-<epoch>.json: what, why, from→to, entries replayed
```

- **Rollback completion deadline (B06, carried; outcomes DISTINCT, R4-13):**
  `rollbackDeadlineMs` 300 s from the health-window failure to service
  restored on the web surface (which never leaves the ingress Service in a
  core rollback — R4-06; a rolled-back gateway re-enters its Service
 Endpoint set at its readiness) — ONE clock covering revert, reconcile,
  pod replacement, confirmed termination, readiness, activation, and the
  gateway's Service re-admission where the module is a gateway; detection
  (the 120 s window) is a different clock. TWO measured outcomes exist and
  are never conflated: RESTORED within the clock, or MAINTENANCE-ON-EXPIRY
  — maintenance is a NAMED outcome in the report (the step that ran over
  and how much it consumed), not restored service. The budget allocation
  is stated, not assumed: the clock's largest single claimant is a module
  termination grace at its declared maximum (an egress gateway stop bound
  to its longest declared timeout) plus the replacement's readiness
  (`readinessWindowMs` 60 s); a maximum-duration in-flight call during a
  MULTI-module rollback can therefore consume most of the 300 s, and the
  walk measures that worst case rather than assuming the removed
  downgrade step provides slack. SAFE EARLY-STOP policy: a per-module
  termination grace longer than the clock MINUS the readiness bound makes
  the rollback of that module declare maintenance on entry (the operator
  refuses a rollback it cannot finish instead of timing out mid-drain),
  and in-flight calls past the termination grace are cut by it — never
  waited on unbounded. On expiry the operator stops the attempt
  (best-effort stops, leases revoked), opens MAINTENANCE mode and writes
  the report naming the step that ran over — it never leaves a
  half-rollback serving and never starts a second automatic try.
- **One automatic fallback (B0R-R06, carried):** after it, either the
  restored set is healthy, or maintenance opens. Two consecutive failed
  commits (`maxFailedGenerations` = 2) open maintenance without a second
  try; panic overrides everything, first.
- **Maintenance mode (F5 as amended):** the operator's gate in which
  NOTHING starts automatically — held as the same durable CLUSTER state as
  panic: the lifemodel Flux releases SUSPENDED and the module workloads
  SCALED TO ZERO (a node or operator restart revives nothing — there is
  nothing to revive). The operator's web UI lists the generation registry
  (commits, module images with their build-input hashes, epoch/version
  stamps, attempts, verdicts, reports); the owner boots an OLDER GENERATION
  WITHIN THE COMPATIBILITY WINDOW — the window is decided by the point-5
  comparison plus the snapshot format version rule, checked from FILES and
  the stores' stamped versions at the boot's own rollout (an older
  generation is inside the window iff its schema and snapshot-version
  rules accept the current dataset); the boot is an OWNER-COMMANDED start:
  the operator reverts the deploy branch to that generation's RECORDED
  revision — its COMPLETE desired state, chart templates and values, not
  merely its module tags (an older image under NEWER launch semantics is
  not a boot of the older generation — R5-10) — and lets
  Flux apply through the same gated per-module machinery. Outside the
  window, the boot REFUSES with the reason naming the failing comparison,
  and the instance stays down in maintenance. Snapshot COPIES are the
  manual recovery past the window: restored by the owner in maintenance
  only, never while any module serves, never automatically. Same login,
  same front door — no second control interface (B0R-R09); reports
  readable in the UI without shell access (Q10).
- **Panic is DURABLE CLUSTER STATE (the platform decision; replaces
  panic.json).** The owner's panic (web UI or command) is applied by the
  operator as: (a) a Flux suspend on the lifemodel releases, and (b) the
  module workloads SCALED TO ZERO — both hold across operator restarts,
  Flux restarts and node reboots, with NO time limit, because they are
  cluster state nothing else reconciles away. Panic blocks every start —
  generation, maintenance boot, rollback target — first in precedence,
  overriding everything including a rollback in flight.
  The PANIC TRANSITION is the per-release reconciliation the record
  drives (R5-02), each mutation ACK'd and each cut walked: for every
  lifemodel release, in manifest order — the SUSPEND lands first (durable
  suspend intent written and read back complete BEFORE the mutation; the
  suspend ACK awaited; any in-flight Helm action is AWAITED to its
  outcome — a suspend does not cancel one); for the `lifemodel-motor`
  release the next mutation is MOTOR'S OWN CLEANUP — the release's
  RUNNING sandbox Jobs are deleted by Motor's registered identity under
  its own RBAC row (the ONLY principal that may delete them — the
  operator stays control-only), observed gone, BEFORE the release's
  workload SCALE TO ZERO (ACK), then the stopped state OBSERVED — and
  only then the next release. PANIC IS COMPLETE only when every lifemodel release
  is suspended and every module workload is OBSERVED at zero — the walk
  proves convergence WITHOUT any start; while the epoch-bump ordering
  below stands, a mid-transition crash re-drives the remainder toward
  stopped deterministically, and a mid-transition node reboot revives
  nothing (the scaled releases have nothing to start; the unscaled ones
  are read from the record and stopped next). While a
  generation runs, the operator bumps the epoch FIRST (the Lua CAS — an
  operator-role write), then scales the core to zero: a panicking
  instance's writes refuse before the process dies. A RESUME records the
  owner's authorization as a durable record FIRST (a rollout-record entry
  written and READ BACK COMPLETE — the cluster datastore's replicated-log
  write-through is the fsync the old file rule carried, R4-09; the
  installer selects embedded etcd explicitly so this contract is a named,
  tested property of the chosen datastore, never a default the installer
  did not select — R5-18), then removes the panic state (the
  suspend lifted, the desired state restored from the branch). The
  ACHIEVABLE cuts are asserted (R4-09):
  a crash before the durable resume record leaves the panic state
  standing — the block STANDS (the state IS the block; an authorization
  that never reached the record cannot lift it); a crash after the
  durable resume record but before the state removal leaves the block in
  place and the record naming the intent — the reconciliation carries the
  recorded intent out (removes the state) rather than guessing; the
  UNACHIEVABLE assertion (the block standing after the state was durably
  removed) is never made — the recorded intent plus the deterministic
  reconciliation means a boot without the completed removal neither
  re-blocks nor starts anything but the recorded intent. The operator's
  own recorded panic observations are written durable before anything
  acts on them.

## Operator crash reconciliation (Q5, C01 — simplified, on the platform)

The GENERATION OPERATOR runs as a single replica behind a leader-election
Lease: two operators cannot race (the second waits for the Lease). It
writes its intent BEFORE it acts and reconciles from records, not from
cluster observation alone. The durable records (state ownership rows 19)
are CLUSTER RESOURCES in the operator's namespace, written under its RBAC
surface: the ROLLOUT RECORD (one per attempted commit: desired state = the
commit's module tags and order, phase
`building | migrating | replacing-<module> | core-window | health-wait |
done | refused`, per-module status, attempt count, report id), the
GENERATION REGISTRY (per commit: epoch, snapshot format version, PG schema
version, module tags, and the deploy-branch REVISION the generation's
complete desired state was recorded at — rollback and the maintenance boot
reconstruct THAT, not a tag set: R5-10), and the PANIC/MAINTENANCE state itself — which is
now ALSO cluster state (suspend + scale 0) the reconciler reads like any
other fact. The cluster DATASTORE's replicated-log write-through is the
durability the old file rule
carried (R4-09): the installer selects embedded etcd EXPLICITLY for the
single-server k3s (the default SQLite-backed single-server install would
carry a DIFFERENT, undocumented-by-this-design durability contract —
R5-18), and on that named datastore a record is WRITTEN AND READ BACK
COMPLETE before the
operator issues the action it authorizes (a values commit, a scale, a
revoke, a panic-state change); a record not read back complete is
rewritten before anything acts on it. The authoritative fencing material
remains OUTSIDE the records: the Valkey epoch record.

A fresh operator walks, in order:

1. **Load state.** Read the panic/maintenance cluster state FIRST (panic
   precedence: hold every automatic start, keep the state standing,
   report); else the newest rollout record; read the HelmRelease values
   (the branch's applied desired state) and Flux's readiness conditions;
   read the Valkey epoch; list pods for identity, not for decisions. A
   panic/maintenance state that is NOT YET COMPLETE (some lifemodel
   release unsuspended, some module workload above zero) is RE-DRIVEN
   from the recorded intent (R5-02): the remaining releases are taken to
   suspended-and-scaled-to-zero, release by release, each mutation
   followed by the same cut discipline — never reversing toward a start;
   completion remains the observed all-stopped state, reported only then.
2. **Reconcile the epoch vs the record (the only ambiguity that matters).**
   - Record phase BEFORE the core's gated window and epoch == old: resume
     at the recorded phase — Flux has already rolled the start-first
     modules whose replacements the record lists (verify each pod set
     against the record, lease-revoke any confirmed-terminated old pod not
     yet revoked), then continue. An old core that was never gated out KEPT
     SERVING (pod restarts are in place, Q5) — no gap, no duplicate report
     (one report id per attempt, rewritten at `done`/`refused`).
   - Record phase INSIDE the core's gated window (after the old core's
     confirmed termination, before its post-conditions) and epoch == old:
     the fence steps not yet relied on — re-run them IDEMPOTENTLY
     (revocation idempotent; the snapshot copy verified or taken), resume
     the core HelmRelease, continue at `health-wait`. The bump itself is
     the new core's Lua CAS, so nothing here can half-bump.
   - Epoch == aimed (N+1 — the new core's CAS landed, then anything died):
     continue (the new core's pod restarts in place and re-takes the epoch
     CAS idempotently — set to N+1 if still N; `active_holder` set at
     takeover idempotently; re-hydration ALWAYS reads the LATEST snapshot
     under the current epoch). A record whose phase still says
     `core-window` while the epoch is aimed is reconciled FORWARD, never
     re-fenced: the epoch record outranks the recorded phase.
   - Epoch NEITHER old NOR aimed (a still-older crash lineage): REFUSE —
     write the report naming the mismatch, hold maintenance. Never guess.
3. **Settle drift.** A pod whose image matches neither the branch's desired
   state nor any rollout record is DRIFT (a hand-applied change): the
   operator re-applies the branch state (Flux's reconcile does this
   naturally), records the observation, and reports — it never adopts
   off-branch state, and the epoch still arbitrates every writer. A form
   the branch does NOT carry never comes from Flux: the operator pushes a
   values commit only AFTER its rollout record is durable (the
   record-before-act rule), so an unrecorded module pod can only be
   drift, never the operator's own half-applied intent. The dead
   operator's unrevoked leases are reconciled: revocation for confirmed-
   terminated pods its records name, then fresh bootstraps on restart
   (vault-env's Kubernetes-auth login at each container start).
4. **A node/kubelet restart is NOT a special case (Q5's adapted rule).**
   Module pods restart IN PLACE under the pod's restartPolicy — a
   restarted process is a FRESH bootstrap (it re-authenticates through its
   service account, holds no persisted material, rejoins its consumer
   group under the keyed rules), and the OLD core never revives beside the
   new one: inside the gated window the core StatefulSet is scaled to 0, so
   there is nothing to start (and a StatefulSet replaces no pod before its
   predecessor's fully observed termination — R5-03). New CODE arrives by no path other than a
   rollout the operator drives through the deploy branch. During panic or
   maintenance the workloads are scaled to zero — a node restart revives
   NOTHING.
5. **A Valkey restart DURING reconciliation:** the epoch record is read
   from AOF — if the store came back EMPTY (volume lost), the operator
   refuses into maintenance rather than minting epoch 1 beside live
   generations.

Every cut is deterministic: a restarted operator (or a replayed one)
reading the same records and the same epoch takes the same branch. Labels
and pod images are identity, never decision.

## Keyed job rules (simplification point 2)

A JOB is a keyed command event in a Valkey stream, consumed through a
consumer group. This is the ENTIRE in-flight/async machinery — there is no
executor module, no durable per-job state machine, no heartbeats, no grace
allowlist. Every non-core module applies the same rules to its own
command stream:

- **Stable effect ids.** An effect's logical id is minted ONCE, when the
  effect is first decided — inside the deciding tick — and is persisted in
  that tick's snapshot commit (the outbox entry) and in the turn's
  pending-effect list. A replayed turn reads its pending effects from that
  persisted state and re-issues with the SAME ids; ids are never re-derived
  from a new turn id, commit, epoch, tool sequence or model answer.
  Scheduler fires already have such an id (`fireId =
  scheduleId:nextFireAt-ms`); motor runs keep `runId:step`; sends get a
  minted send effect id. The id survives the rollout, the epoch bump and a
  crash: the command on the bus, the done record and the report all name it.
- **XACK only after the result is recorded.** A dead consumer's pending job
  is claimed by another instance of the same module via XAUTOCLAIM
  (built-in). Min-idle is NOT a live-consumer fence (R4-02): it is the
  CRASH-takeover trigger, set ABOVE every module's declared
  delivery-to-result bound (the manifest field below) — a healthy
  consumer, including a PAUSED one or one PARKED in a correlated round
  trip, is not stolen within its declared bounds. A live consumer's entry
  may be claimed only PAST that bound, and the same-key `in-flight`
  admission (R4-01) then makes the outcome deterministic: keyed → the
  destination dedups; unkeyed → `uncertain`, reported, never re-dispatched.
  Reclaim from a RETIRING instance is authorized by CONFIRMED POD TERMINATION,
  not by idle: once the operator confirms the replaced pod's termination,
  its PEL entries are reclaimed immediately — the idle clock never delays a
  confirmed-dead consumer's entries, and min-idle above the grace bounds
  never steals a live-but-slow old instance mid-rollout.
- **Done record by key, ADMITTED BEFORE the effect and updated AFTER.**
  The consumer's FIRST write for a delivery is the done record itself,
  inserted in state `in-flight` BEFORE the effect is dispatched. The
  insert is same-key ATOMIC — the effect key is the record's identity, a
  re-delivery conflicts with the existing record and can neither overwrite
  it nor mint a second one — so the `in-flight` marker is durable before
  any external call starts (R4-01). After the effect applies, the record
  is UPDATED to its final state (`delivered`/`uncertain`; `settled` when
  the core applies the settlement). Done records live in the CONSUMER
  module's OWN schema (the point-0 barrier: a bug is contained to one
  schema). The record is checked BEFORE the effect re-runs, so every
  recovered attempt follows recorded state instead of guessing. Death
  after dispatch but before the completion write leaves the record
  `in-flight`: a keyed destination retries safely under the same id (the
  destination dedups); an unkeyed destination is recorded `uncertain`,
  reported, and NEVER automatically dispatched again — the report is the
  owner's re-issue surface.
- **Destination idempotency classes.** The effect manifest (build-stage)
  declares, per side-effecting command type, how once-only is achieved at
  the destination: `keyed` (the destination honors the effect key — the web
  reply's insert-by-key message row is the model) or `unkeyed` (an
  explicit, reviewable no-mechanism entry; UNDECLARED = build failure).
  Done-record states: `in-flight | delivered | uncertain | settled`. An
  ambiguous `keyed` attempt recovers through its contract; an ambiguous
  `unkeyed` attempt is recorded `uncertain` and reported, and NOTHING
  re-delivers it automatically — the report is the owner's re-issue
  surface. No disposition claims "no duplicate application" for an
  ambiguous `unkeyed` effect; it claims "reported as uncertain".
- **Timeouts (Release It!):** EVERY sync call declares a timeout per
  destination in the module's call manifest, with its keyed/unkeyed class;
  a call without a declared timeout FAILS THE BUILD. The consumer module
  cuts the connection at the timeout; after a cut: keyed → retry (done
  record dedups), unkeyed → `uncertain`. Build check: the module's
  `terminationGracePeriodSeconds` >= its longest declared timeout (this invariant, not
  the number, justifies the egress gateway's proposed 300 s target — the
  MEASUREMENT of the longest realistic call sets the value, open question
  1; the manifest declares ms, the pod field is seconds, so the check
  converts once and asserts in ONE unit against the RENDERED field —
  R5-11). The egress gateway also enforces a per-request timeout on its side.
  The call manifest ALSO declares, once per module, a DELIVERY-TO-RESULT
  BOUND (R4-02): the maximum time from a command's delivery to its result,
  covering the queue wait, the held sync call AND a parked correlated
  round trip (a parked `tool.request` not answered within it is released,
  counted and reported — N-14). A missing bound FAILS THE BUILD. The
  XAUTOCLAIM min-idle sits above this bound — it is the crash-takeover
  trigger, not a live-consumer fence; reclaim from a retiring instance is
  authorized by its confirmed pod termination.
  NO unbounded sync calls.
- **A call whose answer arrives on the bus later** (webhook, human reply,
  timer fire): send, record the correlation as ordinary state, XACK, be
  done — the answer arrives as a future event. NO suspension mechanism, no
  special registry.
- **A call answered on the same connection** (a Motor step the Motor module
  holds; the egress gateway's HTTP round trip) is held by the consumer
  module for the duration (Half-Sync/Half-Async — the external protocol's
  fact), within its declared timeout.
- **Jobs issued by an older version are run by the new module** (bus FULL
  compatibility both ways). NO retained-image one-shot runners.
- **The core is fully async** (decision 4's kept half): a command event
  goes out, a result event comes in, the tick never blocks on a round trip.
- **Pruning follows settlement AND the end of every re-issue path, never a
  clock.** A done record and its matching pending effect are pruned ONLY
  after their settlement is committed in a snapshot (`send.settled`
  applied, the inbound outcome final) AND no path can still RE-ISSUE the
  key (R4-10): a live PEL entry (the consumer published its result and
  died before XACK), an undelivered command entry in its stream, a parked
  un-XACKed delivery, or a retained snapshot copy whose pending-effect
  list still names the key. Settlement alone is NOT permission to prune:
  the result-before-XACK death leaves a live delivery reference, and the
  done record — the only proof the effect already applied — is KEPT as
  the tombstone the redelivery dedups against (key, final state, result
  reference; retained regardless of age until every re-issue path ends).
  Time or retention NEVER prunes an unsettled record, and maintenance
  (no ticks committing) holds pruning entirely. Retention decides what
  the bus may REDELIVER; the settlement rule decides what the record
  KEEPS.
- **Crash cuts** (the same five as before, now without an executor; the
  record's states are `in-flight` → `delivered`/`uncertain` → `settled`):
  (1) outbox committed, the consumer died BEFORE the `in-flight` admission:
  no done record exists, the effect never started — the re-issue (its own
  re-delivery or the new instance's XAUTOCLAIM) delivers once. (2) the
  consumer died AFTER the admission, before the completion write — this
  includes death after the external call went out but before any result
  was recorded: record `in-flight` → keyed: the re-issue completes under
  the same id; unkeyed: `uncertain`, reported, never automatically
  dispatched again (R4-01). (3) the completion write landed, death before
  the result was committed: record `delivered` → the re-issue recovers the
  result from the record/row. (4) the core's stop deadline abandons the
  tick: pending effects replay with their persisted ids — the same cuts.
  (5) Valkey restart inside any cut: ids and commands live in the outbox
  (AOF) and records in Postgres, not in process memory.
- **The function host's adapter ack rule (R3-10, carried).** The adapter
  XACKs a delivery only when the function answered (a signal or a response)
  or when a deliberately bounded number of attempts (an operator setting,
  named at outcome-6 design time) ended unavailable — a deliberately
  DROPPED poison delivery, counted and reported, never a silent loss. A
  crashed HTTP invocation re-delivers, and the re-run's output carries the
  input event's idempotency key, so the consumer-side dedup absorbs it.


## Postgres rules (decision 5; point 5; B04 carried)

Every Postgres writer is accounted for; none writes a live row mid-tick or
on its own authority. The writers are: the core's keyed-command applier
(conversation rows, memory graph, soul versions, recipient registry, plugin
enable/disable, schedules, config, skills-as-data rows, done-record-free
body state), each keyed consumer's done records in ITS OWN schema, the
Motor module's run registry rows in its own schema, and the ingress
gateway's scoped INSERT-by-key on `conversation_message` (the one
cross-schema grant in the design). The rules:

- **One schema per module** (`CREATE SCHEMA`); the module's OpenBao role
  has rights ONLY on its schema — plus the two named narrow grants above.
  The enforcement chain is named (R5-16): CNPG declaratively manages each
  module's fixed NOLOGIN group role; the migration set owns the
  GRANT/ALTER DEFAULT PRIVILEGES SQL scoping it (a table a migration
  creates is granted by that same migration); OpenBao issues a leased
  LOGIN user that inherits the group role. Declared attributes alone are
  not the containment — the grants are.
- **Keyed commands, idempotent by NATURAL key.** A tick that wants a
  Postgres change emits a keyed command in its snapshot commit (the outbox);
  the owning module's applier applies it in a short transaction. The
  command key is the effect's NATURAL key — message row id, soul version,
  fireId, `runId:step`, config version — and the apply is idempotent on
  that key WITHOUT a generic ledger.
- **The generic `applied(key, epoch)` table is the EXCEPTION, not the
  norm.** It exists only where no natural key can be minted, written in the
  SAME transaction as the change it admits. No review may add one where a
  natural key exists.
- **Epoch guards stay cheap.** The core's snapshot commit is the
  epoch-checked Lua CAS. The core's `pg.apply` transactions check
  `active_holder` (updated at the new core's takeover, alongside its epoch
  take; the operator only VERIFIES it) and abort on a mismatch and abort on a mismatch — a cheap guard against operator bugs (A2),
  not a barrier: on one node there is no already-open old transaction to
  race (the old core's termination is confirmed, and its sessions revoked
  and drained, before the new core takes the epoch — R4-14). Other modules'
  own-schema applies are NOT epoch-checked; their commands are keyed and
  idempotent by natural key.
- **Migrations are expanding-only**, linted by squawk (bans drop/rename of
  column or table, type change, NOT NULL without default), applied by the
  OPERATOR before the rollout under a DDL role separate from every module
  role — a dbmate run executed as a JOB the operator creates in
  `lifemodel-state`, recorded in the rollout record (Q8). The tool is dbmate + squawk (DECIDED, point 5): language-neutral
  plain SQL behind a narrow interface, replaceable. Contract steps (the
  removal half of expand/contract) come in later commits; deprecated items
  are marked now. The column rule: a column's meaning never changes; a new
  meaning = a new column (semantic drift is caught by review and the
  health window — A11's named residue).
- **Schedules' fire/advance is crash-safe.** The emit IS the outbox: the
  `schedule.fired` command (fireId) and the schedule-row advance are
  reconciled by the applied record — the applier applies the advance in the
  same transaction where fireId is first recorded; a redelivered command
  hits the fireId record and only the signal side re-runs; if the advance
  was committed but the fire event was lost, the schedule reload
  (`nextFireAt <= now` fires as seen) re-produces it. Delayed events ride
  the SAME pair as delayed-event rows (R3-14). Either store may win a
  crash; the pair converges to fire-exactly-once.
- **Readiness suppresses everything.** A module's dry self-check emits NO
  command, writes NO done record, advances NO schedule: effect suppression
  at readiness is total. The function host serves no delivery until its
  declared read set is complete (the bootstrap barrier, R3-10).
- **No live-row writes on lease authority.** OpenBao leases gate
  CONNECTION; the epoch CAS and the `active_holder` check are what reject a
  stale writer. Revocation is defence in depth, not the fence.


## Valkey persistence, retention and pressure (R3-21, carried)

AOF `appendfsync-always` is the ACK boundary in BOTH directions: the
ingress gateway answers HTTP 202 only after its fsync'd XADD, and a write
whose fsync cannot complete — a STALLING disk or an AOF rewrite colliding
with the append buffer — is a VISIBLE failure: the caller's command is
refused, the core PAUSES its commit (unavailability reported), never an
accepted write later unaccounted. DISK EXHAUSTION is the same cut: Valkey's
write error surfaces as refused commits and a reported outage, and the
operator treats it as a static-infrastructure outage (the health window
holds, maintenance with the outage named).

TRIMMING is bounded by the MINIMUM SAFE OFFSET across ALL consumer groups,
not by the core's progress alone: a stream entry is trim-eligible only when
every consumer group has delivered it AND no outstanding reference still
needs it — no claimed job whose input is that entry (a live PEL entry), no
pending effect whose done record has not settled, no parked function
delivery the adapter has not XACKed. The same floor bounds the done
record's own retention (R4-10): a settled record whose key could still
re-issue through any of those references is kept — a record is pruned no
earlier than the last entry that could re-deliver its key. Consumer
groups are DURABLE: a Valkey
restart keeps each group's position and PEL from AOF, so a restart never
re-delivers a settled entry nor skips an unsettled one, and the core's
snapshot offsets continue from disk. The rewrite/disk-pressure
amplification of this policy is measured, not assumed (Q11's retention
numbers).


## Operator configuration (the decided values, 2026-10-12)

Every value is an operator setting read from the environment with the
stated default (the platform's equivalent of `loader/src/config.ts`), or a
CHART field declared in the repo (the workload values the ADR's A1 names).
DECIDED marks an owner-decided number; "(to measure)" marks a target the
acceptance walk measures down to the realistic value; "(named at outcome-6
design time)" marks a setting whose default is deliberately deferred.

| Setting (`OperatorConfig` field) | Env key / where | Default | Unit | What reads it |
|---|---|---|---|---|
| `coreStopDeadlineMs` | `LIFEMODEL_CORE_STOP_DEADLINE_MS` | 5 000 (DECIDED) | ms (integer, ≥ 0) | The stop-first deadline the OLD core gets to finish the tick in flight and commit its snapshot; expiry is a forced stop (the pod's grace covers it), the unfinished tick re-runs by key. The core's ticks hold no external calls, so the bound is small by construction. |
| `terminationGracePeriodSeconds` (per module, a CHART field) | the module's chart values (an ms input, converted ONCE) | egress gateway: 300 s target, TO MEASURE (≥ its longest declared timeout — the invariant is a build check), rendered `300`; Motor: ≥ its run limit (an existing runtime setting); every other module: 30 s (DECIDED), rendered `30` | s — the pod field's unit; the chart carries ms and converts in ONE reviewed place (ms / 1 000, rounded UP, never shorter than the deadline it covers — R5-11) | How long a terminated old pod may finish in-flight deliveries before SIGKILL; unfinished PEL entries are taken by the new pod via XAUTOCLAIM. The egress value is justified by the build-check invariant (grace ≥ the longest declared timeout, asserted on the RENDERED field in ONE unit), not by the number. |
| `healthWindowMs` | `LIFEMODEL_HEALTH_WINDOW_MS` | 120 000 (DECIDED) | ms (integer, ≥ 1 000) | The window a replaced set must show per-module completed work in to be kept; starts after the commit's LAST replacement. A changed module whose declared delivery-to-result bound exceeds it EXTENDS the window to that bound (R4-03), so demand arriving at the window's start can age past the bound inside it. |
| `firstCommitDeadlineMs` | `LIFEMODEL_FIRST_COMMIT_DEADLINE_MS` | 30 000 (DECIDED, < window) | ms (integer, ≥ 1 000) | The deadline for the new core's first snapshot commit inside the window. |
| `healthFailureWindowMs` | `LIFEMODEL_HEALTH_FAILURE_WINDOW_MS` | 60 000 (proposal — R3-12) | ms (integer, ≥ 1 000, < `healthWindowMs`) | The ROLLING failure window of per-module health: N consecutive local failures with zero successes WITHIN this window fail a module, never over the lifetime since activation. |
| `maxFailedGenerations` | `LIFEMODEL_MAX_FAILED_GENERATIONS` | 2 (DECIDED) | count (integer, ≥ 1) | Consecutive failed commits that open maintenance mode instead of another automatic try. |
| `readinessProbeIntervalMs` | `LIFEMODEL_READINESS_PROBE_INTERVAL_MS` | 2 000 (DECIDED) | ms (integer, ≥ 500) | The replaced module's probe interval — rendered into the pod's readiness probe (`periodSeconds`); time from start to declared-failed = `readinessWindowMs` (the named fixed multiple 30 × the interval, R3-13's number, kept). |
| `readinessWindowMs` | `LIFEMODEL_READINESS_WINDOW_MS` | 60 000 (DECIDED) | ms (integer, ≥ probe interval) | The readiness window (Q2): a module not ready within it is declared failed, the rollout stops and rolls back. |
| `leaseMaxTtl` | `LIFEMODEL_LEASE_MAX_TTL` | 7 (DECIDED) | days (integer, ≥ 1) | Ceiling on a renewed OpenBao module lease; a credential CHANGE ends the module process (vault-env exits, Kubernetes restarts the container), a renewal that lands does not. |
| `leaseIssueStaggerMs` | `LIFEMODEL_LEASE_ISSUE_STAGGER_MS` | 30 000 (proposal — R3-16) | ms (integer, ≥ 0) | The spread between a generation's modules' first authentications, so the leases do not all reach max TTL together. |
| `snapshotCopyRetention` | `LIFEMODEL_SNAPSHOT_COPY_RETENTION` | 3 (DECIDED — the owner's values, not an open question) | count (integer, ≥ 1) | How many snapshot copies (taken ONLY at a core replacement) the operator keeps in Valkey; the oldest beyond it is deleted after the newer copy is durable. |
| `xautoClaimMinIdleMs` | `LIFEMODEL_XAUTOCLAIM_MIN_IDLE_MS` | no default yet (open question 2) | ms (integer) | The XAUTOCLAIM crash-takeover bound; MUST sit above every module's declared delivery-to-result bound (queue wait + held call + parked wait — R4-02), not merely its termination grace; the operator checks the invariant against the manifests at every rollout. Min-idle does NOT fence a live consumer: reclaim from a retiring pod is authorized by its CONFIRMED pod termination, not by idle. |
| delivery-to-result bound (per module, a manifest field) | — (call manifest) | no default; declared per module (TO MEASURE, R4-02) | ms (integer) | The maximum time from a command's delivery to its result: queue wait + held sync call + parked correlated wait. Build-checked with the call manifest; the XAUTOCLAIM min-idle sits above it; the health aged-demand predicate reads it. |
| `functionDeliveryRetryBudget` | `LIFEMODEL_FUNCTION_DELIVERY_RETRY_BUDGET` | named at outcome-6 design time (proposal — R3-10) | count (integer, ≥ 1) | The adapter's bounded attempts for an unavailable function before a delivery is dropped as poison — counted and reported, never silent. |
| `unsealCustody` | fixed; no operator override | `loader` | fixed choice | The loader holds the Shamir key in Kubernetes Secret custody, initializes once, unseals every sealed restart, and retires the root token after verified hand-off to its Kubernetes-auth role (R5-06). |
| `rollbackDeadlineMs` | `LIFEMODEL_ROLLBACK_DEADLINE_MS` | 300 000 (kept — Q3's named window) | ms (integer, ≥ 30 000) | ONE deadline for the whole rollback — revert, Flux reconcile, pod replacement, confirmed termination, readiness, activation, and the restored gateway's Service re-admission where the module is a gateway (a core rollback moves no Service — R4-06). It no longer contains a downgrade step, so the same value covers a shorter sequence with slack. |
| `repositoryPollIntervalMs` | `LIFEMODEL_REPOSITORY_POLL_INTERVAL_MS` | 30 000 | ms (integer, ≥ 1 000) | Operator-configured candidate poll cadence for `main`/PR refs; independent of rollback deadline. Deploy refs are reconciliation inputs only. |
| `buildTimeoutMs` | `LIFEMODEL_BUILD_TIMEOUT_MS` | 1 200 000 (kept from today's loader, `loader/src/config.ts:174`) | ms (integer) | The build budget per module build; the operator refuses a build that writes no image. TO BE RE-MEASURED on the cluster's own 2-CPU envelope (open question 6) — the in-cluster BuildKit build of one module inside the workload's cluster is a new cost, never assumed. |
| `deployRepository` / `deployBranch` (where the desired state is written) | operator config | same Gitea repository / deploy branch (owner, 2026-10-13) | string | The deploy branch is in the in-cluster Gitea repository; protected `main` and deploy are written only by the operator; Flux reads deploy with read-only auth. |

Removed settings of the old shape: `switchDrainMs` (replaced by
`coreStopDeadlineMs` 5 s), `pgFenceLockTimeoutMs` (the closed-apply barrier
is gone; the `active_holder` UPDATE is a trivial idempotent write at the
new core's takeover inside the operator's verification window),
`executorGraceMs` (no executor; the `terminationGracePeriodSeconds` +
XAUTOCLAIM min-idle pair is the whole handover surface). The Compose
manifest fields of the pre-platform shape (`deploy.update_config.order`,
`stop_grace_period`) became the chart's Kubernetes fields (a one-replica
StatefulSet for the core / `RollingUpdate` for the rest,
`terminationGracePeriodSeconds`) — declared per module in
the repo, reviewed with the commit. The two places the settings and the
manifests must agree are unchanged in duty: the XAUTOCLAIM min-idle
invariant (above every declared delivery-to-result bound) and the grace ≥
longest-declared-timeout build check — both checked at every rollout out of
the CHART and the call manifests, never out of literals.

## Architecture rules (point 4; point 3)

- **Only the ingress gateway and the egress gateway touch the world.**
  Every other module's whole influence is signals and commands on the bus.
  Explicit exceptions (adapted to the platform's names):
  (a) Traefik is infrastructure in front of the ingress gateway — the
  owner's WHOLE web surface terminates on the ingress gateway's Service;
  the core holds no front route (R4-06); the operator's web UI is a
  Traefik route with ForwardAuth to the OPERATOR;
  (b) Agent Vault is the last hop of the egress path (egress gateway →
  Agent Vault → internet, reachable from modules only on policy row P5,
  whose only module member is the egress gateway; the vault's own outbound
  leg to the world is the egress path's last hop — Agent Vault ALONE holds
  the model keys, R4-06);
  (c) Motor sandbox traffic goes through the egress gateway as an HTTP
  proxy (`HTTPS_PROXY`) under a motor policy, on the `lifemodel-motor` rows
  (P8) — the sandboxes have no bus or store route; P8 is their proxy-egress
  path, while the only internal-route exceptions are P24 to Gitea HTTPS for
  this-repository clone, task-branch push and PR, and P27 to OpenBao only for
  run-specific task-token retrieval;
  (d) the operator's BuildKit builds use the network (Q1) outside the
  rule — they may later go via the gateway or a package mirror; (e) the
  optional Gitea push mirror uses the existing egress gateway through P26,
  never a direct Gitea internet route (exception e).
  Later Telegram rides the same two gateways: inbound via the ingress
  gateway (webhook) or the egress gateway (polling), sending via the
  egress gateway.
- **Interactions are one-directional, acyclic, through the bus wherever
  possible** (point 3's architecture rule). Explicit exceptions: the stores
  (Valkey, Postgres — the modules' data planes), the read-only PROBE
  (the kubelet probes the module — observation, never control, O2-F),
  the owner's entry via Traefik, the adapter ↔ workerd HTTP leg INSIDE one
  function-host module, every module pod's vault-env auth leg to OpenBao
  (P3), the operator's control plane (the Kubernetes API, git, the stores
  and OpenBao — rows P9-P12), the Motor module's Jobs API row (P6/P7), the
  egress gateway's vault leg (P5), and the Motor sandbox's proxied egress
  trip through the egress gateway (P8). Nothing else is a direct call; no
  cycles exist in the call graph above — requests flow
  core → gateway → world, results flow world → gateway → bus → core.
- **Identity without certificates (point 3).** A requester's identity is
  the stream it wrote to; the Valkey ACL refuses a module XADD on another
  module's command stream. Network isolation is structural (the policy
  rows above): a module that must not reach a surface HAS NO ROW to it.
  mTLS workload identity is DEFERRED to the backlog and returns when
  modules span machines or come from foreign sources (A3's invalidator).
- **Cluster-mutation authority is the RBAC surface, stated (B08's
  successor).** The operator holds the controller verbs of the RBAC table;
  Motor holds its narrow Jobs row; module service accounts grant NOTHING.
  RBAC is a MISTAKE barrier, not a blast-radius bound — the operator's
  rights are the cluster's widest mutation surface, and the cheap guards
  (the Lua epoch CAS, `active_holder`) are exactly as far as the owner
  asked the guards to go (A2). In-place restarts are Kubernetes'
  (restartPolicy — a fresh bootstrap, re-authenticated, rejoins its group
  under Q2's rules); a CODE replacement is never self-healing — it arrives
  only through a rollout the operator drives through the deploy branch;
  panic and maintenance hold their cluster state (suspend + scale 0), so a
  node restart during them revives nothing.
- **The tick is the only boundary (Q13).** No component writes tick state
  except through committed snapshots and bus events; every span-tick item
  of inventory 2.2 maps to exactly one row of the event table or one named
  durable mechanism (the delayed-event rows, the done records).

## Checks

Every F* (inventory 3.1, with its amendments) and every Q* (inventory 4) as
an executable check — fitness function: WHAT runs, WHERE — or a named human
judgement, plus the design's own checks (the N-numbering of the simplified
shape SURVIVES: its assertions are content-neutral, only the mechanism nouns
changed — the noun map after the N-rows). Each row states the design rule or
owner decision it proves.

**Delivery checks are decided here.** Isolated launcher tests cover unit and
ordinary integration behavior; they do not start a cluster. The owner decision
of 2026-10-14 removes the Docker-run instance image and its first-start fixture.
There is no PR-only first-start or k3d delivery CI walk. Outcome 4 is accepted
on the k3s shape by the manual clean-VM check on the owner's test VM, run by the
coordinator over SSH using `generations/clean-vm-install`. The owner restores
the clean hypervisor snapshot before the from-scratch check. It proves k3s,
Flux, the pinned signature-verifying OCI source, platform-up, loader first
start, second source and first generation, including a node reboot cut. The
supported shapes are NixOS first (`services.lifemodel`, `nixos-rebuild switch`)
and Ubuntu/Debian (`scripts/install.sh`); both use k3s with embedded etcd and
the same rendered `deploy/root/` templates. Existing-cluster installation is
deferred to lifemodel-xc9.

3. **A named human judgement** — the table at the end.

No surviving check depends on a removed mechanism (the socket proxies, the
wrapped AppRole secret-ids, `docker inspect`, Caddy aliases, panic.json,
loader-file fsync — each replaced check's noun is in the map table).

**Round-five checks remain in force; round six closes the delivery changes.**
The earlier F1-F8, Q*, and N* checks remain unchanged except where their
source/lifecycle boundary is amended below. The clean-VM check is a manual
acceptance check on the owner's test VM, run by the coordinator over SSH;
there is no CI walk or k3d delivery walk and no existing-cluster path in this
milestone. R6-05's never-delete-a-referenced-Secret rule and R6-06's
platform-layer Gitea lifecycle owner are explicitly exercised by G3 and
N-19. Every assertion below names its isolated unit, k3d walk, manual
acceptance check on the owner's test VM, or human judgement. No old
installer-Helm check is retained.

### Round 7 authority and bootstrap checks

| Finding | Design contract and acceptance evidence |
|---|---|
| R7-01 — application apply identity and sources | Each application Kustomization lives in its target namespace (`lifemodel`, `lifemodel-motor`) and its `serviceAccountName` names the applier in that same namespace; each HelmRelease independently impersonates its target-namespace applier and explicitly sets `spec.storageNamespace` to `lifemodel-releases` or `lifemodel-motor-releases`. Each target has its own platform-created deploy-branch GitRepository and loader-written read-only credential Secret; source-controller reads that credential under its own identity, never the applier. The platform-created storage namespaces contain no workloads, only Helm release Secrets, and have default-deny policy; generation sources cannot touch them. Each applier has no Secret rights in either target namespace. A Role and RoleBinding in each storage namespace grants Secret get/list/watch/create/update/delete only to the corresponding target-namespace applier ServiceAccount; RBAC does not filter by Secret type, so isolation is by dedicated storage namespace, not admission. Verify `spec.storageNamespace` and HelmRelease `serviceAccountName` against the [Flux HelmRelease docs](https://fluxcd.io/flux/components/helm/helmreleases/). Missing/privileged identities, remote kubeconfigs, disallowed cross-namespace references, nested reconcilers except the named HelmRelease edge, CRDs, and cluster-scoped outputs fail closed. Platform admission validates rendered chart objects/hooks and reserved kind/name/field ownership. Under each real applier identity, prove Helm install, upgrade, history and cleanup succeed in its storage namespace, and Secret get/list of non-release Secrets is denied in both target namespaces; also prove credential Secret access is denied to the applier. Exercise actual Flux/Helm rejection of a cluster object, a Gitea object and an in-namespace policy/account edit, plus a valid generation rollout. |
| R7-02 — loader bootstrap authority | The platform declares a separate loader ServiceAccount and exact namespace-scoped grants for phase/custody/admin Secrets, the two target-namespace read-only source credential Secrets and application Kustomizations, and the digest-only root pin patch. The platform release creates each local deploy-branch GitRepository source. Root verifier/source fields and platform RBAC are immutable to the loader; generation writer cannot patch the root or bootstrap records. Custody and bootstrap/source credentials are excluded from both prune inventories. Verify each positive operation under the real loader identity and denied platform operation under the generation identity. Cut each durable phase; start the loader before Gitea readiness and Bao unseal, and prove there is no aggregate-readiness/webhook cycle. Retain the named init-to-custody visible-recovery limit. |
| R7-03 — effective Gitea chart values | Signed chart values explicitly disable `postgresql-ha`, `postgresql`, `valkey-cluster`, and `valkey`; set SQLite and built-in queue/cache; explicitly empty admin username/password while the generated Secret is referenced. Render chart 12.7.0 and assert effective DB/cache/admin configuration, no bundled database/cache workloads/PVCs. Secret retirement disables admin config, proves no fallback credential, checks replacement Pod and Bao-held API login, then deletes only after all rendered references are gone; cut and resume every durable phase. |
| R7-04 — exclusive root trust/pin ownership | Installer/root policy owns root OCIRepository, verification policy and root Kustomization outside the signed artifact inventory. Loader can patch only the selected digest after owner authorization; artifact cannot manage/prune these objects or reset a pin. Durable selection survives Flux/loader/node restart. Reconcile an owner repin under competing reconciliation; reject verifier/pin changes from a release and assert the persisted selected digest. |
| R7-05 — recoverable platform upgrade | Record old/new digests, versions, app revision, compatibility, verified recovery material, phases, deadlines and outcome. Preflight supported paths against the running app; serialize app selection/deploy writes at its recorded revision while its source continues reconciling. Keep loader/owner UI reachable. Permit rollback only before irreversible migration; otherwise forward/owner recovery, never DB downgrade/prune. Until verified Gitea/storage recovery exists, refuse those upgrades. Walk successful and partial upgrade, loader restart/UI failure, concurrent app write, safe pin return and unsafe rollback refusal. |
| R7-06 — continuing signed-source route | P15 names OCI registry/auth/token, online verifier-required Sigstore, DNS, and the one `release.yml` signing/verifying identity. P31 names kustomize-controller/helm-controller artifact fetches from source-controller Service TCP 80 → container HTTP 9090; P32 names Flux-controller access to the Kubernetes API. These direct platform routes do not use application egress. Pin verifier versions and state online Rekor/TUF requirements. Prove signed fetch/reverification after default-deny and after source-controller restart/cache loss. |
| R7-07 — publisher transition/outage | Root-policy-only, separately authenticated identity transition with exact old/new overlap and later old identity retirement; never trust a matcher from the artifact. Clean install requires network and fails closed without artifact/signature/trust evidence. Existing workloads and last applied state continue during outage; new releases require verification. Cached verified use is allowed only while artifact and evidence remain available and trust is unchanged; cache loss blocks fetch. Walk allowed/denied identities, retirement, tampering, outage and cache/source restart. |
| R7-08 — panic stop/leave-running sets | During panic keep the application Kustomization reconciling its pinned source, but protect operator-owned gate fields; suspend every app HelmRelease and scale module workloads to zero. Enumerate both application namespaces; remove the obsolete bootstrap-root exclusion. Platform roots/controllers and loader/Traefik/owner UI, Gitea, Bao and control plane remain running. Platform upgrades cannot clear panic and pause if they conflict or endanger recovery. Cut competing app/platform reconciles and an upgrade during panic; prove no module/sandbox restart and reachable owner UI. |
| R7-09 — bounded claims and evidence | At the init-success/custody-write crash cut, assert visible owner recovery, no automatic second init, and no automatic credential-preservation claim. F7, G3 and N-19 await the manual acceptance check on the owner's test VM. Include R7-05 upgrade success/partial/recovery cases, R7-06 outage/cache/reverification, R7-07 identity transition, and R7-08 two-layer panic cuts. Synthetic source lint or an empty k3d cluster is not manual acceptance evidence. |

### F* checks

| # | Check (fitness function) | Where / what runs it |
|---|---|---|
| F1 | Request a generation at a commit while N serves: the OPERATOR builds ONLY the changed modules' images as rootless BuildKit pods in `lifemodel-system`, pushing into the LOCAL REGISTRY (no host Docker, no external registry; the build pod holds no credentials, bases digest-pinned); an unchanged module's tag resolves from the previous commit and reuses its image with NO build (N-1) — while the commit-pair schema check still runs at every rollout regardless of reuse (N-2). The changed modules are then replaced ONE BY ONE in manifest order, each gated by a GIT STEP (R5-01): the operator commits the module's slice, waits for the release APPLIED AT THE RECORDED revision (the release's status names the step's revision — a stale ACK closes no step) AND the module's completion (readiness + the old pod's confirmed termination), then commits the next — a scale-down/suspend waits for the suspend ACK with NO in-flight Helm action; a build failure or a failing schema comparison writes no tag and touches nothing running, with a compiler-grade report; the REGISTRY is proved as a node-pull mechanism (R5-08): the installer wrote the node's trust for the stable endpoint before any module pod was scheduled, and the walk runs a COLD containerd pull on a rebooted node with no preloaded module images — the pod reaches Running, and the registry volume's persistence is recorded separately; a candidate whose image tags are ALL reused but whose chart/values change the rendered workload state passes the FULL gate — the same Git steps, readiness gates and health window (R5-10: reuse buys build cost, never a skipped gate). Proves O1-2026, simplification points 1 and 5, R3-18, R5-10, R5-08. | Unit in the launcher: the tag/build ledger (N-1) and the schema-checker (N-2). k3d walk `generations/candidate-beside` and `generations/timing` (the all-reused candidate case lives here — the tags-unchanged candidate whose chart/values changed still passes the gate, and its readiness-BREAKING chart-only variant is the failed candidate `generations/rollback-unhealthy` rolls back — R5-10's paired cases). |
| F2 | The rollout state machine cannot replace the next module before the current one passes its KUBERNETES readiness probe (`readinessWindowMs`, the fixed 30× multiple of `readinessProbeIntervalMs`); readiness cannot pass while the module's initialization is incomplete (stores reachable; for the core: the epoch-N snapshot hydrated and its format accepted, ONE dry tick with all effects suppressed); the epoch changes ZERO times during a start-first rollout and ONLY at the core's stop-first replacement — where the NEW CORE takes the epoch itself (the Lua CAS) after the old pod's termination is CONFIRMED (observed, never assumed, A12) and the lease revocation + bounded backend drain finished (R4-14) — and the operator VERIFIES the post-conditions (epoch moved exactly once, `active_holder` agrees; a miss is maintenance). Proves O2-2026, simplification point 1, Q2's fencing, R5-01's one-owner gate, R5-15's one startup predicate. | Unit in the launcher: the rollout state machine with fake probes/clock + the readiness-suppression rule (N-22), plus the gate state machine (a step closes on the revision ACK + acceptance pair; a stale revision ACK or a missing acceptance closes nothing) and the predicate checker (Ready cannot report true while the group join or any bootstrap item is missing — the R5-15 unit). k3d walk `generations/switch-happy` (asserts the epoch record unchanged until the core's confirmed termination; zero stream entries or rows written during any module's dry readiness EXCEPT the R4-04 adapter-bootstrap exception — the fresh adapter's keyed `bootstrap.request` and the applier's instance-addressed answer packets, which carry no effect; the R5-15 cuts — a valid boot LONGER than the 15 s liveness threshold is not restarted (the startup allowance holds), and a SLOW group join keeps the pod NotReady with the old pod still serving until the join completes, against the real Deployment controller). |
| F3 | Messages sent around a planned switch (before the stop, during the serving gap, after the new core's first commit) are each answered exactly once; the serving gap is bounded (Q1) and the ingress gateway keeps ACCEPTING and XADDing to `inbound` through the whole gap — Traefik's Service endpoints follow readiness, so a switch moves who READS `inbound`, never who accepts it; the new core continues from the final snapshot the old core committed under epoch N (the outbox, inbound offsets, dedup ring and pending-effect list ride the commit); a lost browser response retries with the SAME idempotency key and is absorbed by the dedup ring (R3-15, N-17). Proves F3, O2-2026, points 1 and 6. | k3d walk `generations/switch-messages`; the replay/offset math (post-offset minus dedup, pending effects re-issued under persisted ids) unit-tested in the launcher against synthetic snapshots. |
| F4 | A replaced module that passes readiness but shows no completed work in its health window is caught by the PER-MODULE health classifier (N-16: rolling failure window, local/upstream/infra attribution, done-record evidence); a failed module (or the core's two consecutive liveness gaps) triggers rollback to the PREVIOUS GENERATION'S COMPLETE desired state — a GIT REVERT of the deploy branch to the generation registry's recorded revision (full chart and values, R5-10), applied by Flux module by module, on CURRENT data — with exactly ONE report and NO downgrade step and NO data-restore step in the recorded sequence; the revert restores the COMPLETE previous desired state — the generation registry's recorded revision, chart and values together — so a launch-state regression (probe/grace/env/strategy/policy) cannot survive behind reused tags (R5-10). Proves F4, O3-2026, points 1 and 6, B06, R5-10. | Unit in the launcher: the health classifier (N-16) and the rollback deadline state machine (fake clock). k3d walks `generations/rollback-unhealthy` (timed against `rollbackDeadlineMs`; the failed candidate is a CHART-ONLY readiness-breaking commit whose image tags are ALL reused — the revert restores the prior revision whole and the walk asserts the rendered state matches it — R5-10) and `generations/whole-health` (N-16's module-wedge cases). |
| F5 | From maintenance mode (durable cluster state: the lifemodel releases SUSPENDED, the workloads SCALED TO ZERO — a node or operator restart revives nothing) the owner boots an older generation WITHIN the compatibility window — decided from FILES and the stores' stamped versions at the boot's own rollout (the point-5 commit-pair comparison plus the snapshot-format rule; NOT a registry run, no reader runs): in-window boot serves and answers a live create through the function surface (a reminder created via a function `schedule.set` command, its row in the core schema, the `state.applied` ack by correlation id — R3-10); an OUT-of-window boot REFUSES BEFORE any start, with the reason naming the failing comparison, and the instance stays down in maintenance; an automatic rollback whose target refuses the current data's format opens maintenance with the refusal named. NO down-migration path exists in any code surface (a source scan finds only the expanding-only tool interface). Proves F5, O3-2026, point 5. | Unit in the launcher: the window decision (schema pair + stamped versions, positive/negative) + the source scan. k3d walk `generations/maintenance-boot-older` (in-window boot, out-of-window refusal, the live create through the adapter, and the scale-0/suspend state asserted across an operator restart). |
| F6 | The compatibility checks are real and fail the rollout before any tag or pod exists: (a) the commit-pair schema comparison — AsyncAPI + JSON Schema + snapshot format, FULL both ways (N-3); (b) expanding-only migrations, squawk-linted (N-6), applied BEFORE the first replacement as a migration JOB the operator creates in `lifemodel-state`, run under the DDL role; (c) the call-manifest timeout/class check and the grace invariant (N-5); (d) the WinterTC lint (N-10, N-14). All four produce the same compiler-grade report shape. Proves O1-2026, O8, point 5, R3-07's file-level survivor. | Unit/integration in the launcher: the four checkers against synthetic commit pairs and manifests — no engines or cluster needed. k3d walk re-runs them inside the real build/rollout (`generations/candidate-beside` asserts a failing check leaves no image tag, no migration Job and no pod). |
| F7 | One command on a clean dedicated VM installs only k3s, Flux, and the pinned root `OCIRepository` + platform `Kustomization`; the root verifies the signed platform artifact using keyless `matchOIDCIdentity` (default) or key verification through `secretRef` to a public key. Flux brings up platform workloads, including loader and Gitea. The loader's first start resumes idempotently through OpenBao init/unseal custody, chart-supported Gitea admin creation, same-release repository seed, branch protection, Flux read-only credential, and creation of the application source. That source reconciles only generation-scoped namespaced objects; the first generation runs only after source health. A tampered, unsigned, wrong-identity, or unpinned artifact is refused before any platform object applies. Kill/restart at every loader step resumes without reinitializing Bao, overwriting the repo, or deleting a referenced Secret (R6-05); the init-succeeded/before-custody-write cut instead fails visibly for owner-supplied recovery and is never automatically reinitialized. A candidate/rollback attempting to change Gitea or any platform object is rejected before mutation (R6-06). Panic remains durable across operator/Flux restarts and node reboot; only an owner-authorized durable resume clears it. Proves the revised F7 and the two-layer boundary. **Pending the manual acceptance check on the owner's test VM.** | Manual acceptance check on the owner's test VM, run by the coordinator over SSH: `generations/clean-vm-install`; actual k3s install → Flux + signed platform source → platform-ready → loader first start → second source → first generation, with a reboot and cuts after each first-start step. k3d `generations/clean-bootstrap` covers cluster mechanics only. Unit/source tests verify pinned signature policy, source scope, resume records and ownership lint. |
| F8 | The operator's config schema carries every ADR-010 setting with its stated default, DECIDED marks closed (open: only `xautoClaimMinIdleMs` undefaulted, `functionDeliveryRetryBudget` deferred, and the egress gateway's grace to measure): `coreStopDeadlineMs` 5 000, per-module `terminationGracePeriodSeconds` as a CHART field (egress ≥ longest declared timeout, Motor ≥ run limit, others 30 000), `leaseMaxTtl` 7, `snapshotCopyRetention` 3, `healthWindowMs` 120 000, `firstCommitDeadlineMs` 30 000, `healthFailureWindowMs` 60 000, `maxFailedGenerations` 2, `readinessProbeIntervalMs` 2 000, `readinessWindowMs` 60 000, `leaseIssueStaggerMs` 30 000, `rollbackDeadlineMs` 300 000, `buildTimeoutMs` 1 200 000 (to re-measure), `unsealCustody` `'operator'`; out-of-range env values rejected, and the CROSS-SETTING invariants hold (`firstCommitDeadlineMs < healthWindowMs`, `healthFailureWindowMs < healthWindowMs`, `xautoClaimMinIdleMs` > every module's declared delivery-to-result bound, every module's chart grace ≥ its longest declared timeout); a module whose declared bound exceeds `healthWindowMs` extends its health window to the bound (R4-03, N-16); the switch/rollback/health paths read the fields, not literals; every grace value is RENDERED as the pod field's own unit — seconds (300/30, the core's grace ≥ the 5 s deadline) with the one reviewed ms→s conversion (rounded up) — and the grace invariant is asserted against the RENDERED pod field, never the pre-conversion chart input (R5-11); the chart's rendered sources declare NO `spec.suspend` and no operator-owned gate scale anywhere (one writer per operator-owned field — R5-01/R5-02). Proves the values as configuration. | Unit in the launcher: `loadConfig` defaults + invalid-env cases against the operator's config + the invariant checks against the chart values and synthetic call manifests; the R5-11 unit renders the chart and asserts the ACTUAL pod fields (`terminationGracePeriodSeconds` 300/30 and the core's ≥ 5) and the timeout inequalities in one converted unit, never only the `OperatorConfig` defaults. |

### Gitea checks (owner decision, 2026-10-13)

| # | Check (fitness function) | Where / what runs it |
|---|---|---|
| G1 | Flux's `GitRepository` reads the deploy branch from in-cluster Gitea using read-only auth; it cannot write either protected branch. Candidate polling reads only `main`/PR refs; deploy refs are reconciliation inputs, never candidate events. The configured poll interval is separate from the rollback clock. Durable source-SHA/outcome deduplication serializes selection behind active rollback; a refused SHA retries only after explicit owner authorization or a new SHA. | k3d walk `generations/gitea-flux-source`: poll during rollback, after deploy revert, and after operator restart; prove no duplicate generation or automatic reapplication of failed SHA. Exercise explicit owner retry and new-SHA retry; source/credential wiring unit-checked in the launcher. |
| G2 | Prove the real non-admin `lifemodel-task` identity has access only to this repository, can clone/push `task/*` and open/update PRs, and cannot direct/force push, API-write files, or merge to `main`/deploy, edit protection, mint credentials or access a second private repository. Verify highest-priority operator-only direct-push and merge rules, no task admin bypass, and the accepted residual rights on other unprotected branches/tags and PR metadata. Before each mint, durably record run id, unique token name/id, maximum run lifetime and pending revoke; recover lost mint response by identity/name without duplicate minting. Cut after intent, mint, Bao write, delivery, Job cancellation/deadline, operator crash/restart, Gitea outage during revoke, confirmed revoke and Bao deletion. Reconcile all cleanup outcomes; visibly retry and deny new self-change run while cleanup unresolved. Prove a copied token is refused for both Git and API after confirmed revoke. | k3d walk `generations/gitea-task-credentials` with two concurrent run identities and cleanup cuts; prove cross-run Bao isolation, no access to admin/module secrets or subtree listing, and no access after teardown. Unit test durable issuance/revocation state transitions and lost-response recovery; inspect the final mutated Pod after webhook mutation, not merely its Job template, and verify no credential fields are present. |
| G3 | Prove the clean-VM order: one command installs only k3s, Flux and the pinned signature-verifying OCI source; Flux deploys the platform; the loader first start initializes OpenBao custody, creates the Gitea admin via chart 12.7.0 `existingSecret` + `initialOnlyNoReset`, seeds the same release, protects branches, creates Flux read-only auth and adds the deploy-branch source; the first generation follows only after that source reconciles. The loader-owned admin and Flux Secrets are never deleted while referenced by rendered objects (R6-05). Interrupt and restart after each action, including before/after all durable writes and source reconciliation. The init-succeeded/before-custody-write cut must stop visibly for owner-supplied recovery, without a second init or a claim of automatic credential preservation; all other recorded phases prove idempotent resume. Tampered, unsigned, wrong-identity and wrong-digest artifacts are refused. A candidate touching Gitea, platform releases, PVCs, policies, routes or the platform source is refused before mutation. | Manual acceptance check on the owner's test VM, run by the coordinator over SSH: `generations/clean-vm-install`; unit tests for signature policy, step persistence and scope refusal. No existing-cluster walk in this milestone. **Pending the manual acceptance check on the owner's test VM.** |
| G4 | With push mirroring enabled, pinned-chart Gitea Git subprocess settings use the dedicated egress-gateway mirror listener and fixed `gitea-push-mirror` policy to send commits only to the configured outside remote; CONNECT is allowed only to that host on 443. The listener has its own port, is reachable by NetworkPolicy only from Gitea pods in `lifemodel-git`, uses no proxy credential, and grants no bus/store authority. Gitea cannot reach other gateway listeners or select another policy/listener. With mirroring off, no mirror traffic is emitted. Gitea has no direct internet route, and mirror failure never gates rollout/rollback. | k3d walk `generations/gitea-mirror-egress`: observe an actual commit arrive at the allowed remote; deny a second remote and direct internet; prove another caller cannot reach the mirror listener, and Gitea cannot select another policy/listener; exercise mirror-off and gateway-unavailable retry/report; inspect proxy settings, NetworkPolicy and fixed listener-policy binding. Rendered-policy inspection alone is not delivery proof. |
| G5 | When Gitea is stopped, an already running generation continues unaffected; no new generation is built or selected. Every Gitea wait/retry consumes `rollbackDeadlineMs`; recovery before expiry resumes the recorded attempt, while expiry durably enters maintenance (Flux suspended and module workloads scaled to zero), reports the blocked Git step, and requires owner authorization to start after recovery. No late automatic revert/start occurs. Candidate polling is suspended behind rollback; deploy refs never enqueue candidates and a refused SHA is not retried absent owner authorization or a new SHA. | k3d walk `generations/gitea-outage`: recover before/after expiry, operator restart cut, durable resumption before expiry, maintenance and blocked Git-step report after expiry, authorized operator restart only, no late auto-revert/start; poll during rollback, after revert and after restart and assert no duplicate generation/failed-SHA reapplication. |

### Q* checks

| # | Check (fitness function) | Where / what runs it |
|---|---|---|
| Q1 | Bounded pause, PHASE-NAMED (R5-14): the core replacement's serving gap is the SUM of its recorded phases — the stop deadline (≤ `coreStopDeadlineMs` 5 s — the core holds NO external call, so the bound is small by construction), the fence waits (lease revocation + the bounded backend drain), the snapshot-copy write, the resume + Flux reconcile and revision ACK, node scheduling and image pull, and the new core's start-to-first-commit bounded by `readinessWindowMs` (60 s, its clock starting at the RESUME); each phase names its bound and failure outcome (overrun → forced stop / rollback / maintenance as the contract states); the walk reports the observed per-phase timings and their sum as the actual pause — never the application boot alone; the walk asserts the core makes NO egress request and NO direct endpoint call at any time (its influence is command events only); every owner message received around the switch is answered exactly once (F3's method); the ingress gateway answers HTTP 202 throughout. Proves O2-2026, the values, points 1 and 3, R5-14. | k3d walk `generations/switch-messages` (timed per phase, the sum reported, with the no-egress-call assertion) — the same walk F3 uses; the phase timings come from the rollout record's own entries (unit-asserted) and Q11's synchronized sampler. |
| Q2 — SPLIT (R4-11) | TWO never-ready cases, each proving what the owner's strategy actually claims: (a) KEYED-MODULE never-ready (start-first): a non-core module declared failed within `readinessWindowMs` — the named fixed multiple, 30 × `readinessProbeIntervalMs` (2 s / 60 s, values) — the epoch changes ZERO times (operator records), the previous instance answers THROUGHOUT the window, the discard leaves no pod, and the readiness path wrote NO side effect (N-22). (b) CORE stop-first readiness failure: the old core has ALREADY exited and the epoch ALREADY taken (by the failed core's own CAS, if it got that far) before the failure is declared, so the case asserts instead: the epoch value moved EXACTLY once and is NEVER reused; intake stayed DURABLE throughout — the ingress gateway kept accepting and XADDing to `inbound`, no dropped owner message; and the failure is followed by the BOUNDED FALLBACK ON CURRENT DATA (contract point 8): the failed pod is discarded under confirmed termination, the previous commit's desired state is restored in the deploy branch (the recorded revision — R5-10), and the restored core goes through the SAME gated window, taking the NEXT epoch value idempotently by CAS — and hydrating the LATEST CURRENT snapshot on CURRENT Postgres data: the asserted NEGATIVE cuts are that NO retained COPY is restored by any automatic path (the window's own copy stays an untouched observation point) and that NO COMMITTED outcome is replayed (a re-run executes only the abandoned tick's still-PENDING effects under their persisted ids; done records and message rows settle everything else) — never a frozen instance, never a reused epoch, never an automatic copy restore (R5-12). Proves O2-2026, point 1, R4-11, R5-12. | Unit: both branches of the probe/rollout state machine, fake clock — case (b) against the fallback/rollback state machine (Q3's). k3d walk `generations/never-ready` runs BOTH cases — a gateway AND the core — so the core case cannot hide behind a gateway-only exercise. |
| Q3 | Ready-but-unhealthy (or a failed replacement): rollback's TWO measured outcomes are distinct and never conflated (R4-13) — RESTORED within `rollbackDeadlineMs` 300 s from the health-window failure to service restored on the unchanged web surface (no Traefik/Service step for a core rollback — the core is bus-reachable, R4-06; a rolled-back gateway re-enters its Service endpoint set at its readiness), or MAINTENANCE-ON-EXPIRY with the report naming the step that ran over and what it consumed (NOT restored service); ONE clock covering the git revert, Flux reconcile, pod replacement, confirmed termination, readiness, activation, and the gateway's Service re-admission where the module is a gateway (no downgrade step exists to measure — the schema check catches a format gap at ROLLOUT time, N-2/N-3); the budget allocation is measured, not assumed: the walk runs a MAXIMUM-duration in-flight call (the longest declared timeout) during a MULTI-module rollback and reports what share of the 300 s it consumed against the named allocation (a chart grace too long for the clock refuses into maintenance at the attempt's entry instead of timing out mid-drain — the safe early-stop); exactly one report; the once-only message contract holds through the rollback (F3's method re-run mid-rollback); ONE automatic fallback — after it, healthy or maintenance (`maxFailedGenerations` 2); the rollback target is the previous generation's RECORDED FULL revision and the walk asserts the rendered state matches it after the revert (launch state included — R5-10); the rollback's core replacement takes a snapshot copy and the epoch moves to a NEVER-REUSED value (point 6); if the restored core refuses the current data's format, maintenance with the refusal named. Proves O3-2026, points 1 and 6, B06, B0R-R06, R4-13, R5-10. | k3d walk `generations/rollback-unhealthy` with the deadline asserted + the refusal case + the maximum-duration-call-during-multi-module-rollback measurement (R4-13); the deadline state machine (including the early-stop refusal branch) unit-tested with a fake clock. |
| Q4 | Crash mid-tick (kill -9 the core pod): the restart continues from the last committed snapshot; ≤ 1 replay per message; committed work not redone; the abandoned tick's pending effects replay with their PERSISTED effect ids (minted at the deciding tick, never re-derived); its in-flight command events are taken over by the owning module's consumer group via XAUTOCLAIM (N-13) — no executor heartbeat exists to fake or lose (point 2). The five crash cuts (outbox-committed/undelivered, mid-delivery, delivered-uncommitted, deadline-abandoned tick, Valkey restart) are each walked. Proves O2-2026, points 2 and 4. | k3d walk `generations/holder-crash`; the cut matrix unit-tested in the launcher against synthetic done records and pending-effect lists (N-12). |
| Q5 | OPERATOR crash at EACH reconciliation branch (record phase before the core's gated window with epoch == old → resume at the recorded phase, the old core KEPT SERVING, no gap, no duplicate report; record phase INSIDE the gated window with epoch == old → the fence steps re-run IDEMPOTENTLY, resume, continue at health-wait; epoch == aimed → reconciled FORWARD, never re-fenced — the epoch record outranks the recorded phase; a FOREIGN epoch → refuse + maintenance, never guess; an EMPTY Valkey after AOF loss → refuse + maintenance, never epoch 1 beside live generations; a NODE/kubelet restart is NOT a special case — in-place restarts are fresh bootstraps re-authenticated through their service accounts, the gated core window has NOTHING to revive (the Deployment is scaled to 0), panic/maintenance scale-0 revives nothing, and no new code arrives by any path other than an operator rollout; DRIFT (a pod matching neither branch nor record) is settled by Flux's reconcile and reported, never adopted; the dead operator's unrevoked leases are revoked for its records' confirmed-terminated pods; a RECORD WRITE cut (R4-09): the installer-selected embedded etcd's replicated-log write-through replaces the fsync triple (R5-18) — a record not read back complete is REWRITTEN before anything acts on it, and the panic/resume cuts are the ACHIEVABLE pair above; the R5-02 panic-CONVERGENCE cuts — the operator killed after EACH mutation of the per-release transition (after release i's suspend ACK, after its scale ACK, and AGAIN while a Helm action was still running when the suspend landed); the `lifemodel-motor` step is MOTOR'S OWN CLEANUP — Motor's registered identity deletes the RUNNING sandbox Jobs under its own RBAC row BEFORE that release's scale to zero (the operator stays control-only; scaling Motor to zero alone stops no existing Job, R5-09) — the result is always the completed all-stopped state (every lifemodel release suspended, every module workload OBSERVED at zero, NO sandbox Job running) with NO module started, and an incomplete panic state on a fresh operator's read is re-driven, never reported complete; the R5-09 CLEANUP CUT — an interrupted sandbox cleanup resumed at Motor start leaves neither a running sandbox nor a retained unowned volume (the run registry re-drives deletion; the walk deliberately kills Motor mid-cleanup and re-checks); exactly one report per attempt, rewritten at done/refused; a rollout cut BETWEEN a step commit and the step's acceptance resumes at that step — the release's revision ACK and the module's acceptance are re-verified from the record before the next commit (R5-01); a suspend/scale of the panic and maintenance paths is issued only AFTER the controller's ACK and with no in-flight Helm action. Proves O2-2026/O3-2026, points 1 and 3, C01, R4-09, R5-01, R5-09. | Unit: the reconciliation walker against recorded states (isolated launcher). k3d walk `generations/operator-crash-cuts` (each epoch-vs-record branch, drift, the node-restart cut with in-place restart + re-authentication, the record-not-read-back-complete rewrite — and, per R5-18, the walk asserts the server ACTUALLY runs the installer-selected embedded etcd datastore and re-reads a rollout record across a node reboot on it, the read-back-completeness being a property of the NAMED datastore, not an assumed default; and the achievable panic-resume pair — R4-09; the R5-02 panic-convergence cuts (the operator killed after EACH per-release mutation — suspend ACK, scale ACK, and again mid a running Helm action — ending in the observed all-stopped state with NO sandbox Job running, R5-09; the walk's walker also drives an incomplete panic state), the R5-09 cleanup cut (Motor killed mid-cleanup, restarted: no running sandbox, no retained unowned volume); the R5-01 gate cuts — a CONCURRENT reconcile while a step is open (the branch carries one uninstructed step, so a second module cannot move; the walk runs a competing kustomize reconcile against an open step and counts the modules touched: exactly the step's own one), and an operator crash BETWEEN a step commit and its acceptance (the reopened walk verifies the release's revision ACK and the step module's acceptance from the record BEFORE any next commit lands — the next module never moved during the cut). |
| Q6 | Valkey restart: AOF replay yields byte-identical bus position, epoch record and snapshot; the modules' writes during downtime fail VISIBLY (the core's commit pauses, unavailability reported — never an accepted write later unaccounted); consumer groups keep their positions and PEL entries from AOF (no settled entry re-delivered, none skipped); the core's snapshot offsets continue from disk; the epoch record read from AOF — an EMPTY store refuses into maintenance, never mints epoch 1 beside live generations. Proves O4-2026, point 3, R3-21's durability half. | k3d walk `generations/valkey-restart`; engine behavior recorded as measured output (C02 debt). |
| Q7 | Stale write after the switch, on the core's one authorized live connection: (i) the epoch-checked Lua CAS with the CURRENT epoch succeeds — a NORMAL commit is required (the core role carries its commit script; the check proves the happy path works on the same connection); (ii) the same CAS with the OLD epoch refuses, counted, and the `active_holder`-checked `pg.apply` refuses on the epoch mismatch — zero accepted stale writes; the snapshot and bus position are byte-identical before and after; (iii) the epoch key is writable ONLY by the core and operator roles (a module role's direct epoch write is refused by the ACL — point 3; the CAS script is granted to the core role alone); (iv) the recorded switch sequence shows the confirmed pod termination BEFORE the fence is relied on — and that termination's EVIDENCE is the kubelet/OBSERVED pod state, never API-object absence: the core runs as a ONE-REPLICA STATEFULSET (the at-most-one identity; no replacement pod before the previous pod's fully observed termination — R5-03, Recreate's upgrade-only wait rejected), the operator issues NO force deletion on a core pod, and the walk's failure cut removes a core pod's API object WITHOUT observed process death — the outcome is a refusal into maintenance with NO successor started and NOTHING fenced; the fence is confirmed termination + epoch CAS + `active_holder` guard, and `active_holder` is set by the NEW CORE at takeover (the operator only VERIFIES it); (v) the fence's SERVER-SIDE half is CONFIRMED, not assumed from pod termination (R4-14): the recorded stop-first sequence shows the bounded wait between the confirmed termination and the fence ending with ZERO live Postgres backends of the retired core (lease revocation killed its sessions), and the walk submits a statement designed to complete AFTER the exit — it dies undecided with the revoked session, is never accepted against a later `active_holder` epoch, and adds zero accepted stale writes; the wait is bounded (an overrun names the step in the report). Proves O2-2026, points 0/1/3, R4-14. | k3d walk `generations/stale-writes` (real Valkey and Postgres; a stale-credentialed core pod for the refusals, the current core for the positive commit; case (v) is the delayed-old-transaction cut — a session whose statement is still running in a backend at the retired core's termination, killed by the revocation and never accepted; case (vi) is the R5-03 evidence cut — the core pod's API object removed without observed process death, refused into maintenance with no successor and no fence). Proves O2-2026, points 0/1/3, R4-14, R5-03. |
| Q8 | Credentials by role, scoped by KIND (R3-17's method, carried, re-mechanized): (i) MODEL-KEY absence — the made-up model key's value appears in NO module pod's environment, data file or log; (ii) STORE-CREDENTIAL invisibility — OpenBao-issued Postgres/Valkey credentials appear in NO POD SPEC (`kubectl get pod -o yaml`: no `env` secret values, no `envFrom`, no secret volumes — N-7), in NO Kubernetes Secret object and therefore not in etcd (the walk lists the Secrets in the lifemodel namespaces and matches them against the credentials — none), no data file, no log, while VERIFIED PRESENT, positively, per role, in exactly the vault-env-wrapped module process environments the owner's policy names — every OTHER child process sees a SCRUBBED environment (the spawned-child fixture asserts the distinction); the pod's ONLY bootstrap material is its service account's projected JWT (Kubernetes auth — a walk case asserts no wrapped secret-id, no reusable token, no bootstrap material in any pod spec), and operator-rendered env would be a RECORDED POSTURE DOWNGRADE asserted ABSENT by default; (iii) PER-PROCESS zero (R4-05): the function host's WORKERD process holds NO credential of any kind and NO store connection (N-10 — its scrubbed environment asserted), the adapter process holds exactly its matrix row; the egress gateway holds Agent Vault plus exactly its matrix grants (N-9's positive path); the ingress gateway holds its matrix row including `send.settled`; nothing exists outside the per-process matrix; the operator alone holds the `+@admin`-class Valkey user and the cross-schema health role; (iv) identity needs NO certificate: a module's XADD on another module's command stream is refused by the Valkey ACL, and the sensitive surfaces are unreachable STRUCTURALLY (N-8 — no policy row, no route); (v) leases revoked ONLY for the RETIRED pod, AFTER its termination is confirmed (the recorded sequence shows revoke-after-confirmed-termination) — and the R4-07 ordering: a GATEWAY-ONLY rollout's lease set diffed against the pre-rollout state names exactly the two gateway instances, every unchanged module's lease survives untouched, and the old gateway's in-flight delivery completes on its own unrevoked lease. Proves O7-2026, points 0/3/4, R3-17, R4-07. | k3d walk `generations/credentials` (:1847 method + positive per-role assertions + ACL-refusal case + lease observations incl. vault-env's daemon-mode renewals + the pod-spec and Secret-object inspection); unit in the launcher: the grant manifest vs the OpenBao role definitions (N-11). |
| Q9 | Docker/cluster access confined (AMENDED — RBAC is the mechanism): NO Docker socket, CLI or `DOCKER_HOST` exists anywhere in the cluster; a module pod's service account grants NOTHING — any Kubernetes API attempt from it is refused by the API server and counted; the ONE named exemption is the Motor module's row: Jobs create/get/list/watch/delete in `lifemodel-motor` ONLY (pods + pod logs read there; the row is ALSO the panic's authorized sandbox-cleanup authority — Motor deletes its own running Jobs before the release's scale to zero, R5-09), every other verb or namespace refused; the OPERATOR is the only workload with cluster mutation rights (its RBAC row is the whole lifemodel mutation surface, build workloads included — R5-07); Motor's sandbox Jobs carry no mounts, no privileges, no bus or store route (their named network routes are P8 (proxy), P24 (Gitea HTTPS) and P27 (OpenBao token delivery)), and RBAC's gap — it authorizes the CREATE verb, not the Job's fields — is closed by the EXTERNAL guards (R5-09): `lifemodel-motor` is PSA `restricted`, and ValidatingAdmissionPolicies refuse a Job template or final post-webhook Pod that names another ServiceAccount, lacks `activeDeadlineSeconds`, lacks resource requests/limits or carries a non-ephemeral volume — the invalid-Job cases (privileged, hostPath, no deadline, foreign service account) are each REFUSED by the API server, counted in Motor's own log, and Motor's pre-submission validation refuses the same set first. The socket-proxy posture this replaces is B08's: RBAC is a reviewable chart-declared surface, and the blast radius is stated (the operator's rights are the cluster's widest mutation surface; the cheap guards are exactly as far as the owner asked). Proves O5-2026, points 3 and 4, B08's successor, R4-06's Jobs exception, R5-09. | Unit in the launcher: the chart's RBAC objects (Role/RoleBinding, the PSA labels, the ValidatingAdmissionPolicy) diffed against the RBAC table and the R5-09 Job rules — the assertion that a module service account's bound roles resolve to NOTHING and only the operator's and Motor's named rows exist. k3d walk `generations/no-docker` (in-pod `kubectl`/API attempts from a module pod and from a Motor sandbox — refusals counted; the Motor Jobs row exercised positively within its namespace; the R5-09 invalid-Job refusals (psa + VAP) exercised against the live API server; the socket/CLI/DOCKER_HOST absence asserted in every pod). The RBAC table's match to the ADR's posture is the human judgement below. |
| Q10 | Operator UI (Traefik, ForwardAuth): during normal operation, a rollout, and a rollback, the UI shows the current commit, each module's image tag and status, the rollout record phase, and the report of every switch/rollback; maintenance mode and the generation registry (commits, tags, epoch/version stamps, verdicts, reports) reachable from the same login; reports visible without shell access; no second control interface exists. At pinned `git.` host, anonymous Gitea UI/API is denied; an authorized owner can view a task PR; external URL/redirects are correct and Gitea login/provisioning works. Flux/operator/task Git traffic continues through authenticated internal Services, not public ForwardAuth. The owner's entry surface is exercised END TO END per R5-19: FIRST SETUP (set the operator's login password through the unguarded setup router while the bootstrap record shows setup incomplete), then the SETUP ROUTER'S CLOSURE (after the record completes, the same route is refused like any guarded one), KEY ENTRY (the model key pasted through the `vault.` host's ForwardAuth-guarded UI — the outcome-4 walk's "puts the model key into Agent Vault" on the new shape), ANONYMOUS DENIAL (every non-exception owner router — chat UI, submit, transcript, reply, operator boot/panic UI/API, and Gitea UI/API — answers an unauthenticated request with ForwardAuth denial, never content); authorized owner views a task PR through the pinned `git.` host; assert correct external URL and redirects, Gitea login/provisioning, while Flux/operator/task Git traffic uses authenticated internal Services, never public ForwardAuth. Then the MODEL CALL reaching the endpoint with the vault-injected key while no key sits in any module pod (the :1847 method). Proves F5, Q10, B0R-R09, R5-19. | k3d walk `generations/ui-during-switch` + the first-start fixture's setup/key-entry cases on the k3s shape (F7's walk); visual layout is the human judgement below. |
| Q11 — AMENDED | The k3s shape's window MEASURED, not bounded (R3-23's method, carried): a SYNCHRONIZED sampler records the AGGREGATE memory of the whole cluster's lifemodel set continuously through candidate build/start, the rollout and the per-pod termination overlaps; the peak AGGREGATE comes from simultaneous samples (never a sum of per-pod maxima); each pod's own peak reported separately (cgroup peak); the line items NAMED: the module pods (the two-generation overlap), Valkey, Postgres (CNPG), Traefik, OpenBao + the Bank-Vaults secrets webhook, the Flux controllers, the local registry, a BuildKit build pod, Agent Vault, the operator. BuildKit's build cost (CPU + memory inside the cluster's 2-CPU envelope) is measured with the same walk (open question 6). Also measured and named: stream/retention growth under the trim-floor rule, done-record and message-row growth, Motor sandbox Job volume retention, the REGISTRY's volume persistence/recovery recorded separately from image delivery (R5-08) — and the egress gateway's and Agent Vault's latency, concurrency and outage-recovery behavior under synthetic load, reported separately from tick latency (R3-20). A source check asserts NO operative dev-machine memory limit remains anywhere the module set runs. Proves O5-2026, points 2/4, R3-20/R3-23. | k3d walk `generations/peak-memory` (the synchronized sampler through the window + the BuildKit build measurement); source-scan in the launcher (operative-limit scan). |
| Q12 | Build + start + readiness: the two-commit reuse sequence builds ZERO images for unchanged modules and ONE per changed module (N-1); the commit-pair schema check's cost is TIMED separately at every rollout including the all-reused one (point 5 — reuse buys build cost, never a skipped check); changed-module build time inside `buildTimeoutMs` — the in-cluster BuildKit build is RE-MEASURED on the cluster's own 2-CPU envelope (open question 6); start + readiness + (function host) read-set bootstrap measured and named. The egress gateway's longest realistic sync call is MEASURED here to set its `terminationGracePeriodSeconds` (target 300 s, rendered `300` — open question 1); the measurement is recorded, and the grace invariant (N-5) holds against the measured value, asserted on the RENDERED pod field in one converted unit (R5-11). The BUILD WORKLOADS' RBAC is exercised under the OPERATOR's identity, positively and negatively (R5-07): the build Job the operator creates runs, pushes to the registry and is DELETED with its pod and cache after the tag lands (tracked cleanup); the same creation attempted in a namespace the operator holds NO Job-create grant in (`lifemodel-motor` — Motor's namespace, where the operator has no rights; `lifemodel-state` CANNOT serve as the refusal case — the operator's migration Job lives there by design, R5-07) is REFUSED, and the build pod's own service account holds NO rights (the existing no-rights case, Q9). Proves O1-2026, points 1 and 5, R5-07. | k3d walk `generations/timing` (timed phases + reuse assertion + the schema-check cost + the egress-call measurement + the operator-identity build/cleanup case and the wrong-namespace refusal — R5-07). |
| Q13 | Tick-only boundary: a review pass confirms no component writes tick state outside snapshot commits + bus events; EVERY span-tick item of inventory 2.2 appears in the design's event table AND its AsyncAPI document, or maps to one named durable mechanism (the delayed-event rows, the done records); no process timer holds a delayed event (the N-15 scan rule); all writers run post-commit. Proves O4-2026, point 4, Q13. | Named human judgement (below), backed by an executable rule: the fixture asserts stop-time processing goes through the same event path, and the delayed-event source scan (N-15). |

### The design's own checks

The N-numbering of the simplified shape is KEPT so the review record's
references stay resolvable; the assertions are content-neutral and the
mechanism nouns changed (the noun map after N-22).

| # | Check | Where / what runs it |
|---|---|---|
| N-1 | IMAGE REUSE BY CANONICAL BUILD IDENTITY (R3-18, kept): the same commit built twice creates no second image; a commit that changes one module builds exactly one image, other modules resolve. Tag = hash(canonical JSON of: context git tree id + the SELECTED Dockerfile's path and content + each named additional context's name and tree id + every admitted build option). A declaration-only change — Dockerfile selector A→B, a context rebinding, a build-option edit with an UNCHANGED context tree — changes the tag and builds a new image. No build args from the operator; bases digest-pinned; the build pod holds no credentials. | Unit in the launcher: the build ledger against the tag function, with the selector/rebinding/build-option cases; k3d walk `generations/timing` confirms on real images. |
| N-2 | COMMIT-PAIR SCHEMA CHECK AT EVERY ROLLOUT (point 5; closes R3-06 without admission records): the operator compares the RUNNING commit's and the CANDIDATE commit's schema FILES — the AsyncAPI documents + JSON Schemas, the snapshot format schema, the Postgres migration set — at EVERY rollout, regardless of how many images are reused; the check is bound to the COMMIT PAIR, not the image. A failing comparison refuses the rollout with the diff as the report; an all-reused candidate is still checked. NO admission record exists and none is needed. | Unit in the launcher: the checker against synthetic commit pairs (additive, breaking, reused-image cases). k3d walk `generations/timing`'s reused-candidate case. |
| N-3 | BUS CONTRACT FULL BOTH WAYS + TOLERANT READER (O8, R3-07's survivor): every payload change outside additive-with-default bounds is refused BIDIRECTIONALLY (old reads new AND new reads old — the mixed window); a breaking change is validated as a NEW event type beside the old; the reader rules are checked in BOTH directions at build: unknown event type → ACK + drop, counted, unless the consumer declared an EXCLUDE list; dual publication (old + new type) shares the minted effect key, so the destination's done record absorbs the second delivery — publish twice, apply once. CONTRACT RETIREMENT (R4-15): this milestone contracts NOTHING — the gate is expand-only, a deprecated shape is only marked; a TRIMMING candidate is refused with the diff as the report unless BOTH retirement arms hold: no commit the compatibility window could boot still consumes or produces the old shape, and no outstanding bus reference can still deliver under it (trim floor + no retained snapshot copy's pending list naming it). | Unit in the launcher (schema + reader-rule logic, no engines); a PR gate; k3d walk re-runs it inside the build (`generations/candidate-beside`). |
| N-4 | SNAPSHOT FORMAT: ADDITIVE, NEWER-REFUSES (O8, point 5): additive fields do not bump the format version (no conversion step exists in either direction); a NEWER format version refuses loudly at the new core's self-check, BEFORE serving anything; the refusal reason names the version pair. | Unit in the launcher: the version/acceptance fixtures (positive: additive read by the older reader; negative: newer refused) against the snapshot schema. k3d walk: the refusal case inside `generations/maintenance-boot-older` and `generations/rollback-unhealthy`. |
| N-5 | CALL-MANIFEST TIMEOUT AND CLASS CHECK (simplification point 2): every sync call declares a timeout per destination in the module's call manifest, with its keyed/unkeyed class; a call without a declared timeout FAILS THE BUILD; the build check `terminationGracePeriodSeconds >= the module's longest declared timeout` holds — read out of the RENDERED pod field (the chart's ms input converted once, compared in ONE unit, R5-11), never out of literals (the invariant, not the number, justifies the egress gateway's grace — the measured value sets it, open question 1). NO unbounded sync call exists in any module's source. | Unit in the launcher: the manifest checker (missing timeout, missing class, grace-violation cases; a manifest with no delivery-to-result bound, or one below its longest call) + a source scan for undeclared sync calls; the R4-02 bound is part of the same manifest check (N-13's min-idle invariant is verified against it). The R5-11 pairing: the unit renders the chart, asserts the rendered `terminationGracePeriodSeconds` integers (300/30, the core's ≥ 5), and FAILS a chart whose ms input converts SHORTER than the deadline or timeout it must cover — the wrong-unit or bad-rounding case is a refusal, never a silently accepted same-unit-looking inequality. k3d walk `generations/candidate-beside` (a violating candidate fails before any pod). |
| N-6 | SQUAWK EXPAND-ONLY MIGRATIONS (point 5, O8): the migration set bans drop/rename of column or table, type change, NOT NULL without default; the OPERATOR applies the candidate's NEW migrations BEFORE replacing any module — as a migration JOB it creates in `lifemodel-state`, run under the DDL role separate from every module role, recorded in the rollout record — the running old code tolerates the expanded schema by construction. | Unit in the launcher: the squawk lint run over the migration set; k3d walk `generations/candidate-beside` asserts the migration Job ran under the DDL role before the first replacement, and no module role holds DDL. |
| N-7 | SECRET DELIVERY INVISIBLE (kept, re-mechanized): after a module pod starts, its SPEC carries NO credential material — `kubectl get pod -o yaml` shows no `env` secret values, no `envFrom` references, no secret volumes, nothing in etcd-backed Kubernetes Secrets (the webhook's vault-env resolves the pod's secret references inside the container at start and stays the process's parent); the made-up-key check covers every module's pod spec AND the module processes' environments; no wrapped secret-id or reusable token exists anywhere (Kubernetes auth's only bootstrap material is the service account's projected JWT). | k3d walk `generations/credentials`. |
| N-8 | THE NAMESPACES ARE DEFAULT-DENY EGRESS (kept, structural, re-mechanized from the internal networks; the platform's own traffic NAMED — R5-05): from inside a plain module pod, an attempt to REACH an outside address fails (TCP); name resolution rides the cluster-DNS row (P17) and ONLY CoreDNS answers — no external resolver and no direct DNS-to-the-world row exists for a plain module; `kubectl get networkpolicy -A` shows EXACTLY the design's P1-P32 rows (P23 is removed) and nothing else — a module cannot reach a surface it has no row to, by ABSENCE of a route (unreachability, not a refusal); the only world-facing surfaces are the rows that name them: the egress gateway (P4, P5 to Agent Vault; the optional Gitea mirror's outbound traffic arrives through P26 and exits only via this gateway), BuildKit's base-image rows (P14), Flux source-controller's signed OCI fetch on TCP 443 to `ghcr.io`, `pkg-containers.githubusercontent.com`, its configured token endpoint, `tuf-repo-cdn.sigstore.dev` and `rekor.sigstore.dev` (P15), Agent Vault's own outbound leg (the egress path's LAST hop — its named row), Traefik's LoadBalancer (the ONLY published port — the Vault UI and Gitea's pinned `git.` host are ForwardAuth-guarded routes with anonymous UI/API denial and authenticated owner PR viewing; correct external URL/redirect and Gitea login/provisioning are exercised, while Flux/operator/task Git clients remain on authenticated internal Services, R5-19); the Motor sandbox namespace holds the proxy path (P8) and one named internal exception to Gitea's HTTPS port (P24) for clone/task-branch/PR only, plus P27 to OpenBao solely for vault-env task-token delivery — no bus or store row. The check exercises every named row positively, INCLUDING the platform rows the bootstrap needs — store issuance (P18), the Kubernetes-auth TokenReview (P19), admission webhooks (the Bank-Vaults secrets webhook + CNPG), route discovery (P20), CoreDNS (P17) — and states the node/API exceptions the rows cannot filter in the walk output; sensitive paths (plain module → Gitea, operator, registry, BuildKit, Agent Vault, another namespace) and unauthorized mutations are tested negatively; sandbox-to-Gitea is tested positively only for its named P24 exception (the module API attempt is refused by RBAC and counted — Q9). | k3d walk `generations/internal-egress` (attempts from the module set + policy inspection + the named rows exercised positively — the Flux signed OCI fetch and online TUF/Rekor verification (P15), the sandbox's proxied fetch and P24 Gitea access, the Gitea mirror's P26 route through the egress gateway, the vault's outbound hop, the BuildKit push, a store credential issued end-to-end through P18, a module login through P19, a route resolved through P20 — with every other attempt failing unreachable). |

| N-9 | IDENTITY BY STREAM AND THE EGRESS CHOKEPOINT (points 3 and 4; the PER-PROCESS grant matrix, R4-05): a process's Valkey ACL grants XADD on ITS OWN stream ONLY (producer-side identity — consuming another module's stream grants nothing) — an XADD on another module's `cmd.egress.<module>` stream (or on `inbound`, or on the bus's producer-only entries) is refused and counted; the POSITIVE path is tested for EVERY granted endpoint in the matrix (R4-05): the core reads `inbound` (plain read, its offsets riding the snapshot), the egress gateway consumes each `cmd.egress.<module>` stream in group `egress` AND publishes `http.result` on the bus, the ingress gateway publishes `send.settled` after its insert-by-key, the adapter produces `cmd.state` (`bootstrap.request` included, R4-04) and publishes the function's declared `signal.<kind>` on the bus, Motor publishes `motor.result` on the bus, the adapter reads its own `state.bootstrap.<self>` and the core produces those instance-addressed streams — a required endpoint MISSING from the matrix or refused at run time FAILS the check, not just an undeclared excess; the egress gateway derives the caller from the stream name (verified origin, not a header) and refuses AND LOGS requests outside the module's policy; the egress gateway is the ONLY pod with a world route (P4) and the ONLY module that reaches Agent Vault (P5); the command-stream set matches the module set exactly. | Unit in the launcher: the PER-PROCESS grant matrix (process → its consume + produce + schema grants, positive-path assertions every required endpoint resolves, plus the refusal cases; the egress gateway's policy table). k3d walk `generations/internal-egress` (cross-stream refusal, required-endpoint success, policy refusal + log record, vault reach only from the egress gateway). |
| N-10 | THE WORKERD PROCESS CARRIES NOTHING; THE ADAPTER PROCESS CARRIES EXACTLY ITS MATRIX ROW (point 4, O7; per-process zero, R4-05): the caption is per PROCESS — the function host's WORKERD process holds NO credential, NO store connection, NO socket, NO grant of any kind (the spawned-child fixture asserts its environment is scrubbed of every OpenBao-issued value; vault-env execs only its own module process — workerd is a separate process whose environment the pod spec keeps credential-free), while the adapter process of the same pod holds EXACTLY the adapter row of the per-process matrix (N-9: consume `adapter`, produce `cmd.state`/its own `cmd.egress.<function-host>`, its own schema) and nothing beyond it; the pod spec names both processes and their distinct environments; function sources contain no store client (image/source surface asserted); everything a function receives arrives inside the adapter's delivery envelope. | Unit in the launcher: the pod/process spec builder (two named processes, distinct environments) + the adapter grant set vs the matrix + the fragment/source lint (with N-14's fragment check). k3d walk `generations/credentials` (the workerd process's scrubbed-environment case AND the adapter's positive grants) and `generations/no-docker`. |
| N-11 | POSTGRES SCHEMA GRANTS AND NATURAL-KEY IDEMPOTENCY (points 0/5, O4/O5): every module's OpenBao role holds rights ONLY on its own schema (the CNPG declarative role), PLUS exactly the two named narrow grants (the ingress gateway's SELECT on the transcript + INSERT-by-key on `conversation_message` in the core's schema; the operator's cross-schema health reads); a write attempt on ANY other module's schema is refused (NOPERM) and counted; every keyed apply is idempotent by NATURAL key (a same-key re-apply changes nothing); the generic `applied(key, epoch)` table exists ONLY where no natural key can be minted, written in the same transaction as the change it admits (a review-level refusal: no new one where a natural key exists); the Motor module's registry lives in Motor's OWN schema (point 4); the DDL role — the migration Job's only identity — is the only writer of schema; the GRANT surface is the MIGRATION SET's (GRANT/ALTER DEFAULT PRIVILEGES over the CNPG-managed NOLOGIN group roles, R5-16), checked positively and negatively: a newly migrated table is usable by a NEWLY ROTATED login of its module (positive), and any cross-schema access is refused (negative, NOPERM, counted). | Unit in the launcher: the grant manifest vs the CNPG/OpenBao role definitions + the idempotency units against synthetic rows; the R5-16 unit diffs the migration set's GRANT SQL against the declared group-role set (an ungranted new table fails the build). k3d walk `generations/credentials` (the cross-schema refusal case, NOPERM, counted; the R5-16 pair — new table × rotated login positive, cross-schema negative). |
| N-12 | KEYED-JOB RULES (point 2): stable effect ids — a replayed turn re-issues its pending effects with the ids PERSISTED in the deciding tick's commit (never re-derived); XACK only after the result is recorded; the done record by key is ADMITTED in `in-flight` BEFORE dispatch — a same-key atomic insert, a re-delivery can neither overwrite it nor mint a second one — and UPDATED after the effect applies, in the CONSUMER module's OWN schema; destination classes `keyed`/`unkeyed` per command type, `unkeyed` explicit in the manifest (undeclared = build failure, N-5); an ambiguous `keyed` attempt recovers through its contract (the web reply's insert-by-key row is the model); an ambiguous `unkeyed` attempt records `uncertain`, reports, and NOTHING re-delivers it automatically — the report is the owner's re-issue surface; done records and pending effects are pruned ONLY after their settlement is committed in a snapshot AND no re-issue path remains (a live PEL entry, an undelivered command entry, a parked delivery, a retained snapshot copy naming the key — R4-10): settlement alone never permits pruning, the record is the tombstone the redelivery dedups against; time never prunes an unsettled record, and maintenance holds pruning entirely. | Unit in the launcher: the crash-cut matrix (the five cuts) against synthetic done records + the replay-id assertion + the pruning rule (an unsettled record survives retention; the R4-10 pairing — a result published, XACK pending, then the core settles and the normal pruning opportunity arrives: the record SURVIVES while the PEL entry lives, and a redelivery against the tombstone is a no-op; after the last re-issue path ends the record is pruned). The R4-01 cut pairing: death BEFORE the admission (no record) → the re-issue delivers once; death AFTER dispatch, BEFORE the completion write → a recovered unkeyed attempt is recorded `uncertain` and reported, never automatically dispatched again, and a recovered keyed attempt completes under the same id. k3d walks `generations/holder-crash` (the cuts) and `generations/switch-messages` (an ambiguous keyed effect recovered, never delivered twice). |
| N-13 | XAUTOCLAIM TAKEOVER (point 2): the claim's min-idle sits ABOVE every module's declared delivery-to-result bound (queue + call + parked wait, R4-02) — the operator checks the invariant against the manifests at every rollout and refuses to start a rollout whose manifest violates it (open question 2's setting); min-idle is NOT a live-consumer fence: a live consumer's entry may be claimed only PAST its declared bound, and the same-key `in-flight` admission makes that outcome deterministic (R4-01); a RETIRING consumer's entries are reclaimed on the operator's CONFIRMED-POD-TERMINATION signal, never by the idle clock alone; a dead consumer's pending job is claimed by another instance of the SAME module and re-runs under the SAME effect id (the done record dedups). | Unit in the launcher: the invariant calculation (min-idle vs the declared bounds, violation refused) + the takeover state machine (the termination-authorized reclaim; the past-bound live claim's deterministic outcome). k3d walk `generations/job-takeover` (a killed consumer's entries claimed and settled once; a slow-but-live consumer's entries NOT claimed within its declared bounds; a PAUSED consumer and a PARKED delivery taken past the bound — the R4-02 pairing — the outcome deterministic, never a blind re-dispatch). |
| N-14 | THE ADAPTER CONTRACT (R3-10, carried): a function's AsyncAPI fragment declares ONLY its signal outputs, the four command forms (`state.set`/`state.delete`/`schedule.set`/`schedule.cancel`), a bounded read set, and — where needed — a declared `tool.request` form; an undeclared one fails the build like any undeclared call (N-5's rule at the fragment level); the projection version is CONTENT-DERIVED, so an unchanged re-publish carries the SAME key (the adapter's cache value does not change) and two distinct updates of one key produce two distinct versions; ORDER is the applier's MONOTONIC position — the adapter applies a packet only at a position greater than its consumed watermark for the key, so a claimed old packet can never regress a newer repair (R5-13 — content hashes decide equality, never order); the ADAPTER's readiness REQUIRES its declared read set complete (the owning module's bootstrap projections present per `(module, projection)`) before its function leg serves a delivery — a function never sees an empty read set (bounded by `readinessWindowMs`); the repair is REQUESTED by every fresh adapter instance from the CURRENT durable rows over the bus (a keyed `bootstrap.request` on `cmd.state` carrying its instance id, answered on `state.bootstrap.<instanceId>` — a DEDICATED stream consumed at the instance's OWN position, which no group competitor can drain during an old/new overlap (R5-13's lighter mechanism); until the retiring instance's confirmed exit the applier appends every subsequent projection change to the same instance stream, and the stream is trimmed only after the fresh instance CONSUMED THROUGH the applier's head — the watermark barrier, so a crash before the handoff completes resumes from the recorded position and loses nothing) — NOT gated on the owning module's activation, NOT dependent on retained projection events a predecessor already ACKed and trimmed, and a predecessor-PEL claim runs only after the repair completes (a claimed pre-repair packet for a repaired key is dropped, counted) (R4-04); a correlated `tool.request` is held un-XACKed in the adapter's PEL, published as a keyed `http.request` on the function host's OWN command stream, and re-invokes the function on `tool.result` under the SAME effect id — two invocations, not a session; a parked delivery counts as an outstanding reference in trimming (N-21); the adapter XACKs a delivery ONLY when the function answered, or after the bounded retry budget (`functionDeliveryRetryBudget`) ended unavailable — a dropped poison delivery, counted and reported, never silent; a crashed invocation re-delivers, and the re-run's output carries the input's idempotency key. Reminder's schedules arrive as `schedule.set` commands for the SAME schedule rows the tick's scan advances — no parallel scheduler anywhere. | Unit in the launcher: the fragment check, the projection-cache/dedup logic, the readiness barrier, the ack rule against synthetic deliveries. k3d walk `generations/function-state` (a function-created reminder survives a switch — row in the core schema, fires once, projection re-published and re-read; a crashed HTTP invocation re-delivers without a lost or duplicated state transition; a web-search tool round trip rides the correlated routing; R4-04's paired cuts — a HOST-ONLY replacement whose core is unchanged and NOT restarted, a sole-adapter RESTART (an in-place restart is a fresh adapter bootstrapping from the current rows), and an OLD/NEW ADAPTER OVERLAP (the retiring pod still consuming group `adapter` while the fresh one repairs: BOTH reach a complete declared read set through the instance's own-position stream; the R5-13 handoff cuts — a projection change published EXACTLY at the old instance's confirmed exit reaches the fresh cache through the barrier, a fresh-adapter CRASH at the old-exit handoff loses NO change: on restart it resumes from its recorded position past the not-yet-trimmed stream, and a claimed pre-repair packet with a stale position is dropped, never applied backward; the OVERLAP FAN-OUT cut — while BOTH instances serve (old in group `adapter`, fresh on its instance stream), a projection change delivered to the group and won by the FRESH instance still reaches the OLD cache through the dual append, and the walk asserts BOTH live caches carry the change after the overlap window — never only the fresh one (R5-13)) — each reaches a COMPLETE declared read set before its function leg serves a delivery, and an unanswered `bootstrap.request` past `readinessWindowMs` is a failed readiness, never an empty cache served). |

| N-15 | DELAYED-EVENT DURABILITY AND THE SCHEDULE FIRE/ADVANCE PAIR (R3-14, carried; principle 7): a delayed event is a delayed-event ROW written by the core's applier in the SAME keyed-apply transaction as the schedule advance; the core's scan produces `delayed.fired` when due — the same fire-exactly-once pair as a schedule fire (`fireId = scheduleId:nextFireAt-ms`); the emit IS the outbox: a redelivered command hits the fireId record and only the signal side re-runs; a fire event lost after the advance is re-produced by the schedule reload (`nextFireAt <= now` fires as seen); a switch or crash before the due time loses nothing (the row is current data the next holder's scan picks up); a source scan finds NO `setTimeout` in the applicator's schedule path and no process timer holding a delayed event anywhere. | Unit in the launcher: the scan/advance state machine against synthetic rows + the source scan. k3d walks: a delayed event across the switch in `generations/switch-messages` (fired once by the new core, never by the old) and crash-before-due in `generations/holder-crash`. |
| N-16 | PER-MODULE HEALTH CLASSIFIER (R3-12, amended by point 1 — per module, not one generation-wide verdict): health reads the module's OWN durable records (its done records, read by the operator with its health role) — never a live pod alone. ROLLING failure window (`healthFailureWindowMs` 60 000), never lifetime-since-activation: N consecutive LOCAL failures with zero settled jobs WITHIN the window fail the module — one success then a wedge is caught (the unit asserts the rolling and lifetime predicates DISAGREE on that input). A failure classified UPSTREAM (remote refused/unreachable/rate-limited, recorded on the done record) is counted separately, never against the module. A long-running or parked job counts NOTHING: the exclusion proof is DURABLE EVIDENCE — its live PEL entry or its parked un-XACKed delivery — past whose bounds the XAUTOCLAIM/retry machinery re-runs it and the outcome counts like any other. AGED OUTSTANDING DEMAND with no progress fails the window (R4-03): demand older than the module's declared delivery-to-result bound (unread `cmd.<module>` entries from the bus entry age, claimed PEL entries, parked deliveries) with no settled job, no local failure and no claim/ack movement is a SILENT wedge behind a green probe — the exclusion proofs hold only within the declared bounds, and a module whose declared bound exceeds `healthWindowMs` has its window EXTENDED to that bound, so demand arriving at the window's start ages past the bound INSIDE the window and the two silent-wedge cuts below are never accepted at the 120 s mark (R4-03). No idle demand: a module with no work in the window is HEALTHY. A STATIC chart-component outage (observed on the operator's own connections) HOLDS the window's clock and marks failures infra-attributed; an outage past the window ends BROKEN-INTO-MAINTENANCE with the outage named — never a rollback of healthy code onto a broken store. Core additionally: first commit within `firstCommitDeadlineMs` 30 s, liveness gap 15 s; ingress gateway additionally: the readiness probe exercises the ACCEPT path (`inbound` length grows). | Unit in the launcher: the classifier (local/upstream/idle/hold matrix, the rolling-vs-lifetime disagreement fixture, the exclusion-evidence rules). k3d walk `generations/whole-health`: the wedge cases — a keyed consumer whose jobs all fail locally, a wedged function host, a wedged egress gateway (the core keeps committing ticks throughout, the module still fails); an upstream-failure burst that NEVER fails the window; a Valkey outage that holds the clock and ends in maintenance with the outage named; a failed send counted as failure evidence while a deliberate silence counts as the inbound positive; the R4-03 wedge cuts — a consumer with an UNREAD BACKLOG past its declared bound (no PEL entry, no outcome) and a consumer holding a CLAIMED delivery that produces neither result nor failure past the bound — both FAIL the window, and the kept exemptions assert GREEN: an idle module, an upstream-failure burst, an infra outage that holds the clock; the R4-03 window-extension cut — a module with a 300 s declared bound whose wedge demand (an unread backlog, then a claimed delivery with neither result nor failure) arrives at window start fails at bound expiry INSIDE its extended window, never accepted at the 120 s mark, while a legitimate parked call still within its bound stays GREEN in the same window. |
| N-17 | SERVICE CUTOVER ORDERING (R3-15, carried, re-mechanized from Caddy aliases): the recorded switch/rollback sequence shows a leaving ingress pod's Service endpoint removed only by its readiness drop / termination — removal never precedes the stop it implies (Endpoint membership follows pod readiness; per-request resolution, no stale list, no reload); the root-host surface is the ingress Service's whole (the core holds no front route, R4-06), and a core replacement moves no Service at all; a POST whose server-side write succeeded but whose HTTP response was lost retries with the SAME idempotency key against the moved route and is absorbed by the inbound dedup ring, never answered twice; Traefik's security surface holds (pinned hosts, ForwardAuth to the operator, no admin dashboard exposed). | Unit in the launcher: the Service/Endpoint ordering against the recorded switch record (the endpoint-leaves-only-at-readiness/termination invariant). k3d walk `generations/switch-messages` extended with the persistent-connection and lost-HTTP-response cases. |
| N-18 | LEASE LIFECYCLE (R3-16, carried, re-mechanized): NO pod spec carries a persisted reusable bootstrap — the pod's ONLY bootstrap material is its service account's projected JWT, consumed by a FRESH Kubernetes-auth login at EVERY process start (vault-env's login; an in-place container restart re-authenticates and re-issues fresh leases — no operator action, R4-08's replacement of "no restart policy"); a renewal outage: a lease issued before the outage serves its TERM, and expiry is enforced LOCALLY (R5-20) — the supervising agent (vault-env in daemon mode, the R5-04 owner decision) tracks each lease's issue time + term and stops the supervised work VISIBLY at the deadline (a renewal failure past it is a nonzero exit naming the expired lease — vault-env exits and Kubernetes restarts the container; the restart re-authenticates when Bao returns) — because a module's live PG/Valkey session does NOT expire merely because Bao is down and server-side revocation is unavailable, the local deadline is the expiry mechanism; a module whose lease expires during the outage fails VISIBLY, counted, re-bootstrapped when Bao returns; issuance is STAGGERED by `leaseIssueStaggerMs` (no synchronized module-set rotation in the steady walk); a lease reaching max TTL (7 days) changes the credential and vault-env exits so Kubernetes restarts ONLY the affected container (a renewal that lands does not); an old session's revocation/expiry is observable (lease metadata + the store's connection list); revocation is PER RETIRED POD at its CONFIRMED termination, never before the replacement started — a gateway-only rollout's lease diff names only the two gateway instances and no unchanged module's lease moves (R4-07). | Unit in the launcher: the re-authentication branch (a fresh login per start, no persisted material in any pod spec) + the revoke-after-confirmed-termination ordering against the recorded switch sequence. k3d walk `generations/credential-rotation` (the cases above; the R5-20 cut — Bao taken DOWN past a lease's expiry while a PG/Valkey session is ALREADY OPEN: the module's work stops at the local deadline with the expiry named, the open session's fate observed in the store's connection list, and work resumes by re-authentication when Bao returns — the cut reads the module's stop, never only lease metadata after Bao is back) and `generations/credentials` (the gateway-only lease-diff assertion). |
| N-19 | CLEAN BOOTSTRAP DAG AND ONE COMMAND (R3-19; R5-06/R5-08/R5-18; R6-05/R6-06): on a clean dedicated VM the single command installs only k3s, Flux and the pinned root OCIRepository + Kustomization. The installer-bundled root manifest selects the verification policy: keyless `matchOIDCIdentity` (default; issuer `^https://token\.actions\.githubusercontent\.com$`, subject `^https://github\.com/shady2k/lifemodel/\.github/workflows/release\.yml@refs/tags/v.*$`) or key verification through `secretRef` to a public key; unsigned, tampered, wrong-identity/key and wrong-digest artifacts fail before application. Flux installs the signed platform, including loader and Gitea 12.7.0 with SQLite/PVC. The loader's idempotent recorded first-start phases are OpenBao init once, custody write/read-back, unseal; admin Secret creation and chart-driven account verification; same-release seed and repository identity verification; branch protection verification; read-only Flux credential creation; then creation and reconciliation of the second Gitea deploy-branch source. First generation is permitted only after the second source is healthy. Cuts before and after every external action and durable checkpoint, followed by process/Pod restart, prove recorded-phase resume without reinitializing Bao, overwriting the repository, duplicating accounts/tokens, or deleting a chart/source-referenced Secret. For Bao init-success before custody persistence, assert visible owner recovery, no second init, and no assertion of automatic credential preservation. R6-05 asserts the referenced-secret deletion guard; R6-06 asserts Gitea and the entire platform remain owned by the signed platform layer. Candidate/rollback attempts against Gitea, the platform OCI source/pin, its chart/releases, policies, routes, PVCs, namespaces, CRDs or other cluster-scoped resources are refused before mutation. No long-lived installer credential exists. | Manual acceptance check on the owner's test VM, run by the coordinator over SSH: `generations/clean-vm-install` exercises actual k3s → Flux → signed source → platform up → loader first start → second source → first generation, including reboot and every phase cut; k3d `generations/clean-bootstrap` tests the state machine only. Unit tests validate OCI verification matcher, exact source scope and candidate ownership refusal. No existing-cluster check or walk is in this milestone. **Pending the manual acceptance check on the owner's test VM.** |
| N-20 | SNAPSHOT COPY RULES (point 6, O3): a copy is taken ONLY at a core replacement — by the operator right after the old core committed its final tick and its termination is CONFIRMED (and the bounded backend drain finished, R4-14), the point the new core starts from; other modules' replacements take no snapshot COPY and replace no core instance (the gateway-only walk asserts NO COPY was taken, the core's epoch/instance unchanged, and the core's tick commits CONTINUED through the rollout — never byte equality of the live snapshot, which keeps advancing, R4-16); NO AUTOMATIC PATH RESTORES A COPY (R5-12): the never-ready fallback, the ready-failure fallback and every rollback hydrate the LATEST CURRENT snapshot on CURRENT data — a copy taken at a core replacement is a named observation point, never a hydration source; copies are identified (`copy-<commit>-<epoch>`) and IMMUTABLE, the last `snapshotCopyRetention` 3 kept in Valkey; a restore is MANUAL, MAINTENANCE MODE ONLY, NEVER while any module serves, NEVER automatic — it first checks the copy's snapshot schema is readable by the CURRENT core (the point-5 rule), that the copy's recorded bus position is not trimmed, AND that every pending effect the copy names still has its done-record proof in the current schema — a copy whose required proof was pruned is REFUSED with the reason (R4-10; the pruning rule keeps records referenced by retained copies, so the refusal fires only on records pruned before this rule or lost); a restore puts the instance at the COPY INSTANT WITHOUT touching the bus (R4-12: no truncation, no rewind — the SNAPSHOT alone is replaced), retained entries after the copy instant replay under their keys (accepted-but-unprocessed inbound and no-done-record commands re-deliver normally; done records settle duplicates), and only entries the retention already trimmed are lost, listed in the report as unreconciled from the later done records where one exists; Postgres is NOT rolled back — replayed state settles against current rows by natural key, replayed inbound entries and pending effects settle from the current done records / message rows; NO snapshot+PG stamp pair exists; a FULL backup (PG dump + Valkey copy) is an OWNER-COMMANDED maintenance action only, never part of a switch or rollback (CNPG's declarative backup config is the owner's, outside this machinery). | Unit in the launcher: the copy-identity/retention calculus and the refusal rules (unreadable schema, trimmed position) against synthetic copies. k3d walk `generations/snapshot-copy-restore` (a switch → later advance → maintenance restore → serving; the refusal cases; an old-copy restore attempted after a NORMAL pruning opportunity — with the retained-reference rule the restore succeeds on kept tombstones, and a deliberately pruned proof is refused with the reason — the R4-10 pairing; the R4-12 pairing — a restore KEEPS the bus (asserted: zero stream entries deleted, none rewound) and retained post-copy entries REPLAY under their keys, with an accepted-but-unprocessed inbound message reaching the answered-exactly-once contract through the replay; the owner-run backup as a separate coordinated capture). |
| N-21 | FSYNC ACK BOUNDARY AND TRIM FLOOR (R3-21, carried): `appendfsync-always` is the ACK boundary in BOTH directions — the ingress gateway answers HTTP 202 only after its fsync'd XADD, and a stalling fsync (disk pressure, AOF rewrite collision) or disk exhaustion is a VISIBLE failure: the caller's command refused (non-202), the core's commit PAUSED (unavailability reported) — never an accepted write later unaccounted; disk exhaustion is treated as a static-infrastructure outage (N-16's hold → maintenance with the outage named); TRIM eligibility = the MINIMUM SAFE OFFSET across ALL consumer groups AND no outstanding reference (a claimed job's input entry, an unsettled pending effect's done record, a parked un-XACKed delivery) — never the core's progress alone; consumer groups are DURABLE (Q6's restart rules). | k3d walk `generations/valkey-restart` extended with the failure-pressure cuts: the fsync stall (non-202 + paused commit + the retry with the same key landing exactly once), disk exhaustion (maintenance with the outage named), the trim floor (a slow consumer's and a parked delivery's entries survive trimming). |
| N-22 | DRY READINESS SUPPRESSES EVERYTHING (Postgres rules; F2's readiness definition): a module's dry self-check emits NO command, writes NO done record, advances NO schedule, makes NO egress request — effect suppression at readiness is total, WITH ONE NAMED EXCEPTION (R4-04): a fresh adapter's keyed `bootstrap.request` into `cmd.state` and the applier's instance-addressed answer packets on `state.bootstrap.<instanceId>` are the readiness's own REQUIRED material — they write no done record, advance nothing and carry no function effect, and are excluded from the zero-write assertions; the function host additionally serves no delivery until its declared read set is complete (N-14's bootstrap barrier). | Unit in the launcher: the suppression rule against the self-check path. k3d walk `generations/switch-happy` asserts zero stream entries, rows and schedule advances attributable to every module's readiness phase EXCEPT the R4-04 exception (asserted PRESENT for a replaced function host, absent for every other module's readiness). |

### The mechanism noun map (the simplified shape's check set, carried)

Every N-check above is the SAME assertion as the Compose shape's, with the
platform's nouns:

| Was (Compose/Docker) | Now (k3s + GitOps) |
|---|---|
| the loader builds via the socket proxy (N-1) | the operator's rootless BuildKit pods push to the local registry (N-1) |
| `docker inspect` / container exit confirmed by the loader | confirmed POD TERMINATION — observed (`kubectl get` / the watch), never assumed, A12 |
| Caddy `internal: true` networks + alias membership | namespaces + NetworkPolicy rows P1-P32 (the platform's own traffic included, R5-05); Service Endpoint membership follows readiness |
| socket-proxy verb allowlists (R3-19's N-19 half) | the chart's RBAC objects (Role/RoleBinding per principal) |
| wrapped single-use AppRole secret-ids, envconsul agents | Kubernetes auth (the service-account JWT) + the Bank-Vaults secrets webhook's vault-env in daemon mode (process parent, lease renewal, exit on renewal failure or change) |
| `stop_grace_period` / `deploy.update_config.order` | `terminationGracePeriodSeconds` / the strategy + updateStrategy fields, chart-declared |
| the healthcheck / `intake-ready` pool | the readiness probe / the whole-surface Service's Endpoint set |
| container restart policy absent (R4-08's no-revival rule) | in-place pod restarts ARE fresh bootstraps; new code only by operator rollout; panic/maintenance scale-0 revives nothing |
| panic.json + fsync/rename/dir-sync record durability | Flux suspend + scale to zero (durable cluster state) + rollout records as cluster resources, write-and-read-back-complete (the installer-selected embedded etcd's replicated-log write-through — R5-18) |
| `docker compose up -d` (one command) | k3s + Flux + pinned signature-verifying platform OCI source; loader first-start initialization adds the application source; dedicated-VM walk only |

### Checks the platform decision removed (and what absorbed their requirement)

The simplified shape's check set needed no REMOVAL — every removed
MECHANISM's check was already re-mechanized in the noun map above. Two
checks changed ASSERTION SHAPE with the platform, named here because their
old form cannot be re-run at all:

| Changed check | Why the old form died (platform decision) | The requirement now lives in |
|---|---|---|
| Q9's no-Docker walk (socket/CLI/DOCKER_HOST absence + proxy unreachability) | there is no Docker anywhere in the cluster to confine — the sockets and proxies do not exist | N-8 (NetworkPolicy rows), Q9 (RBAC: module service accounts grant NOTHING; the API server refuses and counts; the one Motor Jobs row), F8's invariants |
| The B08 human judgement over both proxies' pinned verb allowlists | no socket proxy exists; the allowlist duty (R3-19) died with it | the RBAC table (chart-declared, reviewable in the commit); the human judgement below reviews THAT surface |

### Human judgements

| Judgement | Who | How |
|---|---|---|
| The RBAC table matches the ADR's stated posture (the operator's row is the WHOLE lifemodel mutation surface; Motor's row is the ONE module exception; module service accounts resolve to NOTHING) | The reviewer of the PR that carries the chart's RBAC objects | Read the chart's Role/RoleBinding set against the design's RBAC table and the ADR's operator/motor rows; record the verdict in the PR description. |
| The workerd engine driver's generated config matches the manifest-derived shape the ADR promises (ONE driver in the operator; egress routing and bus I/O OUTSIDE the function) | The architecture reviewer each milestone | Read the generated config against the driver contract; note gaps as findings. |
| Q13's review pass: no mid-tick writers, the inventory-2.2 conversion set maps 1:1 to the event table + the named durable mechanisms, and the AsyncAPI documents match the event table | The architecture reviewer each milestone | Walk the inventory 2.2 list against the design's event table, the AsyncAPI documents and the tick code; note gaps as findings. |
| The EGRESS GATEWAY's `terminationGracePeriodSeconds` value: the measured longest realistic sync call set against the 300 s target (open question 1 — the measurement is Q12's walk; the DECISION to accept the measured value is the owner's) | The owner at milestone acceptance | Read the `generations/timing` measurement; set the chart value or file the gap. |
| UI layout/readability of the rollout records and reports (Q10's visual aspect) | The owner at milestone acceptance | Open the UI during a staged rollout; accept or file findings. |
| The k3d walk set's final membership (which `generations/*` cases are PR-gating vs milestone-acceptance on the shared cluster budget — the ADR's open question 7, decided HERE in the intro, refined per walk's cost at the first run); the clean-VM check remains a manual acceptance check on the owner's test VM, not a PR walk | The owner at milestone acceptance | Read the first full walk run's timings; move cases between the PR set and acceptance set or file the gap. |
### Round 7 second-pass decision (R7-01) — application apply topology and ownership

There are exactly two application Kustomizations, one in each target
namespace (`lifemodel`, `lifemodel-motor`), not in `flux-system`. Each
Kustomization's `serviceAccountName` names the platform-created applier in
its own object namespace, and its target namespace is that same namespace.
The platform release creates a deploy-branch GitRepository in each target
namespace; the loader writes that namespace's read-only credential Secret.
Kustomizations reference only their local source. The sole allowed
reconciler edge is Kustomization -> same-namespace HelmRelease; the
HelmRelease independently uses its same-namespace applier and chart path in
the local GitRepository. Cross-namespace refs stay disabled.

The platform release declares each namespace's applier ServiceAccount, Role
and RoleBinding. The Role grants only the enumerated application-owned kinds
plus get/list/create/update/delete on local Helm release-storage Secrets
(`helm.sh/release.v1`); admission constrains Secret access to that storage
type. Application-owned kinds are only Deployments, StatefulSets, Services,
ConfigMaps, module HelmReleases and Motor Job templates, and only in those
two namespaces. The signed platform release owns NetworkPolicies, all RBAC
(including ServiceAccounts, Roles and RoleBindings), PSA labels, admission
policies, applier accounts and GitRepositories. These are immutable to
generations. Rollback never restores or changes them.

### Round 7 second-pass decision (R7-05) — platform upgrade recovery

The platform root uses the same root OCI source for ordered Flux
Kustomizations with `wait: true`. A0 applies the loader, its Traefik route and
policies first and has no `dependsOn` on A or B; it starts without OpenBao or
Gitea. A applies backing services (OpenBao, Gitea, registry, CNPG operator
and Agent Vault) with `dependsOn: A0`; the loader's first-start work
initializes/unseals OpenBao and bootstraps Gitea so A becomes ready. B applies
the generation operator with `dependsOn: A`. A broken new loader is recovered through
`lifemodel doctor` over SSH, which can re-pin the previous platform release;
this replaces the former C-last ordering. The upgrade quiescence lock and
existing rollback-clock arbitration remain unchanged.

The owner's SSH entry point on the dedicated VM is `lifemodel doctor`. It
diagnoses Flux sources and Kustomizations, the loader, Gitea, OpenBao seal
state, and the upgrade lock across both layers; it offers recovery actions,
including re-pinning the previous platform release digest and resuming Flux.
This remains reachable when a partial apply breaks the loader UI. The
`generations/platform-upgrade-recovery` dedicated-VM check breaks that UI,
uses `lifemodel doctor` over SSH, checks the diagnostics and recovery actions,
re-pins the prior digest, resumes Flux and confirms recovery.

The upgrade lock is acquired only when the application layer is quiescent
(no open rollout step and no active rollback). While held, the generation
operator makes no deploy writes. If rollback becomes necessary during the
upgrade, the upgrade fails and the instance enters maintenance; the existing
rollback clock continues and is never reset.

## Round 7 dispositions (2026-10-13)

- R7-01 — Fixed: explicit per-Kustomization/HelmRelease impersonation, namespaced Roles, fail-closed ownership and Flux lockdown contract recorded; real refusal/valid-rollout walk remains acceptance evidence.
- R7-02 — Fixed: separate Bao-independent loader identity, scoped grants, prune exclusions, phase ownership and hand-off checks recorded; runtime walks remain unverified.
- R7-03 — Fixed: explicit chart overrides and safe admin-Secret retirement sequence recorded; rendered chart and replacement/login checks remain unverified.
- R7-04 — Fixed: installer-owned root trust, loader-only digest pin, artifact exclusion and restart persistence recorded; competing reconciliation remains unverified.
- R7-05 — Fixed: durable upgrade, serialization, compatibility, recovery-material and no-unsafe-downgrade contract recorded; dedicated upgrade walks remain unverified.
- R7-06 — Fixed: P15 includes registry/auth/verifier/internal delivery paths independent of app egress; exact pinned endpoint/bundle validation and live signed-fetch walk remain unverified.
- R7-07 — Fixed: separately authenticated identity transition, strict outage/cache behavior and fail-closed clean install recorded; transition/outage walks remain unverified.
- R7-08 — Fixed: application stop set and platform leave-running set, field ownership and upgrade precedence recorded; competing reconcile/panic walk remains unverified.
- R7-09 — Fixed: init-to-custody visible-recovery limit restored; F7/G3/N-19 await the manual acceptance check on the owner's test VM.
