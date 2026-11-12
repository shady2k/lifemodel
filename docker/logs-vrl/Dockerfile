# The check image for the collector's record contract (ADR-016 §2, check L02;
# scripts/check-logs-vrl.mjs).
#
# It exists so CI can run a check that needs two things the GitHub runner has
# only outside its own filesystem: the pinned Vector binary, and this
# checkout's dependencies. Neither is installed on the runner - CI installs
# nothing on the host (AGENTS.md, "Test isolation") - so both are baked here and
# the whole check runs inside this image with no network and no Docker socket.
#
# The Vector binary comes from the digest-pinned image the host run starts
# (scripts/logs-vector-runner.mjs names the same digest), copied as a file: the
# check only ever calls `vector test` and `vector --config`. Both base images are
# Debian trixie, which is what the binary is built against and therefore needs.
#
# The context is filtered by docker/logs-vrl/Dockerfile.dockerignore: only what
# the check reads is copied in.
ARG NODE_IMAGE=node:24.21.0-trixie-slim
ARG VECTOR_IMAGE=docker.io/timberio/vector@sha256:f6c23b5a7e16fb2838d33619ef7acf4bad2289a7cf22bc90efc2371f520c4ea2

FROM ${VECTOR_IMAGE} AS vector

FROM ${NODE_IMAGE}

# The pinned binary, under the name scripts/logs-vector-runner.mjs looks for.
COPY --from=vector /usr/bin/vector /usr/local/bin/vector
ENV LIFEMODEL_VECTOR_BIN=/usr/local/bin/vector

WORKDIR /app
# The installation policy is the checkout's own .npmrc, as the isolated test
# boundary uses it: legacy peer resolution, no registry override.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

# What the check reads and executes: the collector configuration, the core and
# loader loggers (and the core modules the real turn touches), the harness the
# turn seed drives, the seeds and fixtures, and the check programs themselves.
COPY deploy/platform/logs ./deploy/platform/logs
COPY src ./src
COPY loader ./loader
COPY tests/fixtures/logs-vrl ./tests/fixtures/logs-vrl
COPY tests/helpers ./tests/helpers
COPY scripts/check-logs-vrl.mjs scripts/logs-record-shape.mjs scripts/logs-vector-runner.mjs scripts/logs-vrl-real-loggers.mjs scripts/logs-heartbeat-check.mjs ./scripts/

# The check writes only temporary files; /tmp is theirs.
CMD ["node", "scripts/check-logs-vrl.mjs"]
