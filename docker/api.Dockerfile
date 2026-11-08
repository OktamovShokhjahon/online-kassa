# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN npm ci --include-workspace-root -w @kass/shared -w @kass/api
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @kass/api

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared packages/shared
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --include-workspace-root -w @kass/shared -w @kass/api && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
# template of the downloadable cash-desk program (Python)
COPY --from=build /app/apps/api/assets apps/api/assets
WORKDIR /app/apps/api
RUN mkdir -p /data/uploads && chown -R node:node /data /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:4000/api/v1/health || exit 1
CMD ["node", "dist/server.js"]
