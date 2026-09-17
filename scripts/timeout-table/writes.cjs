"use strict";

// Shared with preload.cjs. A measured operation must never send one of these
// to the origin. The sentence in run.mjs is built from this list.
const ORIGIN_WRITE_RULES = Object.freeze([
  Object.freeze({ method: "POST", pathPrefix: "/functions/v1/command", kind: "command" }),
  Object.freeze({ method: "POST", pathPrefix: "/functions/v1/activity", kind: "activity" }),
  Object.freeze({ method: "POST", pathPrefix: "/storage/v1/", kind: "storage" }),
  Object.freeze({ method: "PUT", pathPrefix: "/storage/v1/", kind: "storage" }),
]);

function originWriteKind(method, path) {
  const normalizedMethod = String(method ?? "").toUpperCase();
  const normalizedPath = String(path ?? "").split("?")[0];
  for (const rule of ORIGIN_WRITE_RULES) {
    if (normalizedMethod !== rule.method) continue;
    if (normalizedPath === rule.pathPrefix || normalizedPath.startsWith(rule.pathPrefix)) {
      return rule.kind;
    }
  }
  return null;
}

function describeOriginWriteRules() {
  return ORIGIN_WRITE_RULES.map(rule => `${rule.method} ${rule.pathPrefix}`).join(", ");
}

module.exports = { ORIGIN_WRITE_RULES, originWriteKind, describeOriginWriteRules };
