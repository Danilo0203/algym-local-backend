FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY hostinger/package.json hostinger/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM postgres:17-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY hostinger ./hostinger
COPY windows ./windows
COPY database/migrations ./database/migrations
USER postgres
EXPOSE 54433
ENTRYPOINT ["node", "hostinger/server.mjs"]
