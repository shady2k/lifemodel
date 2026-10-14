# Core-only image for the Kubernetes core module.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /opt/lifemodel
COPY package.json package-lock.json tsconfig.json .npmrc ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Resolve and cache the exact local embedder model at build time. The application
# copies this cache into its writable /tmp data path before starting.
FROM build AS model
RUN node --input-type=module -e "import { pipeline, env } from '@huggingface/transformers'; env.cacheDir='/opt/model-cache'; env.allowLocalModels=true; await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', {dtype:'fp32'});"

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="lifemodel-core" \
      org.opencontainers.image.description="The lifemodel core module"
ENV NODE_ENV=production \
    DATA_PATH=/tmp/lifemodel \
    LOG_LEVEL=info \
    MOTOR_CORTEX_ENABLED=false \
    HOME=/tmp
WORKDIR /opt/lifemodel
COPY --from=build --chown=node:node /opt/lifemodel/package.json ./package.json
COPY --from=build --chown=node:node /opt/lifemodel/node_modules ./node_modules
COPY --from=build --chown=node:node /opt/lifemodel/dist ./dist
COPY --from=model /opt/model-cache /opt/model-cache
COPY docker/core/entrypoint.sh /usr/local/bin/lifemodel-core-entrypoint
RUN chmod 0555 /usr/local/bin/lifemodel-core-entrypoint
USER node
ENTRYPOINT ["/usr/local/bin/lifemodel-core-entrypoint"]
