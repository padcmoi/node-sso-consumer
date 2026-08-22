FROM node:22-alpine AS build

RUN corepack enable

# The build context is the LIBRARY's root, not this folder, and the tree is MIRRORED
# here on purpose: `file:../../../packages/*.tgz` in `package.json` then resolves to
# the same file inside the image as it does on a host. One path, true in both places.
WORKDIR /build
COPY packages/ ./packages/

WORKDIR /build/poc/nuxt4-nest/api
COPY poc/nuxt4-nest/api/ ./

RUN pnpm install --no-frozen-lockfile
RUN pnpm build

FROM node:22-alpine AS runtime

RUN corepack enable

# The same mirrored tree, because the production install reads the same tarball path.
# Nest is not bundled: `dist` needs its `node_modules` beside it at runtime.
WORKDIR /build
COPY packages/ ./packages/

WORKDIR /build/poc/nuxt4-nest/api
COPY poc/nuxt4-nest/api/package.json ./
RUN pnpm install --prod --no-frozen-lockfile

COPY --from=build /build/poc/nuxt4-nest/api/dist ./dist

ENV NODE_ENV=production
EXPOSE 3333
CMD ["node", "dist/main"]
