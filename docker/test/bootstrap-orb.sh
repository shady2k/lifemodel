#!/bin/sh
# bootstrap-orb.sh — provision a disposable OrbStack isolated machine for the
# lifemodel Docker integration tests (lifemodel-q4x.5.3).
#
# Runs INSIDE the disposable machine only. scripts/test-docker-isolated.mjs
# streams this script and the pinned artifacts into /opt/lifemodel-provision
# and runs the stages:
#   root   (as root)      apt prerequisites, subordinate ids, pinned docker
#                         static + rootless-extras + node extraction, checks
#   repo   (as lifemodel) generate a fresh private git repository from the
#                         streamed source snapshot (no owner history)
#   daemon (as root)      start the user's rootless Docker daemon and wait
#                         until it answers `docker info`
#
# The machine is disposable and deleted after the run; nothing here is
# reusable state. The machine shares OrbStack's Linux kernel (not a hardware
# VM). No credentials, no LLM keys, no host mounts — the pinned artifacts and
# the sanitized source snapshot arrive as tar streams over stdin.
#
# Rootless prerequisites per https://docs.docker.com/engine/security/rootless/:
# newuidmap/newgidmap (the uidmap package) and at least 65536 subordinate
# UIDs/GIDs for the daemon user in /etc/subuid and /etc/subgid.

set -eu

PROVISION_DIR=/opt/lifemodel-provision
USER_NAME=lifemodel
HOME_DIR=/home/lifemodel
SRC_DIR="$HOME_DIR/src"
DOCKER_VERSION=29.9.0
NODE_VERSION=24.21.0
SUBORDINATE_START=100000
SUBORDINATE_COUNT=65536

log() { printf '[bootstrap-orb] %s\n' "$*"; }

die() { printf '[bootstrap-orb] FATAL: %s\n' "$*" >&2; exit 1; }

as_user() {
    su -s /bin/sh "$USER_NAME" -c "$1"
}

# Refuse to run outside the disposable isolated machine: the helper writes a
# marker into /opt/lifemodel-provision right after creating the machine.
guard() {
    [ -f "$PROVISION_DIR/.machine-id" ]         || die "no $PROVISION_DIR/.machine-id — these stages run only inside the disposable isolated machine"
}

stage_root() {
    guard
    log "installing system prerequisites inside the machine"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y --no-install-recommends \
        uidmap fuse-overlayfs iptables iproute2 xz-utils git ca-certificates

    for f in /etc/subuid /etc/subgid; do
        grep -q "^${USER_NAME}:" "$f" \
            || echo "${USER_NAME}:${SUBORDINATE_START}:${SUBORDINATE_COUNT}" >> "$f"
    done

    log "extracting pinned docker ${DOCKER_VERSION} static binaries"
    tmp=$(mktemp -d)
    tar -xzf "$PROVISION_DIR/docker-${DOCKER_VERSION}.tgz" -C "$tmp"
    install -m 0755 "$tmp"/docker/* /usr/local/bin/
    log "extracting pinned docker rootless extras ${DOCKER_VERSION}"
    tar -xzf "$PROVISION_DIR/docker-rootless-extras-${DOCKER_VERSION}.tgz" -C "$tmp"
    install -m 0755 "$tmp"/docker-rootless-extras/* /usr/local/bin/
    rm -rf "$tmp"

    log "extracting pinned node ${NODE_VERSION}"
    tar -xJf "$PROVISION_DIR"/node-"${NODE_VERSION}"-linux-*.tar.xz -C /opt
    node_src=$(echo /opt/node-"${NODE_VERSION}"-linux-*)
    [ -d "$node_src" ] || die "node tarball did not extract where expected: $node_src"
    ln -sfn "$node_src" /opt/node24
    /opt/node24/bin/node --version

    log "verifying unprivileged user namespaces (unshare -Ur)"
    as_user 'unshare -Ur true' || die "unshare -Ur failed for ${USER_NAME}"

    test -f "$SRC_DIR/package.json" || die "source snapshot missing at $SRC_DIR"
    log "root stage done"
}

stage_repo() {
    guard
    [ "$(id -un)" = "$USER_NAME" ] || die "repo stage must run as ${USER_NAME}"
    cd "$SRC_DIR"
    if [ ! -d .git ]; then
        log "generating a fresh private git repository from the snapshot"
        git init -b main
        git config user.email "test@lifemodel.local"
        git config user.name "lifemodel test"
        git config commit.gpgsign false
        git add -A
        git commit -qm "source snapshot (private, generated inside the machine; no owner history)"
    fi
    log "repo stage done"
}

stage_daemon() {
    guard
    [ "$(id -un)" = "root" ] || die "daemon stage must run as root"
    uid=$(id -u "$USER_NAME")
    run_dir="/run/user/$uid"
    mkdir -p "$run_dir"
    chown "$USER_NAME" "$run_dir"
    chmod 700 "$run_dir"

    log "preparing the rootless daemon (user ${USER_NAME}, uid ${uid})"
    as_user "mkdir -p $HOME_DIR/.config/docker"
    as_user "printf '%s\n' '{\"storage-driver\":\"fuse-overlayfs\"}' > $HOME_DIR/.config/docker/daemon.json"
    as_user "touch $HOME_DIR/rootless-docker.log"

    start_daemon() {
        as_user "setsid env XDG_RUNTIME_DIR=$run_dir HOME=$HOME_DIR \
bash /usr/local/bin/dockerd-rootless.sh --storage-driver $1 \
>> $HOME_DIR/rootless-docker.log 2>&1 < /dev/null &"
    }

    wait_healthy() {
        i=0
        while [ "$i" -lt 90 ]; do
            if as_user "XDG_RUNTIME_DIR=$run_dir DOCKER_HOST=unix://$run_dir/docker.sock \
PATH=/usr/local/bin:/usr/bin:/bin docker info" >/dev/null 2>&1; then
                return 0
            fi
            i=$((i + 1))
            sleep 2
        done
        return 1
    }

    start_daemon fuse-overlayfs
    if wait_healthy; then
        log "rootless daemon healthy (fuse-overlayfs)"
    else
        log "fuse-overlayfs attempt did not become healthy; retrying once with vfs"
        start_daemon vfs
        if wait_healthy; then
            log "rootless daemon healthy (vfs)"
        else
            printf '[bootstrap-orb] FATAL: rootless docker did not become healthy\n' >&2
            tail -n 50 "$HOME_DIR/rootless-docker.log" >&2 2>/dev/null || true
            exit 1
        fi
    fi

    as_user "XDG_RUNTIME_DIR=$run_dir DOCKER_HOST=unix://$run_dir/docker.sock \
PATH=/usr/local/bin:/usr/bin:/bin docker info --format '{{.ServerVersion}}'"
    log "daemon stage done"
}

case "${1:-}" in
    root) stage_root ;;
    repo) stage_repo ;;
    daemon) stage_daemon ;;
    *) die "usage: bootstrap-orb.sh root|repo|daemon (run by scripts/test-docker-isolated.mjs)" ;;
esac
