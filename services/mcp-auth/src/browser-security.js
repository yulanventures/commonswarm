// Browser security: opaque values/origins in, cookies and response policies out.
// Form pages retain same-origin POST; P9b owns finish response policies.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { privateUseScheme } from "./registration.js";

export const SESSION_COOKIE = "__Host-cswarm-oauth";
export const SESSION_COOKIE_ATTRIBUTES = "Secure; HttpOnly; Path=/; SameSite=Lax";

export function randomOpaque(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function hashOpaque(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function opaqueMatches(value, expectedHash) {
  if (expectedHash == null) return false;
  const actual = hashOpaque(value);
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

export function sessionCookie(value, { clear = false } = {}) {
  return `${SESSION_COOKIE}=${clear ? "" : value}; ${SESSION_COOKIE_ATTRIBUTES}${clear ? "; Max-Age=0" : "; Max-Age=34560000"}`;
}

export function assertAllowedOrigin(origin, allowedOrigins) {
  if (typeof origin !== "string" || !allowedOrigins.has(origin)) {
    const error = new Error("request origin is not allowed");
    error.code = "origin_forbidden";
    throw error;
  }
}

export const INTERACTION_SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // same-origin, not no-referrer: under no-referrer the Fetch standard serializes the Origin of a form POST
  // as "null", so the strict Origin check below refused every real consent submission (live, 2026-10-02).
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
});

export function consentSecurityHeaders(redirectUri, { allowLoopback = false, registeredRedirectUris = [] } = {}) {
  // Use only the provider-validated interaction URI. Reject URL parser
  // normalization tricks before serializing a single CSP origin source.
  if (typeof redirectUri !== "string" || /[\s\u0000-\u001f\u007f\\]/u.test(redirectUri)) {
    throw new TypeError("invalid consent redirect URI");
  }
  const url = new URL(redirectUri);
  const origin = url.origin;
  const https = /^https:\/\/[a-z0-9.-]+(:\d+)?$/u.test(origin);
  const loopback = allowLoopback &&
    /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u.test(origin);
  const privateUse = privateUseScheme(url) && registeredRedirectUris.includes(redirectUri);
  if (url.username || url.password || url.href.includes("#") || (!https && !loopback && !privateUse)) {
    throw new TypeError("invalid consent redirect origin");
  }
  return {
    ...INTERACTION_SECURITY_HEADERS,
    "content-security-policy": INTERACTION_SECURITY_HEADERS["content-security-policy"]
      // Consent submits to the AS; form-action also governs the resulting
      // redirect chain. A custom URI has an opaque origin, so name its exact
      // registered scheme rather than serializing "null" or allowing all schemes.
      .replace("form-action 'self'", `form-action 'self' ${privateUse ? url.protocol : origin}`) + "; script-src 'self'; script-src-attr 'none'",
  };
}
