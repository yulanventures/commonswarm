/** Unified Item 6b WCAG 2.2 AA, Carbon border/contrast, 44 px target, and responsive capture sweep across Step 3D-1, 3D-2, and 3D-3. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";
import { chromium } from "playwright-core";
import { compileFixtureFunction, renderAstroFixture } from "../../../tests/astro-fixture";

const WS = "11111111-1111-4111-8111-111111111111";
const AGENT_OWNED = "44444444-4444-4444-8444-444444444444";
const DM_GROUP_CONV = "bbbb2222-2222-4222-8222-222222222222";
const DM_UNAVAILABLE_CONV = "cccc3333-3333-4333-8333-333333333333";
const OVERSIGHT_DM_CONV = "dddd4444-4444-4444-8444-444444444444";

function installStep3dA11yFixture() {
  const f = (window as any).existingFixture;
  const peerLongA = "eeee5555-5555-4555-8555-555555555551";
  const peerLongB = "eeee5555-5555-4555-8555-555555555552";
  const generalConv = "99990000-0000-4000-8000-000000000001";
  const dmGroupConv = "bbbb2222-2222-4222-8222-222222222222";
  const dmUnavailableConv = "cccc3333-3333-4333-8333-333333333333";
  const oversightConv = "dddd4444-4444-4444-8444-444444444444";
  const rootId = "f2000001-0000-4000-8000-000000000001";
  const replyId = "f2000002-0000-4000-8000-000000000002";
  const missingRootId = "f2000003-0000-4000-8000-000000000003";

  f.step3d = {
    generalConv,
    dmGroupConv,
    dmUnavailableConv,
    oversightConv,
    rootId,
    replyId,
    missingRootId,
    failLoadOlder: true,
    failOversightHistory: false,
    sendMode: "missing_root" as "missing_root" | "retryable_503" | "ok",
  };

  const now = Date.now();
  const iso = (offsetSec: number) => new Date(now + offsetSec * 1000).toISOString();

  const conversations = [
    {
      conversation_id: generalConv,
      kind: "general",
      channel_id: null,
      slug: "general",
      description: null,
      archived_at: null,
      joined: true,
      generation: 1,
      lead_mode: "workspace",
      lead_agent_principal_id: null,
      members: [],
      notify_level: "everything",
      starred: false,
      star_rank: null,
      read_through_at: null,
      read_through_id: null,
      unread_count: 0,
      mention_count: 0,
      last_message_at: iso(-120),
      last_message_id: null,
    },
    {
      conversation_id: dmGroupConv,
      kind: "group_dm",
      channel_id: null,
      slug: null,
      description: null,
      archived_at: null,
      joined: true,
      generation: 1,
      lead_mode: null,
      lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "user", id: peerLongA, name: "Alexandria-Montgomery-Design-Lead", left_at: null },
        { kind: "agent", id: peerLongB, name: "Autonomous-Architecture-Reviewer-Bot", left_at: null },
      ],
      notify_level: "everything",
      starred: false,
      star_rank: null,
      read_through_at: null,
      read_through_id: null,
      unread_count: 0,
      mention_count: 0,
      last_message_at: iso(-20),
      last_message_id: missingRootId,
    },
  ];

  const mkMsg = (id: string, body: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
    id,
    workspace_id: f.workspace,
    from: peerLongA,
    from_kind: "user",
    to: f.owner,
    to_agent: null,
    kind: "note",
    body,
    attachments: [],
    about: null,
    until: iso(3600),
    created_at: createdAt,
    channel_id: null,
    thread_root_id: null,
    in_reply_to: null,
    broadcast_to_channel: false,
    ...extra,
  });

  const groupMessages = [
    mkMsg(missingRootId, "Thread root removed before reply.", iso(-20), { conversation_id: dmGroupConv, conversation_kind: "group_dm" }),
    mkMsg(replyId, "Confirmed private 1-level thread reply inside group DM.", iso(-40), {
      from: peerLongB,
      from_kind: "agent",
      thread_root_id: rootId,
      conversation_id: dmGroupConv,
      conversation_kind: "group_dm",
    }),
    mkMsg(rootId, "Launch readiness review thread root.", iso(-80), { conversation_id: dmGroupConv, conversation_kind: "group_dm" }),
  ];

  const oversightSummary = {
    conversation_id: oversightConv,
    kind: "dm",
    channel_id: null,
    slug: null,
    description: null,
    archived_at: null,
    generation: 1,
    members: [
      { kind: "agent", id: f.agent, name: "Owned Agent", left_at: null },
      { kind: "user", id: peerLongA, name: "Alexandria-Montgomery-Design-Lead", left_at: null },
    ],
    last_message_at: iso(-50),
    last_message_id: "f4000001-0000-4000-8000-000000000001",
    read_only: true,
  };

  const previous = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.test.invalid") return previous(input, init);

    if (url.pathname === "/rest/v1/member_profiles") {
      return Response.json([
        { user_id: f.owner, display_name: "Synthetic owner", role: "owner" },
        { user_id: peerLongA, display_name: "Alexandria-Montgomery-Design-Lead", role: "member" },
      ]);
    }
    if (url.pathname === "/rest/v1/agent_principals") {
      if (url.searchParams.get("revoked_at") !== "is.null") return Response.json([]);
      return Response.json([
        {
          principal_id: f.agent,
          name: "Owned Agent",
          model: "Claude",
          transport: "hosted_mcp",
          turn_only: false,
          owner_user_id: f.owner,
          revoked_at: null,
          workspace_id: f.workspace,
          created_at: "2026-11-01T00:00:00Z",
        },
        {
          principal_id: peerLongB,
          name: "Autonomous-Architecture-Reviewer-Bot",
          model: "Claude",
          transport: "local",
          turn_only: false,
          owner_user_id: peerLongA,
          revoked_at: null,
          workspace_id: f.workspace,
          created_at: "2026-11-01T00:00:00Z",
        },
      ]);
    }

    if (url.pathname === "/rest/v1/rpc/agent_queue") {
      return Response.json({
        workspace_id: f.workspace,
        principal_id: f.agent,
        owner_user_id: f.owner,
        accepts_from: "anyone",
        content_access: "none",
        status: { work: "idle", facts: { transport: "hosted_mcp", turn_only: false, connection: "live", last_activity_at: iso(-30), messages_waiting_since: null, doing: null, working_on: null } },
        working: [],
        up_next: [],
        not_yet: [],
        requests: [],
        read_at: iso(0),
        next_offset: { working: null, up_next: null, not_yet: null, requests: null },
      });
    }

    if (url.pathname === "/functions/v1/read") {
      const body = await request.clone().json().catch(() => ({}));
      if (body.resource === "conversations") {
        return Response.json({ conversations });
      }
      if (body.resource === "conversation_history") {
        if (body.conversation_id === dmUnavailableConv) {
          return Response.json(
            { error: "conversation_not_found", message: "This conversation isn't available in this workspace." },
            { status: 404 },
          );
        }
        if (body.conversation_id === dmGroupConv) {
          if (body.before_created_at && f.step3d.failLoadOlder) {
            return Response.json({ error: "temporary_error", message: "History read failed temporarily." }, { status: 503 });
          }
          return Response.json({
            conversation: conversations[1],
            messages: body.before_created_at ? [] : groupMessages,
            has_more: !body.before_created_at,
            next_before: !body.before_created_at ? { created_at: iso(-80), id: rootId } : null,
            next_after: { created_at: iso(-20), id: missingRootId },
          });
        }
        return Response.json({
          conversation: conversations[0],
          messages: [
            mkMsg("00000000-0000-4000-8000-000000000001", "General channel message.", iso(-120), { to: null, conversation_id: generalConv }),
          ],
          has_more: false,
          next_before: null,
          next_after: null,
        });
      }
      if (body.resource === "conversation_oversight") {
        return Response.json({ conversations: [oversightSummary] });
      }
      if (body.resource === "conversation_oversight_history") {
        if (body.before_created_at) {
          return Response.json({ error: "oversight_unavailable", message: "Could not load older oversight messages." }, { status: 503 });
        }
        return Response.json({
          conversation: oversightSummary,
          messages: [
            mkMsg("f4000001-0000-4000-8000-000000000001", "Read-only oversight transcript message.", iso(-50), {
              from: f.agent,
              from_kind: "agent",
              conversation_id: oversightConv,
            }),
          ],
          has_more: true,
          next_before: { created_at: iso(-50), id: "f4000001-0000-4000-8000-000000000001" },
          next_after: null,
        });
      }
    }

    if (url.pathname === "/functions/v1/command") {
      const body = await request.clone().json().catch(() => ({}));
      if (body?.command?.kind === "conversation_mark_read" || body?.command?.kind === "signals_seen") {
        return Response.json({ status: "accepted" });
      }
      if (body?.command?.kind === "post_signal") {
        if (f.step3d.sendMode === "missing_root") {
          return Response.json(
            { error: "thread_root_not_found", message: "That thread is no longer available." },
            { status: 404 },
          );
        }
        if (f.step3d.sendMode === "retryable_503") {
          return Response.json(
            { error: "temporarily_unavailable", message: "Could not send right now." },
            { status: 503 },
          );
        }
      }
    }

    return previous(input, init);
  };
}

test("Item 6b unified Step 3D-1 + 3D-2 + 3D-3 WCAG 2.2 AA contrast, Carbon control borders, 44 px targets, focus, and responsive sweep", { timeout: 180_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const installBase = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const installOverlay = await compileFixtureFunction(new URL(import.meta.url), "installStep3dA11yFixture");
  const axeSource = await readFile(resolve(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");
  const fontsDir = fileURLToPath(new URL("../../../public/fonts/", import.meta.url));

  const html =
    "<!doctype html><html><head><meta charset='utf-8'>" +
    "<meta name='commonswarm:url' content='https://api.test.invalid'>" +
    "<meta name='commonswarm:anon-key' content='synthetic-public'>" +
    "<style>" + styles.join("\n") + "</style>" +
    "<script>" + installBase + "\n" + installOverlay + "</script>" +
    "</head><body>" + markup + "</body></html>";

  const server = createServer((request, response) => {
    const reqUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname === "/app.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(bundled.join("\n"));
      return;
    }
    if (reqUrl.pathname.startsWith("/fonts/") && reqUrl.pathname.endsWith(".woff2")) {
      void readFile(join(fontsDir, basename(reqUrl.pathname))).then(
        (data) => { response.writeHead(200, { "Content-Type": "font/woff2" }); response.end(data); },
        () => { response.writeHead(404); response.end(); },
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  });

  const evidenceDir = process.env.STEP3D_A11Y_CAPTURE_DIR
    ? resolve(process.env.STEP3D_A11Y_CAPTURE_DIR)
    : resolve(process.cwd(), "../site-observer-evidence/conversations-step3d-a11y");
  await mkdir(evidenceDir, { recursive: true });

  const browser = await launchPlaywrightChromium(chromium);
  const report: Record<string, unknown> = {};

  // Plain JS helper injected in each browser context to compute exact WCAG 2.2 sRGB contrast ratios.
  const contrastHelperScript = `
    (() => {
      function parseRgb(str) {
        const m = String(str || "").match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/);
        if (!m) return null;
        return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
      }
      function lum(c) {
        const ch = [c.r, c.g, c.b].map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
      }
      function effectiveBg(el) {
        let cur = el;
        while (cur) {
          const c = parseRgb(getComputedStyle(cur).backgroundColor);
          if (c && c.a > 0.05) return c;
          cur = cur.parentElement;
        }
        return { r: 255, g: 255, b: 255, a: 1 };
      }
      function ratio(c1, c2) {
        const l1 = Math.max(lum(c1), lum(c2));
        const l2 = Math.min(lum(c1), lum(c2));
        return (l1 + 0.05) / (l2 + 0.05);
      }
      window.__measureContrast = (selector, mode) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const st = getComputedStyle(el);
        const bg = effectiveBg(mode === "border" ? el.parentElement || el : el);
        const fg = parseRgb(mode === "border" ? st.borderTopColor : st.color);
        const rect = el.getBoundingClientRect();
        return {
          ratio: fg ? Number(ratio(fg, bg).toFixed(2)) : 0,
          borderWidth: parseFloat(st.borderTopWidth || "0"),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          fg: mode === "border" ? st.borderTopColor : st.color,
          bg: "rgb(" + bg.r + ", " + bg.g + ", " + bg.b + ")",
        };
      };
    })();
  `;

  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const origin = `http://127.0.0.1:${addr.port}`;

    const matrix = [
      { width: 360, height: 740, theme: "light" as const, touch: true },
      { width: 360, height: 740, theme: "dark" as const, touch: true },
      { width: 390, height: 844, theme: "dark" as const, touch: true },
      { width: 844, height: 390, theme: "dark" as const, touch: true },
      { width: 1024, height: 768, theme: "light" as const, touch: true },
      { width: 1024, height: 768, theme: "dark" as const, touch: true },
      { width: 1440, height: 900, theme: "light" as const, touch: false },
      { width: 1440, height: 900, theme: "dark" as const, touch: false },
    ];

    for (const { width, height, theme, touch } of matrix) {
      const label = `${width}x${height}-${theme}`;
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
      await context.addInitScript(contrastHelperScript);
      const page = await context.newPage();

      try {
        // ── A. Step 3D-1 & 3D-2: Group DM with Load older error, 1-level thread reply, Escape focus, Move draft, Retry send ──
        await page.goto(`${origin}/app?w=${WS}&dm=${DM_GROUP_CONV}&theme=${theme}`, { waitUntil: "load" });
        await page.addScriptTag({ content: axeSource });
        await page.waitForSelector('[data-feed-list] .dashboard__message[data-signal-id="f2000001-0000-4000-8000-000000000001"]');

        // Step 3D-1: Click Load older -> triggers 503 -> verify error contrast >= 4.5:1 & Load older touch height >= 44px
        await page.click("[data-load-older]");
        await page.waitForSelector("[data-load-older-error]:not([hidden])");
        const loadOlderError = await page.evaluate(() => (window as any).__measureContrast("[data-load-older-error]", "text"));
        const loadOlderBtn = await page.evaluate(() => (window as any).__measureContrast("[data-load-older]", "border"));
        assert.ok(loadOlderError && loadOlderError.ratio >= 4.5, `${label}: load-older error contrast >= 4.5 (${JSON.stringify(loadOlderError)})`);
        if (touch) assert.ok(loadOlderBtn && loadOlderBtn.height >= 44, `${label}: load-older button >= 44px (${JSON.stringify(loadOlderBtn)})`);

        // Step 3D-2: Reply in thread on missingRootId -> verify reply bar + private pill + Escape focus return
        const rootReplyBtn = page.locator('[data-message-reply="f2000003-0000-4000-8000-000000000003"]');
        await rootReplyBtn.focus();
        await rootReplyBtn.click();
        await page.waitForSelector("[data-composer-reply]:not([hidden])");
        const cancelBox = await page.evaluate(() => (window as any).__measureContrast("[data-composer-reply-cancel]", "text"));
        assert.ok(cancelBox && cancelBox.width >= 44 && cancelBox.height >= 44, `${label}: reply Cancel >= 44x44 (${JSON.stringify(cancelBox)})`);

        // Escape returns keyboard focus back to the root's Reply in thread control.
        await page.locator("[data-composer-input]").focus();
        await page.keyboard.press("Escape");
        await page.waitForSelector("[data-composer-reply]", { state: "hidden" });
        const escapeReturned = await page.evaluate(() =>
          document.activeElement?.matches('[data-message-reply="f2000003-0000-4000-8000-000000000003"]') === true,
        );
        assert.equal(escapeReturned, true, `${label}: Escape on DM thread reply must restore focus to root Reply button`);

        // Re-open reply on missingRootId -> type draft -> submit -> 404 thread_root_not_found -> Move draft to conversation + error contrast!
        await rootReplyBtn.focus();
        await rootReplyBtn.click();
        await page.waitForSelector("[data-composer-reply]:not([hidden])");
        await page.fill("[data-composer-input]", "Preserved group DM thread draft");
        await page.click("[data-composer-send]");
        await page.waitForSelector("[data-composer-move-to-conversation]:not([hidden])");
        await page.waitForSelector('[data-composer-status][data-state="error"]');

        const threadMetrics = await page.evaluate(() => ({
          statusContrast: (window as any).__measureContrast('[data-composer-status][data-state="error"]', "text"),
          moveBtn: (window as any).__measureContrast("[data-composer-move-to-conversation]", "text"),
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        }));
        assert.ok(threadMetrics.statusContrast && threadMetrics.statusContrast.ratio >= 4.5, `${label}: composer error contrast >= 4.5 (${JSON.stringify(threadMetrics.statusContrast)})`);
        assert.ok(threadMetrics.moveBtn && threadMetrics.moveBtn.height >= 44, `${label}: Move draft button >= 44px (${JSON.stringify(threadMetrics.moveBtn)})`);
        assert.equal(threadMetrics.overflow, false, `${label}: zero horizontal overflow on unavailable DM thread`);

        if (width === 360 || width === 844 || width === 1024) {
          await page.screenshot({ path: join(evidenceDir, `step3d2-thread-unavailable-${label}.png`) });
        }

        const axeGroupDm = await page.evaluate(async () => {
          const res = await (window as any).axe.run(document.querySelector(".hm-frame") || document.body, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
          });
          return res.violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n: any) => n.html) }));
        });
        assert.deepEqual(axeGroupDm, [], `${label}: axe violations on Step 3D-1/3D-2 group DM: ${JSON.stringify(axeGroupDm)}`);

        // Click Move draft to conversation -> moves focus cleanly to composer textarea, then test Retry send border on 503!
        await page.click("[data-composer-move-to-conversation]");
        await page.waitForSelector("[data-composer-reply]", { state: "hidden" });
        const focusedComposer = await page.evaluate(() => document.activeElement?.matches("[data-composer-input]") === true);
        assert.equal(focusedComposer, true, `${label}: Move draft to conversation must focus composer input`);

        await page.evaluate(() => { (window as any).existingFixture.step3d.sendMode = "retryable_503"; });
        await page.click("[data-composer-send]");
        await page.waitForSelector("[data-composer-retry]:not([hidden])");
        const retryBtn = await page.evaluate(() => (window as any).__measureContrast("[data-composer-retry]", "border"));
        assert.ok(retryBtn && retryBtn.borderWidth >= 1 && retryBtn.ratio >= 3, `${label}: Retry send border >= 3:1 (${JSON.stringify(retryBtn)})`);
        assert.ok(retryBtn && retryBtn.width >= 44 && retryBtn.height >= 44, `${label}: Retry send >= 44x44 (${JSON.stringify(retryBtn)})`);

        // ── B. Step 3D-1 Unavailable DM (404 conversation_not_found): Go to #general button border >= 3:1 & >= 44px ──
        await page.goto(`${origin}/app?w=${WS}&dm=${DM_UNAVAILABLE_CONV}&theme=${theme}`, { waitUntil: "load" });
        await page.addScriptTag({ content: axeSource });
        await page.waitForSelector(".dashboard__channel-unavailable [data-channel-go-general]");
        const unavailBtn = await page.evaluate(() => (window as any).__measureContrast(".dashboard__channel-unavailable [data-channel-go-general]", "border"));
        const unavailOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert.ok(unavailBtn && unavailBtn.borderWidth >= 1 && unavailBtn.ratio >= 3, `${label}: Go to #general border >= 3:1 (${JSON.stringify(unavailBtn)})`);
        assert.ok(unavailBtn && unavailBtn.height >= 44, `${label}: Go to #general >= 44px (${JSON.stringify(unavailBtn)})`);
        assert.equal(unavailOverflow, false, `${label}: zero overflow on unavailable DM`);
        if (width === 360 || width === 1024) {
          await page.screenshot({ path: join(evidenceDir, `step3d1-unavailable-${label}.png`) });
        }

        // ── C. Step 3D-3 Read-Only Agent Oversight error contrast on --k-shell-subtle + control borders ──
        await page.goto(`${origin}/app?w=${WS}&agent=${AGENT_OWNED}&theme=${theme}`, { waitUntil: "load" });
        await page.addScriptTag({ content: axeSource });
        await page.waitForSelector(".cs-oversight__row");
        if (width <= 832) {
          await page.click(".cs-oversight__row");
        }
        await page.waitForSelector("[data-oversight-load-older]");
        await page.click("[data-oversight-load-older]");
        await page.waitForSelector(".cs-oversight__detail .cs-oversight__error");
        const oversightMetrics = await page.evaluate(() => ({
          errorContrast: (window as any).__measureContrast(".cs-oversight__detail .cs-oversight__error", "text"),
          loadOlderBorder: (window as any).__measureContrast("[data-oversight-load-older]", "border"),
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        }));
        assert.ok(oversightMetrics.errorContrast && oversightMetrics.errorContrast.ratio >= 4.5, `${label}: oversight error on subtle >= 4.5:1 (${JSON.stringify(oversightMetrics.errorContrast)})`);
        assert.ok(oversightMetrics.loadOlderBorder && oversightMetrics.loadOlderBorder.borderWidth >= 1 && oversightMetrics.loadOlderBorder.ratio >= 3, `${label}: oversight Load older border >= 3:1 (${JSON.stringify(oversightMetrics.loadOlderBorder)})`);
        assert.ok(oversightMetrics.loadOlderBorder && oversightMetrics.loadOlderBorder.height >= 44, `${label}: oversight Load older >= 44px (${JSON.stringify(oversightMetrics.loadOlderBorder)})`);
        assert.equal(oversightMetrics.overflow, false, `${label}: zero overflow on Step 3D-3 oversight`);

        const axeOversight = await page.evaluate(async () => {
          const res = await (window as any).axe.run(document.querySelector(".cs-oversight") || document.body, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
          });
          return res.violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n: any) => n.html) }));
        });
        assert.deepEqual(axeOversight, [], `${label}: axe violations on Step 3D-3 oversight: ${JSON.stringify(axeOversight)}`);

        if (width === 360 || width === 1024) {
          await page.screenshot({ path: join(evidenceDir, `step3d3-oversight-error-${label}.png`) });
        }

        report[label] = {
          ok: true,
          loadOlderError,
          threadMetrics,
          retryBtn,
          unavailBtn,
          oversightMetrics,
        };
      } finally {
        await context.close();
      }
    }

    await writeFile(join(evidenceDir, "summary.json"), JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
