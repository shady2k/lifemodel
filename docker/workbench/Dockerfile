# One release-commit workbench, separate from core. No installs at task startup.
# Both agents require verified pins for each supported architecture; missing pins fail the build.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS cli-build
WORKDIR /build
COPY loader/package.json loader/package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts --no-update-notifier --loglevel=http
COPY loader/tsconfig.json ./
COPY scripts/task-start-manifest.mjs /scripts/
COPY src/ports/task-agent-validation.* src/ports/task-harness-registry.json /src/ports/
COPY loader/src/ ./src/
RUN npm run build

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
LABEL org.opencontainers.image.title="lifemodel-workbench" \
      org.opencontainers.image.source="https://github.com/shady2k/lifemodel" \
      org.opencontainers.image.licenses="MIT"

# Pin snapshot content before apt uses it, even during the HTTP CA bootstrap.
# apt still verifies Debian signatures and index/package hashes. Compare the
# exact metadata apt used too: a second fetch cannot substitute a signed replay.
# This bookworm InRelease has no Valid-Until; no expiry override is needed.
ENV DEBIAN_INRELEASE_SHA256=77737fa4b34f2693e982cc9ee35736816c35a7778fc2d326cc1bbf5b301fe1aa
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && rm -rf /var/lib/apt/lists/* \
 && /usr/lib/apt/apt-helper download-file http://snapshot.debian.org/archive/debian/20261015T000000Z/dists/bookworm/InRelease /tmp/debian.InRelease "SHA256:${DEBIAN_INRELEASE_SHA256}" \
 && echo "${DEBIAN_INRELEASE_SHA256}  /tmp/debian.InRelease" | sha256sum -c - \
 && printf 'deb http://snapshot.debian.org/archive/debian/20261015T000000Z bookworm main\n' > /etc/apt/sources.list \
 && apt-get update -o APT::Update::Error-Mode=any \
 && cmp /tmp/debian.InRelease /var/lib/apt/lists/*_InRelease \
 && apt-get install -y --no-install-recommends ca-certificates curl git build-essential python3 python3-venv ripgrep strace \
 && rm -rf /var/lib/apt/lists/* /tmp/debian.InRelease

# Registry-owned architecture pins, extraction and immutable agent configuration.
COPY src/ports/task-harness-registry.json /opt/lifemodel/src/ports/task-harness-registry.json
COPY src/ports/task-agent-validation.mjs /opt/lifemodel/src/ports/task-agent-validation.mjs
COPY scripts/task-agent-provision.mjs scripts/task-agent-paths.mjs /opt/lifemodel/scripts/
COPY docker/workbench/ /opt/lifemodel/docker/workbench/
RUN node /opt/lifemodel/scripts/task-agent-provision.mjs > /tmp/install-agents.sh  && sh -ec "$(cat /tmp/install-agents.sh)"  && rm /tmp/install-agents.sh

# Keep all development dependencies, including native modules, from THIS source
# lock. Do not copy an owner .npmrc (it could contain credentials). The only
# install policy is the repository's legacy-peer-deps=true, passed explicitly.
WORKDIR /opt/lifemodel
COPY package.json package-lock.json ./
# Suppress every lifecycle during fetching. Only the audited native/local
# setup scripts below may run, in a separate build step with networking off.
# The bundled CPU ONNX runtime needs no unchecked CUDA GitHub release asset.
RUN npm ci --legacy-peer-deps --no-audit --no-fund --ignore-scripts --no-update-notifier --loglevel=http \
 && test -d /opt/lifemodel/node_modules \
 && npm cache clean --force
RUN --network=none ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm rebuild esbuild onnxruntime-node protobufjs sharp --foreground-scripts
COPY --from=cli-build /build/package.json /opt/lifemodel/loader/package.json
# Ship the complete compiled graph, including shared modules without a task- prefix.
COPY --from=cli-build /build/dist/ /opt/lifemodel/loader/dist/
COPY --chown=root:root --chmod=0555 docker/loader/lifemodel-storage /usr/local/bin/lifemodel-storage
COPY --chown=root:root --chmod=0555 docker/workbench/lifemodel-task-launcher /usr/local/bin/lifemodel-task-launcher
# The Job mounts its PRIVATE working volume at /work (uid/gid/fsGroup 1000).
# HOME, mutable XDG paths and TMPDIR live there; config stays immutable above.
RUN mkdir -p /work/home /work/tmp \
 && chown -R 1000:1000 /work
ENV HOME=/work/home \
    TMPDIR=/work/tmp \
    XDG_CONFIG_HOME=/etc/lifemodel/xdg \
    XDG_CACHE_HOME=/work/home/.cache \
    XDG_DATA_HOME=/work/home/.local/share \
    XDG_STATE_HOME=/work/home/.local/state
USER 1000:1000
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/lifemodel-task-launcher"]
