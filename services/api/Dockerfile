# The API (sign-in exchange, sync, billing, admin, marketplace, growth, status, help). Built from the repo, not mounted from the host:
# the code and its runtime packages travel together, so a new import can no longer meet a host folder that lacks the package.
# Build context is the repository root (docs/ is the help assistant's knowledge base).
FROM node:24.15.0-alpine AS deps
WORKDIR /srv
COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.15.0-alpine
WORKDIR /srv
ENV NODE_ENV=production AO_HELP_DOCS_DIR=/srv/docs
COPY --from=deps /srv/node_modules ./node_modules
COPY services/api/package.json ./
COPY services/api/src ./src
COPY docs ./docs
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "src/api/main.ts"]
