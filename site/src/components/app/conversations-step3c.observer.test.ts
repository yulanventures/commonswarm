/** Signed-in mounted Step 3C observer: New message picker (#511 flows), Channel Members sheet, and C1/C2/C3 security witnesses. */
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
  f.viewerRole = params.get("viewer_role") ?? "owner";
  f.promotedManager = params.get("promoted_manager") === "1";
  f.manyMembers = params.get("many_members") === "1";
  f.sameName = params.get("same_name") === "1";
  f.convCommands = [] as any[];
  f.signalCommands = [] as any[];
  f.uploadCalls = [] as string[];
  f.holdFirstInvite401 = false;
  f.invite401Count = 0;
  f.releaseInvite401 = null as null | (() => void);
  f.holdNextConvPoll = false;
  f.releaseConvPoll = null as null | (() => void);
  f.convReadCount = 0;

  const opsChannel = "66666666-6666-4666-8666-666666666666";
  const secretChannel = "77777777-7777-4777-8777-777777777777";
  const generalConv = "99990000-0000-4000-8000-000000000001";
  const opsConv = "99990000-0000-4000-8000-000000000002";
  const secretConv = "99990000-0000-4000-8000-000000000003";
  const dmAlexConv = "aaaa1111-1111-4111-8111-111111111111";
  const dmGroupConv = "bbbb2222-2222-4222-8222-222222222222";
  const newGroupConv = "cccc3333-3333-4333-8333-333333333333";
  const notesConv = "cccc4444-4444-4444-8444-444444444444";
  const peerAlex = "dddd4444-4444-4444-8444-444444444444";
  const peerSam = "dddd5555-5555-4555-8555-555555555555";
  const peerLead = "eeee5555-5555-4555-8555-555555555555";
  const peerBot = "ffff6666-6666-4666-8666-666666666666";
  const secondWorkspace = "22222222-2222-4222-8222-222222222222";
  f.ids = { opsChannel, secretChannel, opsConv, secretConv, dmAlexConv, dmGroupConv, newGroupConv, notesConv, peerAlex, peerSam, peerLead, peerBot, secondWorkspace };
  f.openCalls = 0;

  const makeChannel = (id: string, slug: string, purpose: string, visibility: "open" | "private" = "open", creator = f.owner) => ({
    channel_id: id, workspace_id: f.workspace, slug, purpose,
    created_by_principal: creator, created_by_kind: "user",
    created_at: "2026-11-01T00:00:00Z", archived_at: null, visibility,
  });
  f.channelRows = [
    makeChannel(opsChannel, "ops", "Release coordination and deploys.", "open", f.owner),
    makeChannel(secretChannel, "secrets", "Private channel for key rotation.", "private", f.promotedManager ? peerAlex : f.owner),
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
        { kind: "user", id: peerAlex, name: f.sameName ? "Jordan Lee" : "Alex", left_at: null },
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
        { kind: "user", id: peerAlex, name: f.sameName ? "Jordan Lee" : "Alex", left_at: null },
      ],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: "2026-11-19T15:05:00Z", last_message_id: null,
    },
    {
      conversation_id: dmAlexConv, kind: "dm", channel_id: null, slug: null, description: null,
      archived_at: null, joined: true, generation: 1, lead_mode: null, lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "user", id: peerAlex, name: f.sameName ? "Jordan Lee" : "Alex", left_at: null },
      ],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: "2026-11-19T15:18:00Z", last_message_id: null,
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
    if (url.pathname.startsWith("/storage/v1/")) {
      f.uploadCalls.push(url.pathname);
      return Response.json({ Key: "synthetic" });
    }
    if (url.pathname === "/rest/v1/workspaces" && f.capture === "c3-lifetime") {
      return Response.json([
        { workspace_id: f.workspace, org_id: "33333333-3333-4333-8333-333333333333", name: "Home", archived_at: null },
        { workspace_id: secondWorkspace, org_id: "33333333-3333-4333-8333-333333333333", name: "Studio", archived_at: null },
      ]);
    }
    if (url.pathname === "/rest/v1/channels") {
      return Response.json(url.searchParams.get("workspace_id") === `eq.${f.workspace}` ? f.channelRows : []);
    }
    if (url.pathname === "/rest/v1/channel_members") {
      return Response.json(f.promotedManager ? [{ is_manager: true }] : []);
    }
    if (url.pathname === "/rest/v1/member_profiles") {
      if (f.sameName) {
        return Response.json([
          { user_id: f.owner, display_name: "Synthetic owner", role: f.viewerRole },
          { user_id: peerAlex, display_name: "Jordan Lee", role: "member" },
          { user_id: peerSam, display_name: "Jordan Lee", role: "member" },
        ]);
      }
      if (f.manyMembers) {
        return Response.json([
          { user_id: f.owner, display_name: "Synthetic owner", role: f.viewerRole },
          { user_id: peerAlex, display_name: "Alex", role: "member" },
          ...Array.from({ length: 10 }, (_, i) => ({
            user_id: `aaaa0000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`,
            display_name: `Teammate ${i + 1}`,
            role: "member",
          })),
        ]);
      }
      return Response.json([
        { user_id: f.owner, display_name: "Synthetic owner", role: f.viewerRole },
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
        if (body.workspace_id === secondWorkspace) return Response.json({ conversations: [] });
        f.convReadCount += 1;
        if (f.holdNextConvPoll) {
          f.holdNextConvPoll = false;
          const staleSnapshot = JSON.parse(JSON.stringify(f.conversations));
          await new Promise<void>((resolve) => { f.releaseConvPoll = resolve; });
          return Response.json({ conversations: staleSnapshot });
        }
        return Response.json({ conversations: f.conversations });
      }
      if (body?.resource === "conversation_history") {
        const matched = f.conversations.find((c: any) => c.conversation_id === body.conversation_id);
        if (!matched) {
          return Response.json({ error: "conversation_not_found", message: "This conversation isn't available in this workspace." }, { status: 404 });
        }
        return Response.json({ conversation: matched, messages: [], has_more: false, next_before: null, next_after: null });
      }
    }
    if (url.pathname === "/functions/v1/command" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      const command = body?.command;
      if (command?.kind === "file_create" || command?.kind === "file_upload_url") {
        f.uploadCalls.push(command.kind);
        return Response.json({ status: "accepted", file_id: "55555555-5555-4555-8555-555555555555", version_n: 1 });
      }
      if (command?.kind === "post_signal") {
        f.signalCommands.push(command);
        return Response.json({
          status: "accepted",
          signal: {
            id: "88888888-8888-4888-8888-" + String(f.signalCommands.length).padStart(12, "0"),
            created_at: new Date().toISOString(),
          },
        });
      }
      if (command?.kind && (String(command.kind).startsWith("conversation_") || String(command.kind).startsWith("channel_member_"))) {
        if (command.kind === "conversation_invite" && f.holdFirstInvite401) {
          f.invite401Count += 1;
          if (f.invite401Count === 1) {
            await new Promise<void>((resolve) => { f.releaseInvite401 = resolve; });
            return Response.json({ error: "unauthenticated", message: "Token expired" }, { status: 401 });
          }
        }
        f.convCommands.push({ command_id: body?.command_id, ...command });
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
          const isNotes = fullMembers.length === 1;
          const convId = isNotes ? notesConv : fullMembers.length === 2 && fullMembers[1].id === peerAlex ? dmAlexConv : newGroupConv;
          const conv = {
            conversation_id: convId,
            kind: fullMembers.length > 2 ? "group_dm" : "dm",
            channel_id: null, slug: null, description: null, archived_at: null,
            joined: true, generation: 2, lead_mode: null, lead_agent_principal_id: null,
            members: fullMembers.map((m: any) => ({ ...m, name: memberName(m), left_at: null })),
            notify_level: "everything", starred: false, star_rank: null,
            read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
            last_message_at: "2026-11-19T16:00:00Z", last_message_id: null,
          };
          f.conversations = [conv, ...f.conversations.filter((c: any) => c.conversation_id !== convId)];
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
      if (command?.kind === "signals_seen" || command?.kind === "channel_preference_set") return Response.json({ status: "accepted" });
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
  const pressKey = async (key: string) => {
    const response = await fetch(`/__key?key=${encodeURIComponent(key)}`);
    check(response.ok, "key failed (" + key + "): " + await response.text());
  };
  const centerReachable = (el: HTMLElement | null, label: string) => {
    target44(el, label);
    const r = el!.getBoundingClientRect();
    check(r.top >= 0 && r.bottom <= innerHeight + 0.5 && r.left >= 0 && r.right <= innerWidth + 0.5, `${label} clipped outside viewport: ${JSON.stringify(r)} vs ${innerWidth}x${innerHeight}`);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    check(hit?.closest("button") === el, `${label} center (${cx.toFixed(1)},${cy.toFixed(1)}) missed hit test: hit ${hit?.outerHTML.slice(0, 120)}`);
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
      await openDrawerIfPhone();
      await click(".hm-menu__trigger:visible");
      await wait("more menu open", () => visible(shown("[data-menu-conversation-members]")));
      await click("[data-menu-conversation-members]:visible");
    }
    await wait("members dialog open", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === true);
  };
  try {
    await wait("step 2b rail rendered", () => !!one("[data-home-dms]") && !!one(`[data-rail-channel="${f.ids.opsChannel}"]`));

    // C1 security witness: Group DM, Notes to self, ordinary 1:1 DM, and public #general through real composer.
    if (f.capture === "c1-dm-safety") {
      // 1. Group DM via rail: posts strictly via post_signal({ conversation_id }), NEVER workspace broadcast, and attaches disabled.
      await openDrawerIfPhone();
      await click(`[data-rail-conversation="${f.ids.dmGroupConv}"]:visible`);
      await wait("group dm open", () => location.search.includes(`dm=${f.ids.dmGroupConv}`) && visible(one("[data-composer]")));
      check(one<HTMLButtonElement>("[data-composer-attach]")?.disabled === true, "C1: attach button must be disabled in group DM");
      const input = one<HTMLTextAreaElement>("[data-composer-input]")!;
      input.value = "Group DM secret";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await click("[data-composer-send]:visible");
      await wait("group dm send landed", () => f.signalCommands.length === 1);
      check(
        f.signalCommands[0].conversation_id === f.ids.dmGroupConv &&
          !("channel" in f.signalCommands[0]) &&
          !("mentions" in f.signalCommands[0]),
        "C1: group DM must post by exact conversation_id without public broadcast: " + JSON.stringify(f.signalCommands[0]),
      );
      check(f.uploadCalls.length === 0, "C1: group DM must emit 0 upload calls");

      // 2. Notes to self via New message picker (selecting only self): posts strictly via post_signal({ conversation_id: notesConv }).
      await openDrawerIfPhone();
      await click("[data-home-new-dm]:visible");
      await wait("picker open for notes", () => one<HTMLDialogElement>("[data-conversation-picker-dialog]")?.open === true);
      await click(`[data-conversation-picker-option="user:${f.owner}"]:visible`);
      await click("[data-conversation-picker-submit]:visible");
      await wait("notes to self open", () => location.search.includes(`dm=${f.ids.notesConv}`) && visible(one("[data-composer]")));
      check(one<HTMLButtonElement>("[data-composer-attach]")?.disabled === true, "C1: attach button must be disabled in Notes to self");
      input.value = "Private self note";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await click("[data-composer-send]:visible");
      await wait("notes to self send landed", () => f.signalCommands.length === 2);
      check(
        f.signalCommands[1].conversation_id === f.ids.notesConv &&
          !("channel" in f.signalCommands[1]) &&
          !("mentions" in f.signalCommands[1]),
        "C1: Notes to self must post by exact conversation_id without public broadcast: " + JSON.stringify(f.signalCommands[1]),
      );
      check(f.uploadCalls.length === 0, "C1: Notes to self must emit 0 upload calls");

      // 3. Stage a file in #general, switch into ordinary 1:1 DM with Alex -> upload refused on Enter & Send button.
      await openDrawerIfPhone();
      await click('[data-rail-channel="general"]:visible');
      await wait("#general composer visible", () => visible(one("[data-composer]")));
      const dt = new DataTransfer();
      dt.items.add(new File(["secret"], "secret.txt", { type: "text/plain" }));
      const fileInput = one<HTMLInputElement>("[data-composer-file-input]")!;
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await wait("staged file chip in #general", () => !!one("[data-composer-attachments] button"));

      await openDrawerIfPhone();
      await click(`[data-rail-conversation="${f.ids.dmAlexConv}"]:visible`);
      await wait("1:1 dm open", () => !!one(`[data-rail-conversation="${f.ids.dmAlexConv}"][aria-current="page"]`) && visible(one("[data-composer]")));
      if (visible(one("[data-entity-panel-close]"))) {
        await click("[data-entity-panel-close]:visible");
        await wait("entity panel closed", () => !visible(one("[data-entity-panel]")));
      }
      check(one<HTMLButtonElement>("[data-composer-attach]")?.disabled === true, "C1: attach button must be disabled in 1:1 DM");
      input.value = "DM with staged file";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await click("[data-composer-send]:visible");
      await new Promise(r => setTimeout(r, 80));
      check(f.uploadCalls.length === 0, "C1: 1:1 DM must upload 0 files even when staged elsewhere");
      check(f.signalCommands.length === 2, "C1: 1:1 DM with staged file must send 0 new signals");

      // Remove staged file, send plain 1:1 DM -> exact conversation_id, never public broadcast.
      await click("[data-composer-attachments] button:visible");
      await wait("staged file removed", () => !one("[data-composer-attachments] button"));
      input.value = "Hello Alex privately";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await click("[data-composer-send]:visible");
      await wait("1:1 directed send landed", () => f.signalCommands.length === 3);
      check(
        f.signalCommands[2].conversation_id === f.ids.dmAlexConv &&
          !("mentions" in f.signalCommands[2]) &&
          !("channel" in f.signalCommands[2]),
        "C1: 1:1 DM must post by exact conversation_id, not public broadcast: " + JSON.stringify(f.signalCommands[2]),
      );

      // Public #general control: sends normally with no refusal.
      await openDrawerIfPhone();
      await click('[data-rail-channel="general"]:visible');
      await wait("back in #general", () => visible(one("[data-composer]")) && one<HTMLButtonElement>("[data-composer-attach]")?.disabled === false);
      input.value = "Public #general control";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await click("[data-composer-send]:visible");
      await wait("public control landed", () => f.signalCommands.length === 4);

      document.documentElement.dataset.step3cObservation = JSON.stringify({ ok: true, capture: f.capture, signals: f.signalCommands.length, uploads: f.uploadCalls.length });
      return;
    }

    // C2 security witness: promoted manager unchanged refresh, held older poll vs newer omission,
    // public-to-private conversion with same owner, archive fence, and browser Back retirement.
    if (f.capture === "c2-revalidation") {
      // 1. Promoted private-channel manager (role=member, Step 2b row omits is_manager; swarm_read.channel_members has is_manager=true).
      await openMembersSheet();
      check(visible(one("[data-conversation-members-add-toggle]")), "C2: promoted private-channel manager must see Add toggle");
      check(!!one(`[data-conversation-member-remove="user:${f.ids.peerAlex}"]`), "C2: promoted private-channel manager must see Remove button");

      // 1b. Unchanged refresh control: trigger forced channel unread/conversations refresh -> promoted manager's sheet MUST stay open!
      const readsBefore = f.convReadCount;
      one<HTMLButtonElement>("[data-channel-star]")?.click();
      await wait("unchanged conversations refresh landed", () => f.convReadCount > readsBefore);
      await new Promise(r => setTimeout(r, 80));
      check(one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === true, "C2: unchanged refresh must keep promoted manager sheet open");

      // 2. Held older allowed poll across newer access-loss omission:
      // Start an older background refresh that captures #secrets while still allowed, then omit #secrets before preflight.
      f.holdNextConvPoll = true;
      one<HTMLButtonElement>("[data-channel-star]")?.click();
      await wait("older poll held", () => typeof f.releaseConvPoll === "function");
      f.conversations = f.conversations.filter((c: any) => c.conversation_id !== f.ids.secretConv);
      await click("[data-conversation-members-add-toggle]:visible");
      await wait("secrets add panel", () => visible(one("[data-conversation-members-add-panel]")));
      await click(`[data-conversation-members-candidate="user:${f.ids.peerSam}"]:visible`);
      await click("[data-conversation-members-add-submit]:visible");
      await wait("stale secrets sheet closed", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === false);
      check(f.convCommands.length === 0, "C2: private access loss must dispatch 0 commands, got " + JSON.stringify(f.convCommands));
      check(!one(`[data-rail-channel="${f.ids.secretChannel}"]`), "C2: #secrets must be removed from rail after omission");
      // Release the older allowed poll -> shared conversationsGeneration MUST drop it so #secrets stays retired!
      f.releaseConvPoll!();
      await new Promise(r => setTimeout(r, 120));
      check(!one(`[data-rail-channel="${f.ids.secretChannel}"]`), "C2: older held poll must NOT restore revoked #secrets to rail");

      // 3. Held public-to-private conversion with the SAME owner (identical canAdd/canRemove booleans, changed kind/route):
      f.viewerRole = "owner";
      await click(`[data-rail-channel="${f.ids.opsChannel}"]:visible`);
      await wait("#ops open", () => location.search.includes(`c=${f.ids.opsChannel}`));
      await openMembersSheet();
      await click("[data-conversation-members-add-toggle]:visible");
      await wait("ops add panel", () => visible(one("[data-conversation-members-add-panel]")));
      await click(`[data-conversation-members-candidate="agent:${f.ids.peerLead}"]:visible`);
      const opsRow = f.conversations.find((c: any) => c.conversation_id === f.ids.opsConv);
      opsRow.kind = "private_channel";
      await click("[data-conversation-members-add-submit]:visible");
      await wait("converted ops sheet closed", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === false);
      check(f.convCommands.length === 0, "C2: public-to-private conversion must dispatch 0 commands, got " + JSON.stringify(f.convCommands));

      // 4. Archive fence on #ops:
      opsRow.kind = "public_channel";
      await openMembersSheet();
      await click("[data-conversation-members-add-toggle]:visible");
      await wait("ops add panel 2", () => visible(one("[data-conversation-members-add-panel]")));
      await click(`[data-conversation-members-candidate="agent:${f.ids.peerLead}"]:visible`);
      opsRow.archived_at = "2026-11-19T18:00:00Z";
      await click("[data-conversation-members-add-submit]:visible");
      await wait("archived ops sheet closed", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === false);
      check(f.convCommands.length === 0, "C2: archived channel must dispatch 0 commands, got " + JSON.stringify(f.convCommands));

      // 5. Browser Back (popstate) to a different view in the same workspace retires open Members sheet immediately:
      // Open the group DM (pushState, leaving #ops as the prior same-workspace entry) so Back stays inside /app.
      opsRow.archived_at = null;
      await click(`[data-rail-conversation="${f.ids.dmGroupConv}"]:visible`);
      await wait("group dm open for back check", () => location.search.includes(`dm=${f.ids.dmGroupConv}`));
      await openMembersSheet();
      window.history.back();
      await wait("sheet closed on browser Back", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === false && location.search.includes(`c=${f.ids.opsChannel}`));
      check(f.convCommands.length === 0, "C2: browser Back must dispatch 0 commands");

      document.documentElement.dataset.step3cObservation = JSON.stringify({ ok: true, capture: f.capture, commands: f.convCommands.length });
      return;
    }

    // C3 security witness: held first 401 followed by dialog close / reset must NOT dispatch retry attempt 1.
    if (f.capture === "c3-lifetime") {
      await openMembersSheet();
      await click("[data-conversation-members-add-toggle]:visible");
      await wait("ops add panel", () => visible(one("[data-conversation-members-add-panel]")));
      await click(`[data-conversation-members-candidate="agent:${f.ids.peerLead}"]:visible`);
      f.holdFirstInvite401 = true;
      await click("[data-conversation-members-add-submit]:visible");
      await wait("first invite held", () => f.invite401Count === 1 && typeof f.releaseInvite401 === "function");
      // Switch channel while first 401 is held -> reconciles/retires operation lifetime.
      one<HTMLAnchorElement>('[data-rail-channel="general"]')?.click();
      await wait("sheet retired on switch", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === false);
      // Now release the 401 -> postCommand must see isAlive() === false and NEVER send retry attempt 1!
      f.releaseInvite401!();
      await new Promise(r => setTimeout(r, 120));
      check(f.invite401Count === 1, "C3: retired operation must NOT dispatch retry attempt 1 after 401, got count=" + f.invite401Count);
      check(f.convCommands.length === 0, "C3: retired operation must record 0 accepted commands");
      document.documentElement.dataset.step3cObservation = JSON.stringify({ ok: true, capture: f.capture, inviteAttempts: f.invite401Count });
      return;
    }

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
        centerReachable(one<HTMLElement>("[data-conversation-members-add-submit]"), "Add submit");
        centerReachable(one<HTMLElement>("[data-conversation-members-add-cancel]"), "Add cancel");
      } else {
        target44(one<HTMLElement>(`[data-conversation-member-remove="user:${f.ids.peerAlex}"]`), "Remove button");
        await click(`[data-conversation-member-remove="user:${f.ids.peerAlex}"]:visible`);
        await wait("remove confirm open", () => visible(one(`[data-conversation-member-confirm="user:${f.ids.peerAlex}"]`)));
        centerReachable(one<HTMLElement>(`[data-conversation-member-remove-cancel="user:${f.ids.peerAlex}"]`), "Remove Cancel");
        centerReachable(one<HTMLElement>(`[data-conversation-member-remove-confirm="user:${f.ids.peerAlex}"]`), "Remove Confirm");
        if (f.sameName) {
          const confirmText = one(`[data-conversation-member-confirm="user:${f.ids.peerAlex}"]`)?.textContent ?? "";
          check(confirmText.includes("Jordan Lee · dddd44"), "same-name remove prompt must include discriminator: " + confirmText);
        }
      }
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
      document.documentElement.dataset.step3cObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    if (f.capture === "same-name-picker") {
      await openDrawerIfPhone();
      await click("[data-home-new-dm]:visible");
      await wait("picker open", () => one<HTMLDialogElement>("[data-conversation-picker-dialog]")?.open === true);
      const opt1 = one(`[data-conversation-picker-option="user:${f.ids.peerAlex}"]`);
      const opt2 = one(`[data-conversation-picker-option="user:${f.ids.peerSam}"]`);
      check(opt1?.textContent?.includes("Jordan Lee · dddd44") && opt2?.textContent?.includes("Jordan Lee · dddd55"), "both Jordan Lee rows must be distinguishable");
      await click(`[data-conversation-picker-option="user:${f.ids.peerAlex}"]:visible`);
      const chip = one<HTMLElement>(`[data-conversation-picker-chip="user:${f.ids.peerAlex}"]`);
      check(chip?.getAttribute("aria-label")?.includes("Jordan Lee · dddd44"), "selected chip aria-label must carry discriminator");
      centerReachable(chip, "same-name selected chip");
      centerReachable(one<HTMLElement>("[data-conversation-picker-submit]"), "picker Open");
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
    check(visible(one("[data-composer]")), "group DM must expose composer now that Step 3D posts by conversation_id");

    await openMembersSheet();
    check(!visible(one("[data-conversation-members-add-toggle]")), "DM Members must be read-only (no Add)");
    check(document.querySelectorAll("[data-conversation-member-remove]").length === 0, "DM Members must be read-only (no Remove)");
    await click("[data-conversation-members-close]:visible");
    await wait("dm members closed", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === false);

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
    await pressKey("Escape");
    await wait("ops members closed via Escape", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === false);
    check(document.activeElement !== document.body && visible(document.activeElement), "Escape must return focus to a reachable opener, got " + document.activeElement?.outerHTML.slice(0, 120));

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
      errors: f.errors, unexpected: f.unexpected, commands: f.convCommands, signals: f.signalCommands, uploads: f.uploadCalls,
    });
  }
}

test("Step 3C signed-in dashboard wires New message picker (#511 flows), Channel Members sheet, and C1/C2/C3 safety", { timeout: 160_000 }, async () => {
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
    if (url.pathname === "/__click") { void activePage!.locator(url.searchParams.get("selector")!).first().click({ timeout: 8_000 }).then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
    if (url.pathname === "/__key") { void activePage!.keyboard.press(url.searchParams.get("key")!).then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
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
    const secretCh = "77777777-7777-4777-8777-777777777777";
    const cases: { name: string; width: number; height: number; query: string; screenshot?: boolean }[] = [
      { name: "flow-360-light", width: 360, height: 740, query: `w=${ws}&c=general&theme=light&capture=flow` },
      { name: "flow-1024-dark", width: 1024, height: 1366, query: `w=${ws}&c=general&theme=dark&capture=flow` },
      { name: "c1-dm-safety-1024", width: 1024, height: 1366, query: `w=${ws}&c=general&theme=light&capture=c1-dm-safety&open_mode=direct` },
      { name: "c2-revalidation-1024", width: 1024, height: 1366, query: `w=${ws}&c=${secretCh}&theme=light&capture=c2-revalidation&viewer_role=member&promoted_manager=1` },
      { name: "c3-lifetime-1024", width: 1024, height: 1366, query: `w=${ws}&c=${opsCh}&theme=light&capture=c3-lifetime` },
      // Signed-in captures across 360, 390, 1024 in light & dark:
      { name: "360x740-light-picker", width: 360, height: 740, query: `w=${ws}&c=general&theme=light&capture=picker`, screenshot: true },
      { name: "360x740-dark-picker", width: 360, height: 740, query: `w=${ws}&c=general&theme=dark&capture=picker`, screenshot: true },
      { name: "390x844-light-picker-member-left", width: 390, height: 844, query: `w=${ws}&c=general&theme=light&capture=picker-member-left&open_mode=member_left`, screenshot: true },
      { name: "390x844-dark-picker-member-left", width: 390, height: 844, query: `w=${ws}&c=general&theme=dark&capture=picker-member-left&open_mode=member_left`, screenshot: true },
      { name: "1024x1366-light-picker-member-left", width: 1024, height: 1366, query: `w=${ws}&c=general&theme=light&capture=picker-member-left&open_mode=member_left`, screenshot: true },
      { name: "1024x1366-dark-picker", width: 1024, height: 1366, query: `w=${ws}&c=general&theme=dark&capture=picker`, screenshot: true },
      { name: "360x740-light-members-add", width: 360, height: 740, query: `w=${ws}&c=${opsCh}&theme=light&capture=members-add`, screenshot: true },
      { name: "360x740-dark-members-add", width: 360, height: 740, query: `w=${ws}&c=${opsCh}&theme=dark&capture=members-add`, screenshot: true },
      { name: "844x390-light-members-add-landscape", width: 844, height: 390, query: `w=${ws}&c=${opsCh}&theme=light&capture=members-add&many_members=1`, screenshot: true },
      { name: "360x740-light-same-name-picker", width: 360, height: 740, query: `w=${ws}&c=general&theme=light&capture=same-name-picker&same_name=1`, screenshot: true },
      { name: "360x740-light-same-name-members", width: 360, height: 740, query: `w=${ws}&c=${opsCh}&theme=light&capture=members-remove-confirm&same_name=1`, screenshot: true },
      { name: "390x844-light-members-remove-confirm", width: 390, height: 844, query: `w=${ws}&c=${opsCh}&theme=light&capture=members-remove-confirm`, screenshot: true },
      { name: "390x844-dark-members-remove-confirm", width: 390, height: 844, query: `w=${ws}&c=${opsCh}&theme=dark&capture=members-remove-confirm`, screenshot: true },
      { name: "1024x1366-light-members-add", width: 1024, height: 1366, query: `w=${ws}&c=${opsCh}&theme=light&capture=members-add`, screenshot: true },
      { name: "1024x1366-dark-members-remove-confirm", width: 1024, height: 1366, query: `w=${ws}&c=${opsCh}&theme=dark&capture=members-remove-confirm`, screenshot: true },
      { name: "390x844-light-dm-members-readonly", width: 390, height: 844, query: `w=${ws}&c=general&theme=light&capture=dm-members-readonly`, screenshot: true },
      { name: "1024x1366-dark-dm-members-readonly", width: 1024, height: 1366, query: `w=${ws}&c=general&theme=dark&capture=dm-members-readonly`, screenshot: true },
    ];
    for (const item of cases) {
      const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, hasTouch: item.width < 1024 });
      activePage = await context.newPage();
      try {
        await activePage.goto(`http://127.0.0.1:${address.port}/app?${item.query}`);
        await activePage.waitForFunction(() => !!document.documentElement.dataset.step3cObservation, null, { timeout: 25_000 });
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
