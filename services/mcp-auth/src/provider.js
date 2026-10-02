import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import Provider, { errors } from "oidc-provider";

import {
  createMetadataFetch,
  createPinnedMetadataFetch,
  metadataUrlAllowed,
  METADATA_BODY_LIMIT_BYTES,
} from "./metadata-fetch.js";
import { createAtomicMemoryAdapter } from "./memory-adapter.js";

export const ISSUER = "https://mcp.commonswarm.com";
export const RESOURCE = "https://mcp.commonswarm.com/mcp";
export const ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const CIMD_CACHE_DURATION_SECONDS = Object.freeze({ min: 30, max: 5 * 60 });
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
  fetch: injectedFetch,
  cookieKeys = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")],
  jwks,
  findAccount,
  metadataFetch: injectedMetadataFetch,
  cimdCacheDuration = CIMD_CACHE_DURATION_SECONDS,
  authorizationCodeTtlSeconds = AUTHORIZATION_CODE_TTL_SECONDS,
  accessTokenTtlSeconds = ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlSeconds = REFRESH_TOKEN_TTL_SECONDS,
  nativeLoopbackEnabled = false,
  providerGrantActive = async () => true,
  clientMetadataAccepted = async () => true,
} = {}) {
  const metadataFetch = injectedMetadataFetch ?? (injectedFetch === undefined
    ? createPinnedMetadataFetch()
    : createMetadataFetch(injectedFetch));
  if (!Number.isFinite(cimdCacheDuration?.min) || !Number.isFinite(cimdCacheDuration?.max) ||
      cimdCacheDuration.min <= 0 || cimdCacheDuration.max < cimdCacheDuration.min) {
    throw new TypeError("CIMD cache duration must have bounded min and max seconds");
  }
  const provider = new Provider(ISSUER, {
    adapter,
    clientAuthMethods: ["none"],
    // Match omitted client algorithms to the provider's ES256 signing key.
    clientDefaults: {
      id_token_signed_response_alg: "ES256",
      authorization_signed_response_alg: "ES256",
      introspection_signed_response_alg: "ES256",
    },
    cookies: {
      keys: cookieKeys,
      long: { httpOnly: true, sameSite: "lax", secure: true, signed: true },
      short: { httpOnly: true, sameSite: "lax", secure: true, signed: true },
    },
    features: {
      clientIdMetadataDocument: {
        ack: "draft-02",
        enabled: true,
        allowFetch: (_ctx, clientId) => metadataUrlAllowed(clientId),
        allowClient: async (_ctx, client) => {
          const metadata = client.metadata();
          if (!nativeLoopbackEnabled && metadata.application_type === "native") return false;
          return await clientMetadataAccepted(metadata);
        },
        cacheDuration: cimdCacheDuration,
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
    fetch: metadataFetch,
    fetchResponseBodyLimits: {
      "client_id metadata document": METADATA_BODY_LIMIT_BYTES,
    },
    findAccount: findAccount ?? (async (_ctx, accountId) => ({
      accountId,
      claims: async () => ({ sub: accountId }),
    })),
    grantTypes: ["authorization_code", "refresh_token"],
    jwks: jwks ?? { keys: [await signingJwk()] },
    pkce: { required: () => true },
    responseTypes: ["code"],
    routes: {
      authorization: "/authorize",
      jwks: "/jwks",
    },
    rotateRefreshToken: true,
    scopes: ["openid", "offline_access", "mcp"],
    ttl: {
      AccessToken: accessTokenTtlSeconds,
      AuthorizationCode: authorizationCodeTtlSeconds,
      Grant: refreshTokenTtlSeconds,
      Interaction: 10 * 60,
      RefreshToken: (ctx) => Math.min(
        refreshTokenTtlSeconds,
        ctx?.oidc?.entities.RotatedRefreshToken?.remainingTTL ?? refreshTokenTtlSeconds,
      ),
      Session: refreshTokenTtlSeconds,
    },
    extraTokenClaims: async (_ctx, token) => {
      if (!await providerGrantActive(token.grantId)) {
        throw new errors.InvalidGrant("provider grant is inactive");
      }
      return { grant_id: token.grantId };
    },
  });

  // Production terminates TLS before this app. Tests exercise the same trusted
  // proxy shape over an ephemeral loopback HTTP server.
  provider.proxy = true;
  return provider;
}
