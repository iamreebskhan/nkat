# Multi-stage build for the NestJS API.
#
#   1. `deps`  — install dependencies once, share with later stages.
#   2. `build` — compile TS → dist/.
#   3. `dev`   — final stage for `docker compose up`. Mounts the source
#                tree at runtime; runs `nest start --watch`. Hot-reload
#                works inside the container because Vite isn't involved
#                here — Nest watches the bind-mounted dist/ output of
#                its own incremental compiler.
#   4. `prod`  — slim runtime image. `node dist/main.js`.
#
# Pin the Node major version to match `engines` in package.json.
ARG NODE_VERSION=22

# ---- deps stage ------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
# Install build essentials for native deps (pg, crypto bindings).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates dumb-init python3 build-essential \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# `npm ci` is preferred when a lock exists; fallback to `install` keeps
# a fresh checkout buildable.
RUN npm ci || npm install

# ---- build stage -----------------------------------------------------------
FROM deps AS build
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# ---- dev stage (used by docker-compose) -----------------------------------
FROM deps AS dev
ENV NODE_ENV=development
COPY tsconfig*.json nest-cli.json ./
# The compose file bind-mounts the host's backend/ over /app at runtime
# so edits trigger Nest's watch reload. The COPYs here are a fallback
# when running the image standalone.
COPY src ./src
COPY scripts ./scripts
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "start:dev"]

# ---- prod stage ------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS prod
WORKDIR /app
ENV NODE_ENV=production
# Install only runtime deps to shrink the image.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=build /app/dist ./dist
# Scripts are TS — bundle ts-node + their source so the EventBridge
# scheduled tasks can keep working.
COPY --from=build /app/scripts ./scripts
COPY --from=deps /usr/bin/dumb-init /usr/bin/dumb-init
USER node
EXPOSE 3000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
