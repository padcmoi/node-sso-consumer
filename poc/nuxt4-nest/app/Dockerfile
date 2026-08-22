FROM node:22-alpine AS build

RUN corepack enable

# The build context is the LIBRARY's root, not this folder, and the tree is MIRRORED
# here on purpose: `file:../../../packages/*.tgz` in `package.json` then resolves to
# the same file inside the image as it does on a host. One path, true in both places,
# rather than one that only works because `/..` above the root collapses to `/`.
WORKDIR /build
COPY packages/ ./packages/

WORKDIR /build/poc/nuxt4-nest/app
# One COPY, and the root `.dockerignore` decides what is in it.
COPY poc/nuxt4-nest/app/ ./

RUN pnpm install --no-frozen-lockfile
RUN pnpm build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000

COPY --from=build /build/poc/nuxt4-nest/app/.output ./.output

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
