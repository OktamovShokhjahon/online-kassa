# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN npm ci --include-workspace-root -w @kass/shared -w @kass/web
COPY packages/shared packages/shared
COPY apps/web apps/web
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
# the API address is baked into the rewrites at build time
ARG API_URL=http://api:4000
ENV API_URL=$API_URL
RUN npm run build -w @kass/web

FROM node:20-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
