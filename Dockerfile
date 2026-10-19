# syntax = docker/dockerfile:1

# Kiln: build the Next.js shell to static files, then run one Node process
# (server/main.ts, type-stripped TypeScript) that serves them, owns every
# room's simulation and speaks WebSocket at /ws. node:sqlite on the /data
# volume, so there's no native module to compile. Versions follow mise.toml.

FROM node:24.21.0-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY next.config.ts tsconfig.json ./
COPY app/ ./app/
COPY client/ ./client/
COPY shared/ ./shared/
RUN NEXT_TELEMETRY_DISABLED=1 pnpm build

FROM node:24.21.0-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY server/ ./server/
COPY shared/ ./shared/
COPY --from=build /app/out ./out
COPY README.md ./
ENV DATA_DIR=/data NODE_ENV=production
CMD ["node", "server/main.ts"]
