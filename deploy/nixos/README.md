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
