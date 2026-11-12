#!/bin/sh
# ci-logs-vrl.sh — run the collector's record-contract check (ADR-016 §2 and §9
# point 4, check L02) on a runner.
#
# The check needs the pinned Vector binary and this checkout's dependencies, and
# CI installs nothing on the host (AGENTS.md, "Test isolation"): both are baked
# into docker/logs-vrl/Dockerfile, and the check runs inside that image with no
# network and no Docker socket. The image is built from this checkout, so the
# check reads the change under test and not a copy of it.
#
# Called by the `ci-logs-vrl` job of .github/workflows/ci.yml for a pull request
# that touches what the check reads (scripts/ci-logs-vrl-paths.sh selects it),
# and runnable by hand the same way:
#
#   scripts/ci-logs-vrl.sh
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
image="lifemodel-logs-vrl:${GITHUB_SHA:-local}"
printf 'ci-logs-vrl: building %s\n' "$image"
docker build --file docker/logs-vrl/Dockerfile --tag "$image" .
printf 'ci-logs-vrl: running the collector contract check\n'
docker run --rm --network none "$image"
