/** Signed-in mounted Step 3C observer: New message picker (#511 409 flows) & Channel Members & Invite sheet. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test } from "../../../tests/chrome.js";
import { launchPlaywrightChromium } from "../../../tests/chrome.js";
import { chromium, type Page } from "playwright-core";
import { compileFixtureFunction, renderAstroFixture } from "../../../tests/astro-fixture";

function installConversations3CFixture() {
  const f = (window as any).existingFixture;
  const params = new URL(location.href).searchParams;
  f.capture = params.get("capture") ?? "flow";
  f.openMode = params.get("open_mode") ?? "flow";
  f.convCommands = [] as any[];

  const opsChannel = "66666666-6666-4666-8666-666666666666";
  const secretChannel = "77777777-7777-4777-8777-777777777777";
  const generalConv = "99990000-0000-4000-8000-000000000001";
  const opsConv = "99990000-0000-4000-8000-000000000002";
  const secretConv = "99990000-0000-4000-8000-000000000003";
  const dmGroupConv = "bbbb2222-2222-4222-8222-222222222222";
  const newGroupConv = "cccc3333-3333-4333-8333-333333333333";
  const peerAlex = "dddd4444-4444-4444-8444-444444444444";
  const peerSam = "dddd5555-5555-4555-8555-555555555555";
  const peerLead = "eeee5555-5555-4555-8555-555555555555";
  const peerBot = "ffff6666-6666-4666-8666-666666666666";
  f.ids = { opsChannel, secretChannel, opsConv, secretConv, dmGroupConv, newGroupConv, peerAlex, peerSam, peerLead, peerBot };
  f.openCalls = 0;

  const makeChannel = (id: string, slug: string, purpose: string, visibility: "open" | "private" = "open") => ({
    channel_id: id, workspace_id: f.workspace, slug, purpose,
    created_by_principal: f.owner, created_by_kind: "user",
    created_at: "2026-11-01T00:00:00Z", archived_at: null, visibility,
  });
  f.channelRows = [
    makeChannel(opsChannel, "ops", "Release coordination and deploys.", "open"),
    makeChannel(secretChannel, "secrets", "Private channel for key rotation.", "private"),
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
      ],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: "2026-11-19T15:10:00Z", last_message_id: null,
    },
    {
      conversation_id: secretConv, kind: "private_channel", channel_id: secretChannel, slug: "secrets",
      description: "Private channel for key rotation.", archived_at: null, joined: true, generation: 0,
      lead_mode: "workspace", lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "user", id: peerAlex, name: "Alex", left_at: null },
      ],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: "2026-11-19T15:05:00Z", last_message_id: null,
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

  const memberName = (m: { kind: string; id: string }) => {
    if (m.id === f.owner) return "Synthetic owner";
    if (m.id === peerAlex) return "Alex";
    if (m.id === peerSam) return "Sam";
    if (m.id === peerLead) return "Lead";
    if (m.id === peerBot) return "Archive Bot";
    return "Member";
  };

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
      if (body?.resource === "conversations") {
        return Response.json({ conversations: f.conversations });
      }
    }
    if (url.pathname === "/functions/v1/command" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      const command = body?.command;
      if (command?.kind && (String(command.kind).startsWith("conversation_") || String(command.kind).startsWith("channel_member_"))) {
        f.convCommands.push(command);
        if (command.kind === "conversation_open") {
          f.openCalls += 1;
          if (f.openMode === "member_left" && !command.new_group) {
            return Response.json(
              { error: "conversation_member_left", message: "Alex left this group. To include everyone again, start a new group." },
              { status: 409 },
            );
          }
          if (f.openMode === "flow" && f.openCalls === 1 && !command.new_group) {
            return Response.json(
              { error: "conversation_left", message: "You left this group. Ask a current member to start a new group with you." },
              { status: 409 },
            );
          }
          if (f.openMode === "flow" && f.openCalls === 2 && !command.new_group) {
            return Response.json(
              { error: "conversation_member_left", message: "Alex left this group. To include everyone again, start a new group." },
              { status: 409 },
            );
          }
          const fullMembers = [
            { kind: "user", id: f.owner },
            ...command.members.filter((m: any) => !(m.kind === "user" && m.id === f.owner)),
          ];
          const conv = {
            conversation_id: newGroupConv,
            kind: fullMembers.length > 2 ? "group_dm" : "dm",
            channel_id: null, slug: null, description: null, archived_at: null,
            joined: true, generation: 2, lead_mode: null, lead_agent_principal_id: null,
            members: fullMembers.map((m: any) => ({ ...m, name: memberName(m), left_at: null })),
            notify_level: "everything", starred: false, star_rank: null,
            read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
            last_message_at: "2026-11-19T16:00:00Z", last_message_id: null,
          };
          f.conversations = [conv, ...f.conversations.filter((c: any) => c.conversation_id !== newGroupConv)];
          return Response.json({
            status: "accepted",
            created: true,
            conversation: {
              conversation_id: conv.conversation_id,
              kind: conv.kind,
              generation: conv.generation,
              members: fullMembers,
            },
          });
        }
        if (command.kind === "conversation_invite") {
          const target = f.conversations.find((c: any) => c.conversation_id === command.conversation_id);
          if (target) {
            for (const m of command.members) {
              if (!target.members.some((e: any) => e.kind === m.kind && e.id === m.id)) {
                target.members.push({ ...m, name: memberName(m), left_at: null });
              }
            }
          }
          return Response.json({ status: "accepted", conversation_id: command.conversation_id, members_added: command.members });
        }
        if (command.kind === "conversation_remove") {
          const target = f.conversations.find((c: any) => c.conversation_id === command.conversation_id);
          if (target) {
            target.members = target.members.filter((e: any) => !(e.kind === command.member.kind && e.id === command.member.id));
          }
          return Response.json({ status: "accepted", conversation_id: command.conversation_id, changed: true });
        }
        if (command.kind === "channel_member_add") {
          const target = f.conversations.find((c: any) => c.channel_id === command.channel_id);
          if (target) {
            for (const m of command.members) {
              if (!target.members.some((e: any) => e.kind === m.kind && e.id === m.id)) {
                target.members.push({ ...m, name: memberName(m), left_at: null });
              }
            }
          }
          return Response.json({ status: "accepted", channel: { channel_id: command.channel_id } });
        }
        if (command.kind === "channel_member_remove") {
          const target = f.conversations.find((c: any) => c.channel_id === command.channel_id);
          if (target) {
            target.members = target.members.filter((e: any) => !(e.kind === command.member.kind && e.id === command.member.id));
          }
          return Response.json({ status: "accepted", channel: { channel_id: command.channel_id } });
        }
      }
      if (command?.kind === "signals_seen") return Response.json({ status: "accepted" });
    }
    return previous(input, init);
  };
}

async function observeConversations3C() {
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
    if (!visible(shown("[data-home-new-dm]"))) {
      await click('button[aria-label="Open navigation"]:visible');
      await wait("phone drawer open", () => visible(shown("[data-home-new-dm]")));
    }
  };
  const openMembersSheet = async () => {
    const headerBtn = shown("[data-conversation-members-open]");
    if (headerBtn) {
      await click("[data-conversation-members-open]:visible");
    } else {
      await click(".hm-menu__trigger:visible");
      await wait("more menu open", () => visible(shown("[data-menu-conversation-members]")));
      await click("[data-menu-conversation-members]:visible");
    }
    await wait("members dialog open", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === true);
  };
  try {
    await wait("step 2b rail rendered", () => !!one("[data-home-dms]") && !!one(`[data-rail-channel="${f.ids.opsChannel}"]`));

    if (f.capture === "picker" || f.capture === "picker-member-left") {
      await openDrawerIfPhone();
      await click("[data-home-new-dm]:visible");
      await wait("picker open", () => one<HTMLDialogElement>("[data-conversation-picker-dialog]")?.open === true);
      target44(one<HTMLElement>("[data-conversation-picker-close]"), "picker Close");
      target44(one<HTMLElement>("[data-conversation-picker-submit]"), "picker Open");
      await click(`[data-conversation-picker-option="user:${f.ids.peerAlex}"]:visible`);
      await click(`[data-conversation-picker-option="agent:${f.ids.peerLead}"]:visible`);
      target44(one<HTMLElement>(`[data-conversation-picker-chip="user:${f.ids.peerAlex}"]`), "selected chip");
      if (f.capture === "picker-member-left") {
        await click("[data-conversation-picker-submit]:visible");
        await wait("member_left prompt", () => visible(one("[data-conversation-picker-restart]")));
        target44(one<HTMLElement>("[data-conversation-picker-restart]"), "Start new group");
        check(one("[data-conversation-picker-error]")?.textContent === "Alex left this group. To include everyone again, start a new group.", "exact member_left copy");
      }
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
      document.documentElement.dataset.step3cObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    if (f.capture === "members-add" || f.capture === "members-remove-confirm") {
      await openMembersSheet();
      target44(one<HTMLElement>("[data-conversation-members-close]"), "members Close");
      if (f.capture === "members-add") {
        target44(one<HTMLElement>("[data-conversation-members-add-toggle]"), "Add toggle");
        await click("[data-conversation-members-add-toggle]:visible");
        await wait("add panel open", () => visible(one("[data-conversation-members-add-panel]")));
        await click(`[data-conversation-members-candidate="agent:${f.ids.peerLead}"]:visible`);
        target44(one<HTMLElement>("[data-conversation-members-add-submit]"), "Add submit");
      } else {
        target44(one<HTMLElement>(`[data-conversation-member-remove="user:${f.ids.peerAlex}"]`), "Remove button");
        await click(`[data-conversation-member-remove="user:${f.ids.peerAlex}"]:visible`);
        await wait("remove confirm open", () => visible(one(`[data-conversation-member-confirm="user:${f.ids.peerAlex}"]`)));
        target44(one<HTMLElement>(`[data-conversation-member-remove-cancel="user:${f.ids.peerAlex}"]`), "Remove Cancel");
        target44(one<HTMLElement>(`[data-conversation-member-remove-confirm="user:${f.ids.peerAlex}"]`), "Remove Confirm");
      }
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
      document.documentElement.dataset.step3cObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    if (f.capture === "dm-members-readonly") {
      await openDrawerIfPhone();
      await click(`[data-rail-conversation="${f.ids.dmGroupConv}"]:visible`);
      await wait("group dm open", () => location.search.includes(`dm=${f.ids.dmGroupConv}`));
      await openMembersSheet();
      check(!visible(one("[data-conversation-members-add-toggle]")), "DM must not offer Add");
      check(document.querySelectorAll("[data-conversation-member-remove]").length === 0, "DM must not offer Remove");
      check(document.querySelectorAll("[data-conversation-member-row]").length === 3, "DM must list all 3 members");
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
      document.documentElement.dataset.step3cObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    // Full interactive flow:
    // 1. New message picker: conversation_left (no restart) -> conversation_member_left (Start new group) -> opens DM.
    await openDrawerIfPhone();
    await click("[data-home-new-dm]:visible");
    await wait("picker open", () => one<HTMLDialogElement>("[data-conversation-picker-dialog]")?.open === true);
    check(document.activeElement === one("[data-conversation-picker-search]"), "picker focuses search");
    await click(`[data-conversation-picker-option="user:${f.ids.peerAlex}"]:visible`);
    await click(`[data-conversation-picker-option="agent:${f.ids.peerLead}"]:visible`);
    await click("[data-conversation-picker-submit]:visible");
    await wait("conversation_left alert", () => one("[data-conversation-picker-error]")?.textContent?.includes("You left this group"));
    check(!visible(one("[data-conversation-picker-restart]")), "conversation_left must NOT show Start new group");

    await click("[data-conversation-picker-submit]:visible");
    await wait("conversation_member_left alert", () => visible(one("[data-conversation-picker-restart]")));
    check(one("[data-conversation-picker-error]")?.textContent === "Alex left this group. To include everyone again, start a new group.", "exact member_left copy");
    await click("[data-conversation-picker-restart]:visible");
    await wait("new group opened", () => one<HTMLDialogElement>("[data-conversation-picker-dialog]")?.open === false && location.search.includes(`dm=${f.ids.newGroupConv}`));
    check(f.convCommands.some((c: any) => c.kind === "conversation_open" && c.new_group === true), "Start new group must send new_group: true");

    // 2. Fixed-member group DM Members sheet: strictly read-only.
    await openMembersSheet();
    check(!visible(one("[data-conversation-members-add-toggle]")), "DM Members must be read-only (no Add)");
    check(document.querySelectorAll("[data-conversation-member-remove]").length === 0, "DM Members must be read-only (no Remove)");
    await click("[data-conversation-members-close]:visible");
    await wait("dm members closed", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === false);

    // 3. Public channel (#ops) Members sheet: Add (conversation_invite) + Remove confirm/cancel/confirm (conversation_remove).
    await openDrawerIfPhone();
    await click(`[data-rail-channel="${f.ids.opsChannel}"]:visible`);
    await wait("#ops open", () => location.search.includes(`c=${f.ids.opsChannel}`));
    await openMembersSheet();
    await click("[data-conversation-members-add-toggle]:visible");
    await wait("ops add panel", () => visible(one("[data-conversation-members-add-panel]")));
    await click(`[data-conversation-members-candidate="agent:${f.ids.peerLead}"]:visible`);
    await click("[data-conversation-members-add-submit]:visible");
    await wait("Lead added to #ops", () => !!one(`[data-conversation-member-row="agent:${f.ids.peerLead}"]`));
    check(f.convCommands.some((c: any) => c.kind === "conversation_invite" && c.conversation_id === f.ids.opsConv), "public Add must send conversation_invite");

    await click(`[data-conversation-member-remove="user:${f.ids.peerAlex}"]:visible`);
    await wait("ops remove confirm", () => visible(one(`[data-conversation-member-confirm="user:${f.ids.peerAlex}"]`)));
    check(document.activeElement === one(`[data-conversation-member-remove-cancel="user:${f.ids.peerAlex}"]`), "Remove confirm focuses Cancel");
    check(!f.convCommands.some((c: any) => c.kind === "conversation_remove"), "clicking Remove must not send before confirm");
    await click(`[data-conversation-member-remove-cancel="user:${f.ids.peerAlex}"]:visible`);
    await wait("ops remove cancelled", () => !one(`[data-conversation-member-confirm="user:${f.ids.peerAlex}"]`));
    check(!f.convCommands.some((c: any) => c.kind === "conversation_remove"), "Cancel must not send conversation_remove");

    await click(`[data-conversation-member-remove="user:${f.ids.peerAlex}"]:visible`);
    await wait("ops remove confirm 2", () => visible(one(`[data-conversation-member-confirm="user:${f.ids.peerAlex}"]`)));
    await click(`[data-conversation-member-remove-confirm="user:${f.ids.peerAlex}"]:visible`);
    await wait("Alex removed from #ops", () => !one(`[data-conversation-member-row="user:${f.ids.peerAlex}"]`));
    check(f.convCommands.some((c: any) => c.kind === "conversation_remove" && c.conversation_id === f.ids.opsConv), "confirming Remove must send conversation_remove");
    await click("[data-conversation-members-close]:visible");
    await wait("ops members closed", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === false);

    // 4. Private channel (#secrets) Members sheet: Add (channel_member_add) + Remove (channel_member_remove).
    await openDrawerIfPhone();
    await click(`[data-rail-channel="${f.ids.secretChannel}"]:visible`);
    await wait("#secrets open", () => location.search.includes(`c=${f.ids.secretChannel}`));
    await openMembersSheet();
    await click("[data-conversation-members-add-toggle]:visible");
    await wait("secrets add panel", () => visible(one("[data-conversation-members-add-panel]")));
    await click(`[data-conversation-members-candidate="user:${f.ids.peerSam}"]:visible`);
    await click("[data-conversation-members-add-submit]:visible");
    await wait("Sam added to #secrets", () => !!one(`[data-conversation-member-row="user:${f.ids.peerSam}"]`));
    check(f.convCommands.some((c: any) => c.kind === "channel_member_add" && c.channel_id === f.ids.secretChannel), "private Add must send channel_member_add");

    await click(`[data-conversation-member-remove="user:${f.ids.peerAlex}"]:visible`);
    await wait("secrets remove confirm", () => visible(one(`[data-conversation-member-confirm="user:${f.ids.peerAlex}"]`)));
    await click(`[data-conversation-member-remove-confirm="user:${f.ids.peerAlex}"]:visible`);
    await wait("Alex removed from #secrets", () => !one(`[data-conversation-member-row="user:${f.ids.peerAlex}"]`));
    check(f.convCommands.some((c: any) => c.kind === "channel_member_remove" && c.channel_id === f.ids.secretChannel), "private Remove must send channel_member_remove");

    await document.fonts.ready;
    check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
    check(f.errors.length === 0, "app errors: " + f.errors.join(","));
    check(f.unexpected.length === 0, "unexpected HTTP: " + f.unexpected.join(","));
    document.documentElement.dataset.step3cObservation = JSON.stringify({ ok: true, mode: "flow", commands: f.convCommands.length });
  } catch (error) {
    document.documentElement.dataset.step3cObservation = JSON.stringify({
      error: String(error), stage, active: document.activeElement?.outerHTML.slice(0, 240),
      errors: f.errors, unexpected: f.unexpected, commands: f.convCommands,
    });
  }
}

test("Step 3C signed-in dashboard wires New message picker (#511 flows) and Channel Members & Invite sheet", { timeout: 300_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const convFixture = await compileFixtureFunction(new URL(import.meta.url), "installConversations3CFixture");
  const observe = await compileFixtureFunction(new URL(import.meta.url), "observeConversations3C");
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
    const evidence = join(process.cwd(), "../site-observer-evidence/conversations-step3c");
    await mkdir(evidence, { recursive: true });
    const outcomes: Record<string, any> = {};
    const ws = "11111111-1111-4111-8111-111111111111";
    const opsCh = "66666666-6666-4666-8666-666666666666";
    const cases: { name: string; width: number; height: number; query: string; screenshot?: boolean }[] = [
      { name: "flow-360-light", width: 360, height: 740, query: `w=${ws}&c=general&theme=light&capture=flow` },
      { name: "flow-1024-dark", width: 1024, height: 1366, query: `w=${ws}&c=general&theme=dark&capture=flow` },
      // Signed-in captures across phone & desktop, light & dark:
      ...([
        [360, 740],
        [390, 844],
        [1024, 1366],
      ] as const).flatMap(([width, height]) => (["light", "dark"] as const).flatMap((theme) => [
        { name: `${width}x${height}-${theme}-picker`, width, height, query: `w=${ws}&c=general&theme=${theme}&capture=picker`, screenshot: true },
        { name: `${width}x${height}-${theme}-members-add`, width, height, query: `w=${ws}&c=${opsCh}&theme=${theme}&capture=members-add`, screenshot: true },
      ])),
      { name: "390x844-light-picker-member-left", width: 390, height: 844, query: `w=${ws}&c=general&theme=light&capture=picker-member-left&open_mode=member_left`, screenshot: true },
      { name: "390x844-dark-picker-member-left", width: 390, height: 844, query: `w=${ws}&c=general&theme=dark&capture=picker-member-left&open_mode=member_left`, screenshot: true },
      { name: "1024x1366-light-picker-member-left", width: 1024, height: 1366, query: `w=${ws}&c=general&theme=light&capture=picker-member-left&open_mode=member_left`, screenshot: true },
      { name: "390x844-light-members-remove-confirm", width: 390, height: 844, query: `w=${ws}&c=${opsCh}&theme=light&capture=members-remove-confirm`, screenshot: true },
      { name: "390x844-dark-members-remove-confirm", width: 390, height: 844, query: `w=${ws}&c=${opsCh}&theme=dark&capture=members-remove-confirm`, screenshot: true },
      { name: "1024x1366-light-members-remove-confirm", width: 1024, height: 1366, query: `w=${ws}&c=${opsCh}&theme=light&capture=members-remove-confirm`, screenshot: true },
      { name: "390x844-light-dm-members-readonly", width: 390, height: 844, query: `w=${ws}&c=general&theme=light&capture=dm-members-readonly`, screenshot: true },
      { name: "1024x1366-dark-dm-members-readonly", width: 1024, height: 1366, query: `w=${ws}&c=general&theme=dark&capture=dm-members-readonly`, screenshot: true },
    ];
    for (const item of cases) {
      const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, hasTouch: item.width < 1024 });
      activePage = await context.newPage();
      try {
        await activePage.goto(`http://127.0.0.1:${address.port}/app?${item.query}`);
        await activePage.waitForFunction(() => !!document.documentElement.dataset.step3cObservation, null, { timeout: 30_000 });
        outcomes[item.name] = await activePage.evaluate(() => JSON.parse(document.documentElement.dataset.step3cObservation!));
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
