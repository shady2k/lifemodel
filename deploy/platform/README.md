# Platform OCI artifact

This directory is the root of the signed platform OCI artifact. The root
`OCIRepository` and `platform` Kustomization apply the artifact in
`flux-system`. The artifact declares the platform-instance bootstrap followed by five ordered
steps: A0, A, B, C and D. A0 depends on platform-instance, which creates the
loader namespace, app namespace, identity ConfigMaps and named Ingresses. Step A
`dependsOn: platform-a0`, so OpenBao and Gitea arrive only after the loader
can start. Step B installs CloudNativePG with its CRDs in a default-deny operator namespace;
its only opened routes are DNS, the documented Kubernetes API port, Postgres
instance ports and API-server webhook ingress. Step C depends on B and applies
shared state resources, including the Postgres Cluster and Valkey StatefulSet.  This order
lets the loader initialize OpenBao rather than requiring an already running
Bao. Step D depends on C and applies the storage module, whose readiness reads
the database's catalog (ADR-015 S-D7); it is last because it is the only
platform workload that needs SQL. See
[ADR-010](../../docs/adr/010-container-generations.md) for the decision.

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
ServiceAccount, no loader volume, custody Secret or PKI, a read-only root
filesystem and `GET /status` as readiness (a first start with no model slots is
ready). `a/kustomization.yaml` pins the same loader image name, and the release
flow writes the pushed loader digest into `a0/kustomization.yaml` and
`a/kustomization.yaml` in one run. The Service publishes 8080 (the
OpenAI-compatible API) and 8081 (`/status`); `model-gateway-access` admits 8080
only from core pods and 8081 only from web and loader pods, and lets the
gateway reach DNS, OpenBao and the loader's model exception. OpenBao admits the
gateway on 8200 beside the loader. The core's `lifemodel-model-egress` allows
the gateway's 8080 and nothing else for the model, and the web module reads the
gateway's `/status`. The gateway logs in to OpenBao with role `model-gateway`,
policy `read` on `lifemodel/data/model/*` only, provisioned and verified by the
loader's bootstrap before the root token is retired. The core's endpoint comes
from `LIFEMODEL_MODEL_BASE_URL` and carries no key.

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

## Step D: the storage module

`storage-module` is a Deployment and Service in `lifemodel-system`, also the
loader image with its own entry point
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
or `failed`. `GET /livez` is the process, so a stopped database or store never
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

The task listener is TLS on 8443, with a second instance-CA leaf for the
module's in-cluster names (`storage-module.lifemodel-system.svc` and
`.svc.cluster.local`). The loader issues and renews it into the
platform-created `storage-module-tls` Secret, which only this pod mounts; the
module re-reads it once a minute, so a renewal reaches the next handshake
without a restart. The listener answers a health-like `GET /ping` for now;
653.7.2 adds TokenReview and the task API to it. Clients trust the instance CA
(`lifemodel-ca`), and nothing plain serves the task port.

`storage-module-access` lets the module reach DNS, OpenBao 8200, SeaweedFS 8333
and the database's 5432, and lets the loader read its health on 8081; the
database's own policy admits this pod back on 5432. It has no Internet, model or
Kubernetes API route yet, and no pod may reach the task port - the TokenReview
egress and the task, trusted-control and owner-read peers arrive with the task
API (lifemodel-653.7.2, lifemodel-653.7.5).

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
storage module's `storage-module-db-credentials` Secret in `lifemodel-system`,
in one resumable first-start phase. It also
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
