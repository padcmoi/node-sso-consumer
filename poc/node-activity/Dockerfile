# The library, compiled HERE from `src/` rather than taken from a host's `dist/`:
# what runs is provably the source in this repository. `dist/` is in the root
# `.dockerignore` for that reason.
FROM node:22-alpine

WORKDIR /lib
COPY package.json package-lock.json tsconfig.json ./
COPY src/ ./src/
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev

# The probe imports `../../dist/index.js`, the same path it means on a host.
COPY poc/node-activity/publish.mjs ./poc/node-activity/publish.mjs

CMD ["node", "poc/node-activity/publish.mjs"]
