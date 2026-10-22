FROM node:24.15.0-alpine
WORKDIR /srv
COPY database/package.json database/package-lock.json ./database/
RUN cd database && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY services/api/src/status ./services/api/src/status
COPY services/prober/main.ts ./services/prober/main.ts
RUN ln -s /srv/database/node_modules /srv/services/node_modules
USER node
CMD ["node", "services/prober/main.ts"]
