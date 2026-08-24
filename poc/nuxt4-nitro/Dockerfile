FROM node:22-alpine AS build

RUN corepack enable
WORKDIR /app

# The build context is the LIBRARY's root, not this folder. It used to be so that a
# packed tarball under `packages/` fell inside it; that folder is gone and the
# library is installed from the registry now, so the context is wider than it needs
# to be and `.dockerignore` is what keeps it cheap.

# One COPY, and `.dockerignore` decides what is in it.
COPY poc/nuxt4-nitro/ ./

RUN pnpm install --no-frozen-lockfile
RUN pnpm build

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000

COPY --from=build /app/.output ./.output

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
