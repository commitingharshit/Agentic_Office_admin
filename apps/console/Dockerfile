# The control plane: sign-in (Better Auth) and the admin console, as one Next.js service.
# Build context is services/control-plane. Runs as an unprivileged user; the port is 8791.
FROM node:24.15.0-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24.15.0-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Placeholders only so the build can load the config; the real values arrive at run time.
RUN AUTH_BASE_URL=http://localhost:8791 AUTH_SECRET=build-time-placeholder-build-time-placeholder AUTH_DATABASE_URL=postgres://build:build@127.0.0.1:1/build npx next build

FROM node:24.15.0-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8791 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 8791
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8791/api/health || exit 1
CMD ["node", "server.js"]
