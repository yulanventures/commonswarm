import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { errors } from "oidc-provider";

import { metadataUrlAllowed } from "./metadata-fetch.js";

export const REGISTRATION_IDLE_SECONDS = 30 * 24 * 60 * 60;
export const CLIENT_SCOPES = Object.freeze(["openid", "offline_access", "mcp"]);
export const DEFAULT_DCR_LIMITS = Object.freeze({ perIp: 60, perHost: 300 });
// Descriptions from these owned errors contain only service-authored text.
class RegistrationMetadataError extends errors.InvalidClientMetadata {}
class RegistrationRequestError extends errors.InvalidRequest {}

export function registrationErrorResponse(error) {
  if (error instanceof RegistrationMetadataError || error instanceof RegistrationRequestError) {
    return { status: error.statusCode, body: { error: error.error, error_description: error.error_description } };
  }
  if (error instanceof errors.InvalidClientMetadata) {
    // Provider metadata errors can interpolate client-supplied URI schemes.
    // Retain the field name, never the supplied value or exception detail.
    const field = /^(?:invalid )?([a-z][a-z0-9_]{0,63})(?:\[| |$)/u.exec(error.error_description)?.[1];
    return { status: 400, body: { error: error.error,
      error_description: field ? `${field} metadata is invalid` : "client metadata is invalid" } };
  }
  if (error instanceof errors.InvalidRequest) {
    const description = error.error_description;
    const safe = new Set(["failed to parse the request body", "client registration request must be a JSON object"]);
    return { status: 400, body: { error: "invalid_request", error_description: safe.has(description)
      ? description : "registration requests require application/json" } };
  }
  return { status: 500, body: { error: "server_error", error_description: "registration could not be saved; retry later" } };
}

const LOOPBACKS = new Set(["localhost", "127.0.0.1", "[::1]"]);
// The mapping is also the branding domain for an explicitly allowed client.
const NATIVE_CLIENT_SCHEMES = new Map([["cursor:", "cursor.com"]]);
const DANGEROUS_SCHEMES = new Set(["javascript:", "vbscript:", "data:", "blob:", "file:", "about:"]);

export function privateUseScheme(url) {
  return !["http:", "https:"].includes(url.protocol) && !DANGEROUS_SCHEMES.has(url.protocol) &&
    (url.protocol.includes(".") || NATIVE_CLIENT_SCHEMES.has(url.protocol));
}

function loopbackRedirect(url) {
  return url.protocol === "http:" && LOOPBACKS.has(url.hostname);
}

const GENERIC_CC_SLD = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);
const HOSTNAME_IN_TEXT = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\b/giu;

export function registrableDomain(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || isIP(host)) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const tld = labels.at(-1);
  const sld = labels.at(-2);
  if (tld.length === 2 && GENERIC_CC_SLD.has(sld) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

function redirectRegistrableDomains(metadata) {
  const domains = new Set();
  const hasHttps = (metadata.redirect_uris ?? []).some(uri => new URL(uri).protocol === "https:");
  for (const uri of metadata.redirect_uris ?? []) {
    const url = new URL(uri);
    // An app scheme must not lend its brand to a web callback in the same list.
    if (hasHttps && privateUseScheme(url)) continue;
    // Private-use authorities identify an app route, not a DNS owner. Bind DCR
    // branding to the known client domain or the reversed dotted scheme instead.
    const host = privateUseScheme(url)
      ? NATIVE_CLIENT_SCHEMES.get(url.protocol) ?? url.protocol.slice(0, -1).split(".").reverse().join(".")
      : url.hostname;
    domains.add(registrableDomain(host));
  }
  return domains;
}

function hostnamesInText(value) {
  if (typeof value !== "string" || value.length === 0) return [];
  return [...new Set([...value.matchAll(HOSTNAME_IN_TEXT)].map((match) => match[1].toLowerCase()))];
}

function validateDcrBranding(metadata) {
  if (metadata.client_id && metadataUrlAllowed(metadata.client_id)) return;
  if (metadata.logo_uri !== undefined) {
    throw new RegistrationMetadataError("registered clients cannot declare logo_uri");
  }
  const allowed = redirectRegistrableDomains(metadata);
  for (const host of hostnamesInText(metadata.client_name)) {
    if (!allowed.has(registrableDomain(host))) {
      throw new RegistrationMetadataError("client_name cannot claim a different host than redirect_uris");
    }
  }
  if (metadata.client_uri !== undefined) {
    const host = registrableDomain(new URL(metadata.client_uri).hostname);
    if (!allowed.has(host)) {
      throw new RegistrationMetadataError("client_uri must stay on the redirect host");
    }
  }
}

// Applied to both CIMD and registered metadata before the provider schema.
// The provider independently restricts grants, responses and algorithms.
export function validateClientPolicy(metadata, nativeLoopbackEnabled) {
  if (metadata.token_endpoint_auth_method !== "none") {
    throw new RegistrationMetadataError("only public clients are supported");
  }
  // extraClientMetadata.validator runs before the provider schema, despite
  // receiving the merged defaults. Validate shapes before URL operations.
  for (const field of ["redirect_uris", "post_logout_redirect_uris"]) {
    const uris = metadata[field];
    if (uris === undefined && field === "post_logout_redirect_uris") continue;
    if (!Array.isArray(uris)) throw new RegistrationMetadataError(`${field} must be an array of URLs`);
    for (const uri of uris) {
      try {
        if (typeof uri !== "string") throw new TypeError();
        new URL(uri);
      } catch { throw new RegistrationMetadataError(`${field} must contain valid URLs`); }
    }
  }
  if (metadata.client_uri !== undefined) {
    try {
      if (typeof metadata.client_uri !== "string") throw new TypeError();
      new URL(metadata.client_uri);
    } catch { throw new RegistrationMetadataError("client_uri must be a valid URL"); }
  }
  if (metadata.application_type === "native" && !nativeLoopbackEnabled &&
      !metadata.redirect_uris.some(uri => privateUseScheme(new URL(uri)))) {
    throw new RegistrationMetadataError("native clients are disabled");
  }
  for (const uri of [...metadata.redirect_uris, ...metadata.post_logout_redirect_uris ?? []]) {
    const url = new URL(uri);
    const loopback = metadata.application_type === "native" && nativeLoopbackEnabled &&
      loopbackRedirect(url);
    const privateUse = metadata.application_type === "native" && privateUseScheme(url);
    if (url.username || url.password || url.href.includes("#") ||
        (!privateUse && !loopback && (url.protocol !== "https:" || LOOPBACKS.has(url.hostname)))) {
      throw new RegistrationMetadataError("redirect URIs require HTTPS, a native private-use scheme or enabled native loopback");
    }
  }
  validateDcrBranding(metadata);
}

// One container: fixed windows bound memory and registration write pressure.
// Never evict a live bucket (which would allow key churn to reset a quota).
// At capacity, fail closed until a window expires. Restart resets the limits.
export function createRegistrationLimiter({ perIp = DEFAULT_DCR_LIMITS.perIp, perHost = DEFAULT_DCR_LIMITS.perHost,
  windowMs = 60 * 60 * 1000, maxKeys = 10_000 } = {}) {
  const buckets = new Map();
  return (ctx) => {
    // oidc-provider 9.12.2 calls this DCR idFactory after parsing JSON and
    // before copying the body into metadata for validation and persistence.
    // Ignore optional, untrusted branding here; CIMD never takes this path.
    delete ctx.oidc.body.logo_uri;
    // registrationResponse decides whether to generate a secret before applying
    // clientDefaults. Set the public default in the parsed request as well.
    ctx.oidc.body.token_endpoint_auth_method ??= "none";
    if (ctx.oidc.body.token_endpoint_auth_method !== "none") {
      throw new RegistrationMetadataError("only public clients are supported");
    }
    const now = Date.now();
    for (const [key, bucket] of buckets) if (bucket.until <= now) buckets.delete(key);
    const uris = ctx.oidc.body.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10) {
      throw new RegistrationMetadataError("register between one and ten redirect URIs");
    }
    let urls;
    try {
      urls = uris.map((uri) => new URL(uri));
    } catch { throw new RegistrationMetadataError("invalid redirect URI"); }
    // Some MCP clients omit application_type or send web for native callbacks.
    // Infer native only when every callback is private-use or HTTP loopback.
    // validateClientPolicy still enforces the native loopback configuration.
    if ((ctx.oidc.body.application_type === undefined || ctx.oidc.body.application_type === "web") &&
        urls.every(url => privateUseScheme(url) || loopbackRedirect(url))) {
      ctx.oidc.body.application_type = "native";
    }
    // Loopback and private-use authorities do not identify an app's web origin.
    // Charging them globally would cap every user of that app together.
    const hosts = [...new Set(urls.filter(url => url.protocol === "https:" && !LOOPBACKS.has(url.hostname))
      .map((url) => registrableDomain(url.hostname)))];
    const keys = [[`ip:${ctx.ip}`, perIp, "per-ip"],
      ...hosts.map((host) => [`host:${host}`, perHost, "per-redirect-host"])];
    const exhausted = keys.filter(([key, limit]) => (buckets.get(key)?.count ?? 0) >= limit);
    const atCapacity = buckets.size + keys.filter(([key]) => !buckets.has(key)).length > maxKeys;
    if (exhausted.length || atCapacity) {
      const until = exhausted.length
        ? Math.max(...exhausted.map(([key]) => buckets.get(key).until))
        : Math.min(...[...buckets.values()].map(bucket => bucket.until), now + windowMs);
      const reason = exhausted.length ? [...new Set(exhausted.map(([, , kind]) => kind))].join(", ") : "capacity";
      ctx.set("Retry-After", String(Math.max(1, Math.ceil((until - now) / 1000))));
      throw new RegistrationRequestError(`registration rate limit exceeded: ${reason}`, 429);
    }
    const reservation = keys.map(([key]) => {
      const bucket = buckets.get(key) ?? { count: 0, until: now + windowMs };
      bucket.count += 1;
      buckets.set(key, bucket);
      return [key, bucket];
    });
    // Reserve synchronously before metadata validation/storage yields. Settle at
    // provider completion, even if the peer disconnects during the store write.
    // Keep bucket references so a late failure cannot debit a replacement window.
    ctx.state.registrationSettle = (succeeded) => {
      delete ctx.state.registrationSettle;
      if (!succeeded) for (const [key, bucket] of reservation) {
        bucket.count -= 1;
        if (bucket.count === 0 && buckets.get(key) === bucket) buckets.delete(key);
      }
    };
    return randomBytes(24).toString("base64url");
  };
}

// Test/spike store. Production composes the PostgreSQL store below.
export function createMemoryRegistrationStore() {
  const clients = new Map();
  const store = {
    async upsert(id, metadata) {
      await store.cleanup();
      if (clients.size >= 10_000) throw new RegistrationRequestError("registration capacity exceeded", 429);
      const now = Date.now();
      clients.set(id, { client_id: id, metadata: structuredClone(metadata), registered_at: now,
        last_used_at: null, expires_at: now + REGISTRATION_IDLE_SECONDS * 1000 });
    },
    async find(id) {
      await store.cleanup();
      return structuredClone(clients.get(id)?.metadata);
    },
    async destroy(id) { clients.delete(id); },
    async markUsed(id) {
      await store.cleanup();
      const row = clients.get(id);
      if (row) { row.last_used_at = Date.now(); row.expires_at = Date.now() + REGISTRATION_IDLE_SECONDS * 1000; }
    },
    async cleanup() {
      let removed = 0;
      for (const [id, row] of clients) if (row.expires_at <= Date.now()) { clients.delete(id); removed += 1; }
      return removed;
    },
    async list() { await store.cleanup(); return structuredClone([...clients.values()]); },
  };
  return store;
}

// Safe for an internal admin caller; never exposed as an unauthenticated route.
export const LIST_REGISTRATIONS_SQL = `SELECT client_id, metadata, registered_at, last_used_at, expires_at
  FROM commonswarm_oauth.registered_clients
  WHERE expires_at > statement_timestamp()
  ORDER BY registered_at DESC, client_id LIMIT $1`;

export function createPostgresRegistrationStore(pool) {
  return {
    async upsert(id, metadata) {
      await pool.query(`INSERT INTO commonswarm_oauth.registered_clients (client_id, metadata)
        VALUES ($1, $2::jsonb)`, [id, JSON.stringify(metadata)]);
    },
    async find(id) {
      const result = await pool.query(`SELECT metadata FROM commonswarm_oauth.registered_clients
        WHERE client_id = $1 AND expires_at > statement_timestamp()`, [id]);
      return result.rows[0]?.metadata;
    },
    async destroy(id) {
      await pool.query("DELETE FROM commonswarm_oauth.registered_clients WHERE client_id = $1", [id]);
    },
    async markUsed(id) {
      await pool.query(`UPDATE commonswarm_oauth.registered_clients
        SET last_used_at = statement_timestamp(), expires_at = statement_timestamp() + interval '30 days'
        WHERE client_id = $1 AND expires_at > statement_timestamp()`, [id]);
    },
    async cleanup() {
      try {
        return (await pool.query(`DELETE FROM commonswarm_oauth.registered_clients
          WHERE expires_at <= statement_timestamp()`)).rowCount;
      } catch (error) {
        // Maintenance must not abort startup or the hourly retry. Request-time
        // reads and writes still reject when the database is unavailable.
        const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/u.test(error.code)
          ? error.code : "UNKNOWN";
        console.error(`mcp-auth registration cleanup failed (${code})`);
      }
    },
    async list(limit = 100) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("invalid listing limit");
      return (await pool.query(LIST_REGISTRATIONS_SQL, [limit])).rows;
    },
  };
}
