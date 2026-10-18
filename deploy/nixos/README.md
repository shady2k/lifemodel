# lifemodel platform installation

## Generic Linux (Debian/Ubuntu)

Use a dedicated host with an x86-64-v2 CPU or newer. Download the **installer
release asset**, not GitHub's automatically generated source archive. The
latest release provides an asset named `lifemodel-installer-v<VERSION>.tar.gz`.
The bundle contains `scripts/install.sh`, root templates, mDNS units and the
recovery CLI. Its platform URL and verified platform digest are already stamped.

With the GitHub CLI installed, download and extract the latest installer in a
clean directory:

```sh
mkdir lifemodel-install
cd lifemodel-install
gh release download --repo shady2k/lifemodel --pattern 'lifemodel-installer-*.tar.gz'
tar -xzf lifemodel-installer-*.tar.gz
sudo sh scripts/install.sh
```

There are **no required parameters**. The default name is `lifemodel`; the LAN
interface comes from the lowest-metric IPv4 default route. To select a specific
release rather than latest, add its tag (for example `v1.0.0`) to the
`gh release download` command and download that release's installer asset.
Never run `scripts/install.sh` from the source archive expecting a release pin.

Optional flags (run `sh scripts/install.sh --help` for all flags):

- `--name home` sets the instance DNS label on first installation.
- `--lan-interface eth0` selects the LAN interface explicitly.
- `--platform-url oci://REGISTRY/PATH` selects another platform source.
- `--digest sha256:<64 lowercase hex characters>` explicitly selects another
  release by digest; `--tag v1.0.0` selects a tag instead. These are mutually
  exclusive. Signature verification remains enabled.
- `--verify key --public-key-file FILE` selects trusted-key verification instead
  of the default keyless verification. `--issuer` and `--subject-regex` tune the
  keyless identity. `--insecure-registry` is only for a VM-local HTTP registry.
- `--render-only DIR` writes the rendered manifests without installing anything;
  `--root-templates DIR` overrides the packaged root templates.

The installer runs as root, installs k3s, Flux and LAN name publication, then
waits for verified HTTPS before printing the address and
"SHA-256 fingerprint of the CA certificate (DER)". If it times out, it names the
first unready step and points to `lifemodel doctor`. Later, run
`sudo lifemodel address` to print the established address and CA fingerprint.

The name and selected digest (or explicitly chosen tag) persist in
`/etc/lifemodel/instance.env`. Rerunning the installer without release flags
keeps that saved name and digest, **even from a newer installer bundle**. To
change the release, pass `--digest` or `--tag` explicitly (and `--platform-url`
if needed). The established name cannot change: a different `--name` is refused
before any host change. The installer also recovers identity from
`/var/lib/lifemodel/instance-name` and the cluster's `lifemodel-instance`
ConfigMap, and refuses conflicts between surviving records. Do not edit the
saved record as shell code; only validated literal assignments are accepted.

## NixOS


Add this flake as an input and enable `services.lifemodel` on the dedicated VM:

```nix
{ inputs, ... }: {
  imports = [ inputs.lifemodel.nixosModules.default ];
  services.lifemodel = {
    enable = true;
    name = "lifemodel"; # one DNS label, at most 57 characters
    # The platform URL and tag default to this flake's own release.
    # Pin the flake input to a versioned release before deploying it.
  };
}
```

The core image requires an x86-64-v2 CPU or newer for memory search. For a VM, configure the vCPU type as `host` or an x86-64-v2 model; a default `Common KVM processor` / `qemu64` may expose only x86-64-v1. `lifemodel doctor` warns if `/proc/cpuinfo` lacks `sse4_2` or `popcnt`.

Then run `sudo nixos-rebuild switch --flake .#HOST`. The module starts k3s
with embedded etcd and its bundled Traefik, installs Flux v2.9.6, and applies
the verified platform source, the instance ConfigMap, and root Kustomization. Set `services.lifemodel.name` before installation; it fixes `<name>.local` and `boot-<name>.local`. The bootstrap is a systemd
oneshot: an unchanged switch does not rerun it. Changing the configured platform
ref changes its unit script, so NixOS restarts the unit during the switch; a
failed bootstrap makes the switch fail. After applying, the unit waits up to
10 minutes for the loader's anonymous HTTPS state endpoint, with the instance CA
and loopback address resolution. Each request has a 10-second limit. Only then
does it log the address and the SHA-256 fingerprint of the CA certificate (DER).
Read these with `journalctl -u lifemodel-flux-bootstrap` or run
`sudo lifemodel address`. A timeout names the first unready step and points to
`lifemodel doctor`. To re-apply without changing the
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

See [ADR-010](../../docs/adr/010-container-generations.md) for the platform decision.

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
