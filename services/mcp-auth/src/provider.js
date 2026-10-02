import { randomBytes } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import Provider, { errors, interactionPolicy } from "oidc-provider";

import {
  createMetadataFetch,
  createPinnedMetadataFetch,
  metadataUrlAllowed,
  METADATA_BODY_LIMIT_BYTES,
} from "./metadata-fetch.js";
import { createAtomicMemoryAdapter } from "./memory-adapter.js";
import { CLIENT_SCOPES, createMemoryRegistrationStore, createRegistrationLimiter,
  validateClientPolicy } from "./registration.js";

export const ISSUER = "https://mcp.commonswarm.com";
export const RESOURCE = "https://mcp.commonswarm.com/mcp";
export const ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const CIMD_CACHE_DURATION_SECONDS = Object.freeze({ min: 30, max: 5 * 60 });
export const TEST_ACCOUNT_ID = "commonswarm-test-user";
export const RESOURCE_SCOPES = Object.freeze(["mcp"]);

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
  registrationEnabled = true,
  registrationStore = createMemoryRegistrationStore(),
  registrationLimiter = createRegistrationLimiter(),
} = {}) {
  const metadataFetch = injectedMetadataFetch ?? (injectedFetch === undefined
    ? createPinnedMetadataFetch()
    : createMetadataFetch(injectedFetch));
  if (!Number.isFinite(cimdCacheDuration?.min) || !Number.isFinite(cimdCacheDuration?.max) ||
      cimdCacheDuration.min <= 0 || cimdCacheDuration.max < cimdCacheDuration.min) {
    throw new TypeError("CIMD cache duration must have bounded min and max seconds");
  }
  const policy = interactionPolicy.base();
  // A provider session can outlive the authenticated browser session. The
  // default no_session check only tests accountId; without an Account,
  // loadGrant creates no Grant and the subsequent consent checks would throw.
  policy.get("login").checks.add(new interactionPolicy.Check(
    "account_unavailable", "End-User authentication is required", "login_required",
    (ctx) => Boolean(ctx.oidc.session.accountId && !ctx.oidc.account),
  ));
  const provider = new Provider(ISSUER, {
    adapter: (model) => model === "Client" ? registrationStore : adapter(model),
    clientAuthMethods: ["none"],
    // Match omitted client algorithms to the provider's ES256 signing key.
    clientDefaults: {
      id_token_signed_response_alg: "ES256",
      authorization_signed_response_alg: "ES256",
      introspection_signed_response_alg: "ES256",
      token_endpoint_auth_method: "none",
      scope: CLIENT_SCOPES.join(" "),
    },
    cookies: {
      keys: cookieKeys,
      long: { httpOnly: true, sameSite: "lax", secure: true, signed: true },
      short: { httpOnly: true, sameSite: "lax", secure: true, signed: true },
    },
    features: {
      registration: { enabled: registrationEnabled, initialAccessToken: false,
        issueRegistrationAccessToken: false, idFactory: registrationLimiter },
      pushedAuthorizationRequests: { enabled: false },
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
            scope: RESOURCE_SCOPES.join(" "),
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
    interactions: { policy },
    jwks: jwks ?? { keys: [await signingJwk()] },
    pkce: { required: () => true },
    responseTypes: ["code"],
    routes: {
      authorization: "/authorize",
      jwks: "/jwks",
    },
    rotateRefreshToken: true,
    scopes: CLIENT_SCOPES,
    extraClientMetadata: {
      properties: ["scope"],
      validator: (_ctx, _key, _value, metadata) => validateClientPolicy(metadata, nativeLoopbackEnabled),
    },
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
  provider.use(async (ctx, next) => {
    // oidc-provider filters unknown authorization scopes. Refuse escalation
    // explicitly rather than silently turning it into a narrower request.
    if (ctx.path === "/authorize" && typeof ctx.query.scope === "string" &&
        ctx.query.scope.split(" ").filter(Boolean).some((scope) => !CLIENT_SCOPES.includes(scope))) {
      ctx.status = 400;
      ctx.body = { error: "invalid_scope" };
      return;
    }
    await next();
    const entities = ctx.oidc?.entities;
    if ((entities?.AuthorizationCode || entities?.AccessToken) && ctx.status < 400 &&
        (ctx.path.startsWith("/authorize") || ctx.path === "/token")) {
      await registrationStore.markUsed(entities.Client.clientId);
    }
  });
  return provider;
}
