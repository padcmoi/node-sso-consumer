FROM node:22-alpine AS build

RUN corepack enable

# The build context is the LIBRARY's root, not this folder, and the tree is MIRRORED
# here on purpose: `file:../../packages/*.tgz` in `package.json` then resolves to the
# same file inside the image as it does on a host. One path, true in both places.
WORKDIR /build
COPY packages/ ./packages/

WORKDIR /build/poc/nextjs16
# One COPY, and the root `.dockerignore` decides what is in it.
COPY poc/nextjs16/ ./

RUN pnpm install --no-frozen-lockfile
# `next build` for the application, then `tsc` for `server.ts`, which Next does not
# compile: it is outside its world by design.
RUN pnpm build

FROM node:22-alpine AS runtime

RUN corepack enable

WORKDIR /build
COPY packages/ ./packages/

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
