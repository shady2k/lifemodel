# The loader image (ADR-010, platform step A0 - lifemodel-lut.2.1).
#
# A platform-mode loader: the program Flux deploys into `lifemodel-system`
# while the cluster has NO Docker socket and nothing to supervise. It carries
# the loader and nothing else - no Caddy, no Agent Vault, no seed bundle, no
# lifemodel - because in platform mode the loader reads none of them. It comes
# up, serves its interface and login on one port, and waits.
#
# Build it from the checkout root (the context is the whole repository):
#
#   docker build -f docker/loader/Dockerfile -t lifemodel-loader:local .
#
# The runtime runs as a non-root user, holds a read-only root filesystem, and
# writes only to /var/lib/loader (a volume: the password and session secret
# survive a restart) and to /tmp. LIFEMODEL_LOADER_MODE=platform starts it in
# platform mode; the port is the loader's own 7000 on every interface.

ARG NODE_IMAGE=node:24-bookworm-slim

# The loader is a TypeScript program with its own package.json in loader/
# (lifemodel-q4x.2.1): it is compiled here, once, with its own manifests, so
# the runtime stage carries the built dist/ and nothing of the toolchain.
FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY loader/package.json loader/package-lock.json ./
RUN npm ci
COPY loader/ ./
RUN npm run build \
 && npm prune --omit=dev

# ----------------------------------------------------------------- runtime --
FROM ${NODE_IMAGE}

LABEL org.opencontainers.image.title="lifemodel-loader" \
      org.opencontainers.image.description="The lifemodel loader in platform mode: one login and one interface for the platform" \
      org.opencontainers.image.source="https://github.com/shady2k/lifemodel" \
      org.opencontainers.image.licenses="MIT"

# One unprivileged identity for the runtime. The base image already carries a
# user and group named `node` with uid and gid 1000; renaming them keeps the
# image free of a second identity and the loader free of a fixed uid choice.
RUN groupmod --new-name loader node \
 && usermod --login loader --comment "the lifemodel loader" --home /var/lib/loader --shell /usr/sbin/nologin node \
 && mkdir -p /var/lib/loader \
 && chown loader:loader /var/lib/loader \
 && chmod 0700 /var/lib/loader

# The loader: dist/, its runtime dependencies and nothing else - not its
# sources, not the toolchain. Root-owned; the `loader` user runs it and
# cannot change it.
COPY --from=build --chown=root:root /build /opt/lifemodel/loader
# Release builds provide this full-history bundle in their build context.
COPY --chown=root:root .docker-context/seed.bundle /opt/lifemodel/seed.bundle

USER loader
WORKDIR /var/lib/loader

# The mode is the deployment's decision, named here because this image exists
# for it; the volume root is the one writable path (a volume: the password
# and session secret survive a restart), and /tmp is the process's own.
# The port is the loader's own, on every interface so a Service can reach it
# (the instance image binds the loopback inside its container).
VOLUME ["/var/lib/loader"]
ENV LIFEMODEL_LOADER_MODE=platform \
    LIFEMODEL_VOLUME_ROOT=/var/lib/loader \
    NODE_ENV=production

EXPOSE 7000

# No init: one Node process, nothing to reap. Node forwards SIGTERM to its
# handlers (loader/src/main.ts), so `kubectl delete pod` drains it.
ENTRYPOINT ["node", "/opt/lifemodel/loader/dist/main.js"]
