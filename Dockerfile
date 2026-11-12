# syntax=docker/dockerfile:1
# One build, two images: --target bot and --target hub.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/bot/package.json apps/bot/
COPY apps/hub/package.json apps/hub/
RUN pnpm install --frozen-lockfile
COPY packages/core packages/core
COPY apps apps
RUN pnpm --filter @mrmod/core build && pnpm --filter @mrmod/bot build && pnpm --filter @mrmod/hub build \
 && pnpm --filter @mrmod/bot deploy --prod --legacy /out/bot \
 && pnpm --filter @mrmod/hub deploy --prod --legacy /out/hub

FROM node:22-bookworm-slim AS bot
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/bot .
USER node
CMD ["node", "dist/index.js"]

FROM node:22-bookworm-slim AS hub
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /out/hub .
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
