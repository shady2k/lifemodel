# Platform OCI artifact

This directory is the root of the signed platform OCI artifact. The root
`OCIRepository` and `platform` Kustomization apply the artifact in
`flux-system`. The artifact declares the platform-instance bootstrap followed by five ordered
steps: A0, A, B, C and D. A0 depends on platform-instance, which creates the
loader namespace, both application namespaces (including restricted `lifemodel-motor`), identity ConfigMaps and named Ingresses. Step A
`dependsOn: platform-a0`, so OpenBao and Gitea arrive only after the loader
can start. Step B installs CloudNativePG with its CRDs in a default-deny operator namespace;
its only opened routes are DNS, the documented Kubernetes API port, Postgres
instance ports and API-server webhook ingress. Step C depends on B and applies
shared state resources, including the Postgres Cluster and Valkey StatefulSet.  This order
lets the loader initialize OpenBao rather than requiring an already running
Bao. Step D depends on C and applies the storage module, whose readiness reads
the database's catalog (ADR-015 S-D7); it is last because its readiness needs SQL.
The model gateway also uses SQL for task authorization, but starts in A and
fails closed per task request until C and the migrations are available. SQL
and its copied credentials never gate gateway startup or readiness. See
[ADR-010](../../docs/adr/010-container-generations.md) for the decision.

## Release images

The signed platform artifact pins the loader (also model gateway and storage),
core, web and **workbench** images by digest. The workbench is
`zot.lifemodel-system.svc:5001/lifemodel/workbench`: Node 24.21.0, OpenCode 2.1.4, git/build
tools, this release's offline dev dependencies, storage CLI and task launcher.
It is not a running platform Deployment. Its release digest is the core's
`LIFEMODEL_TASK_WORKBENCH_IMAGE` launch input in
`applications/lifemodel/kustomization.yaml`, pinned before loader seed bundling.
The Job adapter consumes it in 653.8.5; the launcher stub fails closed until
653.8.7. See [the workbench contract](../../docs/features/motor/workbench.md)
for pins, private HOME/work-volume paths and offline checks. Prime Agent joins
this one image in stage 4, not in the stage-3 image.

CI also publishes the workbench on a push to main whose inputs changed, as
`ghcr.io/shady2k/lifemodel-workbench:main` and `:<commit sha>`
(lifemodel-653.8.15). Those are moving tags for inspecting the current build,
not a release: no manifest or platform artifact refers to them, and the loader
import still copies exactly the release digest.

## Zot and the background workbench import

The step order remains **instance → A0 → A → B → C → D**. A contains zot,
with one retained 20Gi local-path PVC and no host networking. Its upstream
v2.1.22 OCI index is digest-pinned (current stable main release, released
2026-10-06), not a mutable “latest” image. Deduplication and GC are enabled.
GC runs hourly with a two-hour `gcDelay`, longer than the importer's entire
30-minute phase budget. It reclaims uploads idle beyond that grace and
unreferenced blobs. An explicit retention policy for `lifemodel/workbench`
sets `deleteUntagged: false` and `deleteReferrers: false`: digest-only release
roots and their referenced graph remain pullable across GC and restart.
After a hard crash, retry the import; completed objects are reused and stale
partial uploads are reclaimed on a later GC pass (normally within three
hours of their last write while zot is healthy, plus scheduler/runtime delay).
This is not a disk quota: retained releases are not automatically expired.
Before deliberate release pruning or store recovery, back up the registry
volume and OpenBao; never delete roots or shared blobs by hand. Restore the
volume or reimport the pinned public release after storage repair.
zot's configuration is `a/zot/config.json`, which the platform artifact renders
through a `configMapGenerator`: the generated ConfigMap's name carries a hash of
the file, kustomize rewrites the pod template's reference to that name, and a
configuration change therefore replaces `zot-0` on the next reconcile. This is
needed because v2.1.22 reloads its config file live only for a subset of fields:
`http.compat`, the listener address and port, `rootDirectory` and a newly added
subpath stay at their startup values, and the process only logs that difference
as needing a restart. Flux prunes the previous ConfigMap name under step A's `prune: true`.
The one input zot re-reads live is the `zot-htpasswd` Secret: v2.1.22's
`HTPasswdWatcher` reloads the file, which is why the pod mounts its directory
(no `subPath`) and an identity rotation needs no replace.

The Service is `zot.lifemodel-system.svc:5001`, with fixed ClusterIP
`10.43.0.51` in the installers' explicit `10.43.0.0/16` service CIDR.

Both installers write k3s `registries.yaml` for this exact authority with
plain-HTTP mirror `http://10.43.0.51:5001`, and disable default-registry-endpoint
fallback. Node containerd uses kube-proxy routing rather than cluster DNS.
Port 5000, used by the clean-VM walk for its platform artifact, is unchanged.
No hostPort or Pod Security exception is added. Bootstrap images (k3s, Flux,
zot itself and loader) remain externally release-pinned, never served by zot.
Core, web and gateway images do not move in this task.

A0 precreates `zot-htpasswd`; its key is initially absent so zot cannot start
unauthenticated. After Bao init/unseal/policy, phases run:

1. Seaweed custody (only Bao and A's identity Secret).
2. Zot custody: generate/reuse one random password in
   `lifemodel/data/registry/zot`, verify read-back, project only a bcrypt hash
   for the sole `loader` user into `zot-htpasswd`.
3. Gitea bootstrap, seeding and application source/Kustomization creation.
4. CNPG credential copy (waits for C), then Valkey credential copy.

Workbench import is an independent loader task, not a first-start phase. It
reads the release digest from A0's `workbench-origin` ConfigMap as
`LIFEMODEL_WORKBENCH_DIGEST`, and the source registry/repository plus optional
pull credential from the loader's OpenBao setting. The default source is
`ghcr.io/shady2k/lifemodel-workbench`; an instance may select another HTTPS
registry. The source credential stays in `lifemodel/data/workbench/source`.
The sole zot push credential remains in `lifemodel/data/registry/zot`.

The worker copies exact index/manifests/config/layer bytes, verifies SHA-256
and size after pushing, and reuses verified objects after a kill. Request and
whole-attempt deadlines and size/count budgets fail with safe codes. Status
on the loader volume is `pending`, `importing`, `ready` or `failed`, with last
attempt time. Failures back off from one second to one minute; a settings save
cancels the old attempt and retries immediately without restart. The loader
shows the source and status in English and Russian; secret values never return.

Zot waits on neither Gitea nor C. Application sources are created even if the
source is unreachable or refuses the credential. Core checks the pinned
manifest with a bounded anonymous HEAD before task acceptance. A missing digest
refuses start with `workbench_unavailable` and creates no Job or task row. Jobs
never fall back to the external source. Anonymous pull has `read` only. Push
requires the sole password and repository authorization. Pod ingress admits
loader and core; core receives only anonymous read access. Node-origin pull
uses Kubernetes' node exception.
A commented builder slot grants no rights. TLS remains lifemodel-pwe.2.

The existing loader model-check egress also reaches the public import origin.
NetworkPolicy is additive; no phase-only network enforcement is claimed and
there is no temporary import-egress policy. The importer's own host confinement
is the boundary: HTTPS to the configured registry, checked token realms and
anonymous HTTPS blob redirects. Pull credentials are sent only to the configured
registry or its same-origin token realm. A registry-named off-host HTTPS realm
may be used anonymously only; a configured credential makes it a refusal.
Redirects never carry Authorization or cookies, and bytes remain digest/size
verified. Zot's password is used only at the destination.

## A0: loader and admission

A0 consumes the `lifemodel-system` namespace owned by `platform-instance` and creates restricted `lifemodel-git`,
the loader ServiceAccount and its narrowly scoped bootstrap permissions, the
loader Deployment and Service. `platform-instance` owns the `boot-<name>.local`
Ingress. The loader image is
pinned by digest in `a0/kustomization.yaml`; its zero digest is a release
placeholder. The loader Deployment runs non-root with a read-only root
filesystem. `lifemodel-system-default-deny` denies all ingress and egress in the
namespace as its own object, and `loader-access` is the loader's own permit list
on top of it: Traefik to port 7000, DNS, the Kubernetes API on TCP 6443, OpenBao
on TCP 8200, Gitea on TCP 3000 and the model endpoints. A second platform
workload in this namespace inherits none of it; the model gateway gets its own
policy in step A.

A0 also creates two Flux-prune-protected Secrets for durable loader phase
records and OpenBao key custody. Its ValidatingAdmissionPolicies fail closed:
the loader can create or update only `gitea-admin` in `lifemodel-git` and
`deploy-source-credential` in the two application namespaces, and cannot
delete them. Application Kustomizations must use their namespace's named
GitRepository and applier, cannot use kubeconfig, and cannot target or depend
on another namespace.

## Web interface routes

`platform-instance` owns the public routes and their namespace-local ConfigMaps.
`boot-<name>.local` routes every path directly to the loader without ForwardAuth.
The app host `<name>.local` routes through ForwardAuth except exact
`/_auth/handoff`, which goes to the loader. The loader rejects all other
host/path combinations. The app origin and chat's loader link derive from the
instance ConfigMap. HTTP remains in this stage; HTTPS and the Traefik redirect
are lifemodel-3wi9.3.4.

## Step A: OpenBao, Gitea and applications

Step A applies OpenBao and Gitea as committed rendered manifests, application
namespaces and their appliers, and default-deny policies. OpenBao uses
integrated Raft storage on a retained PVC, has no injector or auto-unseal, and
allows only loader ingress on TCP 8200, DNS and Kubernetes API TCP 6443 for
TokenReview; its ServiceAccount has the built-in `system:auth-delegator` role.
Gitea uses SQLite on its retained PVC, has no Ingress, and its
chart references the `gitea-admin` Secret. Flux pruning is disabled for the
stateful namespaces and the Gitea PVC.

The loader initializes OpenBao and stores the 1-of-1 unseal key and root token
in `openbao-unseal-custody` before using them. It verifies Kubernetes-auth
handoff, revokes the root token and removes it from custody. The unseal key
remains in custody so later starts can unseal Bao. It then creates or reuses
Gitea's admin Secret, verifies Gitea, seeds `main` from the release git bundle
in the loader image, creates `deploy`, protects both branches and creates a
read-only source user. It creates the two namespace-local
`deploy-source-credential` Secrets. Step A's namespace-local GitRepositories
use those credentials. The loader then creates the two application
Kustomizations with their matching restricted appliers. Phase progress is
stored and read back after each durable phase; failures are recorded and
retried by the loader while its interface remains available.

## Step A: the model gateway

`model-gateway` is a Deployment and Service in `lifemodel-system`, part of the
signed platform and applied after OpenBao: the loader image with its command
overridden to `node /opt/lifemodel/loader/dist/model-gateway.js`, its own
ServiceAccount, no loader volume, custody Secret or CA private key, a read-only
root filesystem and `GET /status` as readiness (a first start with no model slots
or SQL is ready). `a/kustomization.yaml` pins the same loader image name, and the release
flow writes the pushed loader digest into `a0/kustomization.yaml` and
`a/kustomization.yaml` in one run. The Service publishes 8080 (the
OpenAI-compatible core API), 8446 (the separate task TLS listener) and 8081
(`/status`); `model-gateway-access` admits 8080 only from core pods and 8081
only from web and loader pods. `task-model-ingress` admits 8446 only from
`lifemodel-motor` AND task-labelled Pods, paired with task model egress in D.
The gateway reaches DNS, OpenBao, the loader's model exception, Postgres 5432
(`lifemodel-state` AND `cnpg.io/cluster: lifemodel`) and the existing k3s API
TCP 6443 exception. Postgres explicitly admits only gateway-labelled Pods from
the system namespace beside its existing clients. OpenBao admits the
gateway on 8200 beside the loader. The core's `lifemodel-model-egress` allows
the gateway's 8080 and nothing else for the model, and the web module reads the
gateway's `/status`. The gateway logs in to OpenBao with role `model-gateway`,
policy `read` on `lifemodel/data/model/*` only, provisioned and verified by the
loader's bootstrap before the root token is retired. The core's endpoint comes
from `LIFEMODEL_MODEL_BASE_URL` and carries no key.

The task listener uses its own instance-CA leaf for
`model-gateway.lifemodel-system.svc` and `.svc.cluster.local`. Loader PKI issues
and renews it into `model-gateway-task-tls`, precreated in A0 because PKI runs
before A. Only the gateway mounts this leaf, read-only without subPath at
`/opt/lifemodel/task-model-tls` (`LIFEMODEL_TASK_MODEL_TLS_DIR`). The listener
reloads it once a minute, like storage. Tasks trust the public `lifemodel-ca`
copy; no key leaves the trusted platform Pods.

Core's task-only mailbox uses a separate instance-CA leaf for
`core.lifemodel.svc` and `core.lifemodel.svc.cluster.local` on TLS port 8447.
A0 precreates `core-task-channel-tls` in `lifemodel` and grants loader only
fixed-name `get`/`update`; the loader Secret admission permits only UPDATE of
that leaf, not CREATE or DELETE. The namespace already exists in instance, so
PKI boot never waits for A or D. Only the core process mounts this Secret,
read-only without subPath at `/opt/lifemodel/task-channel-tls`
(`LIFEMODEL_TASK_CHANNEL_TLS_DIR`); its migration init container does not.
`LIFEMODEL_TASK_CHANNEL_PORT=8447` selects the task listener, separate from
health on 8081. Tasks receive only the existing public CA ConfigMap. No CA
private key or unrelated listener leaf is mounted in core. Step D grants the
core a dedicated cluster-scoped `create` on TokenReviews only for task audience
proof. Its existing namespaced Job/Pod reads supply live identity checks; no
SubjectAccessReview, impersonation or generalized auth-delegator grant is added.

The same CNPG copy phase that supplies storage's interim owner login fills
`model-gateway-db-credentials`. The gateway mounts the Secret as an optional
read-only directory without subPath at `/opt/lifemodel/database`, and reads
`LIFEMODEL_DB_USERNAME_FILE` and `LIFEMODEL_DB_PASSWORD_FILE` when it needs SQL.
It uses storage's fixed target `lifemodel-rw.lifemodel-state.svc.cluster.local:5432/lifemodel`.
No Secret-backed environment value can freeze the empty pre-C state. This is
the interim module login until lifemodel-2t5, not a new identity lease.

Gateway RBAC grants only cluster-scoped `create` on TokenReviews for audience
proof and namespaced `get` on Pods and Jobs in `lifemodel-motor` for current
bound Pod/controller Job proof. Dynamic names cannot be pinned with
`resourceNames`; there is no list/watch, Secret read, mutation, impersonation
or general auth-delegator role. Each task request proves live identity and
canonical SQL intent anew. See [task identity](../../docs/features/motor/task-identity.md)
for the start claim and model routes. API/SQL outages deny task calls, not the
core's existing model listener or gateway readiness.

## Step A: SeaweedFS

`seaweedfs` is a one-replica StatefulSet in `lifemodel-system` running
`weed mini`: master, volume server, filer and S3 in one process on one
retained 10Gi `local-path` volume (ADR-015 S-D1). The image is pinned by the
research digest, the process is started directly as the image's own non-root
user, and the flags are explicit: data, filer metadata and the mini
configuration file live under `/data`, the components talk over loopback, and
the admin UI, WebDAV and the Iceberg and Lance catalogs are disabled. S3
requires authentication (`-s3.config`): a missing or unreadable identity file
stops the process, and a file that yields no identity denies every request, so
there is no anonymous mode. The Service publishes only the S3 port 8333.

The S3 identity is platform custody. The loader's first start generates the
module's service credentials, keeps them in the OpenBao record
`lifemodel/data/storage/seaweed`, and projects them into the
`seaweed-s3-identity` Secret that only the SeaweedFS pod mounts (as
`/etc/seaweedfs/s3.json`). One identity, scoped to the one bucket
`lifemodel-storage`, with `Read`, `Write` and `List` on that bucket and no
admin action. Flux creates the Secret empty once (`IfNotPresent`) and never
overwrites the loader's content. Rotation rewrites the record and the Secret;
SeaweedFS reads the file at startup, so a rotation takes effect on its next
restart.

This arrives with a fresh installation only. An instance bootstrapped by an
earlier platform version has no `storage-module` identity and no `loader-storage`
grant on the custody record, and its root token is already retired, so nothing
can provision them in place; the loader refuses that instance on every start
with one named error that says a reinstall is required. There is no upgrade
path. SeaweedFS custody runs as the loader's first first-start phase: it needs
only OpenBao, which the policy phase has just prepared, and the platform Secret,
while the phases after it copy Secrets that exist only once step C has run. The
storage module of step D reads that custody record, so the record has to land
from the step that needs only A.

`seaweedfs-access` admits only storage-module pods, and only on 8333: the
master, volume and filer ports have no allow rule anywhere, so the namespace
default deny keeps them private to that pod.

## Step D: the storage module and task ground

`storage-module` is a single-replica Recreate Deployment and Service in
`lifemodel-system`, also the loader image with its own entry point
(`/opt/lifemodel/loader/dist/storage-module.js`), its own ServiceAccount and no
loader volume. It is in step D, after the database, because its readiness reads
its own Postgres catalog; in step A it would have made A wait for C while C
waits for A. Its catalog is the `storage` schema that `db/migrations` creates,
applied by the first generation's `migrate` initContainer, so on a fresh
installation the module is unready until that generation has started - the step
keeps a 30-minute wait for exactly that, and Flux retries it on its interval
until it converges. The module never reports an empty or missing catalog as
ready.

`GET /status` on its own status listener is 200 only when the module read its
catalog table and SeaweedFS answered a signed listing of the module's bucket
with valid auth; otherwise it is 503 with the reason (`catalog_unavailable`,
`unreachable`, `auth_denied`, `bucket_missing`, `unexpected`,
`credentials_unavailable`, `timeout`). A failed catalog read also records the
repair in the log: `unreachable`, `auth_failed`, `schema_missing`, `forbidden`
or `failed`. A non-normal restore hold also reports `catalog_unavailable`,
with the safe logged cause `restore_pending`; health JSON does not expose
maintenance generation, progress or unavailable counts. The recovery CLI exposes
those separately. Listeners and the retention loop start under a hold, but
durable transaction fences refuse ordinary writes/GC until explicit release.
`GET /livez` is the process, so a stopped database or store never
restarts the module that reports it. It logs status codes and identifiers only,
never a key, a body or a password.

Its database login is the database owner's own for now, copied by the loader's
first start from CloudNativePG's generated `lifemodel-app` Secret into the
platform-created `storage-module-db-credentials` Secret in `lifemodel-system`,
which only the module's pod reads. That is the owner's interim decision
(ADR-015 amendment, 2026-10-21, lifemodel-653.7.8); a leased identity is
lifemodel-2t5's. The module logs in to OpenBao with role `storage-module`,
whose policy is `read` on the one custody record and nothing else, provisioned
and verified by the loader's bootstrap before the root token is retired.

The module serves three separate TLS listeners with the existing instance-CA
leaf for `storage-module.lifemodel-system.svc` and `.svc.cluster.local`. The
loader issues and renews it into the platform-created `storage-module-tls`
Secret, mounted only by this pod. Each listener re-reads it once a minute;
clients must trust the instance CA (`lifemodel-ca`), never disable certificate
verification. No plaintext listener serves task or trusted operations.

- Task 8443: `GET /spaces/:space/access` proves current own-space access;
  `GET /ping` is a transport check only. The [object API](../../docs/features/motor/storage-objects.md)
  serves own-space immutable PUT/GET/list/mark. Audience `lifemodel-task-storage`,
  identity `lifemodel-motor:task`. Every operation/chunk performs a fresh
  audience-specific TokenReview and reads the current non-deleting bound Pod
  and its exact live controller Job. The SQL intent/projection/catalog guard
  checks binding, revision, mode and database-clock deadlines independently of
  the core process. No positive identity cache substitutes for these reads.
- Trusted control 8444: keyed allocate/bind/revoke/seal, retention policy/plan
  routes and maintenance begin/status/release. Audience
  `lifemodel-core-storage-control`, exact SA `lifemodel:core` and fresh bound
  Pod verification. Revoke commits the revision and keyed receipt, then cancels
  active streams before ACK. A missing space is `404 space_not_found`; a stale
  expected revision is `409 revision_conflict`. The wired core retention client
  persists owner warnings before confirming them; task lifecycle/terminal
  integration remains stage 3.
- Trusted read 8445: `GET /identity`, audiences
  `lifemodel-core-storage-read` and `lifemodel-web-storage-read`, matched to
  `lifemodel:core` and `lifemodel:web` respectively with fresh bound Pod checks.
  Web cannot invoke control. Core also has marked, non-tombstoned object
  GET/list routes on this listener, with fresh verification on each chunk.
  Web has no object-route permission yet: owner download authorization and the
  same-origin browser content boundary remain S08 integration work, not an
  existing owner download service.

`storage-module-access` and the caller-side egress policies admit these exact
peers, combining namespaceSelector AND podSelector (the Pod label is
`app.kubernetes.io/name`):

| Port | Caller namespace | Caller Pod label |
| --- | --- | --- |
| Health 8081 | `lifemodel-system` | `loader` |
| Task 8443 | `lifemodel-motor` | `task` |
| Control 8444 | `lifemodel` | `core` |
| Read 8445 | `lifemodel` | `core` or `web` |

Reverse caller egress targets `lifemodel-system` AND `storage-module` on only
those ports. Module egress is DNS in `kube-system` AND `k8s-app: kube-dns`,
OpenBao 8200 (the inherited namespace-only peer in `openbao`), SeaweedFS 8333
in `lifemodel-system` AND `seaweedfs`, and Postgres 5432 in `lifemodel-state`
AND `cnpg.io/cluster: lifemodel`. The database admits the module back on 5432.
TCP 6443 is the platform's any-address k3s Kubernetes API egress exception
because API Service DNAT targets the node address. It grants no API rights:
RBAC permits only TokenReview creation, Pod GETs in `lifemodel` and
`lifemodel-motor`, and Job GETs only in `lifemodel-motor`. There is no model
route or general Internet egress.

Identity proof outages (apiserver 5xx, transport or timeout) fail closed with
`503 identity_unavailable`; unauthenticated tokens, wrong audience/binding,
missing/deleting Pod or Job and API 401/403 refusals stay `403 identity_denied`.
Readiness checks stores and authorization DDL, not Kubernetes verification RBAC;
a Ready module does not prove those API rights are intact. One request-denial
or revoke log line contains only `{ id, code, status, space }`; correlate a
reported error ID with that line. Unknown or invalid space IDs log as null,
not as a request body, path or file name. Fix the API/RBAC path for a failed
identity proof; never bypass it or substitute core availability.

The `gitea-admin` Secret remains while the chart references it. Its Bao-held
retirement is lifemodel-2t5.2. The Gitea and OpenBao charts are vendored at
pinned versions and rendered into committed manifests; `nix flake check`
re-renders them and rejects drift. The Flux resources are plain manifests, not
Helm releases, and rendered Helm test hooks are excluded.

## Rendering the charts

Render both committed files with:

```sh
tmp=$(mktemp deploy/platform/a/openbao/rendered.yaml.XXXXXX) && nix shell --inputs-from . nixpkgs#kubernetes-helm -c helm template openbao deploy/platform/charts/openbao --namespace openbao --skip-tests -f deploy/platform/a/openbao-values.yaml > "$tmp" && test -s "$tmp" && mv "$tmp" deploy/platform/a/openbao/rendered.yaml || { status=$?; rm -f "$tmp"; exit "$status"; }
tmp=$(mktemp deploy/platform/a/gitea/rendered.yaml.XXXXXX) && nix shell --inputs-from . nixpkgs#kubernetes-helm -c helm template gitea deploy/platform/charts/gitea --namespace lifemodel-git --skip-tests -f deploy/platform/a/gitea/values.yaml > "$tmp" && test -s "$tmp" && mv "$tmp" deploy/platform/a/gitea/rendered.yaml || { status=$?; rm -f "$tmp"; exit "$status"; }
```

## Releasing and reaching the loader

The release workflow builds and pushes the loader image, substitutes its
immutable digest in the platform manifests, and signs the OCI artifact. A0's
digest is therefore resolved from the release image, not from a mutable tag.
The generic installer accepts `--name home` (default `lifemodel`), a lowercase DNS label up to 57 characters; the value is fixed by the installed ConfigMap. The owner cuts a release by pushing a version tag; the workflow verifies its
signature against the pinned release-workflow identity. The `boot-<name>.local`
loader is reached on a test VM with:

```sh
curl --resolve boot-<name>.local:443:VM_IP https://boot-<name>.local/login
```

Replace `VM_IP` in the command with the VM's reachable IP. Traefik publishes this host on port 443. Port 80 redirects to HTTPS.

The Flux reconcilers use `dependsOn` to enforce platform-instance → A0 → A → B → C → D.
The instance ConfigMap is required by the platform-instance post-build substitution. See the [Flux v2.9.6
API](https://github.com/fluxcd/kustomize-controller/blob/v1.9.6/docs/spec/v1/kustomizations.md)
and [release notes](https://github.com/fluxcd/flux2/releases/tag/v2.9.6).

## CloudNativePG state

The CloudNativePG operator chart is vendored at `charts/cloudnative-pg`,
version 0.29.1 (operator 1.30.1). Its release archive SHA-256 is recorded in
`chart-source.sha256`. The chart supports a digest override added to its image
value; the operator image is pinned to
`ghcr.io/cloudnative-pg/cloudnative-pg@sha256:923c267ec29636db3bee20f993d0ec4973fa22998e1adad37da79e4d32b5bc07`.
Step B applies the CRDs and waits for the operator. Step C owns
`lifemodel-state`, its default-deny policies, the one-instance `lifemodel`
Cluster and the one-replica Valkey StatefulSet. Valkey uses a plain Kubernetes
manifest rather than a chart: its small, fixed resource set stays explicit and
adds no chart packaging. Step A permits core egress to Postgres on TCP 5432 and
Valkey on TCP 6379; the state policies admit only the core namespace on those
store ports, plus the CNPG operator ports. The bootstrap creates database
`lifemodel` and owner role `lifemodel` with CNPG's generated `lifemodel-app` Secret.
The post-init SQL enables pgvector in the application database.

The loader copies only the generated username and password to the
`lifemodel-db-credentials` Secret in the `lifemodel` namespace and to the
storage module's `storage-module-db-credentials` and gateway's
`model-gateway-db-credentials` Secrets in `lifemodel-system`, in one resumable
first-start phase. It also
generates a random Valkey password only if the retained source Secret is
absent, then copies it to the `lifemodel-valkey-credentials` Secret in the `lifemodel` namespace. This uses
the existing loader ServiceAccount; it adds no controller. The credentials are
static until lifemodel-2t5 moves them to OpenBao. The platform admission policy
allows only these named loader Secrets while application Kustomizations remain
confined to their own namespaces.

## Vendored CRD schema check

`nix flake check` runs `scripts/check-platform-crd-schemas.py` against the rendered
CloudNativePG resources and vendored CRDs. The checker validates schema-declared
primitive types, enum values, required fields, object field placement, and nested
array/object schemas (including local `$ref` and composition branches). It is a
focused CRD resource checker, not a general Kubernetes or full OpenAPI validator;
it does not validate formats or every Kubernetes extension. Nix fixtures prove it
rejects both an unknown field and `instances: not-an-integer`.


## Back up and restore loader PKI

The loader volume contains the instance CA and identity. Back up the **whole**
`/var/lib/loader` volume, including `pki/ca.key`, `pki/ca.crt`, and
`instance.json`, with file ownership and permissions preserved. The CA key is
private and must remain mode `0600`; never copy it to a Kubernetes Secret or
log. Keep the backup encrypted and access-controlled.

To restore, stop the loader Deployment, restore the complete volume with its
original permissions, then start the Deployment. Do not restore only the
Kubernetes `lifemodel-tls` Secret or regenerate a missing CA when
`instance.json` exists. Run `lifemodel doctor` and verify that its reported
CA SHA-256 fingerprint matches the fingerprint recorded with the backup
before trusting the restored instance. If the volume is lost, reinstalling
creates a new CA and every client must trust the new certificate.


## Task launch boundary (ADR-014 D1/D3, lifemodel-653.8.2)

Step D also supplies the unbound `lifemodel-motor:task` ServiceAccount,
core's namespace-scoped task-launcher Role/Binding, and the task runtime
NetworkPolicies. The namespace default-denies ingress and egress. Pods labelled
`app.kubernetes.io/name=task` get exactly these outbound routes:

| Destination namespace AND Pod selector | Protocol/port | Purpose |
| --- | --- | --- |
| `kube-system` AND `k8s-app=kube-dns` | UDP and TCP 53 | Resolve Service names, including `storage-module.lifemodel-system.svc`; no hostAliases |
| `lifemodel-system` AND `app.kubernetes.io/name=storage-module` | TCP 8443 | Own-space storage TLS |
| `lifemodel-system` AND `app.kubernetes.io/name=model-gateway` | TCP 8446 | Separate task model/identity TLS listener |
| `lifemodel` AND `app.kubernetes.io/name=core` | TCP 8447 | Task-only durable control TLS channel, implemented in 653.8.8 |

The model listener runs in A; task ingress and egress arrive in D. The task
channel port 8447 remains reserved and exposed by its Service until 653.8.8.
Numeric targetPorts avoid a bootstrap dependency on later application changes. Existing model API
8080 and status 8081 stay unchanged and are not task routes. Each runtime
listener's ingress is paired with the task egress and combines namespace AND
Pod selectors. Tasks have no ingress, Internet/API route or direct
Postgres/Valkey/SeaweedFS route. DNS is a resolver exception, not authority to
connect to a resolved address; trusted service protocols enforce live identity.

The `task` SA has no RoleBinding or ClusterRoleBinding. Default API-token
mounting is disabled. Jobs explicitly project only the three service audiences
`lifemodel-task-model`, `lifemodel-task-storage`, `lifemodel-task-channel`.
Core alone gets a rotating API-audience token, explicitly mounted only in its
main container (not the migration init container); default automount remains
off. Its Role permits Jobs create/get/list/watch/patch/delete and Pods
get/list/watch in `lifemodel-motor` only. Get supports exact adoption/identity,
list/watch resync, patch monotone deadline shortening and delete exact-UID
stop/cleanup. No Secrets, exec or cluster-wide grant is added. Core's TCP 6443
API egress follows the existing k3s unknown-node-DNAT exception; tasks never
inherit it. These network and RBAC guards do not prove caller-side UID/CAS use.

### CA replication without a readiness cycle

`platform-instance` owns both restricted application namespaces. A0 precreates
`lifemodel-ca` placeholders in `lifemodel` and `lifemodel-motor`, with
IfNotPresent SSA and prune disabled. Loader PKI writes the same public
`ca.crt` to system, core and task copies on every issuance/rotation, then reads
each back; missing/denied/mismatched copies fail closed. The fixed-name A0
loader Roles allow only get/update of `lifemodel-ca`. Its admission rule allows
only a single `ca.crt` data entry, no binaryData/key, and reserves update to the
loader while refusing deletion. No TLS Secret or private key crosses namespaces.
Tasks must mount the CA read-only, without subPath, so kubelet can rotate it.

This bootstrap placement is necessary: loader PKI starts before A, and A waits
for A0. Provisioning the task copy or rights in A or D would deadlock. No new
wait edge is added: instance → A0 → A → B → C → D. Namespace ownership relocation
is verified for fresh installation; an in-place Flux inventory transfer is not
claimed here (the platform's current storage install also requires reinstall).

### Service-free task admission

A0 installs `task-job-admission` and `task-pod-admission` with failurePolicy
Fail and Deny bindings, scoped to the entire task namespace, not just labelled
objects or opted-in identities. They validate core-created one-shot Jobs and
core/Job-controller-created Pods, explicit task SA/no automount, matching
`lifemodel.dev/launch-id` and task labels, one workbench container, restricted
security, finite deadlines, Never/0/Failed/fail-on-disruption/nonzero semantics,
closed volume/token sources, and immutable launch/template on Job UPDATE.
Deadline removal/increase, suspend, selector adoption and TTL cleanup are denied.
Pod ephemeral-container subresource updates are guarded too. Status subresources
are not intercepted; scheduler binding is not a new Pod CREATE.

The fixed maximum Job `activeDeadlineSeconds` is **86400 seconds**, including
snapshotted wrap grace. This is this leaf's platform engineering ceiling, not a
claim that the settings registry has a total-timeout declaration (it currently
has only a separate wrap-grace bound), and not ADR-014's 300-second wrap default.
Raising it is an explicit platform policy change. The release pin point is the
workbench image rule: only repository
`zot.lifemodel-system.svc:5001/lifemodel/workbench` with a valid sha256 digest.
The release supplies the pin and core requires that exact pinned image.
`ghcr.io/shady2k/lifemodel-workbench` is the default import origin, not an
admitted Job or Pod image. The trusted launcher is the image ENTRYPOINT. Command/args overrides and lifecycle hooks remain
forbidden. Both Job and Pod policies permit only these literal environment names:

- `LIFEMODEL_STORAGE_ENDPOINT`
- `LIFEMODEL_STORAGE_SPACE`
- `LIFEMODEL_STORAGE_TOKEN_FILE`
- `LIFEMODEL_STORAGE_CA_FILE`
- `LIFEMODEL_TASK_CHANNEL_ENDPOINT`
- `LIFEMODEL_TASK_CHANNEL_TOKEN_FILE`
- `LIFEMODEL_TASK_CHANNEL_CA_FILE`
- `LIFEMODEL_TASK_MODEL_ENDPOINT`
- `LIFEMODEL_TASK_MODEL_TOKEN_FILE`
- `LIFEMODEL_TASK_MODEL_CA_FILE`

Each entry must have a literal `value`; `valueFrom`, nonempty `envFrom`, and all
other names (including `NODE_OPTIONS`, `LD_PRELOAD` and `PATH`) are denied.
Values carry non-secret endpoints, space identity and projected token/CA file
paths, never token contents. This is a closed launch-configuration contract, not
permission to override the trusted launcher. The existing storage CLI consumes
the four storage names; the six channel/model names are reserved for the
verified launcher handshake in 653.8.7. Admission validates the static shape;
it does not verify endpoint trust or that a literal value contains no secret.

CEL cannot query canonical SQL intent/epoch or resolve a live owner reference.
Its controller Job owner reference is only a shape check, not proof that the
named Job exists or owns this Pod, and labels are not authority. The model
gateway's live Pod/Job binding and once-only SQL execution claim (653.8.6)
provide that proof and keep delayed stale creates inert. Local tests evaluate
actual CEL expressions with the existing evaluator. They do not replace API
server CEL typechecking/defaulting or runtime network enforcement: the
coordinator must run the VM probes before stage acceptance.
