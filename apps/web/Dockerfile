# Production image for the Next.js web frontend (@pma/web).
#
# The frontend talks ONLY to the API gateway over HTTP (Requirement 9.1). The
# gateway base URL is a build-time public env (baked into the client bundle):
#   docker build --build-arg NEXT_PUBLIC_API_BASE_URL=https://api.example.com .
#
# Build context is the repo root so the workspace lockfile is available:
#   docker build -f apps/web/Dockerfile -t pma-web .

# ---- builder ----------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app

ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}

COPY package.json package-lock.json ./
COPY apps/web ./apps/web
# Install only the web workspace's dependencies.
RUN npm ci --workspace @pma/web --include-workspace-root=false || npm ci
RUN npm run build --workspace @pma/web

# ---- runtime ----------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app/apps/web
ENV NODE_ENV=production PORT=3000

COPY --from=builder --chown=node:node /app/node_modules /app/node_modules
COPY --from=builder --chown=node:node /app/apps/web/.next ./.next
COPY --from=builder --chown=node:node /app/apps/web/package.json ./package.json
COPY --from=builder --chown=node:node /app/apps/web/next.config.mjs ./next.config.mjs

USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
