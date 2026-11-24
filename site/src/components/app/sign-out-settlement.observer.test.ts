/**
 * Mounted browser witnesses for single-account sign-out settlement in `/app` (`LiveDashboard.astro`).
 *
 * Serves the real built `site/dist` (`/app`) over local loopback with Playwright intercepting
 * `https://api.commonswarm.com/**` (zero external traffic).
 *
 * Proves C2b:
 *  (a) Refused local removal with server logout unconfirmed (500), followed by a real same-login
 *      `SIGNED_IN` notification from GoTrue's visibilitychange recovery: the private view stays
 *      closed, the retry panel ("CommonSwarm could not sign you out on this device." + Try again)
 *      stays intact, and retrying after storage recovers finishes signing out cleanly.
 *  (b) Control: after a refused local removal leaves the retry panel active, a genuinely new
 *      login (same user with a new `session_id`) arrives and signs in normally, clearing the
 *      pending sign-out state.
 *  (c) Successful local removal with server logout unconfirmed (500): the notice
 *      "Signed out on this device. Could not reach the server to confirm remote sign-out."
 *      survives the `SIGNED_OUT` event and the queued `boot()`, and clears on an explicit
 *      signed-out auth-entry switch.
 *  (d) Delayed unrelated cross-tab notifications (unscoped `SIGNED_OUT`, and `SIGNED_IN`
 *      naming a different login not in storage) while storage still holds the retired login:
 *      the private view stays closed, the retry panel stays intact, and nothing of the
 *      retired login is painted.
 *  (e) Late sign-out settlement arriving after a verified successor has been shown changes
 *      nothing on screen and clears nothing belonging to the successor.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import type { BrowserContext, Page, Route } from "playwright-core";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";
import { sessionStorageKeyForDeployment } from "../../../../shared/browser-session/index.js";

const API_ORIGIN = "https://api.commonswarm.com";
const STORAGE_KEY = sessionStorageKeyForDeployment(API_ORIGIN);
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

function makeSessionPayload(opts: {
  user?: typeof USER_A;
  sessionId: string;
  refreshToken: string;
  expOffsetSec?: number;
}) {
  const user = opts.user ?? USER_A;
  const expOffset = opts.expOffsetSec ?? 3600;
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    access_token: makeJwt(user.id, user.email, opts.sessionId, expOffset),
    refresh_token: opts.refreshToken,
    expires_in: 3600,
    expires_at: nowSec + expOffset,
    token_type: "bearer",
    user,
  };
}

function decodeSidFromAuthHeader(authHeader: string | undefined): string {
  if (!authHeader) return "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return "";
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { session_id?: unknown };
    return typeof parsed.session_id === "string" ? parsed.session_id : "";
  } catch {
    return "";
  }
}

function injectRuntimeMeta(html: string, url: string, anonKey: string): string {
  const stripped = html.replace(/\s*<meta\s+name="commonswarm:(?:url|anon-key)"[^>]*\/?>/gi, "");
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

function buildHomeOverview(workspaces: Array<{ id: string; name: string }>, user: typeof USER_A) {
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

interface ApiEvent {
  readonly ts: number;
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly sid: string;
  readonly status: number;
}

interface ScenarioConfig {
  readonly name: string;
  readonly activeSessionIds: Set<string>;
  readonly logoutStatus: number;
  readonly workspacesForSid?: (sid: string) => Array<{ id: string; name: string }>;
}

test(
  "mounted /app sign-out settlement keeps retired login closed through same-login SIGNED_IN, admits a genuinely new login, and preserves the unconfirmed-server notice through SIGNED_OUT boot",
  { timeout: 120_000 },
  async () => {
    const siteRoot = resolve(import.meta.dirname, "../../..");
    const siteDist = join(siteRoot, "dist");
    assert.ok(existsSync(join(siteDist, "app/index.html")), "CI must build site/dist/app/index.html first");

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const pathname = reqUrl.pathname;
        if (pathname === "/seed") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end("<!doctype html><html><head><meta charset=\"utf-8\"></head><body>seed</body></html>");
          return;
        }
        try {
          const rel =
            pathname === "/" || pathname === ""
              ? "index.html"
              : pathname.endsWith("/")
                ? `${pathname.slice(1)}index.html`
                : !extname(pathname) && existsSync(join(siteDist, pathname.slice(1), "index.html"))
                  ? `${pathname.slice(1)}/index.html`
                  : pathname.replace(/^\//, "");
          const filePath = resolve(siteDist, rel);
          if (!filePath.startsWith(`${resolve(siteDist)}/`)) {
            res.writeHead(404);
            res.end("not found");
            return;
          }
          let body = await readFile(filePath);
          if (filePath.endsWith(".html")) {
            body = Buffer.from(injectRuntimeMeta(body.toString("utf8"), API_ORIGIN, ANON_KEY), "utf8");
          }
          res.writeHead(200, { "content-type": mimeTypeFor(filePath) });
          res.end(body);
        } catch {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("not found");
        }
      })();
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const { chromium } = await import("playwright-core");
    const browser = await launchPlaywrightChromium(chromium);

    try {
      const withScenario = async (
        scenario: ScenarioConfig,
        body: (ctx: {
          context: BrowserContext;
          apiLog: ApiEvent[];
          consoleErrors: string[];
          counters: { userChecks: number; logouts: number };
          setStep: (s: string) => void;
          attachDiagnostics: (label: string, p: Page) => void;
          dumpDiagnostics: (p: Page) => Promise<string>;
          waitFor: (label: string, predicate: () => Promise<boolean> | boolean, p: Page, timeoutMs?: number) => Promise<void>;
          seedStorage: (sessionObj: ReturnType<typeof makeSessionPayload> | null) => Promise<void>;
          waitForAppSignedIn: (p: Page) => Promise<void>;
          signOutFromApp: (p: Page) => Promise<void>;
        }) => Promise<void>,
      ): Promise<void> => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const apiLog: ApiEvent[] = [];
        const consoleErrors: string[] = [];
        const counters = { userChecks: 0, logouts: 0 };
        let currentStep = `${scenario.name}:init`;

        const corsHeaders = {
          "access-control-allow-origin": origin,
          "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
          "access-control-allow-headers":
            "authorization,apikey,content-type,accept,accept-profile,content-profile,x-client-info,x-supabase-api-version,prefer",
          "access-control-expose-headers": "x-supabase-api-version, retry-after",
          "x-supabase-api-version": "2024-01-01",
        };

        const fulfillJson = async (route: Route, status: number, payload: unknown, sid: string, url: URL, method: string) => {
          apiLog.push({ ts: Date.now(), method, path: url.pathname, search: url.search, sid, status });
          await route
            .fulfill({
              status,
              headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
              body: JSON.stringify(payload),
            })
            .catch(() => undefined);
        };

        await context.routeWebSocket("wss://api.commonswarm.com/**", (ws) => {
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
          const sid = decodeSidFromAuthHeader(req.headers().authorization);
          let reqBody: Record<string, unknown> = {};
          if (method === "POST") {
            const raw = req.postData();
            if (raw) {
              try {
                reqBody = JSON.parse(raw) as Record<string, unknown>;
              } catch {
                reqBody = {};
              }
            }
          }

          if (url.pathname === "/auth/v1/settings" && method === "GET") {
            await fulfillJson(route, 200, { external: { google: false, github: false, email: true } }, sid, url, method);
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
                url,
                method,
              );
              return;
            }
            await fulfillJson(route, 200, USER_A, sid, url, method);
            return;
          }
          if (url.pathname === "/auth/v1/logout" && method === "POST") {
            counters.logouts += 1;
            if (scenario.logoutStatus >= 200 && scenario.logoutStatus < 300) {
              scenario.activeSessionIds.delete(sid);
              apiLog.push({ ts: Date.now(), method, path: url.pathname, search: url.search, sid, status: scenario.logoutStatus });
              await route.fulfill({ status: scenario.logoutStatus, headers: corsHeaders, body: "" }).catch(() => undefined);
              return;
            }
            await fulfillJson(
              route,
              scenario.logoutStatus,
              { code: "unexpected_failure", msg: "Fixture logout unavailable" },
              sid,
              url,
              method,
            );
            return;
          }

          if (!scenario.activeSessionIds.has(sid)) {
            await fulfillJson(
              route,
              401,
              url.pathname.startsWith("/rest/v1/") ? { code: "session_not_found", message: "Session ended" } : { error: "unauthenticated" },
              sid,
              url,
              method,
            );
            return;
          }

          const workspacesForReq = scenario.workspacesForSid
            ? scenario.workspacesForSid(sid)
            : [{ id: WS_1, name: "Alpha Vault" }];

          if (url.pathname === "/rest/v1/workspaces" && method === "GET") {
            await fulfillJson(
              route,
              200,
              workspacesForReq.map((ws) => ({
                workspace_id: ws.id,
                org_id: ORG_1,
                org_display_name: "Alpha Org",
                name: ws.name,
                archived_at: null,
                lead_agent_principal_id: null,
                channel_creation_policy: "members",
              })),
              sid,
              url,
              method,
            );
            return;
          }
          if (url.pathname === "/rest/v1/rpc/home_overview" && method === "POST") {
            await fulfillJson(route, 200, buildHomeOverview(workspacesForReq, USER_A), sid, url, method);
            return;
          }
          if (url.pathname === "/rest/v1/rpc/decision_queue" && method === "POST") {
            await fulfillJson(
              route,
              200,
              { workspace_id: String(reqBody.p_workspace_id ?? WS_1), generated_at: NOW_ISO, total: 0, truncated: false, asks: [] },
              sid,
              url,
              method,
            );
            return;
          }
          if (url.pathname === "/rest/v1/rpc/waiting_todos_page" && method === "POST") {
            await fulfillJson(
              route,
              200,
              { workspace_id: String(reqBody.p_workspace_id ?? WS_1), generated_at: NOW_ISO, total: 0, truncated: false, todos: [] },
              sid,
              url,
              method,
            );
            return;
          }
          if (url.pathname === "/rest/v1/rpc/channel_unread" && method === "POST") {
            await fulfillJson(
              route,
              200,
              { workspace_id: String(reqBody.p_workspace_id ?? WS_1), generated_at: NOW_ISO, channels: [] },
              sid,
              url,
              method,
            );
            return;
          }
          if (url.pathname === "/rest/v1/member_profiles" && method === "GET") {
            await fulfillJson(route, 200, [{ user_id: USER_A.id, display_name: "Alex Owner", role: "owner" }], sid, url, method);
            return;
          }
          if (url.pathname === "/rest/v1/channels" && method === "GET") {
            const firstWs = workspacesForReq[0]?.id ?? WS_1;
            await fulfillJson(
              route,
              200,
              [
                {
                  channel_id: firstWs === WS_2 ? CONV_GEN_2 : CONV_GEN_1,
                  workspace_id: firstWs,
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
              url,
              method,
            );
            return;
          }
          if (url.pathname.startsWith("/rest/v1/")) {
            await fulfillJson(route, 200, [], sid, url, method);
            return;
          }
          if (url.pathname === "/functions/v1/read" && method === "POST") {
            if (reqBody.resource === "conversations") {
              const wsId = String(reqBody.workspace_id ?? WS_1);
              await fulfillJson(
                route,
                200,
                {
                  conversations: [
                    {
                      id: wsId === WS_2 ? CONV_GEN_2 : CONV_GEN_1,
                      slug: "general",
                      kind: "general",
                      visibility: "open",
                      purpose: null,
                      member_count: 1,
                      last_message_at: NOW_ISO,
                      last_message_preview: null,
                      unread_count: 0,
                      archived_at: null,
                    },
                  ],
                },
                sid,
                url,
                method,
              );
              return;
            }
            if (reqBody.resource === "conversation_history") {
              await fulfillJson(route, 200, { signals: [], has_more: false, mentions: [], reactions: [] }, sid, url, method);
              return;
            }
            if (reqBody.resource === "seat_admin_status") {
              await fulfillJson(route, 200, { enabled: false }, sid, url, method);
              return;
            }
            if (reqBody.resource === "pending_access") {
              await fulfillJson(route, 200, { pending: [], agents: [] }, sid, url, method);
              return;
            }
            if (reqBody.resource === "review_checks") {
              await fulfillJson(route, 200, { checks: [] }, sid, url, method);
              return;
            }
            await fulfillJson(route, 200, { grants: [], invitations: [] }, sid, url, method);
            return;
          }
          await fulfillJson(route, 404, { error: "not_found" }, sid, url, method);
        });

        const attachDiagnostics = (label: string, p: Page) => {
          p.on("pageerror", (err) => consoleErrors.push(`${label} pageerror: ${err.message}`));
          p.on("console", (msg) => {
            if (msg.type() === "error") consoleErrors.push(`${label} console.error: ${msg.text()}`);
          });
        };

        const dumpDiagnostics = async (p: Page): Promise<string> => {
          const dom = await p
            .evaluate((key: string) => {
              const dash = document.querySelector<HTMLElement>("live-dashboard");
              const errPanel = document.querySelector<HTMLElement>('[data-panel="workspace-error"]');
              const signedOutPanel = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
              const channelPanel = document.querySelector<HTMLElement>('[data-panel="channel"]');
              const title = document.querySelector<HTMLElement>("#dashboard-workspace-error-title");
              const authErr = document.querySelector<HTMLElement>("[data-auth-error]");
              const retryBtn = document.querySelector<HTMLElement>("[data-retry-workspaces]");
              const w = window as unknown as {
                __csObservedAuthBroadcasts?: Array<{ event: string; userId: string | null; refreshToken: string | null }>;
                __csStateHistory?: string[];
              };
              return {
                state: dash?.dataset.state ?? null,
                errorPanelHidden: errPanel?.hidden ?? null,
                signedOutPanelHidden: signedOutPanel?.hidden ?? null,
                channelPanelHidden: channelPanel?.hidden ?? null,
                errorTitle: title?.textContent ?? null,
                retryVisible: Boolean(retryBtn && !retryBtn.hidden),
                authErrorHidden: authErr?.hidden ?? null,
                authErrorText: authErr?.textContent ?? null,
                hasStoredCredential: Boolean(localStorage.getItem(key)),
                broadcasts: w.__csObservedAuthBroadcasts ?? [],
                stateHistory: w.__csStateHistory ?? [],
                bodyPreview: (document.body?.innerText ?? "").slice(0, 300),
              };
            }, STORAGE_KEY)
            .catch((e: unknown) => `eval-failed: ${e instanceof Error ? e.message : String(e)}`);
          return JSON.stringify(
            {
              scenario: scenario.name,
              step: currentStep,
              counters,
              dom,
              consoleErrors: consoleErrors.slice(-20),
              recentApiLog: apiLog.slice(-25),
            },
            null,
            2,
          );
        };

        const waitFor = async (
          label: string,
          predicate: () => Promise<boolean> | boolean,
          p: Page,
          timeoutMs = 15_000,
        ): Promise<void> => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (await predicate()) return;
            await new Promise((r) => setTimeout(r, 30));
          }
          throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}\nDiagnostics:\n${await dumpDiagnostics(p)}`);
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

        const waitForAppSignedIn = async (p: Page): Promise<void> => {
          await waitFor(
            "/app signed in",
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
            p,
          );
        };

        const signOutFromApp = async (p: Page): Promise<void> => {
          await waitFor(
            "user menu trigger visible",
            () => p.locator("[data-user-menu-trigger]").first().isVisible().catch(() => false),
            p,
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
          await p.click("[data-user-menu] [data-signout]");
        };

        try {
          await body({
            context,
            apiLog,
            consoleErrors,
            counters,
            setStep: (s) => {
              currentStep = `${scenario.name}:${s}`;
            },
            attachDiagnostics,
            dumpDiagnostics,
            waitFor,
            seedStorage,
            waitForAppSignedIn,
            signOutFromApp,
          });
        } finally {
          await context.close().catch(() => undefined);
        }
      };

      // ═══════════════════════════════════════════════════════════════════════
      // Witness (a): Refused local removal + server logout unconfirmed (500),
      // then a REAL same-login SIGNED_IN notification (from visibilitychange).
      // Private view stays closed and retry panel stays intact; retrying after
      // storage recovers finishes signing out cleanly.
      // ═══════════════════════════════════════════════════════════════════════
      {
        const sidA = "sid-c2b-refused-a1";
        await withScenario(
          { name: "c2b-a-refused-removal-same-login-signed-in", activeSessionIds: new Set([sidA]), logoutStatus: 500 },
          async (ctx) => {
            ctx.setStep("seed-and-open");
            await ctx.seedStorage(makeSessionPayload({ sessionId: sidA, refreshToken: "rt-c2b-a1" }));
            const page = await ctx.context.newPage();
            ctx.attachDiagnostics("tabA", page);
            await page.goto(`${origin}/app`);
            await ctx.waitForAppSignedIn(page);

            ctx.setStep("install-removeItem-refusal-and-broadcast-observer");
            await page.evaluate((key: string) => {
              const w = window as unknown as {
                __csNativeRemoveItem?: typeof Storage.prototype.removeItem;
                __csRefuseRemoval?: boolean;
                __csObservedAuthBroadcasts?: Array<{ event: string; userId: string | null; refreshToken: string | null }>;
                __csBroadcastChannel?: BroadcastChannel;
              };
              w.__csNativeRemoveItem = Storage.prototype.removeItem;
              w.__csRefuseRemoval = true;
              w.__csObservedAuthBroadcasts = [];
              w.__csBroadcastChannel = new BroadcastChannel(key);
              w.__csBroadcastChannel.onmessage = (ev: MessageEvent) => {
                const payload = ev.data as { event?: string; session?: { user?: { id?: string }; refresh_token?: string } | null } | null;
                w.__csObservedAuthBroadcasts?.push({
                  event: String(payload?.event ?? ""),
                  userId: payload?.session?.user?.id ?? null,
                  refreshToken: payload?.session?.refresh_token ?? null,
                });
              };
              Storage.prototype.removeItem = function (k: string) {
                if (w.__csRefuseRemoval && k === key) {
                  throw new DOMException("Fixture removal denial", "SecurityError");
                }
                return w.__csNativeRemoveItem!.call(this, k);
              };
            }, STORAGE_KEY);

            ctx.setStep("click-signout-under-refusal");
            await ctx.signOutFromApp(page);

            await ctx.waitFor(
              "retry panel shown after refused local removal",
              () =>
                page.evaluate(() => {
                  const dash = document.querySelector<HTMLElement>("live-dashboard");
                  const title = document.querySelector<HTMLElement>("#dashboard-workspace-error-title");
                  const channel = document.querySelector<HTMLElement>('[data-panel="channel"]');
                  const signedOut = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
                  const retryBtn = document.querySelector<HTMLElement>("[data-retry-workspaces]");
                  return (
                    dash?.dataset.state === "workspace-error" &&
                    title?.textContent === "CommonSwarm could not sign you out on this device." &&
                    Boolean(channel?.hidden) &&
                    Boolean(signedOut?.hidden) &&
                    Boolean(retryBtn && !retryBtn.hidden)
                  );
                }),
              page,
            );

            const logoutEvents = ctx.apiLog.filter((e) => e.path === "/auth/v1/logout");
            assert.equal(logoutEvents.length, 1, `Expected 1 local logout attempt:\n${await ctx.dumpDiagnostics(page)}`);
            assert.equal(logoutEvents[0]!.search, "?scope=local");
            assert.equal(logoutEvents[0]!.status, 500);

            const apiLogIndexBeforeVisibility = ctx.apiLog.length;
            const userChecksBeforeVisibility = ctx.counters.userChecks;
            const logoutsBeforeVisibility = ctx.counters.logouts;

            await page.evaluate(() => {
              const w = window as unknown as {
                __csStateHistory?: string[];
                __csStateObserver?: MutationObserver;
                __csPanelFlicker?: boolean;
                __csPanelObserver?: MutationObserver;
              };
              const dash = document.querySelector<HTMLElement>("live-dashboard");
              const channel = document.querySelector<HTMLElement>('[data-panel="channel"]');
              const signedOut = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
              const errPanel = document.querySelector<HTMLElement>('[data-panel="workspace-error"]');
              w.__csStateHistory = [dash?.dataset.state ?? ""];
              w.__csPanelFlicker = false;
              if (dash) {
                w.__csStateObserver = new MutationObserver(() => {
                  w.__csStateHistory?.push(dash.dataset.state ?? "");
                });
                w.__csStateObserver.observe(dash, { attributes: true, attributeFilter: ["data-state"] });
              }
              w.__csPanelObserver = new MutationObserver(() => {
                if (
                  (channel && !channel.hidden) ||
                  (signedOut && !signedOut.hidden) ||
                  Boolean(errPanel?.hidden)
                ) {
                  w.__csPanelFlicker = true;
                }
              });
              for (const el of [channel, signedOut, errPanel]) {
                if (el) w.__csPanelObserver.observe(el, { attributes: true, attributeFilter: ["hidden"] });
              }
            });

            // Trigger a real same-login SIGNED_IN notification from the pinned GoTrueClient's
            // visibilitychange recovery path (`GoTrueClient.ts:4936`).
            ctx.setStep("dispatch-visibilitychange-same-login-signed-in");
            await page.evaluate(() => {
              window.dispatchEvent(new Event("visibilitychange"));
            });

            await ctx.waitFor(
              "GoTrue emitted same-login SIGNED_IN notification",
              () =>
                page.evaluate(() => {
                  const w = window as unknown as {
                    __csObservedAuthBroadcasts?: Array<{ event: string; userId: string | null; refreshToken: string | null }>;
                  };
                  return Boolean(
                    w.__csObservedAuthBroadcasts?.some(
                      (item) => item.event === "SIGNED_IN" && item.refreshToken === "rt-c2b-a1",
                    ),
                  );
                }),
              page,
            );

            // Allow queued macrotasks/rAFs to settle, then verify the retired login stayed closed.
            await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 150)));

            const afterSameLogin = await page.evaluate((key: string) => {
              const dash = document.querySelector<HTMLElement>("live-dashboard");
              const title = document.querySelector<HTMLElement>("#dashboard-workspace-error-title");
              const channel = document.querySelector<HTMLElement>('[data-panel="channel"]');
              const signedOut = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
              const retryBtn = document.querySelector<HTMLElement>("[data-retry-workspaces]");
              const w = window as unknown as {
                __csObservedAuthBroadcasts?: Array<{ event: string; userId: string | null; refreshToken: string | null }>;
                __csStateHistory?: string[];
                __csPanelFlicker?: boolean;
              };
              return {
                state: dash?.dataset.state ?? "",
                title: title?.textContent ?? "",
                channelHidden: Boolean(channel?.hidden),
                signedOutHidden: Boolean(signedOut?.hidden),
                retryVisible: Boolean(retryBtn && !retryBtn.hidden),
                credentialStillStored: Boolean(localStorage.getItem(key)),
                hadSignedOutBroadcast: Boolean(w.__csObservedAuthBroadcasts?.some((b) => b.event === "SIGNED_OUT")),
                stateHistory: [...(w.__csStateHistory ?? [])],
                panelFlicker: Boolean(w.__csPanelFlicker),
                bodyText: document.body?.innerText ?? "",
              };
            }, STORAGE_KEY);

            assert.equal(afterSameLogin.state, "workspace-error", `Must stay on retry panel:\n${await ctx.dumpDiagnostics(page)}`);
            assert.equal(afterSameLogin.title, "CommonSwarm could not sign you out on this device.");
            assert.equal(afterSameLogin.channelHidden, true, "Private view must stay closed");
            assert.equal(afterSameLogin.signedOutHidden, true, "Must not claim signed-out while credential remains stored");
            assert.equal(afterSameLogin.retryVisible, true, "Try again button must remain visible");
            assert.equal(afterSameLogin.credentialStillStored, true, "Credential still stored during refusal");
            assert.equal(afterSameLogin.hadSignedOutBroadcast, false, "Zero SIGNED_OUT broadcasts during refusal");
            assert.equal(afterSameLogin.panelFlicker, false, "Retry panel must remain unbroken without transient repaint");
            assert.ok(
              afterSameLogin.stateHistory.every((s) => s === "workspace-error"),
              `Same-login SIGNED_IN must never leave workspace-error (history=${JSON.stringify(afterSameLogin.stateHistory)}):\n${await ctx.dumpDiagnostics(page)}`,
            );
            assert.equal(afterSameLogin.bodyText.includes("Alpha Vault"), false, "Nothing of retired login painted");
            assert.equal(ctx.counters.logouts, logoutsBeforeVisibility, "Same-login SIGNED_IN must not trigger extra logouts");
            const afterVisApi = ctx.apiLog.slice(apiLogIndexBeforeVisibility);
            const afterVisUserChecks = afterVisApi.filter((e) => e.path === "/auth/v1/user" && e.method === "GET");
            const afterVisDelta = ctx.counters.userChecks - userChecksBeforeVisibility;
            assert.ok(
              afterVisDelta >= 0 && afterVisDelta <= 2 && afterVisUserChecks.length === afterVisDelta,
              `Same-login SIGNED_IN must not trigger unbounded auth checks (delta=${afterVisDelta}, recorded=${afterVisUserChecks.length}):\n${await ctx.dumpDiagnostics(page)}`,
            );
            assert.equal(
              afterVisApi.some((e) => e.path === "/rest/v1/workspaces" || e.path === "/rest/v1/rpc/home_overview"),
              false,
              `Same-login SIGNED_IN must not reload workspaces for retired login:\n${await ctx.dumpDiagnostics(page)}`,
            );

            // Restore removeItem and click Try again -> completes local sign-out cleanly with unconfirmed-server notice.
            ctx.setStep("allow-removal-and-click-try-again");
            await page.evaluate(() => {
              (window as unknown as { __csRefuseRemoval?: boolean }).__csRefuseRemoval = false;
            });
            await page.click("[data-retry-workspaces]");
            await ctx.waitFor(
              "retry completed local sign-out with unconfirmed-server notice",
              () =>
                page.evaluate((key: string) => {
                  const dash = document.querySelector<HTMLElement>("live-dashboard");
                  const authErr = document.querySelector<HTMLElement>("[data-auth-error]");
                  return (
                    dash?.dataset.state === "signed-out" &&
                    localStorage.getItem(key) === null &&
                    Boolean(authErr && !authErr.hidden) &&
                    authErr?.textContent ===
                      "Signed out on this device. Could not reach the server to confirm remote sign-out."
                  );
                }, STORAGE_KEY),
              page,
            );
            assert.equal(
              ctx.consoleErrors.filter((line) => line.includes("pageerror")).length,
              0,
              `Expected zero pageerrors:\n${await ctx.dumpDiagnostics(page)}`,
            );
          },
        );
      }

      // ═══════════════════════════════════════════════════════════════════════
      // Witness (b) Control: After a refused local removal leaves the retry
      // panel active, a genuinely new login (same user with a NEW session_id)
      // signs in normally, clearing the pending sign-out state.
      // ═══════════════════════════════════════════════════════════════════════
      {
        const sidOld = "sid-c2b-control-old";
        const sidNew = "sid-c2b-control-new";
        await withScenario(
          {
            name: "c2b-b-new-login-after-refused-removal",
            activeSessionIds: new Set([sidOld, sidNew]),
            logoutStatus: 500,
            workspacesForSid: (sid) =>
              sid === sidNew
                ? [{ id: WS_2, name: "Fresh Login Vault" }]
                : [{ id: WS_1, name: "Alpha Vault" }],
          },
          async (ctx) => {
            ctx.setStep("seed-old-login-and-open");
            await ctx.seedStorage(makeSessionPayload({ sessionId: sidOld, refreshToken: "rt-c2b-old" }));
            const page = await ctx.context.newPage();
            ctx.attachDiagnostics("tabA", page);
            await page.goto(`${origin}/app`);
            await ctx.waitForAppSignedIn(page);

            ctx.setStep("refuse-removal-and-click-signout");
            await page.evaluate((key: string) => {
              const w = window as unknown as {
                __csNativeRemoveItem?: typeof Storage.prototype.removeItem;
              };
              w.__csNativeRemoveItem = Storage.prototype.removeItem;
              Storage.prototype.removeItem = function (k: string) {
                if (k === key) throw new DOMException("Fixture removal denial", "SecurityError");
                return w.__csNativeRemoveItem!.call(this, k);
              };
            }, STORAGE_KEY);

            await ctx.signOutFromApp(page);
            await ctx.waitFor(
              "retry panel shown after refused removal",
              () =>
                page.evaluate(() => {
                  const dash = document.querySelector<HTMLElement>("live-dashboard");
                  const title = document.querySelector<HTMLElement>("#dashboard-workspace-error-title");
                  return (
                    dash?.dataset.state === "workspace-error" &&
                    title?.textContent === "CommonSwarm could not sign you out on this device."
                  );
                }),
              page,
            );

            // A genuinely new login (same user, new session_id) lands in storage from a peer tab
            // and triggers GoTrue's visibilitychange SIGNED_IN notification on tabA.
            ctx.setStep("deliver-new-login-from-peer-tab");
            const newPayload = makeSessionPayload({ sessionId: sidNew, refreshToken: "rt-c2b-new" });
            const peer = await ctx.context.newPage();
            await peer.goto(`${origin}/seed`);
            await peer.evaluate(
              ({ key, value }: { key: string; value: string }) => {
                localStorage.setItem(key, value);
              },
              { key: STORAGE_KEY, value: JSON.stringify(newPayload) },
            );
            await peer.close();

            await page.evaluate(() => {
              window.dispatchEvent(new Event("visibilitychange"));
            });

            await ctx.waitFor(
              "genuinely new login signed in normally and opened its workspace",
              () =>
                page.evaluate(() => {
                  const dash = document.querySelector<HTMLElement>("live-dashboard");
                  const errPanel = document.querySelector<HTMLElement>('[data-panel="workspace-error"]');
                  const channel = document.querySelector<HTMLElement>('[data-panel="channel"]');
                  return (
                    dash?.dataset.state === "channel" &&
                    Boolean(errPanel?.hidden) &&
                    Boolean(channel && !channel.hidden) &&
                    (document.body?.innerText ?? "").includes("Fresh Login Vault")
                  );
                }),
              page,
            );

            assert.ok(
              ctx.apiLog.some((e) => e.path === "/auth/v1/user" && e.sid === sidNew && e.status === 200),
              `Expected GET /auth/v1/user verified for new session_id:\n${await ctx.dumpDiagnostics(page)}`,
            );
            assert.equal(
              ctx.consoleErrors.filter((line) => line.includes("pageerror")).length,
              0,
              `Expected zero pageerrors:\n${await ctx.dumpDiagnostics(page)}`,
            );
          },
        );
      }

      // ═══════════════════════════════════════════════════════════════════════
      // Witness (c): Successful local removal with server logout unconfirmed
      // (500): the notice survives the SIGNED_OUT event AND the queued boot(),
      // and clears when the user explicitly switches auth entry.
      // ═══════════════════════════════════════════════════════════════════════
      {
        const sidC = "sid-c2b-unconfirmed-c1";
        const expectedNotice = "Signed out on this device. Could not reach the server to confirm remote sign-out.";
        await withScenario(
          { name: "c2b-c-local-success-server-unconfirmed-notice", activeSessionIds: new Set([sidC]), logoutStatus: 500 },
          async (ctx) => {
            ctx.setStep("seed-and-open");
            await ctx.seedStorage(makeSessionPayload({ sessionId: sidC, refreshToken: "rt-c2b-c1" }));
            const page = await ctx.context.newPage();
            ctx.attachDiagnostics("tabA", page);
            await page.goto(`${origin}/app`);
            await ctx.waitForAppSignedIn(page);

            ctx.setStep("attach-state-and-broadcast-observers");
            await page.evaluate((key: string) => {
              const w = window as unknown as {
                __csObservedAuthBroadcasts?: Array<{ event: string; userId: string | null; refreshToken: string | null }>;
                __csStateHistory?: string[];
                __csBroadcastChannel?: BroadcastChannel;
                __csStateObserver?: MutationObserver;
              };
              w.__csObservedAuthBroadcasts = [];
              w.__csStateHistory = [];
              w.__csBroadcastChannel = new BroadcastChannel(key);
              w.__csBroadcastChannel.onmessage = (ev: MessageEvent) => {
                const payload = ev.data as { event?: string; session?: { user?: { id?: string }; refresh_token?: string } | null } | null;
                w.__csObservedAuthBroadcasts?.push({
                  event: String(payload?.event ?? ""),
                  userId: payload?.session?.user?.id ?? null,
                  refreshToken: payload?.session?.refresh_token ?? null,
                });
              };
              const dash = document.querySelector<HTMLElement>("live-dashboard");
              if (dash) {
                w.__csStateHistory.push(dash.dataset.state ?? "");
                w.__csStateObserver = new MutationObserver(() => {
                  w.__csStateHistory?.push(dash.dataset.state ?? "");
                });
                w.__csStateObserver.observe(dash, { attributes: true, attributeFilter: ["data-state"] });
              }
            }, STORAGE_KEY);

            ctx.setStep("click-signout-with-server-500");
            await ctx.signOutFromApp(page);

            // Wait until SIGNED_OUT broadcast fired AND the queued boot transitioned through loading -> signed-out.
            await ctx.waitFor(
              "SIGNED_OUT broadcast and queued boot settled on signed-out with unconfirmed-server notice",
              () =>
                page.evaluate(
                  ({ key, notice }: { key: string; notice: string }) => {
                    const w = window as unknown as {
                      __csObservedAuthBroadcasts?: Array<{ event: string }>;
                      __csStateHistory?: string[];
                    };
                    const dash = document.querySelector<HTMLElement>("live-dashboard");
                    const signedOut = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
                    const authErr = document.querySelector<HTMLElement>("[data-auth-error]");
                    const history = w.__csStateHistory ?? [];
                    const sawSignedOutEvent = Boolean(w.__csObservedAuthBroadcasts?.some((b) => b.event === "SIGNED_OUT"));
                    const loadingIdx = history.indexOf("loading");
                    const bootSettledToSignedOut = loadingIdx >= 0 && history.slice(loadingIdx + 1).includes("signed-out");
                    return (
                      sawSignedOutEvent &&
                      bootSettledToSignedOut &&
                      dash?.dataset.state === "signed-out" &&
                      Boolean(signedOut && !signedOut.hidden) &&
                      localStorage.getItem(key) === null &&
                      Boolean(authErr && !authErr.hidden) &&
                      authErr?.textContent === notice
                    );
                  },
                  { key: STORAGE_KEY, notice: expectedNotice },
                ),
              page,
            );

            // Give any extra queued task a turn and verify notice is still displayed.
            await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 150)));
            const noticeStillVisible = await page.evaluate((notice: string) => {
              const authErr = document.querySelector<HTMLElement>("[data-auth-error]");
              return Boolean(authErr && !authErr.hidden && authErr.textContent === notice);
            }, expectedNotice);
            assert.equal(noticeStillVisible, true, `Notice must survive SIGNED_OUT boot:\n${await ctx.dumpDiagnostics(page)}`);

            // Explicit auth-entry switch clears the notice.
            ctx.setStep("explicit-switch-clears-notice");
            await page.click("[data-auth-entry-switch]");
            await ctx.waitFor(
              "explicit auth-entry switch cleared the sign-out notice",
              () =>
                page.evaluate(() => {
                  const authErr = document.querySelector<HTMLElement>("[data-auth-error]");
                  return Boolean(authErr?.hidden);
                }),
              page,
            );
            assert.equal(
              ctx.consoleErrors.filter((line) => line.includes("pageerror")).length,
              0,
              `Expected zero pageerrors:\n${await ctx.dumpDiagnostics(page)}`,
            );
          },
        );
      }

      // ═══════════════════════════════════════════════════════════════════════
      // Witness (d) C2b control: After a refused local removal leaves the retry
      // panel active while storage still holds the retired login, delayed
      // UNRELATED cross-tab notifications (an unscoped SIGNED_OUT, and a
      // SIGNED_IN naming a different login NOT in storage) must NOT clear
      // pendingSignOut or paint anything of the retired login; the private view
      // stays closed and the retry panel stays intact.
      // ═══════════════════════════════════════════════════════════════════════
      {
        const sidRetired = "sid-c2b-delayed-retired";
        const sidGhost = "sid-c2b-delayed-ghost";
        await withScenario(
          {
            name: "c2b-d-delayed-unrelated-notifications-keep-retired-closed",
            activeSessionIds: new Set([sidRetired]),
            logoutStatus: 500,
          },
          async (ctx) => {
            ctx.setStep("seed-and-open");
            await ctx.seedStorage(makeSessionPayload({ sessionId: sidRetired, refreshToken: "rt-c2b-d-retired" }));
            const page = await ctx.context.newPage();
            ctx.attachDiagnostics("tabA", page);
            await page.goto(`${origin}/app`);
            await ctx.waitForAppSignedIn(page);

            ctx.setStep("install-removeItem-refusal");
            await page.evaluate((key: string) => {
              const w = window as unknown as {
                __csNativeRemoveItem?: typeof Storage.prototype.removeItem;
                __csRefuseRemoval?: boolean;
              };
              w.__csNativeRemoveItem = Storage.prototype.removeItem;
              w.__csRefuseRemoval = true;
              Storage.prototype.removeItem = function (k: string) {
                if (w.__csRefuseRemoval && k === key) {
                  throw new DOMException("Fixture removal denial", "SecurityError");
                }
                return w.__csNativeRemoveItem!.call(this, k);
              };
            }, STORAGE_KEY);

            ctx.setStep("click-signout-under-refusal");
            await ctx.signOutFromApp(page);

            await ctx.waitFor(
              "retry panel shown after refused local removal",
              () =>
                page.evaluate(() => {
                  const dash = document.querySelector<HTMLElement>("live-dashboard");
                  const title = document.querySelector<HTMLElement>("#dashboard-workspace-error-title");
                  const channel = document.querySelector<HTMLElement>('[data-panel="channel"]');
                  const signedOut = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
                  const retryBtn = document.querySelector<HTMLElement>("[data-retry-workspaces]");
                  return (
                    dash?.dataset.state === "workspace-error" &&
                    title?.textContent === "CommonSwarm could not sign you out on this device." &&
                    Boolean(channel?.hidden) &&
                    Boolean(signedOut?.hidden) &&
                    Boolean(retryBtn && !retryBtn.hidden)
                  );
                }),
              page,
            );

            // Observe every state transition on <live-dashboard> from this point forward.
            await page.evaluate(() => {
              const w = window as unknown as {
                __csStateHistory?: string[];
                __csStateObserver?: MutationObserver;
              };
              const dash = document.querySelector<HTMLElement>("live-dashboard");
              w.__csStateHistory = [dash?.dataset.state ?? ""];
              if (dash) {
                w.__csStateObserver = new MutationObserver(() => {
                  w.__csStateHistory?.push(dash.dataset.state ?? "");
                });
                w.__csStateObserver.observe(dash, { attributes: true, attributeFilter: ["data-state"] });
              }
            });

            const peer = await ctx.context.newPage();
            await peer.goto(`${origin}/seed`);
            try {
              // 1) Delayed unscoped SIGNED_OUT broadcast while storage STILL holds the retired login.
              ctx.setStep("deliver-delayed-unscoped-signed-out");
              const checksBeforeSignedOut = ctx.counters.userChecks;
              await peer.evaluate((key: string) => {
                const bc = new BroadcastChannel(key);
                bc.postMessage({ event: "SIGNED_OUT", session: null });
                bc.close();
              }, STORAGE_KEY);

              await ctx.waitFor(
                "boot revalidated storage after delayed unscoped SIGNED_OUT",
                () => ctx.counters.userChecks > checksBeforeSignedOut,
                page,
              );
              await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 150)));

              const afterDelayedSignedOut = await page.evaluate((key: string) => {
                const dash = document.querySelector<HTMLElement>("live-dashboard");
                const errPanel = document.querySelector<HTMLElement>('[data-panel="workspace-error"]');
                const errSignOutBtn = errPanel?.querySelector<HTMLElement>("[data-signout]");
                const title = document.querySelector<HTMLElement>("#dashboard-workspace-error-title");
                const channel = document.querySelector<HTMLElement>('[data-panel="channel"]');
                const signedOut = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
                const retryBtn = document.querySelector<HTMLElement>("[data-retry-workspaces]");
                const w = window as unknown as { __csStateHistory?: string[] };
                return {
                  state: dash?.dataset.state ?? "",
                  title: title?.textContent ?? "",
                  channelHidden: Boolean(channel?.hidden),
                  signedOutHidden: Boolean(signedOut?.hidden),
                  retryVisible: Boolean(retryBtn && !retryBtn.hidden),
                  errSignOutHidden: Boolean(errSignOutBtn?.hidden),
                  credentialStillStored: Boolean(localStorage.getItem(key)),
                  stateHistory: [...(w.__csStateHistory ?? [])],
                  bodyText: document.body?.innerText ?? "",
                };
              }, STORAGE_KEY);

              assert.equal(afterDelayedSignedOut.state, "workspace-error", `Must stay on retry panel after delayed SIGNED_OUT:\n${await ctx.dumpDiagnostics(page)}`);
              assert.equal(afterDelayedSignedOut.title, "CommonSwarm could not sign you out on this device.");
              assert.equal(afterDelayedSignedOut.channelHidden, true, "Private view must stay closed");
              assert.equal(afterDelayedSignedOut.signedOutHidden, true, "Must not claim signed-out while retired login remains stored");
              assert.equal(afterDelayedSignedOut.retryVisible, true, "Retry button must remain visible");
              assert.equal(afterDelayedSignedOut.errSignOutHidden, true, "Sign-out button inside retry panel must stay hidden");
              assert.equal(afterDelayedSignedOut.credentialStillStored, true, "Retired credential still stored");
              assert.ok(
                afterDelayedSignedOut.stateHistory.every((s) => s === "workspace-error"),
                `Delayed SIGNED_OUT must never leave workspace-error or paint retired login (history=${JSON.stringify(afterDelayedSignedOut.stateHistory)})`,
              );
              assert.equal(afterDelayedSignedOut.bodyText.includes("Alpha Vault"), false, "Nothing of retired login painted");

              // 2) Delayed SIGNED_IN naming a DIFFERENT login NOT in storage while storage STILL holds the retired login.
              ctx.setStep("deliver-delayed-unrelated-signed-in");
              const ghostPayload = makeSessionPayload({ sessionId: sidGhost, refreshToken: "rt-c2b-d-ghost" });
              const checksBeforeGhost = ctx.counters.userChecks;
              await peer.evaluate(
                ({ key, payload }: { key: string; payload: ReturnType<typeof makeSessionPayload> }) => {
                  const bc = new BroadcastChannel(key);
                  bc.postMessage({ event: "SIGNED_IN", session: payload });
                  bc.close();
                },
                { key: STORAGE_KEY, payload: ghostPayload },
              );

              await ctx.waitFor(
                "boot revalidated storage after delayed unrelated SIGNED_IN",
                () => ctx.counters.userChecks > checksBeforeGhost,
                page,
              );
              await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 150)));

              const afterDelayedGhost = await page.evaluate((key: string) => {
                const dash = document.querySelector<HTMLElement>("live-dashboard");
                const errPanel = document.querySelector<HTMLElement>('[data-panel="workspace-error"]');
                const errSignOutBtn = errPanel?.querySelector<HTMLElement>("[data-signout]");
                const title = document.querySelector<HTMLElement>("#dashboard-workspace-error-title");
                const channel = document.querySelector<HTMLElement>('[data-panel="channel"]');
                const signedOut = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
                const retryBtn = document.querySelector<HTMLElement>("[data-retry-workspaces]");
                const w = window as unknown as { __csStateHistory?: string[] };
                return {
                  state: dash?.dataset.state ?? "",
                  title: title?.textContent ?? "",
                  channelHidden: Boolean(channel?.hidden),
                  signedOutHidden: Boolean(signedOut?.hidden),
                  retryVisible: Boolean(retryBtn && !retryBtn.hidden),
                  errSignOutHidden: Boolean(errSignOutBtn?.hidden),
                  credentialStillStored: Boolean(localStorage.getItem(key)),
                  stateHistory: [...(w.__csStateHistory ?? [])],
                  bodyText: document.body?.innerText ?? "",
                };
              }, STORAGE_KEY);

              assert.equal(afterDelayedGhost.state, "workspace-error", `Must stay on retry panel after delayed unrelated SIGNED_IN:\n${await ctx.dumpDiagnostics(page)}`);
              assert.equal(afterDelayedGhost.title, "CommonSwarm could not sign you out on this device.");
              assert.equal(afterDelayedGhost.channelHidden, true, "Private view must stay closed");
              assert.equal(afterDelayedGhost.signedOutHidden, true, "Must not claim signed-out while retired login remains stored");
              assert.equal(afterDelayedGhost.retryVisible, true, "Retry button must remain visible");
              assert.equal(afterDelayedGhost.errSignOutHidden, true, "Sign-out button inside retry panel must stay hidden");
              assert.equal(afterDelayedGhost.credentialStillStored, true, "Retired credential still stored");
              assert.ok(
                afterDelayedGhost.stateHistory.every((s) => s === "workspace-error"),
                `Delayed unrelated SIGNED_IN must never leave workspace-error or paint retired login (history=${JSON.stringify(afterDelayedGhost.stateHistory)})`,
              );
              assert.equal(afterDelayedGhost.bodyText.includes("Alpha Vault"), false, "Nothing of retired login painted");
              assert.equal(
                ctx.apiLog.some((e) => e.path === "/auth/v1/user" && e.sid === sidGhost),
                false,
                "Unstored ghost notification must never be verified as active",
              );
            } finally {
              await peer.close().catch(() => undefined);
            }

            // Allow removal and retry -> finishes signing out cleanly.
            ctx.setStep("allow-removal-and-retry");
            await page.evaluate(() => {
              (window as unknown as { __csRefuseRemoval?: boolean }).__csRefuseRemoval = false;
            });
            await page.click("[data-retry-workspaces]");
            await ctx.waitFor(
              "retry completed local sign-out cleanly",
              () =>
                page.evaluate((key: string) => {
                  const dash = document.querySelector<HTMLElement>("live-dashboard");
                  return dash?.dataset.state === "signed-out" && localStorage.getItem(key) === null;
                }, STORAGE_KEY),
              page,
            );
            assert.equal(
              ctx.consoleErrors.filter((line) => line.includes("pageerror")).length,
              0,
              `Expected zero pageerrors:\n${await ctx.dumpDiagnostics(page)}`,
            );
          },
        );
      }

      // ═══════════════════════════════════════════════════════════════════════
      // Witness (e) C2b control: A late sign-out settlement arriving AFTER a
      // verified successor has been shown changes nothing on screen (no
      // signed-out screen, no retry panel, no notice) and clears nothing
      // belonging to the successor.
      // ═══════════════════════════════════════════════════════════════════════
      {
        const sidOld = "sid-c2b-late-old";
        const sidNew = "sid-c2b-late-new";
        await withScenario(
          {
            name: "c2b-e-late-signout-settlement-after-verified-successor",
            activeSessionIds: new Set([sidOld, sidNew]),
            logoutStatus: 500,
            workspacesForSid: (sid) =>
              sid === sidNew
                ? [{ id: WS_2, name: "Fresh Login Vault" }]
                : [{ id: WS_1, name: "Alpha Vault" }],
          },
          async (ctx) => {
            ctx.setStep("seed-old-login-and-open");
            await ctx.seedStorage(makeSessionPayload({ sessionId: sidOld, refreshToken: "rt-c2b-late-old" }));
            const page = await ctx.context.newPage();
            ctx.attachDiagnostics("tabA", page);
            await page.goto(`${origin}/app`);
            await ctx.waitForAppSignedIn(page);

            ctx.setStep("refuse-removal-and-click-signout");
            await page.evaluate((key: string) => {
              const w = window as unknown as {
                __csNativeRemoveItem?: typeof Storage.prototype.removeItem;
              };
              w.__csNativeRemoveItem = Storage.prototype.removeItem;
              Storage.prototype.removeItem = function (k: string) {
                if (k === key) throw new DOMException("Fixture removal denial", "SecurityError");
                return w.__csNativeRemoveItem!.call(this, k);
              };
            }, STORAGE_KEY);

            await ctx.signOutFromApp(page);
            await ctx.waitFor(
              "retry panel shown after refused removal",
              () =>
                page.evaluate(() => {
                  const dash = document.querySelector<HTMLElement>("live-dashboard");
                  const title = document.querySelector<HTMLElement>("#dashboard-workspace-error-title");
                  return (
                    dash?.dataset.state === "workspace-error" &&
                    title?.textContent === "CommonSwarm could not sign you out on this device."
                  );
                }),
              page,
            );

            // Delay delivery of the NEXT Web Lock promise's return value (after the real lock
            // callback has already finished and released the lock) so the Retry sign-out result
            // settles AFTER the verified successor has been loaded and rendered on screen.
            ctx.setStep("arm-delayed-retry-settlement-and-click-retry");
            await page.evaluate(() => {
              const w = window as unknown as {
                __csHoldNextLockReturn?: boolean;
                __csLateSignOutHeld?: boolean;
                __csReleaseLateSignOut?: () => void;
              };
              const origRequest = navigator.locks.request.bind(navigator.locks);
              w.__csHoldNextLockReturn = true;
              w.__csLateSignOutHeld = false;
              let releaseFn: (() => void) | null = null;
              const gate = new Promise<void>((resolve) => {
                releaseFn = resolve;
              });
              w.__csReleaseLateSignOut = () => {
                releaseFn?.();
              };
              Object.defineProperty(navigator.locks, "request", {
                configurable: true,
                writable: true,
                value(...args: unknown[]): Promise<unknown> {
                  const promise = (origRequest as (...a: unknown[]) => Promise<unknown>)(...args);
                  if (w.__csHoldNextLockReturn) {
                    w.__csHoldNextLockReturn = false;
                    return promise.then(async (value) => {
                      w.__csLateSignOutHeld = true;
                      await gate;
                      return value;
                    });
                  }
                  return promise;
                },
              });
            });

            await page.click("[data-retry-workspaces]");
            await ctx.waitFor(
              "retry sign-out finished under real lock and is held before settling",
              () =>
                page.evaluate(() => Boolean((window as unknown as { __csLateSignOutHeld?: boolean }).__csLateSignOutHeld)),
              page,
            );

            // Now a genuine verified successor arrives in storage and boots normally while the
            // earlier Retry sign-out result is still pending delivery.
            ctx.setStep("deliver-verified-successor");
            const newPayload = makeSessionPayload({ sessionId: sidNew, refreshToken: "rt-c2b-late-new" });
            const peer = await ctx.context.newPage();
            await peer.goto(`${origin}/seed`);
            await peer.evaluate(
              ({ key, value }: { key: string; value: string }) => {
                localStorage.setItem(key, value);
              },
              { key: STORAGE_KEY, value: JSON.stringify(newPayload) },
            );
            await peer.close();

            await page.evaluate(() => {
              window.dispatchEvent(new Event("visibilitychange"));
            });

            await ctx.waitFor(
              "verified successor loaded and rendered",
              () =>
                page.evaluate(() => {
                  const dash = document.querySelector<HTMLElement>("live-dashboard");
                  const channel = document.querySelector<HTMLElement>('[data-panel="channel"]');
                  const errPanel = document.querySelector<HTMLElement>('[data-panel="workspace-error"]');
                  return (
                    dash?.dataset.state === "channel" &&
                    Boolean(channel && !channel.hidden) &&
                    Boolean(errPanel?.hidden) &&
                    (document.body?.innerText ?? "").includes("Fresh Login Vault")
                  );
                }),
              page,
            );

            // Start recording state transitions, panel visibility, and storage removals, then release the late settlement.
            ctx.setStep("release-late-signout-settlement");
            const apiLogIndexBeforeLate = ctx.apiLog.length;
            const userChecksBeforeLate = ctx.counters.userChecks;
            const logoutsBeforeLate = ctx.counters.logouts;
            await page.evaluate((key: string) => {
              const w = window as unknown as {
                __csStateHistory?: string[];
                __csStateObserver?: MutationObserver;
                __csPanelFlicker?: boolean;
                __csPanelObserver?: MutationObserver;
                __csLateStorageRemovalAttempts?: number;
                __csReleaseLateSignOut?: () => void;
              };
              w.__csLateStorageRemovalAttempts = 0;
              const prevRemoveItem = Storage.prototype.removeItem;
              Storage.prototype.removeItem = function (k: string) {
                if (k === key) w.__csLateStorageRemovalAttempts = (w.__csLateStorageRemovalAttempts ?? 0) + 1;
                return prevRemoveItem.call(this, k);
              };
              const prevClear = Storage.prototype.clear;
              Storage.prototype.clear = function () {
                w.__csLateStorageRemovalAttempts = (w.__csLateStorageRemovalAttempts ?? 0) + 1;
                return prevClear.call(this);
              };
              const dash = document.querySelector<HTMLElement>("live-dashboard");
              const channel = document.querySelector<HTMLElement>('[data-panel="channel"]');
              const errPanel = document.querySelector<HTMLElement>('[data-panel="workspace-error"]');
              const signedOut = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
              const authErr = document.querySelector<HTMLElement>("[data-auth-error]");
              w.__csStateHistory = [dash?.dataset.state ?? ""];
              w.__csPanelFlicker = false;
              if (dash) {
                w.__csStateObserver = new MutationObserver(() => {
                  w.__csStateHistory?.push(dash.dataset.state ?? "");
                });
                w.__csStateObserver.observe(dash, { attributes: true, attributeFilter: ["data-state"] });
              }
              w.__csPanelObserver = new MutationObserver(() => {
                if (
                  Boolean(channel?.hidden) ||
                  (errPanel && !errPanel.hidden) ||
                  (signedOut && !signedOut.hidden) ||
                  (authErr && !authErr.hidden)
                ) {
                  w.__csPanelFlicker = true;
                }
              });
              for (const el of [channel, errPanel, signedOut, authErr]) {
                if (el) w.__csPanelObserver.observe(el, { attributes: true, attributeFilter: ["hidden"] });
              }
              w.__csReleaseLateSignOut?.();
            }, STORAGE_KEY);

            await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 150)));

            const afterLate = await page.evaluate((key: string) => {
              const dash = document.querySelector<HTMLElement>("live-dashboard");
              const channel = document.querySelector<HTMLElement>('[data-panel="channel"]');
              const errPanel = document.querySelector<HTMLElement>('[data-panel="workspace-error"]');
              const signedOut = document.querySelector<HTMLElement>('[data-panel="signed-out"]');
              const authErr = document.querySelector<HTMLElement>("[data-auth-error]");
              const storedRaw = localStorage.getItem(key);
              const storedParsed = storedRaw
                ? (JSON.parse(storedRaw) as { refresh_token?: string; access_token?: string })
                : null;
              const storedRt = storedParsed?.refresh_token ?? null;
              let storedSid: string | null = null;
              if (typeof storedParsed?.access_token === "string") {
                const parts = storedParsed.access_token.split(".");
                if (parts.length === 3 && parts[1]) {
                  try {
                    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
                    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
                    const claims = JSON.parse(atob(padded)) as { session_id?: unknown };
                    if (typeof claims.session_id === "string") storedSid = claims.session_id;
                  } catch {
                    storedSid = null;
                  }
                }
              }
              const w = window as unknown as {
                __csStateHistory?: string[];
                __csPanelFlicker?: boolean;
                __csLateStorageRemovalAttempts?: number;
              };
              return {
                state: dash?.dataset.state ?? "",
                channelHidden: Boolean(channel?.hidden),
                errPanelHidden: Boolean(errPanel?.hidden),
                signedOutHidden: Boolean(signedOut?.hidden),
                authErrHidden: Boolean(authErr?.hidden),
                storedRt,
                storedSid,
                storageRemovalAttempts: w.__csLateStorageRemovalAttempts ?? 0,
                stateHistory: [...(w.__csStateHistory ?? [])],
                panelFlicker: Boolean(w.__csPanelFlicker),
                bodyText: document.body?.innerText ?? "",
              };
            }, STORAGE_KEY);

            assert.equal(afterLate.state, "channel", `Late settlement must not leave successor view:\n${await ctx.dumpDiagnostics(page)}`);
            assert.equal(afterLate.channelHidden, false, "Successor channel panel must stay visible");
            assert.equal(afterLate.errPanelHidden, true, "Retry panel must not appear over successor");
            assert.equal(afterLate.signedOutHidden, true, "Signed-out panel must not appear over successor");
            assert.equal(afterLate.authErrHidden, true, "No sign-out notice may appear over successor");
            assert.equal(afterLate.storedRt, "rt-c2b-late-new", "Successor stored credential must remain intact");
            assert.equal(afterLate.storedSid, sidNew, "Successor stored session_id must remain intact");
            assert.equal(afterLate.storageRemovalAttempts, 0, "Late settlement must not attempt any storage removal");
            assert.equal(afterLate.bodyText.includes("Fresh Login Vault"), true, "Successor workspace must remain rendered");
            assert.equal(afterLate.bodyText.includes("Alpha Vault"), false, "Nothing of retired login may be painted");
            assert.equal(afterLate.panelFlicker, false, "Late settlement must not transiently flicker panels or notices");
            assert.ok(
              afterLate.stateHistory.every((s) => s === "channel"),
              `Late sign-out settlement must not flicker or change dashboard state (history=${JSON.stringify(afterLate.stateHistory)})`,
            );
            const lateApiEvents = ctx.apiLog.slice(apiLogIndexBeforeLate);
            const lateUserChecks = lateApiEvents.filter((e) => e.path === "/auth/v1/user" && e.method === "GET");
            const lateUserCheckDelta = ctx.counters.userChecks - userChecksBeforeLate;
            assert.ok(
              lateUserCheckDelta >= 0 && lateUserCheckDelta <= 2 && lateUserChecks.length === lateUserCheckDelta,
              `Late settlement may overlap with at most 2 bounded background successor auth checks (delta=${lateUserCheckDelta}, recorded=${lateUserChecks.length}):\n${await ctx.dumpDiagnostics(page)}`,
            );
            assert.ok(
              lateUserChecks.every((e) => e.sid === sidNew),
              `Every GET /auth/v1/user after late settlement must verify the successor (${sidNew}), got sids=${JSON.stringify(lateUserChecks.map((e) => e.sid))}:\n${await ctx.dumpDiagnostics(page)}`,
            );
            assert.equal(
              lateApiEvents.some((e) => e.sid === sidOld),
              false,
              `No request after late settlement may use the retired login (${sidOld}):\n${await ctx.dumpDiagnostics(page)}`,
            );
            assert.equal(ctx.counters.logouts, logoutsBeforeLate, "Late settlement must not trigger extra logouts");
            assert.equal(
              ctx.consoleErrors.filter((line) => line.includes("pageerror")).length,
              0,
              `Expected zero pageerrors:\n${await ctx.dumpDiagnostics(page)}`,
            );
          },
        );
      }
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);
