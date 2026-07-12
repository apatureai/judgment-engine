# Judgment Engine API + worker image. Runtime secrets are injected by Fly;
# credentials and model/capture endpoints are never baked into an image layer.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json vitest.config.ts ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build
# `pnpm prune` is not workspace-aware and removes package-local links needed by
# the runtime. Re-install from the warmed store so the final graph is prod-only
# while retaining all workspace package and transitive dependency links.
RUN pnpm install --prod --frozen-lockfile --offline

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
EXPOSE 8080
CMD ["node", "packages/runtime/dist/api-main.js"]
