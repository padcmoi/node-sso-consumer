# ── THE LIBRARY, BUILT HERE ───────────────────────────────────────────────────
#
# `package.json` in this POC declares the library as `file:../..`, so what pnpm
# installs is the DIRECTORY - packed the way `npm publish` would pack it, which means
# it needs `dist/` to exist. And `dist/` is in the root `.dockerignore`, deliberately:
# a build output copied from a host is whatever that host last compiled.
#
# So it is compiled here instead, from `src/`, in its own stage. What the POC
# installs is then provably the source in this repository rather than something
# somebody remembered to build.
FROM node:22-alpine AS lib

WORKDIR /lib
COPY package.json package-lock.json tsconfig.json ./
COPY src/ ./src/
RUN npm ci --ignore-scripts && npm run build

# ── THE POC ───────────────────────────────────────────────────────────────────
#
# The build context is the LIBRARY's root, and the tree is MIRRORED here on purpose:
# `file:../..` read from `/build/poc/nuxt4-local` is `/build`, the same path it means
# on a host. One path, true in both places.
FROM node:22-alpine AS build

RUN corepack enable

WORKDIR /build
COPY package.json README.md LICENSE CHANGELOG.md ./
COPY --from=lib /lib/dist ./dist

WORKDIR /build/poc/nuxt4-local
# One COPY, and the root `.dockerignore` decides what is in it.
COPY poc/nuxt4-local/ ./

RUN pnpm install --no-frozen-lockfile
RUN pnpm build

# ── RUNTIME ───────────────────────────────────────────────────────────────────
#
# Nuxt's output is self-contained: its own `node_modules` are bundled into
# `.output/server`, so nothing is installed again here.
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000

COPY --from=build /build/poc/nuxt4-local/.output ./.output

EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
