# The lifemodel instance image (lifemodel-q4x, the decisions on the image and
# the front door).
#
# What it carries, and nothing else:
#
#   /opt/lifemodel/loader/      the LOADER: the trusted layer lifemodel cannot
#                               see or change, and the container's main process
#                               under tini (its login, panic and first start)
#   /usr/bin/caddy              the front door (decision 13), started by the
#                               loader
#   /etc/lifemodel/Caddyfile    the front door's routing, root-owned
#   /usr/local/bin/agent-vault  Agent Vault (decisions 4 and 12), the credential
#                               proxy that holds the keys; the loader starts it
#   /usr/local/bin/lifemodel    the loader's CLI: status, panic, resume
#   /opt/lifemodel/seed.bundle  the repository's history at this image's
#                               commit; the loader clones the instance's
#                               repository from it on first start
#
# It does NOT carry lifemodel's own sources. The instance's code is the git
# repository the loader makes on the volume, seeded once from the bundle: a
# newer image never overwrites it (story S7).
#
# Build it with scripts/build-image.sh, never with a bare `docker build`: that
# script makes the seed bundle first, and without it the COPY below fails,
# which is the honest error. It is also the one command CI runs.

ARG NODE_IMAGE=node:24-bookworm-slim

# The loader is a TypeScript program with its own package.json in loader/
# (lifemodel-q4x.2.1). It is built here so the image carries its dist/ and its
# runtime dependencies only.
FROM ${NODE_IMAGE} AS loader
WORKDIR /opt/lifemodel/loader
COPY loader/package.json loader/package-lock.json ./
RUN npm ci
COPY loader/ ./
RUN npm run build \
 && npm prune --omit=dev

# Caddy, pinned by version and digest: the binary is copied from the image the
# Caddy project publishes rather than rebuilt here. It is a static Go binary,
# so it runs in the runtime image as it is. To move the pin, change both parts
# (`docker buildx imagetools inspect caddy:<version>-alpine` prints the digest).
FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f AS caddy

# ----------------------------------------------------------------- runtime --
FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="lifemodel" \
      org.opencontainers.image.description="A lifemodel instance: the runtime, the loader and the front door" \
      org.opencontainers.image.source="https://github.com/shady2k/lifemodel" \
      org.opencontainers.image.licenses="MIT"

# tini is PID 1: it reaps what the loader leaves behind and passes SIGTERM on,
# so `docker stop` reaches the loader and lifemodel's drain through it.
# git is how the loader seeds the instance's repository from the bundle and how
# the instance keeps its own history.
#
# iptables and netbase are what the loader's egress rule is made of
# (lifemodel-q4x.3.2): before lifemodel starts, the loader fills its own chain
# with "uid 1000 reaches 127.0.0.1, everything else is REJECTed", so lifemodel
# leaves through Agent Vault's proxy or not at all. netbase's /etc/protocols is
# what iptables reads; making the rule needs the documented `--cap-add
# NET_ADMIN`, and a container without it does not start lifemodel (the loader
# says so in one line and leaves with a non-zero code).
#
# curl is there for the documented checks and for looking at the container from
# inside it.
#
# The native dependencies (onnxruntime from @huggingface/transformers, LanceDB,
# sharp) resolve against the libraries this base image already has: `ldd` on
# every linux-*.node and libonnxruntime.so in a node_modules installed for this
# base reports no missing library. Nothing else is added for them.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      iptables \
      netbase \
      tini; \
    rm -rf /var/lib/apt/lists/*

# Agent Vault, pinned by version and checked against the checksums the release
# publishes (lifemodel-q4x.3.1, decisions 4 and 12): the loader starts it as it
# starts Caddy, and it is the layer that holds the keys. The build either
# carries the published binary of THIS version or fails - a drifted or
# unverified download is not a trusted layer. Moving the pin is a change of its
# own, because Agent Vault's API is still changing.
ARG AGENT_VAULT_VERSION=0.40.0
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64|arm64) ;; \
      *) printf '%s\n' "the Agent Vault release carries no binary for $arch" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/Infisical/agent-vault/releases/download/v${AGENT_VAULT_VERSION}"; \
    archive="agent-vault_${AGENT_VAULT_VERSION}_linux_${arch}.tar.gz"; \
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL -o "/tmp/${archive}" "${base}/${archive}"; \
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL -o /tmp/agent-vault-checksums.txt "${base}/checksums.txt"; \
    awk -v archive="${archive}" '$2 == archive { print }' /tmp/agent-vault-checksums.txt > /tmp/agent-vault-checksum; \
    test "$(wc -l < /tmp/agent-vault-checksum)" -eq 1; \
    (cd /tmp && sha256sum -c agent-vault-checksum); \
    tar -xzf "/tmp/${archive}" -C /tmp agent-vault; \
    install -m 0755 /tmp/agent-vault /usr/local/bin/agent-vault; \
    rm -f "/tmp/${archive}" /tmp/agent-vault-checksums.txt /tmp/agent-vault-checksum /tmp/agent-vault

# The front door: the binary, and the routing the loader starts it with. Both
# are root-owned; lifemodel can read them and cannot write them.
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
COPY docker/instance/Caddyfile /etc/lifemodel/Caddyfile
COPY docker/instance/lifemodel-cli /usr/local/bin/lifemodel
RUN chmod 0755 /usr/local/bin/lifemodel

# The loader itself, built above: its dist/main.js is the container's main
# process (the ENTRYPOINT below) and its dist/cli.js is what the `lifemodel`
# command runs. It is copied as the whole directory, sources included, and kept
# root-only: lifemodel cannot see or change the trusted layer. Looking at it is
# root's work, and `docker exec` is root.
COPY --from=loader /opt/lifemodel/loader /opt/lifemodel/loader
RUN chmod 0700 /opt/lifemodel/loader

# lifemodel runs as an unprivileged user with uid and gid 1000 and no sudo:
# the user this base image already has for that id, given the instance's name
# and home. The loader starts lifemodel as this uid and owns the volume's
# repo/ and data/ directories with it.
RUN set -eux; \
    groupmod --new-name lifemodel node; \
    usermod --login lifemodel --home /var/lib/lifemodel --shell /usr/sbin/nologin node

# The code the image carries, as history. It is copied last: it changes with
# every commit, and nothing above it should be rebuilt for that.
COPY .docker-context/seed.bundle /opt/lifemodel/seed.bundle

# One volume per instance. The loader makes the directories inside it on first
# start: repo/ and data/ are lifemodel's, loader/ and vault/ are root's alone
# (0700). The image carries the code and the runtime, never the instance.
VOLUME /var/lib/lifemodel

# Caddy is the only web entrance; it listens on :80 inside the container and
# the documented `docker run` publishes it as 127.0.0.1:8080.
EXPOSE 80

WORKDIR /var/lib/lifemodel

# The loader is the container's main process, under tini. DATA_PATH is set for
# lifemodel by the loader, not here: one owner for that fact.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/lifemodel/loader/dist/main.js"]
