# One release-commit workbench, separate from core. No installs at task startup.
# Linux/amd64 native v2 binary is checksum pinned. Other architectures
# fail closed until they have a reviewed binary/checksum and offline receipt.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS cli-build
WORKDIR /build
COPY loader/package.json loader/package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts --no-update-notifier --loglevel=http
COPY loader/tsconfig.json ./
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
 && apt-get install -y --no-install-recommends ca-certificates curl git build-essential python3 ripgrep strace \
 && rm -rf /var/lib/apt/lists/* /tmp/debian.InRelease

# Pinned native v2 npm archive. Registry SHA-512 was verified during research;
# its independently recorded SHA-256 below is checked before extraction.
ENV OPENCODE_VERSION=2.1.4 \
    OPENCODE_SHA256=ce05abe2dce1041391c8ec8cdb8da066f640fd471e72ac846dcb089c441e11e1
RUN test "$(dpkg --print-architecture)" = amd64 \
 && curl --fail --location --retry 3 "https://registry.npmjs.org/@opencode/cli-linux-x64/-/cli-linux-x64-${OPENCODE_VERSION}.tgz" -o /tmp/opencode.tar.gz \
 && echo "${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/opencode.tar.gz -C /tmp package/bin/opencode \
 && install -m 0555 /tmp/package/bin/opencode /usr/local/bin/opencode \
 && rm -rf /tmp/package /tmp/opencode.tar.gz

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
COPY --from=cli-build /build/dist/storage-cli-main.js /build/dist/storage-cli.js /build/dist/task-*.js /opt/lifemodel/loader/dist/
COPY --chown=root:root --chmod=0555 docker/loader/lifemodel-storage /usr/local/bin/lifemodel-storage
COPY --chown=root:root --chmod=0555 docker/workbench/lifemodel-task-launcher /usr/local/bin/lifemodel-task-launcher
COPY --chown=root:root docker/workbench/opencode.json /etc/lifemodel/opencode.json

# Config roots are immutable. v2 has no v1 plugin bootstrap dependency.
RUN mkdir -p /etc/lifemodel/xdg/opencode \
 && chmod 0555 /etc/lifemodel/xdg /etc/lifemodel/xdg/opencode
COPY src/ports/task-harness-registry.json /opt/lifemodel/src/ports/task-harness-registry.json

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
