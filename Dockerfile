# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S exporter && adduser -S exporter -G exporter
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER exporter
EXPOSE 9101
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:9101/healthz || exit 1

ENTRYPOINT ["node", "src/index.js"]
