/** Signed-in mounted C2 observer: live seat status line on 1:1 agent DM header across desktop & phone, light & dark themes, and extracted conversationReadLifecycle navigation. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";
import { chromium, type Page } from "playwright-core";
import { compileFixtureFunction, renderAstroFixture } from "../../../tests/astro-fixture";

function installC2DmHeaderFixture() {
  const f = (window as any).existingFixture;
  const params = new URL(location.href).searchParams;
  const stateMode = params.get("seat") ?? "working";
  f.stateMode = stateMode;

  const peerHuman = "dddd4444-4444-4444-8444-444444444444";
  const agentWren = "eeee5555-5555-4555-8555-555555555555";
  const generalConv = "99990000-0000-4000-8000-000000000001";
  const dmAgentConv = "aaaa1111-1111-4111-8111-111111111111";
  const dmHumanConv = "bbbb2222-2222-4222-8222-222222222222";
  const msgAgentId = "f1000001-0000-4000-8000-000000000001";
  const msgHumanId = "f2000001-0000-4000-8000-000000000001";
  f.ids = { peerHuman, agentWren, generalConv, dmAgentConv, dmHumanConv };

  const now = Date.now();
  const iso = (offsetSec: number) => new Date(now + offsetSec * 1000).toISOString();

  const conversations = [
    {
      conversation_id: generalConv, kind: "general", channel_id: null, slug: "general", description: null,
      archived_at: null, joined: true, generation: 0, lead_mode: "workspace", lead_agent_principal_id: null,
      members: [], notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: iso(-120), last_message_id: null,
    },
    {
      conversation_id: dmAgentConv, kind: "dm", channel_id: null, slug: null, description: null,
      archived_at: null, joined: true, generation: 1, lead_mode: null, lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "agent", id: agentWren, name: "Wren", left_at: null },
      ],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: iso(-60), last_message_id: msgAgentId,
    },
    {
      conversation_id: dmHumanConv, kind: "dm", channel_id: null, slug: null, description: null,
      archived_at: null, joined: true, generation: 1, lead_mode: null, lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "user", id: peerHuman, name: "Alex", left_at: null },
      ],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: iso(-90), last_message_id: msgHumanId,
    },
  ];

  const mkMsg = (id: string, from: string, fromKind: "user" | "agent", body: string, createdAt: string, convId: string) => ({
    id, workspace_id: f.workspace, from, from_kind: fromKind,
    to: f.owner, to_agent: null, kind: "note", body, attachments: [], about: null, until: iso(3600),
    created_at: createdAt, channel_id: null, thread_root_id: null, in_reply_to: null, broadcast_to_channel: false,
    conversation_id: convId, conversation_kind: convId === generalConv ? "general" : "dm",
  });

  const rowsByConv: Record<string, any[]> = {
    [generalConv]: [mkMsg("00000000-0000-4000-8000-000000000001", peerHuman, "user", "Public #general status.", iso(-120), generalConv)],
    [dmAgentConv]: [mkMsg(msgAgentId, agentWren, "agent", "Checking the migration checklist now.", iso(-60), dmAgentConv)],
    [dmHumanConv]: [mkMsg(msgHumanId, peerHuman, "user", "Direct message from Alex.", iso(-90), dmHumanConv)],
  };

  const seatRosterRow = (() => {
    if (stateMode === "turn-only") {
      return {
        principal_id: agentWren, workspace_id: f.workspace, owner_user_id: f.owner, revoked_at: null,
        name: "Wren", model: "claude-opus-4-6", transport: "hosted_mcp", turn_only: true, created_at: "2026-11-01T00:00:00Z",
      };
    }
    return {
      principal_id: agentWren, workspace_id: f.workspace, owner_user_id: f.owner, revoked_at: null,
      name: "Wren", model: "claude-opus-4-6", transport: "local", turn_only: false, created_at: "2026-11-01T00:00:00Z",
    };
  })();

  const presenceRow = (() => {
    if (stateMode === "working") {
      return {
        principal_id: agentWren, workspace_id: f.workspace, last_command_at: iso(-30), client_build: "0.1.107",
        watcher_at: iso(-10), channel_at: null, listener_at: null, turn_at: null,
        last_ack_via: "leased", last_ack_at: iso(-10), current_client_build: "0.1.107",
      };
    }
    if (stateMode === "waiting") {
      return {
        principal_id: agentWren, workspace_id: f.workspace, last_command_at: iso(-360), client_build: "0.1.107",
        watcher_at: iso(-10), channel_at: null, listener_at: null, turn_at: null,
        last_ack_via: "leased", last_ack_at: iso(-10), current_client_build: "0.1.107",
      };
    }
    if (stateMode === "not-listening") {
      return {
        principal_id: agentWren, workspace_id: f.workspace, last_command_at: iso(-2 * 3600), client_build: "0.1.107",
        watcher_at: iso(-600), channel_at: null, listener_at: null, turn_at: null,
        last_ack_via: "leased", last_ack_at: iso(-600), current_client_build: "0.1.107",
      };
    }
    return null;
  })();

  const wakeRow = stateMode === "waiting"
    ? { principal_id: agentWren, workspace_id: f.workspace, oldest_unobserved_at: iso(-5 * 60), unseen_count: 2 }
    : null;

  const overviewAgent = (() => {
    if (stateMode === "working") {
      return {
        principal_id: agentWren,
        name: "Wren",
        model: "claude-opus-4-6",
        transport: "local",
        turn_only: false,
        status: {
          work: "working",
          facts: {
            connection: "live",
            working_on: { at: iso(-3 * 60), until: iso(3600), title: "Secret private title must never appear" },
            doing: null,
            last_activity_at: iso(-30),
            messages_waiting_count: 0,
            messages_waiting_since: null,
            wake: { watcher_at: iso(-10), channel_at: null, listener_at: null, turn_at: null },
          },
        },
      };
    }
    if (stateMode === "turn-only") {
      return {
        principal_id: agentWren,
        name: "Wren",
        model: "claude-opus-4-6",
        transport: "hosted_mcp",
        turn_only: true,
        status: {
          work: "idle",
          facts: {
            connection: "live",
            working_on: null,
            doing: null,
            last_activity_at: iso(-5 * 60),
            messages_waiting_count: 0,
            messages_waiting_since: null,
            wake: null,
          },
        },
      };
    }
    return null;
  })();

  const previous = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.test.invalid") return previous(input, init);
    if (url.pathname === "/rest/v1/channels") return Response.json([]);
    if (url.pathname === "/rest/v1/rpc/channel_unread") {
      return Response.json({
        workspace_id: f.workspace,
        generated_at: iso(0),
        channels: [{ channel_id: null, slug: "general", unread: false }],
      });
    }
    if (url.pathname === "/rest/v1/signals") return Response.json(rowsByConv[generalConv]);
    if (url.pathname === "/rest/v1/member_profiles") {
      return Response.json([
        { user_id: f.owner, display_name: "Synthetic owner", role: "owner" },
        { user_id: peerHuman, display_name: "Alex", role: "member" },
      ]);
    }
    if (url.pathname === "/rest/v1/agent_principals") {
      if (url.searchParams.get("revoked_at") !== "is.null") return Response.json([]);
      if (url.searchParams.get("workspace_id") && url.searchParams.get("workspace_id") !== "eq." + f.workspace) return Response.json([]);
      return Response.json([seatRosterRow]);
    }
    if (url.pathname === "/rest/v1/agent_presence") return Response.json(presenceRow ? [presenceRow] : []);
    if (url.pathname === "/rest/v1/agent_wake_path") return Response.json(wakeRow ? [wakeRow] : []);
    if (url.pathname === "/rest/v1/rpc/home_overview") {
      return Response.json({
        viewer_user_id: f.owner,
        generated_at: iso(0),
        workspaces: [f.workspace, f.other].map((id) => ({
          workspace_id: id,
          name: id === f.workspace ? "Home" : "Studio",
          role: "owner",
          last_seen_at: iso(0),
          new_messages: 0,
          content: null,
          people: [{
            user_id: f.owner,
            display_name: "Synthetic owner",
            role: "owner",
            is_viewer: true,
            agents: id === f.workspace && overviewAgent ? [overviewAgent] : [],
          }],
          needs_you: { asks: [], assigned: [], waiting: [] },
        })),
      });
    }
    if (url.pathname === "/functions/v1/command" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null) as Record<string, any> | null;
      if (body?.command?.kind === "signals_seen" || body?.command?.kind === "conversation_mark_read") {
        return Response.json({ status: "accepted" });
      }
    }
    if (url.pathname === "/functions/v1/read" && request.method === "POST") {
      const body = await request.clone().json().catch(() => ({})) as Record<string, any>;
      if (body.resource === "conversations") return Response.json({ conversations });
      if (body.resource === "conversation_history") {
        const convId = String(body.conversation_id ?? "");
        const conv = conversations.find((c) => c.conversation_id === convId) ?? null;
        if (!conv) return Response.json({ error: "conversation_not_found", message: "Not found" }, { status: 404 });
        const rows = body.after ? [] : (rowsByConv[convId] ?? []);
        return Response.json({ conversation: conv, messages: rows, has_more: false, next_before: null, next_after: null });
      }
    }
    return previous(input, init);
  };
}

async function observeC2DmHeader() {
  const f = (window as any).existingFixture;
  const one = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);
  const all = <T extends Element = HTMLElement>(s: string) => [...document.querySelectorAll<T>(s)];
  const visible = (el: Element | null) => {
    if (!el || el.closest("[hidden]")) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const shown = <T extends Element = HTMLElement>(s: string) => all<T>(s).find(visible) ?? null;
  let stage = "boot";
  const wait = async (label: string, ready: () => boolean, ms = 12_000) => {
    stage = label;
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (ready()) return;
      await fetch("/__observer-tick");
    }
    throw new Error(`Timed out at: ${label}`);
  };
  const check = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
  const click = async (selector: string) => {
    const res = await fetch(`/__click?selector=${encodeURIComponent(selector)}`);
    if (!res.ok) throw new Error(`click ${selector}: ${await res.text()}`);
  };
  const dismissEntityPanel = async () => {
    await new Promise((r) => setTimeout(r, 80));
    const closeBtn = shown<HTMLButtonElement>("[data-entity-close]");
    if (closeBtn) {
      closeBtn.click();
      await wait("entity panel closed", () => !shown("[data-entity-close]"));
    }
  };
  const openDrawerIfPhone = async () => {
    const toggle = shown<HTMLButtonElement>("[data-kylon-drawer-toggle]");
    if (toggle && toggle.getAttribute("aria-expanded") !== "true") {
      await click("[data-kylon-drawer-toggle]:visible");
      await wait("phone drawer open", () => toggle.getAttribute("aria-expanded") === "true");
    }
  };

  try {
    await import("/app.js");
    await wait("agent DM loaded", () => (one("[data-feed-list]")?.textContent ?? "").includes("Checking the migration checklist now."));
    await dismissEntityPanel();

    const expected: Record<string, { kind: string; indicator: string; attention: string; substring: string }> = {
      working: { kind: "working", indicator: "dot", attention: "false", substring: "Working · 3 min" },
      waiting: { kind: "waiting", indicator: "diamond", attention: "true", substring: "2 unseen" },
      "turn-only": { kind: "turn_only", indicator: "ring", attention: "false", substring: "Turn-only, checks when opened · 5 min ago" },
      "not-listening": { kind: "not_listening", indicator: "ring", attention: "false", substring: "Not listening · 2 h ago" },
    };
    const want = expected[f.stateMode]!;

    await wait(`agent DM header seat status (${f.stateMode})`, () => {
      const el = shown("[data-dm-seat-status]");
      return Boolean(el && el.dataset.dmSeatStatus === want.kind && (el.textContent ?? "").includes(want.substring));
    });
    const statusEl = shown<HTMLElement>("[data-dm-seat-status]")!;
    const shapeEl = statusEl.querySelector<HTMLElement>(".hm-dm-seat-status__shape");
    const textEl = statusEl.querySelector<HTMLElement>(".hm-dm-seat-status__text")!;
    check(statusEl.dataset.indicator === want.indicator, `expected indicator=${want.indicator}, got ${statusEl.dataset.indicator}`);
    check(statusEl.dataset.attention === want.attention, `expected attention=${want.attention}, got ${statusEl.dataset.attention}`);
    check(shapeEl?.dataset.shape === want.indicator, `expected shape=${want.indicator}, got ${shapeEl?.dataset.shape}`);
    check(!(statusEl.textContent ?? "").includes("Secret private title"), "DM header seat status must never expose private titles");
    await document.fonts.ready;
    const textStyle = getComputedStyle(textEl);
    check(textStyle.whiteSpace === "normal", `seat status text must wrap cleanly, got white-space=${textStyle.whiteSpace}`);
    check(textStyle.textOverflow === "clip", `seat status text must not ellipsize, got text-overflow=${textStyle.textOverflow}`);
    check(textEl.scrollWidth <= textEl.clientWidth + 1, `seat status text clipped horizontally: ${textEl.scrollWidth} > ${textEl.clientWidth}`);
    const statusRect = statusEl.getBoundingClientRect();
    check(statusRect.left >= 0 && statusRect.right <= innerWidth, `seat status outside viewport: ${statusRect.left}..${statusRect.right} vs ${innerWidth}`);
    if (innerWidth <= 832) {
      const phoneName = shown<HTMLElement>(".cs-org-phone-title > .hm-phone-bar__title")!;
      check(Boolean(phoneName), "phone DM title must be visible");
      check(getComputedStyle(phoneName).whiteSpace === "nowrap", "phone DM name must remain single-line independent of status wrap");
      const nameRect = phoneName.getBoundingClientRect();
      check(statusRect.top >= nameRect.bottom - 1, `status overlaps phone name: status.top=${statusRect.top} < name.bottom=${nameRect.bottom}`);
      const phoneButtons = all<HTMLElement>(".cs-org-phone-bar button").filter(visible);
      check(phoneButtons.length >= 2, `expected surrounding phone header buttons, got ${phoneButtons.length}`);
      for (const btn of phoneButtons) {
        const rect = btn.getBoundingClientRect();
        check(rect.width >= 44 && rect.height >= 44, `phone header button too small: ${rect.width}x${rect.height}`);
        check(rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
          `phone header button out of viewport: ${JSON.stringify({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })}`);
        const overlapsStatus = rect.left < statusRect.right - 1 && rect.right > statusRect.left + 1 &&
          rect.top < statusRect.bottom - 1 && rect.bottom > statusRect.top + 1;
        check(!overlapsStatus, `phone header button overlaps wrapped seat status`);
      }
    }
    check(document.documentElement.scrollWidth <= innerWidth, `horizontal overflow: ${document.documentElement.scrollWidth} > ${innerWidth}`);

    // On working flow, also verify human DM and #general omit [data-dm-seat-status], then return to agent DM.
    if (f.stateMode === "working" && new URL(location.href).searchParams.get("check_nav") === "1") {
      await openDrawerIfPhone();
      await click(`[data-rail-conversation="${f.ids.dmHumanConv}"]:visible`);
      await wait("human DM loaded without agent seat status", () =>
        (one("[data-feed-list]")?.textContent ?? "").includes("Direct message from Alex.") && !shown("[data-dm-seat-status]"),
      );
      await openDrawerIfPhone();
      await click('a[href*="c=general"]:visible');
      await wait("#general loaded without agent seat status", () =>
        location.search.includes("c=general") && !shown("[data-dm-seat-status]"),
      );
      await openDrawerIfPhone();
      await click(`[data-rail-conversation="${f.ids.dmAgentConv}"]:visible`);
      await wait("returned to agent DM with seat status restored", () =>
        (one("[data-feed-list]")?.textContent ?? "").includes("Checking the migration checklist now.") &&
        shown("[data-dm-seat-status]")?.dataset.dmSeatStatus === "working",
      );
    }

    document.documentElement.dataset.c2DmHeaderObservation = JSON.stringify({
      ok: true,
      seat: f.stateMode,
      kind: statusEl.dataset.dmSeatStatus,
      indicator: statusEl.dataset.indicator,
      text: (statusEl.textContent ?? "").trim(),
    });
  } catch (error) {
    document.documentElement.dataset.c2DmHeaderObservation = JSON.stringify({
      error: String(error),
      stage,
    });
  }
}

test("C2 1:1 agent DM header renders live seat status across states, widths, and themes without leaking private titles", { timeout: 120_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const c2Fixture = await compileFixtureFunction(new URL(import.meta.url), "installC2DmHeaderFixture");
  const observe = await compileFixtureFunction(new URL(import.meta.url), "observeC2DmHeader");
  const html = "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" + styles.join("\n") +
    "</style><script>" + install + c2Fixture + "</script></head><body>" + markup + "<script type='module'>" + observe + "</script></body></html>";
  const fonts = fileURLToPath(new URL("../../../public/fonts/", import.meta.url));
  let activePage: Page | null = null;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/__observer-tick") { setTimeout(() => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ now: Date.now() })); }, 2); return; }
    if (url.pathname === "/__click") { void activePage!.locator(url.searchParams.get("selector")!).first().click({ timeout: 8_000 }).then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
    if (url.pathname.startsWith("/fonts/") && url.pathname.endsWith(".woff2")) { void readFile(join(fonts, basename(url.pathname))).then(data => { response.writeHead(200, { "Content-Type": "font/woff2" }); response.end(data); }, () => { response.writeHead(404); response.end(); }); return; }
    response.writeHead(200, { "Content-Type": url.pathname === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
    response.end(url.pathname === "/app.js" ? bundled.join("\n") : html);
  });
  const browser = await launchPlaywrightChromium(chromium);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const evidence = join(process.cwd(), "../site-observer-evidence/c2-dm-header-seat-status");
    await mkdir(evidence, { recursive: true });
    const ws = "11111111-1111-4111-8111-111111111111";
    const dmAgent = "aaaa1111-1111-4111-8111-111111111111";
    const cases: { name: string; width: number; height: number; query: string; screenshot?: boolean }[] = [
      { name: "360x740-light-working", width: 360, height: 740, query: `w=${ws}&dm=${dmAgent}&theme=light&seat=working&check_nav=1`, screenshot: true },
      { name: "360x740-dark-working", width: 360, height: 740, query: `w=${ws}&dm=${dmAgent}&theme=dark&seat=working`, screenshot: true },
      { name: "1440x900-light-working", width: 1440, height: 900, query: `w=${ws}&dm=${dmAgent}&theme=light&seat=working&check_nav=1`, screenshot: true },
      { name: "1440x900-dark-working", width: 1440, height: 900, query: `w=${ws}&dm=${dmAgent}&theme=dark&seat=working`, screenshot: true },
      { name: "360x740-light-waiting", width: 360, height: 740, query: `w=${ws}&dm=${dmAgent}&theme=light&seat=waiting`, screenshot: true },
      { name: "360x740-light-turn-only", width: 360, height: 740, query: `w=${ws}&dm=${dmAgent}&theme=light&seat=turn-only`, screenshot: true },
      { name: "1440x900-light-waiting", width: 1440, height: 900, query: `w=${ws}&dm=${dmAgent}&theme=light&seat=waiting`, screenshot: true },
      { name: "1440x900-light-turn-only", width: 1440, height: 900, query: `w=${ws}&dm=${dmAgent}&theme=light&seat=turn-only`, screenshot: true },
      { name: "1440x900-light-not-listening", width: 1440, height: 900, query: `w=${ws}&dm=${dmAgent}&theme=light&seat=not-listening`, screenshot: true },
    ];
    const outcomes: Record<string, any> = {};
    for (const item of cases) {
      const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, hasTouch: item.width < 1024 });
      activePage = await context.newPage();
      try {
        await activePage.goto(`http://127.0.0.1:${address.port}/app?${item.query}`);
        await activePage.waitForFunction(() => !!document.documentElement.dataset.c2DmHeaderObservation, null, { timeout: 25_000 });
        const result = await activePage.evaluate(() => JSON.parse(document.documentElement.dataset.c2DmHeaderObservation!));
        outcomes[item.name] = result;
        if (item.screenshot) {
          await activePage.screenshot({ path: join(evidence, `${item.name}.png`), fullPage: false });
        }
      } catch (error) {
        outcomes[item.name] = { error: String(error) };
      } finally {
        await context.close();
        activePage = null;
      }
    }
    await writeFile(join(evidence, "results.json"), JSON.stringify(outcomes, null, 2));
    assert.deepEqual(Object.entries(outcomes).filter(([, outcome]) => !outcome.ok), [], JSON.stringify(outcomes));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
