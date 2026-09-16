"use strict";

const { appendFileSync } = require("node:fs");
const { performance } = require("node:perf_hooks");

const base = process.env.TIMEOUT_TABLE_BASE_URL;
const original = process.env.TIMEOUT_TABLE_PROFILE_ORIGIN;
const logPath = process.env.TIMEOUT_TABLE_FETCH_LOG;

if (!base || !original || !logPath) {
  throw new Error("timeout-table preload needs base URL, profile origin, and log path");
}

const baseUrl = new URL(base);
const originalUrl = new URL(original);

function rewritten(raw) {
  const url = new URL(typeof raw === "string" || raw instanceof URL ? raw : raw.url);
  const webSocketEquivalent = (url.protocol === "ws:" || url.protocol === "wss:") &&
    url.host === originalUrl.host;
  if (url.origin === originalUrl.origin || webSocketEquivalent) {
    url.protocol = webSocketEquivalent
      ? (baseUrl.protocol === "https:" ? "wss:" : "ws:")
      : baseUrl.protocol;
    url.username = baseUrl.username;
    url.password = baseUrl.password;
    url.host = baseUrl.host;
  }
  return url;
}

function record(row) {
  // This allowlist is the privacy boundary. Do not add headers, bodies, query,
  // fragments, credentials, or the original URL.
  appendFileSync(logPath, `${JSON.stringify({
    transport: row.transport,
    method: row.method,
    path: row.path,
    status: row.status,
    duration_ms: row.duration_ms,
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

const originalFetch = globalThis.fetch;
if (typeof originalFetch === "function") {
  globalThis.fetch = async function timeoutTableFetch(input, init) {
    const url = rewritten(input);
    const forwarded = typeof Request === "function" && input instanceof Request
      ? new Request(url, input)
      : url;
    const started = performance.now();
    const method = String(init?.method ?? (typeof input === "object" && input?.method) ?? "GET").toUpperCase();
    try {
      const response = await originalFetch.call(this, forwarded, init);
      record({ transport: "fetch", method, path: url.pathname, status: response.status,
        duration_ms: performance.now() - started });
      return response;
    } catch (error) {
      record({ transport: "fetch", method, path: url.pathname, status: "ERROR",
        duration_ms: performance.now() - started });
      throw error;
    }
  };
}

const OriginalWebSocket = globalThis.WebSocket;
if (typeof OriginalWebSocket === "function") {
  class TimeoutTableWebSocket extends OriginalWebSocket {
    constructor(url, protocols) {
      const target = rewritten(url);
      const started = performance.now();
      super(target, ...(protocols === undefined ? [] : [protocols]));
      let done = false;
      const finish = status => {
        if (done) return;
        done = true;
        record({ transport: "websocket", method: "CONNECT", path: target.pathname, status,
          duration_ms: performance.now() - started });
      };
      this.addEventListener("open", () => finish(101), { once: true });
      this.addEventListener("error", () => finish("ERROR"), { once: true });
    }
  }
  Object.defineProperties(TimeoutTableWebSocket, {
    CONNECTING: { value: OriginalWebSocket.CONNECTING },
    OPEN: { value: OriginalWebSocket.OPEN },
    CLOSING: { value: OriginalWebSocket.CLOSING },
    CLOSED: { value: OriginalWebSocket.CLOSED },
  });
  globalThis.WebSocket = TimeoutTableWebSocket;
}
