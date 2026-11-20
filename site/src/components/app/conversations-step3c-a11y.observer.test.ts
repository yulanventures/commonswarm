/** Signed-in Step 3C accessibility, keyboard/Escape focus-return, 44 px target, and 360/390/844/1024/1440 light/dark audit. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";
import { chromium, type Page } from "playwright-core";
import { compileFixtureFunction, renderAstroFixture } from "../../../tests/astro-fixture";

function installStep3CA11yFixture() {
  const f = (window as any).existingFixture;
  const params = new URL(location.href).searchParams;
  f.scene = params.get("scene") ?? "picker-chips";
  f.convCommands = [] as any[];
  f.removeCommands = [] as any[];

  const opsChannel = "66666666-6666-4666-8666-666666666666";
  const generalConv = "99990000-0000-4000-8000-000000000001";
  const opsConv = "99990000-0000-4000-8000-000000000002";
  const dmGroupConv = "bbbb2222-2222-4222-8222-222222222222";
  const peerAlex = "dddd4444-4444-4444-8444-444444444444";
  const peerSam = "dddd5555-5555-4555-8555-555555555555";
  const peerLead = "eeee5555-5555-4555-8555-555555555555";
  const peerBot = "ffff6666-6666-4666-8666-666666666666";

  f.ids = { opsChannel, opsConv, dmGroupConv, peerAlex, peerSam, peerLead, peerBot };
  f.channelRows = [
    {
      channel_id: opsChannel, workspace_id: f.workspace, slug: "ops",
      purpose: "Release coordination and deploys.", created_by_principal: f.owner,
      created_by_kind: "user", created_at: "2026-11-01T00:00:00Z",
      archived_at: null, visibility: "open",
    },
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
      lead_mode: "workspace", lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "user", id: peerAlex, name: "Alex", left_at: null },
        { kind: "agent", id: peerLead, name: "Lead", left_at: null },
      ],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: "2026-11-19T15:10:00Z", last_message_id: null,
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
      read_through_at: null, read_through_id: null, unread_count: 1, mention_count: 0,
      last_message_at: "2026-11-19T15:20:00Z", last_message_id: null,
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
    if (url.pathname === "/rest/v1/channel_members") return Response.json([]);
    if (url.pathname === "/rest/v1/member_profiles") {
      return Response.json([
        { user_id: f.owner, display_name: "Synthetic owner", role: "owner" },
        { user_id: peerAlex, display_name: "Alex", role: "member" },
        { user_id: peerSam, display_name: "Sam", role: "member" },
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
          { channel_id: null, slug: "general", unread: false },
          ...f.channelRows.map((row: any) => ({ channel_id: row.channel_id, slug: row.slug, unread: false })),
        ],
      });
    }
    if (url.pathname === "/functions/v1/read" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      if (body?.resource === "conversations") return Response.json({ conversations: f.conversations });
    }
    if (url.pathname === "/functions/v1/command" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      const command = body?.command;
      if (command?.kind === "conversation_open") {
        f.convCommands.push(command);
        return Response.json(
          { error: "conversation_member_left", message: "Alex left this group. To include everyone again, start a new group." },
          { status: 409 },
        );
      }
      if (command?.kind === "conversation_remove") {
        f.removeCommands.push(command);
        return Response.json({ status: "accepted", conversation_id: command.conversation_id });
      }
    }
    return previous(input, init);
  };
}

async function observeStep3CA11y() {
  const f = (window as any).existingFixture;
  const tick = () => fetch("/__observer-tick");
  const click = async (selector: string) => {
    const res = await fetch(`/__click?selector=${encodeURIComponent(selector)}`);
    if (!res.ok) throw new Error(`click failed (${selector}): ${await res.text()}`);
  };
  const key = async (name: string) => {
    const res = await fetch(`/__key?key=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`key failed (${name}): ${await res.text()}`);
  };
  const tapPoint = async (x: number, y: number) => {
    const res = await fetch(`/__tap?x=${encodeURIComponent(String(x))}&y=${encodeURIComponent(String(y))}`);
    if (!res.ok) throw new Error(`tap failed (${x},${y}): ${await res.text()}`);
  };
  const one = <T extends Element>(s: string) => document.querySelector<T>(s);
  const visible = (el: Element | null) => !!el && !el.closest("[hidden]") && el.getClientRects().length > 0;
  let stage = "boot";
  const wait = async (label: string, testFn: () => boolean, limit = 8000) => {
    stage = label;
    const end = Date.now() + limit;
    while (Date.now() < end) {
      if (testFn()) return;
      await tick();
    }
    throw new Error(`timed out: ${label}`);
  };
  const openDrawerIfPhone = async () => {
    if (innerWidth <= 832 && !one("dialog.cs-org-drawer[open]")) {
      await click('button[aria-label="Open navigation"]:visible');
      await wait("drawer open", () => !!one("dialog.cs-org-drawer[open]"));
    }
  };
  const measureSmallTargets = (root: Element, minPx: number) => {
    const issues: { selector: string; width: number; height: number }[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [role='menuitem']")) {
      if (!visible(el) || (el as HTMLButtonElement).disabled) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width + 0.5 < minPx || r.height + 0.5 < minPx) {
        issues.push({
          selector: `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).trim().replace(/\s+/g, ".") : ""}`,
          width: Math.round(r.width * 10) / 10,
          height: Math.round(r.height * 10) / 10,
        });
      }
    }
    return issues;
  };
  const measureTransparentBorders = (root: Element) => {
    const missing: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>(".dashboard__button--secondary, .cm-picker-chip, .cm-picker-badge")) {
      if (!visible(el)) continue;
      const border = getComputedStyle(el).borderTopColor;
      if (!border || border === "rgba(0, 0, 0, 0)" || border === "transparent") {
        missing.push(`${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/\s+/g, ".")}`);
      }
    }
    return missing;
  };
  const openMembersSheet = async () => {
    if (visible(one("[data-conversation-members-open]"))) {
      await click("[data-conversation-members-open]:visible");
    } else {
      await openDrawerIfPhone();
      await click(".hm-menu__trigger:visible");
      await wait("ws menu open", () => visible(one("[data-menu-conversation-members]")));
      await click("[data-menu-conversation-members]:visible");
    }
    await wait("members dialog open", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === true);
  };

  try {
    await import("/app.js");
    await document.fonts.ready;
    await wait("channel loaded", () => one("live-dashboard")?.getAttribute("data-state") === "channel" &&
      (one("live-dashboard")?.getAttribute("data-channel-view") === "feed" || one("live-dashboard")?.getAttribute("data-channel-view") === "feed-empty"));
    await wait("conversations settled", () => !!one(`[data-rail-conversation="${f.ids.dmGroupConv}"]`));

    if (f.scene === "picker-chips" || f.scene === "picker-409-restart") {
      await openDrawerIfPhone();
      await click("[data-home-new-dm]:visible");
      await wait("picker dialog open", () => one<HTMLDialogElement>("[data-conversation-picker-dialog]")?.open === true);
      await click(`[data-conversation-picker-option="user:${f.ids.peerAlex}"]:visible`);
      await click(`[data-conversation-picker-option="agent:${f.ids.peerLead}"]:visible`);
      await wait("two chips rendered", () => document.querySelectorAll("[data-conversation-picker-chip]").length === 2);
      if (f.scene === "picker-409-restart") {
        await click("[data-conversation-picker-submit]:visible");
        await wait("409 restart button shown", () => visible(one("[data-conversation-picker-restart]")) && visible(one("[data-conversation-picker-error]")));
      }
      const dialog = one<HTMLDialogElement>("[data-conversation-picker-dialog]")!;
      const rect = dialog.getBoundingClientRect();
      document.documentElement.dataset.step3cA11y = JSON.stringify({
        ok: rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1,
        scene: f.scene,
        axeRoot: "[data-conversation-picker-dialog][open]",
        overflow: document.documentElement.scrollWidth > innerWidth || dialog.scrollWidth > dialog.clientWidth + 1,
        smallTargets: measureSmallTargets(dialog, 44),
        transparentBorders: measureTransparentBorders(dialog),
      });
      return;
    }

    if (f.scene === "picker-escape") {
      await openDrawerIfPhone();
      await click("[data-home-new-dm]:visible");
      await wait("picker dialog open", () => one<HTMLDialogElement>("[data-conversation-picker-dialog]")?.open === true);
      await key("Escape");
      await wait("picker dialog closed", () => one<HTMLDialogElement>("[data-conversation-picker-dialog]")?.open === false);
      const active = document.activeElement;
      const okReturn = !!active && active !== document.body && (
        active.hasAttribute("data-home-new-dm") ||
        active.getAttribute("aria-label") === "Open navigation"
      );
      document.documentElement.dataset.step3cA11y = JSON.stringify({
        ok: okReturn && f.convCommands.length === 0,
        scene: f.scene,
        returnedTo: active?.outerHTML.slice(0, 180) ?? null,
        error: okReturn ? undefined : `Escape from New message picker left focus on ${active?.outerHTML.slice(0, 160)}`,
      });
      return;
    }

    if (f.scene === "members-add" || f.scene === "members-remove-confirm") {
      await openMembersSheet();
      if (f.scene === "members-add") {
        await click("[data-conversation-members-add-toggle]:visible");
        await wait("add panel open", () => visible(one("[data-conversation-members-add-panel]")));
        await click(`[data-conversation-members-candidate="user:${f.ids.peerSam}"]:visible`);
        await wait("add (1) ready", () => one("[data-conversation-members-add-submit]")?.textContent?.includes("Add (1)") === true);
      } else {
        await click(`[data-conversation-member-remove="user:${f.ids.peerAlex}"]:visible`);
        await wait("remove confirm visible", () => visible(one(`[data-conversation-member-confirm="user:${f.ids.peerAlex}"]`)));
      }
      const dialog = one<HTMLDialogElement>("[data-conversation-members-dialog]")!;
      const rect = dialog.getBoundingClientRect();
      document.documentElement.dataset.step3cA11y = JSON.stringify({
        ok: rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1,
        scene: f.scene,
        axeRoot: "[data-conversation-members-dialog][open]",
        overflow: document.documentElement.scrollWidth > innerWidth || dialog.scrollWidth > dialog.clientWidth + 1,
        smallTargets: measureSmallTargets(dialog, 44),
        transparentBorders: measureTransparentBorders(dialog),
      });
      return;
    }

    if (f.scene === "members-readonly") {
      await openDrawerIfPhone();
      await click(`[data-rail-conversation="${f.ids.dmGroupConv}"]:visible`);
      await wait("group dm open", () => !one("dialog.cs-org-drawer[open]") && (one(".hm-ws-header__title")?.textContent ?? "").includes("Alex"));
      await openMembersSheet();
      const dialog = one<HTMLDialogElement>("[data-conversation-members-dialog]")!;
      document.documentElement.dataset.step3cA11y = JSON.stringify({
        ok: !visible(one("[data-conversation-members-add-toggle]")) && document.querySelectorAll("[data-conversation-member-remove]").length === 0,
        scene: f.scene,
        axeRoot: "[data-conversation-members-dialog][open]",
        overflow: document.documentElement.scrollWidth > innerWidth || dialog.scrollWidth > dialog.clientWidth + 1,
        smallTargets: measureSmallTargets(dialog, 44),
        transparentBorders: measureTransparentBorders(dialog),
      });
      return;
    }

    if (f.scene === "members-escape") {
      await openMembersSheet();
      await key("Escape");
      await wait("members dialog closed", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === false);
      const active = document.activeElement;
      const okReturn = !!active && active !== document.body && (
        active.hasAttribute("data-conversation-members-open") ||
        active.classList.contains("hm-menu__trigger") ||
        active.getAttribute("aria-label") === "Open navigation"
      );
      document.documentElement.dataset.step3cA11y = JSON.stringify({
        ok: okReturn,
        scene: f.scene,
        returnedTo: active?.outerHTML.slice(0, 180) ?? null,
        error: okReturn ? undefined : `Escape from Members sheet left focus on ${active?.outerHTML.slice(0, 160)}`,
      });
      return;
    }

    if (f.scene === "members-remove-double-tap") {
      await openMembersSheet();
      const targetKey = `user:${f.ids.peerAlex}`;
      const openerSel = `[data-conversation-member-remove="${targetKey}"]`;
      const cancelSel = `[data-conversation-member-remove-cancel="${targetKey}"]`;
      const confirmSel = `[data-conversation-member-remove-confirm="${targetKey}"]`;
      const opener = one<HTMLButtonElement>(openerSel)!;
      const openerRect = opener.getBoundingClientRect();
      const probes = [
        { name: "center", x: (openerRect.left + openerRect.right) / 2, y: (openerRect.top + openerRect.bottom) / 2 },
        { name: "left-edge", x: openerRect.left + 2, y: (openerRect.top + openerRect.bottom) / 2 },
        { name: "right-edge", x: openerRect.right - 2, y: (openerRect.top + openerRect.bottom) / 2 },
        { name: "top-edge", x: (openerRect.left + openerRect.right) / 2, y: openerRect.top + 2 },
        { name: "bottom-edge", x: (openerRect.left + openerRect.right) / 2, y: openerRect.bottom - 2 },
      ];
      let focusOnCancel = true;
      let disjointFromConfirm = true;
      for (const probe of probes) {
        await click(`${openerSel}:visible`);
        await wait(`confirm open (${probe.name})`, () => visible(one(confirmSel)));
        const cancelBtn = one<HTMLButtonElement>(cancelSel)!;
        const confirmBtn = one<HTMLButtonElement>(confirmSel)!;
        if (document.activeElement !== cancelBtn) focusOnCancel = false;
        const cRect = confirmBtn.getBoundingClientRect();
        const overlaps = !(cRect.right <= openerRect.left || cRect.left >= openerRect.right || cRect.bottom <= openerRect.top || cRect.top >= openerRect.bottom);
        if (overlaps) disjointFromConfirm = false;
        await tapPoint(probe.x, probe.y);
        await tick();
        if (visible(one(confirmSel))) {
          await click(`${cancelSel}:visible`);
          await wait(`confirm closed (${probe.name})`, () => !one(confirmSel));
        } else {
          await wait(`opener restored (${probe.name})`, () => visible(one(openerSel)));
        }
      }
      const removalsAfterRepeatedTaps = f.removeCommands.length;
      // Now deliberately confirm removal once and verify exactly one removal command is sent.
      await click(`${openerSel}:visible`);
      await wait("confirm open for deliberate tap", () => visible(one(confirmSel)));
      const confirmRect = one<HTMLButtonElement>(confirmSel)!.getBoundingClientRect();
      await tapPoint((confirmRect.left + confirmRect.right) / 2, (confirmRect.top + confirmRect.bottom) / 2);
      await wait("deliberate removal completed", () => f.removeCommands.length === 1 && !one(`[data-conversation-member-row="${targetKey}"]`));
      document.documentElement.dataset.step3cA11y = JSON.stringify({
        ok: focusOnCancel && disjointFromConfirm && removalsAfterRepeatedTaps === 0 && f.removeCommands.length === 1,
        scene: f.scene,
        focusOnCancel,
        disjointFromConfirm,
        removalsAfterRepeatedTaps,
        deliberateRemovals: f.removeCommands.length,
      });
      return;
    }

    throw new Error(`unknown scene: ${f.scene}`);
  } catch (error) {
    document.documentElement.dataset.step3cA11y = JSON.stringify({
      ok: false,
      stage,
      error: String(error),
      active: document.activeElement?.outerHTML.slice(0, 200),
    });
  }
}

test("Step 3C accessibility, Escape focus-return, 44 px target, and light/dark parity audit", { timeout: 300_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const fixture = await compileFixtureFunction(new URL(import.meta.url), "installStep3CA11yFixture");
  const observe = await compileFixtureFunction(new URL(import.meta.url), "observeStep3CA11y");
  const axeSource = await readFile(fileURLToPath(new URL("../../../node_modules/axe-core/axe.min.js", import.meta.url)), "utf8");
  const html = "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" + styles.join("\n") +
    "</style><script>" + install + fixture + "</script></head><body>" + markup + "<script type='module'>" + observe + "</script></body></html>";
  const fonts = fileURLToPath(new URL("../../../public/fonts/", import.meta.url));
  let activePage: Page | null = null;
  let activeHasTouch = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/__observer-tick") { setTimeout(() => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ now: Date.now() })); }, 2); return; }
    if (url.pathname === "/__click") { void activePage!.locator(url.searchParams.get("selector")!).first().click({ timeout: 8_000 }).then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
    if (url.pathname === "/__key") { void activePage!.keyboard.press(url.searchParams.get("key")!).then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
    if (url.pathname === "/__tap") {
      const x = Number(url.searchParams.get("x"));
      const y = Number(url.searchParams.get("y"));
      const action = activeHasTouch ? activePage!.touchscreen.tap(x, y) : activePage!.mouse.click(x, y);
      void action.then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); });
      return;
    }
    if (url.pathname.startsWith("/fonts/") && url.pathname.endsWith(".woff2")) { void readFile(join(fonts, basename(url.pathname))).then(data => { response.writeHead(200, { "Content-Type": "font/woff2" }); response.end(data); }, () => { response.writeHead(404); response.end(); }); return; }
    response.writeHead(200, { "Content-Type": url.pathname === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
    response.end(url.pathname === "/app.js" ? bundled.join("\n") : html);
  });
  const browser = await launchPlaywrightChromium(chromium);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const evidence = process.env.STEP3C_A11Y_OUT || join(process.cwd(), "../site-observer-evidence/conversations-step3c-a11y");
    await mkdir(evidence, { recursive: true });
    const ws = "11111111-1111-4111-8111-111111111111";
    const opsCh = "66666666-6666-4666-8666-666666666666";
    const cases: { name: string; width: number; height: number; query: string; screenshot?: boolean }[] = [
      ...(["light", "dark"] as const).flatMap((theme) => [
        { name: `1440x900-${theme}-picker-chips`, width: 1440, height: 900, query: `w=${ws}&c=general&theme=${theme}&scene=picker-chips`, screenshot: true },
        { name: `1024x768-${theme}-picker-chips`, width: 1024, height: 768, query: `w=${ws}&c=general&theme=${theme}&scene=picker-chips`, screenshot: true },
        { name: `390x844-${theme}-picker-chips`, width: 390, height: 844, query: `w=${ws}&c=general&theme=${theme}&scene=picker-chips`, screenshot: true },
        { name: `360x740-${theme}-picker-chips`, width: 360, height: 740, query: `w=${ws}&c=general&theme=${theme}&scene=picker-chips`, screenshot: true },
        { name: `1440x900-${theme}-picker-409`, width: 1440, height: 900, query: `w=${ws}&c=general&theme=${theme}&scene=picker-409-restart`, screenshot: true },
        { name: `390x844-${theme}-picker-409`, width: 390, height: 844, query: `w=${ws}&c=general&theme=${theme}&scene=picker-409-restart`, screenshot: true },
        { name: `1440x900-${theme}-members-add`, width: 1440, height: 900, query: `w=${ws}&c=${opsCh}&theme=${theme}&scene=members-add`, screenshot: true },
        { name: `844x390-${theme}-members-add`, width: 844, height: 390, query: `w=${ws}&c=${opsCh}&theme=${theme}&scene=members-add`, screenshot: true },
        { name: `360x740-${theme}-members-add`, width: 360, height: 740, query: `w=${ws}&c=${opsCh}&theme=${theme}&scene=members-add`, screenshot: true },
        { name: `1440x900-${theme}-members-remove-confirm`, width: 1440, height: 900, query: `w=${ws}&c=${opsCh}&theme=${theme}&scene=members-remove-confirm`, screenshot: true },
        { name: `390x844-${theme}-members-remove-confirm`, width: 390, height: 844, query: `w=${ws}&c=${opsCh}&theme=${theme}&scene=members-remove-confirm`, screenshot: true },
        { name: `360x740-${theme}-members-remove-confirm`, width: 360, height: 740, query: `w=${ws}&c=${opsCh}&theme=${theme}&scene=members-remove-confirm`, screenshot: true },
        { name: `1024x768-${theme}-members-readonly`, width: 1024, height: 768, query: `w=${ws}&c=general&theme=${theme}&scene=members-readonly`, screenshot: true },
        { name: `360x740-${theme}-members-readonly`, width: 360, height: 740, query: `w=${ws}&c=general&theme=${theme}&scene=members-readonly`, screenshot: true },
      ]),
      // Repeated-tap safety witnesses on inline Remove confirmation (phone, landscape, and desktop):
      { name: "360x740-light-members-remove-double-tap", width: 360, height: 740, query: `w=${ws}&c=${opsCh}&theme=light&scene=members-remove-double-tap` },
      { name: "360x740-dark-members-remove-double-tap", width: 360, height: 740, query: `w=${ws}&c=${opsCh}&theme=dark&scene=members-remove-double-tap` },
      { name: "390x844-light-members-remove-double-tap", width: 390, height: 844, query: `w=${ws}&c=${opsCh}&theme=light&scene=members-remove-double-tap` },
      { name: "844x390-light-members-remove-double-tap", width: 844, height: 390, query: `w=${ws}&c=${opsCh}&theme=light&scene=members-remove-double-tap` },
      { name: "1440x900-light-members-remove-double-tap", width: 1440, height: 900, query: `w=${ws}&c=${opsCh}&theme=light&scene=members-remove-double-tap` },
      // Keyboard Escape focus-return witnesses (desktop & phone):
      { name: "1024x768-picker-escape", width: 1024, height: 768, query: `w=${ws}&c=general&theme=light&scene=picker-escape` },
      { name: "360x740-picker-escape", width: 360, height: 740, query: `w=${ws}&c=general&theme=light&scene=picker-escape` },
      { name: "1024x768-members-escape", width: 1024, height: 768, query: `w=${ws}&c=${opsCh}&theme=light&scene=members-escape` },
      { name: "360x740-members-escape", width: 360, height: 740, query: `w=${ws}&c=${opsCh}&theme=light&scene=members-escape` },
    ];
    const report: Record<string, any> = {};
    for (const item of cases) {
      activeHasTouch = item.width < 1024;
      const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, hasTouch: activeHasTouch });
      activePage = await context.newPage();
      try {
        await activePage.goto(`http://127.0.0.1:${address.port}/app?${item.query}`);
        await activePage.waitForFunction(() => !!document.documentElement.dataset.step3cA11y, null, { timeout: 30_000 });
        const result = await activePage.evaluate(() => JSON.parse(document.documentElement.dataset.step3cA11y!));
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
    const failures = Object.entries(report).filter(([, r]) => !r.ok || r.overflow || (r.axeViolations?.length ?? 0) > 0 || (r.smallTargets?.length ?? 0) > 0 || (r.transparentBorders?.length ?? 0) > 0);
    assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
