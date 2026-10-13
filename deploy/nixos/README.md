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
the verified platform source and root Kustomization. Keyless verification is
the default. For key verification set `verify.mode = "key"` and
`verify.publicKey` to the PEM public key text. Use `platform.digest` instead of
a mutable tag when pinning an artifact by digest. `platform.insecureRegistry`
is only for a VM-local plain-HTTP registry.


## When the loader is broken

SSH to the dedicated VM and run `sudo lifemodel doctor`. It reports Flux source
and Kustomization readiness, revisions, and loader pod health. To restore the
previous successfully applied platform release, run
`sudo lifemodel doctor --repin previous`. This patches the root `platform`
OCIRepository and requests a Flux reconcile. Recovery completes within the
A0 Kustomization's 2-minute timeout plus the loader's start time. The old
loader keeps serving during a broken rollout. On NixOS, a later
`nixos-rebuild switch` reapplies the configured pin, so copy the exact
`services.lifemodel.platform.tag` or `.digest` setting printed by the command
into the host configuration before rebuilding. The previous pin is kept in
`/var/lib/lifemodel/platform-history`; it is advanced only after the installer
or NixOS bootstrap successfully applies the configured root objects.
