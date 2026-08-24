# ── THE LIBRARY, BUILT HERE ───────────────────────────────────────────────────
#
# `package.json` in this POC declares the library as `file:../../..`, so what pnpm
# installs is the DIRECTORY - packed the way `npm publish` would pack it, which means
# it needs `dist/` to exist. And `dist/` is in the root `.dockerignore`, deliberately:
# a build output copied from a host is whatever that host last compiled.
#
# So it is compiled here instead, from `src/`, in its own stage.
FROM node:22-alpine AS lib

WORKDIR /lib
COPY package.json package-lock.json tsconfig.json ./
COPY src/ ./src/
RUN npm ci --ignore-scripts && npm run build

# ── THE POC ───────────────────────────────────────────────────────────────────
#
# The tree is MIRRORED here on purpose: `file:../../..` read from
# `/build/poc/nuxt4-nest/api` is `/build`, the same path it means on a host.
FROM node:22-alpine AS build

RUN corepack enable

WORKDIR /build
COPY package.json README.md LICENSE CHANGELOG.md ./
COPY --from=lib /lib/dist ./dist

WORKDIR /build/poc/nuxt4-nest/api
COPY poc/nuxt4-nest/api/ ./

RUN pnpm install --no-frozen-lockfile
RUN pnpm build

FROM node:22-alpine AS runtime

RUN corepack enable

# Nest is not bundled: `dist` needs its `node_modules` beside it at runtime, so the
# mirrored tree is needed here too.
WORKDIR /build
COPY package.json README.md LICENSE CHANGELOG.md ./
COPY --from=lib /lib/dist ./dist

WORKDIR /build/poc/nuxt4-nest/api
COPY poc/nuxt4-nest/api/package.json ./
RUN pnpm install --prod --no-frozen-lockfile

COPY --from=build /build/poc/nuxt4-nest/api/dist ./dist

ENV NODE_ENV=production
EXPOSE 3333
CMD ["node", "dist/main"]
