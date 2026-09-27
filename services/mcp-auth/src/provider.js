import { generateKeyPair, exportJWK } from "jose";
import Provider, { errors } from "oidc-provider";

import {
  createMetadataFetch,
  metadataUrlAllowed,
  METADATA_BODY_LIMIT_BYTES,
} from "./metadata-fetch.js";
import { createAtomicMemoryAdapter } from "./memory-adapter.js";

export const ISSUER = "https://mcp.commonswarm.com";
export const RESOURCE = "https://mcp.commonswarm.com/mcp";
export const ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
export const TEST_ACCOUNT_ID = "commonswarm-test-user";

async function signingJwk() {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return {
    ...await exportJWK(privateKey),
    alg: "ES256",
    kid: "mcp-auth-spike-es256",
    use: "sig",
  };
}

export async function createMcpProvider({
  adapter = createAtomicMemoryAdapter(),
  fetch: injectedFetch = globalThis.fetch,
} = {}) {
  const provider = new Provider(ISSUER, {
    adapter,
    clientAuthMethods: ["none"],
    cookies: {
      keys: ["mcp-auth-spike-cookie-key-not-for-production"],
    },
    features: {
      clientIdMetadataDocument: {
        ack: "draft-02",
        enabled: true,
        allowFetch: (_ctx, clientId) => metadataUrlAllowed(clientId),
      },
      devInteractions: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: (_ctx, _client, resource) => {
          if (Array.isArray(resource)) {
            throw new errors.InvalidTarget("exactly one resource indicator is required");
          }
          if (resource === undefined) {
            throw new errors.InvalidTarget("resource indicator is required");
          }
          return resource;
        },
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== RESOURCE) {
            throw new errors.InvalidTarget("unsupported resource");
          }
          return {
            accessTokenFormat: "jwt",
            accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
            audience: RESOURCE,
            jwt: { sign: { alg: "ES256" } },
            scope: "mcp",
          };
        },
        useGrantedResource: (ctx) => {
          if (ctx.oidc.params.resource === undefined) {
            throw new errors.InvalidTarget("resource indicator is required at the token endpoint");
          }
          return false;
        },
      },
    },
    fetch: createMetadataFetch(injectedFetch),
    fetchResponseBodyLimits: {
      "client_id metadata document": METADATA_BODY_LIMIT_BYTES,
    },
    findAccount: async (_ctx, accountId) => ({
      accountId,
      claims: async () => ({ sub: accountId }),
    }),
    grantTypes: ["authorization_code", "refresh_token"],
    jwks: { keys: [await signingJwk()] },
    pkce: { required: () => true },
    responseTypes: ["code"],
    rotateRefreshToken: true,
    scopes: ["openid", "offline_access", "mcp"],
    ttl: { AccessToken: ACCESS_TOKEN_TTL_SECONDS },
    extraTokenClaims: (_ctx, token) => ({ grant_id: token.grantId }),
  });

  // Production terminates TLS before this app. Tests exercise the same trusted
  // proxy shape over an ephemeral loopback HTTP server.
  provider.proxy = true;
  return provider;
}
