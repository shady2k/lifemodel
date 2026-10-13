# Platform OCI artifact — A0

This directory is the root of the platform OCI artifact. Flux's root
`OCIRepository` applies the `platform` Kustomization here. At this stage the
only reconciled step is A0, the loader in `lifemodel-system`; later platform
steps must be added as Flux Kustomizations with explicit `dependsOn` edges to
A0 (and to any required earlier step).

## Loader image release pin

`a0/kustomization.yaml` pins the loader image with Kustomize's `images[].digest`
field. The all-zero SHA-256 digest is an intentional release placeholder, not
a deployable image. The artifact release process must replace it with the
built loader image's immutable `sha256:<64 hex digits>` digest. Do not set an
image tag: deployments must identify the exact image bytes.

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
