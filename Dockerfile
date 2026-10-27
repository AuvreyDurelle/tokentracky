FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/cloud/package.json ./packages/cloud/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN npm ci
COPY packages/core ./packages/core
COPY packages/cloud ./packages/cloud
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY tsconfig.json ./
RUN npm run build --workspace=@tokentracky/web && npm run build --workspace=@tokentracky/server
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production TOKENTRACKY_MODE=hosted PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/main.mjs"]
