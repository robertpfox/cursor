# GrotFoxy has zero runtime dependencies, so the image is just Node plus source.
FROM node:22-alpine

RUN apk add --no-cache tini curl

WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY public ./public

ENV GROTFOXY_HOST=0.0.0.0 \
    GROTFOXY_PORT=8787 \
    GROTFOXY_DATA_DIR=/data \
    GROTFOXY_WORKSPACE_DIR=/workspace \
    NODE_ENV=production

RUN mkdir -p /data /workspace && chown -R node:node /data /workspace /app
VOLUME ["/data", "/workspace"]
EXPOSE 8787
USER node

HEALTHCHECK --interval=30s --timeout=4s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:8787/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--experimental-sqlite", "--no-warnings", "src/index.js"]
