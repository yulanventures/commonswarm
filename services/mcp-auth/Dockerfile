FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS management-build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src/h0/verbs.ts ./src/h0/verbs.ts
COPY src/protocol ./src/protocol
COPY src/cloud/session-wire.ts src/cloud/wake-lease-constants.ts src/cloud/ask-chain-constants.ts src/cloud/reply-status.ts ./src/cloud/
COPY supabase/functions/command ./supabase/functions/command
COPY supabase/functions/_shared ./supabase/functions/_shared
COPY services/mcp-auth/build-management.mjs ./services/mcp-auth/build-management.mjs
COPY services/mcp-auth/build-admin-policy.mjs ./services/mcp-auth/build-admin-policy.mjs
RUN node services/mcp-auth/build-management.mjs

FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=10001:10001 services/mcp-auth/package.json services/mcp-auth/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force
COPY --chown=10001:10001 services/mcp-auth/src ./src
COPY --chown=10001:10001 --from=management-build /build/services/mcp-auth/src/management-command.generated.js ./src/management-command.generated.js
COPY --chown=10001:10001 --from=management-build /build/services/mcp-auth/src/admin-policy.generated.js ./src/admin-policy.generated.js

USER 10001:10001
EXPOSE 3490
CMD ["node", "src/server.js"]
