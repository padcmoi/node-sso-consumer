# ── THE LIBRARY, BUILT HERE ───────────────────────────────────────────────────
#
# `package.json` in this POC declares the library as `file:../..`, so what pnpm
# installs is the DIRECTORY - packed the way `npm publish` would pack it, which means
# it needs `dist/` to exist. And `dist/` is in the root `.dockerignore`, deliberately:
# a build output copied from a host is whatever that host last compiled.
#
# So it is compiled here instead, from `src/`, in its own stage. What the POC installs
# is then provably the source in this repository rather than something somebody
# remembered to build.
FROM node:22-alpine AS lib

WORKDIR /lib
COPY package.json package-lock.json tsconfig.json ./
COPY src/ ./src/
RUN npm ci --ignore-scripts && npm run build

# ── THE POC ───────────────────────────────────────────────────────────────────
#
# The build context is the LIBRARY's root, and the tree is MIRRORED here on purpose:
# `file:../..` read from `/build/poc/nextjs16` is `/build`, the same path it means on
# a host. One path, true in both places.
FROM node:22-alpine AS build

RUN corepack enable

WORKDIR /build
COPY package.json README.md LICENSE CHANGELOG.md ./
COPY --from=lib /lib/dist ./dist

WORKDIR /build/poc/nextjs16
# One COPY, and the root `.dockerignore` decides what is in it.
COPY poc/nextjs16/ ./

RUN pnpm install --no-frozen-lockfile
# `next build` for the application, then `tsc` for `server.ts`, which Next does not
# compile: it is outside its world by design.
RUN pnpm build

FROM node:22-alpine AS runtime

RUN corepack enable

# The same mirrored tree, because the production install reads the same `file:` path.
WORKDIR /build
COPY package.json README.md LICENSE CHANGELOG.md ./
COPY --from=lib /lib/dist ./dist

WORKDIR /build/poc/nextjs16
COPY poc/nextjs16/package.json ./
RUN pnpm install --prod --no-frozen-lockfile

# Next is not bundled: it reads `.next` and its own config at runtime.
COPY --from=build /build/poc/nextjs16/.next ./.next
COPY --from=build /build/poc/nextjs16/dist ./dist
COPY poc/nextjs16/next.config.mjs ./

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000
CMD ["node", "dist/server.js"]
