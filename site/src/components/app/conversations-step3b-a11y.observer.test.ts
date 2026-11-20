/** Signed-in Step 3B accessibility, keyboard/Escape focus-return, 44 px target, and 360/390/1024/1440 light/dark audit. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";
import { chromium, type Page } from "playwright-core";
import { compileFixtureFunction, renderAstroFixture } from "../../../tests/astro-fixture";

function installStep3BA11yFixture() {
  const f = (window as any).existingFixture;
  const params = new URL(location.href).searchParams;
  f.scene = params.get("scene") ?? "rail";
  f.failConvReadCount = Number(params.get("fail_conv_read") ?? "0");
  f.failNextPreviewJoin = params.get("fail_join") === "1";
  f.convCommands = [] as any[];

  const opsChannel = "66666666-6666-4666-8666-666666666666";
  const designChannel = "77777777-7777-4777-8777-777777777777";
  const previewChannel = "88888888-8888-4888-8888-888888888888";
  const generalConv = "99990000-0000-4000-8000-000000000001";
  const opsConv = "99990000-0000-4000-8000-000000000002";
  const designConv = "99990000-0000-4000-8000-000000000003";
  const previewConv = "99990000-0000-4000-8000-000000000004";
  const dmStarredConv = "aaaa1111-1111-4111-8111-111111111111";
  const dmGroupConv = "bbbb2222-2222-4222-8222-222222222222";
  const dmMutedConv = "cccc3333-3333-4333-8333-333333333333";
  const peerAlex = "dddd4444-4444-4444-8444-444444444444";
  const peerLead = "eeee5555-5555-4555-8555-555555555555";
  const peerBot = "ffff6666-6666-4666-8666-666666666666";

  f.ids = { opsChannel, designChannel, previewChannel, opsConv, designConv, previewConv, dmStarredConv, dmGroupConv, dmMutedConv };

  const makeChannel = (id: string, slug: string, purpose: string) => ({
    channel_id: id, workspace_id: f.workspace, slug, purpose,
    created_by_principal: f.owner, created_by_kind: "user",
    created_at: "2026-11-01T00:00:00Z", archived_at: null, visibility: "open",
  });
  f.channelRows = [
    makeChannel(opsChannel, "ops", "Release coordination and deploys."),
    makeChannel(designChannel, "design", "Design reviews and UI specs."),
    makeChannel(previewChannel, "preview-only", "Open public channel you have not joined yet."),
  ];
  f.conversations = [
    {
      conversation_id: generalConv, kind: "general", channel_id: null, slug: "general", description: null,
      archived_at: null, joined: true, generation: 0, lead_mode: "workspace", lead_agent_principal_id: null,
      members: [], notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: "2026-11-19T14:00:00Z", last_message_id: null,
    },
    {
      conversation_id: opsConv, kind: "public_channel", channel_id: opsChannel, slug: "ops",
      description: "Release coordination and deploys.", archived_at: null, joined: true, generation: 0,
      lead_mode: "workspace", lead_agent_principal_id: null, members: [], notify_level: "everything",
      starred: false, star_rank: null, read_through_at: null, read_through_id: null,
      unread_count: 3, mention_count: 2, last_message_at: "2026-11-19T15:10:00Z", last_message_id: null,
    },
    {
      conversation_id: designConv, kind: "public_channel", channel_id: designChannel, slug: "design",
      description: "Design reviews and UI specs.", archived_at: null, joined: false, generation: 0,
      lead_mode: "workspace", lead_agent_principal_id: null, members: [], notify_level: "everything",
      starred: false, star_rank: null, read_through_at: null, read_through_id: null,
      unread_count: 0, mention_count: 0, last_message_at: "2026-11-19T15:00:00Z", last_message_id: null,
    },
    {
      conversation_id: previewConv, kind: "public_channel", channel_id: previewChannel, slug: "preview-only",
      description: "Open public channel you have not joined yet.", archived_at: null, joined: false, generation: 0,
      lead_mode: "workspace", lead_agent_principal_id: null, members: [], notify_level: "everything",
      starred: false, star_rank: null, read_through_at: null, read_through_id: null,
      unread_count: 0, mention_count: 0, last_message_at: "2026-11-19T14:30:00Z", last_message_id: null,
    },
    {
      conversation_id: dmStarredConv, kind: "dm", channel_id: null, slug: null, description: null,
      archived_at: null, joined: true, generation: 1, lead_mode: null, lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "agent", id: peerLead, name: "Lead", left_at: null },
      ],
      notify_level: "everything", starred: true, star_rank: 1,
      read_through_at: null, read_through_id: null, unread_count: 1, mention_count: 0,
      last_message_at: "2026-11-19T15:25:00Z", last_message_id: null,
    },
    {
      conversation_id: dmGroupConv, kind: "group_dm", channel_id: null, slug: null, description: null,
      archived_at: null, joined: true, generation: 1, lead_mode: null, lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "user", id: peerAlex, name: "Alex", left_at: null },
        { kind: "agent", id: peerLead, name: "Lead", left_at: null },
      ],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 4, mention_count: 1,
      last_message_at: "2026-11-19T15:20:00Z", last_message_id: null,
    },
    {
      conversation_id: dmMutedConv, kind: "dm", channel_id: null, slug: null, description: null,
      archived_at: null, joined: true, generation: 1, lead_mode: null, lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "agent", id: peerBot, name: "Archive Bot", left_at: null },
      ],
      notify_level: "muted", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 9, mention_count: 2,
      last_message_at: "2026-11-19T13:00:00Z", last_message_id: null,
    },
  ];

  const previous = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.test.invalid") return previous(input, init);
    if (url.pathname === "/rest/v1/channels") {
      return Response.json(url.searchParams.get("workspace_id") === `eq.${f.workspace}` ? f.channelRows : []);
    }
    if (url.pathname === "/rest/v1/member_profiles") {
      return Response.json([
        { user_id: f.owner, display_name: "Synthetic owner", role: "owner" },
        { user_id: peerAlex, display_name: "Alex", role: "member" },
      ]);
    }
    if (url.pathname === "/rest/v1/agent_principals") {
      if (url.searchParams.get("revoked_at") !== "is.null") return Response.json([]);
      return Response.json([
        { principal_id: peerLead, name: "Lead", model: "Claude", transport: "local", turn_only: false, owner_user_id: f.owner, revoked_at: null, workspace_id: f.workspace, created_at: "2026-11-01T00:00:00Z" },
        { principal_id: peerBot, name: "Archive Bot", model: "Claude", transport: "local", turn_only: false, owner_user_id: f.owner, revoked_at: null, workspace_id: f.workspace, created_at: "2026-11-01T00:00:00Z" },
      ]);
    }
    if (url.pathname === "/rest/v1/rpc/channel_unread") {
      return Response.json({
        workspace_id: f.workspace, generated_at: new Date().toISOString(),
        channels: [
          { channel_id: null, slug: "general", unread: false, starred: false, star_rank: null },
          ...f.channelRows.map((row: any) => ({
            channel_id: row.channel_id,
            slug: row.slug,
            unread: row.channel_id === opsChannel,
            starred: row.channel_id === opsChannel,
            star_rank: row.channel_id === opsChannel ? 1 : null,
          })),
        ],
      });
    }
    if (url.pathname === "/functions/v1/read" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      if (body?.resource === "conversations") {
        if (f.failConvReadCount > 0) {
          f.failConvReadCount -= 1;
          return Response.json({ error: "service_unavailable", message: "Couldn't check channel membership." }, { status: 503 });
        }
        return Response.json({ conversations: f.conversations });
      }
    }
    if (url.pathname === "/functions/v1/command" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      const command = body?.command;
      if (command?.kind && String(command.kind).startsWith("conversation_")) {
        f.convCommands.push(command);
        if (command.kind === "conversation_join" && f.failNextPreviewJoin) {
          f.failNextPreviewJoin = false;
          return Response.json({ error: "service_unavailable", message: "Network timeout." }, { status: 503 });
        }
        return Response.json({ status: "accepted", conversation_id: command.conversation_id, changed: true });
      }
      if (command?.kind === "signals_seen") return Response.json({ status: "accepted" });
    }
    return previous(input, init);
  };
}

async function observeStep3BA11y() {
  const f = (window as any).existingFixture;
  const one = <T extends Element>(selector: string) => document.querySelector<T>(selector);
  const visible = (el: Element | null): el is HTMLElement => !!el && !el.closest("[hidden]") && el.getClientRects().length > 0;
  const shown = <T extends HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)].find(visible) ?? null;
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  let stage = "boot";
  const wait = async (name: string, ready: () => unknown) => {
    stage = name;
    const now = async () => (await (await fetch("/__observer-tick")).json()).now;
    const until = await now() + 10_000;
    while (!ready()) { if (await now() > until) throw new Error("timed out at " + name); }
  };
  const click = async (selector: string) => {
    const response = await fetch(`/__click?selector=${encodeURIComponent(selector)}`);
    check(response.ok, "click failed (" + selector + "): " + await response.text());
  };
  const key = async (name: string) => {
    const response = await fetch(`/__key?key=${encodeURIComponent(name)}`);
    check(response.ok, "key failed (" + name + "): " + await response.text());
  };
  const openDrawerIfPhone = async () => {
    if (!visible(shown("[data-home-all-channels]"))) {
      await click('button[aria-label="Open navigation"]:visible');
      await wait("phone drawer open", () => visible(shown("[data-home-all-channels]")));
    }
  };
  const measureSmallTargets = (root: Element, minSize = 44) => {
    const small: { selector: string; w: number; h: number }[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("a[href], button, input:not([type=hidden]), select, textarea, [role=menuitem]")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < minSize || r.height < minSize) {
        small.push({
          selector: `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).trim().split(/\s+/).slice(0, 2).join(".") : ""}[${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 32)}]`,
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }
    }
    return small;
  };

  try {
    await document.fonts.ready;
    const waitVisible = async (label: string, selector: string): Promise<Element> => {
      await wait(label, () => visible(one(selector)));
      return one(selector)!;
    };

    if (f.scene === "membership-retry") {
      const root = await waitVisible("membership retry visible", "[data-channel-membership-retry-bar]");
      document.documentElement.dataset.step3bA11y = JSON.stringify({
        ok: true,
        scene: f.scene,
        axeRoot: "[data-channel-membership-retry-bar]",
        overflow: document.documentElement.scrollWidth > innerWidth,
        smallTargets: measureSmallTargets(root),
      });
      return;
    }

    await wait("step 2b rail ready", () => one("live-dashboard")?.getAttribute("data-state") === "channel" &&
      !!one("[data-home-dms]") && !!one(`[data-rail-conversation="${f.ids.dmGroupConv}"]`));

    if (f.scene === "rail-menu") {
      await openDrawerIfPhone();
      const triggerSel = `[data-rail-conversation-menu="${f.ids.dmGroupConv}"]:visible`;
      await click(triggerSel);
      await wait("rail context menu open", () => visible(one(".cs-context-menu")));
      const menu = one(".cs-context-menu")!;
      // Focus the destructive item so axe-core also verifies hover/focus background contrast:
      menu.querySelector<HTMLElement>("[data-danger]")?.focus();
      const smallTargets = measureSmallTargets(menu, innerWidth <= 1024 ? 44 : 24);
      const axeRoot = ".cs-context-menu";
      document.documentElement.dataset.step3bA11y = JSON.stringify({
        ok: true,
        scene: f.scene,
        axeRoot,
        overflow: document.documentElement.scrollWidth > innerWidth,
        smallTargets,
      });
      return;
    }

    if (f.scene === "rail-menu-escape") {
      await openDrawerIfPhone();
      const triggerSel = `[data-rail-conversation-menu="${f.ids.dmGroupConv}"]:visible`;
      await click(triggerSel);
      await wait("rail context menu open", () => visible(one(".cs-context-menu")));
      await key("Escape");
      await wait("rail context menu closed", () => !one(".cs-context-menu"));
      const activeAttr = document.activeElement?.getAttribute("data-rail-conversation-menu");
      document.documentElement.dataset.step3bA11y = JSON.stringify({
        ok: activeAttr === f.ids.dmGroupConv,
        scene: f.scene,
        returnedTo: document.activeElement?.outerHTML.slice(0, 180) ?? null,
        error: activeAttr === f.ids.dmGroupConv ? undefined : `Escape from rail context menu left focus on ${document.activeElement?.outerHTML.slice(0, 160)}`,
      });
      return;
    }

    if (f.scene === "directory") {
      await openDrawerIfPhone();
      await click("[data-home-all-channels]:visible");
      await wait("directory open", () => one<HTMLDialogElement>("[data-channel-directory]")?.open === true);
      await document.fonts.ready;
      const dialog = one("[data-channel-directory]")!;
      document.documentElement.dataset.step3bA11y = JSON.stringify({
        ok: true,
        scene: f.scene,
        axeRoot: "[data-channel-directory]",
        overflow: document.documentElement.scrollWidth > innerWidth,
        smallTargets: measureSmallTargets(dialog),
      });
      return;
    }

    if (f.scene === "directory-escape") {
      await openDrawerIfPhone();
      await click("[data-home-all-channels]:visible");
      await wait("directory open", () => one<HTMLDialogElement>("[data-channel-directory]")?.open === true);
      await key("Escape");
      await wait("directory closed", () => one<HTMLDialogElement>("[data-channel-directory]")?.open === false);
      const active = document.activeElement;
      const okReturn = !!active && (active.hasAttribute("data-home-all-channels") || active.getAttribute("aria-label") === "Open navigation");
      document.documentElement.dataset.step3bA11y = JSON.stringify({
        ok: okReturn,
        scene: f.scene,
        returnedTo: active?.outerHTML.slice(0, 180) ?? null,
        error: okReturn ? undefined : `Escape from All channels left focus on ${active?.outerHTML.slice(0, 160)}`,
      });
      return;
    }

    if (f.scene === "preview" || f.scene === "preview-retry") {
      await waitVisible("preview bar visible", "[data-channel-preview-bar]");
      if (f.scene === "preview-retry") {
        await click("[data-channel-preview-join]:visible");
        await wait("preview retry state", () => one("[data-channel-preview-join]")?.textContent === "Retry");
      }
      const bar = await waitVisible("preview bar settled", "[data-channel-preview-bar]");
      document.documentElement.dataset.step3bA11y = JSON.stringify({
        ok: true,
        scene: f.scene,
        axeRoot: "[data-channel-preview-bar]",
        overflow: document.documentElement.scrollWidth > innerWidth,
        smallTargets: measureSmallTargets(bar),
      });
      return;
    }

    if (f.scene === "group-leave") {
      await openDrawerIfPhone();
      await click(`[data-rail-conversation-menu="${f.ids.dmGroupConv}"]:visible`);
      await wait("group dm menu open", () => visible(one(".cs-context-menu")));
      await click('.cs-context-menu__item:has-text("Leave group")');
      await wait("group leave confirm open", () => one<HTMLDialogElement>("[data-group-leave-dialog]")?.open === true);
      await document.fonts.ready;
      const dialog = one("[data-group-leave-dialog]")!;
      document.documentElement.dataset.step3bA11y = JSON.stringify({
        ok: true,
        scene: f.scene,
        axeRoot: "[data-group-leave-dialog]",
        overflow: document.documentElement.scrollWidth > innerWidth,
        smallTargets: measureSmallTargets(dialog),
      });
      return;
    }

    if (f.scene === "group-leave-escape") {
      await openDrawerIfPhone();
      await click(`[data-rail-conversation-menu="${f.ids.dmGroupConv}"]:visible`);
      await wait("group dm menu open", () => visible(one(".cs-context-menu")));
      await click('.cs-context-menu__item:has-text("Leave group")');
      await wait("group leave confirm open", () => one<HTMLDialogElement>("[data-group-leave-dialog]")?.open === true);
      await key("Escape");
      await wait("group leave confirm closed", () => one<HTMLDialogElement>("[data-group-leave-dialog]")?.open === false);
      const active = document.activeElement;
      const okReturn = !!active && active !== document.body && (
        active.getAttribute("data-rail-conversation-menu") === f.ids.dmGroupConv ||
        active.getAttribute("data-rail-conversation") === f.ids.dmGroupConv ||
        active.getAttribute("aria-label") === "Open navigation"
      );
      document.documentElement.dataset.step3bA11y = JSON.stringify({
        ok: okReturn && f.convCommands.length === 0,
        scene: f.scene,
        returnedTo: active?.outerHTML.slice(0, 180) ?? null,
        commands: f.convCommands.length,
        error: okReturn ? undefined : `Escape from Group leave dialog left focus on ${active?.outerHTML.slice(0, 160)}`,
      });
      return;
    }

    // Default scene: full rail (Starred + Channels + Direct messages)
    await openDrawerIfPhone();
    await wait("starred section visible", () => !!one("[data-home-starred]"));
    await document.fonts.ready;
    const rail = shown<HTMLElement>(".hm-rail") ?? one<HTMLElement>("nav") ?? document.body;
    document.documentElement.dataset.step3bA11y = JSON.stringify({
      ok: true,
      scene: "rail",
      axeRoot: ".hm-rail",
      overflow: document.documentElement.scrollWidth > innerWidth,
      smallTargets: measureSmallTargets(rail, innerWidth <= 1024 ? 44 : 24),
    });
  } catch (error) {
    document.documentElement.dataset.step3bA11y = JSON.stringify({
      ok: false,
      stage,
      error: String(error),
      active: document.activeElement?.outerHTML.slice(0, 200),
    });
  }
}

test("Step 3B accessibility, Escape focus-return, 44 px target, and light/dark parity audit", { timeout: 300_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const fixture = await compileFixtureFunction(new URL(import.meta.url), "installStep3BA11yFixture");
  const observe = await compileFixtureFunction(new URL(import.meta.url), "observeStep3BA11y");
  const axeSource = await readFile(fileURLToPath(new URL("../../../node_modules/axe-core/axe.min.js", import.meta.url)), "utf8");
  const html = "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" + styles.join("\n") +
    "</style><script>" + install + fixture + "</script></head><body>" + markup + "<script type='module'>" + observe + "</script></body></html>";
  const fonts = fileURLToPath(new URL("../../../public/fonts/", import.meta.url));
  let activePage: Page | null = null;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/__observer-tick") { setTimeout(() => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ now: Date.now() })); }, 2); return; }
    if (url.pathname === "/__click") { void activePage!.locator(url.searchParams.get("selector")!).first().click().then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
    if (url.pathname === "/__key") { void activePage!.keyboard.press(url.searchParams.get("key")!).then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
    if (url.pathname.startsWith("/fonts/") && url.pathname.endsWith(".woff2")) { void readFile(join(fonts, basename(url.pathname))).then(data => { response.writeHead(200, { "Content-Type": "font/woff2" }); response.end(data); }, () => { response.writeHead(404); response.end(); }); return; }
    response.writeHead(200, { "Content-Type": url.pathname === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
    response.end(url.pathname === "/app.js" ? bundled.join("\n") : html);
  });
  const browser = await launchPlaywrightChromium(chromium);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const evidence = process.env.STEP3B_A11Y_DIR || join(process.cwd(), "../site-observer-evidence/conversations-step3b-a11y");
    await mkdir(evidence, { recursive: true });
    const ws = "11111111-1111-4111-8111-111111111111";
    const previewCh = "88888888-8888-4888-8888-888888888888";
    const cases: { name: string; width: number; height: number; query: string; screenshot?: boolean }[] = [
      // Light & dark across phone (360, 390) and desktop (1024, 1440):
      ...(["light", "dark"] as const).flatMap(theme => [
        { name: `1440x900-${theme}-rail`, width: 1440, height: 900, query: `w=${ws}&c=general&theme=${theme}&scene=rail`, screenshot: true },
        { name: `1024x768-${theme}-rail-menu`, width: 1024, height: 768, query: `w=${ws}&c=general&theme=${theme}&scene=rail-menu`, screenshot: true },
        { name: `360x740-${theme}-rail`, width: 360, height: 740, query: `w=${ws}&c=general&theme=${theme}&scene=rail`, screenshot: true },
        { name: `390x844-${theme}-rail-menu`, width: 390, height: 844, query: `w=${ws}&c=general&theme=${theme}&scene=rail-menu`, screenshot: true },
        { name: `1440x900-${theme}-directory`, width: 1440, height: 900, query: `w=${ws}&c=general&theme=${theme}&scene=directory`, screenshot: true },
        { name: `360x740-${theme}-directory`, width: 360, height: 740, query: `w=${ws}&c=general&theme=${theme}&scene=directory`, screenshot: true },
        { name: `1440x900-${theme}-preview`, width: 1440, height: 900, query: `w=${ws}&c=${previewCh}&theme=${theme}&scene=preview`, screenshot: true },
        { name: `390x844-${theme}-preview-retry`, width: 390, height: 844, query: `w=${ws}&c=${previewCh}&theme=${theme}&scene=preview-retry&fail_join=1`, screenshot: true },
        { name: `1024x768-${theme}-group-leave`, width: 1024, height: 768, query: `w=${ws}&c=general&theme=${theme}&scene=group-leave`, screenshot: true },
        { name: `360x740-${theme}-group-leave`, width: 360, height: 740, query: `w=${ws}&c=general&theme=${theme}&scene=group-leave`, screenshot: true },
        { name: `390x844-${theme}-membership-retry`, width: 390, height: 844, query: `w=${ws}&c=${previewCh}&theme=${theme}&scene=membership-retry&fail_conv_read=99`, screenshot: true },
      ]),
      // Keyboard Escape focus-return witnesses (desktop & phone):
      { name: "1024x768-rail-menu-escape", width: 1024, height: 768, query: `w=${ws}&c=general&theme=light&scene=rail-menu-escape` },
      { name: "360x740-rail-menu-escape", width: 360, height: 740, query: `w=${ws}&c=general&theme=light&scene=rail-menu-escape` },
      { name: "1024x768-directory-escape", width: 1024, height: 768, query: `w=${ws}&c=general&theme=light&scene=directory-escape` },
      { name: "360x740-directory-escape", width: 360, height: 740, query: `w=${ws}&c=general&theme=light&scene=directory-escape` },
      { name: "1024x768-group-leave-escape", width: 1024, height: 768, query: `w=${ws}&c=general&theme=light&scene=group-leave-escape` },
      { name: "360x740-group-leave-escape", width: 360, height: 740, query: `w=${ws}&c=general&theme=light&scene=group-leave-escape` },
    ];
    const report: Record<string, any> = {};
    for (const item of cases) {
      const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, hasTouch: item.width < 1024 });
      activePage = await context.newPage();
      try {
        await activePage.goto(`http://127.0.0.1:${address.port}/app?${item.query}`);
        await activePage.waitForFunction(() => !!document.documentElement.dataset.step3bA11y, null, { timeout: 30_000 });
        const result = await activePage.evaluate(() => JSON.parse(document.documentElement.dataset.step3bA11y!));
        if (result.axeRoot) {
          await activePage.addScriptTag({ content: axeSource });
          const axeRes = await activePage.evaluate(async (sel: string) => {
            const visibleNodes = [...document.querySelectorAll(sel)].filter(el => !el.closest("[hidden]") && el.getClientRects().length > 0);
            const target = visibleNodes[0] ?? document.querySelector(sel) ?? document.body;
            return (window as any).axe.run(target, {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
            });
          }, result.axeRoot);
          result.axeViolations = axeRes.violations.map((v: any) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            nodes: v.nodes.map((n: any) => ({ html: n.html.slice(0, 180), summary: n.failureSummary?.slice(0, 200) })).slice(0, 5),
          }));
        }
        report[item.name] = result;
        if (item.screenshot) {
          await activePage.screenshot({ path: join(evidence, `${item.name}.png`), fullPage: false });
        }
      } catch (error) {
        report[item.name] = { ok: false, error: String(error) };
      } finally {
        await context.close();
        activePage = null;
      }
    }
    await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
    const failures = Object.entries(report).filter(([, r]) => !r.ok || r.overflow || (r.axeViolations?.length ?? 0) > 0 || (r.smallTargets?.length ?? 0) > 0);
    assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
