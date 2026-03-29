# ==============================================================
# Stage 1: Install dependencies and build frontend
# ==============================================================
FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace package.json files first for layer caching
COPY package.json ./
COPY packages/agent-bridge/package.json ./packages/agent-bridge/
COPY packages/doc-core/package.json ./packages/doc-core/
COPY packages/doc-editor/package.json ./packages/doc-editor/
COPY packages/doc-server/package.json ./packages/doc-server/
COPY packages/doc-store-sqlite/package.json ./packages/doc-store-sqlite/
COPY apps/proof-example/package.json ./apps/proof-example/

RUN npm install

COPY . .

# Build frontend SPA (Vite → dist/), then merge into public/ so the
# Express static middleware can serve the built assets alongside existing
# static files, then prune dev dependencies.
# Single RUN so dev deps don't persist in any layer.
RUN npm run build \
    && cp -r dist/* public/ \
    && npm prune --omit=dev

# ==============================================================
# Stage 2: Production runtime
# ==============================================================
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g tsx@4 && npm cache clean --force

ENV NODE_ENV=production

WORKDIR /app
RUN chown node:node /app

# Server source and shared modules it imports at runtime
COPY --from=builder --chown=node:node /app/server ./server
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/docs/agent-docs.md ./docs/
COPY --from=builder --chown=node:node /app/AGENT_CONTRACT.md ./
COPY --from=builder --chown=node:node /app/package.json ./

RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 4000

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["tsx", "server/index.ts"]
