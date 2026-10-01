# AccessLease: API + worker + web UI + CLI in one image (`worker` can also run as its own container).
# Base images are pinned by digest. Update the digest deliberately and re-run the smoke procedure
# (docs/runbook/smoke.md) before shipping a new base.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.web.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
# Inside the container the app must listen on all container interfaces so Docker can publish the port.
# compose.yaml publishes it on 127.0.0.1 only (this computer); see docs/runbook/install.md for bind semantics.
ENV NODE_ENV=production ACCESSLEASE_HOST=0.0.0.0 ACCESSLEASE_PORT=8791
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY templates ./templates
USER node
EXPOSE 8791
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:8791/api/v1/health/ready >/dev/null || exit 1
ENTRYPOINT ["node", "dist/src/cli.js"]
CMD ["serve"]
