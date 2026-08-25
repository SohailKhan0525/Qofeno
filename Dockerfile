# syntax=docker/dockerfile:1
# Minimal, non-root runtime image for `qofeno serve` and headless use.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev && npm run build

FROM node:22-alpine
ENV NODE_ENV=production QOFENO_HOME=/data
WORKDIR /app
RUN addgroup -S qofeno && adduser -S qofeno -G qofeno && mkdir -p /data && chown qofeno:qofeno /data
COPY --from=build --chown=qofeno:qofeno /app/node_modules ./node_modules
COPY --from=build --chown=qofeno:qofeno /app/packages ./packages
COPY --from=build --chown=qofeno:qofeno /app/package.json ./
USER qofeno
EXPOSE 7931
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:7931/healthz || exit 1
ENTRYPOINT ["node", "packages/cli/dist/src/main.js"]
CMD ["serve", "--port", "7931"]
