# Platform OCI artifact

This directory is the root of the signed platform OCI artifact. The root
`OCIRepository` and `platform` Kustomization apply the artifact in
`flux-system`. The artifact declares the platform-instance bootstrap followed by four ordered
steps: A0, A, B and C. A0 depends on platform-instance, which creates the
loader namespace, app namespace, identity ConfigMaps and named Ingresses. Step A
`dependsOn: platform-a0`, so OpenBao and Gitea arrive only after the loader
can start. Step B installs CloudNativePG with its CRDs in a default-deny operator namespace;
its only opened routes are DNS, the documented Kubernetes API port, Postgres
instance ports and API-server webhook ingress. Step C depends on B and applies
shared state resources, including the Postgres Cluster and Valkey StatefulSet.  This order
lets the loader initialize OpenBao rather than requiring an already running
Bao. See [ADR-010](../../docs/adr/010-container-generations.md) for the decision.

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

The Flux reconcilers use `dependsOn` to enforce platform-instance → A0 → A → B → C.
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

The loader copies only the generated username and password to a fixed Secret
the `lifemodel-db-credentials` Secret in the `lifemodel` namespace, in a resumable first-start phase. It also
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
