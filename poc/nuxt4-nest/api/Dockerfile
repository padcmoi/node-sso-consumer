FROM node:22-alpine AS build

RUN corepack enable

# The build context is the LIBRARY's root, not this folder. The tree used to be
# MIRRORED here so that `file:../../../packages/*.tgz` resolved to the same file
# inside the image as on a host; that folder is gone and the library comes from the
# registry now.
WORKDIR /build/poc/nuxt4-nest/api
COPY poc/nuxt4-nest/api/ ./

RUN pnpm install --no-frozen-lockfile
RUN pnpm build

FROM node:22-alpine AS runtime

RUN corepack enable

# Nest is not bundled: `dist` needs its `node_modules` beside it at runtime.
WORKDIR /build/poc/nuxt4-nest/api
COPY poc/nuxt4-nest/api/package.json ./
RUN pnpm install --prod --no-frozen-lockfile

COPY --from=build /build/poc/nuxt4-nest/api/dist ./dist

ENV NODE_ENV=production
EXPOSE 3333
CMD ["node", "dist/main"]
