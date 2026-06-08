# Multi-stage build for the backend services (@pma/api gateway and
# @pma/ingestion runner). The web frontend has its own Dockerfile
# (apps/web/Dockerfile).
#
# The runtime image carries the full workspace (node_modules + every package's
# compiled dist); the running service is selected by the container command, e.g.
#   node packages/api/dist/main.js          # API gateway
#   node packages/ingestion/dist/main.js    # ingestion runner
#
# Node 22 (LTS) provides a global WebSocket, which the ingestion runner uses for
# the Polymarket price stream.

# ---- builder ----------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app

# Install dependencies first (better layer caching). Copy the root manifest,
# lockfile, and every workspace package manifest, then install.
COPY package.json package-lock.json ./
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci

# Compile the backend project graph (tsc --build). The Next.js web app is built
# in its own image and is excluded from this graph.
RUN npm run build

# Drop dev dependencies for a lean runtime node_modules.
RUN npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as the unprivileged `node` user shipped in the base image.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/packages ./packages

USER node

# Default to the API gateway; override the command for the ingestion runner.
ENV API_HOST=0.0.0.0 API_PORT=4000
EXPOSE 4000
CMD ["node", "packages/api/dist/main.js"]
