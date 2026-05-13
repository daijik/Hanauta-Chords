# ── 開発ステージ ──────────────────────────────────────
FROM registry.access.redhat.com/ubi9/nodejs-20:latest AS dev

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev"]

# ── ビルドステージ ────────────────────────────────────
FROM registry.access.redhat.com/ubi9/nodejs-20:latest AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── 本番ステージ ──────────────────────────────────────
FROM registry.access.redhat.com/ubi9/nginx-120:latest AS prod

COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
