import { readFile, stat } from "node:fs/promises";

import { Pool } from "pg";

import { ISSUER, RESOURCE } from "./provider.js";

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(env, name, fallback) {
  if (env[name] === undefined || env[name] === "") return fallback;
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function protectedText(path, name) {
  const metadata = await stat(path);
  if (!metadata.isFile() || (metadata.mode & 0o007) !== 0) {
    throw new Error(`${name} path must be a file with no permissions for other users`);
  }
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error(`${name} file is empty`);
  return value;
}

function parseSigningKeys(text, activeKid) {
  const document = JSON.parse(text);
  if (!Array.isArray(document.keys) || document.keys.length < 1) throw new Error("signing key file must be a JWK set");
  const kids = new Set();
  for (const key of document.keys) {
    if (key.kty !== "EC" || key.crv !== "P-256" || key.alg !== "ES256" ||
        key.use !== "sig" || typeof key.kid !== "string" || typeof key.d !== "string") {
      throw new Error("every signing key must be a private ES256 P-256 signing JWK with kid");
    }
    if (kids.has(key.kid)) throw new Error("signing key kids must be unique");
    kids.add(key.kid);
  }
  if (!kids.has(activeKid)) throw new Error("active signing kid is absent");
  return { keys: [...document.keys].sort((left, right) => {
    if (left.kid === activeKid) return -1;
    if (right.kid === activeKid) return 1;
    return left.kid.localeCompare(right.kid);
  }) };
}

function exactOrigins(value) {
  const result = new Set();
  for (const item of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    const url = new URL(item);
    if (url.origin !== item || !["https:", "http:"].includes(url.protocol)) {
      throw new Error("allowed origins must be exact URL origins");
    }
    result.add(item);
  }
  if (result.size === 0) throw new Error("at least one allowed origin is required");
  return result;
}

export async function loadConfig(env = process.env) {
  const issuer = env.MCP_OAUTH_ISSUER || ISSUER;
  const resource = env.MCP_OAUTH_RESOURCE || RESOURCE;
  if (issuer !== ISSUER || resource !== RESOURCE) throw new Error("issuer and resource must match the CommonSwarm contract");
  const publicOrigin = required(env, "MCP_OAUTH_PUBLIC_ORIGIN");
  if (new URL(publicOrigin).origin !== publicOrigin || publicOrigin !== issuer) {
    throw new Error("public origin must exactly match the issuer origin");
  }
  const signingKeysText = await protectedText(required(env, "MCP_OAUTH_SIGNING_KEYS_FILE"), "signing key");
  const cookieText = await protectedText(required(env, "MCP_OAUTH_COOKIE_KEYS_FILE"), "cookie key");
  const databaseCredentialText = await protectedText(
    required(env, "MCP_OAUTH_DATABASE_CREDENTIALS_FILE"),
    "database credential",
  );
  const databaseCredentials = JSON.parse(databaseCredentialText);
  if (typeof databaseCredentials.user !== "string" || typeof databaseCredentials.password !== "string") {
    throw new Error("database credential file must contain user and password");
  }
  const cookieKeys = cookieText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (cookieKeys.length < 2 || cookieKeys.some((key) => key.length < 32)) {
    throw new Error("cookie key file must contain at least two strong keys");
  }
  const activeSigningKid = required(env, "MCP_OAUTH_ACTIVE_SIGNING_KID");
  const tlsCa = await protectedText(required(env, "MCP_OAUTH_DATABASE_TLS_CA_FILE"), "database TLS CA");
  const authorizationCodeTtlSeconds = positiveInteger(env, "MCP_OAUTH_AUTHORIZATION_CODE_TTL_SECONDS", 60);
  const accessTokenTtlSeconds = positiveInteger(env, "MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS", 300);
  const refreshTokenTtlSeconds = positiveInteger(
    env,
    "MCP_OAUTH_REFRESH_LIFETIME_SECONDS",
    30 * 24 * 60 * 60,
  );
  if (authorizationCodeTtlSeconds !== 60 || accessTokenTtlSeconds !== 300 ||
      refreshTokenTtlSeconds !== 30 * 24 * 60 * 60) {
    throw new Error("OAuth token lifetimes must match the reviewed contract");
  }
  const allowedOrigins = exactOrigins(required(env, "MCP_OAUTH_ALLOWED_ORIGINS"));
  allowedOrigins.add(issuer);
  return {
    issuer,
    resource,
    publicOrigin,
    publicAuthorizationEnabled: env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED === "1",
    nativeLoopbackEnabled: env.MCP_OAUTH_NATIVE_LOOPBACK_ENABLED === "1",
    allowedOrigins,
    gotrueUrl: required(env, "MCP_OAUTH_GOTRUE_URL"),
    gotrueProvider: required(env, "MCP_OAUTH_GOTRUE_PROVIDER"),
    supabaseAnonKey: required(env, "SUPABASE_ANON_KEY"),
    activeSigningKid,
    jwks: parseSigningKeys(signingKeysText, activeSigningKid),
    cookieKeys,
    port: positiveInteger(env, "PORT", 3490),
    maxBodyBytes: positiveInteger(env, "MCP_OAUTH_MAX_BODY_BYTES", 64 * 1024),
    requestTimeoutMs: positiveInteger(env, "MCP_OAUTH_REQUEST_TIMEOUT_MS", 10_000),
    authorizationCodeTtlSeconds,
    accessTokenTtlSeconds,
    refreshTokenTtlSeconds,
    database: {
      host: required(env, "MCP_OAUTH_DATABASE_HOST"),
      port: positiveInteger(env, "MCP_OAUTH_DATABASE_PORT", 5432),
      database: required(env, "MCP_OAUTH_DATABASE_NAME"),
      user: databaseCredentials.user,
      password: databaseCredentials.password,
      ssl: { ca: tlsCa, rejectUnauthorized: true },
      application_name: "commonswarm-mcp-auth",
      max: 10,
      statement_timeout: 10_000,
      query_timeout: 10_000,
    },
  };
}

export function createPool(config) {
  return new Pool(config.database);
}
