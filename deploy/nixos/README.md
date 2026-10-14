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

SSH to the VM and run `sudo lifemodel doctor`. The doctor reads the cluster
through k3s kubectl; it does not print Secret values. It reports whether
OpenBao is initialized and sealed, every Flux OCIRepository and GitRepository
in `flux-system`, and every Flux Kustomization there, including Ready state,
observed generation, reason, message and artifact or applied revision. An
uninitialised or sealed OpenBao, unavailable status, or a non-ready or stale
Flux resource fails the check. A missing application GitRepository is expected
before the loader creates the application sources.

The doctor reads `lifemodel-system/loader-bootstrap-state`. A missing phase is
reported as `not started`; a valid `running` or `complete` phase reports its
name and status. A malformed record or `failed` phase fails the check. It
checks the `lifemodel` and `lifemodel-motor` GitRepositories and
Kustomizations in their own namespaces. While the loader has not reached its
final `gitea-application-kustomizations` phase, missing application resources
are reported as expected; after that phase is complete, or after a failed or
invalid phase, missing resources fail the check. Present application
resources must be Ready at their current generation. The doctor also checks
that the Gitea Deployment has ready replicas at its current generation and
that the loader Deployment and its pods are running and ready at the current
generation; it reports pod restarts and the latest related event. Any failed
check returns a non-zero status.

To restore the previous successfully applied platform release, run
`sudo lifemodel doctor --repin previous`. The doctor saves a durable override
against the currently configured tag or digest and restarts the bootstrap
writer; it does not patch the cluster itself. The writer uses the override
only while the configured reference still matches the recorded value. An
unchanged NixOS switch keeps it. Changing the configured tag or digest makes
the configured reference win and removes the override. Run
`sudo lifemodel doctor --repin clear` to remove it explicitly. The doctor
reports an active override prominently. If another field manager owns the
root OCIRepository `spec.ref`, the writer refuses to apply and reports the
manager. Delete that object to reset ownership; Flux keeps its applied state:

```sh
sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml delete ocirepository platform -n flux-system
```

See [ADR-010](../adr/010-container-generations.md) for the platform decision.

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
