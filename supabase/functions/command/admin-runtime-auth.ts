import { ADMIN_RESOURCE, ADMIN_ACCESS_TTL_SECONDS } from '../_shared/protocol.js';

// Same signing authority as OAuth, but a distinct resource and signed binding.
// The existing MCP provider cannot issue these tokens; no MCP-token fallback.
export const ADMIN_RUNTIME_ISSUER = "https://mcp.commonswarm.com";
export const ADMIN_RUNTIME_JWKS_URL = "https://mcp.commonswarm.com/jwks";

const TOKEN_MAX_BYTES = 12 * 1024;
const JWKS_MAX_BYTES = 64 * 1024;
const JWKS_MAX_KEYS = 16;
const KID_MAX_LENGTH = 128;
const CLIENT_ID_MAX_LENGTH = 2048;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface VerifiedAdminRuntime {
  grant_id: string;
  owner_user_id: string;
  connection_id: string;
  client_id: string;
  resource: typeof ADMIN_RESOURCE;
  expires_at: number;
}

export interface JwtVerifierOptions {
  cacheTtlSeconds?: number;
  clockSkewSeconds?: number;
  fetch?: typeof fetch;
  now?: () => number;
  fetchTimeoutMs?: number;
}

interface PublicKeyEntry {
  kid: string;
  key: CryptoKey;
}

interface JsonObject {
  [key: string]: unknown;
}

export class AdminRuntimeTokenError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AdminRuntimeTokenError";
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function decodeBase64Url(value: string, limit: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length > Math.ceil(limit * 4 / 3) + 4) {
    throw new AdminRuntimeTokenError("invalid_token");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw new AdminRuntimeTokenError("invalid_token");
  }
  if (decoded.length > limit) throw new AdminRuntimeTokenError("invalid_token");
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function parsePart(value: string, limit: number): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64Url(value, limit),
    ));
  } catch (error) {
    if (error instanceof AdminRuntimeTokenError) throw error;
    throw new AdminRuntimeTokenError("invalid_token");
  }
  const result = object(parsed);
  if (result === null) throw new AdminRuntimeTokenError("invalid_token");
  return result;
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const announced = response.headers.get("content-length");
  if (announced !== null && (!/^\d+$/u.test(announced) || Number(announced) > maximum)) {
    throw new AdminRuntimeTokenError("jwks_unavailable");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximum) throw new AdminRuntimeTokenError("jwks_unavailable");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function boundedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  close: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("jwks_timeout")), timeoutMs);
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

export class AdminRuntimeJwtVerifier {
  readonly issuer = ADMIN_RUNTIME_ISSUER;
  readonly resource = ADMIN_RESOURCE;
  readonly jwksUrl = ADMIN_RUNTIME_JWKS_URL;
  private readonly cacheTtlSeconds: number;
  private readonly clockSkewSeconds: number;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;
  private keys = new Map<string, CryptoKey>();
  private cacheExpiresAt = 0;
  private refreshPromise: Promise<void> | null = null;

  constructor(options: JwtVerifierOptions = {}) {
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? 60;
    this.clockSkewSeconds = options.clockSkewSeconds ?? 0;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 3_000;
    if (!Number.isSafeInteger(this.cacheTtlSeconds) || this.cacheTtlSeconds < 1 ||
        this.cacheTtlSeconds > 300 || !Number.isSafeInteger(this.clockSkewSeconds) ||
        this.clockSkewSeconds < 0 || this.clockSkewSeconds > 60 ||
        !Number.isSafeInteger(this.fetchTimeoutMs) || this.fetchTimeoutMs < 100 ||
        this.fetchTimeoutMs > 10_000) {
      throw new Error("Admin runtime JWT bounds are invalid");
    }
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  private async refresh(parentSignal?: AbortSignal): Promise<void> {
    if (this.refreshPromise !== null) return await this.refreshPromise;
    const operation = (async () => {
      const linked = linkedSignal(parentSignal, this.fetchTimeoutMs);
      try {
        const response = await this.fetcher(this.jwksUrl, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          signal: linked.signal,
        });
        if (!response.ok || response.url !== "" && response.url !== this.jwksUrl) {
          throw new AdminRuntimeTokenError("jwks_unavailable");
        }
        const bytes = await boundedBytes(response, JWKS_MAX_BYTES);
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          throw new AdminRuntimeTokenError("jwks_unavailable");
        }
        const document = object(parsed);
        if (document === null || !Array.isArray(document.keys) ||
            document.keys.length < 1 || document.keys.length > JWKS_MAX_KEYS) {
          throw new AdminRuntimeTokenError("jwks_unavailable");
        }
        const imported: PublicKeyEntry[] = [];
        const seen = new Set<string>();
        for (const value of document.keys) {
          const jwk = object(value);
          const kid = jwk?.kid;
          if (jwk === null || typeof kid !== "string" || kid.length < 1 ||
              kid.length > KID_MAX_LENGTH || seen.has(kid) || jwk.kty !== "EC" ||
              jwk.crv !== "P-256" || jwk.alg !== "ES256" || jwk.use !== "sig" ||
              typeof jwk.x !== "string" || typeof jwk.y !== "string" ||
              Object.hasOwn(jwk, "d") ||
              (jwk.key_ops !== undefined &&
                (!Array.isArray(jwk.key_ops) || !jwk.key_ops.includes("verify")))) {
            throw new AdminRuntimeTokenError("jwks_unavailable");
          }
          seen.add(kid);
          try {
            imported.push({ kid, key: await crypto.subtle.importKey(
              "jwk",
              jwk as JsonWebKey,
              { name: "ECDSA", namedCurve: "P-256" },
              false,
              ["verify"],
            ) });
          } catch {
            throw new AdminRuntimeTokenError("jwks_unavailable");
          }
        }
        this.keys = new Map(imported.map(({ kid, key }) => [kid, key]));
        this.cacheExpiresAt = this.now() + this.cacheTtlSeconds;
      } catch (error) {
        if (error instanceof AdminRuntimeTokenError) throw error;
        throw new AdminRuntimeTokenError("jwks_unavailable");
      } finally {
        linked.close();
      }
    })();
    this.refreshPromise = operation;
    try {
      await operation;
    } finally {
      this.refreshPromise = null;
    }
  }

  async verify(token: string, signal?: AbortSignal): Promise<VerifiedAdminRuntime> {
    if (typeof token !== "string" || new TextEncoder().encode(token).byteLength > TOKEN_MAX_BYTES) {
      throw new AdminRuntimeTokenError("invalid_token");
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new AdminRuntimeTokenError("invalid_token");
    }
    const header = parsePart(parts[0]!, 2 * 1024);
    if (header.typ !== "at+jwt" || header.crit !== undefined || header.b64 !== undefined || header.alg !== "ES256" || typeof header.kid !== "string" ||
        header.kid.length < 1 || header.kid.length > KID_MAX_LENGTH ||
        Object.hasOwn(header, "jku") || Object.hasOwn(header, "jwk") ||
        Object.hasOwn(header, "x5u") || Object.hasOwn(header, "x5c")) {
      throw new AdminRuntimeTokenError("invalid_token");
    }
    let key = this.cacheExpiresAt > this.now() ? this.keys.get(header.kid) : undefined;
    if (key === undefined) {
      // A missing kid performs one bounded fetch. There is no second fallback,
      // and no URL or key carried by the token participates in this lookup.
      await this.refresh(signal);
      key = this.keys.get(header.kid);
    }
    if (key === undefined) throw new AdminRuntimeTokenError("invalid_token");
    const signature = decodeBase64Url(parts[2]!, 64);
    if (signature.byteLength !== 64) throw new AdminRuntimeTokenError("invalid_token");
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signatureBuffer = signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength,
    ) as ArrayBuffer;
    if (!await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, signatureBuffer, signed,
    )) throw new AdminRuntimeTokenError("invalid_token");

    const claims = parsePart(parts[1]!, 8 * 1024);
    const now = this.now();
    if (claims.iss !== this.issuer || claims.aud !== this.resource ||
        typeof claims.sub !== "string" || !UUID_RE.test(claims.sub) ||
        typeof claims.grant_id !== "string" || !UUID_RE.test(claims.grant_id) ||
        typeof claims.connection_id !== "string" || !UUID_RE.test(claims.connection_id) ||
        typeof claims.client_id !== "string" || claims.client_id.length < 1 ||
        claims.client_id.length > CLIENT_ID_MAX_LENGTH ||
        !boundedInteger(claims.iat) || !boundedInteger(claims.exp) ||
        claims.exp <= claims.iat || claims.exp - claims.iat > ADMIN_ACCESS_TTL_SECONDS ||
        claims.iat > now + this.clockSkewSeconds ||
        claims.iat < now - ADMIN_ACCESS_TTL_SECONDS - this.clockSkewSeconds ||
        claims.exp <= now - this.clockSkewSeconds ||
        claims.exp > now + ADMIN_ACCESS_TTL_SECONDS + this.clockSkewSeconds ||
        (claims.nbf !== undefined &&
          (!boundedInteger(claims.nbf) || claims.nbf > now + this.clockSkewSeconds ||
            claims.nbf > claims.exp))) {
      throw new AdminRuntimeTokenError("invalid_token");
    }
    return {
      grant_id: claims.grant_id.toLowerCase(),
      owner_user_id: claims.sub.toLowerCase(),
      connection_id: claims.connection_id.toLowerCase(),
      client_id: claims.client_id,
      resource: ADMIN_RESOURCE,
      expires_at: claims.exp * 1000,
    };
  }
}
