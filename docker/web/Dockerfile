# Standalone web module image; only its bundled server and built app ship at runtime.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /opt/lifemodel
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY src ./src
COPY web/app ./web/app
COPY web/kit ./web/kit
RUN npm run build:web

FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="lifemodel-web" \
      org.opencontainers.image.description="The lifemodel web interface"
ENV NODE_ENV=production HOME=/tmp LIFEMODEL_WEB_APP_DIRECTORY=/opt/lifemodel/web/app
WORKDIR /opt/lifemodel
COPY --from=build --chown=node:node /opt/lifemodel/dist/web/server.cjs ./dist/web/server.cjs
COPY --from=build --chown=node:node /opt/lifemodel/web/app/dist ./web/app
USER node
EXPOSE 8080 8081
CMD ["node", "dist/web/server.cjs"]
