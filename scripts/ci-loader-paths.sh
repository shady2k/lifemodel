#!/bin/sh
# ci-loader-paths.sh — does this change owe the loader-image build?
#
# Reads the classifier's output on stdin (the same file the `changes` job
# writes to $RUNNER_TEMP: one "changed: <path>" line per path and the product
# verdict on the last line) and prints "loader_image=true" or
# "loader_image=false" as its one output line, which CI appends to
# $GITHUB_OUTPUT. The `changes` job of .github/workflows/ci.yml calls it after
# scripts/ci-verdict.sh, the way it calls scripts/ci-web-provenance-paths.sh.
#
# The paths are the loader image's inputs, read off docker/loader/Dockerfile
# and scripts/release/prepare-loader-context.sh:
#
#   * loader/ — the loader program the build stage compiles;
#   * web/loader/ and web/kit/ — the browser UI and the shared kit the
#     ui-build stage copies and builds;
#   * src/web/model-status.ts and src/web/contract.ts — the shared status
#     projection and its wire contract, copied into the ui-build stage;
#   * src/ports/message-attachment.ts — the shared attachment metadata type
#     imported by that wire contract;
#   * package.json and package-lock.json — installed by the ui-build stage,
#     which also runs the manifest's build:loader-ui script;
#   * docker/loader/ — the Dockerfile the job builds;
#   * .dockerignore — the context filter Docker reads when it assembles this
#     job's build context: it decides which of the files above reach the build;
#   * deploy/platform/ — the release tree whose kustomization the seed bundle
#     carries;
#   * scripts/release/ — the context script and the digest pinners the job
#     calls.
#
# A change to anything else cannot change what this image builds. No record at
# all is no evidence of safety either: when the producer emits no "changed:"
# line -- ci.yml's unknown-range fallback feeds it `ci-product-paths.sh
# < /dev/null`, which answers product=true with no records -- no path was
# readable, so the image is selected, the way the producer itself answers
# product=true on no input. No network, no clock, no arguments: the same list
# always gets the same answer. Its behaviour is pinned by
# tests/unit/ci-loader-paths.test.ts.
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
        loader/*|web/loader/*|web/kit/*|docker/loader/*|.dockerignore|deploy/platform/*|scripts/release/*|src/web/model-status.ts|src/web/contract.ts|src/ports/message-attachment.ts|src/ports/task-harness-registry.json|package.json|package-lock.json)
            selected=true ;;
    esac
done
# Nothing was read: the range was unreadable, so the build is owed.
[ "$read_any" = true ] || selected=true
printf 'loader_image=%s\n' "$selected"
