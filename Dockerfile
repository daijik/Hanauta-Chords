# ── 開発ステージ ──────────────────────────────────────────────────────────────
FROM registry.access.redhat.com/ubi9/nodejs-20:latest AS dev

USER root
RUN mkdir -p /app && chown -R 1001:0 /app
USER 1001

WORKDIR /app
COPY --chown=1001:0 package*.json ./
RUN npm ci
COPY --chown=1001:0 . .

EXPOSE 5173
CMD ["node", "server.js"]

# ── ビルドステージ ────────────────────────────────────────────────────────────
FROM registry.access.redhat.com/ubi9/nodejs-20:latest AS build

USER root
RUN mkdir -p /app && chown -R 1001:0 /app
USER 1001

WORKDIR /app
COPY --chown=1001:0 package*.json ./
RUN npm ci
COPY --chown=1001:0 . .
RUN npm run build

# ── 本番ステージ ──────────────────────────────────────────────────────────────
FROM registry.access.redhat.com/ubi9/nodejs-20:latest AS prod

USER root
RUN mkdir -p /app && chown -R 1001:0 /app
USER 1001

WORKDIR /app
COPY --chown=1001:0 package*.json ./
RUN npm ci --omit=dev

COPY --from=build --chown=1001:0 /app/dist ./dist
COPY --chown=1001:0 server.js ./

EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production
CMD ["node", "server.js"]
