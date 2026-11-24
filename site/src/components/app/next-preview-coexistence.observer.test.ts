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
 *  (b) A stale terminal refresh failure in one tab does not remove a replacement login stored
 *      by the other tab.
 *  (c) A private response held in `/next` stays retired after Tab A signs out, after the same
 *      person signs in again (new session_id), and after a workspace refusal: nothing private
 *      is painted and no stale request is sent.
 *  (d) The served `/next` response carries `Content-Security-Policy: frame-ancestors 'none'`
 *      (also verified against `deploy/site/commonswarm-site.caddy`, since this local test
 *      server is Node HTTP rather than Caddy) and a host page attempting to frame `/next`
 *      gets nothing.
 *
 * Deadlock safety: never hold a token-refresh response while asking the peer tab to acquire
 * the same Web Lock. Scenarios (a) and (b) release refresh holds well below the 4s `authFetch`
 * timeout, and scenario (c) holds only post-token data responses so the session Web Lock is
 * completely free during peer sign-out and re-sign-in.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { BrowserContext, Page, Route } from "playwright-core";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";
import { sessionStorageKeyForDeployment } from "../../../../shared/browser-session/index.js";

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

const ORG_1 = "55555555-5555-4555-8555-555555555555";
const WS_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const WS_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const CONV_GEN_1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const CONV_GEN_2 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
const CONV_SECRET_1 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const CONV_SECRET_2 = "cccccccc-cccc-4ccc-8ccc-ccccccccccc4";
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
}) {
  const now = Math.floor(Date.now() / 1000);
  const expOffset = options.expired ? -60 : 3600;
  return {
    access_token: makeJwt(USER_A.id, USER_A.email, options.sessionId, expOffset),
    refresh_token: options.refreshToken,
    expires_in: 3600,
    expires_at: now + expOffset,
    token_type: "bearer",
    user: USER_A,
  };
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

interface Deferred<T = void> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface ApiEvent {
  readonly ts: number;
  readonly method: string;
  readonly path: string;
  readonly sid: string;
  readonly detail: string;
  readonly status: number;
}

interface ScenarioConfig {
  name: string;
  validRefreshToken: string;
  nextRefreshToken: string;
  activeSessionIds: Set<string>;
  /** Optional hook to handle POST /auth/v1/token?grant_type=refresh_token */
  onRefresh?: (refreshToken: string) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** Session issued on POST /auth/v1/token?grant_type=password */
  onPasswordSignIn?: () => ReturnType<typeof makeSessionPayload>;
  /** Optional hook to customize or hold POST /functions/v1/read */
  onEdgeRead?: (body: Record<string, unknown>, sid: string) => Promise<{ status: number; body: Record<string, unknown> }>;
  /** Optional hook to customize or hold POST /rest/v1/rpc/decision_queue */
  onDecisionQueue?: (body: Record<string, unknown>, sid: string) => Promise<{ status: number; body: unknown }>;
  /** Workspaces list returned by GET /rest/v1/workspaces */
  workspaces?: Array<{ id: string; name: string }>;
}

function makeConversation(options: {
  id: string;
  slug: string;
  kind?: "general" | "public_channel" | "private_channel";
  joined?: boolean;
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
      { kind: "user", id: USER_A.id, joined_at: NOW_ISO, left_at: null },
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

function buildHomeOverview(workspaces: Array<{ id: string; name: string }>) {
  return {
    viewer_user_id: USER_A.id,
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
          user_id: USER_A.id,
          display_name: "Alex Owner",
          role: "owner",
          is_viewer: true,
          agents: [],
        },
      ],
      needs_you: { asks: [], assigned: [], waiting: [] },
    })),
  };
}

test("served /app and /next two-tab coexistence: single-use refresh, stale terminal guard, held private retirement, and anti-framing", { timeout: 180_000 }, async () => {
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
        counters: { refreshes: number; rejectedRefreshes: number; userChecks: number; logouts: number };
        consoleErrors: string[];
        setStep: (s: string) => void;
        attachPageDiagnostics: (label: string, p: Page) => void;
        dumpDiagnostics: (pages: Record<string, Page | null>) => Promise<string>;
        waitFor: (
          label: string,
          predicate: () => Promise<boolean> | boolean,
          pages: Record<string, Page | null>,
          timeoutMs?: number,
        ) => Promise<void>;
        seedStorage: (sessionObj: ReturnType<typeof makeSessionPayload> | null) => Promise<void>;
        readStorage: (p: Page) => Promise<{ refresh_token?: string; access_token?: string; user?: { id?: string } } | null>;
        waitForAppSignedIn: (p: Page, pages: Record<string, Page | null>) => Promise<void>;
        waitForNextSignedIn: (p: Page, expectedText: string, pages: Record<string, Page | null>) => Promise<void>;
        signOutFromApp: (p: Page, pages: Record<string, Page | null>) => Promise<void>;
      }) => Promise<void>,
    ): Promise<void> {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const apiLog: ApiEvent[] = [];
      const consoleErrors: string[] = [];
      const counters = { refreshes: 0, rejectedRefreshes: 0, userChecks: 0, logouts: 0 };
      let currentStep = `${scenario.name}:init`;
      const defaultWorkspaces = scenario.workspaces ?? [
        { id: WS_1, name: "Alpha Vault" },
        { id: WS_2, name: "Beta Vault" },
      ];

      const corsHeaders = {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        "access-control-allow-headers":
          "authorization,apikey,content-type,accept,accept-profile,content-profile,x-client-info,x-supabase-api-version,prefer",
        "access-control-expose-headers": "x-supabase-api-version",
        "x-supabase-api-version": "2024-01-01",
      };

      const fulfillJson = async (route: Route, status: number, payload: unknown, sid: string, detail: string) => {
        const req = route.request();
        const reqPath = new URL(req.url()).pathname;
        apiLog.push({ ts: Date.now(), method: req.method(), path: reqPath, sid, detail, status });
        if (apiLog.length > 200) apiLog.shift();
        await route.fulfill({
          status,
          headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(payload),
        });
      };

      await context.routeWebSocket("wss://api.commonswarm.com/**", (ws) => {
        ws.close();
      });

      await context.route("https://api.commonswarm.com/**", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const method = req.method().toUpperCase();
        if (method === "OPTIONS") {
          await route.fulfill({ status: 204, headers: corsHeaders, body: "" });
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

        if (url.pathname === "/auth/v1/settings" && method === "GET") {
          await fulfillJson(route, 200, { external: { google: false, github: false, email: true } }, sid, "settings");
          return;
        }
        if (url.pathname === "/auth/v1/user" && method === "GET") {
          counters.userChecks += 1;
          if (!scenario.activeSessionIds.has(sid)) {
            await fulfillJson(
              route,
              403,
              { code: "session_not_found", error_code: "session_not_found", msg: "Session not found" },
              sid,
              "user-revoked",
            );
            return;
          }
          await fulfillJson(route, 200, USER_A, sid, "user-ok");
          return;
        }
        if (url.pathname === "/auth/v1/logout" && method === "POST") {
          counters.logouts += 1;
          scenario.activeSessionIds.delete(sid);
          apiLog.push({ ts: Date.now(), method, path: url.pathname, sid, detail: "logout", status: 204 });
          await route.fulfill({ status: 204, headers: corsHeaders, body: "" });
          return;
        }
        if (url.pathname === "/auth/v1/token" && method === "POST") {
          const grant = url.searchParams.get("grant_type") ?? "";
          const reqBody = parseJsonBody();
          if (grant === "password") {
            const issued = scenario.onPasswordSignIn
              ? scenario.onPasswordSignIn()
              : makeSessionPayload({ sessionId: `sid-pw-${Date.now()}`, refreshToken: `rt-pw-${Date.now()}` });
            const issuedSid = decodeSidFromAuthHeader(`Bearer ${issued.access_token}`);
            scenario.activeSessionIds.add(issuedSid);
            scenario.validRefreshToken = issued.refresh_token;
            await fulfillJson(route, 200, issued, issuedSid, "password-signin");
            return;
          }
          if (grant === "refresh_token") {
            counters.refreshes += 1;
            const rt = String(reqBody.refresh_token ?? "");
            if (scenario.onRefresh) {
              const out = await scenario.onRefresh(rt);
              if (out.status >= 400) counters.rejectedRefreshes += 1;
              await fulfillJson(route, out.status, out.body, sid, `refresh(${rt})`);
              return;
            }
            if (rt !== scenario.validRefreshToken) {
              counters.rejectedRefreshes += 1;
              await fulfillJson(
                route,
                400,
                { code: "refresh_token_already_used", error_code: "refresh_token_already_used", msg: "Already used" },
                sid,
                `refresh-rejected(${rt})`,
              );
              return;
            }
            const nextSession = makeSessionPayload({
              sessionId: [...scenario.activeSessionIds][0] ?? "sid-default",
              refreshToken: scenario.nextRefreshToken,
            });
            scenario.validRefreshToken = scenario.nextRefreshToken;
            await fulfillJson(route, 200, nextSession, sid, `refresh-ok(${rt}->${scenario.nextRefreshToken})`);
            return;
          }
          await fulfillJson(route, 400, { error: "unsupported_grant_type" }, sid, `token-${grant}`);
          return;
        }

        // Authenticated data routes (PostgREST + Edge Functions):
        if (!scenario.activeSessionIds.has(sid)) {
          if (url.pathname.startsWith("/rest/v1/")) {
            await fulfillJson(route, 401, { code: "session_not_found", message: "Session ended" }, sid, "rest-401");
          } else {
            await fulfillJson(route, 401, { error: "unauthenticated" }, sid, "edge-401");
          }
          return;
        }

        if (url.pathname === "/rest/v1/workspaces" && method === "GET") {
          const rows = defaultWorkspaces.map((ws) => ({
            workspace_id: ws.id,
            org_id: ORG_1,
            org_display_name: "Alpha Org",
            name: ws.name,
            archived_at: null,
            lead_agent_principal_id: null,
            channel_creation_policy: "members",
          }));
          await fulfillJson(route, 200, rows, sid, "workspaces");
          return;
        }
        if (url.pathname === "/rest/v1/rpc/home_overview" && method === "POST") {
          await fulfillJson(route, 200, buildHomeOverview(defaultWorkspaces), sid, "home_overview");
          return;
        }
        if (url.pathname === "/rest/v1/rpc/decision_queue" && method === "POST") {
          const reqBody = parseJsonBody();
          if (scenario.onDecisionQueue) {
            const out = await scenario.onDecisionQueue(reqBody, sid);
            await fulfillJson(route, out.status, out.body, sid, `decision_queue(${String(reqBody.p_workspace_id ?? "")})`);
            return;
          }
          await fulfillJson(
            route,
            200,
            {
              workspace_id: String(reqBody.p_workspace_id ?? WS_1),
              generated_at: NOW_ISO,
              total: 0,
              truncated: false,
              asks: [],
            },
            sid,
            `decision_queue(${String(reqBody.p_workspace_id ?? "")})`,
          );
          return;
        }
        if (url.pathname === "/rest/v1/rpc/waiting_todos_page" && method === "POST") {
          const reqBody = parseJsonBody();
          await fulfillJson(
            route,
            200,
            {
              workspace_id: String(reqBody.p_workspace_id ?? WS_1),
              generated_at: NOW_ISO,
              total: 0,
              truncated: false,
              todos: [],
            },
            sid,
            `waiting_todos(${String(reqBody.p_workspace_id ?? "")})`,
          );
          return;
        }
        if (url.pathname === "/rest/v1/rpc/channel_unread" && method === "POST") {
          const reqBody = parseJsonBody();
          await fulfillJson(
            route,
            200,
            { workspace_id: String(reqBody.p_workspace_id ?? WS_1), generated_at: NOW_ISO, channels: [] },
            sid,
            "channel_unread",
          );
          return;
        }
        if (url.pathname === "/rest/v1/member_profiles" && method === "GET") {
          await fulfillJson(
            route,
            200,
            [{ user_id: USER_A.id, display_name: "Alex Owner", role: "owner" }],
            sid,
            "member_profiles",
          );
          return;
        }
        if (url.pathname === "/rest/v1/channels" && method === "GET") {
          await fulfillJson(
            route,
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
            sid,
            "channels",
          );
          return;
        }
        if (url.pathname.startsWith("/rest/v1/")) {
          await fulfillJson(route, 200, [], sid, `rest-empty(${url.pathname})`);
          return;
        }
        if (url.pathname === "/functions/v1/read" && method === "POST") {
          const reqBody = parseJsonBody();
          if (scenario.onEdgeRead) {
            const out = await scenario.onEdgeRead(reqBody, sid);
            await fulfillJson(
              route,
              out.status,
              out.body,
              sid,
              `edge-read(${String(reqBody.resource ?? "")}:${String(reqBody.workspace_id ?? "")})`,
            );
            return;
          }
          if (reqBody.resource === "conversations") {
            const wsId = String(reqBody.workspace_id ?? WS_1);
            await fulfillJson(
              route,
              200,
              {
                conversations: [
                  makeConversation({
                    id: wsId === WS_2 ? CONV_GEN_2 : CONV_GEN_1,
                    slug: wsId === WS_2 ? "beta-general" : "alpha-general",
                    kind: "general",
                  }),
                ],
              },
              sid,
              `conversations(${wsId})`,
            );
            return;
          }
          if (reqBody.resource === "conversation_history") {
            await fulfillJson(route, 200, { signals: [], has_more: false, mentions: [], reactions: [] }, sid, "conv_history");
            return;
          }
          if (reqBody.resource === "seat_admin_status") {
            await fulfillJson(route, 200, { enabled: false }, sid, "seat_admin_status");
            return;
          }
          if (reqBody.resource === "pending_access") {
            await fulfillJson(route, 200, { pending: [], agents: [] }, sid, "pending_access");
            return;
          }
          if (reqBody.resource === "review_checks") {
            await fulfillJson(route, 200, { checks: [] }, sid, "review_checks");
            return;
          }
          await fulfillJson(route, 200, { grants: [], invitations: [] }, sid, `edge-read-other(${String(reqBody.resource ?? "")})`);
          return;
        }
        if (url.pathname === "/functions/v1/command" && method === "POST") {
          await fulfillJson(route, 200, { status: "accepted" }, sid, "command");
          return;
        }
        await fulfillJson(route, 404, { error: "not_found" }, sid, "unknown");
      });

      const attachPageDiagnostics = (label: string, p: Page) => {
        p.on("pageerror", (err) => consoleErrors.push(`${label} pageerror: ${err.message}`));
        p.on("console", (msg) => {
          if (msg.type() === "error") consoleErrors.push(`${label} console.error: ${msg.text()}`);
        });
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
              const testIds = [...document.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid"));
              return {
                href: location.href,
                dashboardState: dash?.dataset.state ?? null,
                testIds,
                storedSummary,
                bodyPreview: (document.body?.innerText ?? "").slice(0, 300),
              };
            }, STORAGE_KEY)
            .catch((e: unknown) => `eval-failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return JSON.stringify(
          {
            scenario: scenario.name,
            step: currentStep,
            counters,
            activeSessionIds: [...scenario.activeSessionIds],
            domSnapshots,
            consoleErrors: consoleErrors.slice(-20),
            recentApiLog: apiLog.slice(-40),
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
              return Boolean(state && state !== "signed-out" && state !== "workspace-error" && signedOut?.hidden);
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
          counters,
          consoleErrors,
          setStep: (s) => { currentStep = `${scenario.name}:${s}`; },
          attachPageDiagnostics,
          dumpDiagnostics,
          waitFor,
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
    //     and neither tab is signed out.
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const sidA = "sid-overlap-1";
      const firstRefreshHit = createDeferred<void>();
      const releaseFirstRefresh = createDeferred<void>();
      const scenario: ScenarioConfig = {
        name: "a-overlapping-refresh",
        validRefreshToken: "rt-overlap-1",
        nextRefreshToken: "rt-overlap-2",
        activeSessionIds: new Set([sidA]),
        async onRefresh(rt) {
          if (rt !== scenario.validRefreshToken) {
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
        ctx.setStep("seed-expired-session");
        await ctx.seedStorage(makeSessionPayload({ sessionId: sidA, refreshToken: "rt-overlap-1", expired: true }));

        const tabA = await ctx.context.newPage();
        const tabB = await ctx.context.newPage();
        ctx.attachPageDiagnostics("tabA", tabA);
        ctx.attachPageDiagnostics("tabB", tabB);
        const pages = { tabA, tabB };

        ctx.setStep("open-both-tabs-simultaneously");
        await Promise.all([tabA.goto(`${origin}/app`), tabB.goto(`${origin}/next`)]);

        ctx.setStep("wait-for-first-refresh-and-peer-lock-contention");
        await ctx.waitFor("first refresh to hit scripted API", async () => {
          return await Promise.race([firstRefreshHit.promise.then(() => true), Promise.resolve(false)]);
        }, pages);

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

        const stored = await ctx.readStorage(tabA);
        assert.equal(ctx.counters.refreshes, 1, `Expected single-use refresh token spent once:\n${await ctx.dumpDiagnostics(pages)}`);
        assert.equal(ctx.counters.rejectedRefreshes, 0, `Expected zero rejected refreshes:\n${await ctx.dumpDiagnostics(pages)}`);
        assert.equal(stored?.refresh_token, "rt-overlap-2", "Rotated refresh token must be persisted");
        assert.equal(await tabB.locator('[data-testid="signed-out-screen"]').count(), 0, "Tab B must remain signed in");
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // (b) Stale terminal refresh failure in one tab does not remove a replacement
    //     login stored by the other tab.
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const staleSid = "sid-stale-1";
      const replacementSid = "sid-replacement-2";
      const staleRefreshHit = createDeferred<void>();
      const releaseStaleRefresh = createDeferred<void>();

      const scenario: ScenarioConfig = {
        name: "b-stale-terminal-preserves-replacement",
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
        ctx.setStep("seed-stale-expired-session");
        await ctx.seedStorage(makeSessionPayload({ sessionId: staleSid, refreshToken: "rt-stale-1", expired: true }));

        // Open a peer tab on the same origin first (does not touch the Web Lock yet) and Tab B on /next.
        const tabA = await ctx.context.newPage();
        const tabB = await ctx.context.newPage();
        ctx.attachPageDiagnostics("tabA", tabA);
        ctx.attachPageDiagnostics("tabB", tabB);
        const pages = { tabA, tabB };

        await tabA.goto(`${origin}/seed`);
        ctx.setStep("boot-tabB-with-expired-stale-session");
        await tabB.goto(`${origin}/next`);

        await ctx.waitFor("Tab B stale refresh to reach API", async () => {
          return await Promise.race([staleRefreshHit.promise.then(() => true), Promise.resolve(false)]);
        }, pages);

        // While Tab B holds the stale refresh in flight, Tab A stores the replacement login
        // directly in shared localStorage (firing a real cross-tab StorageEvent without blocking on Tab B's lock).
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
        // Let the cross-tab StorageEvent deliver to Tab B before the stale refresh returns its terminal 400.
        await new Promise((r) => setTimeout(r, 80));

        ctx.setStep("release-stale-terminal-refresh-400");
        releaseStaleRefresh.resolve();

        // Now navigate Tab A to /app and confirm BOTH tabs adopt/keep the replacement login!
        await tabA.goto(`${origin}/app`);
        await ctx.waitForAppSignedIn(tabA, pages);
        await ctx.waitForNextSignedIn(tabB, "Alpha Vault", pages);

        const stored = await ctx.readStorage(tabA);
        assert.equal(
          stored?.refresh_token,
          "rt-replacement-2",
          `Stale terminal refresh must NOT remove replacement login:\n${await ctx.dumpDiagnostics(pages)}`,
        );
        assert.equal(await tabB.locator('[data-testid="signed-out-screen"]').count(), 0, "Tab B must remain signed in on replacement login");
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
      let heldWs2Hit: Deferred<void> | null = null;
      let releaseHeldWs2: Deferred<void> | null = null;
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
                    makeConversation({ id: CONV_GEN_2, slug: "beta-general", kind: "general" }),
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
                    slug: wsId === WS_2 ? "beta-public-clean" : "alpha-general",
                    kind: "general",
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
        ctx.setStep("c1-boot-both-tabs");
        await ctx.seedStorage(makeSessionPayload({ sessionId: sid1, refreshToken: "rt-c-1" }));
        const tabA = await ctx.context.newPage();
        const tabB = await ctx.context.newPage();
        ctx.attachPageDiagnostics("tabA", tabA);
        ctx.attachPageDiagnostics("tabB", tabB);
        const pages = { tabA, tabB };

        await Promise.all([tabA.goto(`${origin}/app`), tabB.goto(`${origin}/next`)]);
        await ctx.waitForAppSignedIn(tabA, pages);
        await ctx.waitForNextSignedIn(tabB, "alpha-general", pages);

        // Hold WS_2 private conversations response in Tab B (Web Lock is FREE!).
        ctx.setStep("c1-hold-ws2-private-response");
        holdWs2ForSid = sid1;
        secretSlugForHeld = "secret-c1-signout-only";
        heldWs2Hit = createDeferred<void>();
        releaseHeldWs2 = createDeferred<void>();
        await tabB.click('button[aria-label="Beta Vault workspace"]');
        await ctx.waitFor("held WS_2 conversations request (c1)", async () => {
          return await Promise.race([heldWs2Hit!.promise.then(() => true), Promise.resolve(false)]);
        }, pages);

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
        await ctx.waitForNextSignedIn(tabB, "alpha-general", pages);

        // Hold WS_2 private response under sid2.
        ctx.setStep("c2-hold-ws2-private-response-sid2");
        holdWs2ForSid = sid2;
        secretSlugForHeld = "secret-c2-sid2-only";
        heldWs2Hit = createDeferred<void>();
        releaseHeldWs2 = createDeferred<void>();
        await tabB.click('button[aria-label="Beta Vault workspace"]');
        await ctx.waitFor("held WS_2 conversations request (c2)", async () => {
          return await Promise.race([heldWs2Hit!.promise.then(() => true), Promise.resolve(false)]);
        }, pages);

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
        await ctx.waitForNextSignedIn(tabB, "alpha-general", pages);

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
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // (c3) Held private response in /next stays retired after workspace refusal
    // ═══════════════════════════════════════════════════════════════════════════
    {
      const sidRefusal = "sid-c3-refusal";
      const ws2ConvHit = createDeferred<void>();
      const ws2ConvRelease = createDeferred<void>();
      const ws2DecisionHit = createDeferred<void>();
      const ws2DecisionRelease = createDeferred<void>();
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
                conversations: [makeConversation({ id: CONV_GEN_1, slug: "alpha-general", kind: "general" })],
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
        ctx.setStep("c3-boot-tabB");
        await ctx.seedStorage(makeSessionPayload({ sessionId: sidRefusal, refreshToken: "rt-c3-1" }));
        const tabB = await ctx.context.newPage();
        ctx.attachPageDiagnostics("tabB", tabB);
        const pages = { tabB };

        await tabB.goto(`${origin}/next`);
        await ctx.waitForNextSignedIn(tabB, "alpha-general", pages);

        ctx.setStep("c3-select-ws2-and-hold-both-conversations-and-decision-queue");
        await tabB.click('button[aria-label="Revoked Vault workspace"]');
        await ctx.waitFor("WS_2 conversations and decision_queue both in flight", async () => {
          const [c, d] = await Promise.all([
            Promise.race([ws2ConvHit.promise.then(() => true), Promise.resolve(false)]),
            Promise.race([ws2DecisionHit.promise.then(() => true), Promise.resolve(false)]),
          ]);
          return c && d;
        }, pages);

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
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
