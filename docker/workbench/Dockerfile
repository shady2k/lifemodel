# One release-commit workbench, separate from core. No installs at task startup.
# Linux/amd64 baseline binary supports hosts without AVX2. Other architectures
# fail closed until they have a reviewed binary/checksum and offline receipt.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS cli-build
WORKDIR /build
COPY loader/package.json loader/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY loader/tsconfig.json ./
COPY loader/src/ ./src/
RUN npm run build

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
LABEL org.opencontainers.image.title="lifemodel-workbench" \
      org.opencontainers.image.source="https://github.com/shady2k/lifemodel" \
      org.opencontainers.image.licenses="MIT"

# Debian archive is frozen as well as Node: apt's signed indexes pin the native
# toolchain and its transitive libraries, not the changing bookworm mirrors.
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261015T000000Z bookworm main\n' > /etc/apt/sources.list \
 && apt-get update -o APT::Update::Error-Mode=any \
 && apt-get install -y --no-install-recommends ca-certificates curl git build-essential python3 ripgrep \
 && rm -rf /var/lib/apt/lists/*

# Official native release archive; no npm postinstall platform selection or
# downloader at runtime. Checksum from the exact release's asset metadata.
ENV OPENCODE_VERSION=1.19.4 \
    OPENCODE_SHA256=1697ef40558d378bd2f72efa8fafe1bed1f0e664f09247b9357556b95dbc7cbc
RUN test "$(dpkg --print-architecture)" = amd64 \
 && curl --fail --location --retry 3 "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-x64-baseline.tar.gz" -o /tmp/opencode.tar.gz \
 && echo "${OPENCODE_SHA256}  /tmp/opencode.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin opencode \
 && chmod 0555 /usr/local/bin/opencode \
 && rm /tmp/opencode.tar.gz

# Keep all development dependencies, including native modules, from THIS source
# lock. Do not copy an owner .npmrc (it could contain credentials). The only
# install policy is the repository's legacy-peer-deps=true, passed explicitly.
WORKDIR /opt/lifemodel
COPY package.json package-lock.json ./
RUN HUSKY=0 npm ci --legacy-peer-deps --no-audit --no-fund \
 && test -d /opt/lifemodel/node_modules \
 && npm cache clean --force
COPY --from=cli-build /build/package.json /opt/lifemodel/loader/package.json
COPY --from=cli-build /build/dist/storage-cli-main.js /build/dist/storage-cli.js /build/dist/task-launcher-main.js /opt/lifemodel/loader/dist/
COPY --chown=root:root --chmod=0555 docker/loader/lifemodel-storage /usr/local/bin/lifemodel-storage
COPY --chown=root:root --chmod=0555 docker/workbench/lifemodel-task-launcher /usr/local/bin/lifemodel-task-launcher
COPY --chown=root:root docker/workbench/opencode.json /etc/lifemodel/opencode.json

# The Job mounts its PRIVATE working volume at /work (uid/gid/fsGroup 1000).
# No /tmp write is needed: HOME, XDG and TMPDIR all live on that volume.
RUN mkdir -p /work/home /work/tmp \
 && chown -R 1000:1000 /work
ENV HOME=/work/home \
    TMPDIR=/work/tmp \
    XDG_CONFIG_HOME=/work/home/.config \
    XDG_CACHE_HOME=/work/home/.cache \
    XDG_DATA_HOME=/work/home/.local/share \
    XDG_STATE_HOME=/work/home/.local/state \
    OPENCODE_CONFIG=/etc/lifemodel/opencode.json \
    OPENCODE_DISABLE_AUTOUPDATE=true \
    OPENCODE_DISABLE_MODELS_FETCH=true \
    OPENCODE_DISABLE_PROJECT_CONFIG=true \
    OPENCODE_DISABLE_DEFAULT_PLUGINS=true \
    OPENCODE_DISABLE_LSP_DOWNLOAD=true \
    OPENCODE_DISABLE_EXTERNAL_SKILLS=true \
    OPENCODE_DISABLE_CLAUDE_CODE=true \
    OPENCODE_PURE=true
USER 1000:1000
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/lifemodel-task-launcher"]
