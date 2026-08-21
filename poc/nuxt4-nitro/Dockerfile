FROM node:22-alpine AS build

RUN corepack enable
WORKDIR /app

# The build context is the LIBRARY's root, not this folder, and that is deliberate:
# this POC installs the packed tarball rather than a published version, because the
# tarball is what it exists to prove. `../../packages` read from `/app` is
# `/packages` - the same path `package.json` names from this folder on a host.
COPY packages/ /packages/

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
