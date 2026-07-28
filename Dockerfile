# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.server.json ./
COPY src ./src
COPY server ./server
COPY public ./public
COPY migrations ./migrations
RUN pnpm run build && pnpm run build:server

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PORT=8787
ENV DATABASE_PATH=/data/outlook-email.db
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/migrations ./migrations
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY warmup.cjs ./warmup.cjs
RUN mkdir -p /data && chown node:node /data

EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["docker-entrypoint.sh"]
