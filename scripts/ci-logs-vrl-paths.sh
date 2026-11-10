#!/bin/sh
# ci-logs-vrl-paths.sh — does this change owe the collector's record-contract
# check (ADR-016 §2 and §9 point 4, check L02)?
#
# Reads the classifier's output on stdin (the same file the `changes` job
# writes to $RUNNER_TEMP: one "changed: <path>" line per path and the product
# verdict on the last line) and prints "logs_vrl_check=true" or
# "logs_vrl_check=false" as its one output line, which CI appends to
# $GITHUB_OUTPUT. The `changes` job of .github/workflows/ci.yml calls it after
# scripts/ci-nix-paths.sh, the way it calls that script after
# scripts/ci-loader-paths.sh.
#
# The paths are what scripts/check-logs-vrl.mjs reads and executes:
#
#   * deploy/platform/logs/ — the collector configuration whose normalize
#     program is the record contract;
#   * src/core/logger.ts, src/core/trace-context.ts, src/core/core-loop.ts and
#     src/core/globals.ts — the logger the check reads real lines from, the
#     trace context that carries the turn's conversation, where the turn's
#     context is made, and the primary recipient the rule falls back to;
#   * src/layers/cognition/ — the turn the seed drives: its processor, its
#     recipient rule and its agentic loop;
#   * loader/ — the loader image's own stdout logger and the fatal line, both
#     fed through the program;
#   * tests/fixtures/logs-vrl/ — the seeds that write the real lines and the
#     contract fixtures;
#   * tests/helpers/ — the container-shaped harness the turn seed starts;
#   * scripts/check-logs-vrl.mjs, scripts/logs-record-shape.mjs,
#     scripts/logs-vector-runner.mjs, scripts/logs-vrl-real-loggers.mjs and
#     scripts/logs-heartbeat-check.mjs — the check and the modules that build
#     its cases and run them;
#   * package.json and package-lock.json — the logger's own dependencies (pino
#     writes the record) and the toolchain the seeds run under;
#   * docker/logs-vrl/ — the image the job runs the check in.
#
# A change to anything else cannot change what the check reads. No record at
# all is no evidence of safety either: when the producer emits no "changed:"
# line -- ci.yml's unknown-range fallback feeds it `ci-product-paths.sh
# < /dev/null`, which answers product=true with no records -- no path was
# readable, so the check is selected, the way the producer itself answers
# product=true on no input. No network, no clock, no arguments: the same list
# always gets the same answer. Its behaviour is pinned by
# tests/unit/ci-logs-vrl-paths.test.ts.
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
        deploy/platform/logs/*|src/core/logger.ts|src/core/trace-context.ts|src/core/core-loop.ts|src/core/globals.ts|src/layers/cognition/*|loader/*|tests/fixtures/logs-vrl/*|tests/helpers/*|scripts/check-logs-vrl.mjs|scripts/logs-record-shape.mjs|scripts/logs-vector-runner.mjs|scripts/logs-vrl-real-loggers.mjs|scripts/logs-heartbeat-check.mjs|package.json|package-lock.json|docker/logs-vrl/*)
            selected=true ;;
    esac
done
# Nothing was read: the range was unreadable, so the check is owed.
[ "$read_any" = true ] || selected=true
printf 'logs_vrl_check=%s\n' "$selected"
