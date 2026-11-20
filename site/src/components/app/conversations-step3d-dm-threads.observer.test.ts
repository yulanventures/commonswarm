/** Signed-in mounted Step 3D-2 observer: 1-level 1:1 DM & group DM threads, hidden broadcast, fail-closed attachment guard, 404 thread_root_not_found, and Escape focus return. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";
import { chromium, type Page } from "playwright-core";
import { compileFixtureFunction, renderAstroFixture } from "../../../tests/astro-fixture";

function installDmThreadsFixture() {
  const f = (window as any).existingFixture;
  const params = new URL(location.href).searchParams;
  f.capture = params.get("capture") ?? sessionStorage.getItem("step3d2ReloadCapture") ?? "flow";
  f.testEscape = params.get("test_escape") === "1";
  f.signalCommands = [] as any[];
  f.uploadCalls = [] as string[];

  const peerAlex = "dddd4444-4444-4444-8444-444444444444";
  const peerLead = "eeee5555-5555-4555-8555-555555555555";
  const generalConv = "99990000-0000-4000-8000-000000000001";
  const secretChannel = "77777777-7777-4777-8777-777777777777";
  const secretConv = "99990000-0000-4000-8000-000000000007";
  const dmAlexConv = "aaaa1111-1111-4111-8111-111111111111";
  const dmGroupConv = "bbbb2222-2222-4222-8222-222222222222";
  const alexRootId = "f1000001-0000-4000-8000-000000000001";
  const groupRootId = "f2000001-0000-4000-8000-000000000001";
  const groupExistingReplyId = "f2000002-0000-4000-8000-000000000002";
  const missingRootId = "f2000003-0000-4000-8000-000000000003";
  const privateMissingRootId = "f3000001-0000-4000-8000-000000000001";
  f.ids = { peerAlex, peerLead, generalConv, secretChannel, secretConv, dmAlexConv, dmGroupConv, alexRootId, groupRootId, groupExistingReplyId, missingRootId, privateMissingRootId };

  const now = Date.now();
  const iso = (offsetSec: number) => new Date(now + offsetSec * 1000).toISOString();

  f.conversations = [
    {
      conversation_id: generalConv, kind: "general", channel_id: null, slug: "general", description: null,
      archived_at: null, joined: true, generation: 0, lead_mode: "workspace", lead_agent_principal_id: null,
      members: [], notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: iso(-120), last_message_id: null,
    },
    ...(f.capture === "flow" ? [{
      conversation_id: secretConv, kind: "private_channel", channel_id: secretChannel, slug: "secret-ops", description: "Private incident room.",
      archived_at: null, joined: true, generation: 0, lead_mode: "workspace", lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "user", id: peerAlex, name: "Alex", left_at: null },
      ],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: iso(-100), last_message_id: privateMissingRootId,
    }] : []),
    {
      conversation_id: dmAlexConv, kind: "dm", channel_id: null, slug: null, description: null,
      archived_at: null, joined: true, generation: 1, lead_mode: null, lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "user", id: peerAlex, name: "Alex", left_at: null },
      ],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: iso(-60), last_message_id: alexRootId,
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
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: iso(-20), last_message_id: missingRootId,
    },
  ];

  const mkMsg = (id: string, body: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
    id, workspace_id: f.workspace, from: peerAlex, from_kind: "user",
    to: f.owner, to_agent: null, kind: "note", body, attachments: [], about: null, until: iso(3600),
    created_at: createdAt, channel_id: null, thread_root_id: null, in_reply_to: null, broadcast_to_channel: false,
    ...extra,
  });

  const rowsByConv: Record<string, any[]> = {
    [generalConv]: [
      mkMsg("00000000-0000-4000-8000-000000000001", "Public #general status.", iso(-120), { to: null, conversation_id: generalConv }),
    ],
    [dmAlexConv]: [
      mkMsg(alexRootId, "1:1 DM root message from Alex.", iso(-60), { conversation_id: dmAlexConv, conversation_kind: "dm" }),
    ],
    [dmGroupConv]: [
      mkMsg(missingRootId, "Group DM message that disappears before reply.", iso(-20), { conversation_id: dmGroupConv, conversation_kind: "group_dm" }),
      mkMsg(groupExistingReplyId, "Lead reply inside the group DM thread.", iso(-30), {
        from: peerLead, from_kind: "agent", thread_root_id: groupRootId,
        conversation_id: dmGroupConv, conversation_kind: "group_dm",
      }),
      mkMsg(groupRootId, "Group DM launch checklist root.", iso(-90), { conversation_id: dmGroupConv, conversation_kind: "group_dm" }),
    ],
  };

  let seq = 1;
  const previous = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.test.invalid") return previous(input, init);
    if (url.pathname.startsWith("/storage/v1/")) {
      f.uploadCalls.push(url.pathname);
      return Response.json({ Key: "synthetic" });
    }
    if (url.pathname === "/rest/v1/channels") {
      return Response.json(f.capture === "flow" ? [{
        channel_id: secretChannel, workspace_id: f.workspace, slug: "secret-ops",
        purpose: "Private incident room.", created_by_principal: f.owner, created_by_kind: "user",
        created_at: "2026-11-01T00:00:00Z", archived_at: null, visibility: "private",
      }] : []);
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
      ]);
    }
    if (url.pathname === "/rest/v1/signals") {
      return Response.json(f.capture === "flow"
        ? [
          ...rowsByConv[generalConv],
          mkMsg(privateMissingRootId, "Secret ops incident root.", iso(-100), {
            to: null, channel_id: secretChannel, conversation_id: secretConv, conversation_kind: "private_channel",
          }),
        ]
        : rowsByConv[generalConv]);
    }
    if (url.pathname === "/rest/v1/rpc/channel_unread") {
      return Response.json({ workspace_id: f.workspace, generated_at: iso(0), channels: [{ channel_id: null, slug: "general", unread: false }] });
    }
    if (url.pathname === "/functions/v1/read" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      if (body?.resource === "conversations") return Response.json({ conversations: f.conversations });
      if (body?.resource === "conversation_history") {
        const convId = String(body.conversation_id ?? "");
        const conv = f.conversations.find((c: any) => c.conversation_id === convId);
        if (!conv) {
          return Response.json({ error: "conversation_not_found", message: "This conversation isn't available in this workspace." }, { status: 404 });
        }
        const rows = rowsByConv[convId] ?? [];
        return Response.json({
          conversation: conv,
          messages: rows,
          has_more: false,
          next_before: null,
          next_after: rows[0] ? { created_at: rows[0].created_at, id: rows[0].id } : null,
        });
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
        if (command.thread_root_id === missingRootId || command.thread_root_id === privateMissingRootId) {
          return Response.json(
            { status: "rejected", error: "thread_root_not_found", message: "There is no live message with that id in this workspace." },
            { status: 404 },
          );
        }
        const convId = String(command.conversation_id ?? "");
        const conv = f.conversations.find((c: any) => c.conversation_id === convId);
        const created = {
          id: "f9000000-0000-4000-8000-" + String(seq++).padStart(12, "0"),
          created_at: iso(seq),
          from: f.owner,
          from_kind: "user",
          to: peerAlex,
          to_agent: null,
          kind: command.signal_kind ?? "note",
          body: String(command.body ?? ""),
          channel_id: null,
          thread_root_id: command.thread_root_id ?? null,
          broadcast_to_channel: false,
          conversation_id: convId || null,
          conversation_kind: conv?.kind ?? null,
        };
        if (convId && rowsByConv[convId]) rowsByConv[convId] = [created, ...rowsByConv[convId]];
        return Response.json({ status: "accepted", signal: created });
      }
      if (command?.kind === "signals_seen" || command?.kind === "conversation_mark_read") {
        return Response.json({ status: "accepted" });
      }
    }
    return previous(input, init);
  };
}

async function observeDmThreads() {
  const f = (window as any).existingFixture;
  const one = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);
  const all = <T extends Element = HTMLElement>(s: string) => Array.from(document.querySelectorAll<T>(s));
  const visible = (el: Element | null): el is HTMLElement => !!el && !el.closest("[hidden]") && el.getClientRects().length > 0;
  const shown = <T extends HTMLElement>(s: string) => all<T>(s).find(visible) ?? null;
  const check = (value: unknown, msg: string) => { if (!value) throw new Error(msg); };
  let stage = "boot";
  const wait = async (label: string, ready: () => unknown) => {
    stage = label;
    const now = async () => (await (await fetch("/__observer-tick")).json()).now;
    const until = await now() + 10_000;
    while (!ready()) { if (await now() > until) throw new Error("timed out at " + label); }
  };
  const click = async (selector: string) => {
    const res = await fetch(`/__click?selector=${encodeURIComponent(selector)}`);
    check(res.ok, `click failed (${selector}): ${await res.text()}`);
  };
  const press = async (key: string) => {
    const res = await fetch(`/__press?key=${encodeURIComponent(key)}`);
    check(res.ok, `press failed (${key}): ${await res.text()}`);
  };
  const openReply = async (signalId: string) => {
    const btn = one<HTMLButtonElement>(`[data-message-reply="${signalId}"]`);
    check(!!btn, `Reply in thread button missing for ${signalId}`);
    // Focusing the reply control brings the floating .dashboard__message-tools bar out of rest (opacity:0; pointer-events:none) on both touch and desktop.
    btn!.focus();
    await click(`[data-message-reply="${signalId}"]`);
  };
  const dismissEntityPanel = async () => {
    const closeBtn = one<HTMLButtonElement>("[data-entity-panel-close]");
    if (closeBtn && visible(closeBtn)) {
      await click("[data-entity-panel-close]:visible");
      await wait("entity panel closed", () => !visible(one("[data-entity-panel-close]")));
    }
  };
  const openDrawerIfPhone = async () => {
    if (!visible(shown("[data-home-dms]"))) {
      await click('button[aria-label="Open navigation"]:visible');
      await wait("phone drawer open", () => visible(shown("[data-home-dms]")));
    }
  };

  try {
    if (f.capture === "missing-thread-reload") {
      await wait("group DM loaded for missing-thread reload check", () => (one("[data-feed-list]")?.textContent ?? "").includes("Group DM launch checklist root."));
      await dismissEntityPanel();
      const input = one<HTMLTextAreaElement>("[data-composer-input]")!;
      const isPhone = window.innerWidth < 1024;
      const phase = sessionStorage.getItem("step3d2ReloadPhase") ?? "setup";
      if (phase === "setup") {
        await openReply(f.ids.missingRootId);
        await wait("missing-root reply bar open before reload", () => visible(one("[data-composer-reply]")));
        input.value = "Draft for deleted root";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const cmdsBefore = f.signalCommands.length;
        if (isPhone) {
          await click("[data-composer-send]:visible");
        } else {
          input.focus();
          await press("Enter");
        }
        await wait("404 thread_root_not_found before reload", () =>
          f.signalCommands.length === cmdsBefore + 1 &&
          visible(one("[data-composer-reply]")) &&
          visible(one("[data-composer-move-to-conversation]")) &&
          (one("[data-composer-status]")?.textContent ?? "").includes("That thread isn't available anymore."),
        );
        // Edit preserved draft, leave group DM to #general and return, then verify explicit Move survives leave/return.
        input.value = "Draft for deleted root (edited before reload)";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await openDrawerIfPhone();
        await click('a[href*="c=general"]:visible');
        await wait("left group DM to #general", () => location.search.includes("c=general") && !visible(one("[data-composer-reply]")));
        check(input.value === "", "#general composer must not inherit unavailable DM thread draft");
        await openDrawerIfPhone();
        await click(`[data-rail-conversation="${f.ids.dmGroupConv}"]:visible`);
        await wait("returned to group DM with Move draft to conversation restored", () =>
          location.search.includes(`dm=${f.ids.dmGroupConv}`) &&
          input.value === "Draft for deleted root (edited before reload)" &&
          visible(one("[data-composer-reply]")) &&
          visible(one("[data-composer-move-to-conversation]")) &&
          (one("[data-composer-status]")?.textContent ?? "").includes("That thread isn't available anymore."),
        );
        if (isPhone) {
          await click("[data-composer-send]:visible");
        } else {
          input.focus();
          await press("Enter");
        }
        await new Promise((r) => setTimeout(r, 80));
        check(f.signalCommands.length === cmdsBefore + 1, "Send/Enter after leave+return must still be blocked before Move draft to conversation");
        sessionStorage.setItem("step3d2ReloadPhase", "verify");
        sessionStorage.setItem("step3d2ReloadCapture", "missing-thread-reload");
        document.documentElement.dataset.dmThreadsObservation = JSON.stringify({
          ok: true, capture: f.capture, phase: "setup", mode: isPhone ? "phone-send" : "desktop-enter",
        });
        return;
      }
      // Phase 2 (after real browser reload): unavailable thread state & Move action must be restored!
      await wait("reloaded group DM restored editable draft and Move draft to conversation", () =>
        input.value === "Draft for deleted root (edited before reload)" &&
        visible(one("[data-composer-reply]")) &&
        visible(one("[data-composer-move-to-conversation]")) &&
        (one("[data-composer-status]")?.textContent ?? "").includes("That thread isn't available anymore."),
      );
      check(!visible(one("[data-composer-reply-cancel]")), "reloaded unavailable bar must hide Cancel reply");
      check(f.signalCommands.length === 0, "reload itself must emit 0 post_signal commands");
      // Repeat Send (phone 360px) or Enter (desktop 1440px) after reload: MUST NOT post to main DM!
      if (isPhone) {
        await click("[data-composer-send]:visible");
      } else {
        input.focus();
        await press("Enter");
      }
      await new Promise((r) => setTimeout(r, 80));
      check(
        f.signalCommands.length === 0,
        `Designer reload: ${isPhone ? "phone Send" : "desktop Enter"} after reload must not post to main DM before Move draft to conversation`,
      );
      await press("Escape");
      check(visible(one("[data-composer-move-to-conversation]")), "Escape after reload must not bypass Move draft to conversation");
      await click("[data-composer-move-to-conversation]:visible");
      await wait("Move draft to conversation closed reply bar after reload", () => !visible(one("[data-composer-reply]")));
      check(input.value === "Draft for deleted root (edited before reload)", "Move draft to conversation after reload must keep edited draft");
      if (isPhone) {
        await click("[data-composer-send]:visible");
      } else {
        input.focus();
        await press("Enter");
      }
      await wait("post after Move draft to conversation succeeded after reload", () => f.signalCommands.length === 1);
      const movedAfterReload = f.signalCommands[0];
      check(
        movedAfterReload.conversation_id === f.ids.dmGroupConv &&
        !("thread_root_id" in movedAfterReload) &&
        !("channel" in movedAfterReload) &&
        movedAfterReload.body === "Draft for deleted root (edited before reload)",
        "Post after reload + explicit Move must target main group DM: " + JSON.stringify(movedAfterReload),
      );
      document.documentElement.dataset.dmThreadsObservation = JSON.stringify({
        ok: true, capture: f.capture, phase: "verify", mode: isPhone ? "phone-send" : "desktop-enter", commands: f.signalCommands.length,
      });
      return;
    }

    if (f.capture === "missing-thread-capture" || f.capture === "missing-thread-flow") {
      await wait("group DM loaded for missing-thread check", () => (one("[data-feed-list]")?.textContent ?? "").includes("Group DM launch checklist root."));
      await dismissEntityPanel();
      const input = one<HTMLTextAreaElement>("[data-composer-input]")!;
      const isPhone = window.innerWidth < 1024;
      await openReply(f.ids.missingRootId);
      await wait("missing-root reply bar open", () => visible(one("[data-composer-reply]")));
      input.value = "Draft for deleted root";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const cmdsBefore = f.signalCommands.length;
      if (isPhone) {
        await click("[data-composer-send]:visible");
      } else {
        input.focus();
        await press("Enter");
      }
      await wait("404 thread_root_not_found shows Move draft to conversation", () =>
        f.signalCommands.length === cmdsBefore + 1 &&
        visible(one("[data-composer-reply]")) &&
        visible(one("[data-composer-move-to-conversation]")) &&
        (one("[data-composer-status]")?.textContent ?? "").includes("That thread isn't available anymore."),
      );
      check(input.value === "Draft for deleted root", "missing thread must preserve unsent draft text");
      check(!visible(one("[data-composer-reply-cancel]")), "unavailable thread bar must show Move draft to conversation instead of Cancel reply");
      const moveRect = one<HTMLElement>("[data-composer-move-to-conversation]")!.getBoundingClientRect();
      check(moveRect.height >= 44, `Move draft to conversation target must be >=44px tall, got ${moveRect.height.toFixed(1)}px`);
      // Repeat Send (phone 360px) or Enter (desktop 1440px): must NOT post to main DM before explicit Move draft to conversation.
      if (isPhone) {
        await click("[data-composer-send]:visible");
      } else {
        input.focus();
        await press("Enter");
      }
      await new Promise((r) => setTimeout(r, 80));
      check(
        f.signalCommands.length === cmdsBefore + 1,
        `Designer: ${isPhone ? "phone Send" : "desktop Enter"} must not post to main DM before Move draft to conversation`,
      );
      if (f.capture === "missing-thread-capture") {
        await document.fonts.ready;
        check(document.documentElement.scrollWidth <= innerWidth, "missing-thread page overflow");
        document.documentElement.dataset.dmThreadsObservation = JSON.stringify({
          ok: true, capture: f.capture, moveHeight: moveRect.height, commands: f.signalCommands.length,
        });
        return;
      }
      // Edit preserved draft, verify repeated Send/Enter is still blocked, then click Move draft to conversation and send to main DM.
      input.value = "Draft for deleted root (edited)";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      check(visible(one("[data-composer-move-to-conversation]")), "editing draft must keep Move draft to conversation visible");
      await press("Escape");
      check(visible(one("[data-composer-move-to-conversation]")), "Escape must not silently move draft to conversation");
      if (isPhone) {
        await click("[data-composer-send]:visible");
      } else {
        input.focus();
        await press("Enter");
      }
      await wait("blocked send re-surfaces unavailable error", () =>
        (one("[data-composer-status]")?.textContent ?? "").includes("That thread isn't available anymore."),
      );
      check(f.signalCommands.length === cmdsBefore + 1, "edited draft must still not post to main DM before explicit Move draft to conversation");
      await click("[data-composer-move-to-conversation]:visible");
      await wait("Move draft to conversation closed reply bar", () => !visible(one("[data-composer-reply]")));
      check(input.value === "Draft for deleted root (edited)", "Move draft to conversation must keep edited draft text");
      if (isPhone) {
        await click("[data-composer-send]:visible");
      } else {
        input.focus();
        await press("Enter");
      }
      await wait("moved draft posted to main group DM", () => f.signalCommands.length === cmdsBefore + 2);
      const movedCmd = f.signalCommands[f.signalCommands.length - 1];
      check(
        movedCmd.conversation_id === f.ids.dmGroupConv &&
        !("thread_root_id" in movedCmd) &&
        !("channel" in movedCmd) &&
        movedCmd.body === "Draft for deleted root (edited)",
        "Moved draft must post as top-level main DM message: " + JSON.stringify(movedCmd),
      );
      document.documentElement.dataset.dmThreadsObservation = JSON.stringify({
        ok: true, capture: f.capture, mode: isPhone ? "phone-send" : "desktop-enter", commands: f.signalCommands.length,
      });
      return;
    }

    if (f.capture === "group-thread-capture") {
      await wait("group DM loaded", () => (one("[data-feed-list]")?.textContent ?? "").includes("Group DM launch checklist root."));
      await dismissEntityPanel();
      check(!!one(`[data-message-reply="${f.ids.groupRootId}"]`), "group DM top-level root must offer Reply in thread");
      check(!one(`[data-message-reply="${f.ids.groupExistingReplyId}"]`), "DM thread reply row must not offer Reply in thread (1-level deep)");
      await openReply(f.ids.groupRootId);
      await wait("DM thread reply bar visible", () => visible(one("[data-composer-reply]")));
      check(!visible(one("[data-composer-reply-broadcast-row]")), "broadcast checkbox must stay hidden in group DM threads");
      check(!visible(one("[data-composer-to]")), "To: Everyone here row must stay hidden in group DM threads");
      check(one<HTMLButtonElement>("[data-composer-attach]")?.disabled === true, "DM thread attach button must stay disabled");
      if (f.testEscape) {
        await press("Escape");
        await wait("Escape closed reply bar", () => !visible(one("[data-composer-reply]")));
        check(
          document.activeElement?.getAttribute("data-message-reply") === f.ids.groupRootId,
          `Escape must return focus to originating Reply button, got ${document.activeElement?.tagName}:${document.activeElement?.getAttribute("data-message-reply")}`,
        );
        await openReply(f.ids.groupRootId);
        await wait("DM thread reply bar reopened", () => visible(one("[data-composer-reply]")));
      }
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
      document.documentElement.dataset.dmThreadsObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    // Full flow: 1:1 DM thread reply -> Group DM thread reply -> DM attachment guard -> 404 thread_root_not_found -> Escape focus return.
    await wait("1:1 DM loaded", () => (one("[data-feed-list]")?.textContent ?? "").includes("1:1 DM root message from Alex."));
    await dismissEntityPanel();
    check(!!one(`[data-message-reply="${f.ids.alexRootId}"]`), "1:1 DM top-level message must offer Reply in thread");
    await openReply(f.ids.alexRootId);
    await wait("1:1 DM reply bar open", () => visible(one("[data-composer-reply]")));
    check((one("[data-composer-reply-target-text]")?.textContent ?? "").includes("Alex"), "1:1 DM reply bar must name Alex");
    check(!visible(one("[data-composer-reply-broadcast-row]")), "1:1 DM thread must hide broadcast checkbox");

    const input = one<HTMLTextAreaElement>("[data-composer-input]")!;
    input.value = "1:1 DM thread reply check";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await click("[data-composer-send]:visible");
    await wait("1:1 DM thread reply posted", () =>
      f.signalCommands.some((c: any) => c.conversation_id === f.ids.dmAlexConv && c.thread_root_id === f.ids.alexRootId),
    );
    const dm1Cmd = f.signalCommands.find((c: any) => c.conversation_id === f.ids.dmAlexConv && c.thread_root_id === f.ids.alexRootId);
    check(!("broadcast_to_channel" in dm1Cmd) && !("channel" in dm1Cmd) && !("to" in dm1Cmd) && !("mentions" in dm1Cmd),
      "1:1 DM thread reply must only send conversation_id + thread_root_id: " + JSON.stringify(dm1Cmd));
    await wait("1:1 DM reply count updated", () => (one(`[data-thread-toggle="${f.ids.alexRootId}"]`)?.textContent ?? "").includes("1 reply"));
    const dm1ReplyRows = all(`.dashboard__thread[data-thread-root="${f.ids.alexRootId}"] .dashboard__thread-replies .dashboard__message`);
    check(dm1ReplyRows.length === 1 && !dm1ReplyRows[0]?.querySelector("[data-message-reply]"), "1:1 DM reply row must stay 1-level deep");

    await openDrawerIfPhone();
    await click(`[data-rail-conversation="${f.ids.dmGroupConv}"]:visible`);
    await wait("Group DM loaded", () => (one("[data-feed-list]")?.textContent ?? "").includes("Group DM launch checklist root."));
    check((one(`[data-thread-toggle="${f.ids.groupRootId}"]`)?.textContent ?? "").includes("1 reply"), "Group DM starts with 1 reply");
    await openReply(f.ids.groupRootId);
    await wait("Group DM reply bar open", () => visible(one("[data-composer-reply]")));
    check((one("[data-composer-reply-target-text]")?.textContent ?? "").includes("Alex and Lead"), "Group DM reply bar must name Alex and Lead");
    check(!visible(one("[data-composer-reply-broadcast-row]")), "Group DM thread must hide broadcast checkbox");
    check(!visible(one("[data-composer-to]")), "Group DM thread must hide To: Everyone here row");
    check(one<HTMLButtonElement>("[data-composer-attach]")?.disabled === true, "Group DM thread must keep attach disabled");

    const picker = one<HTMLInputElement>("[data-composer-file-input]")!;
    const dt = new DataTransfer();
    dt.items.add(new File(["secret"], "private.txt", { type: "text/plain" }));
    picker.files = dt.files;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await wait("DM thread drop refused", () => (one("[data-composer-status]")?.textContent ?? "").includes("Attachments aren't available in private conversations."));
    check(f.uploadCalls.length === 0, "DM thread attachment refusal must make zero upload calls");

    input.value = "Second reply in group DM thread";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await click("[data-composer-send]:visible");
    await wait("Group DM thread reply posted", () =>
      f.signalCommands.some((c: any) => c.conversation_id === f.ids.dmGroupConv && c.thread_root_id === f.ids.groupRootId),
    );
    const groupCmd = f.signalCommands.find((c: any) => c.conversation_id === f.ids.dmGroupConv && c.thread_root_id === f.ids.groupRootId);
    check(!("broadcast_to_channel" in groupCmd) && !("channel" in groupCmd), "Group DM thread reply must omit broadcast_to_channel and channel");
    await wait("Group DM reply count updated to 2 replies", () => (one(`[data-thread-toggle="${f.ids.groupRootId}"]`)?.textContent ?? "").includes("2 replies"));

    await openReply(f.ids.missingRootId);
    await wait("missing-root reply bar open", () => visible(one("[data-composer-reply]")));
    const cmdsBeforeMissing = f.signalCommands.length;
    input.value = "Draft for deleted root";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await click("[data-composer-send]:visible");
    await wait("404 thread_root_not_found handled with explicit Move draft to conversation", () =>
      f.signalCommands.length === cmdsBeforeMissing + 1 &&
      visible(one("[data-composer-reply]")) &&
      visible(one("[data-composer-move-to-conversation]")) &&
      (one("[data-composer-status]")?.textContent ?? "").includes("That thread isn't available anymore."),
    );
    check(input.value === "Draft for deleted root", "404 thread_root_not_found must preserve unsent draft text");
    check((one("[data-feed-list]")?.textContent ?? "").includes("Group DM launch checklist root."), "404 thread_root_not_found must not evict DM");
    // Repeat Send and Enter before Move draft to conversation: must NOT post to main DM.
    await click("[data-composer-send]:visible");
    input.focus();
    await press("Enter");
    await new Promise((r) => setTimeout(r, 80));
    check(f.signalCommands.length === cmdsBeforeMissing + 1, "Send/Enter must not post to main DM before Move draft to conversation");
    // Explicitly move draft to conversation, then verify top-level post succeeds.
    await click("[data-composer-move-to-conversation]:visible");
    await wait("Move draft to conversation cleared reply bar", () => !visible(one("[data-composer-reply]")));
    check(input.value === "Draft for deleted root", "Move draft to conversation must keep draft text");
    await click("[data-composer-send]:visible");
    await wait("explicitly moved draft posted to main group DM", () => f.signalCommands.length === cmdsBeforeMissing + 2);
    const movedMainCmd = f.signalCommands[f.signalCommands.length - 1];
    check(
      movedMainCmd.conversation_id === f.ids.dmGroupConv && !("thread_root_id" in movedMainCmd),
      "Moved draft must post to main group DM without thread_root_id: " + JSON.stringify(movedMainCmd),
    );

    await openReply(f.ids.groupRootId);
    await wait("reply bar open for Escape check", () => visible(one("[data-composer-reply]")));
    await press("Escape");
    await wait("Escape cancelled DM thread reply", () => !visible(one("[data-composer-reply]")));
    check(
      document.activeElement?.getAttribute("data-message-reply") === f.ids.groupRootId,
      `Escape must restore focus to Reply button for ${f.ids.groupRootId}`,
    );

    // Leaving a DM with an open DM thread reply to #general must clear the DM thread reply bar immediately.
    await openReply(f.ids.groupRootId);
    await wait("DM reply bar reopened before channel switch", () => visible(one("[data-composer-reply]")));
    await openDrawerIfPhone();
    await click('a[href*="c=general"]:visible');
    await wait("switched to #general with DM reply bar cleared", () =>
      location.search.includes("c=general") && !visible(one("[data-composer-reply]")),
    );
    check(one("[data-composer-audience]")?.getAttribute("data-audience") === "public", "switching from DM thread to #general must restore public audience");

    // HezSec C1: a refused 404 thread_root_not_found on a private-channel reply started from All messages
    // must NEVER close the reply bar into the workspace-wide #general composer or turn private text into a #general draft.
    await click(".hm-menu__trigger:visible");
    await wait("more menu open for All messages", () => visible(shown('[data-menu-channel-place=""]')));
    await click('[data-menu-channel-place=""]:visible');
    await wait("All messages loaded with private-channel root", () =>
      !location.search.includes("c=") &&
      (one("[data-feed-list]")?.textContent ?? "").includes("Secret ops incident root."),
    );
    await openReply(f.ids.privateMissingRootId);
    await wait("private-channel reply bar open in All messages", () =>
      visible(one("[data-composer-reply]")) &&
      (one("[data-composer-reply-target-text]")?.textContent ?? "").includes("#secret-ops"),
    );
    const cmdsBeforePrivate404 = f.signalCommands.length;
    input.value = "Private channel reply that must never post to general";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await click("[data-composer-send]:visible");
    await wait("private-channel 404 refusal shown", () =>
      f.signalCommands.length === cmdsBeforePrivate404 + 1 &&
      (one("[data-composer-status]")?.textContent ?? "").includes("That thread isn't available anymore."),
    );
    check(visible(one("[data-composer-reply]")), "HezSec C1: private-channel 404 must keep reply bar bound to #secret-ops, never close to #general");
    check(!visible(one("[data-composer-move-to-conversation]")), "HezSec C1: private-channel 404 must never offer Move draft to conversation");
    check(
      (one("[data-composer-reply-target-text]")?.textContent ?? "").includes("#secret-ops"),
      "HezSec C1: reply bar must stay bound to #secret-ops: " + one("[data-composer-reply-target-text]")?.textContent,
    );
    // A follow-up ordinary Send must STILL target the refused private thread_root_id and NEVER post top-level to #general.
    await click("[data-composer-send]:visible");
    await wait("second Send stayed bound to private thread root", () => f.signalCommands.length === cmdsBeforePrivate404 + 2);
    const privateAttempts = f.signalCommands.slice(cmdsBeforePrivate404);
    check(
      privateAttempts.every((c: any) => c.thread_root_id === f.ids.privateMissingRootId && !("channel" in c) && !("conversation_id" in c)),
      "HezSec C1: refused private-channel reply must never re-target #general or workspace composer: " + JSON.stringify(privateAttempts),
    );

    document.documentElement.dataset.dmThreadsObservation = JSON.stringify({
      ok: true,
      commands: f.signalCommands.length,
      uploads: f.uploadCalls.length,
    });
  } catch (error) {
    document.documentElement.dataset.dmThreadsObservation = JSON.stringify({
      error: String(error),
      stage,
      errors: f.errors,
      unexpected: f.unexpected,
      commands: f.signalCommands,
      uploads: f.uploadCalls,
    });
  }
}

test("Step 3D-2 signed-in dashboard enables 1-level DM and group DM threads, hides broadcast, guards attachments, handles 404, and restores Escape focus", { timeout: 140_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const dmFixture = await compileFixtureFunction(new URL(import.meta.url), "installDmThreadsFixture");
  const observe = await compileFixtureFunction(new URL(import.meta.url), "observeDmThreads");
  const html = "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" + styles.join("\n") +
    "</style><script>" + install + dmFixture + "</script></head><body>" + markup + "<script type='module'>" + observe + "</script></body></html>";
  const fonts = fileURLToPath(new URL("../../../public/fonts/", import.meta.url));
  let activePage: Page | null = null;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/__observer-tick") { setTimeout(() => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ now: Date.now() })); }, 2); return; }
    if (url.pathname === "/__click") { void activePage!.locator(url.searchParams.get("selector")!).first().click({ timeout: 8_000 }).then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
    if (url.pathname === "/__press") { void activePage!.keyboard.press(url.searchParams.get("key")!).then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
    if (url.pathname.startsWith("/fonts/") && url.pathname.endsWith(".woff2")) { void readFile(join(fonts, basename(url.pathname))).then(data => { response.writeHead(200, { "Content-Type": "font/woff2" }); response.end(data); }, () => { response.writeHead(404); response.end(); }); return; }
    response.writeHead(200, { "Content-Type": url.pathname === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
    response.end(url.pathname === "/app.js" ? bundled.join("\n") : html);
  });
  const browser = await launchPlaywrightChromium(chromium);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const evidence = join(process.cwd(), "../site-observer-evidence/conversations-step3d-dm-threads");
    await mkdir(evidence, { recursive: true });
    const ws = "11111111-1111-4111-8111-111111111111";
    const dmAlex = "aaaa1111-1111-4111-8111-111111111111";
    const dmGroup = "bbbb2222-2222-4222-8222-222222222222";
    const cases: { name: string; width: number; height: number; query: string; screenshot?: boolean; reload?: boolean }[] = [
      { name: "flow-1024-light", width: 1024, height: 1366, query: `w=${ws}&dm=${dmAlex}&theme=light&capture=flow` },
      { name: "missing-thread-360-send", width: 360, height: 740, query: `w=${ws}&dm=${dmGroup}&theme=light&capture=missing-thread-flow` },
      { name: "missing-thread-1440-enter", width: 1440, height: 900, query: `w=${ws}&dm=${dmGroup}&theme=light&capture=missing-thread-flow` },
      { name: "missing-thread-reload-360-send", width: 360, height: 740, query: `w=${ws}&dm=${dmGroup}&theme=light&capture=missing-thread-reload`, reload: true },
      { name: "missing-thread-reload-1440-enter", width: 1440, height: 900, query: `w=${ws}&dm=${dmGroup}&theme=light&capture=missing-thread-reload`, reload: true },
      { name: "360x740-light-dm-thread-missing", width: 360, height: 740, query: `w=${ws}&dm=${dmGroup}&theme=light&capture=missing-thread-capture`, screenshot: true },
      { name: "360x740-dark-dm-thread-missing", width: 360, height: 740, query: `w=${ws}&dm=${dmGroup}&theme=dark&capture=missing-thread-capture`, screenshot: true },
      { name: "1440x900-light-dm-thread-missing", width: 1440, height: 900, query: `w=${ws}&dm=${dmGroup}&theme=light&capture=missing-thread-capture`, screenshot: true },
      { name: "1440x900-dark-dm-thread-missing", width: 1440, height: 900, query: `w=${ws}&dm=${dmGroup}&theme=dark&capture=missing-thread-capture`, screenshot: true },
      { name: "360x740-light-dm-thread", width: 360, height: 740, query: `w=${ws}&dm=${dmGroup}&theme=light&capture=group-thread-capture&test_escape=1`, screenshot: true },
      { name: "360x740-dark-dm-thread", width: 360, height: 740, query: `w=${ws}&dm=${dmGroup}&theme=dark&capture=group-thread-capture`, screenshot: true },
      { name: "390x844-light-dm-thread", width: 390, height: 844, query: `w=${ws}&dm=${dmGroup}&theme=light&capture=group-thread-capture&test_escape=1`, screenshot: true },
      { name: "390x844-dark-dm-thread", width: 390, height: 844, query: `w=${ws}&dm=${dmGroup}&theme=dark&capture=group-thread-capture`, screenshot: true },
      { name: "1024x1366-light-dm-thread", width: 1024, height: 1366, query: `w=${ws}&dm=${dmGroup}&theme=light&capture=group-thread-capture&test_escape=1`, screenshot: true },
      { name: "1024x1366-dark-dm-thread", width: 1024, height: 1366, query: `w=${ws}&dm=${dmGroup}&theme=dark&capture=group-thread-capture`, screenshot: true },
      { name: "1440x900-light-dm-thread", width: 1440, height: 900, query: `w=${ws}&dm=${dmGroup}&theme=light&capture=group-thread-capture&test_escape=1`, screenshot: true },
      { name: "1440x900-dark-dm-thread", width: 1440, height: 900, query: `w=${ws}&dm=${dmGroup}&theme=dark&capture=group-thread-capture`, screenshot: true },
    ];
    const outcomes: Record<string, any> = {};
    for (const item of cases) {
      const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, hasTouch: item.width < 1024 });
      activePage = await context.newPage();
      try {
        await activePage.goto(`http://127.0.0.1:${address.port}/app?${item.query}`);
        await activePage.waitForFunction(() => !!document.documentElement.dataset.dmThreadsObservation, null, { timeout: 25_000 });
        let result = await activePage.evaluate(() => JSON.parse(document.documentElement.dataset.dmThreadsObservation!));
        if (item.reload && result.ok) {
          await activePage.reload();
          await activePage.waitForFunction(() => !!document.documentElement.dataset.dmThreadsObservation, null, { timeout: 25_000 });
          result = await activePage.evaluate(() => JSON.parse(document.documentElement.dataset.dmThreadsObservation!));
        }
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
