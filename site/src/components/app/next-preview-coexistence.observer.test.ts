/**
 * Mounted two-tab served-origin browser witness for /next preview coexistence with /app.
 *
 * Serves the REAL built site (`site/dist` including `/app`) and REAL built preview app
 * (`site/dist/next` or `app/dist` at `/next`) from ONE local loopback origin, configured with
 * the production API URL (`https://api.commonswarm.com`) so both tabs share `/app`'s real
 * `sb-api-auth-token` storage key and `lock:sb-api-auth-token` Web Lock while Playwright
 * intercepts every API and Realtime request locally (zero external network traffic).
 *
 * Proves:
 *  (a) Overlapping token refresh in both tabs spends the single-use refresh token once and
 *      neither tab is signed out.
 *  (b1/b2) A stale terminal verification (GET /user 403) or stale terminal refresh failure
 *      (POST /token 400) in one tab does not remove a replacement login stored by the other tab.
 *  (c) A private response held in `/next` stays retired after Tab A signs out, after the same
 *      person signs in again (new session_id), and after a workspace refusal: nothing private
 *      is painted and no stale request is sent.
 *  (d) The served `/next` response carries `Content-Security-Policy: frame-ancestors 'none'`
 *      (also verified against `deploy/site/commonswarm-site.caddy`, since this local test
 *      server is Node HTTP rather than Caddy) and a host page attempting to frame `/next`
 *      gets nothing.
 *  (e) Back / history-cache (bfcache) restore in `/next` observes a real `pageshow` with
 *      `persisted === true` (failing explicitly with CDP diagnostics if reloaded instead),
 *      paints zero old private content before revalidation settles, then paints the fresh read.
 *  (f) Back from cross-site navigation while `/next` holds an accepted, OPEN Phoenix-compatible
 *      realtime WebSocket (both same-login and login-change-while-away variants): observes and
 *      logs whether the browser restored from bfcache or performed a full reload, and asserts
 *      the full security invariants (socket closed in the leave phase, zero old private paint,
 *      no bearer-carrying or phx_join frames on the old socket after pagehide with optional
 *      bearer-free phx_leave, and only current-login topics/bearer after Back) for whichever
 *      outcome occurs.
 *
 * Deadlock safety: never hold a token-refresh or user-verification response while asking a peer
 * tab to acquire the same Web Lock. Scenarios (a), (b1), (b2), (e), and (f) release auth holds well
 * below the 4s `authFetch` timeout; (b2) closes the tab holding the intentional 30s refresh
 * cooldown before verifying fresh sign-in on the preserved replacement; (c) holds only post-token
 * data responses so the session Web Lock is completely free during peer sign-out and re-sign-in.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Browser, BrowserContext, Page, Route, WebSocketRoute } from "playwright-core";
import { browserTest as test } from "../../../tests/chrome.js";
import { launchPlaywrightChromium } from "../../../tests/chrome.js";
import { sessionStorageKeyForDeployment } from "../../../../shared/browser-session/index.js";
import { awaitSignal, createSignal, type Signal, type WaitableSignal } from "../../lib/await-signal.js";

const execFileAsync = promisify(execFile);

const API_ORIGIN = "https://api.commonswarm.com";
const STORAGE_KEY = sessionStorageKeyForDeployment(API_ORIGIN);
const LOCK_NAME = `lock:${STORAGE_KEY}`;
const ANON_KEY = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.fixture`;

const USER_A = {
  id: "11111111-1111-4111-8111-111111111111",
  aud: "authenticated",
  role: "authenticated",
  email: "owner@example.test",
  email_confirmed_at: "2026-11-01T00:00:00.000Z",
  phone: "",
  confirmed_at: "2026-11-01T00:00:00.000Z",
  last_sign_in_at: "2026-11-23T12:00:00.000Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: "Alex Owner" },
  identities: [],
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-23T12:00:00.000Z",
  is_anonymous: false,
};

const USER_B = {
  id: "22222222-2222-4222-8222-222222222222",
  aud: "authenticated",
  role: "authenticated",
  email: "teammate@example.test",
  email_confirmed_at: "2026-11-01T00:00:00.000Z",
  phone: "",
  confirmed_at: "2026-11-01T00:00:00.000Z",
  last_sign_in_at: "2026-11-23T12:05:00.000Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: "Blake Member" },
  identities: [],
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-23T12:05:00.000Z",
  is_anonymous: false,
};

const ORG_1 = "55555555-5555-4555-8555-555555555555";
const WS_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const WS_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const CONV_GEN_1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const CONV_GEN_2 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const CONV_SECRET_1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const CONV_SECRET_2 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc4";
const CONV_PUB_1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc5";
const CONV_PUB_2 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc6";
const NOW_ISO = "2026-11-23T12:00:00.000Z";

function makeJwt(userId: string, email: string, sessionId: string, expOffsetSec = 3600): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    iss: `${API_ORIGIN}/auth/v1`,
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    email,
    session_id: sessionId,
    iat: now,
    exp: now + expOffsetSec,
  })}.fixture-sig`;
}

function makeSessionPayload(options: {
  sessionId: string;
  refreshToken: string;
  expired?: boolean;
  user?: typeof USER_A;
}) {
  const user = options.user ?? USER_A;
  const now = Math.floor(Date.now() / 1000);
  const expOffset = options.expired ? -60 : 3600;
  return {
    access_token: makeJwt(user.id, user.email, options.sessionId, expOffset),
    refresh_token: options.refreshToken,
    expires_in: 3600,
    expires_at: now + expOffset,
    token_type: "bearer",
    user,
  };
}

function decodeJwtClaims(token: string | null | undefined): { sid: string | null; sub: string | null } {
  if (!token) return { sid: null, sub: null };
  const parts = token.split(".");
  if (parts.length !== 3) return { sid: null, sub: null };
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      session_id?: unknown;
      sub?: unknown;
    };
    return {
      sid: typeof payload.session_id === "string" ? payload.session_id : null,
      sub: typeof payload.sub === "string" ? payload.sub : null,
    };
  } catch {
    return { sid: null, sub: null };
  }
}

function decodeSidFromAuthHeader(authHeader: string | undefined): string {
  if (!authHeader?.startsWith("Bearer ")) return "none";
  const token = authHeader.slice("Bearer ".length).trim();
  const parts = token.split(".");
  if (parts.length !== 3) return "malformed";
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      session_id?: string;
    };
    return payload.session_id ?? "no-sid";
  } catch {
    return "unreadable";
  }
}

function injectRuntimeMeta(html: string, url: string, anonKey: string): string {
  const stripped = html.replace(
    /\s*<meta\s+name="commonswarm:(?:url|anon-key)"[^>]*\/?>/gi,
    "",
  );
  const injected =
    `    <meta name="commonswarm:url" content="${url}" />\n` +
    `    <meta name="commonswarm:anon-key" content="${anonKey}" />\n`;
  if (!stripped.includes("</head>")) {
    throw new Error("Built HTML missing </head> for runtime meta injection");
  }
  return stripped.replace("</head>", `${injected}  </head>`);
}

function mimeTypeFor(filePath: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
  };
  return types[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function ensureBuiltPreviewDist(repoRoot: string, siteDist: string): Promise<string> {
  const bundledNext = join(siteDist, "next");
  if (existsSync(join(bundledNext, "index.html"))) {
    return bundledNext;
  }
  const appDir = join(repoRoot, "app");
  const appDist = join(appDir, "dist");
  if (existsSync(join(appDist, "index.html"))) {
    return appDist;
  }
  // Fallback when a workflow_dispatch runs an older workflow definition that only built site/.
  if (!existsSync(join(appDir, "node_modules"))) {
    await execFileAsync("npm", ["ci", "--prefix", appDir, "--no-audit", "--no-fund"], {
      cwd: repoRoot,
      timeout: 120_000,
    });
  }
  await execFileAsync("npm", ["run", "build", "--prefix", appDir], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PUBLIC_SUPABASE_URL: API_ORIGIN,
      PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
    },
    timeout: 120_000,
  });
  assert.ok(existsSync(join(appDist, "index.html")), "app/dist/index.html must exist after building app/");
  return appDist;
}

interface ApiEvent {
  readonly id: number;
  readonly ts: number;
  readonly method: string;
  readonly path: string;
  sid: string;
  detail: string;
  status: number | "pending" | "aborted";
}

interface HeldRequest {
  readonly id: number;
  readonly startedAt: number;
  readonly method: string;
  readonly path: string;
  readonly sid: string;
  readonly detail: string;
}

interface TokenFetchRecord {
  readonly tab: string;
  readonly perfNow: number;
  readonly wallMs: number;
  readonly grantType: string;
  readonly holdsLock: boolean;
  readonly localLockHeld: boolean;
  readonly lockHeldByAny: boolean;
  readonly lockPendingCount: number;
  readonly rtLast4: string | null;
  readonly topFrame: string;
  readonly stack: readonly string[];
}

interface ScenarioConfig {
  name: string;
  validRefreshToken: string;
  nextRefreshToken: string;
  activeSessionIds: Set<string>;
  /** Optional hook to handle GET /auth/v1/user */
  onUserCheck?: (sid: string) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** Optional hook to handle POST /auth/v1/token?grant_type=refresh_token */
  onRefresh?: (refreshToken: string) => Promise<
    | { status: number; body: Record<string, unknown>; headers?: Record<string, string> }
    | { abort: "failed" | "connectionreset" | "timedout" }
  >;
  /** Session issued on POST /auth/v1/token?grant_type=password */
  onPasswordSignIn?: () => ReturnType<typeof makeSessionPayload>;
  /** Optional hook to customize or hold POST /functions/v1/read */
  onEdgeRead?: (body: Record<string, unknown>, sid: string) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** Optional hook to customize or hold POST /rest/v1/rpc/decision_queue */
  onDecisionQueue?: (body: Record<string, unknown>, sid: string) => Promise<{ status: number; body: unknown }>;
  /** Workspaces list returned by GET /rest/v1/workspaces */
  workspaces?: Array<{ id: string; name: string }>;
  /** Optional per-session workspaces override for GET /rest/v1/workspaces and home_overview */
  workspacesForSid?: (sid: string) => Array<{ id: string; name: string }>;
  /** Optional per-session user override for home_overview */
  userForSid?: (sid: string) => typeof USER_A;
  /** Optional custom handler for wss://api.commonswarm.com/** (defaults to closing immediately) */
  onWebSocket?: (ws: WebSocketRoute) => void;
}

interface RecordedSocketFrame {
  readonly socketId: number;
  readonly ts: number;
  readonly phase: string;
  readonly topic: string;
  readonly event: string;
  readonly joinRef: string | null;
  readonly ref: string | null;
  readonly hasBearer: boolean;
  readonly bearer: string | null;
  readonly bearerSid: string | null;
  readonly bearerSub: string | null;
  readonly raw: string;
}

interface RecordedSocket {
  readonly id: number;
  readonly url: string;
  readonly openedAt: number;
  readonly openedPhase: string;
  closed: boolean;
  closedAt: number | null;
  closedPhase: string | null;
  closedCode: number | undefined;
  closedReason: string | undefined;
  closeNotifications: number;
  readonly closedSignal: Signal<void>;
  readonly frames: RecordedSocketFrame[];
}

function createPhoenixSocketRecorder(getPhase: () => string) {
  let nextSocketId = 0;
  const sockets: RecordedSocket[] = [];

  const handleWebSocket = (ws: WebSocketRoute): void => {
    const id = ++nextSocketId;
    const record: RecordedSocket = {
      id,
      url: ws.url(),
      openedAt: Date.now(),
      openedPhase: getPhase(),
      closed: false,
      closedAt: null,
      closedPhase: null,
      closedCode: undefined,
      closedReason: undefined,
      closeNotifications: 0,
      closedSignal: createSignal<void>(),
      frames: [],
    };
    sockets.push(record);

    ws.onMessage((rawMessage) => {
      const rawText = typeof rawMessage === "string" ? rawMessage : rawMessage.toString("utf8");
      let format: "v2" | "v1" | "unknown" = "unknown";
      let joinRef: string | null = null;
      let ref: string | null = null;
      let topic = "<unparsed>";
      let event = "<unparsed>";
      let payload: unknown = null;

      try {
        const parsed = JSON.parse(rawText) as unknown;
        if (Array.isArray(parsed) && parsed.length >= 5) {
          format = "v2";
          joinRef = parsed[0] == null ? null : String(parsed[0]);
          ref = parsed[1] == null ? null : String(parsed[1]);
          topic = typeof parsed[2] === "string" ? parsed[2] : String(parsed[2] ?? "");
          event = typeof parsed[3] === "string" ? parsed[3] : String(parsed[3] ?? "");
          payload = parsed[4];
        } else if (parsed && typeof parsed === "object") {
          format = "v1";
          const obj = parsed as Record<string, unknown>;
          joinRef = obj.join_ref == null ? null : String(obj.join_ref);
          ref = obj.ref == null ? null : String(obj.ref);
          topic = typeof obj.topic === "string" ? obj.topic : String(obj.topic ?? "");
          event = typeof obj.event === "string" ? obj.event : String(obj.event ?? "");
          payload = obj.payload;
        }
      } catch {
        // Keep raw text in frame record for diagnostics.
      }

      const payloadObj =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : null;
      const bearer =
        payloadObj && typeof payloadObj.access_token === "string" && payloadObj.access_token.length > 0
          ? payloadObj.access_token
          : null;
      const claims = decodeJwtClaims(bearer);

      record.frames.push({
        socketId: id,
        ts: Date.now(),
        phase: getPhase(),
        topic,
        event,
        joinRef,
        ref,
        hasBearer: bearer !== null,
        bearer,
        bearerSid: claims.sid,
        bearerSub: claims.sub,
        raw: rawText,
      });

      if (record.closed) return;

      const replyOk = (replyJoinRef: string | null) => {
        const replyPayload = { status: "ok", response: {} };
        const serialized =
          format === "v1"
            ? JSON.stringify({ join_ref: replyJoinRef, ref, topic, event: "phx_reply", payload: replyPayload })
            : JSON.stringify([replyJoinRef, ref, topic, "phx_reply", replyPayload]);
        try {
          ws.send(serialized);
        } catch {
          // Socket may already be closing.
        }
      };

      if (event === "phx_join") {
        replyOk(joinRef);
      } else if (event === "heartbeat" && topic === "phoenix") {
        replyOk(null);
      } else if (event === "phx_leave") {
        replyOk(joinRef);
      }
    });

    ws.onClose((code, reason) => {
      record.closeNotifications += 1;
      if (!record.closed) {
        record.closed = true;
        record.closedAt = Date.now();
        record.closedPhase = getPhase();
        record.closedCode = code;
        record.closedReason = reason;
        record.closedSignal.resolve();
        // Acknowledge the close so Playwright's mock WebSocket transitions from CLOSING to CLOSED.
        void ws.close({ code: code ?? 1000, reason: reason ?? "" }).catch(() => undefined);
      }
    });
  };

  const summary = () =>
    sockets.map((s) => ({
      id: s.id,
      url: s.url,
      openedAt: s.openedAt,
      openedPhase: s.openedPhase,
      closed: s.closed,
      closedAt: s.closedAt,
      closedPhase: s.closedPhase,
      closedCode: s.closedCode,
      closeNotifications: s.closeNotifications,
      frames: s.frames.map((f) => ({
        ts: f.ts,
        phase: f.phase,
        topic: f.topic,
        event: f.event,
        hasBearer: f.hasBearer,
        bearerSid: f.bearerSid,
        bearerSub: f.bearerSub,
      })),
    }));

  return { sockets, handleWebSocket, summary };
}

function formatBfcacheNotRestoredReasons(
  cdpEvents: Array<Record<string, unknown>>,
  navReasons: unknown,
): string {
  const reasons: string[] = [];
  for (const ev of cdpEvents) {
    const explanations = ev.notRestoredExplanations;
    if (Array.isArray(explanations)) {
      for (const item of explanations) {
        if (item && typeof item === "object") {
          const rec = item as { reason?: unknown; context?: unknown };
          if (typeof rec.reason === "string" && rec.reason.length > 0) {
            const ctx = typeof rec.context === "string" && rec.context.length > 0 ? `(${rec.context})` : "";
            reasons.push(`${rec.reason}${ctx}`);
          }
        }
      }
    }
  }
  if (reasons.length === 0 && navReasons != null) {
    reasons.push(`nav:${JSON.stringify(navReasons)}`);
  }
  return reasons.length > 0 ? [...new Set(reasons)].join(",") : "unknown";
}

// Plain-string init script for POST /auth/v1/token instrumentation (no transpiler helpers, no named inner functions).
// Captures tab label, performance.now(), whether this tab holds lock:sb-api-auth-token at that instant,
// refresh token last 4 chars, and a 20-frame JS call stack BEFORE the fetch leaves the page.
function buildTokenFetchInitScript(tabLabel: string, lockName: string): string {
  return `(() => {
  if (window.__csTokenFetchInstrumented) return;
  window.__csTokenFetchInstrumented = true;
  var tabLabel = ${JSON.stringify(tabLabel)};
  var targetLock = ${JSON.stringify(lockName)};
  window.__csTokenFetchRecords = [];
  var myClientId = null;
  var localLockDepth = 0;

  var locks = navigator && navigator.locks;
  if (locks && typeof locks.request === "function") {
    var origLockRequest = locks.request.bind(locks);
    if (typeof locks.query === "function") {
      var probeName = "__cs_probe_" + tabLabel + "_" + Math.random().toString(36).slice(2);
      try {
        void origLockRequest(probeName, function () {
          return locks.query().then(function (q) {
            var held = (q && q.held) || [];
            for (var i = 0; i < held.length; i += 1) {
              if (held[i] && held[i].name === probeName && held[i].clientId) {
                myClientId = held[i].clientId;
                break;
              }
            }
          }).catch(function () {});
        }).catch(function () {});
      } catch (_e) {}
    }
    locks.request = function () {
      var args = Array.prototype.slice.call(arguments);
      var reqName = args[0];
      if (reqName !== targetLock) {
        return origLockRequest.apply(locks, args);
      }
      var cbIndex = typeof args[1] === "function" ? 1 : 2;
      var origCb = args[cbIndex];
      if (typeof origCb !== "function") {
        return origLockRequest.apply(locks, args);
      }
      args[cbIndex] = function (lock) {
        if (!lock) return origCb(lock);
        localLockDepth += 1;
        var released = false;
        var release = function () {
          if (released) return;
          released = true;
          localLockDepth = Math.max(0, localLockDepth - 1);
        };
        try {
          var res = origCb(lock);
          if (res && typeof res.then === "function") {
            return res.then(function (v) { release(); return v; }, function (err) { release(); throw err; });
          }
          release();
          return res;
        } catch (err) {
          release();
          throw err;
        }
      };
      return origLockRequest.apply(locks, args);
    };
  }

  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var urlStr = "";
    var method = "GET";
    try {
      if (typeof input === "string") {
        urlStr = input;
      } else if (input && typeof input.url === "string") {
        urlStr = input.url;
        if (input.method) method = String(input.method);
      } else if (input) {
        urlStr = String(input);
      }
      if (init && init.method) method = String(init.method);
    } catch (_e) {}

    var isTokenPost = false;
    var grantType = "";
    try {
      var parsedUrl = new URL(urlStr, location.href);
      if (method.toUpperCase() === "POST" && parsedUrl.pathname.endsWith("/auth/v1/token")) {
        isTokenPost = true;
        grantType = parsedUrl.searchParams.get("grant_type") || "";
      }
    } catch (_e) {}

    if (!isTokenPost) {
      return origFetch(input, init);
    }

    var perfNow = performance.now();
    var wallMs = Date.now();
    var rawStack = String((new Error()).stack || "");
    var stackLines = rawStack.split("\\n").slice(0, 20);
    var topFrame = "";
    for (var f = 1; f < stackLines.length; f += 1) {
      var line = stackLines[f].trim();
      if (line && line.indexOf("window.fetch") === -1) {
        topFrame = line;
        break;
      }
    }
    if (!topFrame && stackLines.length > 0) topFrame = stackLines[0].trim();

    var rtLast4 = null;
    try {
      var body = init && init.body;
      if (typeof body === "string") {
        var parsedBody = JSON.parse(body);
        if (parsedBody && typeof parsedBody.refresh_token === "string" && parsedBody.refresh_token.length > 0) {
          rtLast4 = parsedBody.refresh_token.slice(-4);
        }
      }
    } catch (_e) {}

    var localAtEntry = localLockDepth > 0;
    var queryPromise = locks && typeof locks.query === "function"
      ? locks.query().catch(function () { return null; })
      : Promise.resolve(null);

    return queryPromise.then(function (q) {
      var heldList = (q && q.held) || [];
      var pendingList = (q && q.pending) || [];
      var heldMatches = [];
      for (var i = 0; i < heldList.length; i += 1) {
        if (heldList[i] && heldList[i].name === targetLock) heldMatches.push(heldList[i]);
      }
      var pendingCount = 0;
      for (var j = 0; j < pendingList.length; j += 1) {
        if (pendingList[j] && pendingList[j].name === targetLock) pendingCount += 1;
      }
      var holdsLock = myClientId
        ? heldMatches.some(function (l) { return l.clientId === myClientId; })
        : (localAtEntry && heldMatches.length > 0);
      var record = {
        tab: tabLabel,
        perfNow: perfNow,
        wallMs: wallMs,
        grantType: grantType,
        holdsLock: holdsLock,
        localLockHeld: localAtEntry,
        lockHeldByAny: heldMatches.length > 0,
        lockPendingCount: pendingCount,
        rtLast4: rtLast4,
        topFrame: topFrame,
        stack: stackLines,
      };
      window.__csTokenFetchRecords.push(record);
      var report = typeof window.__csRecordTokenFetch === "function"
        ? Promise.resolve(window.__csRecordTokenFetch(record)).catch(function () {})
        : Promise.resolve();
      return report.then(function () {
        return origFetch(input, init);
      });
    });
  };
})();`;
}

// Plain-string init script for scenario (h): records every localStorage write/remove on STORAGE_KEY,
// and optionally renames the first lock:sb-api-auth-token acquisition so a second tab deterministically
// starts an overlapping refresh with the old token while the first tab's refresh is held.
function buildScenarioHInitScript(storageKey: string, lockName: string, bypassFirstLock: boolean): string {
  return `(() => {
  var targetKey = ${JSON.stringify(storageKey)};
  var targetLock = ${JSON.stringify(lockName)};
  var bypassFirst = ${JSON.stringify(bypassFirstLock)};
  window.__csStorageAudit = { writes: [], removals: [] };
  var proto = Storage.prototype;
  var origSet = proto.setItem;
  var origRemove = proto.removeItem;
  proto.setItem = function (k, v) {
    if (this === window.localStorage && k === targetKey) {
      var rt = null;
      try {
        var parsed = JSON.parse(String(v));
        rt = parsed && typeof parsed.refresh_token === "string" ? parsed.refresh_token : null;
      } catch (_e) {}
      window.__csStorageAudit.writes.push({ ts: Date.now(), refreshToken: rt, rawLen: String(v).length });
    }
    return origSet.apply(this, arguments);
  };
  proto.removeItem = function (k) {
    if (this === window.localStorage && k === targetKey) {
      window.__csStorageAudit.removals.push({ ts: Date.now() });
    }
    return origRemove.apply(this, arguments);
  };
  if (bypassFirst && navigator && navigator.locks && typeof navigator.locks.request === "function") {
    var locks = navigator.locks;
    var origReq = locks.request.bind(locks);
    var bypassed = false;
    locks.request = function () {
      var args = Array.prototype.slice.call(arguments);
      if (!bypassed && args[0] === targetLock) {
        bypassed = true;
        args[0] = targetLock + ":scenario-h-overlap";
      }
      return origReq.apply(locks, args);
    };
  }
})();`;
}

// Page init script for scenario (f) (plain string so esbuild never injects Node-only __name helpers).
// Captures pagehide/pageshow phase and every WebSocket.prototype.close() call made by the page so
// a restored bfcache document carries an in-page witness of when the app closed its socket.
const WS_CLOSE_OBSERVER_INIT_SCRIPT = `(() => {
  if (window.__wsCloseObserverInstalled) return;
  window.__wsCloseObserverInstalled = true;
  window.__wsLifecyclePhase = "active";
  window.__wsPagehideTs = null;
  window.__wsCloseLog = [];
  window.addEventListener("pagehide", function () {
    window.__wsLifecyclePhase = "pagehide";
    window.__wsPagehideTs = Date.now();
  }, true);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden" && window.__wsLifecyclePhase === "active") {
      window.__wsLifecyclePhase = "hidden";
    }
  }, true);
  window.addEventListener("pageshow", function (ev) {
    if (ev && ev.persisted) {
      window.__wsLifecyclePhase = "pageshow";
    }
  }, true);
  const proto = typeof WebSocket === "function" ? WebSocket.prototype : null;
  if (proto && typeof proto.close === "function") {
    const origClose = proto.close;
    proto.close = function (code, reason) {
      window.__wsCloseLog.push({
        url: typeof this.url === "string" ? this.url : "",
        readyStateBefore: this.readyState,
        phase: window.__wsLifecyclePhase,
        ts: Date.now(),
      });
      return origClose.apply(this, arguments);
    };
  }
})();`;

function makeConversation(options: {
  id: string;
  slug: string;
  kind?: "general" | "public_channel" | "private_channel";
  joined?: boolean;
  userId?: string;
}) {
  return {
    conversation_id: options.id,
    kind: options.kind ?? "public_channel",
    channel_id: options.kind === "general" ? null : options.id,
    slug: options.slug,
    description: null,
    archived_at: null,
    joined: options.joined ?? true,
    generation: 1,
    members: [
      { kind: "user", id: options.userId ?? USER_A.id, joined_at: NOW_ISO, left_at: null },
    ],
    notify_level: "everything",
    starred: false,
    star_rank: null,
    unread_count: 0,
    mention_count: 0,
    last_message_at: null,
    last_message_id: null,
  };
}

function buildHomeOverview(
  workspaces: Array<{ id: string; name: string }>,
  user: typeof USER_A = USER_A,
) {
  return {
    viewer_user_id: user.id,
    generated_at: NOW_ISO,
    workspaces: workspaces.map((ws) => ({
      workspace_id: ws.id,
      name: ws.name,
      role: "owner",
      last_seen_at: NOW_ISO,
      new_messages: 0,
      content: null,
      people: [
        {
          user_id: user.id,
          display_name: user.user_metadata.full_name,
          role: "owner",
          is_viewer: true,
          agents: [],
        },
      ],
      needs_you: { asks: [], assigned: [], waiting: [] },
    })),
  };
}

const repeatScenarioARaw = process.env.CS_REPEAT_SCENARIO_A?.trim() ?? "";
const REPEAT_SCENARIO_A_COUNT =
  /^\d+$/.test(repeatScenarioARaw) && Number(repeatScenarioARaw) > 0
    ? Number(repeatScenarioARaw)
    : 1;

test(
  "served /app and /next two-tab coexistence: single-use refresh, stale terminal guard, held private retirement, and anti-framing",
  { timeout: Math.max(180_000, REPEAT_SCENARIO_A_COUNT * 30_000) },
  async (t) => {
  const siteRoot = resolve(import.meta.dirname, "../../..");
  const repoRoot = resolve(siteRoot, "..");
  const siteDist = join(siteRoot, "dist");
  assert.ok(existsSync(join(siteDist, "app/index.html")), "CI must build site/dist/app/index.html first");
  const nextDist = await ensureBuiltPreviewDist(repoRoot, siteDist);

  // Verify the repository Caddy config carries the exact /next security headers (local test server is Node HTTP).
  const caddyConfig = await readFile(join(repoRoot, "deploy/site/commonswarm-site.caddy"), "utf8");
  assert.match(
    caddyConfig,
    /@next path \/next \/next\/\*\n\t\theader @next \{\n\t\t\tContent-Security-Policy "frame-ancestors 'none'"\n\t\t\tX-Content-Type-Options "nosniff"\n\t\t\tReferrer-Policy "no-referrer"\n\t\t\}/u,
    "deploy/site/commonswarm-site.caddy must configure /next anti-framing and security headers",
  );
  assert.match(
    caddyConfig,
    /@nextHtml path \/next \/next\/ \/next\/index\.html \/next\/index\.html\/\n\t\theader @nextHtml Cache-Control "no-cache"/u,
    "deploy/site/commonswarm-site.caddy must set Cache-Control: no-cache on /next HTML",
  );

  // Start ONE local origin serving BOTH site/dist (/app, /_astro/*, /fonts/*) AND nextDist (/next, /next/assets/*, /next/fonts/*).
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = reqUrl.pathname;

      if (pathname === "/seed") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end("<!doctype html><html><head><meta charset=\"utf-8\"></head><body>seed</body></html>");
        return;
      }

      if (pathname === "/bfcache-control") {
        // Match production /next HTML Cache-Control ("no-cache", never "no-store") so the
        // plain-page control proves the harness + header policy can perform a persisted restore.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
        res.end("<!doctype html><html><head><meta charset=\"utf-8\"><title>BFCache Control</title></head><body><h1>Plain Control</h1></body></html>");
        return;
      }

      if (pathname === "/away") {
        // Cache-Control must NOT be no-store so the browser stays eligible for back-forward cache.
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" });
        res.end("<!doctype html><html><head><meta charset=\"utf-8\"><title>Away</title></head><body><h1>Away</h1></body></html>");
        return;
      }

      if (pathname === "/frame-host") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>Frame Host</title></head>` +
          `<body><h1>Host</h1><iframe id="framed-next" src="/next"></iframe></body></html>`,
        );
        return;
      }

      const isNext = pathname === "/next" || pathname.startsWith("/next/");
      const nextHeaders: Record<string, string> = isNext
        ? {
            "content-security-policy": "frame-ancestors 'none'",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
            ...(pathname === "/next" || pathname === "/next/" || pathname === "/next/index.html"
              ? { "cache-control": "no-cache" }
              : pathname.startsWith("/next/assets/")
                ? { "cache-control": "public, max-age=31536000, immutable" }
                : { "cache-control": "public, max-age=0, must-revalidate" }),
          }
        : { "cache-control": "public, max-age=0, must-revalidate" };

      try {
        let filePath: string;
        if (isNext) {
          const rel =
            pathname === "/next" || pathname === "/next/"
              ? "index.html"
              : pathname.slice("/next/".length);
          filePath = resolve(nextDist, rel);
          if (!filePath.startsWith(`${resolve(nextDist)}/`)) {
            res.writeHead(404, nextHeaders);
            res.end("not found");
            return;
          }
        } else {
          const rel =
            pathname === "/app" || pathname === "/app/"
              ? "app/index.html"
              : pathname === "/"
                ? "index.html"
                : pathname.replace(/^\//, "");
          filePath = resolve(siteDist, rel);
          if (!filePath.startsWith(`${resolve(siteDist)}/`)) {
            res.writeHead(404);
            res.end("not found");
            return;
          }
        }
        let body = await readFile(filePath);
        if (filePath.endsWith(".html")) {
          body = Buffer.from(injectRuntimeMeta(body.toString("utf8"), API_ORIGIN, ANON_KEY), "utf8");
        }
        res.writeHead(200, { "content-type": mimeTypeFor(filePath), ...nextHeaders });
        res.end(body);
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...nextHeaders });
        res.end("The page could not be found\n\nNOT_FOUND\n\ncommonswarm::not-found\n");
      }
    })();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const { chromium } = await import("playwright-core");
  const browser = await launchPlaywrightChromium(chromium);

  try {
    // ── Helper: build an isolated BrowserContext with scripted API + rich timeout diagnostics ──
    async function withTwoTabScenario(
      scenario: ScenarioConfig,
      body: (ctx: {
        context: BrowserContext;
        apiLog: ApiEvent[];
        tokenFetchRecords: TokenFetchRecord[];
        counters: { refreshes: number; rejectedRefreshes: number; userChecks: number; logouts: number };
        consoleErrors: string[];
        getInFlightApiRequests: () => number;
        setStep: (s: string) => void;
        attachPageDiagnostics: (label: string, p: Page) => void;
        instrumentTab: (label: string, p: Page) => Promise<void>;
        emitRefreshDiagnostics: (label: string) => void;
        dumpDiagnostics: (pages: Record<string, Page | null>) => Promise<string>;
        waitFor: (
          label: string,
          predicate: () => Promise<boolean> | boolean,
          pages: Record<string, Page | null>,
          timeoutMs?: number,
        ) => Promise<void>;
        waitForSignal: (
          label: string,
          signals: WaitableSignal | Record<string, WaitableSignal>,
          pages: Record<string, Page | null>,
          timeoutMs?: number,
        ) => Promise<void>;
        seedStorage: (sessionObj: ReturnType<typeof makeSessionPayload> | null) => Promise<void>;
        readStorage: (p: Page) => Promise<{ refresh_token?: string; access_token?: string; user?: { id?: string } } | null>;
        waitForAppSignedIn: (p: Page, pages: Record<string, Page | null>) => Promise<void>;
        waitForNextSignedIn: (p: Page, expectedText: string, pages: Record<string, Page | null>) => Promise<void>;
        signOutFromApp: (p: Page, pages: Record<string, Page | null>) => Promise<void>;
      }) => Promise<void>,
      targetBrowser: Browser = browser,
    ): Promise<void> {
      const context = await targetBrowser.newContext({ viewport: { width: 1280, height: 900 } });
      const apiLog: ApiEvent[] = [];
      const tokenFetchRecords: TokenFetchRecord[] = [];
      const inFlightRequests = new Map<number, HeldRequest>();
      const consoleErrors: string[] = [];
      const counters = { refreshes: 0, rejectedRefreshes: 0, userChecks: 0, logouts: 0 };
      let nextRequestId = 0;
      let currentStep = `${scenario.name}:init`;
      await context.exposeFunction("__csRecordTokenFetch", (rec: TokenFetchRecord) => {
        tokenFetchRecords.push(rec);
      });
      const defaultWorkspaces = scenario.workspaces ?? [
        { id: WS_1, name: "Alpha Vault" },
        { id: WS_2, name: "Beta Vault" },
      ];

      const corsHeaders = {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        "access-control-allow-headers":
          "authorization,apikey,content-type,accept,accept-profile,content-profile,x-client-info,x-supabase-api-version,prefer",
        "access-control-expose-headers": "x-supabase-api-version, retry-after",
        "x-supabase-api-version": "2024-01-01",
      };

      const isAbortedRouteError = (route: Route, err: unknown): boolean => {
        if (route.request().failure() !== null) return true;
        const msg = err instanceof Error ? err.message : String(err);
        return /target (?:page, context or browser )?has been closed|route is already handled|request was aborted|interception/i.test(msg);
      };

      const fulfillJson = async (
        route: Route,
        entry: ApiEvent,
        status: number,
        payload: unknown,
        detail: string,
        overrideSid?: string,
        extraHeaders?: Record<string, string>,
      ) => {
        if (overrideSid !== undefined) entry.sid = overrideSid;
        entry.detail = detail;
        entry.status = status;
        try {
          await route.fulfill({
            status,
            headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8", ...(extraHeaders ?? {}) },
            body: JSON.stringify(payload),
          });
        } catch (err) {
          if (isAbortedRouteError(route, err)) {
            entry.status = "aborted";
            entry.detail = `${detail} (aborted-before-fulfill)`;
            return;
          }
          throw err;
        }
      };

      await context.routeWebSocket("wss://api.commonswarm.com/**", (ws) => {
        if (scenario.onWebSocket) {
          scenario.onWebSocket(ws);
          return;
        }
        ws.close();
      });

      await context.route("https://api.commonswarm.com/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const method = req.method().toUpperCase();
        if (method === "OPTIONS") {
          await route.fulfill({ status: 204, headers: corsHeaders, body: "" }).catch(() => undefined);
          return;
        }
        const headers = req.headers();
        const sid = decodeSidFromAuthHeader(headers.authorization);
        const parseJsonBody = (): Record<string, unknown> => {
          const raw = req.postData();
          if (!raw) return {};
          try {
            return JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return {};
          }
        };
        const reqBodyForDetail = method === "POST" ? parseJsonBody() : {};
        const initialDetail =
          url.pathname === "/functions/v1/read"
            ? `edge-read(${String(reqBodyForDetail.resource ?? "")}:${String(reqBodyForDetail.workspace_id ?? "")})`
            : url.pathname === "/auth/v1/token"
              ? `token(${url.searchParams.get("grant_type") ?? ""})`
              : url.pathname.startsWith("/rest/v1/rpc/")
                ? `${url.pathname.slice("/rest/v1/rpc/".length)}(${String(reqBodyForDetail.p_workspace_id ?? "")})`
                : url.pathname;
        const reqId = ++nextRequestId;
        const entry: ApiEvent = {
          id: reqId,
          ts: Date.now(),
          method,
          path: url.pathname,
          sid,
          detail: initialDetail,
          status: "pending",
        };
        apiLog.push(entry);
        if (apiLog.length > 1000) apiLog.shift();
        inFlightRequests.set(reqId, {
          id: reqId,
          startedAt: entry.ts,
          method,
          path: url.pathname,
          sid,
          detail: initialDetail,
        });
        try {
        if (url.pathname === "/auth/v1/settings" && method === "GET") {
          await fulfillJson(route, entry, 200, { external: { google: false, github: false, email: true } }, "settings");
          return;
        }
        if (url.pathname === "/auth/v1/user" && method === "GET") {
          counters.userChecks += 1;
          if (scenario.onUserCheck) {
            const out = await scenario.onUserCheck(sid);
            await fulfillJson(route, entry, out.status, out.body, `user-hook(${out.status})`);
            return;
          }
          if (!scenario.activeSessionIds.has(sid)) {
            await fulfillJson(
              route,
              entry,
              403,
              { code: "session_not_found", error_code: "session_not_found", msg: "Session not found" },
              "user-revoked",
            );
            return;
          }
          await fulfillJson(route, entry, 200, USER_A, "user-ok");
          return;
        }
        if (url.pathname === "/auth/v1/logout" && method === "POST") {
          counters.logouts += 1;
          scenario.activeSessionIds.delete(sid);
          entry.detail = "logout";
          entry.status = 204;
          try {
            await route.fulfill({ status: 204, headers: corsHeaders, body: "" });
          } catch (err) {
            if (isAbortedRouteError(route, err)) {
              entry.status = "aborted";
              entry.detail = "logout (aborted-before-fulfill)";
              return;
            }
            throw err;
          }
          return;
        }
        if (url.pathname === "/auth/v1/token" && method === "POST") {
          const grant = url.searchParams.get("grant_type") ?? "";
          const reqBody = reqBodyForDetail;
          if (grant === "password") {
            const issued = scenario.onPasswordSignIn
              ? scenario.onPasswordSignIn()
              : makeSessionPayload({ sessionId: `sid-pw-${Date.now()}`, refreshToken: `rt-pw-${Date.now()}` });
            const issuedSid = decodeSidFromAuthHeader(`Bearer ${issued.access_token}`);
            scenario.activeSessionIds.add(issuedSid);
            scenario.validRefreshToken = issued.refresh_token;
            await fulfillJson(route, entry, 200, issued, "password-signin", issuedSid);
            return;
          }
          if (grant === "refresh_token") {
            counters.refreshes += 1;
            const rt = String(reqBody.refresh_token ?? "");
            if (scenario.onRefresh) {
              const out = await scenario.onRefresh(rt);
              if ("abort" in out) {
                counters.rejectedRefreshes += 1;
                entry.status = "aborted";
                entry.detail = `refresh-aborted(${rt}:${out.abort})`;
                await route.abort(out.abort).catch(() => undefined);
                return;
              }
              if (out.status >= 400) counters.rejectedRefreshes += 1;
              await fulfillJson(route, entry, out.status, out.body, `refresh(${rt})`, undefined, out.headers);
              return;
            }
            if (rt !== scenario.validRefreshToken) {
              counters.rejectedRefreshes += 1;
              await fulfillJson(
                route,
                entry,
                400,
                { code: "refresh_token_already_used", error_code: "refresh_token_already_used", msg: "Already used" },
                `refresh-rejected(${rt})`,
              );
              return;
            }
            const nextSession = makeSessionPayload({
              sessionId: [...scenario.activeSessionIds][0] ?? "sid-default",
              refreshToken: scenario.nextRefreshToken,
            });
            scenario.validRefreshToken = scenario.nextRefreshToken;
            await fulfillJson(route, entry, 200, nextSession, `refresh-ok(${rt}->${scenario.nextRefreshToken})`);
            return;
          }
          await fulfillJson(route, entry, 400, { error: "unsupported_grant_type" }, `token-${grant}`);
          return;
        }

        // Authenticated data routes (PostgREST + Edge Functions):
        if (!scenario.activeSessionIds.has(sid)) {
          if (url.pathname.startsWith("/rest/v1/")) {
            await fulfillJson(route, entry, 401, { code: "session_not_found", message: "Session ended" }, "rest-401");
          } else {
            await fulfillJson(route, entry, 401, { error: "unauthenticated" }, "edge-401");
          }
          return;
        }

        if (url.pathname === "/rest/v1/workspaces" && method === "GET") {
          const workspacesForReq = scenario.workspacesForSid ? scenario.workspacesForSid(sid) : defaultWorkspaces;
          const rows = workspacesForReq.map((ws) => ({
            workspace_id: ws.id,
            org_id: ORG_1,
            org_display_name: "Alpha Org",
            name: ws.name,
            archived_at: null,
            lead_agent_principal_id: null,
            channel_creation_policy: "members",
          }));
          await fulfillJson(route, entry, 200, rows, "workspaces");
          return;
        }
        if (url.pathname === "/rest/v1/rpc/home_overview" && method === "POST") {
          const workspacesForReq = scenario.workspacesForSid ? scenario.workspacesForSid(sid) : defaultWorkspaces;
          const userForReq = scenario.userForSid ? scenario.userForSid(sid) : USER_A;
          await fulfillJson(route, entry, 200, buildHomeOverview(workspacesForReq, userForReq), "home_overview");
          return;
        }
        if (url.pathname === "/rest/v1/rpc/decision_queue" && method === "POST") {
          const reqBody = reqBodyForDetail;
          if (scenario.onDecisionQueue) {
            const out = await scenario.onDecisionQueue(reqBody, sid);
            await fulfillJson(route, entry, out.status, out.body, `decision_queue(${String(reqBody.p_workspace_id ?? "")})`);
            return;
          }
          await fulfillJson(
            route,
            entry,
            200,
            {
              workspace_id: String(reqBody.p_workspace_id ?? WS_1),
              generated_at: NOW_ISO,
              total: 0,
              truncated: false,
              asks: [],
            },
            `decision_queue(${String(reqBody.p_workspace_id ?? "")})`,
          );
          return;
        }
        if (url.pathname === "/rest/v1/rpc/waiting_todos_page" && method === "POST") {
          const reqBody = reqBodyForDetail;
          await fulfillJson(
            route,
            entry,
            200,
            {
              workspace_id: String(reqBody.p_workspace_id ?? WS_1),
              generated_at: NOW_ISO,
              total: 0,
              truncated: false,
              todos: [],
            },
            `waiting_todos(${String(reqBody.p_workspace_id ?? "")})`,
          );
          return;
        }
        if (url.pathname === "/rest/v1/rpc/channel_unread" && method === "POST") {
          const reqBody = reqBodyForDetail;
          await fulfillJson(
            route,
            entry,
            200,
            { workspace_id: String(reqBody.p_workspace_id ?? WS_1), generated_at: NOW_ISO, channels: [] },
            "channel_unread",
          );
          return;
        }
        if (url.pathname === "/rest/v1/member_profiles" && method === "GET") {
          await fulfillJson(
            route,
            entry,
            200,
            [{ user_id: USER_A.id, display_name: "Alex Owner", role: "owner" }],
            "member_profiles",
          );
          return;
        }
        if (url.pathname === "/rest/v1/channels" && method === "GET") {
          await fulfillJson(
            route,
            entry,
            200,
            [
              {
                channel_id: CONV_GEN_1,
                workspace_id: WS_1,
                slug: "general",
                purpose: null,
                visibility: "open",
                created_by_principal: USER_A.id,
                created_by_kind: "user",
                created_at: NOW_ISO,
                archived_at: null,
              },
            ],
            "channels",
          );
          return;
        }
        if (url.pathname.startsWith("/rest/v1/")) {
          await fulfillJson(route, entry, 200, [], `rest-empty(${url.pathname})`);
          return;
        }
        if (url.pathname === "/functions/v1/read" && method === "POST") {
          const reqBody = reqBodyForDetail;
          if (scenario.onEdgeRead) {
            const out = await scenario.onEdgeRead(reqBody, sid);
            await fulfillJson(
              route,
              entry,
              out.status,
              out.body,
              `edge-read(${String(reqBody.resource ?? "")}:${String(reqBody.workspace_id ?? "")})`,
            );
            return;
          }
          if (reqBody.resource === "conversations") {
            const wsId = String(reqBody.workspace_id ?? WS_1);
            await fulfillJson(
              route,
              entry,
              200,
              {
                conversations: [
                  makeConversation({
                    id: wsId === WS_2 ? CONV_GEN_2 : CONV_GEN_1,
                    slug: "general",
                    kind: "general",
                  }),
                  makeConversation({
                    id: wsId === WS_2 ? CONV_PUB_2 : CONV_PUB_1,
                    slug: wsId === WS_2 ? "beta-room" : "alpha-room",
                    kind: "public_channel",
                  }),
                ],
              },
              `conversations(${wsId})`,
            );
            return;
          }
          if (reqBody.resource === "conversation_history") {
            await fulfillJson(route, entry, 200, { signals: [], has_more: false, mentions: [], reactions: [] }, "conv_history");
            return;
          }
          if (reqBody.resource === "seat_admin_status") {
            await fulfillJson(route, entry, 200, { enabled: false }, "seat_admin_status");
            return;
          }
          if (reqBody.resource === "pending_access") {
            await fulfillJson(route, entry, 200, { pending: [], agents: [] }, "pending_access");
            return;
          }
          if (reqBody.resource === "review_checks") {
            await fulfillJson(route, entry, 200, { checks: [] }, "review_checks");
            return;
          }
          await fulfillJson(route, entry, 200, { grants: [], invitations: [] }, `edge-read-other(${String(reqBody.resource ?? "")})`);
          return;
        }
        if (url.pathname === "/functions/v1/command" && method === "POST") {
          await fulfillJson(route, entry, 200, { status: "accepted" }, "command");
          return;
        }
        await fulfillJson(route, entry, 404, { error: "not_found" }, "unknown");
        } finally {
          inFlightRequests.delete(reqId);
        }
      });

      const attachPageDiagnostics = (label: string, p: Page) => {
        p.on("pageerror", (err) => consoleErrors.push(`${label} pageerror: ${err.message}`));
        p.on("console", (msg) => {
          if (msg.type() === "error") consoleErrors.push(`${label} console.error: ${msg.text()}`);
        });
      };

      const instrumentTab = async (label: string, p: Page): Promise<void> => {
        await p.addInitScript(buildTokenFetchInitScript(label, LOCK_NAME));
      };

      const emitRefreshDiagnostics = (label: string): void => {
        for (const rec of tokenFetchRecords) {
          t.diagnostic(
            `[${label}] POST /auth/v1/token tab=${rec.tab} grant=${rec.grantType} t=${rec.perfNow.toFixed(1)}ms holdsLock=${rec.holdsLock} (local=${rec.localLockHeld},any=${rec.lockHeldByAny},pending=${rec.lockPendingCount}) rt=…${rec.rtLast4 ?? "none"} frame=${rec.topFrame}`,
          );
        }
      };

      const dumpDiagnostics = async (pages: Record<string, Page | null>): Promise<string> => {
        const domSnapshots: Record<string, unknown> = {};
        for (const [label, p] of Object.entries(pages)) {
          if (!p || p.isClosed()) {
            domSnapshots[label] = "closed";
            continue;
          }
          domSnapshots[label] = await p
            .evaluate((key: string) => {
              const raw = localStorage.getItem(key);
              let storedSummary: unknown = null;
              if (raw) {
                try {
                  const parsed = JSON.parse(raw) as { refresh_token?: string; user?: { id?: string } };
                  storedSummary = { refresh_token: parsed.refresh_token, userId: parsed.user?.id };
                } catch {
                  storedSummary = "unparseable";
                }
              }
              const dash = document.querySelector<HTMLElement>("live-dashboard");
              const signedOutPanel = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
              const closedScreen = document.querySelector<HTMLElement>('[data-testid="closed-screen"]');
              const signedOutScreen = document.querySelector<HTMLElement>('[data-testid="signed-out-screen"]');
              const recoveryScreen = document.querySelector<HTMLElement>('[data-testid="session-recovery-screen"]');
              const checkingScreen = document.querySelector<HTMLElement>('[data-testid="session-checking-screen"]');
              const privateRoot = document.querySelector<HTMLElement>('[data-testid="private-view-root"]');
              const workspaceUnavailable = document.querySelector<HTMLElement>('[data-testid="workspace-unavailable"]');
              const sidebarLoading = document.querySelector<HTMLElement>('[data-testid="sidebar-loading"]');
              const sidebarError = document.querySelector<HTMLElement>('[data-testid="sidebar-error"]');
              const sessionGate = closedScreen
                ? { status: "closed", reason: closedScreen.getAttribute("data-closed-reason") ?? "unknown" }
                : signedOutScreen
                  ? { status: "signed_out", reason: null }
                  : recoveryScreen
                    ? { status: "recovery", reason: null }
                    : checkingScreen
                      ? { status: "checking", reason: null }
                      : privateRoot
                        ? {
                            status: privateRoot.hidden ? "authenticated_hidden" : "authenticated",
                            reason: workspaceUnavailable
                              ? "workspace_unavailable"
                              : sidebarError
                                ? "sidebar_error"
                                : sidebarLoading
                                  ? "sidebar_loading"
                                  : null,
                          }
                        : dash
                          ? {
                              status: `app:${dash.dataset.state ?? "unknown"}`,
                              reason: signedOutPanel && !signedOutPanel.hidden ? "signed_out_panel_visible" : null,
                            }
                          : { status: "sample_or_unmounted", reason: null };
              const testIds = [...document.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid"));
              return {
                href: location.href,
                sessionGate,
                dashboardState: dash?.dataset.state ?? null,
                testIds,
                storedSummary,
                bodyPreview: (document.body?.innerText ?? "").slice(0, 300),
              };
            }, STORAGE_KEY)
            .catch((e: unknown) => `eval-failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        const now = Date.now();
        return JSON.stringify(
          {
            scenario: scenario.name,
            step: currentStep,
            counters,
            activeSessionIds: [...scenario.activeSessionIds],
            domSnapshots,
            tokenFetchRecords,
            heldRequests: [...inFlightRequests.values()].map((r) => ({
              id: r.id,
              method: r.method,
              path: r.path,
              sid: r.sid,
              detail: r.detail,
              ageMs: now - r.startedAt,
            })),
            consoleErrors: consoleErrors.slice(-30),
            recentApiLog: apiLog.slice(-30),
          },
          null,
          2,
        );
      };

      const waitFor = async (
        label: string,
        predicate: () => Promise<boolean> | boolean,
        pages: Record<string, Page | null>,
        timeoutMs = 20_000,
      ): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (await predicate()) return;
          await new Promise((r) => setTimeout(r, 30));
        }
        const diag = await dumpDiagnostics(pages);
        throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}\nDiagnostics:\n${diag}`);
      };

      const waitForSignal = async (
        label: string,
        signals: WaitableSignal | Record<string, WaitableSignal>,
        pages: Record<string, Page | null>,
        timeoutMs = 20_000,
      ): Promise<void> => {
        const entries: Array<[string, WaitableSignal]> =
          "promise" in signals
            ? [[label, signals as WaitableSignal]]
            : Object.entries(signals);
        const settled = await awaitSignal(
          entries.map(([, sig]) => sig.promise),
          timeoutMs,
        );
        if (settled) return;
        const signalStates = Object.fromEntries(
          entries.map(([name, sig]) => [name, sig.resolved ? "resolved" : "pending"]),
        );
        const diag = await dumpDiagnostics(pages);
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for signal "${label}"\n` +
          `Signal states: ${JSON.stringify(signalStates)}\n` +
          `In-flight API requests: ${inFlightRequests.size}\n` +
          `Diagnostics:\n${diag}`,
        );
      };

      const seedStorage = async (sessionObj: ReturnType<typeof makeSessionPayload> | null): Promise<void> => {
        const seeder = await context.newPage();
        await seeder.goto(`${origin}/seed`);
        await seeder.evaluate(
          ({ key, value }: { key: string; value: string | null }) => {
            localStorage.clear();
            if (value !== null) localStorage.setItem(key, value);
          },
          { key: STORAGE_KEY, value: sessionObj ? JSON.stringify(sessionObj) : null },
        );
        await seeder.close();
      };

      const readStorage = async (p: Page) =>
        p.evaluate((key: string) => {
          const raw = localStorage.getItem(key);
          if (!raw) return null;
          return JSON.parse(raw) as { refresh_token?: string; access_token?: string; user?: { id?: string } };
        }, STORAGE_KEY);

      const waitForAppSignedIn = async (p: Page, pages: Record<string, Page | null>): Promise<void> => {
        await waitFor(
          "Tab A (/app) signed in",
          () =>
            p.evaluate(() => {
              const dash = document.querySelector<HTMLElement>("live-dashboard");
              const signedOut = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
              const state = dash?.dataset.state ?? "";
              return Boolean(
                state &&
                state !== "loading" &&
                state !== "signed-out" &&
                state !== "workspace-error" &&
                signedOut?.hidden,
              );
            }),
          pages,
        );
      };

      const waitForNextSignedIn = async (
        p: Page,
        expectedText: string,
        pages: Record<string, Page | null>,
      ): Promise<void> => {
        await waitFor(
          `Tab B (/next) signed in with "${expectedText}"`,
          () =>
            p.evaluate((needle: string) => {
              const root = document.querySelector('[data-testid="private-view-root"]');
              if (!root) return false;
              return (document.body.innerText ?? "").includes(needle);
            }, expectedText),
          pages,
        );
      };

      const signOutFromApp = async (p: Page, pages: Record<string, Page | null>): Promise<void> => {
        await waitFor(
          "Tab A user menu trigger visible",
          () => p.locator("[data-user-menu-trigger]").first().isVisible().catch(() => false),
          pages,
        );
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const open = await p.evaluate(() => {
            const menu = document.querySelector<HTMLElement>("[data-user-menu]");
            return Boolean(menu && !menu.hidden);
          });
          if (!open) await p.click("[data-user-menu-trigger]");
          const visible = await p.locator("[data-user-menu] [data-signout]").isVisible().catch(() => false);
          if (visible) {
            await p.click("[data-user-menu] [data-signout]");
            return;
          }
          await p.waitForTimeout(100);
        }
        throw new Error(`Could not click [data-user-menu] [data-signout]\n${await dumpDiagnostics(pages)}`);
      };

      try {
        await body({
          context,
          apiLog,
          tokenFetchRecords,
          counters,
          consoleErrors,
          getInFlightApiRequests: () => inFlightRequests.size,
          setStep: (s) => { currentStep = `${scenario.name}:${s}`; },
          attachPageDiagnostics,
          instrumentTab,
          emitRefreshDiagnostics,
          dumpDiagnostics,
          waitFor,
          waitForSignal,
          seedStorage,
          readStorage,
          waitForAppSignedIn,
          waitForNextSignedIn,
          signOutFromApp,
        });
      } finally {
        await context.close();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // (a) Overlapping token refresh in both tabs spends the refresh token once
    //     and neither tab is signed out. Supports CS_REPEAT_SCENARIO_A=N.
    // ═══════════════════════════════════════════════════════════════════════════
    for (let run = 1; run <= REPEAT_SCENARIO_A_COUNT; run += 1) {
      const runLabel = REPEAT_SCENARIO_A_COUNT > 1 ? `a-overlapping-refresh#run${run}/${REPEAT_SCENARIO_A_COUNT}` : "a-overlapping-refresh";
      const sidA = "sid-overlap-1";
      const firstRefreshHit = createSignal<void>();
      const releaseFirstRefresh = createSignal<void>();
      let rotatedTokenReused = false;
      const scenario: ScenarioConfig = {
        name: runLabel,
        validRefreshToken: "rt-overlap-1",
        nextRefreshToken: "rt-overlap-2",
        activeSessionIds: new Set([sidA]),
        async onRefresh(rt) {
          if (rt !== scenario.validRefreshToken) {
            rotatedTokenReused = true;
            return {
              status: 400,
              body: { code: "refresh_token_already_used", error_code: "refresh_token_already_used", msg: "Already used" },
            };
          }
          scenario.validRefreshToken = scenario.nextRefreshToken;
          firstRefreshHit.resolve();
          await releaseFirstRefresh.promise;
          return {
            status: 200,
            body: makeSessionPayload({ sessionId: sidA, refreshToken: scenario.nextRefreshToken }),
          };
        },
      };

      await withTwoTabScenario(scenario, async (ctx) => {
        try {
        ctx.setStep("seed-expired-session");
        await ctx.seedStorage(makeSessionPayload({ sessionId: sidA, refreshToken: "rt-overlap-1", expired: true }));

        const tabA = await ctx.context.newPage();
        const tabB = await ctx.context.newPage();
        ctx.attachPageDiagnostics("tabA", tabA);
        ctx.attachPageDiagnostics("tabB", tabB);
        await ctx.instrumentTab("tabA", tabA);
        await ctx.instrumentTab("tabB", tabB);
        const pages = { tabA, tabB };

        ctx.setStep("open-both-tabs-simultaneously");
        await Promise.all([tabA.goto(`${origin}/app`), tabB.goto(`${origin}/next`)]);

        ctx.setStep("wait-for-first-refresh-and-peer-lock-contention");
        await ctx.waitForSignal("first refresh to hit scripted API", firstRefreshHit, pages);

        // Give the peer tab up to 600ms (well below authFetch's 4000ms timeout!) to queue on lock:sb-api-auth-token.
        const overlapDeadline = Date.now() + 600;
        while (Date.now() < overlapDeadline) {
          const lockState = await tabA.evaluate(async (lockName: string) => {
            const q = await navigator.locks.query();
            return {
              held: q.held?.some((l) => l.name === lockName) ?? false,
              pending: q.pending?.some((l) => l.name === lockName) ?? false,
            };
          }, LOCK_NAME).catch(() => ({ held: false, pending: false }));
          if (lockState.held && lockState.pending) break;
          await new Promise((r) => setTimeout(r, 25));
        }

        ctx.setStep("release-first-refresh");
        releaseFirstRefresh.resolve();

        await ctx.waitForAppSignedIn(tabA, pages);
        await ctx.waitForNextSignedIn(tabB, "Alpha Vault", pages);

        ctx.emitRefreshDiagnostics(runLabel);
        if (rotatedTokenReused) {
          t.diagnostic(
            `[${runLabel}] ROTATED TOKEN REUSED — full tokenFetchRecords:\n${JSON.stringify(ctx.tokenFetchRecords, null, 2)}`,
          );
        }

        const stored = await ctx.readStorage(tabA);
        assert.equal(ctx.counters.refreshes, 1, `Expected single-use refresh token spent once:\n${await ctx.dumpDiagnostics(pages)}`);
        assert.equal(ctx.counters.rejectedRefreshes, 0, `Expected zero rejected refreshes:\n${await ctx.dumpDiagnostics(pages)}`);
        assert.equal(stored?.refresh_token, "rt-overlap-2", "Rotated refresh token must be persisted");
        assert.equal(await tabB.locator('[data-testid="signed-out-screen"]').count(), 0, "Tab B must remain signed in");
        } finally {
          releaseFirstRefresh.resolve();
        }
      });

      if (rotatedTokenReused) break;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // (b1) Stale terminal verification (GET /auth/v1/user 403 session_not_found)
    //      in Tab B does not remove a replacement login stored by Tab A, releases
    //      the shared Web Lock immediately, and both tabs adopt the replacement.
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const staleSid = "sid-stale-user-1";
      const replacementSid = "sid-replacement-user-2";
      const staleUserHit = createSignal<void>();
      const releaseStaleUser = createSignal<void>();

      const scenario: ScenarioConfig = {
        name: "b1-stale-terminal-user-preserves-replacement",
        validRefreshToken: "rt-replacement-u2",
        nextRefreshToken: "rt-replacement-u3",
        activeSessionIds: new Set([replacementSid]),
        async onUserCheck(sid) {
          if (sid === staleSid) {
            staleUserHit.resolve();
            await releaseStaleUser.promise;
            return {
              status: 403,
              body: { code: "session_not_found", error_code: "session_not_found", msg: "Session not found" },
            };
          }
          if (scenario.activeSessionIds.has(sid)) {
            return { status: 200, body: USER_A };
          }
          return {
            status: 403,
            body: { code: "session_not_found", error_code: "session_not_found", msg: "Session not found" },
          };
        },
      };

      await withTwoTabScenario(scenario, async (ctx) => {
        try {
        ctx.setStep("seed-stale-unexpired-session");
        await ctx.seedStorage(makeSessionPayload({ sessionId: staleSid, refreshToken: "rt-stale-u1", expired: false }));

        const tabA = await ctx.context.newPage();
        const tabB = await ctx.context.newPage();
        ctx.attachPageDiagnostics("tabA", tabA);
        ctx.attachPageDiagnostics("tabB", tabB);
        const pages = { tabA, tabB };

        await tabA.goto(`${origin}/seed`);
        ctx.setStep("boot-tabB-with-stale-session");
        await tabB.goto(`${origin}/next`);

        await ctx.waitForSignal("Tab B stale GET /auth/v1/user to reach API", staleUserHit, pages);

        // While Tab B holds the stale getUser() verification in flight, Tab A stores the replacement login
        // directly in shared localStorage (firing a real cross-tab StorageEvent without blocking on Tab B's lock).
        ctx.setStep("tabA-stores-replacement-login");
        const replacementPayload = makeSessionPayload({
          sessionId: replacementSid,
          refreshToken: "rt-replacement-u2",
          expired: false,
        });
        await tabA.evaluate(
          ({ key, val }: { key: string; val: string }) => {
            localStorage.setItem(key, val);
          },
          { key: STORAGE_KEY, val: JSON.stringify(replacementPayload) },
        );
        await new Promise((r) => setTimeout(r, 80));

        ctx.setStep("release-stale-terminal-user-403");
        releaseStaleUser.resolve();

        // Both tabs adopt/keep the replacement login immediately (no 30s refresh cooldown on GET /user).
        await tabA.goto(`${origin}/app`);
        await ctx.waitForAppSignedIn(tabA, pages);
        await ctx.waitForNextSignedIn(tabB, "Alpha Vault", pages);

        const stored = await ctx.readStorage(tabA);
        assert.equal(
          stored?.refresh_token,
          "rt-replacement-u2",
          `Stale terminal user check must NOT remove replacement login:\n${await ctx.dumpDiagnostics(pages)}`,
        );
        assert.equal(await tabB.locator('[data-testid="signed-out-screen"]').count(), 0, "Tab B must remain signed in on replacement login");
        } finally {
          releaseStaleUser.resolve();
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // (b2) Stale terminal refresh failure (400 refresh_token_not_found) in Tab B
    //      does not remove a replacement login stored by Tab A and does not retry
    //      the stale token. Because authFetch holds a 30s single-flight refresh
    //      cooldown inside Tab B's Web Lock after a changed-storage refresh error,
    //      we assert storage preservation first and then close Tab B to release its
    //      cooldown lock before verifying fresh /app and /next sign-in on it.
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const staleSid = "sid-stale-1";
      const replacementSid = "sid-replacement-2";
      const staleRefreshHit = createSignal<void>();
      const releaseStaleRefresh = createSignal<void>();

      const scenario: ScenarioConfig = {
        name: "b2-stale-terminal-refresh-preserves-replacement",
        validRefreshToken: "rt-replacement-2",
        nextRefreshToken: "rt-replacement-3",
        activeSessionIds: new Set([replacementSid]),
        async onRefresh(rt) {
          if (rt === "rt-stale-1") {
            staleRefreshHit.resolve();
            await releaseStaleRefresh.promise;
            return {
              status: 400,
              body: { code: "refresh_token_not_found", error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" },
            };
          }
          return {
            status: 200,
            body: makeSessionPayload({ sessionId: replacementSid, refreshToken: "rt-replacement-3" }),
          };
        },
      };

      await withTwoTabScenario(scenario, async (ctx) => {
        try {
        ctx.setStep("seed-stale-expired-session");
        await ctx.seedStorage(makeSessionPayload({ sessionId: staleSid, refreshToken: "rt-stale-1", expired: true }));

        const tabA = await ctx.context.newPage();
        const tabB = await ctx.context.newPage();
        ctx.attachPageDiagnostics("tabA", tabA);
        ctx.attachPageDiagnostics("tabB", tabB);
        const pages: Record<string, Page | null> = { tabA, tabB };

        await tabA.goto(`${origin}/seed`);
        ctx.setStep("boot-tabB-with-expired-stale-session");
        await tabB.goto(`${origin}/next`);

        await ctx.waitForSignal("Tab B stale refresh to reach API", staleRefreshHit, pages);

        ctx.setStep("tabA-stores-replacement-login");
        const replacementPayload = makeSessionPayload({
          sessionId: replacementSid,
          refreshToken: "rt-replacement-2",
          expired: false,
        });
        await tabA.evaluate(
          ({ key, val }: { key: string; val: string }) => {
            localStorage.setItem(key, val);
          },
          { key: STORAGE_KEY, val: JSON.stringify(replacementPayload) },
        );
        await new Promise((r) => setTimeout(r, 80));

        ctx.setStep("release-stale-terminal-refresh-400");
        releaseStaleRefresh.resolve();
        // Wait past GoTrue's initial 200ms retry attempt so any unguarded removal or retry would have fired.
        await new Promise((r) => setTimeout(r, 500));

        const storedAfterStale400 = await ctx.readStorage(tabA);
        assert.equal(
          storedAfterStale400?.refresh_token,
          "rt-replacement-2",
          `Stale terminal refresh must NOT remove replacement login:\n${await ctx.dumpDiagnostics(pages)}`,
        );
        assert.equal(
          ctx.counters.rejectedRefreshes,
          1,
          `Stale refresh must NOT hammer GoTrue after replacement:\n${await ctx.dumpDiagnostics(pages)}`,
        );

        // Close Tab B to release its intentional 30s refresh-cooldown Web Lock, then prove
        // both /app and /next boot cleanly on the preserved replacement login.
        ctx.setStep("close-cooldown-tab-and-verify-replacement-usable");
        await tabB.close();
        pages.tabB = null;
        const tabB2 = await ctx.context.newPage();
        ctx.attachPageDiagnostics("tabB2", tabB2);
        pages.tabB2 = tabB2;

        await Promise.all([tabA.goto(`${origin}/app`), tabB2.goto(`${origin}/next`)]);
        await ctx.waitForAppSignedIn(tabA, pages);
        await ctx.waitForNextSignedIn(tabB2, "Alpha Vault", pages);

        const storedFinal = await ctx.readStorage(tabA);
        assert.equal(storedFinal?.refresh_token, "rt-replacement-2", "Preserved replacement login must remain intact");
        } finally {
          releaseStaleRefresh.resolve();
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // (c1 + c2) Held private response in /next stays retired across:
    //   - Tab A sign-out
    //   - Same-person re-sign-in (same user.id, new session_id)
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const sid1 = "sid-c-login-1";
      const sid2 = "sid-c-login-2";
      const sid3 = "sid-c-login-3";
      let holdWs2ForSid: string | null = null;
      let heldWs2Hit: Signal<void> | null = null;
      let releaseHeldWs2: Signal<void> | null = null;
      let secretSlugForHeld = "secret-c1-vault";
      let nextPasswordSession = () => makeSessionPayload({ sessionId: sid2, refreshToken: "rt-c-2" });

      const scenario: ScenarioConfig = {
        name: "c1-c2-held-private-signout-and-relogin",
        validRefreshToken: "rt-c-1",
        nextRefreshToken: "rt-c-1b",
        activeSessionIds: new Set([sid1]),
        onPasswordSignIn: () => nextPasswordSession(),
        async onEdgeRead(reqBody, sid) {
          if (reqBody.resource === "conversations") {
            const wsId = String(reqBody.workspace_id ?? WS_1);
            if (wsId === WS_2 && holdWs2ForSid === sid) {
              holdWs2ForSid = null;
              heldWs2Hit?.resolve();
              await releaseHeldWs2?.promise;
              return {
                status: 200,
                body: {
                  conversations: [
                    makeConversation({ id: CONV_GEN_2, slug: "general", kind: "general" }),
                    makeConversation({ id: CONV_SECRET_1, slug: secretSlugForHeld, kind: "private_channel", joined: true }),
                  ],
                },
              };
            }
            return {
              status: 200,
              body: {
                conversations: [
                  makeConversation({
                    id: wsId === WS_2 ? CONV_GEN_2 : CONV_GEN_1,
                    slug: "general",
                    kind: "general",
                  }),
                  makeConversation({
                    id: wsId === WS_2 ? CONV_PUB_2 : CONV_PUB_1,
                    slug: wsId === WS_2 ? "beta-public-clean" : "alpha-room",
                    kind: "public_channel",
                  }),
                ],
              },
            };
          }
          if (reqBody.resource === "conversation_history") {
            return { status: 200, body: { signals: [], has_more: false, mentions: [], reactions: [] } };
          }
          if (reqBody.resource === "seat_admin_status") return { status: 200, body: { enabled: false } };
          if (reqBody.resource === "pending_access") return { status: 200, body: { pending: [], agents: [] } };
          if (reqBody.resource === "review_checks") return { status: 200, body: { checks: [] } };
          return { status: 200, body: { grants: [], invitations: [] } };
        },
      };

      await withTwoTabScenario(scenario, async (ctx) => {
        try {
        ctx.setStep("c1-boot-both-tabs");
        await ctx.seedStorage(makeSessionPayload({ sessionId: sid1, refreshToken: "rt-c-1" }));
        const tabA = await ctx.context.newPage();
        const tabB = await ctx.context.newPage();
        ctx.attachPageDiagnostics("tabA", tabA);
        ctx.attachPageDiagnostics("tabB", tabB);
        const pages = { tabA, tabB };

        await Promise.all([tabA.goto(`${origin}/app`), tabB.goto(`${origin}/next`)]);
        await ctx.waitForAppSignedIn(tabA, pages);
        await ctx.waitForNextSignedIn(tabB, "alpha-room", pages);

        // Hold WS_2 private conversations response in Tab B (Web Lock is FREE!).
        ctx.setStep("c1-hold-ws2-private-response");
        holdWs2ForSid = sid1;
        secretSlugForHeld = "secret-c1-signout-only";
        heldWs2Hit = createSignal<void>();
        releaseHeldWs2 = createSignal<void>();
        await tabB.click('button[aria-label="Beta Vault workspace"]');
        await ctx.waitForSignal("held WS_2 conversations request (c1)", heldWs2Hit, pages);

        // Sign out from Tab A (/app).
        ctx.setStep("c1-tabA-sign-out");
        await ctx.signOutFromApp(tabA, pages);
        await ctx.waitFor(
          "Tab A signed out and Tab B retired to signed-out-screen",
          async () => {
            const aOut = await tabA.locator('[data-panel="signed-out"]:not([hidden])').isVisible().catch(() => false);
            const bOut = await tabB.locator('[data-testid="signed-out-screen"]').isVisible().catch(() => false);
            return aOut && bOut;
          },
          pages,
        );

        const sid1EventsAfterSignOutStart = ctx.apiLog.filter((e) => e.sid === sid1 && !e.path.endsWith("/logout")).length;

        // Release the held private response AFTER sign-out.
        ctx.setStep("c1-release-held-private-after-signout");
        releaseHeldWs2.resolve();
        await new Promise((r) => setTimeout(r, 250));

        const tabBTextAfterSignOut = await tabB.evaluate(() => document.body.innerText ?? "");
        assert.equal(
          tabBTextAfterSignOut.includes("secret-c1-signout-only"),
          false,
          `Held private channel leaked after Tab A sign-out:\n${await ctx.dumpDiagnostics(pages)}`,
        );
        assert.equal(await tabB.locator('[data-testid="private-view-root"]').count(), 0, "Private view root must stay unmounted");
        assert.equal(
          ctx.apiLog.filter((e) => e.sid === sid1 && !e.path.endsWith("/logout")).length,
          sid1EventsAfterSignOutStart,
          `Stale sid1 request sent after sign-out:\n${await ctx.dumpDiagnostics(pages)}`,
        );

        // ── (c2) Same person signs in again (sid2), holds private response, signs out + signs in again (sid3) ──
        ctx.setStep("c2-sign-in-same-user-sid2");
        nextPasswordSession = () => makeSessionPayload({ sessionId: sid2, refreshToken: "rt-c-2" });
        await tabA.fill("#dashboard-email", USER_A.email);
        await tabA.fill("#dashboard-password", "pw-owner");
        await tabA.click("[data-password-signin]");
        await ctx.waitForAppSignedIn(tabA, pages);
        await ctx.waitForNextSignedIn(tabB, "alpha-room", pages);

        // Hold WS_2 private response under sid2.
        ctx.setStep("c2-hold-ws2-private-response-sid2");
        holdWs2ForSid = sid2;
        secretSlugForHeld = "secret-c2-sid2-only";
        heldWs2Hit = createSignal<void>();
        releaseHeldWs2 = createSignal<void>();
        await tabB.click('button[aria-label="Beta Vault workspace"]');
        await ctx.waitForSignal("held WS_2 conversations request (c2)", heldWs2Hit, pages);

        // Sign out and sign back in as the SAME person (USER_A) with NEW session_id sid3!
        ctx.setStep("c2-same-user-signout-and-resignin-sid3");
        await ctx.signOutFromApp(tabA, pages);
        await ctx.waitFor(
          "Tab A and Tab B signed out before same-user re-sign-in",
          async () =>
            (await tabA.locator('[data-panel="signed-out"]:not([hidden])').isVisible().catch(() => false)) &&
            (await tabB.locator('[data-testid="signed-out-screen"]').isVisible().catch(() => false)),
          pages,
        );
        const sid2EventsAtSignOut = ctx.apiLog.filter((e) => e.sid === sid2 && !e.path.endsWith("/logout")).length;

        nextPasswordSession = () => makeSessionPayload({ sessionId: sid3, refreshToken: "rt-c-3" });
        await tabA.fill("#dashboard-email", USER_A.email);
        await tabA.fill("#dashboard-password", "pw-owner");
        await tabA.click("[data-password-signin]");
        await ctx.waitForAppSignedIn(tabA, pages);
        await ctx.waitForNextSignedIn(tabB, "alpha-room", pages);

        // Release the held sid2 private response AFTER the same person signed in again with sid3!
        ctx.setStep("c2-release-held-sid2-response-under-sid3");
        releaseHeldWs2.resolve();
        await new Promise((r) => setTimeout(r, 250));

        const tabBTextAfterRelogin = await tabB.evaluate(() => document.body.innerText ?? "");
        assert.equal(
          tabBTextAfterRelogin.includes("secret-c2-sid2-only"),
          false,
          `Same-person re-sign-in revived held sid2 private response:\n${await ctx.dumpDiagnostics(pages)}`,
        );
        assert.equal(
          ctx.apiLog.filter((e) => e.sid === sid2 && !e.path.endsWith("/logout")).length,
          sid2EventsAtSignOut,
          `Stale sid2 request sent after same-user re-sign-in:\n${await ctx.dumpDiagnostics(pages)}`,
        );
        } finally {
          releaseHeldWs2?.resolve();
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // (c3) Held private response in /next stays retired after workspace refusal
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const sidRefusal = "sid-c3-refusal";
      const ws2ConvHit = createSignal<void>();
      const ws2ConvRelease = createSignal<void>();
      const ws2DecisionHit = createSignal<void>();
      const ws2DecisionRelease = createSignal<void>();
      let ws2RequestsAfterRefusal = 0;
      let refusedWs2 = false;

      const scenario: ScenarioConfig = {
        name: "c3-held-private-workspace-refusal",
        validRefreshToken: "rt-c3-1",
        nextRefreshToken: "rt-c3-2",
        activeSessionIds: new Set([sidRefusal]),
        workspaces: [
          { id: WS_1, name: "Alpha Vault" },
          { id: WS_2, name: "Revoked Vault" },
        ],
        async onEdgeRead(reqBody) {
          if (reqBody.resource === "conversations") {
            const wsId = String(reqBody.workspace_id ?? WS_1);
            if (wsId === WS_2) {
              if (refusedWs2) ws2RequestsAfterRefusal += 1;
              ws2ConvHit.resolve();
              await ws2ConvRelease.promise;
              return {
                status: 200,
                body: {
                  conversations: [
                    makeConversation({ id: CONV_SECRET_2, slug: "secret-revoked-ws-room", kind: "private_channel", joined: true }),
                  ],
                },
              };
            }
            return {
              status: 200,
              body: {
                conversations: [
                  makeConversation({ id: CONV_GEN_1, slug: "general", kind: "general" }),
                  makeConversation({ id: CONV_PUB_1, slug: "alpha-room", kind: "public_channel" }),
                ],
              },
            };
          }
          if (reqBody.resource === "conversation_history") {
            return { status: 200, body: { signals: [], has_more: false, mentions: [], reactions: [] } };
          }
          if (reqBody.resource === "seat_admin_status") return { status: 200, body: { enabled: false } };
          if (reqBody.resource === "pending_access") return { status: 200, body: { pending: [], agents: [] } };
          if (reqBody.resource === "review_checks") return { status: 200, body: { checks: [] } };
          return { status: 200, body: { grants: [], invitations: [] } };
        },
        async onDecisionQueue(reqBody) {
          const wsId = String(reqBody.p_workspace_id ?? WS_1);
          if (wsId === WS_2) {
            if (refusedWs2) ws2RequestsAfterRefusal += 1;
            ws2DecisionHit.resolve();
            await ws2DecisionRelease.promise;
            // Production authoritative non-member refusal: HTTP 200 JSON null.
            return { status: 200, body: null };
          }
          return {
            status: 200,
            body: { workspace_id: wsId, generated_at: NOW_ISO, total: 0, truncated: false, asks: [] },
          };
        },
      };

      await withTwoTabScenario(scenario, async (ctx) => {
        try {
        ctx.setStep("c3-boot-tabB");
        await ctx.seedStorage(makeSessionPayload({ sessionId: sidRefusal, refreshToken: "rt-c3-1" }));
        const tabB = await ctx.context.newPage();
        ctx.attachPageDiagnostics("tabB", tabB);
        const pages = { tabB };

        await tabB.goto(`${origin}/next`);
        await ctx.waitForNextSignedIn(tabB, "alpha-room", pages);

        ctx.setStep("c3-select-ws2-and-hold-both-conversations-and-decision-queue");
        await tabB.click('button[aria-label="Revoked Vault workspace"]');
        await ctx.waitForSignal(
          "WS_2 conversations and decision_queue both in flight",
          { ws2ConvHit, ws2DecisionHit },
          pages,
        );

        ctx.setStep("c3-deliver-workspace-refusal-first");
        ws2DecisionRelease.resolve();
        await ctx.waitFor(
          "Tab B renders workspace-unavailable",
          () => tabB.locator('[data-testid="workspace-unavailable"]').isVisible().catch(() => false),
          pages,
        );
        refusedWs2 = true;

        ctx.setStep("c3-release-held-private-ws2-conversations");
        ws2ConvRelease.resolve();
        await new Promise((r) => setTimeout(r, 250));

        const text = await tabB.evaluate(() => document.body.innerText ?? "");
        assert.equal(
          text.includes("secret-revoked-ws-room"),
          false,
          `Held private channel painted after workspace refusal:\n${await ctx.dumpDiagnostics(pages)}`,
        );
        assert.equal(
          await tabB.locator('[data-testid="workspace-unavailable"]').isVisible(),
          true,
          "Workspace unavailable state must stay rendered",
        );
        assert.equal(
          ws2RequestsAfterRefusal,
          0,
          `Stale WS_2 requests sent after refusal:\n${await ctx.dumpDiagnostics(pages)}`,
        );
        } finally {
          ws2DecisionRelease.resolve();
          ws2ConvRelease.resolve();
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // (d) Served /next carries frame-ancestors 'none' header & framing gets nothing
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const nextRes = await fetch(`${origin}/next`);
      assert.equal(nextRes.status, 200, "served /next must return HTTP 200");
      assert.match(
        nextRes.headers.get("content-security-policy") ?? "",
        /frame-ancestors 'none'/,
        "served /next response must carry Content-Security-Policy: frame-ancestors 'none'",
      );
      assert.equal(nextRes.headers.get("x-content-type-options"), "nosniff");
      assert.equal(nextRes.headers.get("referrer-policy"), "no-referrer");
      assert.equal(nextRes.headers.get("cache-control"), "no-cache");
      const nextHtml = await nextRes.text();
      assert.match(nextHtml, /<meta\s+charset="UTF-8"\s*\/?>\s*<meta\s+http-equiv="Content-Security-Policy"[^>]*frame-src 'none'/i);

      const sidFrame = "sid-d-frame";
      const scenario: ScenarioConfig = {
        name: "d-framing-refusal",
        validRefreshToken: "rt-d-1",
        nextRefreshToken: "rt-d-2",
        activeSessionIds: new Set([sidFrame]),
      };
      await withTwoTabScenario(scenario, async (ctx) => {
        ctx.setStep("d-seed-authenticated-session-and-open-frame-host");
        await ctx.seedStorage(makeSessionPayload({ sessionId: sidFrame, refreshToken: "rt-d-1" }));
        const hostPage = await ctx.context.newPage();
        ctx.attachPageDiagnostics("frameHost", hostPage);
        const pages = { hostPage };

        await hostPage.goto(`${origin}/frame-host`, { waitUntil: "load" });
        await new Promise((r) => setTimeout(r, 400));

        const frameCheck = await hostPage.evaluate(() => {
          const iframe = document.querySelector<HTMLIFrameElement>("#framed-next");
          if (!iframe) return { hasIframe: false, inaccessible: false, bodyText: "", hasAppDom: false };
          try {
            const doc = iframe.contentDocument;
            const text = doc?.body?.innerText ?? "";
            const hasAppDom = Boolean(
              doc?.querySelector('[data-testid="private-view-root"], [data-testid="signed-out-screen"], [data-testid="session-checking-screen"], #root > *'),
            );
            return { hasIframe: true, inaccessible: doc === null, bodyText: text, hasAppDom };
          } catch {
            // Chromium replaces blocked frame-ancestors iframes with an opaque error document (cross-origin SecurityError).
            return { hasIframe: true, inaccessible: true, bodyText: "", hasAppDom: false };
          }
        });

        assert.equal(frameCheck.hasIframe, true, "frame host must contain the test iframe");
        assert.equal(frameCheck.hasAppDom, false, `framed /next must render zero app DOM:\n${await ctx.dumpDiagnostics(pages)}`);
        assert.equal(frameCheck.bodyText.includes("Alpha Vault"), false, "framed /next must expose no workspace data");
        assert.equal(
          ctx.counters.userChecks,
          0,
          `framed /next must trigger zero authenticated API requests:\n${await ctx.dumpDiagnostics(pages)}`,
        );
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // (e) Back / history-cache (bfcache) restore in /next:
    //     - Uses Chromium through chrome.ts with --disable-back-forward-cache stripped
    //       and allowlisted --enable-bfcache enabled (enables headless_shell delegate)
    //     - Navigates away cross-site to a second loopback server (`http://localhost:<port>/away`)
    //       so Chromium swaps BrowsingInstances instead of reporting BrowsingInstanceNotSwapped
    //     - First runs a PLAIN-PAGE control (`/bfcache-control`, served with production
    //       `Cache-Control: no-cache`) to prove the harness can perform a persisted restore;
    //       fails with a distinct "harness cannot perform a persisted restore" message if not
    //     - Then proves `/next` observes a REAL persisted pageshow (`event.persisted === true`),
    //       paints zero old private content on pagehide, pageshow capture, pageshow bubble, and
    //       while revalidation is held, then paints the fresh read
    //     - On any failure, dumps CDP `Page.getNavigationHistory` and `Page.backForwardCacheNotUsed`
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const awayHandler = (req: IncomingMessage, res: ServerResponse) => {
        const reqUrl = new URL(req.url ?? "/", "http://localhost");
        if (reqUrl.pathname === "/away") {
          // Separate site (`localhost` vs `127.0.0.1`) and non-`no-store` caching so Chromium
          // swaps BrowsingInstances and keeps the prior document eligible for bfcache.
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=0, must-revalidate",
          });
          res.end('<!doctype html><html><head><meta charset="utf-8"><title>Away</title></head><body><h1>Away</h1></body></html>');
          return;
        }
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
      };
      const awayServer = createServer(awayHandler);
      await new Promise<void>((r) => awayServer.listen(0, "127.0.0.1", r));
      const awayPort = (awayServer.address() as AddressInfo).port;
      // Best-effort IPv6 loopback listener on the same ephemeral port so `http://localhost:<awayPort>`
      // connects immediately whether the runner resolves `localhost` to ::1 or 127.0.0.1 first.
      let awayServerV6: ReturnType<typeof createServer> | null = null;
      try {
        const v6 = createServer(awayHandler);
        await new Promise<void>((resolveV6, rejectV6) => {
          v6.once("error", rejectV6);
          v6.listen({ host: "::1", port: awayPort, ipv6Only: true }, () => {
            v6.off("error", rejectV6);
            resolveV6();
          });
        });
        awayServerV6 = v6;
      } catch {
        // IPv6 loopback unavailable or port occupied on ::1; IPv4 127.0.0.1 still serves localhost.
      }
      const awayOrigin = `http://localhost:${awayPort}`;

      const bfcacheBrowser = await launchPlaywrightChromium(chromium, {
        enableBfcache: true,
        extraArgs: ["--enable-bfcache"],
      });
      try {
        // ── (e0) Plain-page control: prove this harness can do a persisted bfcache restore ──
        {
          const controlContext = await bfcacheBrowser.newContext({ viewport: { width: 1280, height: 900 } });
          await controlContext.routeWebSocket("wss://api.commonswarm.com/**", (ws) => {
            ws.close();
          });
          await controlContext.route("https://api.commonswarm.com/**", async (route) => {
            await route.fulfill({ status: 404, body: "" }).catch(() => undefined);
          });
          const controlPage = await controlContext.newPage();
          const controlCdp = await controlContext.newCDPSession(controlPage);
          const controlBfcacheNotUsed: Array<Record<string, unknown>> = [];
          await controlCdp.send("Page.enable");
          controlCdp.on("Page.backForwardCacheNotUsed", (ev) => {
            controlBfcacheNotUsed.push(ev as unknown as Record<string, unknown>);
          });
          try {
            await controlPage.goto(`${origin}/bfcache-control`, { waitUntil: "load" });
            await controlPage.evaluate(() => {
              const log: Array<{ type: string; persisted: boolean }> = [];
              (window as unknown as { __bfcacheControlLog?: Array<{ type: string; persisted: boolean }> }).__bfcacheControlLog = log;
              window.addEventListener("pagehide", (ev) => {
                log.push({ type: "pagehide", persisted: (ev as PageTransitionEvent).persisted });
              });
              window.addEventListener("pageshow", (ev) => {
                log.push({ type: "pageshow", persisted: (ev as PageTransitionEvent).persisted });
              });
            });

            await controlPage.goto(`${awayOrigin}/away`, { waitUntil: "load" });
            const controlAwayDeadline = Date.now() + 10_000;
            while (Date.now() < controlAwayDeadline) {
              const onAway = await controlPage
                .evaluate((expected: string) => location.href.startsWith(expected), `${awayOrigin}/away`)
                .catch(() => false);
              if (onAway) break;
              await new Promise((r) => setTimeout(r, 30));
            }

            const controlNavHistoryBeforeBack = await controlCdp.send("Page.getNavigationHistory");
            const controlPrevEntry = controlNavHistoryBeforeBack.entries[controlNavHistoryBeforeBack.currentIndex - 1];
            assert.ok(
              controlPrevEntry && controlPrevEntry.url.startsWith(`${origin}/bfcache-control`),
              `harness cannot perform a persisted restore: unexpected navigation history before Back:\n${JSON.stringify(
                { controlNavHistoryBeforeBack, controlBfcacheNotUsed },
                null,
                2,
              )}`,
            );
            await controlCdp.send("Page.navigateToHistoryEntry", { entryId: controlPrevEntry.id });

            const controlBackDeadline = Date.now() + 15_000;
            while (Date.now() < controlBackDeadline) {
              const returned = await controlPage
                .evaluate(() => {
                  if (location.pathname !== "/bfcache-control") return false;
                  const log = (window as unknown as { __bfcacheControlLog?: Array<{ type: string; persisted: boolean }> }).__bfcacheControlLog;
                  if (Array.isArray(log)) {
                    return log.some((entry) => entry.type === "pageshow");
                  }
                  return document.readyState === "complete";
                })
                .catch(() => false);
              if (returned) break;
              await new Promise((r) => setTimeout(r, 30));
            }

            const controlObservation = await controlPage.evaluate(() => {
              const log = (window as unknown as { __bfcacheControlLog?: Array<{ type: string; persisted: boolean }> }).__bfcacheControlLog ?? null;
              const nav = performance.getEntriesByType("navigation")[0] as
                | (PerformanceNavigationTiming & { notRestoredReasons?: unknown })
                | undefined;
              return {
                href: location.href,
                log,
                navType: nav?.type ?? null,
                notRestoredReasons: nav?.notRestoredReasons ?? null,
              };
            });
            const controlPageshow = controlObservation.log?.find((entry) => entry.type === "pageshow");
            if (!Array.isArray(controlObservation.log) || controlPageshow?.persisted !== true) {
              await new Promise((r) => setTimeout(r, 50));
              const controlNavHistoryAfterBack = await controlCdp
                .send("Page.getNavigationHistory")
                .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
              assert.fail(
                `harness cannot perform a persisted restore (plain-page control did not observe pageshow.persisted === true):\n${JSON.stringify(
                  {
                    origin,
                    awayOrigin,
                    controlObservation,
                    navHistoryBeforeBack: controlNavHistoryBeforeBack,
                    navHistoryAfterBack: controlNavHistoryAfterBack,
                    bfcacheNotUsed: controlBfcacheNotUsed,
                  },
                  null,
                  2,
                )}`,
              );
            }
          } finally {
            await controlCdp.detach().catch(() => undefined);
            await controlContext.close();
          }
        }

        // ── (e1) Real /next bfcache restore and revalidation witness ──
        const sidBf = "sid-e-bfcache";
        let readPass = 1;
        let holdRevalidateUser = false;
        const revalidateUserHit = createSignal<void>();
        const releaseRevalidateUser = createSignal<void>();

        const scenario: ScenarioConfig = {
          name: "e-bfcache-back-revalidation",
          validRefreshToken: "rt-e-1",
          nextRefreshToken: "rt-e-2",
          activeSessionIds: new Set([sidBf]),
          async onUserCheck(sid) {
            if (!scenario.activeSessionIds.has(sid)) {
              return {
                status: 403,
                body: { code: "session_not_found", error_code: "session_not_found", msg: "Session not found" },
              };
            }
            if (holdRevalidateUser) {
              holdRevalidateUser = false;
              revalidateUserHit.resolve();
              await releaseRevalidateUser.promise;
            }
            return { status: 200, body: USER_A };
          },
          async onEdgeRead(reqBody) {
            if (reqBody.resource === "conversations") {
              const privateSlug = readPass === 1 ? "secret-bfcache-before" : "fresh-bfcache-after";
              const privateId = readPass === 1 ? CONV_SECRET_1 : CONV_SECRET_2;
              return {
                status: 200,
                body: {
                  conversations: [
                    makeConversation({ id: CONV_GEN_1, slug: "general", kind: "general" }),
                    makeConversation({ id: privateId, slug: privateSlug, kind: "private_channel", joined: true }),
                  ],
                },
              };
            }
            if (reqBody.resource === "conversation_history") {
              return { status: 200, body: { signals: [], has_more: false, mentions: [], reactions: [] } };
            }
            if (reqBody.resource === "seat_admin_status") return { status: 200, body: { enabled: false } };
            if (reqBody.resource === "pending_access") return { status: 200, body: { pending: [], agents: [] } };
            if (reqBody.resource === "review_checks") return { status: 200, body: { checks: [] } };
            return { status: 200, body: { grants: [], invitations: [] } };
          },
        };

        await withTwoTabScenario(
          scenario,
          async (ctx) => {
            ctx.setStep("e-seed-and-boot-single-tab-next");
            await ctx.seedStorage(makeSessionPayload({ sessionId: sidBf, refreshToken: "rt-e-1" }));
            // Single open tab in this context so RelatedActiveContentsExist never blocks bfcache.
            const tabB = await ctx.context.newPage();
            ctx.attachPageDiagnostics("tabB", tabB);
            const pages = { tabB };

            const cdp = await ctx.context.newCDPSession(tabB);
            const bfcacheNotUsed: Array<Record<string, unknown>> = [];
            await cdp.send("Page.enable");
            cdp.on("Page.backForwardCacheNotUsed", (ev) => {
              bfcacheNotUsed.push(ev as unknown as Record<string, unknown>);
            });

            try {
              await tabB.goto(`${origin}/next`);
              await ctx.waitForNextSignedIn(tabB, "secret-bfcache-before", pages);

              // Wait until every initial fetch and Web Lock has settled so Chromium will not
              // reject bfcache for OutstandingNetworkRequestFetch or WebLocks.
              ctx.setStep("e-wait-for-bfcache-eligibility");
              await ctx.waitFor(
                "initial /next requests and Web Locks settled before leaving",
                async () => {
                  if (ctx.getInFlightApiRequests() > 0) return false;
                  const lockBusy = await tabB
                    .evaluate(async () => {
                      const q = await navigator.locks.query();
                      return (q.held?.length ?? 0) > 0 || (q.pending?.length ?? 0) > 0;
                    })
                    .catch(() => true);
                  return !lockBusy;
                },
                pages,
              );
              await new Promise((r) => setTimeout(r, 150));

              // Record pagehide and pageshow (capture BEFORE app's pageshow handler, and bubble AFTER).
              // Deliberately registers NO unload or beforeunload listener.
              // Keep page-evaluated callbacks free of named inner functions/bindings so tsx's esbuild
              // __name(...) helper is never serialized into the browser page.
              ctx.setStep("e-install-bfcache-transition-observer");
              await tabB.evaluate(() => {
                type TransitionSnapshot = {
                  type: string;
                  persisted: boolean;
                  hasVisiblePrivateRoot: boolean;
                  hasCheckingScreen: boolean;
                  bodyText: string;
                };
                const log: TransitionSnapshot[] = [];
                (window as unknown as { __bfcacheLog?: TransitionSnapshot[] }).__bfcacheLog = log;
                for (const [eventName, label, capture] of [
                  ["pagehide", "pagehide", false],
                  ["pageshow", "pageshow:capture", true],
                  ["pageshow", "pageshow:bubble", false],
                ] as const) {
                  window.addEventListener(
                    eventName,
                    (ev) => {
                      const root = document.querySelector<HTMLElement>('[data-testid="private-view-root"]');
                      const checking = document.querySelector('[data-testid="session-checking-screen"]');
                      log.push({
                        type: label,
                        persisted: (ev as PageTransitionEvent).persisted,
                        hasVisiblePrivateRoot: Boolean(root && !root.hidden),
                        hasCheckingScreen: Boolean(checking),
                        bodyText: (document.body?.innerText ?? "").slice(0, 600),
                      });
                    },
                    capture,
                  );
                }
              });

              // Navigate away cross-site (`http://localhost:<awayPort>/away` vs `http://127.0.0.1:<port>/next`)
              // so Chromium swaps BrowsingInstances (top-level user-style navigation via page.goto).
              ctx.setStep("e-navigate-away-cross-site");
              await tabB.goto(`${awayOrigin}/away`, { waitUntil: "load" });
              await ctx.waitFor(
                "Tab B landed on cross-site /away",
                () =>
                  tabB
                    .evaluate((expected: string) => location.href.startsWith(expected), `${awayOrigin}/away`)
                    .catch(() => false),
                pages,
              );

              // Arm revalidation hold and switch fresh sidebar data BEFORE going Back.
              readPass = 2;
              holdRevalidateUser = true;

              ctx.setStep("e-history-back-from-away");
              const navHistoryBeforeBack = await cdp.send("Page.getNavigationHistory");
              const prevEntry = navHistoryBeforeBack.entries[navHistoryBeforeBack.currentIndex - 1];
              assert.ok(
                prevEntry && prevEntry.url.startsWith(`${origin}/next`),
                `Expected /next history entry before Back:\n${JSON.stringify(
                  { navHistoryBeforeBack, bfcacheNotUsed },
                  null,
                  2,
                )}`,
              );
              await cdp.send("Page.navigateToHistoryEntry", { entryId: prevEntry.id });

              await ctx.waitFor(
                "Tab B returned to /next via Back",
                () =>
                  tabB
                    .evaluate(() => {
                      if (!location.pathname.startsWith("/next")) return false;
                      const log = (window as unknown as { __bfcacheLog?: Array<{ type: string }> }).__bfcacheLog;
                      if (Array.isArray(log)) {
                        return log.some((entry) => entry.type === "pageshow:bubble");
                      }
                      // If Chromium did a full reload instead of bfcache restore, stop waiting so we fail explicitly.
                      return document.readyState === "complete";
                    })
                    .catch(() => false),
                pages,
              );

              const backObservation = await tabB.evaluate(() => {
                type TransitionSnapshot = {
                  type: string;
                  persisted: boolean;
                  hasVisiblePrivateRoot: boolean;
                  hasCheckingScreen: boolean;
                  bodyText: string;
                };
                const log = (window as unknown as { __bfcacheLog?: TransitionSnapshot[] }).__bfcacheLog ?? null;
                const nav = performance.getEntriesByType("navigation")[0] as
                  | (PerformanceNavigationTiming & { notRestoredReasons?: unknown })
                  | undefined;
                const root = document.querySelector<HTMLElement>('[data-testid="private-view-root"]');
                const checking = document.querySelector('[data-testid="session-checking-screen"]');
                return {
                  log,
                  navType: nav?.type ?? null,
                  notRestoredReasons: nav?.notRestoredReasons ?? null,
                  liveHasVisiblePrivateRoot: Boolean(root && !root.hidden),
                  liveHasCheckingScreen: Boolean(checking),
                  liveBodyText: (document.body?.innerText ?? "").slice(0, 600),
                };
              });

              const bfcacheDiag = async () => {
                await new Promise((r) => setTimeout(r, 50));
                const navHistoryAfterBack = await cdp
                  .send("Page.getNavigationHistory")
                  .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
                return JSON.stringify(
                  {
                    origin,
                    awayOrigin,
                    backObservation,
                    navHistoryBeforeBack,
                    navHistoryAfterBack,
                    bfcacheNotUsed,
                    diagnostics: JSON.parse(await ctx.dumpDiagnostics(pages)),
                  },
                  null,
                  2,
                );
              };

              assert.ok(
                Array.isArray(backObservation.log),
                `Browser performed a full reload instead of restoring /next from bfcache (pageshow.persisted was never observed):\n${await bfcacheDiag()}`,
              );
              const pagehideSnap = backObservation.log.find((e) => e.type === "pagehide");
              const pageshowCapture = backObservation.log.find((e) => e.type === "pageshow:capture");
              const pageshowBubble = backObservation.log.find((e) => e.type === "pageshow:bubble");

              assert.equal(
                pageshowCapture?.persisted,
                true,
                `Expected real bfcache restore with pageshow event.persisted === true:\n${await bfcacheDiag()}`,
              );
              assert.equal(
                pageshowBubble?.persisted,
                true,
                `Expected pageshow bubble event.persisted === true:\n${await bfcacheDiag()}`,
              );

              // Zero old private content on pagehide, on pageshow:capture (BEFORE app pageshow JS runs), and on pageshow:bubble.
              for (const [label, snap] of [
                ["pagehide", pagehideSnap],
                ["pageshow:capture", pageshowCapture],
                ["pageshow:bubble", pageshowBubble],
              ] as const) {
                assert.ok(snap, `Missing ${label} transition snapshot:\n${await bfcacheDiag()}`);
                assert.equal(
                  snap.hasVisiblePrivateRoot,
                  false,
                  `Old private-view-root was visible at ${label}:\n${await bfcacheDiag()}`,
                );
                assert.equal(
                  snap.bodyText.includes("secret-bfcache-before"),
                  false,
                  `Old private channel painted at ${label}:\n${await bfcacheDiag()}`,
                );
                assert.equal(
                  snap.bodyText.includes("Alpha Vault"),
                  false,
                  `Old private workspace painted at ${label}:\n${await bfcacheDiag()}`,
                );
              }

              // Confirm persisted pageshow triggered real revalidation and that ZERO old private content
              // is painted while revalidation is held (release quickly, well below authFetch's 4000ms timeout).
              ctx.setStep("e-wait-for-held-revalidation-and-assert-zero-old-paint");
              await ctx.waitForSignal("bfcache pageshow revalidation GET /auth/v1/user", revalidateUserHit, pages);
              const duringRevalidation = await tabB.evaluate(() => ({
                privateRootCount: document.querySelectorAll('[data-testid="private-view-root"]').length,
                checkingCount: document.querySelectorAll('[data-testid="session-checking-screen"]').length,
                bodyText: (document.body?.innerText ?? "").slice(0, 600),
              }));
              releaseRevalidateUser.resolve();

              assert.equal(
                duringRevalidation.privateRootCount,
                0,
                `private-view-root must stay unmounted before bfcache revalidation settles:\n${await bfcacheDiag()}`,
              );
              assert.equal(
                duringRevalidation.checkingCount,
                1,
                `session-checking-screen must render while bfcache revalidation is pending:\n${await bfcacheDiag()}`,
              );
              assert.equal(
                duringRevalidation.bodyText.includes("secret-bfcache-before"),
                false,
                `Old private channel leaked while bfcache revalidation was pending:\n${await bfcacheDiag()}`,
              );
              assert.equal(
                duringRevalidation.bodyText.includes("Alpha Vault"),
                false,
                `Old workspace label leaked while bfcache revalidation was pending:\n${await bfcacheDiag()}`,
              );

              // Now the fresh read must paint fresh-bfcache-after without reviving secret-bfcache-before.
              ctx.setStep("e-wait-for-fresh-read-paint");
              await ctx.waitForNextSignedIn(tabB, "fresh-bfcache-after", pages);
              const freshText = await tabB.evaluate(() => document.body.innerText ?? "");
              assert.equal(freshText.includes("fresh-bfcache-after"), true, "Fresh read must paint after bfcache revalidation");
              assert.equal(
                freshText.includes("secret-bfcache-before"),
                false,
                `Old pre-bfcache private channel survived after fresh read:\n${await bfcacheDiag()}`,
              );
            } finally {
              releaseRevalidateUser.resolve();
              await cdp.detach().catch(() => undefined);
            }
          },
          bfcacheBrowser,
        );
      } finally {
        await bfcacheBrowser.close();
        awayServer.closeAllConnections();
        await new Promise<void>((r) => awayServer.close(() => r()));
        if (awayServerV6) {
          awayServerV6.closeAllConnections();
          await new Promise<void>((r) => awayServerV6.close(() => r()));
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LIMIT OF THIS SCENARIO: the browser test tool routes WebSockets through an in-page stand-in, not a
    // native socket. So an "outcome=restored" here does NOT show that a real browser keeps a page with a
    // native realtime socket in its back-forward cache (an open native WebSocket is a known blocker).
    // What this scenario proves is what the app does around the transition, in either outcome. Whether a
    // real browser restores or reloads has to be read from the served preview (the navigation entry's
    // notRestoredReasons), not from this test.
    // (f) Back from cross-site navigation while /next holds an OPEN realtime socket:
    //     - Same browser launch options and cross-site /away server as (e)
    //     - Routes wss://api.commonswarm.com/** to a minimal Phoenix-compatible responder
    //       that accepts and holds the socket open, replies ok to phx_join and heartbeat,
    //       and records every frame sent by the page (topic, event, bearer)
    //     - Asserts the socket is open and both joins were sent BEFORE navigating away
    //     - Accepts EITHER browser outcome (bfcache restored OR full reload), prints which
    //       occurred (`[next-back-open-socket] outcome=restored` or `outcome=reloaded reasons=...`),
    //       and asserts the full security invariants for that outcome
    //     - Runs both (f1) same-login and (f2) login-change-while-away variants
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const awayHandlerF = (req: IncomingMessage, res: ServerResponse) => {
        const reqUrl = new URL(req.url ?? "/", "http://localhost");
        if (reqUrl.pathname === "/away") {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=0, must-revalidate",
          });
          res.end('<!doctype html><html><head><meta charset="utf-8"><title>Away</title></head><body><h1>Away</h1></body></html>');
          return;
        }
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
      };
      const awayServerF = createServer(awayHandlerF);
      await new Promise<void>((r) => awayServerF.listen(0, "127.0.0.1", r));
      const awayPortF = (awayServerF.address() as AddressInfo).port;
      let awayServerFV6: ReturnType<typeof createServer> | null = null;
      try {
        const v6 = createServer(awayHandlerF);
        await new Promise<void>((resolveV6, rejectV6) => {
          v6.once("error", rejectV6);
          v6.listen({ host: "::1", port: awayPortF, ipv6Only: true }, () => {
            v6.off("error", rejectV6);
            resolveV6();
          });
        });
        awayServerFV6 = v6;
      } catch {
        // IPv6 loopback unavailable or port occupied on ::1; IPv4 127.0.0.1 still serves localhost.
      }
      const awayOriginF = `http://localhost:${awayPortF}`;

      const openSocketBrowser = await launchPlaywrightChromium(chromium, {
        enableBfcache: true,
        extraArgs: ["--enable-bfcache"],
      });

      try {
        const variants = [
          {
            name: "same-login" as const,
            beforeUser: USER_A,
            afterUser: USER_A,
            beforeSid: "sid-f1-open-socket",
            afterSid: "sid-f1-open-socket",
            beforeRefreshToken: "rt-f1-1",
            afterRefreshToken: "rt-f1-2",
            beforeWs: { id: WS_1, name: "Alpha Vault" },
            afterWs: { id: WS_1, name: "Alpha Vault" },
            beforePrivateSlug: "secret-f1-before",
            afterPrivateSlug: "fresh-f1-after",
            changeLoginWhileAway: false,
          },
          {
            name: "login-change" as const,
            beforeUser: USER_A,
            afterUser: USER_B,
            beforeSid: "sid-f2-login-1",
            afterSid: "sid-f2-login-2",
            beforeRefreshToken: "rt-f2-1",
            afterRefreshToken: "rt-f2-2",
            beforeWs: { id: WS_1, name: "Alpha Vault" },
            afterWs: { id: WS_2, name: "Bravo Vault" },
            beforePrivateSlug: "secret-f2-login1-room",
            afterPrivateSlug: "fresh-f2-login2-room",
            changeLoginWhileAway: true,
          },
        ];

        for (const variant of variants) {
          let wsPhase = "before-leave";
          const recorder = createPhoenixSocketRecorder(() => wsPhase);
          const beforeSession = makeSessionPayload({
            sessionId: variant.beforeSid,
            refreshToken: variant.beforeRefreshToken,
            user: variant.beforeUser,
          });
          const afterSession = variant.changeLoginWhileAway
            ? makeSessionPayload({
                sessionId: variant.afterSid,
                refreshToken: variant.afterRefreshToken,
                user: variant.afterUser,
              })
            : beforeSession;

          const beforeTopics = new Set([
            `realtime:cswarm-signals:${variant.beforeWs.id}`,
            `realtime:cswarm-member:${variant.beforeWs.id}:${variant.beforeUser.id}`,
          ]);
          const afterTopics = new Set([
            `realtime:cswarm-signals:${variant.afterWs.id}`,
            `realtime:cswarm-member:${variant.afterWs.id}:${variant.afterUser.id}`,
          ]);

          let readPass = 1;
          let holdRevalidateUser = false;
          let revalidateUserSid: string | null = null;
          const revalidateUserHit = createSignal<void>();
          const releaseRevalidateUser = createSignal<void>();

          const scenario: ScenarioConfig = {
            name: `f-open-socket-back-${variant.name}`,
            validRefreshToken: variant.beforeRefreshToken,
            nextRefreshToken: variant.afterRefreshToken,
            activeSessionIds: new Set([variant.beforeSid]),
            workspacesForSid: (sid) =>
              variant.changeLoginWhileAway && sid === variant.afterSid
                ? [variant.afterWs]
                : [variant.beforeWs],
            userForSid: (sid) =>
              variant.changeLoginWhileAway && sid === variant.afterSid
                ? variant.afterUser
                : variant.beforeUser,
            onWebSocket: recorder.handleWebSocket,
            async onUserCheck(sid) {
              if (!scenario.activeSessionIds.has(sid)) {
                return {
                  status: 403,
                  body: { code: "session_not_found", error_code: "session_not_found", msg: "Session not found" },
                };
              }
              if (holdRevalidateUser) {
                holdRevalidateUser = false;
                revalidateUserSid = sid;
                revalidateUserHit.resolve();
                await releaseRevalidateUser.promise;
              }
              const user = variant.changeLoginWhileAway && sid === variant.afterSid
                ? variant.afterUser
                : variant.beforeUser;
              return { status: 200, body: user };
            },
            async onEdgeRead(reqBody, sid) {
              if (reqBody.resource === "conversations") {
                const isAfter = readPass === 2 || (variant.changeLoginWhileAway && sid === variant.afterSid);
                const ws = isAfter ? variant.afterWs : variant.beforeWs;
                const user = isAfter ? variant.afterUser : variant.beforeUser;
                const privateSlug = isAfter ? variant.afterPrivateSlug : variant.beforePrivateSlug;
                const privateId = isAfter ? CONV_SECRET_2 : CONV_SECRET_1;
                const generalId = ws.id === WS_2 ? CONV_GEN_2 : CONV_GEN_1;
                return {
                  status: 200,
                  body: {
                    conversations: [
                      makeConversation({ id: generalId, slug: "general", kind: "general", userId: user.id }),
                      makeConversation({
                        id: privateId,
                        slug: privateSlug,
                        kind: "private_channel",
                        joined: true,
                        userId: user.id,
                      }),
                    ],
                  },
                };
              }
              if (reqBody.resource === "conversation_history") {
                return { status: 200, body: { signals: [], has_more: false, mentions: [], reactions: [] } };
              }
              if (reqBody.resource === "seat_admin_status") return { status: 200, body: { enabled: false } };
              if (reqBody.resource === "pending_access") return { status: 200, body: { pending: [], agents: [] } };
              if (reqBody.resource === "review_checks") return { status: 200, body: { checks: [] } };
              return { status: 200, body: { grants: [], invitations: [] } };
            },
          };

          await withTwoTabScenario(
            scenario,
            async (ctx) => {
              ctx.setStep(`f-${variant.name}-seed-and-boot-next`);
              await ctx.seedStorage(beforeSession);
              // Single open tab in this context so RelatedActiveContentsExist never blocks bfcache.
              const tabB = await ctx.context.newPage();
              await tabB.addInitScript(WS_CLOSE_OBSERVER_INIT_SCRIPT);
              ctx.attachPageDiagnostics("tabB", tabB);
              const pages = { tabB };

              const cdp = await ctx.context.newCDPSession(tabB);
              const bfcacheNotUsed: Array<Record<string, unknown>> = [];
              await cdp.send("Page.enable");
              cdp.on("Page.backForwardCacheNotUsed", (ev) => {
                bfcacheNotUsed.push(ev as unknown as Record<string, unknown>);
              });

              const openSocketDiag = async (extra: Record<string, unknown> = {}) => {
                const navHistory = await cdp
                  .send("Page.getNavigationHistory")
                  .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
                return JSON.stringify(
                  {
                    variant: variant.name,
                    wsPhase,
                    origin,
                    awayOrigin: awayOriginF,
                    sockets: recorder.summary(),
                    bfcacheNotUsed,
                    navHistory,
                    ...extra,
                    diagnostics: JSON.parse(await ctx.dumpDiagnostics(pages)),
                  },
                  null,
                  2,
                );
              };

              try {
                await tabB.goto(`${origin}/next`);
                await ctx.waitForNextSignedIn(tabB, variant.beforePrivateSlug, pages);

                // (1) Assert the realtime socket is accepted, held OPEN, and BOTH phx_join frames
                //     carrying the initial login's bearer were sent BEFORE navigating away.
                ctx.setStep(`f-${variant.name}-wait-for-open-socket-and-joins`);
                await ctx.waitFor(
                  "realtime socket open with both initial phx_join frames sent",
                  () => {
                    const sock = recorder.sockets[0];
                    if (!sock || sock.closed) return false;
                    const joinedTopics = new Set(
                      sock.frames
                        .filter((f) => f.event === "phx_join" && f.hasBearer)
                        .map((f) => f.topic),
                    );
                    return [...beforeTopics].every((topic) => joinedTopics.has(topic));
                  },
                  pages,
                );

                const preSocket = recorder.sockets[0]!;
                assert.equal(
                  preSocket.closed,
                  false,
                  `Pre-navigation realtime socket must remain OPEN before leaving:\n${await openSocketDiag()}`,
                );
                const preJoins = preSocket.frames.filter((f) => f.event === "phx_join");
                assert.ok(
                  preJoins.length >= 2,
                  `Expected at least 2 pre-navigation phx_join frames:\n${await openSocketDiag()}`,
                );
                for (const joinFrame of preJoins) {
                  assert.ok(
                    beforeTopics.has(joinFrame.topic),
                    `Unexpected pre-navigation join topic ${joinFrame.topic}:\n${await openSocketDiag()}`,
                  );
                  assert.equal(
                    joinFrame.hasBearer,
                    true,
                    `Pre-navigation phx_join must carry bearer:\n${await openSocketDiag()}`,
                  );
                  assert.equal(
                    joinFrame.bearer,
                    beforeSession.access_token,
                    `Pre-navigation phx_join must carry initial login bearer:\n${await openSocketDiag()}`,
                  );
                  assert.equal(joinFrame.bearerSid, variant.beforeSid);
                  assert.equal(joinFrame.bearerSub, variant.beforeUser.id);
                }

                // Wait until initial HTTP fetches and Web Locks settle so only the open realtime
                // connection differentiates this scenario from (e).
                ctx.setStep(`f-${variant.name}-wait-for-http-and-locks-settled`);
                await ctx.waitFor(
                  "initial /next HTTP requests and Web Locks settled before leaving",
                  async () => {
                    if (ctx.getInFlightApiRequests() > 0) return false;
                    const lockBusy = await tabB
                      .evaluate(async () => {
                        const q = await navigator.locks.query();
                        return (q.held?.length ?? 0) > 0 || (q.pending?.length ?? 0) > 0;
                      })
                      .catch(() => true);
                    return !lockBusy;
                  },
                  pages,
                );
                await new Promise((r) => setTimeout(r, 150));

                // Re-confirm the socket is still OPEN right before leaving (cannot pass vacuously).
                assert.equal(
                  preSocket.closed,
                  false,
                  `Pre-navigation realtime socket closed prematurely before navigating away:\n${await openSocketDiag()}`,
                );

                // Install transition observer (no named inner functions inside evaluate).
                ctx.setStep(`f-${variant.name}-install-transition-observer`);
                await tabB.evaluate(() => {
                  type TransitionSnapshot = {
                    type: string;
                    ts: number;
                    persisted: boolean;
                    hasVisiblePrivateRoot: boolean;
                    hasCheckingScreen: boolean;
                    bodyText: string;
                  };
                  const log: TransitionSnapshot[] = [];
                  (window as unknown as { __bfcacheLog?: TransitionSnapshot[] }).__bfcacheLog = log;
                  for (const [eventName, label, capture] of [
                    ["pagehide", "pagehide", false],
                    ["pageshow", "pageshow:capture", true],
                    ["pageshow", "pageshow:bubble", false],
                  ] as const) {
                    window.addEventListener(
                      eventName,
                      (ev) => {
                        const root = document.querySelector<HTMLElement>('[data-testid="private-view-root"]');
                        const checking = document.querySelector('[data-testid="session-checking-screen"]');
                        log.push({
                          type: label,
                          ts: Date.now(),
                          persisted: (ev as PageTransitionEvent).persisted,
                          hasVisiblePrivateRoot: Boolean(root && !root.hidden),
                          hasCheckingScreen: Boolean(checking),
                          bodyText: (document.body?.innerText ?? "").slice(0, 600),
                        });
                      },
                      capture,
                    );
                  }
                });

                // (2) Navigate away cross-site exactly as (e) does.
                ctx.setStep(`f-${variant.name}-navigate-away-cross-site`);
                wsPhase = "during-leave";
                await tabB.goto(`${awayOriginF}/away`, { waitUntil: "load" });
                await ctx.waitFor(
                  "Tab B landed on cross-site /away",
                  () =>
                    tabB
                      .evaluate((expected: string) => location.href.startsWith(expected), `${awayOriginF}/away`)
                      .catch(() => false),
                  pages,
                );

                // Observe that the pre-navigation socket was closed during the leave phase.
                // A phx_leave frame is NOT required: retireAndCleanupSession clears sendBuffer,
                // closes the socket, and disposes the client (`app/src/data/live.ts`); whether
                // a phx_leave reaches the wire before close is incidental. If one appears, it
                // must carry no bearer.
                ctx.setStep(`f-${variant.name}-observe-pre-socket-closed`);
                await ctx.waitForSignal("pre-navigation realtime socket close", preSocket.closedSignal, pages);
                assert.equal(
                  preSocket.closed,
                  true,
                  `Pre-navigation socket must be closed after leaving /next:\n${await openSocketDiag()}`,
                );
                assert.ok(
                  preSocket.closedAt !== null,
                  `Pre-navigation socket close timestamp must be recorded:\n${await openSocketDiag()}`,
                );
                assert.equal(
                  preSocket.closedPhase,
                  "during-leave",
                  `Pre-navigation socket close must be observed in the leave phase (got "${preSocket.closedPhase}"):\n${await openSocketDiag()}`,
                );
                for (const leaveFrame of preSocket.frames.filter((f) => f.phase === "during-leave")) {
                  assert.equal(
                    leaveFrame.hasBearer,
                    false,
                    `No frame sent after pagehide may carry a bearer:\n${await openSocketDiag({ leaveFrame })}`,
                  );
                  assert.equal(
                    leaveFrame.raw.includes(beforeSession.access_token),
                    false,
                    `No frame sent after pagehide may contain the prior bearer token:\n${await openSocketDiag({ leaveFrame })}`,
                  );
                  assert.notEqual(
                    leaveFrame.event,
                    "phx_join",
                    `No phx_join frame may be sent on the old socket after pagehide:\n${await openSocketDiag({ leaveFrame })}`,
                  );
                  if (leaveFrame.event === "phx_leave") {
                    assert.ok(
                      beforeTopics.has(leaveFrame.topic),
                      `Optional phx_leave frame targeted unexpected topic "${leaveFrame.topic}":\n${await openSocketDiag({ leaveFrame })}`,
                    );
                  } else {
                    assert.equal(
                      leaveFrame.event,
                      "heartbeat",
                      `Unexpected frame event "${leaveFrame.event}" sent on old socket during leave:\n${await openSocketDiag({ leaveFrame })}`,
                    );
                  }
                }

                wsPhase = "away";
                const preSocketFrameCountBeforeBack = preSocket.frames.length;

                // (4) Variant with a login change while away: replace stored session with Login 2.
                if (variant.changeLoginWhileAway) {
                  ctx.setStep(`f-${variant.name}-replace-session-while-away`);
                  scenario.activeSessionIds.delete(variant.beforeSid);
                  scenario.activeSessionIds.add(variant.afterSid);
                  scenario.validRefreshToken = variant.afterRefreshToken;
                  await ctx.seedStorage(afterSession);
                }

                // Arm fresh read and revalidation hold BEFORE going Back.
                readPass = 2;
                holdRevalidateUser = true;
                wsPhase = "after-back";
                const apiCountBeforeBack = ctx.apiLog.length;

                ctx.setStep(`f-${variant.name}-history-back-from-away`);
                const navHistoryBeforeBack = await cdp.send("Page.getNavigationHistory");
                const prevEntry = navHistoryBeforeBack.entries[navHistoryBeforeBack.currentIndex - 1];
                assert.ok(
                  prevEntry && prevEntry.url.startsWith(`${origin}/next`),
                  `Expected /next history entry before Back:\n${await openSocketDiag({ navHistoryBeforeBack })}`,
                );
                await cdp.send("Page.navigateToHistoryEntry", { entryId: prevEntry.id });

                await ctx.waitFor(
                  "Tab B returned to /next via Back (restored or reloaded)",
                  () =>
                    tabB
                      .evaluate(() => {
                        if (!location.pathname.startsWith("/next")) return false;
                        const log = (window as unknown as { __bfcacheLog?: Array<{ type: string }> }).__bfcacheLog;
                        if (Array.isArray(log)) {
                          return log.some((entry) => entry.type === "pageshow:bubble");
                        }
                        return document.readyState === "complete";
                      })
                      .catch(() => false),
                  pages,
                );

                const backObservation = await tabB.evaluate(() => {
                  type TransitionSnapshot = {
                    type: string;
                    ts: number;
                    persisted: boolean;
                    hasVisiblePrivateRoot: boolean;
                    hasCheckingScreen: boolean;
                    bodyText: string;
                  };
                  type WsCloseEntry = {
                    url: string;
                    readyStateBefore: number;
                    phase: string;
                    ts: number;
                  };
                  const w = window as unknown as {
                    __bfcacheLog?: TransitionSnapshot[];
                    __wsCloseLog?: WsCloseEntry[];
                    __wsPagehideTs?: number | null;
                  };
                  const nav = performance.getEntriesByType("navigation")[0] as
                    | (PerformanceNavigationTiming & { notRestoredReasons?: unknown })
                    | undefined;
                  const root = document.querySelector<HTMLElement>('[data-testid="private-view-root"]');
                  const checking = document.querySelector('[data-testid="session-checking-screen"]');
                  return {
                    log: w.__bfcacheLog ?? null,
                    wsCloseLog: Array.isArray(w.__wsCloseLog) ? w.__wsCloseLog : [],
                    wsPagehideTs: typeof w.__wsPagehideTs === "number" ? w.__wsPagehideTs : null,
                    navType: nav?.type ?? null,
                    notRestoredReasons: nav?.notRestoredReasons ?? null,
                    liveHasVisiblePrivateRoot: Boolean(root && !root.hidden),
                    liveHasCheckingScreen: Boolean(checking),
                    liveBodyText: (document.body?.innerText ?? "").slice(0, 600),
                  };
                });

                // (3) Branch on actual browser outcome: BOTH Restored and Reloaded are valid passes,
                //     each with its own required assertions and explicit CI log line.
                const restoredLog = Array.isArray(backObservation.log) ? backObservation.log : null;

                if (restoredLog) {
                  const pagehideSnap = restoredLog.find((e) => e.type === "pagehide");
                  const pageshowCapture = restoredLog.find((e) => e.type === "pageshow:capture");
                  const pageshowBubble = restoredLog.find((e) => e.type === "pageshow:bubble");

                  assert.equal(
                    pageshowCapture?.persisted,
                    true,
                    `Expected restored pageshow:capture event.persisted === true:\n${await openSocketDiag({ backObservation })}`,
                  );
                  assert.equal(
                    pageshowBubble?.persisted,
                    true,
                    `Expected restored pageshow:bubble event.persisted === true:\n${await openSocketDiag({ backObservation })}`,
                  );

                  // Zero old private content at pagehide, pageshow:capture, and pageshow:bubble.
                  for (const [label, snap] of [
                    ["pagehide", pagehideSnap],
                    ["pageshow:capture", pageshowCapture],
                    ["pageshow:bubble", pageshowBubble],
                  ] as const) {
                    assert.ok(snap, `Missing ${label} transition snapshot:\n${await openSocketDiag({ backObservation })}`);
                    assert.equal(
                      snap.hasVisiblePrivateRoot,
                      false,
                      `Old private-view-root was visible at ${label}:\n${await openSocketDiag({ backObservation })}`,
                    );
                    assert.equal(
                      snap.bodyText.includes(variant.beforePrivateSlug),
                      false,
                      `Old private channel painted at ${label}:\n${await openSocketDiag({ backObservation })}`,
                    );
                    assert.equal(
                      snap.bodyText.includes(variant.beforeWs.name),
                      false,
                      `Old workspace label painted at ${label}:\n${await openSocketDiag({ backObservation })}`,
                    );
                  }

                  // Assert the app itself closed the pre-navigation socket during leave (in-page witness),
                  // without pinning a specific pre-close readyState (retireAndCleanupSession closes in
                  // both connected and non-connected branches, and visibilitychange->hidden may precede pagehide).
                  const appPagehideClose = backObservation.wsCloseLog.find(
                    (entry) =>
                      entry.url.startsWith("wss://api.commonswarm.com/realtime/v1") &&
                      (entry.phase === "pagehide" || entry.phase === "hidden"),
                  );
                  assert.ok(
                    appPagehideClose,
                    `Expected app to call WebSocket.close() on the realtime socket during pagehide/leave:\n${await openSocketDiag({ backObservation })}`,
                  );
                  assert.ok(
                    pageshowCapture && appPagehideClose.ts <= pageshowCapture.ts,
                    `Expected pre-navigation socket close (${appPagehideClose.ts}) at or before pageshow:capture (${pageshowCapture?.ts}):\n${await openSocketDiag({ backObservation })}`,
                  );
                  if (appPagehideClose.phase === "pagehide" && backObservation.wsPagehideTs !== null) {
                    assert.ok(
                      appPagehideClose.ts >= backObservation.wsPagehideTs,
                      `Expected pre-navigation socket close (${appPagehideClose.ts}) after pagehide start (${backObservation.wsPagehideTs}):\n${await openSocketDiag({ backObservation })}`,
                    );
                  }

                  // Hold revalidation GET /auth/v1/user briefly and assert zero old private paint.
                  ctx.setStep(`f-${variant.name}-restored-wait-revalidation-hold`);
                  await ctx.waitForSignal("restored pageshow revalidation GET /auth/v1/user", revalidateUserHit, pages);
                  const duringRevalidation = await tabB.evaluate(() => ({
                    privateRootCount: document.querySelectorAll('[data-testid="private-view-root"]').length,
                    checkingCount: document.querySelectorAll('[data-testid="session-checking-screen"]').length,
                    bodyText: (document.body?.innerText ?? "").slice(0, 600),
                  }));
                  releaseRevalidateUser.resolve();

                  t.diagnostic(
                    `[next-back-open-socket] outcome=restored variant=${variant.name} ` +
                    `closePhase=${appPagehideClose.phase} nodeClosePhase=${preSocket.closedPhase ?? "unknown"}`,
                  );

                  assert.equal(
                    duringRevalidation.privateRootCount,
                    0,
                    `private-view-root must stay unmounted while restored revalidation is pending:\n${await openSocketDiag({ backObservation, duringRevalidation })}`,
                  );
                  assert.equal(
                    duringRevalidation.checkingCount,
                    1,
                    `session-checking-screen must render while restored revalidation is pending:\n${await openSocketDiag({ backObservation, duringRevalidation })}`,
                  );
                  assert.equal(
                    duringRevalidation.bodyText.includes(variant.beforePrivateSlug),
                    false,
                    `Old private channel leaked during restored revalidation:\n${await openSocketDiag({ backObservation, duringRevalidation })}`,
                  );
                  assert.equal(
                    duringRevalidation.bodyText.includes(variant.beforeWs.name),
                    false,
                    `Old workspace label leaked during restored revalidation:\n${await openSocketDiag({ backObservation, duringRevalidation })}`,
                  );
                } else {
                  // Reloaded (full navigation; pageshow.persisted was false).
                  // Hold the fresh document's own gate GET /auth/v1/user briefly and prove nothing
                  // private is painted and no post-Back socket frames are sent before the gate completes.
                  ctx.setStep(`f-${variant.name}-reloaded-wait-fresh-gate-hold`);
                  await ctx.waitForSignal("reloaded fresh document gate GET /auth/v1/user", revalidateUserHit, pages);
                  const duringFreshGate = await tabB.evaluate(() => ({
                    privateRootCount: document.querySelectorAll('[data-testid="private-view-root"]').length,
                    checkingCount: document.querySelectorAll('[data-testid="session-checking-screen"]').length,
                    bodyText: (document.body?.innerText ?? "").slice(0, 600),
                  }));
                  const postBackFramesBeforeGate = recorder.sockets.flatMap((s) =>
                    s.frames.filter((f) => f.phase === "after-back"),
                  );
                  releaseRevalidateUser.resolve();

                  if (bfcacheNotUsed.length === 0) {
                    await new Promise((r) => setTimeout(r, 50));
                  }
                  const reasonsText = formatBfcacheNotRestoredReasons(
                    bfcacheNotUsed,
                    backObservation.notRestoredReasons,
                  );
                  t.diagnostic(
                    `[next-back-open-socket] outcome=reloaded reasons=${reasonsText} variant=${variant.name}`,
                  );

                  assert.equal(
                    preSocket.closed,
                    true,
                    `Pre-navigation socket must be closed on reload:\n${await openSocketDiag({ backObservation, reasonsText })}`,
                  );
                  assert.equal(
                    preSocket.closedPhase,
                    "during-leave",
                    `Pre-navigation socket close must have been observed in the leave phase on reload:\n${await openSocketDiag({ backObservation, reasonsText })}`,
                  );
                  assert.equal(
                    duringFreshGate.privateRootCount,
                    0,
                    `Fresh reloaded document must not mount private-view-root before its gate completes:\n${await openSocketDiag({ backObservation, duringFreshGate, reasonsText })}`,
                  );
                  assert.equal(
                    duringFreshGate.checkingCount,
                    1,
                    `Fresh reloaded document must render session-checking-screen while its gate is pending:\n${await openSocketDiag({ backObservation, duringFreshGate, reasonsText })}`,
                  );
                  for (const forbidden of [
                    variant.beforePrivateSlug,
                    variant.beforeWs.name,
                    variant.afterPrivateSlug,
                    variant.afterWs.name,
                  ]) {
                    assert.equal(
                      duringFreshGate.bodyText.includes(forbidden),
                      false,
                      `Fresh reloaded document painted private text "${forbidden}" before gate completion:\n${await openSocketDiag({ backObservation, duringFreshGate, reasonsText })}`,
                    );
                  }
                  assert.equal(
                    postBackFramesBeforeGate.length,
                    0,
                    `Fresh reloaded document sent realtime frames before gate completion:\n${await openSocketDiag({ backObservation, postBackFramesBeforeGate, reasonsText })}`,
                  );
                }

                // Revalidation / fresh gate must have verified the CURRENT login.
                assert.equal(
                  revalidateUserSid,
                  variant.afterSid,
                  `Post-Back GET /auth/v1/user must use current login sid "${variant.afterSid}" (saw "${revalidateUserSid}"):\n${await openSocketDiag()}`,
                );

                // Wait for the fresh read to paint AND a NEW post-Back realtime socket to join both current topics.
                ctx.setStep(`f-${variant.name}-wait-fresh-paint-and-new-socket`);
                await ctx.waitForNextSignedIn(tabB, variant.afterPrivateSlug, pages);
                await ctx.waitFor(
                  "new post-Back realtime socket opened with current login phx_join frames",
                  () => {
                    const postSockets = recorder.sockets.filter(
                      (s) => s.id !== preSocket.id && s.openedPhase === "after-back",
                    );
                    if (postSockets.length === 0) return false;
                    const joinedTopics = new Set(
                      postSockets.flatMap((s) =>
                        s.frames.filter((f) => f.event === "phx_join").map((f) => f.topic),
                      ),
                    );
                    return [...afterTopics].every((topic) => joinedTopics.has(topic));
                  },
                  pages,
                );
                // Short settle so any stray frame on the old socket or with an old bearer would surface.
                await new Promise((r) => setTimeout(r, 100));

                const freshText = await tabB.evaluate(() => document.body.innerText ?? "");
                assert.equal(
                  freshText.includes(variant.afterPrivateSlug),
                  true,
                  `Fresh read "${variant.afterPrivateSlug}" must paint after Back:\n${await openSocketDiag()}`,
                );
                assert.equal(
                  freshText.includes(variant.afterWs.name),
                  true,
                  `Current workspace "${variant.afterWs.name}" must paint after Back:\n${await openSocketDiag()}`,
                );
                assert.equal(
                  freshText.includes(variant.beforePrivateSlug),
                  false,
                  `Pre-Back private channel "${variant.beforePrivateSlug}" must not survive after Back:\n${await openSocketDiag()}`,
                );
                if (variant.changeLoginWhileAway) {
                  assert.equal(
                    freshText.includes(variant.beforeWs.name),
                    false,
                    `First login workspace "${variant.beforeWs.name}" must not paint after login change:\n${await openSocketDiag()}`,
                  );
                }

                // Assert on the old pre-navigation socket after pagehide:
                // - NO frame carrying a bearer and NO phx_join at all (phx_leave is allowed if bearer-free,
                //   never required);
                // - ZERO frames of any kind while away or after Back.
                const preSocketPostLeaveFrames = preSocket.frames.filter((f) => f.phase !== "before-leave");
                for (const frame of preSocketPostLeaveFrames) {
                  assert.equal(
                    frame.hasBearer,
                    false,
                    `Old socket sent a bearer-carrying frame after pagehide:\n${await openSocketDiag({ frame })}`,
                  );
                  assert.equal(
                    frame.raw.includes(beforeSession.access_token) ||
                      frame.raw.includes(afterSession.access_token),
                    false,
                    `Old socket leaked a bearer token after pagehide:\n${await openSocketDiag({ frame })}`,
                  );
                  assert.notEqual(
                    frame.event,
                    "phx_join",
                    `Old socket sent phx_join after pagehide:\n${await openSocketDiag({ frame })}`,
                  );
                }
                assert.equal(
                  preSocket.frames.length,
                  preSocketFrameCountBeforeBack,
                  `Old pre-navigation socket sent frames while away or after Back:\n${await openSocketDiag()}`,
                );
                assert.equal(
                  preSocket.frames.filter((f) => f.phase === "away" || f.phase === "after-back").length,
                  0,
                  `Old socket must send zero frames while away or after Back:\n${await openSocketDiag()}`,
                );
                assert.equal(
                  preSocket.frames.filter(
                    (f) =>
                      f.ts > preSocket.closedAt! &&
                      (f.phase !== "during-leave" || f.hasBearer || f.event === "phx_join"),
                  ).length,
                  0,
                  `Old socket sent forbidden frame after close timestamp:\n${await openSocketDiag()}`,
                );

                // Assert a NEW socket opened after Back and EVERY frame on EVERY socket after Back
                // carries ONLY the current login's topics and bearer.
                const postSockets = recorder.sockets.filter(
                  (s) => s.id !== preSocket.id && s.openedPhase === "after-back",
                );
                assert.ok(
                  postSockets.length >= 1,
                  `Expected a NEW realtime socket after Back (distinct from preSocket #${preSocket.id}):\n${await openSocketDiag()}`,
                );
                const allFramesAfterBack = recorder.sockets.flatMap((s) =>
                  s.frames.filter((f) => f.phase === "after-back"),
                );
                assert.ok(
                  allFramesAfterBack.length >= 2,
                  `Expected at least 2 post-Back frames (both phx_join frames):\n${await openSocketDiag()}`,
                );
                const postJoinFrames = allFramesAfterBack.filter((f) => f.event === "phx_join");
                assert.ok(
                  postJoinFrames.length >= 2,
                  `Expected at least 2 post-Back phx_join frames:\n${await openSocketDiag()}`,
                );

                for (const frame of allFramesAfterBack) {
                  assert.notEqual(
                    frame.socketId,
                    preSocket.id,
                    `Post-Back frame was sent on the pre-navigation socket:\n${await openSocketDiag({ frame })}`,
                  );
                  if (frame.event === "heartbeat") {
                    assert.equal(frame.topic, "phoenix");
                    assert.equal(frame.hasBearer, false);
                  } else {
                    assert.ok(
                      afterTopics.has(frame.topic),
                      `Post-Back frame topic "${frame.topic}" does not belong to current login:\n${await openSocketDiag({ frame })}`,
                    );
                  }
                  if (frame.hasBearer || frame.event === "phx_join" || frame.event === "access_token") {
                    assert.equal(
                      frame.hasBearer,
                      true,
                      `Post-Back ${frame.event} frame must carry a bearer:\n${await openSocketDiag({ frame })}`,
                    );
                    assert.equal(
                      frame.bearer,
                      afterSession.access_token,
                      `Post-Back frame carried wrong bearer:\n${await openSocketDiag({ frame })}`,
                    );
                    assert.equal(frame.bearerSid, variant.afterSid);
                    assert.equal(frame.bearerSub, variant.afterUser.id);
                  }
                  if (variant.changeLoginWhileAway) {
                    assert.equal(
                      frame.topic.includes(variant.beforeWs.id),
                      false,
                      `Post-Back frame topic leaked first login workspace id:\n${await openSocketDiag({ frame })}`,
                    );
                    assert.equal(
                      frame.topic.includes(variant.beforeUser.id),
                      false,
                      `Post-Back frame topic leaked first login user id:\n${await openSocketDiag({ frame })}`,
                    );
                    assert.equal(
                      frame.raw.includes(beforeSession.access_token),
                      false,
                      `Post-Back frame leaked first login bearer token:\n${await openSocketDiag({ frame })}`,
                    );
                  }
                }

                if (variant.changeLoginWhileAway) {
                  const staleApiAfterBack = ctx.apiLog
                    .slice(apiCountBeforeBack)
                    .filter((e) => e.sid === variant.beforeSid);
                  assert.equal(
                    staleApiAfterBack.length,
                    0,
                    `Post-Back HTTP requests leaked first login sid "${variant.beforeSid}":\n${await openSocketDiag({ staleApiAfterBack })}`,
                  );
                }
              } finally {
                releaseRevalidateUser.resolve();
                await cdp.detach().catch(() => undefined);
              }
            },
            openSocketBrowser,
          );
        }
      } finally {
        await openSocketBrowser.close();
        awayServerF.closeAllConnections();
        await new Promise<void>((r) => awayServerF.close(() => r()));
        if (awayServerFV6) {
          awayServerFV6.closeAllConnections();
          await new Promise<void>((r) => awayServerFV6.close(() => r()));
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // (g) Genuine failure with no rotation:
    //     Variant 1: 429 with Retry-After: 3
    //     Variant 2: dropped connection (route.abort("failed"))
    //     Both tabs promptly enter "could not check" (< 4s, not signed out, no stall),
    //     neither tab sends any refresh during backoff, and recovery after the window
    //     sends exactly one refresh and signs both tabs in.
    // ═══════════════════════════════════════════════════════════════════════════
    for (const variant of [
      {
        id: "g1-429-retry-after",
        sid: "sid-g1-1",
        rt1: "rt-g1-1",
        rt2: "rt-g1-2",
        windowMs: 3_000,
        quietCheckMs: 1_500,
        triggerViaTryAgain: true,
        firstFailure: () => ({
          status: 429,
          headers: { "retry-after": "3" },
          body: { code: "over_request_rate_limit", error_code: "over_request_rate_limit", msg: "Rate limited" },
        }),
      },
      {
        id: "g2-dropped-connection",
        sid: "sid-g2-1",
        rt1: "rt-g2-1",
        rt2: "rt-g2-2",
        windowMs: 2_000,
        quietCheckMs: 1_000,
        triggerViaTryAgain: false,
        firstFailure: () => ({ abort: "failed" as const }),
      },
    ]) {
      const firstRefreshHit = createSignal<void>();
      let firstFailAt = 0;
      let refreshCalls = 0;

      const scenario: ScenarioConfig = {
        name: variant.id,
        validRefreshToken: variant.rt1,
        nextRefreshToken: variant.rt2,
        activeSessionIds: new Set([variant.sid]),
        async onRefresh(rt) {
          refreshCalls += 1;
          if (refreshCalls === 1) {
            firstFailAt = Date.now();
            firstRefreshHit.resolve();
            return variant.firstFailure();
          }
          if (rt !== scenario.validRefreshToken) {
            return {
              status: 400,
              body: { code: "refresh_token_already_used", error_code: "refresh_token_already_used", msg: "Already used" },
            };
          }
          scenario.validRefreshToken = scenario.nextRefreshToken;
          return {
            status: 200,
            body: makeSessionPayload({ sessionId: variant.sid, refreshToken: scenario.nextRefreshToken }),
          };
        },
      };

      await withTwoTabScenario(scenario, async (ctx) => {
        ctx.setStep("seed-expired-session");
        await ctx.seedStorage(makeSessionPayload({ sessionId: variant.sid, refreshToken: variant.rt1, expired: true }));

        const tabA = await ctx.context.newPage();
        const tabB = await ctx.context.newPage();
        ctx.attachPageDiagnostics("tabA", tabA);
        ctx.attachPageDiagnostics("tabB", tabB);
        await ctx.instrumentTab("tabA", tabA);
        await ctx.instrumentTab("tabB", tabB);
        const pages = { tabA, tabB };

        ctx.setStep("open-both-tabs-with-expired-session");
        await Promise.all([tabA.goto(`${origin}/app`), tabB.goto(`${origin}/next`)]);
        await ctx.waitForSignal("initial failed refresh", firstRefreshHit, pages);
        const failSettledStart = Date.now();

        ctx.setStep("wait-for-both-tabs-could-not-check-promptly");
        await ctx.waitFor(
          `${variant.id}: Tab A (/app) workspace-error and Tab B (/next) recovery screen promptly`,
          async () => {
            const appOk = await tabA.evaluate(() => {
              const dash = document.querySelector<HTMLElement>("live-dashboard");
              const signedOut = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
              const msg = document.querySelector<HTMLElement>("[data-workspace-error]")?.textContent ?? "";
              return (
                dash?.dataset.state === "workspace-error" &&
                Boolean(signedOut?.hidden) &&
                /could not check your sign-in/i.test(msg)
              );
            });
            const nextOk = await tabB.evaluate(() => {
              const rec = document.querySelector<HTMLElement>('[data-testid="session-recovery-screen"]');
              const signedOut = document.querySelector<HTMLElement>('[data-testid="signed-out-screen"]');
              const priv = document.querySelector<HTMLElement>('[data-testid="private-view-root"]');
              const text = rec?.innerText ?? "";
              return (
                Boolean(rec) &&
                !signedOut &&
                !priv &&
                text.includes("Couldn't check your sign-in.") &&
                text.includes("Try again")
              );
            });
            return appOk && nextOk;
          },
          pages,
          3_000,
        );

        const elapsedMs = Date.now() - failSettledStart;
        assert.ok(
          elapsedMs < 3_000,
          `Both tabs must enter "could not check" promptly (well under 4s), took ${elapsedMs}ms:\n${await ctx.dumpDiagnostics(pages)}`,
        );
        assert.equal(
          ctx.counters.refreshes,
          1,
          `Expected exactly 1 refresh attempt before backoff:\n${await ctx.dumpDiagnostics(pages)}`,
        );

        if (variant.triggerViaTryAgain) {
          ctx.setStep("try-again-during-backoff-stays-honest-and-sends-no-refresh");
          await tabA.click("[data-retry-workspaces]");
          await ctx.waitFor(
            `${variant.id}: Tab A remains on workspace-error during active backoff`,
            () =>
              tabA.evaluate(() => {
                const dash = document.querySelector<HTMLElement>("live-dashboard");
                const signedOut = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
                const msg = document.querySelector<HTMLElement>("[data-workspace-error]")?.textContent ?? "";
                return (
                  dash?.dataset.state === "workspace-error" &&
                  Boolean(signedOut?.hidden) &&
                  /could not check your sign-in/i.test(msg)
                );
              }),
            pages,
            2_000,
          );
          assert.equal(
            ctx.counters.refreshes,
            1,
            `Try again during backoff must NOT send another refresh:\n${await ctx.dumpDiagnostics(pages)}`,
          );
        }

        ctx.setStep("verify-no-refresh-sent-during-backoff-window");
        const quietUntil = firstFailAt + variant.quietCheckMs;
        if (Date.now() < quietUntil) {
          await new Promise((r) => setTimeout(r, quietUntil - Date.now()));
        }
        assert.equal(
          ctx.counters.refreshes,
          1,
          `Neither tab may send a refresh during the backoff window:\n${await ctx.dumpDiagnostics(pages)}`,
        );
        assert.equal(
          await tabB.locator('[data-testid="signed-out-screen"]').count(),
          0,
          `Tab B must not sign out during backoff:\n${await ctx.dumpDiagnostics(pages)}`,
        );
        assert.equal(
          await tabB.locator('[data-testid="private-view-root"]').count(),
          0,
          `Tab B must keep private view unmounted during backoff:\n${await ctx.dumpDiagnostics(pages)}`,
        );

        ctx.setStep("recover-after-backoff-window-ends");
        const windowEnd = firstFailAt + variant.windowMs + 50;
        if (Date.now() < windowEnd) {
          await new Promise((r) => setTimeout(r, windowEnd - Date.now()));
        }
        if (variant.triggerViaTryAgain) {
          const retryBtnVisible = await tabA.locator("[data-retry-workspaces]").isVisible().catch(() => false);
          if (retryBtnVisible) {
            await tabA.click("[data-retry-workspaces]");
          }
        }

        await ctx.waitForAppSignedIn(tabA, pages);
        await ctx.waitForNextSignedIn(tabB, "Alpha Vault", pages);

        ctx.emitRefreshDiagnostics(variant.id);

        const stored = await ctx.readStorage(tabA);
        const pageErrors = ctx.consoleErrors.filter((line) => line.includes("pageerror"));
        assert.equal(
          ctx.counters.refreshes,
          2,
          `Expected exactly 2 refreshes (1 failed + 1 recovery):\n${await ctx.dumpDiagnostics(pages)}`,
        );
        assert.equal(
          ctx.counters.rejectedRefreshes,
          1,
          `Expected exactly 1 rejected/aborted refresh:\n${await ctx.dumpDiagnostics(pages)}`,
        );
        assert.equal(stored?.refresh_token, variant.rt2, "Rotated token must be persisted after recovery");
        assert.equal(await tabB.locator('[data-testid="signed-out-screen"]').count(), 0, "Tab B must remain signed in");
        assert.equal(pageErrors.length, 0, `Expected zero pageerrors:\n${await ctx.dumpDiagnostics(pages)}`);
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // (h) The double refresh made harmless:
    //     Force Tab B to send a refresh with the old token while Tab A's refresh is
    //     held; release Tab A's 200 rotation first, wait until both renderers see
    //     rt-h-2 in localStorage, then return 400 refresh_token_already_used to Tab B.
    //     Assert Tab B adopts rt-h-2 and signs in, nobody is signed out, nothing but
    //     the rotated session is ever stored, and exactly two refreshes were made.
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const sidH = "sid-double-h-1";
      const firstRefreshHit = createSignal<void>();
      const secondRefreshHit = createSignal<void>();
      const releaseSecondRefresh400 = createSignal<void>();
      let refreshIndex = 0;

      const scenario: ScenarioConfig = {
        name: "h-double-refresh-harmless",
        validRefreshToken: "rt-h-1",
        nextRefreshToken: "rt-h-2",
        activeSessionIds: new Set([sidH]),
        async onRefresh(rt) {
          refreshIndex += 1;
          if (refreshIndex === 1) {
            assert.equal(rt, "rt-h-1");
            scenario.validRefreshToken = scenario.nextRefreshToken;
            firstRefreshHit.resolve();
            // Hold the first tab's response until the second tab's request arrives.
            await secondRefreshHit.promise;
            return {
              status: 200,
              body: makeSessionPayload({ sessionId: sidH, refreshToken: scenario.nextRefreshToken }),
            };
          }
          // Second tab sent the old token after the first rotated it.
          secondRefreshHit.resolve();
          await releaseSecondRefresh400.promise;
          return {
            status: 400,
            body: { code: "refresh_token_already_used", error_code: "refresh_token_already_used", msg: "Already used" },
          };
        },
      };

      await withTwoTabScenario(scenario, async (ctx) => {
        try {
          ctx.setStep("seed-expired-session");
          await ctx.seedStorage(makeSessionPayload({ sessionId: sidH, refreshToken: "rt-h-1", expired: true }));

          const tabA = await ctx.context.newPage();
          const tabB = await ctx.context.newPage();
          ctx.attachPageDiagnostics("tabA", tabA);
          ctx.attachPageDiagnostics("tabB", tabB);
          await tabA.addInitScript(buildScenarioHInitScript(STORAGE_KEY, LOCK_NAME, false));
          await tabB.addInitScript(buildScenarioHInitScript(STORAGE_KEY, LOCK_NAME, true));
          await ctx.instrumentTab("tabA", tabA);
          await ctx.instrumentTab("tabB", tabB);
          const pages = { tabA, tabB };

          ctx.setStep("open-tabA-and-hold-first-refresh");
          const tabANav = tabA.goto(`${origin}/app`);
          await ctx.waitForSignal("Tab A first refresh", firstRefreshHit, pages);

          ctx.setStep("open-tabB-to-force-second-refresh-with-old-token");
          const tabBNav = tabB.goto(`${origin}/next`);
          await ctx.waitForSignal("Tab B overlapping second refresh", secondRefreshHit, pages);

          ctx.setStep("wait-for-rotated-session-in-storage-before-releasing-400");
          await ctx.waitFor(
            "both tabs observe rotated rt-h-2 in localStorage",
            async () => {
              const a = await ctx.readStorage(tabA);
              const b = await ctx.readStorage(tabB);
              return a?.refresh_token === "rt-h-2" && b?.refresh_token === "rt-h-2";
            },
            pages,
            10_000,
          );

          ctx.setStep("release-second-refresh-400");
          releaseSecondRefresh400.resolve();
          await Promise.all([tabANav, tabBNav]);

          await ctx.waitForAppSignedIn(tabA, pages);
          await ctx.waitForNextSignedIn(tabB, "Alpha Vault", pages);

          ctx.emitRefreshDiagnostics("h-double-refresh-harmless");

          const stored = await ctx.readStorage(tabA);
          const auditA = await tabA.evaluate(() => (window as unknown as {
            __csStorageAudit?: { writes: Array<{ refreshToken: string | null }>; removals: Array<unknown> };
          }).__csStorageAudit ?? { writes: [], removals: [] });
          const auditB = await tabB.evaluate(() => (window as unknown as {
            __csStorageAudit?: { writes: Array<{ refreshToken: string | null }>; removals: Array<unknown> };
          }).__csStorageAudit ?? { writes: [], removals: [] });
          const allWrites = [...auditA.writes, ...auditB.writes];
          const allRemovals = [...auditA.removals, ...auditB.removals];
          const pageErrors = ctx.consoleErrors.filter((line) => line.includes("pageerror"));

          assert.equal(
            ctx.counters.refreshes,
            2,
            `Expected exactly 2 refresh requests in scenario (h):\n${await ctx.dumpDiagnostics(pages)}`,
          );
          assert.equal(
            ctx.counters.rejectedRefreshes,
            1,
            `Expected exactly 1 rejected refresh in scenario (h):\n${await ctx.dumpDiagnostics(pages)}`,
          );
          assert.equal(stored?.refresh_token, "rt-h-2", "Rotated session rt-h-2 must remain stored");
          assert.ok(allWrites.length >= 1, "Rotated session must have been written to storage");
          assert.ok(
            allWrites.every((w) => w.refreshToken === "rt-h-2"),
            `Nothing but the rotated session (rt-h-2) may ever be stored: ${JSON.stringify(allWrites)}\n${await ctx.dumpDiagnostics(pages)}`,
          );
          assert.equal(
            allRemovals.length,
            0,
            `Zero storage removals allowed during double-refresh recovery: ${JSON.stringify(allRemovals)}\n${await ctx.dumpDiagnostics(pages)}`,
          );
          assert.equal(await tabB.locator('[data-testid="signed-out-screen"]').count(), 0, "Tab B must not be signed out");
          assert.equal(pageErrors.length, 0, `Expected zero pageerrors:\n${await ctx.dumpDiagnostics(pages)}`);
        } finally {
          secondRefreshHit.resolve();
          releaseSecondRefresh400.resolve();
        }
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Confirmed sign-out control:
    //     A terminal refusal (400 refresh_token_not_found) with the matching
    //     stored credential signs both tabs out and clears storage, as before.
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const sidTerm = "sid-term-control-1";
      const scenario: ScenarioConfig = {
        name: "confirmed-signout-terminal-refresh-control",
        validRefreshToken: "rt-term-dead",
        nextRefreshToken: "rt-term-unused",
        activeSessionIds: new Set<string>(),
        async onRefresh() {
          return {
            status: 400,
            body: { code: "refresh_token_not_found", error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" },
          };
        },
      };

      await withTwoTabScenario(scenario, async (ctx) => {
        ctx.setStep("seed-expired-dead-session");
        await ctx.seedStorage(makeSessionPayload({ sessionId: sidTerm, refreshToken: "rt-term-dead", expired: true }));

        const tabA = await ctx.context.newPage();
        const tabB = await ctx.context.newPage();
        ctx.attachPageDiagnostics("tabA", tabA);
        ctx.attachPageDiagnostics("tabB", tabB);
        await ctx.instrumentTab("tabA", tabA);
        await ctx.instrumentTab("tabB", tabB);
        const pages = { tabA, tabB };

        ctx.setStep("open-both-tabs-with-dead-credential");
        await Promise.all([tabA.goto(`${origin}/app`), tabB.goto(`${origin}/next`)]);

        await ctx.waitFor(
          "both tabs signed out after confirmed terminal refresh refusal",
          async () => {
            const appSignedOut = await tabA.evaluate(() => {
              const dash = document.querySelector<HTMLElement>("live-dashboard");
              const panel = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
              return dash?.dataset.state === "signed-out" && Boolean(panel && !panel.hidden);
            });
            const nextSignedOut = await tabB.evaluate(() => {
              return (
                Boolean(document.querySelector('[data-testid="signed-out-screen"]')) &&
                !document.querySelector('[data-testid="session-recovery-screen"]') &&
                !document.querySelector('[data-testid="private-view-root"]')
              );
            });
            return appSignedOut && nextSignedOut;
          },
          pages,
          10_000,
        );

        ctx.emitRefreshDiagnostics("confirmed-signout-terminal-refresh-control");

        const stored = await ctx.readStorage(tabA);
        const pageErrors = ctx.consoleErrors.filter((line) => line.includes("pageerror"));
        assert.equal(stored, null, `Dead session must be removed from storage:\n${await ctx.dumpDiagnostics(pages)}`);
        assert.equal(ctx.counters.refreshes, 1, `Expected single terminal refresh:\n${await ctx.dumpDiagnostics(pages)}`);
        assert.equal(ctx.counters.rejectedRefreshes, 1, "Expected 1 terminal rejected refresh");
        assert.equal(pageErrors.length, 0, `Expected zero pageerrors:\n${await ctx.dumpDiagnostics(pages)}`);
      });
    }
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
