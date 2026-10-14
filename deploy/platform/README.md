# Platform OCI artifact

This directory is the root of the signed platform OCI artifact. The root
`OCIRepository` and `platform` Kustomization apply the artifact in
`flux-system`. The artifact declares two ordered steps: A0 and A. A0 has no
`dependsOn`; it deploys the loader and the Gitea namespace first. Step A
`dependsOn: platform-a0`, so OpenBao and the rest of step A arrive only after
the loader can start. A0 creates no namespace that step A creates. This order
lets the loader initialize OpenBao rather than requiring an already running
Bao. See [ADR-010](../adr/010-container-generations.md) for the decision.

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
