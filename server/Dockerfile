# Self-hosting fallback. Colyseus Cloud does not need this — it builds from the
# repo directly — but it makes fly.io / Railway / a plain VPS a one-liner.
#
# Build context must be the REPO ROOT, not server/: the server bundles the
# simulation out of game/src, so both trees have to be present at build time.
#   docker build -f server/Dockerfile -t ace-defense-server .
FROM node:20-slim AS build
WORKDIR /app

COPY server/package.json server/package-lock.json* server/.npmrc ./server/
WORKDIR /app/server
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

WORKDIR /app
COPY game/src ./game/src
COPY game/package.json ./game/
COPY server ./server

WORKDIR /app/server
RUN npm run build

FROM node:20-slim
WORKDIR /app/server
ENV NODE_ENV=production
COPY --from=build /app/server/package.json /app/server/.npmrc ./
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/build ./build
EXPOSE 2567
CMD ["node", "build/index.js"]
