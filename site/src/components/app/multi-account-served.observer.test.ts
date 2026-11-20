/**
 * Real served-browser witness for Multi-Account Sign-In (PR #656).
 *
 * Serves the REAL compiled LiveDashboard.astro (/app) and InviteOnramp.astro (/invite)
 * over local HTTP against a local HTTP Mock GoTrue + Mock OAuth Identity Provider,
 * and drives real Playwright Chromium through:
 *  - C6: Served /app provider redirect callback (/auth/v1/authorize -> /mock-idp -> /auth/v1/callback -> /app?code&cs_attempt),
 *        synchronous URL scrub, S256 PKCE exchange, provider_token stripping, and multi-account promotion
 *  - C3 & Designer #1/#2: Add account email-code submitted-address capture while held, Escape focus return,
 *        and synchronous close-button / Escape OAuth retirement
 *  - C1: Real LiveDashboard.astro composer Send handler with file attachment holding file_version_create
 *        across same-workspace A->B and A->B->A (0 stale PUT/commit/post) + unchanged-account control
 *  - C5: Real [data-signout] handler after peer removes A from localStorage without firing storage event
 *        (0 revokes for B, B stays signed in)
 *  - C6 & Designer #4: Served /invite provider redirect callback preserving ?resume=, review fallback to B,
 *        identity-change notice ("You’re now joining as ... Review this invitation again."), and fresh confirmation gate
 *
 * Production MULTI_ACCOUNT_ENABLED remains false in site/src/lib/multi-account.ts;
 * ONLY the ephemeral in-memory esbuild test bundle enables it for this browser run.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { transform } from "@astrojs/compiler-rs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { test as unitTest } from "node:test";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";
import { accountsStorageKey, deploymentOriginHash } from "../../lib/multi-account.js";
import { parseConversationsListOutcome } from "../../lib/conversations.js";
import { memberInviteUrl } from "../../lib/member-invite.js";
import { HOUSEHOLD_JOIN_CONSENT_VERSION } from "../../../../src/protocol/household-invitations.js";

function makeJwt(issuer: string, userId: string, email: string, sid: string): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    iss: `${issuer}/auth/v1`,
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    email,
    session_id: sid,
    iat: now,
    exp: now + 3600,
  })}.sig`;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

/** Compile a real Astro component with MULTI_ACCOUNT_ENABLED=true ONLY in the ephemeral test bundle. */
async function renderServedMultiAccountPage(
  componentUrl: URL,
  deployment: { url: string; anonKey: string },
): Promise<{ markup: string; css: string; js: string }> {
  const component = fileURLToPath(componentUrl);
  const scripts = new Map<string, string[]>();
  const styles: string[] = [];
  styles.push((await build({
    entryPoints: [fileURLToPath(new URL("../../styles/global.css", import.meta.url))],
    bundle: true,
    write: false,
    external: ["/fonts/*"],
  })).outputFiles[0]!.text);

  const compiler: Plugin = {
    name: "multi-account-astro-fixture",
    setup(builder) {
      builder.onLoad({ filter: /\.astro$/ }, async (args) => {
        const compiled = transform(await readFile(args.path, "utf8"), {
          filename: args.path,
          internalURL: "astro/compiler-runtime",
          resultScopedSlot: true,
          resolvePath: (specifier) => specifier,
        });
        assert.deepEqual(compiled.diagnostics.filter((d) => d.severity === "error"), []);
        scripts.set(
          args.path,
          compiled.scripts.map((s) => s.code).filter((code): code is string => typeof code === "string"),
        );
        styles.push(...compiled.css);
        return {
          contents: compiled.code.replace(/import "[^"\n]+\?astro&type=style[^"\n]+";\n/gu, ""),
          loader: "ts",
          resolveDir: dirname(args.path),
        };
      });
      builder.onLoad({ filter: /\.css$/ }, async (args) => {
        styles.push((await build({
          entryPoints: [args.path],
          bundle: true,
          write: false,
          external: ["/fonts/*"],
        })).outputFiles[0]!.text);
        return { contents: "", loader: "js" };
      });
    },
  };

  const envDefine = JSON.stringify({
    PUBLIC_H0_LINK_JOIN: "0",
    PUBLIC_SUPABASE_URL: deployment.url,
    PUBLIC_SUPABASE_ANON_KEY: deployment.anonKey,
  });

  const rendered = await build({
    entryPoints: [component],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [compiler],
    external: ["astro/compiler-runtime"],
    define: { "import.meta.env": envDefine },
  });
  const code = rendered.outputFiles[0]!.text.replaceAll(
    '"astro/compiler-runtime"',
    JSON.stringify(new URL("../../../node_modules/astro/dist/runtime/compiler/index.js", import.meta.url).href),
  );
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const container = await AstroContainer.create({ resolve: async () => "/bundle.js" });
  const markup = await container.renderToString(mod.default);

  const enableFlagPlugin: Plugin = {
    name: "enable-multi-account-flag-in-test-bundle",
    setup(builder) {
      builder.onLoad({ filter: /\/site\/src\/lib\/multi-account\.ts$/ }, async (args) => {
        const src = await readFile(args.path, "utf8");
        assert.ok(src.includes("export const MULTI_ACCOUNT_ENABLED = false;"), "source flag must remain false");
        return {
          contents: src.replace(
            "export const MULTI_ACCOUNT_ENABLED = false;",
            "export const MULTI_ACCOUNT_ENABLED = true;",
          ),
          loader: "ts",
          resolveDir: dirname(args.path),
        };
      });
    },
  };

  const bundledParts: string[] = [];
  for (const [path, contents] of scripts) {
    for (const content of contents) {
      bundledParts.push((await build({
        stdin: { contents: content, loader: "ts", resolveDir: dirname(path) },
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        plugins: [enableFlagPlugin],
        define: { "import.meta.env": envDefine },
      })).outputFiles[0]!.text);
    }
  }

  return {
    markup,
    css: styles.join("\n"),
    js: bundledParts.join("\n"),
  };
}

unitTest("served witness fixture compiles real LiveDashboard and InviteOnramp with Google provider discovery", async () => {
  const srv = createServer((req, res) => {
    if (req.url?.startsWith("/auth/v1/settings")) {
      sendJson(res, 200, { external: { google: true, github: false, email: true } });
      return;
    }
    sendJson(res, 404, {});
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    const addr = srv.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}`;
    const [app, inv] = await Promise.all([
      renderServedMultiAccountPage(new URL("./LiveDashboard.astro", import.meta.url), { url, anonKey: "anon" }),
      renderServedMultiAccountPage(new URL("../invite/InviteOnramp.astro", import.meta.url), { url, anonKey: "anon" }),
    ]);
    assert.ok(app.markup.includes('data-signin-provider="google"'), "/app renders Google provider button");
    assert.ok(inv.markup.includes('data-signin-provider="google"'), "/invite renders Google provider button");
    assert.ok(app.js.includes("MULTI_ACCOUNT_ENABLED = !0") || app.js.includes("MULTI_ACCOUNT_ENABLED = true"));
    assert.ok(inv.js.includes("MULTI_ACCOUNT_ENABLED = !0") || inv.js.includes("MULTI_ACCOUNT_ENABLED = true"));
    const parsedConv = parseConversationsListOutcome(200, {
      conversations: [{
        conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        kind: "public_channel",
        channel_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        slug: "ops",
        description: "Operations channel",
        archived_at: null,
        joined: true,
        generation: 1,
        members: [],
        notify_level: "everything",
        starred: false,
      }],
    });
    assert.equal(parsedConv.status, "ready");
    assert.equal(parsedConv.conversations.length, 1);
    assert.equal(parsedConv.conversations[0]?.joined, true);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test("served /app and /invite browser witness: provider PKCE callback, sync close retirement, real composer A->B->A fence, exact-login sign-out, and /invite fallback confirmation", { timeout: 180_000 }, async () => {
  let appPage!: { markup: string; css: string; js: string };
  let invitePage!: { markup: string; css: string; js: string };

  const userA = {
    id: "11111111-1111-4111-8111-111111111111",
    aud: "authenticated",
    role: "authenticated",
    email: "a@example.test",
    app_metadata: {},
    user_metadata: { full_name: "Alex" },
    created_at: "2026-11-19T00:00:00Z",
  };
  const userB = {
    id: "22222222-2222-4222-8222-222222222222",
    aud: "authenticated",
    role: "authenticated",
    email: "b@example.test",
    app_metadata: {},
    user_metadata: { full_name: "Alex" },
    created_at: "2026-11-19T00:00:00Z",
  };
  const inviterId = "99999999-9999-4999-8999-999999999999";
  const sharedWs = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const opsChannelId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const inviteWs = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const orgId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const anonKey = "synthetic-served-anon-key";

  const liveTokens = new Map<string, typeof userA>();
  const revokedTokens: string[] = [];
  const authStates = new Map<string, { redirectTo: string; challenge: string; user: typeof userA }>();
  const pkceCodes = new Map<string, { challenge: string; user: typeof userA }>();
  const commandsSent: Array<{ kind: string; actor: string; contentRole?: string }> = [];
  let putCount = 0;
  let pkceExchanges = 0;
  let tokenSeq = 0;

  let nextProviderUser: typeof userA = userB;
  let holdOtp = false;
  let releaseOtp: (() => void) | null = null;
  let otpHeldResolve: (() => void) | null = null;
  let otpHeldPromise = new Promise<void>((r) => { otpHeldResolve = r; });

  let holdVerify = false;
  let releaseVerify: (() => void) | null = null;
  let verifyHeldResolve: (() => void) | null = null;
  let verifyHeldPromise = new Promise<void>((r) => { verifyHeldResolve = r; });

  let holdChannelVisibility = false;
  let releaseChannelVisibility: (() => void) | null = null;
  let channelVisibilityHeldResolve: (() => void) | null = null;
  let channelVisibilityHeldPromise = new Promise<void>((r) => { channelVisibilityHeldResolve = r; });

  let holdFileCreate = false;
  let releaseFileCreate: (() => void) | null = null;
  let fileCreateHeldResolve: (() => void) | null = null;
  let fileCreateHeldPromise = new Promise<void>((r) => { fileCreateHeldResolve = r; });

  const resetFileCreateGate = (hold: boolean): void => {
    holdFileCreate = hold;
    releaseFileCreate = null;
    fileCreateHeldPromise = new Promise<void>((r) => { fileCreateHeldResolve = r; });
  };
  const resetOtpGate = (hold: boolean): void => {
    holdOtp = hold;
    releaseOtp = null;
    otpHeldPromise = new Promise<void>((r) => { otpHeldResolve = r; });
  };
  const resetVerifyGate = (hold: boolean): void => {
    holdVerify = hold;
    releaseVerify = null;
    verifyHeldPromise = new Promise<void>((r) => { verifyHeldResolve = r; });
  };
  const resetChannelVisibilityGate = (hold: boolean): void => {
    holdChannelVisibility = hold;
    releaseChannelVisibility = null;
    channelVisibilityHeldPromise = new Promise<void>((r) => { channelVisibilityHeldResolve = r; });
  };

  let origin = "";
  const issueSession = (who: typeof userA, includeProviderTokens = false) => {
    tokenSeq += 1;
    const at = makeJwt(origin, who.id, who.email, `sid-${who.id.slice(0, 4)}-${tokenSeq}`);
    liveTokens.set(at, who);
    return {
      access_token: at,
      refresh_token: `rt-${tokenSeq}`,
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user: who,
      ...(includeProviderTokens
        ? {
            provider_token: "secret-provider-tok-must-strip",
            provider_refresh_token: "secret-provider-refresh-must-strip",
          }
        : {}),
    };
  };

  const renderHtml = (page: { markup: string; css: string }, scriptPath: string): string =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="commonswarm:url" content="${origin}"><meta name="commonswarm:anon-key" content="${anonKey}">` +
    `<style>${page.css}</style></head><body>${page.markup}<script type="module" src="${scriptPath}"></script></body></html>`;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
      const method = req.method ?? "GET";

      if (url.pathname === "/app" && method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderHtml(appPage, "/app.js"));
        return;
      }
      if (url.pathname === "/app.js" && method === "GET") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(appPage.js);
        return;
      }
      if (url.pathname === "/invite" && method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(renderHtml(invitePage, "/invite.js"));
        return;
      }
      if (url.pathname === "/invite.js" && method === "GET") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(invitePage.js);
        return;
      }

      // Real HTTP GoTrue + Mock OAuth Identity Provider endpoints:
      if (url.pathname === "/auth/v1/settings" && method === "GET") {
        sendJson(res, 200, { external: { google: true, github: false, email: true } });
        return;
      }
      if (url.pathname === "/auth/v1/authorize" && method === "GET") {
        const provider = url.searchParams.get("provider");
        const redirectTo = url.searchParams.get("redirect_to") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const codeMethod = url.searchParams.get("code_challenge_method") ?? "";
        if (provider !== "google" || !redirectTo || !challenge || codeMethod.toLowerCase() !== "s256") {
          sendJson(res, 400, { error: "invalid_authorize_request" });
          return;
        }
        const state = `st_${randomUUID().slice(0, 8)}`;
        authStates.set(state, { redirectTo, challenge, user: nextProviderUser });
        res.writeHead(302, { location: `${origin}/mock-idp/authorize?state=${encodeURIComponent(state)}` });
        res.end();
        return;
      }
      if (url.pathname === "/mock-idp/authorize" && method === "GET") {
        const state = url.searchParams.get("state") ?? "";
        res.writeHead(302, { location: `${origin}/auth/v1/callback?state=${encodeURIComponent(state)}&idp_ok=1` });
        res.end();
        return;
      }
      if (url.pathname === "/auth/v1/callback" && method === "GET") {
        const state = url.searchParams.get("state") ?? "";
        const saved = authStates.get(state);
        authStates.delete(state);
        if (!saved) {
          sendJson(res, 400, { error: "unknown_state" });
          return;
        }
        const code = `pkce_${randomUUID().slice(0, 12)}`;
        pkceCodes.set(code, { challenge: saved.challenge, user: saved.user });
        const dest = new URL(saved.redirectTo);
        dest.searchParams.set("code", code);
        res.writeHead(302, { location: dest.href });
        res.end();
        return;
      }
      if (url.pathname === "/auth/v1/token" && method === "POST") {
        const grantType = url.searchParams.get("grant_type") ?? "";
        const body = await readJsonBody(req);
        if (grantType === "password") {
          const email = String(body.email ?? "").toLowerCase();
          const who = email === userB.email ? userB : userA;
          sendJson(res, 200, issueSession(who, false));
          return;
        }
        if (grantType === "pkce") {
          const code = String(body.auth_code ?? "");
          const verifier = String(body.code_verifier ?? "");
          const entry = pkceCodes.get(code);
          pkceCodes.delete(code);
          const computed = createHash("sha256").update(verifier).digest("base64url");
          if (!entry || computed !== entry.challenge) {
            sendJson(res, 400, { error: "invalid_grant", error_description: "invalid PKCE code or verifier" });
            return;
          }
          pkceExchanges += 1;
          sendJson(res, 200, issueSession(entry.user, true));
          return;
        }
        sendJson(res, 400, { error: "unsupported_grant_type" });
        return;
      }
      if (url.pathname === "/auth/v1/otp" && method === "POST") {
        await readJsonBody(req);
        if (holdOtp) {
          otpHeldResolve?.();
          await new Promise<void>((resolve) => { releaseOtp = resolve; });
        }
        sendJson(res, 200, {});
        return;
      }
      if (url.pathname === "/auth/v1/verify" && method === "POST") {
        await readJsonBody(req);
        if (holdVerify) {
          verifyHeldResolve?.();
          await new Promise<void>((resolve) => { releaseVerify = resolve; });
        }
        sendJson(res, 400, { error_code: "otp_expired", msg: "Token has expired or is invalid" });
        return;
      }
      if (url.pathname === "/auth/v1/user" && method === "GET") {
        const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /i, "");
        const who = liveTokens.get(bearer);
        if (!who) {
          sendJson(res, 403, { error_code: "session_not_found", msg: "Session not found" });
          return;
        }
        sendJson(res, 200, who);
        return;
      }
      if (url.pathname === "/auth/v1/logout" && method === "POST") {
        const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /i, "");
        if (bearer) {
          revokedTokens.push(bearer);
          liveTokens.delete(bearer);
        }
        res.writeHead(204);
        res.end();
        return;
      }

      // Workspace, Feed, Command, Storage & Invite API endpoints:
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /i, "");
      const actor = liveTokens.get(bearer) ?? null;

      if (url.pathname === "/rest/v1/workspaces" && method === "GET") {
        sendJson(res, 200, [{ workspace_id: sharedWs, org_id: orgId, name: "Shared Home", archived_at: null }]);
        return;
      }
      if (url.pathname === "/rest/v1/member_profiles" && method === "GET") {
        sendJson(res, 200, [
          { user_id: userA.id, display_name: "Alex", role: "owner" },
          { user_id: userB.id, display_name: "Alex", role: "member" },
        ]);
        return;
      }
      if (url.pathname === "/rest/v1/channels" && method === "GET") {
        if (holdChannelVisibility && url.searchParams.get("channel_id") === `eq.${opsChannelId}`) {
          channelVisibilityHeldResolve?.();
          await new Promise<void>((resolve) => { releaseChannelVisibility = resolve; });
        }
        sendJson(res, 200, [{
          channel_id: opsChannelId,
          workspace_id: sharedWs,
          slug: "ops",
          purpose: "Operations channel",
          visibility: "open",
          created_by_principal: userA.id,
          created_by_kind: "user",
          created_at: "2026-11-19T00:00:00Z",
          archived_at: null,
        }]);
        return;
      }
      if (url.pathname === "/rest/v1/channel_members" && method === "GET") {
        sendJson(res, 200, [
          { workspace_id: sharedWs, channel_id: opsChannelId, kind: "user", id: userA.id, is_manager: true },
          { workspace_id: sharedWs, channel_id: opsChannelId, kind: "user", id: userB.id, is_manager: false },
        ]);
        return;
      }
      if (url.pathname === "/rest/v1/rpc/home_overview" && method === "POST") {
        const viewer = actor ?? userA;
        const asks = viewer.id === userA.id
          ? [
              { signal_id: "10000000-0000-4000-8000-000000000001", from: { kind: "user", id: userB.id, name: "Alex" }, created_at: "2026-11-19T00:00:00Z", until: "2026-11-20T00:00:00Z" },
              { signal_id: "10000000-0000-4000-8000-000000000002", from: { kind: "user", id: userB.id, name: "Alex" }, created_at: "2026-11-19T00:01:00Z", until: "2026-11-20T00:00:00Z" },
              { signal_id: "10000000-0000-4000-8000-000000000003", from: { kind: "user", id: userB.id, name: "Alex" }, created_at: "2026-11-19T00:02:00Z", until: "2026-11-20T00:00:00Z" },
            ]
          : [];
        sendJson(res, 200, {
          viewer_user_id: viewer.id,
          generated_at: "2026-11-19T00:00:00Z",
          workspaces: [{
            workspace_id: sharedWs,
            name: "Shared Home",
            role: "owner",
            last_seen_at: "2026-11-19T00:00:00Z",
            new_messages: 0,
            content: null,
            people: [{ user_id: viewer.id, display_name: "Alex", role: "owner", is_viewer: true, agents: [] }],
            needs_you: { asks, assigned: [], waiting: [] },
          }],
        });
        return;
      }
      if (url.pathname === "/rest/v1/rpc/channel_unread" && method === "POST") {
        sendJson(res, 200, { workspace_id: sharedWs, generated_at: "2026-11-19T00:00:00Z", channels: [] });
        return;
      }
      if (url.pathname === "/rest/v1/rpc/decision_queue" && method === "POST") {
        sendJson(res, 200, { workspace_id: sharedWs, generated_at: "2026-11-19T00:00:00Z", total: 0, truncated: false, asks: [] });
        return;
      }
      if (url.pathname.startsWith("/rest/v1/")) {
        sendJson(res, 200, []);
        return;
      }
      if (url.pathname === "/functions/v1/read" && method === "POST") {
        const body = await readJsonBody(req);
        if (body.resource === "seat_admin_status") {
          sendJson(res, 200, { enabled: false });
          return;
        }
        if (body.resource === "pending_access") {
          sendJson(res, 200, { pending: [], agents: [] });
          return;
        }
        if (body.resource === "conversations") {
          sendJson(res, 200, {
            conversations: [{
              conversation_id: opsChannelId,
              kind: "public_channel",
              channel_id: opsChannelId,
              slug: "ops",
              description: "Operations channel",
              archived_at: null,
              joined: true,
              generation: 1,
              members: [
                { kind: "user", id: userA.id, joined_at: "2026-11-19T00:00:00Z", left_at: null },
                { kind: "user", id: userB.id, joined_at: "2026-11-19T00:00:00Z", left_at: null },
              ],
              notify_level: "everything",
              starred: false,
            }],
          });
          return;
        }
        sendJson(res, 200, { grants: [], invitations: [] });
        return;
      }
      if (url.pathname === "/functions/v1/command" && method === "POST") {
        const body = await readJsonBody(req);
        const cmd = (body.command ?? {}) as Record<string, unknown>;
        const kind = String(cmd.kind ?? "");
        const actorId = actor?.id ?? "unknown";
        commandsSent.push({
          kind: kind === "household_invitation" ? `household_invitation:${String(cmd.action ?? "")}` : kind,
          actor: actorId,
          ...(typeof cmd.content_role === "string" ? { contentRole: cmd.content_role } : {}),
        });
        if (kind === "file_version_create") {
          if (holdFileCreate) {
            fileCreateHeldResolve?.();
            await new Promise<void>((resolve) => { releaseFileCreate = resolve; });
          }
          sendJson(res, 200, {
            status: "accepted",
            file_id: String(cmd.file_id ?? "f-1"),
            version_id: String(cmd.version_id ?? "v-1"),
            version_n: 1,
            upload_path: "/storage/v1/object/upload/sign/attachments/f-1?token=up-served",
          });
          return;
        }
        if (kind === "file_version_commit") {
          sendJson(res, 200, {
            status: "accepted",
            file_id: String(cmd.file_id ?? "f-1"),
            version_id: String(cmd.version_id ?? "v-1"),
            version_n: 1,
          });
          return;
        }
        if (kind === "post_signal") {
          sendJson(res, 200, {
            status: "accepted",
            signal: {
              id: `sig-${randomUUID().slice(0, 8)}`,
              workspace_id: sharedWs,
              kind: "message",
              from_kind: "user",
              from_id: actorId,
              body: String(cmd.body ?? ""),
              created_at: new Date().toISOString(),
            },
          });
          return;
        }
        if (kind === "household_invitation" && cmd.action === "preview") {
          sendJson(res, 200, {
            status: "preview",
            workspace_id: inviteWs,
            workspace_name: "Family Cabin",
            invitation_id: "inv-served-1",
            audience: [{ display_name: "Host", role: "owner" }],
            disclosure: "Messages and shared lists in Family Cabin.",
            expires_at: Date.now() + 86_400_000,
            preview_digest: createHash("sha256").update(`served-preview:${actorId}`).digest("hex"),
            consent_version: HOUSEHOLD_JOIN_CONSENT_VERSION,
          });
          return;
        }
        if (kind === "household_invitation" && cmd.action === "accept") {
          sendJson(res, 200, {
            status: "joined",
            workspace_id: inviteWs,
            workspace_name: "Family Cabin",
            content_role: String(cmd.content_role ?? "editor"),
            agents_provisioned_by_join: false,
          });
          return;
        }
        if (kind === "signals_seen") {
          sendJson(res, 200, { status: "accepted" });
          return;
        }
        sendJson(res, 200, { status: "accepted" });
        return;
      }
      if (url.pathname.startsWith("/storage/v1/") && method === "PUT") {
        // Consume body
        await new Promise<void>((resolve) => {
          req.on("data", () => undefined);
          req.on("end", resolve);
        });
        putCount += 1;
        res.writeHead(200);
        res.end();
        return;
      }
      sendJson(res, 404, { error: "not_found", path: url.pathname });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${addr.port}`;
  const originHash = deploymentOriginHash(origin);

  [appPage, invitePage] = await Promise.all([
    renderServedMultiAccountPage(new URL("./LiveDashboard.astro", import.meta.url), { url: origin, anonKey }),
    renderServedMultiAccountPage(new URL("../invite/InviteOnramp.astro", import.meta.url), { url: origin, anonKey }),
  ]);
  assert.ok(appPage.markup.includes('data-signin-provider="google"'), "/app must render real Google provider button");
  assert.ok(invitePage.markup.includes('data-signin-provider="google"'), "/invite must render real Google provider button");

  const { chromium } = await import("playwright-core");
  const browser = await launchPlaywrightChromium(chromium);
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    const waitForAppReady = async (
      p: Awaited<ReturnType<typeof context.newPage>>,
      expectedEmail?: string,
    ): Promise<void> => {
      await p.waitForSelector('[data-panel="channel"]:not([hidden])', { timeout: 15_000 });
      await p.waitForSelector("[data-kylon-live-layout]", { timeout: 15_000 });
      await p.waitForSelector("[data-user-menu-trigger]:visible", { timeout: 15_000 });
      if (expectedEmail) {
        await p.waitForFunction(
          (want: string) => (document.querySelector<HTMLElement>("[data-rail-account-email]")?.textContent ?? "").trim() === want,
          expectedEmail,
          { timeout: 15_000 },
        );
      }
    };
    const openAccountMenu = async (p: Awaited<ReturnType<typeof context.newPage>>): Promise<void> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const isOpen = await p.evaluate(() => {
          const menu = document.querySelector<HTMLElement>("[data-user-menu]");
          return Boolean(menu && !menu.hidden);
        });
        if (!isOpen) {
          await p.click("[data-user-menu-trigger]");
        }
        try {
          await p.waitForSelector("[data-user-menu]:not([hidden])", { timeout: 2_000 });
          return;
        } catch {
          // Retry if a concurrent layout.sync() closed overlays during initial mount.
        }
      }
      await p.waitForSelector("[data-user-menu]:not([hidden])", { timeout: 5_000 });
    };
    const clickAccountMenuItem = async (
      p: Awaited<ReturnType<typeof context.newPage>>,
      selector: string,
    ): Promise<void> => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          await openAccountMenu(p);
          await p.waitForSelector(`${selector}:visible`, { timeout: 3_000 });
          await p.click(selector, { timeout: 3_000 });
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(`Could not click account menu item ${selector}`);
    };

    const waitForServerCondition = async (
      predicate: () => boolean,
      label: string,
      timeoutMs = 15_000,
    ): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await page.waitForTimeout(25);
      }
      const feedback = await page.evaluate(
        () => (document.querySelector<HTMLElement>("[data-composer-feedback]")?.textContent ?? "").trim(),
      ).catch(() => "");
      throw new Error(
        `Timed out waiting for ${label}; composerFeedback=${JSON.stringify(feedback)}, putCount=${putCount}, commands=${JSON.stringify(commandsSent)}`,
      );
    };

    // ── FLOW 1 (C6 + Designer): Served /app sign-in A -> Add account Google PKCE redirect -> B promoted ──
    await page.goto(`${origin}/app`);
    await page.waitForSelector('[data-panel="signed-out"]:not([hidden])');
    await page.fill("#dashboard-email", userA.email);
    await page.fill("#dashboard-password", "pw-a");
    await page.click("[data-password-signin]");
    await waitForAppReady(page, userA.email);

    // Open desktop account menu -> Add account -> Google provider redirect through mock IdP & callback!
    await clickAccountMenuItem(page, "[data-add-account-open]");
    await page.waitForSelector("[data-add-account-dialog][open]");
    nextProviderUser = userB;
    const pkceBeforeApp = pkceExchanges;
    await page.click('[data-add-account-dialog] [data-signin-provider="google"]');
    await page.waitForFunction(
      ({ regKey, uidB }: { regKey: string; uidB: string }) =>
        (localStorage.getItem(regKey) ?? "").includes(uidB) &&
        location.pathname === "/app" &&
        !location.search.includes("code=") &&
        !location.search.includes("cs_attempt=") &&
        location.hash === "",
      { regKey: accountsStorageKey(originHash), uidB: userB.id },
      { timeout: 15_000 },
    );
    await waitForAppReady(page, userB.email);
    assert.equal(pkceExchanges, pkceBeforeApp + 1, "served /app must complete real HTTP S256 PKCE provider exchange");

    // Verify callback params scrubbed, 2 accounts owned, provider tokens stripped from storage!
    const afterProvider = await page.evaluate((regKey: string) => {
      const reg = localStorage.getItem(regKey) ?? "";
      const allValues: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i)!;
        allValues.push(localStorage.getItem(k) ?? "");
      }
      return {
        href: location.href,
        reg,
        leakedProvider: allValues.some((v) => v.includes("secret-provider-tok") || v.includes("secret-provider-refresh")),
      };
    }, accountsStorageKey(originHash));
    const afterProviderUrl = new URL(afterProvider.href);
    for (const forbidden of ["code", "cs_attempt", "state", "access_token", "refresh_token", "provider_token", "token_hash"]) {
      assert.equal(afterProviderUrl.searchParams.has(forbidden), false, `callback param ${forbidden} must be scrubbed on served /app`);
    }
    assert.equal(afterProviderUrl.hash, "", "callback hash must be empty on served /app");
    assert.equal(afterProvider.leakedProvider, false, "provider_token & provider_refresh_token must be stripped");
    assert.ok(afterProvider.reg.includes(userA.id) && afterProvider.reg.includes(userB.id), "both A and B owned");

    // Verify Designer #3 cues: Current label, "3 waiting" for inactive Account A, full emails readable, active sub-label on sign-out items!
    await openAccountMenu(page);
    await page.waitForSelector("[data-account-switcher]:visible");
    await page.waitForFunction(
      () => (document.querySelector<HTMLElement>("[data-user-menu]")?.innerText ?? "").includes("3 waiting"),
      null,
      { timeout: 10_000 },
    );
    const menuText = await page.locator("[data-user-menu]").innerText();
    assert.ok(menuText.includes("Current"), "active account must show visible Current label");
    assert.ok(menuText.includes("3 waiting"), "inactive account with 3 open asks must show 3 waiting");
    assert.ok(menuText.includes(userA.email) && menuText.includes(userB.email), "both full emails readable");
    assert.ok(menuText.includes("Sign out on this device"), "multi-account sign-out label shown");

    // ── FLOW 2 (C3 + Designer #1/#2): Submitted email captured while held + Escape focus return ──
    await clickAccountMenuItem(page, "[data-add-account-open]");
    await page.waitForSelector("[data-add-account-dialog][open]");
    resetOtpGate(true);
    await page.fill("#add-account-email", "submitted@example.test");
    await page.click("[data-add-account-email-code]");
    await otpHeldPromise;
    // Edit email field WHILE OTP send is still in flight!
    await page.fill("#add-account-email", "edited-later@example.test");
    (releaseOtp as (() => void) | null)?.();
    await page.waitForSelector("[data-add-account-code-step]:not([hidden])");
    const displayedEmail = (await page.locator("[data-add-account-code-email]").innerText()).trim();
    assert.equal(displayedEmail, "submitted@example.test", "code step must name submitted email, never post-submit edit");

    // C3 held resend across Change email: click Resend (held), click Change email, release -> MUST stay on Step 1 & cancel late attempt!
    resetOtpGate(true);
    await page.click("[data-add-account-otp-resend]");
    await otpHeldPromise;
    await page.click("[data-add-account-otp-change]");
    await page.waitForSelector("[data-add-account-entry]:not([hidden])");
    (releaseOtp as (() => void) | null)?.();
    await page.waitForTimeout(80);
    const afterHeldResendChange = await page.evaluate(() => ({
      entryVisible: !(document.querySelector<HTMLElement>("[data-add-account-entry]")?.hidden ?? true),
      codeHidden: document.querySelector<HTMLElement>("[data-add-account-code-step]")?.hidden ?? false,
      attemptKeys: Object.keys(sessionStorage).filter((k) => k.includes(":attempt:")),
    }));
    assert.equal(afterHeldResendChange.entryVisible, true, "late resend must NOT reopen code step after Change email");
    assert.equal(afterHeldResendChange.codeHidden, true, "code step must stay hidden after Change email");
    assert.equal(afterHeldResendChange.attemptKeys.length, 0, "late resend attempt must be cancelled after Change email");

    // C3 held verify refusal across Change email: send code -> submit verify (held refusal) -> click Change email -> release -> MUST NOT repaint error!
    resetOtpGate(false);
    await page.fill("#add-account-email", "verify@example.test");
    await page.click("[data-add-account-email-code]");
    await page.waitForSelector("[data-add-account-code-step]:not([hidden])");
    resetVerifyGate(true);
    await page.fill("#add-account-otp", "000000");
    await page.click("[data-add-account-otp-verify]");
    await verifyHeldPromise;
    await page.click("[data-add-account-otp-change]");
    await page.waitForSelector("[data-add-account-entry]:not([hidden])");
    (releaseVerify as (() => void) | null)?.();
    await page.waitForTimeout(80);
    const afterHeldVerifyChange = await page.evaluate(() => ({
      entryVisible: !(document.querySelector<HTMLElement>("[data-add-account-entry]")?.hidden ?? true),
      codeStatus: (document.querySelector<HTMLElement>("[data-add-account-code-status]")?.textContent ?? "").trim(),
    }));
    assert.equal(afterHeldVerifyChange.entryVisible, true, "held verify refusal must stay on Step 1 after Change email");
    assert.equal(afterHeldVerifyChange.codeStatus, "", "held verify refusal must NOT repaint stale error after Change email");

    // Press Escape -> dialog closes, focus returns to desktop account trigger, staging attempt cleared!
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("[data-add-account-dialog]")?.open);
    const afterEscape = await page.evaluate(() => ({
      activeIsTrigger: document.activeElement?.hasAttribute("data-user-menu-trigger") ?? false,
      attemptKeys: Object.keys(sessionStorage).filter((k) => k.includes(":attempt:")),
    }));
    assert.equal(afterEscape.activeIsTrigger, true, "Escape from Add account must return focus to desktop account trigger");
    assert.equal(afterEscape.attemptKeys.length, 0, "Escape must retire staging attempt cleanly");

    // ── FLOW 2b (Designer 245c13fc/94b7ba0c keyboard focus): 1280px Enter switch + 360px phone Escape & Enter switch ──
    // Desktop 1280px: from workspace chat, switch accounts with Enter -> focus MUST return to [data-user-menu-trigger] (not body/composer)!
    await page.goto(`${origin}/app?w=${sharedWs}`);
    await waitForAppReady(page, userB.email);
    await page.waitForSelector("[data-composer]:not([hidden])");
    await openAccountMenu(page);
    await page.waitForSelector(`[data-account-switch="${userA.id}"]:visible`);
    await page.waitForTimeout(50);
    await page.focus(`[data-account-switch="${userA.id}"]`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (emailA: string) =>
        (document.querySelector<HTMLElement>("[data-rail-account-email]")?.textContent ?? "").trim() === emailA &&
        Boolean(document.activeElement?.hasAttribute("data-user-menu-trigger")),
      userA.email,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(250);
    const desktopAfterSwitch = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? "",
      isDesktopTrigger: document.activeElement?.hasAttribute("data-user-menu-trigger") ?? false,
      liveAnnouncement: (document.querySelector<HTMLElement>("[data-account-live]")?.textContent ?? "").trim(),
    }));
    assert.ok(desktopAfterSwitch.liveAnnouncement.includes(userA.email), "account switch must announce the target account");
    assert.equal(
      desktopAfterSwitch.isDesktopTrigger,
      true,
      `1280px Enter switch from workspace chat must retain focus on desktop account trigger (got ${desktopAfterSwitch.tag})`,
    );

    // Phone 360px: Escape from Add account and Sign out all MUST return focus to More button (not account tile),
    // and Enter switch from workspace chat MUST restore focus to Open navigation (not body)!
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForSelector('button[aria-label="Open navigation"]:visible', { timeout: 10_000 });
    await page.click('button[aria-label="Open navigation"]');
    await page.waitForSelector(".cs-kylon-workspace-menu .hm-menu__trigger:visible", { timeout: 10_000 });
    await page.click(".cs-kylon-workspace-menu .hm-menu__trigger");
    await page.waitForSelector("[data-menu-add-account]:visible");
    await page.click("[data-menu-add-account]");
    await page.waitForSelector("[data-add-account-dialog][open]");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("[data-add-account-dialog]")?.open);
    const phoneAfterAddEscape = await page.evaluate(() => ({
      isMoreTrigger: document.activeElement?.matches(".cs-kylon-workspace-menu .hm-menu__trigger") ?? false,
      isAccountTile: document.activeElement?.hasAttribute("data-user-menu-trigger") ?? false,
      activeLabel: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? "",
    }));
    assert.equal(
      phoneAfterAddEscape.isMoreTrigger,
      true,
      `360px Escape from Add account must return focus to More button (got ${phoneAfterAddEscape.activeLabel})`,
    );
    assert.equal(phoneAfterAddEscape.isAccountTile, false, "360px Escape from Add account must NOT focus the account tile");

    await page.click(".cs-kylon-workspace-menu .hm-menu__trigger");
    await page.waitForSelector("[data-menu-sign-out-all]:visible");
    await page.click("[data-menu-sign-out-all]");
    await page.waitForSelector("[data-signout-all-dialog][open]");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector<HTMLDialogElement>("[data-signout-all-dialog]")?.open);
    const phoneAfterSignOutAllEscape = await page.evaluate(() => ({
      isMoreTrigger: document.activeElement?.matches(".cs-kylon-workspace-menu .hm-menu__trigger") ?? false,
      isAccountTile: document.activeElement?.hasAttribute("data-user-menu-trigger") ?? false,
      activeLabel: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? "",
    }));
    assert.equal(
      phoneAfterSignOutAllEscape.isMoreTrigger,
      true,
      `360px Escape from Sign out all must return focus to More button (got ${phoneAfterSignOutAllEscape.activeLabel})`,
    );
    assert.equal(phoneAfterSignOutAllEscape.isAccountTile, false, "360px Escape from Sign out all must NOT focus the account tile");

    await page.click(".cs-kylon-workspace-menu .hm-menu__trigger");
    await page.waitForSelector(`[data-menu-account-switch="${userB.id}"]:visible`);
    await page.waitForTimeout(50);
    await page.focus(`[data-menu-account-switch="${userB.id}"]`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (emailB: string) =>
        (document.querySelector<HTMLElement>("[data-rail-account-email]")?.textContent ?? "").trim() === emailB &&
        Boolean(document.activeElement?.matches('button[aria-label="Open navigation"]')),
      userB.email,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(250);
    const phoneAfterSwitch = await page.evaluate(() => ({
      isOpenNav: document.activeElement?.matches('button[aria-label="Open navigation"]') ?? false,
      activeLabel: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName ?? "",
    }));
    assert.equal(
      phoneAfterSwitch.isOpenNav,
      true,
      `360px Enter switch from workspace chat must restore focus to Open navigation (got ${phoneAfterSwitch.activeLabel})`,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await waitForAppReady(page, userB.email);

    // ── FLOW 3 (C1): Real LiveDashboard.astro composer Send handler across same-workspace A->B & A->B->A ──
    // Case 3a0: Hold named-channel #ops ("open") visibility read across same-workspace A -> B -> 0 file_version_create, 0 PUT, 0 commit, 0 post!
    await clickAccountMenuItem(page, `[data-account-switch="${userA.id}"]`);
    await waitForAppReady(page, userA.email);
    await page.goto(`${origin}/app?w=${sharedWs}&c=${opsChannelId}`);
    await waitForAppReady(page, userA.email);
    await page.waitForSelector("[data-composer]:not([hidden])");
    commandsSent.length = 0;
    putCount = 0;
    resetChannelVisibilityGate(true);
    resetFileCreateGate(false);
    await page.setInputFiles("[data-composer-file-input]", {
      name: "secret-vis-a.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("account A visibility-held file"),
    });
    await page.waitForFunction(
      () => (document.querySelector<HTMLElement>("[data-composer-attachments]")?.textContent ?? "").includes("secret-vis-a.txt"),
      null,
      { timeout: 10_000 },
    );
    await page.fill("[data-composer-input]", "held visibility A->B message");
    await page.click("[data-composer-send]");
    await channelVisibilityHeldPromise;
    await clickAccountMenuItem(page, `[data-account-switch="${userB.id}"]`);
    (releaseChannelVisibility as (() => void) | null)?.();
    await page.waitForTimeout(100);
    resetChannelVisibilityGate(false);
    assert.equal(
      commandsSent.some((c) => ["file_version_create", "file_version_commit", "post_signal"].includes(c.kind)),
      false,
      "held named-channel visibility read across A->B must send ZERO file_version_create/commit/post commands",
    );
    assert.equal(putCount, 0, "held named-channel visibility read across A->B must issue 0 PUTs");

    // Case 3a1: Unchanged #ops ("open") control reaches upload & post after that exact same visibility response!
    await waitForAppReady(page, userB.email);
    await clickAccountMenuItem(page, `[data-account-switch="${userA.id}"]`);
    await waitForAppReady(page, userA.email);
    await page.goto(`${origin}/app?w=${sharedWs}&c=${opsChannelId}`);
    await waitForAppReady(page, userA.email);
    await page.waitForSelector("[data-composer]:not([hidden])");
    commandsSent.length = 0;
    putCount = 0;
    await page.setInputFiles("[data-composer-file-input]", {
      name: "ops-ok-a.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("account A ops control file"),
    });
    await page.waitForFunction(
      () => (document.querySelector<HTMLElement>("[data-composer-attachments]")?.textContent ?? "").includes("ops-ok-a.txt"),
      null,
      { timeout: 10_000 },
    );
    await page.fill("[data-composer-input]", "ops control message");
    await page.click("[data-composer-send]");
    await waitForServerCondition(
      () => commandsSent.some((c) => c.kind === "post_signal"),
      "Case 3a1 post_signal after #ops open visibility check",
    );
    assert.equal(putCount, 1, "unchanged #ops control must upload attachment after open visibility check");
    assert.deepEqual(
      commandsSent.filter((c) => ["file_version_create", "file_version_commit", "post_signal"].includes(c.kind)),
      [
        { kind: "file_version_create", actor: userA.id },
        { kind: "file_version_commit", actor: userA.id },
        { kind: "post_signal", actor: userA.id },
      ],
    );

    // Navigate to the workspace chat composer as Account A.
    await page.goto(`${origin}/app?w=${sharedWs}`);
    await waitForAppReady(page, userA.email);
    await page.waitForSelector("[data-composer]:not([hidden])");

    // Case 3a: Hold file_version_create across same-workspace A -> B!
    commandsSent.length = 0;
    putCount = 0;
    resetFileCreateGate(true);
    await page.setInputFiles("[data-composer-file-input]", {
      name: "secret-a.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("account A file"),
    });
    await page.fill("[data-composer-input]", "held A->B message");
    await page.click("[data-composer-send]");
    await fileCreateHeldPromise;
    // Switch to Account B while file_version_create is in flight!
    await clickAccountMenuItem(page, `[data-account-switch="${userB.id}"]`);
    (releaseFileCreate as (() => void) | null)?.();
    await page.waitForTimeout(100);
    assert.equal(putCount, 0, "real composer Send must issue 0 PUTs after same-workspace A->B");
    assert.equal(commandsSent.some((c) => c.kind === "file_version_commit" || c.kind === "post_signal"), false);

    // Case 3b: Hold file_version_create across same-workspace A -> B -> A!
    await waitForAppReady(page, userB.email);
    await clickAccountMenuItem(page, `[data-account-switch="${userA.id}"]`);
    await waitForAppReady(page, userA.email);
    await page.goto(`${origin}/app?w=${sharedWs}`);
    await waitForAppReady(page, userA.email);
    await page.waitForSelector("[data-composer]:not([hidden])");
    commandsSent.length = 0;
    putCount = 0;
    resetFileCreateGate(true);
    await page.setInputFiles("[data-composer-file-input]", {
      name: "secret-a2.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("account A file 2"),
    });
    await page.fill("[data-composer-input]", "held A->B->A message");
    await page.click("[data-composer-send]");
    await fileCreateHeldPromise;
    await clickAccountMenuItem(page, `[data-account-switch="${userB.id}"]`);
    await waitForAppReady(page, userB.email);
    await clickAccountMenuItem(page, `[data-account-switch="${userA.id}"]`);
    (releaseFileCreate as (() => void) | null)?.();
    await page.waitForTimeout(100);
    assert.equal(putCount, 0, "real composer Send must issue 0 PUTs after same-workspace A->B->A");
    assert.equal(commandsSent.some((c) => c.kind === "file_version_commit" || c.kind === "post_signal"), false);

    // Case 3c: Unchanged-account control succeeds end-to-end!
    await page.goto(`${origin}/app?w=${sharedWs}`);
    await waitForAppReady(page, userA.email);
    await page.waitForSelector("[data-composer]:not([hidden])");
    commandsSent.length = 0;
    putCount = 0;
    resetFileCreateGate(false);
    await page.setInputFiles("[data-composer-file-input]", {
      name: "ok-a.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("control bytes"),
    });
    await page.waitForFunction(
      () => (document.querySelector<HTMLElement>("[data-composer-attachments]")?.textContent ?? "").includes("ok-a.txt"),
      null,
      { timeout: 10_000 },
    );
    await page.fill("[data-composer-input]", "control message");
    await page.click("[data-composer-send]");
    await waitForServerCondition(
      () => commandsSent.some((c) => c.kind === "post_signal"),
      "Case 3c post_signal for unchanged-account control",
    );
    assert.equal(putCount, 1, "unchanged control must upload attachment once");
    assert.deepEqual(
      commandsSent.filter((c) => ["file_version_create", "file_version_commit", "post_signal"].includes(c.kind)),
      [
        { kind: "file_version_create", actor: userA.id },
        { kind: "file_version_commit", actor: userA.id },
        { kind: "post_signal", actor: userA.id },
      ],
    );

    // ── FLOW 4 (C5): Peer removes A from localStorage without storage event while A's menu is open -> real [data-signout] spares B! ──
    await page.waitForTimeout(150);
    await openAccountMenu(page);
    await page.waitForFunction(
      (emailA: string) => (document.querySelector<HTMLElement>("[data-signout-sub]")?.textContent ?? "").trim() === emailA,
      userA.email,
      { timeout: 10_000 },
    );
    revokedTokens.length = 0;
    const tokenB = [...liveTokens.entries()].find(([, u]) => u.id === userB.id)?.[0] ?? "";
    assert.ok(tokenB, "B must have a live token before peer removal");
    await page.evaluate(({ regKey, hash, removedUserId }: { regKey: string; hash: string; removedUserId: string }) => {
      const raw = localStorage.getItem(regKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { accounts: Array<{ userId: string; loginId: string }>; activeUserId?: string; activeLoginId?: string };
      const removed = parsed.accounts.find((a) => a.userId === removedUserId);
      parsed.accounts = parsed.accounts.filter((a) => a.userId !== removedUserId);
      const next = parsed.accounts[0] ?? null;
      parsed.activeUserId = next?.userId;
      parsed.activeLoginId = next?.loginId;
      localStorage.setItem(regKey, JSON.stringify(parsed));
      if (removed) localStorage.removeItem(`commonswarm:auth:v1:${hash}:login:${removed.loginId}`);
    }, { regKey: accountsStorageKey(originHash), hash: originHash, removedUserId: userA.id });

    // Click the already-open Sign out button for Account A directly (never reopening the menu if fallback to B already occurred).
    await page.click("[data-user-menu] [data-signout]");
    await page.waitForTimeout(150);
    assert.equal(revokedTokens.includes(tokenB), false, "real [data-signout] after peer removal of A must NEVER revoke B");
    assert.equal(liveTokens.has(tokenB), true, "Account B token must remain live");

    // ── FLOW 5 (C6 + Designer #4): Served /invite provider callback -> review -> fallback to B -> fresh confirmation! ──
    const inviteHref = memberInviteUrl(origin, {
      v: 1,
      url: origin,
      anon_key: anonKey,
      workspace_id: inviteWs,
      invitation_token: "tok_served_invite_1",
      workspace_name: "Family Cabin",
      inviter_display_name: "Host",
      inviter_user_id: inviterId,
    });
    // Start a fresh browser context for the served /invite provider callback + fallback!
    const inviteCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const inviteTab = await inviteCtx.newPage();
    try {
      await inviteTab.goto(inviteHref);
      await inviteTab.waitForSelector('[data-view="auth"]:not([hidden])');
      const resumeBeforeOAuth = new URL(inviteTab.url()).searchParams.get("resume");
      assert.ok(resumeBeforeOAuth, "/invite must persist ?resume= before OAuth");

      // Provider sign-in as Account A through real HTTP mock IdP & callback!
      nextProviderUser = userA;
      const pkceBeforeInvite = pkceExchanges;
      await inviteTab.click('[data-view="auth"] [data-signin-provider="google"]');
      await inviteTab.waitForSelector('[data-view="review"]:not([hidden])', { timeout: 15_000 });
      assert.equal(pkceExchanges, pkceBeforeInvite + 1, "served /invite must complete real HTTP S256 PKCE provider exchange");
      const inviteUrlAfterOAuth = new URL(inviteTab.url());
      assert.equal(inviteUrlAfterOAuth.searchParams.get("resume"), resumeBeforeOAuth, "?resume= preserved on /invite");
      assert.equal(inviteUrlAfterOAuth.searchParams.has("code"), false, "?code= scrubbed on /invite");
      assert.equal(inviteUrlAfterOAuth.searchParams.has("cs_attempt"), false, "?cs_attempt= scrubbed on /invite");

      // Select role + tick consent as Account A on review!
      await inviteTab.check('[data-content-role][value="editor"]');
      await inviteTab.check("[data-independent-consent]");

      // Now sign in Account B in a peer tab and remove Account A -> triggers forced teardown + fallback to B on /invite!
      const peerTab = await inviteCtx.newPage();
      await peerTab.goto(`${origin}/app`);
      await waitForAppReady(peerTab, userA.email);
      await clickAccountMenuItem(peerTab, "[data-add-account-open]");
      await peerTab.waitForSelector("[data-add-account-dialog][open]");
      await peerTab.fill("#add-account-email", userB.email);
      await peerTab.fill("#add-account-password", "pw-b");
      await peerTab.click("[data-add-account-password-submit]");
      await waitForAppReady(peerTab, userB.email);
      // Switch peer tab back to A, wait for A to finish rendering, and sign A out so /invite falls back to B!
      await clickAccountMenuItem(peerTab, `[data-account-switch="${userA.id}"]`);
      await waitForAppReady(peerTab, userA.email);
      await clickAccountMenuItem(peerTab, "[data-user-menu] [data-signout]");
      await waitForAppReady(peerTab, userB.email);
      await peerTab.close();

      // Back on /invite: review MUST reset, name Account B, and keep Join blocked until fresh role + consent!
      await inviteTab.waitForFunction(() => {
        const notice = document.querySelector<HTMLElement>("[data-review-identity-notice]");
        return Boolean(notice && !notice.hidden && notice.textContent?.includes("b@example.test"));
      }, null, { timeout: 15_000 });
      const noticeText = (await inviteTab.locator("[data-review-identity-notice]").innerText()).trim();
      assert.equal(
        noticeText,
        `You’re now joining as ${userB.email}. Review this invitation again.`,
      );
      const resetState = await inviteTab.evaluate(() => ({
        consentChecked: document.querySelector<HTMLInputElement>("[data-independent-consent]")?.checked ?? true,
        roleChecked: [...document.querySelectorAll<HTMLInputElement>("[data-content-role]")].some((r) => r.checked),
      }));
      assert.equal(resetState.consentChecked, false, "consent box must reset after identity change");
      assert.equal(resetState.roleChecked, false, "role choice must reset after identity change");

      // Clicking Join before re-confirming must NOT send accept!
      commandsSent.length = 0;
      await inviteTab.click("[data-confirm-join]");
      await inviteTab.waitForSelector("[data-review-hint]:not([hidden])");
      assert.equal(commandsSent.some((c) => c.kind === "household_invitation:accept"), false);

      // Freshly choose role + tick consent as Account B -> Join succeeds under Account B!
      await inviteTab.check('[data-content-role][value="reader"]');
      await inviteTab.check("[data-independent-consent]");
      await inviteTab.click("[data-confirm-join]");
      await inviteTab.waitForSelector('[data-view="connect"]:not([hidden])');
      assert.deepEqual(
        commandsSent.filter((c) => c.kind === "household_invitation:accept"),
        [{ kind: "household_invitation:accept", actor: userB.id, contentRole: "reader" }],
      );
    } finally {
      await inviteCtx.close();
    }

    await context.close();
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
