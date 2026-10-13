# lifemodel NixOS module

Add this flake as an input and enable `services.lifemodel` on the dedicated VM:

```nix
{ inputs, ... }: {
  imports = [ inputs.lifemodel.nixosModules.default ];
  services.lifemodel = {
    enable = true;
    platform.url = "oci://ghcr.io/shady2k/lifemodel-platform";
    platform.tag = "v1.0.0";
  };
}
```

Then run `sudo nixos-rebuild switch --flake .#HOST`. The module starts k3s
with embedded etcd and its bundled Traefik, installs Flux v2.9.6, and applies
the verified platform source and root Kustomization. The bootstrap is a systemd
oneshot: an unchanged switch does not rerun it. Changing the configured platform
ref changes its unit script, so NixOS restarts the unit during the switch; a
failed bootstrap makes the switch fail. To re-apply without changing the
configuration, run `sudo systemctl restart lifemodel-flux-bootstrap` or
`sudo lifemodel doctor --repin clear`. Keyless verification is the default. The
recovery CLI requires Node.js 18 or newer; the generic installer checks this
before any cluster writes. For key verification set
`verify.mode = "key"` and `verify.publicKey` to the PEM public key text. Use `platform.digest` instead of
a mutable tag when pinning an artifact by digest. `platform.insecureRegistry`
is only for a VM-local plain-HTTP registry.


## When the loader is broken

SSH to the dedicated VM and run `sudo lifemodel doctor`. It reports Flux source
and Kustomization readiness, revisions, and loader pod health. To restore the
previous successfully applied platform release, run
`sudo lifemodel doctor --repin previous`. Doctor stores a durable override and
restarts the single bootstrap writer; it does not patch the cluster itself.
The writer uses the override only while the configured tag or digest still
matches the configuration recorded with it. An unchanged NixOS switch keeps
the override. Setting a new configured tag or digest makes that configured ref
win and removes the override. Run `sudo lifemodel doctor --repin clear` to
remove an override explicitly. Doctor reports an active override prominently. If the root OCIRepository `spec.ref` is owned by a different field manager, the writer refuses to apply and reports the manager. Reset it with `sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml delete ocirepository platform -n flux-system`; the writer then recreates it, while Flux keeps its applied state.

On the test VM, recovery was measured at 82 seconds. The A0 Kustomization's
two-minute timeout covers its reconciliation and health check; it does not
bound OCI fetching and verification, controller scheduling or retries, the
root Kustomization's separate five-minute wait, or complete recovery. Doctor
requests reconciliation and returns; rerun `sudo lifemodel doctor` to confirm
the new release is ready. During a rollout, the old loader keeps serving only
while the replacement never becomes Ready. If the replacement becomes Ready
and fails later, the old pod may already have been retired.

The previous successfully applied ref is kept in `/var/lib/lifemodel/platform-history`.
It advances only after the bootstrap writer successfully applies the configured
root objects.
