# ── 開発ステージ ──────────────────────────────────────
FROM registry.access.redhat.com/ubi9/nodejs-20:latest AS dev

USER root
RUN mkdir -p /app && chown -R 1001:0 /app
USER 1001

WORKDIR /app
COPY --chown=1001:0 package*.json ./
RUN npm ci
COPY --chown=1001:0 . .
EXPOSE 5173
CMD ["npm", "run", "dev"]

# ── ビルドステージ ────────────────────────────────────
FROM registry.access.redhat.com/ubi9/nodejs-20:latest AS build

USER root
RUN mkdir -p /app && chown -R 1001:0 /app
USER 1001

WORKDIR /app
COPY --chown=1001:0 package*.json ./
RUN npm ci
COPY --chown=1001:0 . .
RUN npm run build

# ── 本番ステージ ──────────────────────────────────────
FROM registry.access.redhat.com/ubi9/nginx-120:latest AS prod

USER root
COPY --from=build --chown=1001:0 /app/dist /usr/share/nginx/html
USER 1001

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
