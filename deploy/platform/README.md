# Platform OCI artifact

This directory is the root of the signed platform OCI artifact. The root
`OCIRepository` and `platform` Kustomization apply the artifact in
`flux-system`. The artifact declares four ordered steps: A0, A, B and C. A0 has no
`dependsOn`; it deploys the loader and the Gitea namespace first. Step A
`dependsOn: platform-a0`, so OpenBao and Gitea arrive only after the loader
can start. Step B installs CloudNativePG with its CRDs in a default-deny operator namespace;
its only opened routes are DNS, the documented Kubernetes API port, Postgres
instance ports and API-server webhook ingress. Step C depends on B and applies
shared state resources, including the Postgres Cluster and Valkey StatefulSet. A0 creates no namespace that step A creates. This order
lets the loader initialize OpenBao rather than requiring an already running
Bao. See [ADR-010](../../docs/adr/010-container-generations.md) for the decision.

## A0: loader and admission

A0 creates the restricted `lifemodel-system` and `lifemodel-git` namespaces,
the loader ServiceAccount and its narrowly scoped bootstrap permissions, the
loader Deployment, Service and `boot.localhost` Ingress. The loader image is
pinned by digest in `a0/kustomization.yaml`; its zero digest is a release
placeholder. The loader Deployment runs non-root with a read-only root
filesystem. `loader-default-deny` denies ingress and egress except Traefik to
port 7000, DNS, the Kubernetes API on TCP 6443, OpenBao on TCP 8200 and Gitea
on TCP 3000.

A0 also creates two Flux-prune-protected Secrets for durable loader phase
records and OpenBao key custody. Its ValidatingAdmissionPolicies fail closed:
the loader can create or update only `gitea-admin` in `lifemodel-git` and
`deploy-source-credential` in the two application namespaces, and cannot
delete them. Application Kustomizations must use their namespace's named
GitRepository and applier, cannot use kubeconfig, and cannot target or depend
on another namespace.

## Web interface routes

The signed platform artifact owns the Traefik routes. A0 installs the
`loader-auth` ForwardAuth middleware, pointing at the loader Service's
`/_auth/verify` endpoint. `boot.localhost` `/login` and `/setup` are exact
routes with higher priority and no middleware; the rest of `boot.localhost`
uses ForwardAuth. Step A routes the exact `localhost/_auth/handoff` path directly to the loader at higher priority, without ForwardAuth; all other `localhost` paths use ForwardAuth to the `web` Service on port 8080. Login cookies are host-only, with a short-lived signed handoff for crossing from `boot.localhost` to `localhost`. Browsers refuse `Domain=localhost`, so cookies cannot safely be shared with that Domain. The web Service is delivered by
lifemodel-vhd.6.3. The web pod's NetworkPolicy admits Traefik ingress on 8080
and allows egress only to DNS, Postgres and Valkey. `/api/events` must disable
response buffering in Traefik if buffering is otherwise enabled for the
cluster; the route itself does not add a buffering middleware.

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
The owner cuts a release by pushing a version tag; the workflow verifies its
signature against the pinned release-workflow identity. The `boot.localhost`
loader is reached on a test VM with:

```sh
curl --resolve boot.localhost:80:VM_IP http://boot.localhost/login
```

Replace `VM_IP` with the VM's reachable IP, or map `boot.localhost` to that IP
in the browser host file. Traefik publishes this host to port 7000.

The A0 reconciler uses the Flux v2.9.6 Kustomization API, which supports
`path`, `prune` and `wait` but not a required `dependsOn`; it has no dependency.
Step A uses `dependsOn` to enforce the A0-to-A order. See the [Flux v2.9.6
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
