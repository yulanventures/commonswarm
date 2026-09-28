import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

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
  return `${SESSION_COOKIE}=${clear ? "" : value}; ${SESSION_COOKIE_ATTRIBUTES}${clear ? "; Max-Age=0" : ""}`;
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
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});
