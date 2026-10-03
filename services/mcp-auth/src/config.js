import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { Pool } from "pg";

import { ISSUER, RESOURCE } from "./provider.js";

const FILE_SETTINGS = Object.freeze({
  signingKeys: Object.freeze({
    envName: "MCP_OAUTH_SIGNING_KEYS_FILE",
    name: "signing key",
    policy: "secret",
  }),
  cookieKeys: Object.freeze({
    envName: "MCP_OAUTH_COOKIE_KEYS_FILE",
    name: "cookie key",
    policy: "secret",
  }),
  databaseCredentials: Object.freeze({
    envName: "MCP_OAUTH_DATABASE_CREDENTIALS_FILE",
    name: "database credential",
    policy: "secret",
  }),
  issuerCredentials: Object.freeze({
    envName: "MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE",
    name: "admin issuer database credential", policy: "secret",
  }),
  managementCredentials: Object.freeze({
    envName: "MCP_OAUTH_MANAGEMENT_DATABASE_CREDENTIALS_FILE",
    name: "management database credential",
    policy: "secret",
  }),
  databaseTlsCa: Object.freeze({
    envName: "MCP_OAUTH_DATABASE_TLS_CA_FILE",
    name: "database TLS CA",
    policy: "public-certificate",
  }),
});

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

const FILE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function configuredFileText(env, settingName) {
  const setting = FILE_SETTINGS[settingName];
  const path = required(env, setting.envName);
  let handle;
  try {
    handle = await open(path, FILE_OPEN_FLAGS);
  } catch (error) {
    if (setting.policy === "public-certificate") {
      if (error?.code === "ELOOP") {
        throw new Error(`${setting.name} path must be a regular file, not a symlink`, { cause: error });
      }
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        throw new Error(`${setting.name} path must exist and be inspectable`, { cause: error });
      }
      throw new Error(`${setting.name} file must be readable`, { cause: error });
    }
    if (setting.policy === "secret" && error?.code === "ELOOP") {
      throw new Error(`${setting.name} path must be a file with no permissions for other users`, { cause: error });
    }
    throw error;
  }
  try {
    let metadata;
    try {
      metadata = await handle.stat();
    } catch (error) {
      if (setting.policy === "public-certificate") {
        throw new Error(`${setting.name} path must exist and be inspectable`, { cause: error });
      }
      throw error;
    }
    if (setting.policy === "secret") {
      if (!metadata.isFile() || (metadata.mode & 0o007) !== 0) {
        throw new Error(`${setting.name} path must be a file with no permissions for other users`);
      }
    } else if (setting.policy === "public-certificate") {
      if (!metadata.isFile()) {
        throw new Error(`${setting.name} path must be a regular file`);
      }
      if ((metadata.mode & 0o022) !== 0) {
        throw new Error(`${setting.name} path must not be writable by group or other users`);
      }
      if (metadata.uid !== 0) {
        throw new Error(`${setting.name} path must be owned by root (uid 0)`);
      }
    } else {
      throw new Error(`${setting.envName} has an unsupported file policy`);
    }
    let value;
    try {
      value = (await handle.readFile("utf8")).trim();
    } catch (error) {
      if (setting.policy === "public-certificate") {
        throw new Error(`${setting.name} file must be readable`, { cause: error });
      }
      throw error;
    }
    if (!value) throw new Error(`${setting.name} file is empty`);
    return value;
  } finally {
    await handle.close();
  }
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
  const signingKeysText = await configuredFileText(env, "signingKeys");
  const cookieText = await configuredFileText(env, "cookieKeys");
  const databaseCredentialText = await configuredFileText(env, "databaseCredentials");
  const databaseCredentials = JSON.parse(databaseCredentialText);
  if (typeof databaseCredentials.user !== "string" || typeof databaseCredentials.password !== "string") {
    throw new Error("database credential file must contain user and password");
  }
  const cookieKeys = cookieText.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (cookieKeys.length < 2 || cookieKeys.some((key) => key.length < 32)) {
    throw new Error("cookie key file must contain at least two strong keys");
  }
  const activeSigningKid = required(env, "MCP_OAUTH_ACTIVE_SIGNING_KID");
  const tlsCa = await configuredFileText(env, "databaseTlsCa");
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
  const publicAuthorizationEnabled = env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED === "1";
  let management;
  if (publicAuthorizationEnabled) {
    const document = JSON.parse(await configuredFileText(env, "managementCredentials"));
    if (typeof document.databaseUrl !== "string") {
      throw new Error("management credential file must contain databaseUrl");
    }
    const url = new URL(document.databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password ||
        url.hostname !== required(env, "MCP_OAUTH_DATABASE_HOST") || url.search || url.hash) {
      throw new Error("management database URL must use the verified database hostname without query overrides");
    }
    management = { databaseUrl: document.databaseUrl };
  }
  const adminIssuanceEnabled = env.MCP_OAUTH_ADMIN_ISSUANCE_ENABLED === "1";
  let adminIssuer;
  if (env.MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE) {
    let text;
    try { text = await configuredFileText(env, "issuerCredentials"); }
    catch { /* Optional issuer file: unavailable means issuance stays closed. */ }
    const credential = text ? JSON.parse(text) : undefined;
    if (credential && (credential.user !== "commonswarm_admin_issuer" || typeof credential.password !== "string" || !credential.password)) {
      throw new Error("admin issuer credential requires the dedicated login role");
    }
    adminIssuer = credential;
  }
  return {
    adminIssuer,
    adminIssuanceEnabled,
    issuer,
    resource,
    publicOrigin,
    publicAuthorizationEnabled,
    management,
    supabaseUrl: publicAuthorizationEnabled ? required(env, "SUPABASE_URL") : undefined,
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
