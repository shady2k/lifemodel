#!/bin/sh
# ci-nix-paths.sh — does this change owe the nix flake check?
#
# Reads the classifier's output on stdin (the same file the `changes` job
# writes to $RUNNER_TEMP: one "changed: <path>" line per path and the product
# verdict on the last line) and prints "nix_flake_check=true" or
# "nix_flake_check=false" as its one output line, which CI appends to
# $GITHUB_OUTPUT. The `changes` job of .github/workflows/ci.yml calls it after
# scripts/ci-loader-paths.sh, the way it calls that script after
# scripts/ci-web-provenance-paths.sh.
#
# The paths are the inputs `nix flake check` reads, read off flake.nix (and
# through it, deploy/nixos/default.nix):
#
#   * flake.nix and flake.lock — the flake and the inputs nix resolves it
#     against;
#   * .github/workflows/release.yml — read for the keyless subject the module
#     pins (lifemodel-73e);
#   * deploy/ — the exported NixOS module, the platform manifests every
#     platform check kustomizes and helm-renders, the installer templates and
#     the CLI the checks run;
#   * scripts/install.sh, scripts/check-k3s-commands.mjs and
#     scripts/check-platform-crd-schemas.py — the installer the installer
#     checks render, and the two check programs the platform checks run;
#   * tests/fixtures/nixos/ — the fixtures the rendered objects are compared
#     against.
#
# A change to anything else cannot change what the flake evaluates, and the
# job stays rare the way the owner asked. No record at all is no evidence of
# safety either: when the producer emits no "changed:" line -- ci.yml's
# unknown-range fallback feeds it `ci-product-paths.sh < /dev/null`, which
# answers product=true with no records -- no path was readable, so the check
# is selected, the way the producer itself answers product=true on no input.
# No network, no clock, no arguments: the same list always gets the same
# answer. Its behaviour is pinned by tests/unit/ci-nix-paths.test.ts.
set -eu
selected=false
read_any=false
while IFS= read -r line || [ -n "$line" ]; do
    # The producer emits `changed: <path>` lines followed by its own verdict.
    # Ignore the verdict and classify only paths from the producer's contract.
    case "$line" in
        "changed: "*) path=${line#"changed: "} ;;
        *) continue ;;
    esac
    read_any=true
    case "$path" in
        flake.nix|flake.lock|.github/workflows/release.yml|deploy/*|scripts/install.sh|scripts/check-k3s-commands.mjs|scripts/check-platform-crd-schemas.py|tests/fixtures/nixos/*)
            selected=true ;;
    esac
done
# Nothing was read: the range was unreadable, so the check is owed.
[ "$read_any" = true ] || selected=true
printf 'nix_flake_check=%s\n' "$selected"
