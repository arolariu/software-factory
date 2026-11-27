ARG NODE_IMAGE=docker.io/library/node:24.22.3-bookworm-slim@sha256:873f586f3794f52281bd039bf02c048a0be08fde619338f9941bad1eb6b34530
FROM ${NODE_IMAGE} AS npm-base
WORKDIR /app
RUN --mount=type=secret,id=npm_config,required=true \
    NPM_CONFIG_USERCONFIG=/run/secrets/npm_config \
    npm install --global npm@12.2.3 --ignore-scripts --no-audit --no-fund
COPY package.json package-lock.json .npmrc ./

FROM npm-base AS build
RUN --mount=type=secret,id=npm_config,required=true \
    NPM_CONFIG_USERCONFIG=/run/secrets/npm_config \
    npm ci --include=dev --ignore-scripts --strict-peer-deps --no-audit --no-fund
COPY . .
ARG BUILD_REVISION=
ARG BUILD_TIMESTAMP=
ARG BUILD_RUN_URL=
RUN --network=none npm run check && npm test && npm run build
RUN rm dist/server/identity/copilot-access.js

FROM npm-base AS prod-deps
RUN --mount=type=secret,id=npm_config,required=true \
    NPM_CONFIG_USERCONFIG=/run/secrets/npm_config \
    npm ci --omit=dev --include=optional --ignore-scripts --strict-peer-deps --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY scripts/healthcheck.sh ./healthcheck.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s \
    CMD ["timeout","2","bash","/app/healthcheck.sh"]
CMD ["node", "dist/server/main.js", "--container"]
