/** Signed-in mounted Step 3B observer: Step 2b rail DMs, All channels Join, unjoined preview bar & fallback. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test } from "../../../tests/chrome.js";
import { launchPlaywrightChromium } from "../../../tests/chrome.js";
import { chromium, type Page } from "playwright-core";
import { compileFixtureFunction, renderAstroFixture } from "../../../tests/astro-fixture";

function installConversations3BFixture() {
  const f = (window as any).existingFixture;
  const params = new URL(location.href).searchParams;
  const fallback = params.get("step2b") === "off";
  f.capture = params.get("capture") ?? "flow";
  f.step2b = !fallback;
  f.failNextPreviewJoin = params.get("fail_join") === "1";
  f.failConvReadCount = Number(params.get("fail_conv_read") ?? "0");
  f.malformedConvReadCount = Number(params.get("malformed_conv_200") ?? "0");
  f.convCommands = [] as any[];

  const opsChannel = "66666666-6666-4666-8666-666666666666";
  const designChannel = "77777777-7777-4777-8777-777777777777";
  const previewChannel = "88888888-8888-4888-8888-888888888888";
  const generalConv = "99990000-0000-4000-8000-000000000001";
  const opsConv = "99990000-0000-4000-8000-000000000002";
  const designConv = "99990000-0000-4000-8000-000000000003";
  const previewConv = "99990000-0000-4000-8000-000000000004";
  const dmLeadConv = "aaaa1111-1111-4111-8111-111111111111";
  const dmGroupConv = "bbbb2222-2222-4222-8222-222222222222";
  const dmMutedConv = "cccc3333-3333-4333-8333-333333333333";
  const peerAlex = "dddd4444-4444-4444-8444-444444444444";
  const peerLead = "eeee5555-5555-4555-8555-555555555555";
  const peerBot = "ffff6666-6666-4666-8666-666666666666";
  f.ids = { opsChannel, designChannel, previewChannel, designConv, previewConv, dmLeadConv, dmGroupConv, dmMutedConv };

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
      conversation_id: dmGroupConv, kind: "group_dm", channel_id: null, slug: null, description: null,
      archived_at: null, joined: true, generation: 1, lead_mode: null, lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "user", id: peerAlex, name: "Alex", left_at: null },
        { kind: "agent", id: peerLead, name: "Lead", left_at: null },
      ],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 4, mention_count: 1,
      last_message_at: "2026-11-19T15:20:00Z", last_message_id: "11111111-2222-4333-8444-555555555555",
    },
    {
      conversation_id: dmLeadConv, kind: "dm", channel_id: null, slug: null, description: null,
      archived_at: null, joined: true, generation: 1, lead_mode: null, lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "agent", id: peerLead, name: "Lead", left_at: null },
      ],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 1, mention_count: 0,
      last_message_at: "2026-11-19T15:05:00Z", last_message_id: "11111111-2222-4333-8444-666666666666",
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
          { channel_id: null, slug: "general", unread: false },
          ...f.channelRows.map((row: any) => ({ channel_id: row.channel_id, slug: row.slug, unread: row.channel_id === opsChannel })),
        ],
      });
    }
    if (url.pathname === "/functions/v1/read" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      if (body?.resource === "conversations") {
        if (fallback) return Response.json({ error: "unsupported_resource", message: "Not deployed yet." }, { status: 400 });
        if (f.failConvReadCount > 0) {
          f.failConvReadCount -= 1;
          return Response.json({ error: "service_unavailable", message: "Couldn't check channel membership." }, { status: 503 });
        }
        if (f.malformedConvReadCount > 0) {
          f.malformedConvReadCount -= 1;
          return Response.json({ unexpected: true }, { status: 200 });
        }
        return Response.json({ conversations: f.conversations });
      }
    }
    if (url.pathname === "/functions/v1/command" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      const command = body?.command;
      if (command?.kind && String(command.kind).startsWith("conversation_")) {
        f.convCommands.push(command);
        const target = f.conversations.find((c: any) => c.conversation_id === command.conversation_id);
        if (command.kind === "conversation_join") {
          if (command.conversation_id === previewConv && f.failNextPreviewJoin) {
            f.failNextPreviewJoin = false;
            return Response.json({ error: "service_unavailable", message: "Network timeout." }, { status: 503 });
          }
          if (target) target.joined = true;
          return Response.json({ status: "accepted", conversation_id: command.conversation_id, kind: target?.kind ?? "public_channel", changed: true });
        }
        if (command.kind === "conversation_mark_read") {
          if (target) { target.unread_count = 0; target.mention_count = 0; }
          return Response.json({ status: "accepted", conversation_id: command.conversation_id, read_through_at: new Date().toISOString() });
        }
        if (command.kind === "conversation_set_notify") {
          if (target) {
            if (command.notify_level) target.notify_level = command.notify_level;
            if (typeof command.starred === "boolean") target.starred = command.starred;
          }
          return Response.json({ status: "accepted", conversation_id: command.conversation_id, notify_level: target?.notify_level, starred: target?.starred });
        }
        if (command.kind === "conversation_leave") {
          f.conversations = f.conversations.filter((c: any) => c.conversation_id !== command.conversation_id);
          return Response.json({ status: "accepted", conversation_id: command.conversation_id, changed: true });
        }
      }
      if (command?.kind === "signals_seen") return Response.json({ status: "accepted" });
    }
    return previous(input, init);
  };
}

async function observeConversations3B() {
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
  const target44 = (el: HTMLElement | null, label: string) => {
    check(el && visible(el), `${label} not visible`);
    const r = el!.getBoundingClientRect();
    check(r.width >= 44 && r.height >= 44, `${label} target too small: ${r.width}x${r.height}`);
  };
  const openDrawerIfPhone = async () => {
    if (!visible(shown("[data-home-all-channels]"))) {
      await click('button[aria-label="Open navigation"]:visible');
      await wait("phone drawer open", () => visible(shown("[data-home-all-channels]")));
    }
  };
  try {
    if (!f.step2b) {
      await wait("fallback rail and composer", () => !!one("[data-sidebar-participant-list]") && visible(one("[data-composer]")));
      check(!one("[data-home-dms]"), "fallback should not render Step 2b DM section");
      check(visible(one("[data-composer]")), "fallback should keep composer visible");
      check(f.errors.length === 0, "fallback errors: " + f.errors.join(","));
      document.documentElement.dataset.step3bObservation = JSON.stringify({ ok: true, mode: "fallback" });
      return;
    }

    if (f.capture === "membership-retry") {
      await wait("membership retry bar visible", () => visible(one("[data-channel-membership-retry-bar]")));
      check(!visible(one("[data-composer]")), "failed membership read must never show composer");
      const retryBtn = one<HTMLButtonElement>("[data-channel-membership-retry]");
      check(retryBtn?.textContent === "Retry", "retry button label");
      target44(retryBtn, "membership Retry button");
      check(one("[data-channel-membership-error]")?.textContent === "Couldn't check channel membership.", "membership error text");
      if (new URL(location.href).searchParams.get("recover") === "1") {
        f.failConvReadCount = 0;
        f.malformedConvReadCount = 0;
        await click("[data-channel-membership-retry]:visible");
        await wait("recovered to Join preview bar", () => visible(one("[data-channel-preview-bar]")) && !visible(one("[data-channel-membership-retry-bar]")));
        check(!visible(one("[data-composer]")), "unjoined channel must still hide composer after recovery");
      }
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
      check(f.errors.length === 0, "app errors: " + f.errors.join(","));
      document.documentElement.dataset.step3bObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    await wait("step 2b dms rendered", () => !!one("[data-home-dms]") && !!one(`[data-rail-conversation="${f.ids.dmGroupConv}"]`));
    check(!one(`[data-rail-channel="${f.ids.designChannel}"]`), "unjoined #design must stay out of rail before joining");
    check(!one(`[data-rail-channel="${f.ids.previewChannel}"]`), "unjoined #preview-only must stay out of rail before joining");

    const opsRow = one(`[data-rail-channel="${f.ids.opsChannel}"]`);
    check(opsRow?.querySelector(".hm-rail__mention-badge")?.textContent === "2", "#ops must show mention badge 2");
    const groupRow = one(`[data-rail-conversation="${f.ids.dmGroupConv}"]`);
    check(groupRow?.querySelector(".hm-rail__mention-badge")?.textContent === "1", "group DM must show mention badge 1");
    const mutedRow = one(`[data-rail-conversation="${f.ids.dmMutedConv}"]`);
    check(!mutedRow?.querySelector(".hm-rail__mention-badge") && !mutedRow?.querySelector(".hm-rail__unread"), "muted DM must suppress visual badges");

    if (f.capture === "phone-drawer") {
      await openDrawerIfPhone();
      target44(shown("[data-home-new-dm]"), "New message +");
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
      document.documentElement.dataset.step3bObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    if (f.capture === "rail-preview" || f.capture === "preview-retry") {
      await wait("preview bar visible", () => visible(one("[data-channel-preview-bar]")));
      check(!visible(one("[data-composer]")), "composer must stay hidden on unjoined public channel");
      const btn = one<HTMLButtonElement>("[data-channel-preview-join]");
      check(btn?.textContent === "Join #preview-only", "preview button must say Join #preview-only");
      target44(btn, "preview Join button");
      if (f.capture === "preview-retry") {
        await click("[data-channel-preview-join]:visible");
        await wait("preview retry state", () => one("[data-channel-preview-join]")?.textContent === "Retry");
        check(!visible(one("[data-composer]")), "composer must remain hidden after failed join");
        check(one("[data-channel-preview-error]")?.textContent === "Network timeout.", "error alert must show refusal");
      }
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
      document.documentElement.dataset.step3bObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    if (f.capture === "group-leave") {
      await openDrawerIfPhone();
      await click(`[data-rail-conversation-menu="${f.ids.dmGroupConv}"]:visible`);
      await wait("group dm menu open", () => visible(one(".cs-context-menu")));
      await click('.cs-context-menu__item:has-text("Leave group")');
      await wait("group leave confirm open", () => one<HTMLDialogElement>("[data-group-leave-dialog]")?.open === true);
      check(one("[data-group-leave-title]")?.textContent === "Leave Alex and Lead?", "confirm heading names group");
      check(document.activeElement === one("[data-group-leave-cancel]"), "confirm opens with focus on Cancel");
      target44(one<HTMLElement>("[data-group-leave-cancel]"), "Leave confirm Cancel");
      target44(one<HTMLElement>("[data-group-leave-confirm]"), "Leave confirm Leave");
      check(!f.convCommands.some((c: any) => c.kind === "conversation_leave"), "opening confirm must not send leave");
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
      document.documentElement.dataset.step3bObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    if (f.capture === "directory") {
      await openDrawerIfPhone();
      await click("[data-home-all-channels]:visible");
      await wait("directory open", () => one<HTMLDialogElement>("[data-channel-directory]")?.open === true);
      const joinBtn = one<HTMLButtonElement>(`[data-channel-directory-action="join:${f.ids.designChannel}"]`);
      target44(joinBtn, "directory Join button");
      check(!!one("[data-channel-directory] .cm-directory-joined"), "joined channels must show Joined");
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
      document.documentElement.dataset.step3bObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    // Full interactive signed-in flow:
    await openDrawerIfPhone();
    target44(shown("[data-home-new-dm]"), "New message +");
    await click("[data-home-all-channels]:visible");
    await wait("directory open", () => one<HTMLDialogElement>("[data-channel-directory]")?.open === true);
    const designJoin = one<HTMLButtonElement>(`[data-channel-directory-action="join:${f.ids.designChannel}"]`);
    target44(designJoin, "directory Join #design");
    designJoin!.focus();
    await click(`[data-channel-directory-action="join:${f.ids.designChannel}"]:visible`);
    await wait("design joined in directory", () => !one(`[data-channel-directory-action="join:${f.ids.designChannel}"]`) && !!one(`[data-rail-channel="${f.ids.designChannel}"]`));
    check(f.convCommands.some((c: any) => c.kind === "conversation_join" && c.conversation_id === f.ids.designConv), "Join must send conversation_join");
    check(document.activeElement?.getAttribute("data-channel-directory-action") === `open:${f.ids.designChannel}`, "focus must move to channel link after Join");

    // Open unjoined #preview-only from All channels -> preview bar replaces composer:
    await click(`[data-channel-directory-action="open:${f.ids.previewChannel}"]:visible`);
    await wait("preview bar mounted", () => visible(one("[data-channel-preview-bar]")));
    check(!visible(one("[data-composer]")), "composer must be hidden until membership is confirmed");
    const previewBtn = one<HTMLButtonElement>("[data-channel-preview-join]");
    check(previewBtn?.textContent === "Join #preview-only", "preview label");
    target44(previewBtn, "preview Join button");

    // Failed join keeps preview open with Retry and keeps focus:
    await click("[data-channel-preview-join]:visible");
    await wait("preview retry", () => one("[data-channel-preview-join]")?.textContent === "Retry");
    check(!visible(one("[data-composer]")), "composer stays hidden on failed join");
    check(one("[data-channel-preview-error]")?.textContent === "Network timeout.", "preview error text");
    check(document.activeElement === one("[data-channel-preview-join]"), "Retry button keeps focus");

    // Retry succeeds -> preview unmounts, composer appears, #preview-only enters rail:
    await click("[data-channel-preview-join]:visible");
    await wait("composer unlocked after join", () => visible(one("[data-composer]")) && !visible(one("[data-channel-preview-bar]")));
    check(!!one(`[data-rail-channel="${f.ids.previewChannel}"]`), "#preview-only must appear in rail after joining");

    // DM row ⋯ menu: group DM offers Mark as read + Leave group; 1:1 DM does not offer Leave group:
    await openDrawerIfPhone();
    await click(`[data-rail-conversation-menu="${f.ids.dmGroupConv}"]:visible`);
    await wait("group dm menu open", () => visible(one(".cs-context-menu")));
    const groupLabels = [...document.querySelectorAll(".cs-context-menu__item")].map(el => el.textContent?.trim());
    check(groupLabels.includes("Mark as read"), "group DM menu must offer Mark as read");
    check(groupLabels.includes("Leave group"), "group DM menu must offer Leave group");
    await click('.cs-context-menu__item:has-text("Mark as read")');
    await wait("group dm marked read", () => f.convCommands.some((c: any) => c.kind === "conversation_mark_read" && c.conversation_id === f.ids.dmGroupConv));

    await click(`[data-rail-conversation-menu="${f.ids.dmLeadConv}"]:visible`);
    await wait("1:1 dm menu open", () => visible(one(".cs-context-menu")));
    const oneToOneLabels = [...document.querySelectorAll(".cs-context-menu__item")].map(el => el.textContent?.trim());
    check(!oneToOneLabels.includes("Leave group"), "1:1 DM must never offer Leave group");

    // Group DM Leave requires confirmation (Cancel sends nothing; Leave sends conversation_leave and removes row):
    await click(`[data-rail-conversation-menu="${f.ids.dmGroupConv}"]:visible`);
    await wait("group dm menu reopen", () => visible(one(".cs-context-menu")));
    await click('.cs-context-menu__item:has-text("Leave group")');
    await wait("group leave confirm open", () => one<HTMLDialogElement>("[data-group-leave-dialog]")?.open === true);
    check(one("[data-group-leave-title]")?.textContent === "Leave Alex and Lead?", "leave confirm title");
    check(document.activeElement === one("[data-group-leave-cancel]"), "leave confirm focuses Cancel");
    check(!f.convCommands.some((c: any) => c.kind === "conversation_leave"), "Leave group menu click must not send leave");
    await click("[data-group-leave-cancel]:visible");
    await wait("group leave confirm cancelled", () => one<HTMLDialogElement>("[data-group-leave-dialog]")?.open === false);
    check(!f.convCommands.some((c: any) => c.kind === "conversation_leave"), "Cancel must not send conversation_leave");
    check(!!one(`[data-rail-conversation="${f.ids.dmGroupConv}"]`), "group row stays after Cancel");

    await openDrawerIfPhone();
    await click(`[data-rail-conversation-menu="${f.ids.dmGroupConv}"]:visible`);
    await wait("group dm menu second open", () => visible(one(".cs-context-menu")));
    await click('.cs-context-menu__item:has-text("Leave group")');
    await wait("group leave confirm second open", () => one<HTMLDialogElement>("[data-group-leave-dialog]")?.open === true);
    await click("[data-group-leave-confirm]:visible");
    await wait("group left after confirm", () => one<HTMLDialogElement>("[data-group-leave-dialog]")?.open === false && !one(`[data-rail-conversation="${f.ids.dmGroupConv}"]`));
    check(f.convCommands.some((c: any) => c.kind === "conversation_leave" && c.conversation_id === f.ids.dmGroupConv), "confirming Leave must send conversation_leave");

    await document.fonts.ready;
    check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
    check(f.errors.length === 0, "app errors: " + f.errors.join(","));
    check(f.unexpected.length === 0, "unexpected HTTP: " + f.unexpected.join(","));
    document.documentElement.dataset.step3bObservation = JSON.stringify({ ok: true, mode: "flow", commands: f.convCommands.length });
  } catch (error) {
    document.documentElement.dataset.step3bObservation = JSON.stringify({
      error: String(error), stage, active: document.activeElement?.outerHTML.slice(0, 240),
      errors: f.errors, unexpected: f.unexpected, commands: f.convCommands,
    });
  }
}

test("Step 3B signed-in dashboard wires Step 2b DM rail, All channels Join, preview bar Retry, and pre-2b fallback", { timeout: 300_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const convFixture = await compileFixtureFunction(new URL(import.meta.url), "installConversations3BFixture");
  const observe = await compileFixtureFunction(new URL(import.meta.url), "observeConversations3B");
  const html = "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" + styles.join("\n") +
    "</style><script>" + install + convFixture + "</script></head><body>" + markup + "<script type='module'>" + observe + "</script></body></html>";
  const fonts = fileURLToPath(new URL("../../../public/fonts/", import.meta.url));
  let activePage: Page | null = null;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/__observer-tick") { setTimeout(() => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ now: Date.now() })); }, 2); return; }
    if (url.pathname === "/__click") { void activePage!.locator(url.searchParams.get("selector")!).first().click().then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
    if (url.pathname.startsWith("/fonts/") && url.pathname.endsWith(".woff2")) { void readFile(join(fonts, basename(url.pathname))).then(data => { response.writeHead(200, { "Content-Type": "font/woff2" }); response.end(data); }, () => { response.writeHead(404); response.end(); }); return; }
    response.writeHead(200, { "Content-Type": url.pathname === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
    response.end(url.pathname === "/app.js" ? bundled.join("\n") : html);
  });
  const browser = await launchPlaywrightChromium(chromium);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const evidence = join(process.cwd(), "../site-observer-evidence/conversations-step3b");
    await mkdir(evidence, { recursive: true });
    const outcomes: Record<string, any> = {};
    const ws = "11111111-1111-4111-8111-111111111111";
    const previewCh = "88888888-8888-4888-8888-888888888888";
    const cases: { name: string; width: number; height: number; query: string; screenshot?: boolean }[] = [
      { name: "flow-360-light", width: 360, height: 740, query: `w=${ws}&c=general&theme=light&capture=flow&fail_join=1` },
      { name: "flow-1024-dark", width: 1024, height: 1366, query: `w=${ws}&c=general&theme=dark&capture=flow&fail_join=1` },
      { name: "fallback-390-light", width: 390, height: 844, query: `w=${ws}&c=general&theme=light&step2b=off` },
      // Visual captures for Designer signed-in verification across phone & desktop, light & dark:
      ...([
        [360, 740],
        [390, 844],
        [1024, 1366],
      ] as const).flatMap(([width, height]) => (["light", "dark"] as const).flatMap((theme) => [
        { name: `${width}x${height}-${theme}-preview`, width, height, query: `w=${ws}&c=${previewCh}&theme=${theme}&capture=rail-preview`, screenshot: true },
        { name: `${width}x${height}-${theme}-directory`, width, height, query: `w=${ws}&c=general&theme=${theme}&capture=directory`, screenshot: true },
        ...(width < 1024 ? [{ name: `${width}x${height}-${theme}-rail-drawer`, width, height, query: `w=${ws}&c=general&theme=${theme}&capture=phone-drawer`, screenshot: true }] : []),
      ])),
      { name: "390x844-light-preview-retry", width: 390, height: 844, query: `w=${ws}&c=${previewCh}&theme=light&capture=preview-retry&fail_join=1`, screenshot: true },
      { name: "390x844-dark-preview-retry", width: 390, height: 844, query: `w=${ws}&c=${previewCh}&theme=dark&capture=preview-retry&fail_join=1`, screenshot: true },
      // Delta captures: group Leave confirmation modal and failed membership read Retry bar:
      { name: "360x740-light-group-leave", width: 360, height: 740, query: `w=${ws}&c=general&theme=light&capture=group-leave`, screenshot: true },
      { name: "390x844-dark-group-leave", width: 390, height: 844, query: `w=${ws}&c=general&theme=dark&capture=group-leave`, screenshot: true },
      { name: "1024x1366-light-group-leave", width: 1024, height: 1366, query: `w=${ws}&c=general&theme=light&capture=group-leave`, screenshot: true },
      { name: "1024x1366-dark-group-leave", width: 1024, height: 1366, query: `w=${ws}&c=general&theme=dark&capture=group-leave`, screenshot: true },
      { name: "390x844-light-membership-retry", width: 390, height: 844, query: `w=${ws}&c=${previewCh}&theme=light&capture=membership-retry&fail_conv_read=99`, screenshot: true },
      { name: "390x844-dark-membership-retry", width: 390, height: 844, query: `w=${ws}&c=${previewCh}&theme=dark&capture=membership-retry&fail_conv_read=99`, screenshot: true },
      { name: "1024x1366-light-membership-retry", width: 1024, height: 1366, query: `w=${ws}&c=${previewCh}&theme=light&capture=membership-retry&fail_conv_read=99`, screenshot: true },
      { name: "membership-retry-recover-390", width: 390, height: 844, query: `w=${ws}&c=${previewCh}&theme=light&capture=membership-retry&fail_conv_read=99&recover=1` },
      { name: "membership-retry-malformed-200", width: 390, height: 844, query: `w=${ws}&c=${previewCh}&theme=light&capture=membership-retry&malformed_conv_200=99&recover=1` },
    ];
    for (const item of cases) {
      const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, hasTouch: item.width < 1024 });
      activePage = await context.newPage();
      try {
        await activePage.goto(`http://127.0.0.1:${address.port}/app?${item.query}`);
        await activePage.waitForFunction(() => !!document.documentElement.dataset.step3bObservation, null, { timeout: 30_000 });
        outcomes[item.name] = await activePage.evaluate(() => JSON.parse(document.documentElement.dataset.step3bObservation!));
        if (item.screenshot) {
          await activePage.screenshot({ path: join(evidence, `${item.name}.png`), fullPage: false });
        }
      } catch (error) {
        outcomes[item.name] = { error: String(error) };
        if (item.screenshot) {
          await activePage.screenshot({ path: join(evidence, `${item.name}.png`), fullPage: false }).catch(() => {});
        }
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
