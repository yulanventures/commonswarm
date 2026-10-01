FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS management-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY supabase/functions ./supabase/functions
COPY services/mcp-auth/build-management.mjs ./services/mcp-auth/build-management.mjs
RUN node services/mcp-auth/build-management.mjs

FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=10001:10001 services/mcp-auth/package.json services/mcp-auth/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY --chown=10001:10001 services/mcp-auth/src ./src
COPY --chown=10001:10001 --from=management-build /build/services/mcp-auth/src/management-command.generated.js ./src/management-command.generated.js

USER 10001:10001
EXPOSE 3490
CMD ["node", "src/server.js"]
