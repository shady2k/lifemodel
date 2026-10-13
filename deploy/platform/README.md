# Platform OCI artifact — A0

This directory is the root of the platform OCI artifact. Flux's root
`OCIRepository` applies the `platform` Kustomization here. The root artifact declares A0 and step A. A0 deploys the loader first; A
deploys OpenBao and depends on A0, but does not gate A0 or loader startup.
Step A's chart is the official OpenBao chart 0.30.3, vendored under
`charts/openbao` from its upstream archive (SHA-256
`d50ed31b8305f430df308c342dd3c1efa877222380e99cb480f74f070d6beaa8`).
The HelmRelease uses the same platform OCIRepository as its chart source.
OpenBao runs one standalone server using integrated Raft storage on a retained
PVC, with no injector or auto-unseal. The chart does not create or label the
namespace; `a/namespace.yaml` applies the PSA `restricted` labels. The chart's
server pod security context renders to restricted-compatible settings.
`a/network-policy.yaml` defaults OpenBao ingress to deny and allows TCP 8200
only from the loader pod in `lifemodel-system` (other ingress, including Raft
cluster port 8201, is denied). Egress is not constrained by this ingress-only
policy, so later Kubernetes-auth TokenReview and DNS can work.

## Loader image release pin

`a0/kustomization.yaml` pins the loader image with Kustomize's `images[].digest`
field. The all-zero SHA-256 digest is an intentional release placeholder, not
a deployable image. The artifact release process must replace it with the
built loader image's immutable `sha256:<64 hex digits>` digest. Do not set an
image tag: deployments must identify the exact image bytes.

## Cutting a platform release

The owner cuts a release by pushing a version tag such as `vX.Y.Z`. The
`release.yml` workflow builds and pushes the loader image, substitutes its
immutable digest in the platform manifests, then pushes and keyless-signs the
platform OCI artifact. It verifies that signature against the pinned release
workflow identity before the release completes. Cutting and pushing the tag is
the owner's action through `ship-release`; this workflow does not run on
branches or provide a manual dispatch.

## Reaching the loader on a test VM

The loader accepts only its compiled-in `boot.localhost` host at this point.
For a VM at `VM_IP`, send that Host header while connecting to the VM address:

```sh
curl --resolve boot.localhost:80:VM_IP http://boot.localhost/login
```

Replace `VM_IP` with the VM's reachable IP. In a browser, add a hosts-file
entry mapping `boot.localhost` to the VM IP, then open
`http://boot.localhost/login`. The Ingress publishes only this host through
k3s' bundled Traefik; the NetworkPolicy allows Traefik (`kube-system`) to reach
port 7000 and denies all egress.

## Flux API source

The A0 reconciler uses Flux `kustomize.toolkit.fluxcd.io/v1` fields documented
by Flux v2.9.6's kustomize-controller v1.9.6 API: `path`, `prune`, and `wait`
are supported `spec` fields, while `dependsOn` is optional. Therefore A0 has no
`dependsOn`; future ordered steps must add it. Source: [Flux v2.9.6 API
reference](https://github.com/fluxcd/kustomize-controller/blob/v1.9.6/docs/spec/v1/kustomizations.md);
the [Flux v2.9.6 release notes](https://github.com/fluxcd/flux2/releases/tag/v2.9.6)
identify kustomize-controller v1.9.6.
