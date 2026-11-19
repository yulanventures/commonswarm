/** Signed-in mounted Step 3D-1 observer: true DM/group DM/Notes history, paired cursors, post_signal({ conversation_id }), #general/All DM exclusion, 404 non-oracle, and leave/revocation clearing. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";
import { chromium, type Page } from "playwright-core";
import { compileFixtureFunction, renderAstroFixture } from "../../../tests/astro-fixture";

function installConversations3DFixture() {
  const f = (window as any).existingFixture;
  const params = new URL(location.href).searchParams;
  f.capture = params.get("capture") ?? "flow";
  f.historyRequests = [] as any[];
  f.conversationsReadCount = 0;
  f.unsupportedResponseCount = 0;
  f.signalCommands = [] as any[];
  f.uploadCalls = [] as string[];
  f.fileCreateCalls = 0;
  f.storagePutCalls = 0;
  f.fileCommitCalls = 0;
  f.convCommands = [] as any[];
  f.failNextOlder = params.get("fail_older") === "1";
  f.failOlderSticky = params.get("fail_older_sticky") === "1";
  f.failConversations = params.get("fail_conversations") ?? "";
  f.unjoinedOps = params.get("unjoined_ops") === "1";
  f.holdNextOlder = false;
  f.releaseOlder = null as null | (() => void);
  f.holdNextPost = false;
  f.failHeldPost = false;
  f.releasePost = null as null | (() => void);
  f.holdFirstHistoryFor = params.get("hold_first_history") ?? "";
  f.releaseFirstHistory = null as null | (() => void);
  f.holdNextSignals = false;
  f.releaseSignals = null as null | (() => void);
  f.holdNextConversations = false;
  f.releaseConversations = null as null | (() => void);
  f.holdNextChannelVisibility = false;
  f.releaseChannelVisibility = null as null | (() => void);
  f.holdNextAuthUser = false;
  f.releaseAuthUser = null as null | (() => void);
  f.holdNextAfterRefresh = false;
  f.releaseAfterRefresh = null as null | (() => void);
  f.omitFromNextConversations = new Set<string>();
  f.revokeGroup = false;

  const opsChannel = "66666666-6666-4666-8666-666666666666";
  const generalConv = "99990000-0000-4000-8000-000000000001";
  const opsConv = "99990000-0000-4000-8000-000000000002";
  const dmAlexConv = "aaaa1111-1111-4111-8111-111111111111";
  const dmGroupConv = "bbbb2222-2222-4222-8222-222222222222";
  const notesConv = "cccc4444-4444-4444-8444-444444444444";
  const unknownConv = "deadbeef-dead-4eef-8eef-deadbeef0000";
  const peerAlex = "dddd4444-4444-4444-8444-444444444444";
  const peerLead = "eeee5555-5555-4555-8555-555555555555";
  f.ids = { opsChannel, generalConv, opsConv, dmAlexConv, dmGroupConv, notesConv, unknownConv, peerAlex, peerLead };

  f.channelRows = [
    {
      channel_id: opsChannel, workspace_id: f.workspace, slug: "ops",
      purpose: "Release coordination.", created_by_principal: f.owner, created_by_kind: "user",
      created_at: "2026-11-01T00:00:00Z", archived_at: null, visibility: "open",
    },
  ];
  f.conversations = [
    {
      conversation_id: generalConv, kind: "general", channel_id: null, slug: "general", description: null,
      archived_at: null, joined: true, generation: 0, lead_mode: "workspace", lead_agent_principal_id: null,
      members: [], notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: "2026-11-19T16:10:00Z", last_message_id: null,
    },
    {
      conversation_id: opsConv, kind: "public_channel", channel_id: opsChannel, slug: "ops",
      description: "Release coordination.", archived_at: null, joined: !f.unjoinedOps, generation: 0,
      lead_mode: "workspace", lead_agent_principal_id: null,
      members: [{ kind: "user", id: f.owner, name: "Synthetic owner", left_at: null }],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: "2026-11-19T16:05:00Z", last_message_id: null,
    },
    {
      conversation_id: dmAlexConv, kind: "dm", channel_id: null, slug: null, description: null,
      archived_at: null, joined: true, generation: 1, lead_mode: null, lead_agent_principal_id: null,
      members: [
        { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
        { kind: "user", id: peerAlex, name: "Alex", left_at: null },
      ],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: "2026-11-19T16:12:00Z", last_message_id: null,
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
      last_message_at: "2026-11-19T16:20:00Z", last_message_id: null,
    },
    {
      conversation_id: notesConv, kind: "dm", channel_id: null, slug: null, description: null,
      archived_at: null, joined: true, generation: 1, lead_mode: null, lead_agent_principal_id: null,
      members: [{ kind: "user", id: f.owner, name: "Synthetic owner", left_at: null }],
      notify_level: "everything", starred: false, star_rank: null,
      read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
      last_message_at: "2026-11-19T16:08:00Z", last_message_id: null,
    },
  ];

  const mkMsg = (id: string, body: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
    id, workspace_id: f.workspace, from: peerAlex, from_kind: "user",
    to: null, to_agent: null, kind: "note", body, attachments: [], about: null, until: null,
    created_at: createdAt, channel_id: null, thread_root_id: null, in_reply_to: null, broadcast_to_channel: false,
    ...extra,
  });

  // Build 18 newest + 4 older messages for group DM so scrolling + Load older + Jump to present exercise real geometry.
  const groupNewest = Array.from({ length: 18 }, (_, i) => {
    const n = 22 - i;
    const sec = String(n).padStart(2, "0");
    return mkMsg(
      `00000000-0000-4000-8000-0000000001${sec}`,
      `Group DM message #${n}: coordinating private launch checklist item ${n}.`,
      `2026-11-19T16:15:${sec}Z`,
      { conversation_id: dmGroupConv, from: n % 2 === 0 ? peerAlex : peerLead, from_kind: n % 2 === 0 ? "user" : "agent" },
    );
  });
  const groupOlder = Array.from({ length: 4 }, (_, i) => {
    const n = 4 - i;
    const sec = String(n).padStart(2, "0");
    return mkMsg(
      `00000000-0000-4000-8000-0000000001${sec}`,
      `Older group DM history #${n}: earlier architecture decision.`,
      `2026-11-19T16:14:${sec}Z`,
      { conversation_id: dmGroupConv },
    );
  });
  const historyByConv: Record<string, { newest: any[]; older: any[] }> = {
    [generalConv]: {
      newest: [mkMsg("00000000-0000-4000-8000-000000000001", "Public #general status update.", "2026-11-19T16:10:00Z", { conversation_id: generalConv })],
      older: [],
    },
    [opsConv]: {
      newest: [mkMsg("00000000-0000-4000-8000-000000000002", "Ops channel deploy note.", "2026-11-19T16:05:00Z", { channel_id: opsChannel, conversation_id: opsConv })],
      older: [],
    },
    [dmAlexConv]: {
      newest: [mkMsg("00000000-0000-4000-8000-000000000003", "Private 1:1 DM from Alex.", "2026-11-19T16:12:00Z", { to: f.owner, conversation_id: dmAlexConv })],
      older: [],
    },
    [dmGroupConv]: { newest: groupNewest, older: groupOlder },
    [notesConv]: {
      newest: [mkMsg("00000000-0000-4000-8000-000000000004", "Private self note draft.", "2026-11-19T16:08:00Z", { from: f.owner, to: f.owner, conversation_id: notesConv })],
      older: [],
    },
  };

  const previous = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.test.invalid") return previous(input, init);
    if (url.pathname === "/auth/v1/user" && f.holdNextAuthUser) {
      f.holdNextAuthUser = false;
      await new Promise<void>((resolve) => { f.releaseAuthUser = resolve; });
      return previous(input, init);
    }
    if (url.pathname.startsWith("/storage/v1/")) {
      f.storagePutCalls += 1;
      f.uploadCalls.push(url.pathname);
      return Response.json({ Key: "synthetic" });
    }
    if (url.pathname === "/rest/v1/channels") {
      if (f.holdNextChannelVisibility && url.searchParams.get("channel_id") === `eq.${opsChannel}`) {
        f.holdNextChannelVisibility = false;
        await new Promise<void>((resolve) => { f.releaseChannelVisibility = resolve; });
      }
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
      ]);
    }
    if (url.pathname === "/rest/v1/signals") {
      if (f.holdNextSignals) {
        f.holdNextSignals = false;
        await new Promise<void>((resolve) => { f.releaseSignals = resolve; });
      }
      // Production PostgREST projection omits conversation_id/conversation_kind; include addressed DM rows to prove fail-closed exclusion.
      const stripConv = (row: any) => {
        const copy = { ...row };
        delete copy.conversation_id;
        delete copy.conversation_kind;
        return copy;
      };
      return Response.json([
        ...historyByConv[generalConv].newest.map(stripConv),
        ...historyByConv[opsConv].newest.map(stripConv),
        ...historyByConv[dmAlexConv].newest.map(stripConv),
        stripConv({ ...groupNewest[0], to: f.owner }),
        ...historyByConv[notesConv].newest.map(stripConv),
      ]);
    }
    if (url.pathname === "/rest/v1/rpc/channel_unread") {
      return Response.json({
        workspace_id: f.workspace, generated_at: new Date().toISOString(),
        channels: [
          { channel_id: null, slug: "general", unread: false },
          { channel_id: opsChannel, slug: "ops", unread: false },
        ],
      });
    }
    if (url.pathname === "/functions/v1/read" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      if (body?.resource === "conversations") {
        f.conversationsReadCount += 1;
        if (f.holdNextConversations) {
          f.holdNextConversations = false;
          await new Promise<void>((resolve) => { f.releaseConversations = resolve; });
        }
        if (f.failConversations === "404") {
          return Response.json({}, { status: 404 });
        }
        if (f.failConversations === "invalid_request") {
          return Response.json({ error: "invalid_request", message: "Invalid request." }, { status: 400 });
        }
        if (f.failConversations === "unsupported_resource") {
          f.unsupportedResponseCount += 1;
          return Response.json({ error: "unsupported_resource", message: "Unsupported resource." }, { status: 400 });
        }
        if (f.failConversations === "1" || f.failConversations === "503") {
          return Response.json({ error: "service_unavailable", message: "Conversations service unavailable." }, { status: 503 });
        }
        const list = f.conversations.filter((c: any) =>
          !(f.revokeGroup && c.conversation_id === dmGroupConv) &&
          !f.omitFromNextConversations.has(c.conversation_id),
        );
        return Response.json({ conversations: list });
      }
      if (body?.resource === "conversation_history") {
        f.historyRequests.push(body);
        const convId = String(body.conversation_id ?? "");
        if (body.after_created_at && body.after_id && f.holdNextAfterRefresh) {
          f.holdNextAfterRefresh = false;
          await new Promise<void>((resolve) => { f.releaseAfterRefresh = resolve; });
        }
        if (!body.before_created_at && !body.after_created_at && f.holdFirstHistoryFor === convId) {
          f.holdFirstHistoryFor = "";
          await new Promise<void>((resolve) => { f.releaseFirstHistory = resolve; });
        }
        const conv = f.conversations.find((c: any) => c.conversation_id === convId);
        if (!conv || (f.revokeGroup && convId === dmGroupConv)) {
          return Response.json(
            { error: "conversation_not_found", message: "This conversation isn't available in this workspace." },
            { status: 404 },
          );
        }
        const store = historyByConv[convId] ?? { newest: [], older: [] };
        if (body.before_created_at && body.before_id) {
          if (f.failOlderSticky) {
            return Response.json({ error: "service_unavailable", message: "History read failed." }, { status: 503 });
          }
          if (f.failNextOlder) {
            f.failNextOlder = false;
            return Response.json({ error: "service_unavailable", message: "History read failed." }, { status: 503 });
          }
          if (f.holdNextOlder) {
            f.holdNextOlder = false;
            await new Promise<void>((resolve) => { f.releaseOlder = resolve; });
          }
          return Response.json({
            conversation: conv,
            messages: store.older,
            has_more: false,
            next_before: null,
            next_after: null,
          });
        }
        const oldest = store.newest.at(-1);
        const newest = store.newest[0];
        return Response.json({
          conversation: conv,
          messages: store.newest,
          has_more: store.older.length > 0,
          next_before: store.older.length > 0 && oldest ? { created_at: oldest.created_at, id: oldest.id } : null,
          next_after: newest ? { created_at: newest.created_at, id: newest.id } : null,
        });
      }
    }
    if (url.pathname === "/functions/v1/command" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      const command = body?.command;
      if (command?.kind === "file_version_create" || command?.kind === "file_create" || command?.kind === "file_upload_url") {
        f.fileCreateCalls += 1;
        f.uploadCalls.push(command.kind);
        return Response.json({ status: "accepted", file_id: "55555555-5555-4555-8555-555555555555", version_id: "55555555-5555-4555-8555-555555555556", version_n: 1, upload_path: "/storage/v1/object/upload/sign/test" });
      }
      if (command?.kind === "file_version_commit") {
        f.fileCommitCalls += 1;
        f.uploadCalls.push(command.kind);
        return Response.json({ status: "accepted", file_id: command.file_id, version_n: 1 });
      }
      if (command?.kind === "post_signal") {
        if (f.holdNextPost) {
          f.holdNextPost = false;
          await new Promise<void>((resolve) => { f.releasePost = resolve; });
          if (f.failHeldPost) {
            f.failHeldPost = false;
            return Response.json({ status: "rejected", error: "service_unavailable", message: "Temporary post failure." }, { status: 503 });
          }
        }
        f.signalCommands.push(command);
        const created = {
          id: "88888888-8888-4888-8888-" + String(f.signalCommands.length).padStart(12, "0"),
          created_at: new Date().toISOString(),
          from: f.owner,
          from_kind: "user",
          kind: command.signal_kind ?? "note",
          body: command.body,
          channel_id: null,
          conversation_id: command.conversation_id ?? null,
        };
        if (command.conversation_id && historyByConv[command.conversation_id]) {
          historyByConv[command.conversation_id].newest.unshift(created);
        }
        return Response.json({ status: "accepted", signal: created });
      }
      if (command?.kind === "conversation_leave") {
        f.convCommands.push(command);
        f.conversations = f.conversations.filter((c: any) => c.conversation_id !== command.conversation_id);
        return Response.json({ status: "accepted", conversation_id: command.conversation_id, changed: true });
      }
      if (
        command?.kind === "conversation_set_notify" ||
        command?.kind === "conversation_invite" ||
        command?.kind === "channel_members_add"
      ) {
        f.convCommands.push(command);
        return Response.json({ status: "accepted", conversation_id: command.conversation_id ?? opsConv, changed: true });
      }
      if (command?.kind === "signals_seen" || command?.kind === "conversation_mark_read") {
        return Response.json({ status: "accepted" });
      }
    }
    return previous(input, init);
  };
}

async function observeConversations3D() {
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
  const press = async (key: string) => {
    const response = await fetch(`/__press?key=${encodeURIComponent(key)}`);
    check(response.ok, "press failed (" + key + "): " + await response.text());
  };
  const openDrawerIfPhone = async () => {
    if (!visible(shown("[data-home-dms]"))) {
      await click('button[aria-label="Open navigation"]:visible');
      await wait("phone drawer open", () => visible(shown("[data-home-dms]")));
    }
  };
  try {
    // Designer #1 & #2 witness: Retry Load older keeps visible message coordinate stable before, while pending, and after prepend,
    // and moves keyboard focus from the disappearing Load older button to a visible message (or preserves focus if reader tabbed away).
    if (f.capture === "designer-retry" || f.capture === "designer-retry-tab-away") {
      await wait("group dm history loaded for designer retry", () =>
        (one("[data-feed-list]")?.textContent ?? "").includes("Group DM message #22") &&
        visible(one("[data-load-older]")),
      );
      const scroller = one<HTMLElement>(".dashboard__feed-view")!;
      scroller.scrollTop = 0;
      if (!visible(one("[data-load-older-error]")) && !one<HTMLButtonElement>("[data-load-older]")?.disabled) {
        await click("[data-load-older]:visible");
      }
      await wait("older 503 error visible", () => visible(one("[data-load-older-error]")));
      const loadBtn = one<HTMLButtonElement>("[data-load-older]")!;
      loadBtn.focus();
      check(document.activeElement === loadBtn, "Load older button must be focused before Retry");
      const msg6 = [...document.querySelectorAll<HTMLElement>("[data-feed-list] .dashboard__message[data-signal-id]")]
        .find((row) => (row.textContent ?? "").includes("Group DM message #6"))!;
      check(!!msg6, "Group DM message #6 must be rendered");
      const topBefore = msg6.getBoundingClientRect().top;

      f.failOlderSticky = false;
      f.holdNextOlder = true;
      await press("Enter");
      await wait("retry request held in flight", () => typeof f.releaseOlder === "function");
      const topWhilePending = msg6.getBoundingClientRect().top;
      check(
        Math.abs(topWhilePending - topBefore) <= 1.0,
        `Designer #1: message #6 moved while pending (${topBefore.toFixed(1)} -> ${topWhilePending.toFixed(1)})`,
      );
      if (f.capture === "designer-retry-tab-away") {
        one<HTMLTextAreaElement>("[data-composer-input]")?.focus();
      }
      f.releaseOlder();
      await wait("older final page prepended", () => (one("[data-feed-list]")?.textContent ?? "").includes("Older group DM history #1") && !visible(one("[data-load-older]")));
      const msg6After = [...document.querySelectorAll<HTMLElement>("[data-feed-list] .dashboard__message[data-signal-id]")]
        .find((row) => (row.textContent ?? "").includes("Group DM message #6"))!;
      const topAfter = msg6After.getBoundingClientRect().top;
      check(
        Math.abs(topAfter - topBefore) <= 1.5,
        `Designer #1: message #6 moved after prepend (${topBefore.toFixed(1)} -> ${topAfter.toFixed(1)})`,
      );
      if (f.capture === "designer-retry-tab-away") {
        check(
          document.activeElement === one("[data-composer-input]"),
          "Designer #2: focus tabbed away while pending must stay on composer input",
        );
      } else {
        const active = document.activeElement as HTMLElement | null;
        check(
          !!active && active !== document.body && active.classList.contains("dashboard__message"),
          `Designer #2: focus must land on a visible message row after Load older hides, got ${active?.tagName}.${active?.className}`,
        );
      }
      document.documentElement.dataset.step3dObservation = JSON.stringify({
        ok: true, capture: f.capture, topBefore, topWhilePending, topAfter,
      });
      return;
    }

    // HezSec #1 + Lead #2 + HezSec #6 + Lead #1 witness: draft isolation across navigation, held failing send across nav & eviction,
    // honest agent-oversight DM audience sentence, and addressed channel post omitting conversation_id.
    if (f.capture === "hezsec-drafts-and-audience") {
      await wait("group dm loaded", () => (one("[data-feed-list]")?.textContent ?? "").includes("Group DM message #22"));
      // HezSec #6: agent-including group DM must state agent-owner oversight.
      check(
        (one("[data-composer-audience-sentence]")?.textContent ?? "").includes("Agent owners can read their agents' DMs."),
        "HezSec #6: agent group DM must state agent-owner oversight: " + one("[data-composer-audience-sentence]")?.textContent,
      );
      const input = one<HTMLTextAreaElement>("[data-composer-input]")!;
      input.value = "Confidential group draft";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      // Immediately navigate to #general before debounce fires -> textarea must clear, Enter must NOT post to #general!
      await click('a[href*="c=general"]:visible');
      await wait("switched to #general", () => location.search.includes("c=general") && (one("[data-feed-list]")?.textContent ?? "").includes("Public #general status update."));
      check(input.value === "", "HezSec #1 / Lead #2: #general textarea must not inherit group DM draft, got: " + input.value);
      input.focus();
      await press("Enter");
      await new Promise((r) => setTimeout(r, 80));
      check(f.signalCommands.length === 0, "HezSec #1: Enter in #general must send 0 commands after DM switch");

      // HezSec C1 (popstate): Back from Group DM to #general clears private text BEFORE Enter!
      await click(`[data-rail-conversation="${f.ids.dmGroupConv}"]:visible`);
      await wait("pushed group dm for popstate check", () => location.search.includes(`dm=${f.ids.dmGroupConv}`) && (one("[data-feed-list]")?.textContent ?? "").includes("Group DM message #22"));
      input.value = "Private popstate draft";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      history.back();
      await wait("popstate returned to #general", () => location.search.includes("c=general") && (one("[data-feed-list]")?.textContent ?? "").includes("Public #general status update."));
      check(input.value === "", "HezSec C1: browser Back (popstate) must clear private DM draft from #general box before Enter, got: " + input.value);
      input.focus();
      await press("Enter");
      await new Promise((r) => setTimeout(r, 80));
      check(f.signalCommands.length === 0, "HezSec C1: Enter in #general after popstate must send 0 commands");

      // Switch to human-only 1:1 DM (Alex) -> keeps exclusive sentence and empty draft.
      await click(`[data-rail-conversation="${f.ids.dmAlexConv}"]:visible`);
      await wait("1:1 DM Alex loaded", () => (one("[data-feed-list]")?.textContent ?? "").includes("Private 1:1 DM from Alex."));
      const panelClose = one<HTMLButtonElement>("[data-entity-panel-close]");
      if (panelClose && visible(panelClose)) await click("[data-entity-panel-close]:visible");
      check(
        one("[data-composer-audience-sentence]")?.textContent === "Only Alex and you can read this.",
        "HezSec #6: human-only 1:1 DM keeps exclusive promise: " + one("[data-composer-audience-sentence]")?.textContent,
      );
      check(input.value === "", "1:1 DM must not inherit group DM draft");

      // Switch back to Group DM -> latest group DM draft ("Private popstate draft") restored!
      await click(`[data-rail-conversation="${f.ids.dmGroupConv}"]:visible`);
      await wait("returned to group dm", () => (one("[data-feed-list]")?.textContent ?? "").includes("Group DM message #22"));
      check(input.value === "Private popstate draft", "group DM draft must restore on return, got: " + input.value);

      // Held failing DM send across navigation to #general -> must NOT write failed DM text into #general!
      f.holdNextPost = true;
      f.failHeldPost = true;
      await click("[data-composer-send]:visible");
      await wait("DM post held in flight", () => typeof f.releasePost === "function");
      await click('a[href*="c=general"]:visible');
      await wait("navigated to #general while DM post held", () => location.search.includes("c=general"));
      f.releasePost();
      await new Promise((r) => setTimeout(r, 120));
      check(input.value === "", "HezSec #1: held failing DM send must not restore body into #general, got: " + input.value);

      // Held failing DM send across Group DM leave/eviction -> revoked draft must be discarded from textarea & localStorage!
      await click(`[data-rail-conversation="${f.ids.dmGroupConv}"]:visible`);
      await wait("back in group dm for eviction send", () => (one("[data-feed-list]")?.textContent ?? "").includes("Group DM message #22"));
      input.value = "Evicted secret send";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      f.holdNextPost = true;
      f.failHeldPost = true;
      await click("[data-composer-send]:visible");
      await wait("second DM post held", () => typeof f.releasePost === "function");
      await click(`[data-rail-conversation-menu="${f.ids.dmGroupConv}"]:visible`);
      await wait("group menu open", () => visible(one(".cs-context-menu")));
      await click('.cs-context-menu__item:has-text("Leave group")');
      await wait("leave confirm open", () => one<HTMLDialogElement>("[data-group-leave-dialog]")?.open === true);
      await click("[data-group-leave-confirm]:visible");
      await wait("group evicted", () => location.search.includes("c=general"));
      f.releasePost();
      await new Promise((r) => setTimeout(r, 120));
      const groupDraftKey = `commonswarm:composer-draft:${f.owner}:${f.workspace}:conv:${f.ids.dmGroupConv}`;
      check(input.value === "", "HezSec #1: held failed send after eviction must not populate textarea");
      check(localStorage.getItem(groupDraftKey) === null, "HezSec #1: held failed send after eviction must discard revoked localStorage draft");

      // HezSec C1 (held visibility upload): stage file in open #ops, hold fresh visibility read, switch away -> 0 create/PUT/commit/post!
      await click(`a[href*="c=${f.ids.opsChannel}"]:visible`);
      await wait("#ops loaded for held visibility upload", () => (location.search.includes(`c=${f.ids.opsChannel}`) || location.search.includes("c=ops")) && visible(one("[data-composer]")));
      const opsPicker = one<HTMLInputElement>("[data-composer-file-input]")!;
      const opsDt = new DataTransfer();
      opsDt.items.add(new File(["sensitive"], "ops-report.txt", { type: "text/plain" }));
      opsPicker.files = opsDt.files;
      opsPicker.dispatchEvent(new Event("change", { bubbles: true }));
      await wait("staged file chip in #ops", () => !!one("[data-composer-attachments] button"));
      input.value = "Ops message with staged file";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      f.holdNextChannelVisibility = true;
      await click("[data-composer-send]:visible");
      await wait("channel visibility read held", () => typeof f.releaseChannelVisibility === "function");
      // Switch to 1:1 DM Alex while visibility check is held -> retires the #ops upload scope!
      await click(`[data-rail-conversation="${f.ids.dmAlexConv}"]:visible`);
      await wait("switched to 1:1 dm while visibility held", () => location.search.includes(`dm=${f.ids.dmAlexConv}`));
      f.releaseChannelVisibility();
      await new Promise((r) => setTimeout(r, 140));
      check(
        f.fileCreateCalls === 0 && f.storagePutCalls === 0 && f.fileCommitCalls === 0 && f.signalCommands.length === 0,
        `HezSec C1: held visibility across scope retirement must emit 0 file_create(${f.fileCreateCalls}), 0 PUT(${f.storagePutCalls}), 0 commit(${f.fileCommitCalls}), 0 post(${f.signalCommands.length})`,
      );

      // HezSec C1 (public channel thread -> popstate to DM): push 1:1 DM Alex from #general, navigate Back to #general,
      // open a public #general thread reply, then navigate Forward via browser history (popstate restoring DM) ->
      // must clear stale threadReplyRoot, show private DM audience marker, and post strictly to DM conversation_id.
      await click('a[href*="c=general"]:visible');
      await wait("on #general before pushing 1:1 dm", () => location.search.includes("c=general") && !!one('[data-message-reply="00000000-0000-4000-8000-000000000001"]'));
      await click(`[data-rail-conversation="${f.ids.dmAlexConv}"]:visible`);
      await wait("pushed 1:1 dm Alex onto history", () => location.search.includes(`dm=${f.ids.dmAlexConv}`) && (one("[data-feed-list]")?.textContent ?? "").includes("Private 1:1 DM from Alex."));
      history.back();
      await wait("popstate back to #general", () => location.search.includes("c=general") && !!one('[data-message-reply="00000000-0000-4000-8000-000000000001"]'));
      const generalReplyBtn = one<HTMLButtonElement>('[data-message-reply="00000000-0000-4000-8000-000000000001"]')!;
      generalReplyBtn.focus();
      generalReplyBtn.click();
      await wait("public #general thread reply open before popstate", () =>
        visible(one("[data-composer-reply]")) &&
        (one("[data-composer-reply-target-text]")?.textContent ?? "").includes("Replying to Alex"),
      );
      history.forward();
      await wait("popstate restored 1:1 DM Alex from public thread", () =>
        location.search.includes(`dm=${f.ids.dmAlexConv}`) &&
        (one("[data-feed-list]")?.textContent ?? "").includes("Private 1:1 DM from Alex."),
      );
      check(!visible(one("[data-composer-reply]")), "HezSec C1: popstate to DM must clear stale public thread reply bar");
      check(
        one("[data-composer-audience]")?.getAttribute("data-audience") === "private" &&
        one("[data-composer-audience-sentence]")?.textContent === "Only Alex and you can read this.",
        "HezSec C1: popstate to DM must show exact private DM audience marker: " + one("[data-composer-audience-sentence]")?.textContent,
      );
      input.value = "Private message after popstate from public thread";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await click("[data-composer-send]:visible");
      await wait("DM message sent after popstate from public thread", () => f.signalCommands.length === 1);
      const popstateDmCmd = f.signalCommands[0];
      check(
        popstateDmCmd.conversation_id === f.ids.dmAlexConv &&
        !("thread_root_id" in popstateDmCmd) &&
        !("channel" in popstateDmCmd) &&
        !("broadcast_to_channel" in popstateDmCmd),
        "HezSec C1: post after popstate to DM must target DM conversation_id with no public thread_root_id: " + JSON.stringify(popstateDmCmd),
      );

      document.documentElement.dataset.step3dObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    // HezSec #2 & #3 witness: authoritative omission while first page is held, background draft wipe, held legacy All messages fence.
    if (f.capture === "hezsec-held-omission-and-fences") {
      const notesDraftKey = `commonswarm:composer-draft:${f.owner}:${f.workspace}:conv:${f.ids.notesConv}`;
      localStorage.setItem(notesDraftKey, JSON.stringify({ body: "Background notes secret" }));
      await wait(
        "first group history page held and rail populated",
        () => typeof f.releaseFirstHistory === "function" && !!one(`[data-rail-conversation-menu="${f.ids.dmAlexConv}"]`),
      );
      // Trigger a fresh authoritative `refreshConversations(workspaceId, true)` while STAYING on the loading group DM
      // by starring another conversation row in the rail (dmAlexConv), with BOTH dmGroupConv and notesConv omitted.
      await click(`[data-rail-conversation-menu="${f.ids.dmAlexConv}"]:visible`);
      await wait("alex rail menu open while group history held", () => visible(one(".cs-context-menu")));
      f.omitFromNextConversations.add(f.ids.dmGroupConv);
      f.omitFromNextConversations.add(f.ids.notesConv);
      await click('.cs-context-menu__item:has-text("Star")');
      await wait("group DM evicted while first page still held", () => !!one("[data-channel-unavailable]"));
      check(localStorage.getItem(notesDraftKey) === null, "HezSec #2: background omitted DM draft must be wiped immediately");
      // Now release the held first history page -> must paint NOTHING and never re-add the group DM to rail!
      f.releaseFirstHistory();
      await new Promise((r) => setTimeout(r, 120));
      check(!!one("[data-channel-unavailable]"), "HezSec #2: held first page must not overwrite unavailable state");
      check(!one(`[data-rail-conversation="${f.ids.dmGroupConv}"]`), "HezSec #2: held first page must not re-add omitted DM to rail");

      // HezSec #3: held legacy All messages /rest/v1/signals read settling after switching to 1:1 DM must NOT overwrite DM rows!
      await click("[data-channel-go-general]:visible");
      await wait("in #general", () => location.search.includes("c=general"));
      f.holdNextSignals = true;
      await click(".hm-menu__trigger:visible");
      await wait("more menu open", () => visible(shown('[data-menu-channel-place=""]')));
      await click('[data-menu-channel-place=""]:visible');
      await wait("legacy All messages signals held", () => typeof f.releaseSignals === "function");
      await click(`[data-rail-conversation="${f.ids.dmAlexConv}"]:visible`);
      await wait("1:1 DM Alex loaded", () => (one("[data-feed-list]")?.textContent ?? "").includes("Private 1:1 DM from Alex."));
      f.releaseSignals();
      await new Promise((r) => setTimeout(r, 120));
      const dmFeedText = one("[data-feed-list]")?.textContent ?? "";
      check(dmFeedText.includes("Private 1:1 DM from Alex."), "HezSec #3: DM must keep its own rows");
      check(!dmFeedText.includes("Public #general status update."), "HezSec #3: held All messages read must not overwrite open DM");

      // HezSec #3 (held-session acquisition): hold /auth/v1/user inside currentSession() while opening Notes to self,
      // then switch back to 1:1 DM Alex before auth resolves -> 0 /functions/v1/read conversation_history sends for Notes!
      const notesReadsBefore = f.historyRequests.filter((r: any) => r.conversation_id === f.ids.notesConv).length;
      f.omitFromNextConversations.delete(f.ids.notesConv);
      f.conversations = [
        ...f.conversations.filter((c: any) => c.conversation_id !== f.ids.notesConv),
        {
          conversation_id: f.ids.notesConv, kind: "dm", channel_id: null, slug: null, description: null,
          archived_at: null, joined: true, generation: 1, lead_mode: null, lead_agent_principal_id: null,
          members: [{ kind: "user", id: f.owner, name: "Synthetic owner", left_at: null }],
          notify_level: "everything", starred: false, star_rank: null,
          read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
          last_message_at: "2026-11-19T16:08:00Z", last_message_id: null,
        },
      ];
      // Trigger a held-session acquisition on a real click into 1:1 DM Alex -> switch to #general while /auth/v1/user is held -> 0 reads for Alex after release!
      await click('a[href*="c=general"]:visible');
      await wait("in #general before held-session check", () => location.search.includes("c=general"));
      const alexReadsBefore = f.historyRequests.filter((r: any) => r.conversation_id === f.ids.dmAlexConv).length;
      f.holdNextAuthUser = true;
      await click(`[data-rail-conversation="${f.ids.dmAlexConv}"]:visible`);
      await wait("currentSession /auth/v1/user held", () => typeof f.releaseAuthUser === "function");
      await click('a[href*="c=general"]:visible');
      await wait("retired Alex DM back to #general before session resolved", () => location.search.includes("c=general"));
      f.releaseAuthUser();
      await new Promise((r) => setTimeout(r, 140));
      const alexReadsAfter = f.historyRequests.filter((r: any) => r.conversation_id === f.ids.dmAlexConv).length;
      check(
        alexReadsAfter === alexReadsBefore,
        `HezSec C3: held session acquisition retired by route change must dispatch 0 reads (before=${alexReadsBefore}, after=${alexReadsAfter})`,
      );
      check(notesReadsBefore >= 0, "notes read baseline recorded");

      // HezSec #3 (held Realtime-triggered refresh): trigger live refresh via visibilitychange on 1:1 DM Alex,
      // hold the conversation_history after-cursor response, switch to #general, release -> #general stays clean!
      await click(`[data-rail-conversation="${f.ids.dmAlexConv}"]:visible`);
      await wait("1:1 DM Alex open for held realtime refresh", () => (one("[data-feed-list]")?.textContent ?? "").includes("Private 1:1 DM from Alex."));
      f.holdNextAfterRefresh = true;
      document.dispatchEvent(new Event("visibilitychange"));
      await wait("live after-cursor refresh held", () => typeof f.releaseAfterRefresh === "function");
      await click('a[href*="c=general"]:visible');
      await wait("switched to #general while realtime refresh held", () => location.search.includes("c=general") && (one("[data-feed-list]")?.textContent ?? "").includes("Public #general status update."));
      f.releaseAfterRefresh();
      await new Promise((r) => setTimeout(r, 120));
      const genAfterHeldRefresh = one("[data-feed-list]")?.textContent ?? "";
      check(genAfterHeldRefresh.includes("Public #general status update."), "HezSec C3: #general stays intact after held DM refresh");
      check(!genAfterHeldRefresh.includes("Private 1:1 DM from Alex."), "HezSec C3: held Realtime DM refresh must not paint DM rows into #general");

      document.documentElement.dataset.step3dObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    // HezSec C3 (Members preflight bearer retirement): start on #ops, push 1:1 DM Alex via openDirectConversation,
    // go Back to #ops, hold /auth/v1/user inside Members preflight listConversations, then navigate Forward via
    // popstate (reconcileOpenMembersSheet closes the busy dialog & retires lifetime) -> 0 outgoing conversations reads & 0 commands!
    if (f.capture === "hezsec-members-preflight") {
      await wait("#ops loaded initially", () =>
        (one("[data-feed-list]")?.textContent ?? "").includes("Ops channel deploy note.") &&
        !!one(`[data-rail-conversation="${f.ids.dmAlexConv}"]`),
      );
      await click(`[data-rail-conversation="${f.ids.dmAlexConv}"]:visible`);
      await wait("pushed 1:1 DM Alex onto history", () =>
        location.search.includes(`dm=${f.ids.dmAlexConv}`) &&
        (one("[data-feed-list]")?.textContent ?? "").includes("Private 1:1 DM from Alex."),
      );
      history.back();
      await wait("returned to #ops via popstate", () =>
        (location.search.includes(`c=${f.ids.opsChannel}`) || location.search.includes("c=ops")) &&
        (one("[data-feed-list]")?.textContent ?? "").includes("Ops channel deploy note.") &&
        !!shown("[data-conversation-members-open]"),
      );
      await click("[data-conversation-members-open]:visible");
      await wait("Members sheet open on #ops", () => one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === true);
      await click("[data-conversation-members-add-toggle]:visible");
      await wait("Lead candidate visible in Members add panel", () => !!shown(`[data-conversation-members-candidate="agent:${f.ids.peerLead}"]`));
      await click(`[data-conversation-members-candidate="agent:${f.ids.peerLead}"]:visible`);
      const convReadsBeforePreflight = f.conversationsReadCount;
      const convCmdsBeforePreflight = f.convCommands.length;
      f.holdNextAuthUser = true;
      f.releaseAuthUser = null;
      await click("[data-conversation-members-add-submit]:visible");
      await wait("Members preflight /auth/v1/user held", () => typeof f.releaseAuthUser === "function");
      // Retire the busy Members sheet via real route navigation (popstate -> reconcileOpenMembersSheet -> closeMembers(false) -> lifetime.retire()).
      history.forward();
      await wait("Members sheet retired by popstate while preflight auth held", () =>
        one<HTMLDialogElement>("[data-conversation-members-dialog]")?.open === false &&
        location.search.includes(`dm=${f.ids.dmAlexConv}`),
      );
      f.releaseAuthUser();
      await new Promise((r) => setTimeout(r, 140));
      check(
        f.conversationsReadCount === convReadsBeforePreflight && f.convCommands.length === convCmdsBeforePreflight,
        `HezSec C3: retired Members preflight must emit 0 conversations reads (before=${convReadsBeforePreflight}, after=${f.conversationsReadCount}) and 0 commands (before=${convCmdsBeforePreflight}, after=${f.convCommands.length})`,
      );

      document.documentElement.dataset.step3dObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    // HezSec #4 & #5 witness: bare 404 (and 503) conversations list fails closed (Retry, read-only, DM exclusion active),
    // and unjoined/failed channel membership blocks BOTH top-level and real thread submits before any upload/post.
    if (f.capture === "hezsec-503-and-unjoined") {
      await wait("#general rendered during bare 404 conversations", () => (one("[data-feed-list]")?.textContent ?? "").includes("Public #general status update."));
      const genText = one("[data-feed-list]")?.textContent ?? "";
      check(
        !genText.includes("Private 1:1 DM from Alex.") && !genText.includes("Group DM message") && !genText.includes("Private self note draft."),
        "HezSec #4: #general must exclude legacy production-projection DM rows during bare 404 conversations read",
      );
      await click(".hm-menu__trigger:visible");
      await wait("more menu open during bare 404", () => visible(shown('[data-menu-channel-place=""]')));
      await click('[data-menu-channel-place=""]:visible');
      await wait("All messages rendered during bare 404", () => !location.search.includes("c=") && (one("[data-feed-list]")?.textContent ?? "").includes("Public #general status update."));
      const all503Text = one("[data-feed-list]")?.textContent ?? "";
      check(
        !all503Text.includes("Private 1:1 DM from Alex.") && !all503Text.includes("Group DM message") && !all503Text.includes("Private self note draft."),
        "HezSec #4: All messages must exclude legacy production-projection DM rows during bare 404 conversations read",
      );

      // Navigate to #ops while conversations read returns bare 404 -> must show Retry bar (NOT legacy composer!) and block submit!
      await click(`a[href*="c=${f.ids.opsChannel}"]:visible`);
      await wait("#ops loaded with failed membership on bare 404", () => (location.search.includes(`c=${f.ids.opsChannel}`) || location.search.includes("c=ops")) && visible(one("[data-channel-membership-retry-bar]")));
      const form = one<HTMLFormElement>("[data-composer]")!;
      const input = one<HTMLTextAreaElement>("[data-composer-input]")!;
      check(!visible(form), "HezSec C4: bare 404 must keep composer hidden (fail-closed Retry, never legacy fallback)");
      input.value = "Should be blocked while membership failed on 404";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 80));
      check(
        f.signalCommands.length === 0 && f.fileCreateCalls === 0 && f.storagePutCalls === 0 && f.fileCommitCalls === 0,
        "HezSec #5: bare 404 failed membership must block submit with 0 posts/uploads",
      );

      // Now recover conversations with #ops unjoined -> top-level submit AND real thread reply submit both blocked with 0 posts/uploads!
      f.failConversations = "";
      await click("[data-channel-membership-retry]:visible");
      await wait("unjoined #ops preview bar visible", () => visible(one("[data-channel-preview-bar]")));
      input.value = "Top-level unjoined bypass attempt";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 80));
      check(
        f.signalCommands.length === 0 && f.fileCreateCalls === 0 && f.storagePutCalls === 0 && f.fileCommitCalls === 0,
        "HezSec #5: unjoined #ops must block top-level submit with 0 posts/uploads",
      );
      // Unconditionally open the real Reply in thread on #ops's message and assert thread reply submit is blocked fail-closed!
      const opsReplyBtn = one<HTMLButtonElement>('[data-message-reply="00000000-0000-4000-8000-000000000002"]');
      check(!!opsReplyBtn, "HezSec #5: unjoined #ops message must expose Reply in thread button");
      opsReplyBtn!.focus();
      opsReplyBtn!.click();
      await wait("thread reply root set on unjoined #ops", () => (one("[data-composer-reply-target-text]")?.textContent ?? "").includes("#ops"));
      input.value = "Thread reply unjoined bypass attempt";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await wait("unjoined #ops thread reply refused", () => (one("[data-composer-status]")?.textContent ?? "").includes("Join this channel to post."));
      check(
        f.signalCommands.length === 0 && f.fileCreateCalls === 0 && f.storagePutCalls === 0 && f.fileCommitCalls === 0,
        "HezSec #5: unjoined #ops must block real thread reply submit with 0 posts/uploads",
      );

      // HezSec C4 (confirmed-modern downgrade control): once Step 2b conversations succeeded for this viewer+workspace,
      // even an explicit 400 unsupported_resource on a later refresh must NOT downgrade to legacy or expose the composer!
      f.failConversations = "unsupported_resource";
      await click(`[data-rail-conversation-menu="${f.ids.dmAlexConv}"]:visible`);
      await wait("alex rail menu open for confirmed-modern downgrade control", () => visible(one(".cs-context-menu")));
      await click('.cs-context-menu__item:has-text("Star")');
      await wait("unsupported_resource response observed after modern confirmation", () => f.unsupportedResponseCount >= 1);
      await new Promise((r) => setTimeout(r, 120));
      check(!visible(form), "HezSec C4: confirmed-modern workspace must not downgrade to legacy composer on later unsupported_resource");
      check(visible(one("[data-channel-preview-bar]")), "HezSec C4: unjoined #ops preview bar must stay enforced after unsupported_resource");
      input.value = "Post-downgrade bypass attempt";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 80));
      check(
        f.signalCommands.length === 0 && f.fileCreateCalls === 0 && f.storagePutCalls === 0 && f.fileCommitCalls === 0,
        "HezSec C4: confirmed-modern workspace must block submit after unsupported_resource with 0 posts/uploads",
      );

      document.documentElement.dataset.step3dObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    if (f.capture === "unavailable-404" || f.capture === "unavailable-404-back") {
      await wait("404 unavailable rendered", () => !!one("[data-channel-unavailable]"));
      const text = one("[data-channel-unavailable]")?.textContent ?? "";
      check(text.includes("This conversation isn't available in this workspace."), "must show uniform 404 copy, got: " + text);
      check(!visible(one("[data-composer]")), "404 unavailable must hide composer");
      if (f.capture === "unavailable-404-back") {
        await click("[data-channel-go-general]:visible");
        await wait("returned to #general from 404", () => location.search.includes("c=general") && visible(one("[data-composer]")) && (one("[data-feed-list]")?.textContent ?? "").includes("Public #general status update."));
      }
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
      document.documentElement.dataset.step3dObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    if (f.capture === "group-dm-capture") {
      await wait("group dm history rendered", () => (one("[data-feed-list]")?.textContent ?? "").includes("Group DM message #22"));
      check(visible(one("[data-composer]")), "group DM composer must be visible");
      check(one<HTMLButtonElement>("[data-composer-attach]")?.disabled === true, "group DM attach must stay disabled");
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
      document.documentElement.dataset.step3dObservation = JSON.stringify({ ok: true, capture: f.capture });
      return;
    }

    // Full Step 3D-1 interactive + security witness:
    // 1. Deep-linked ?dm=<groupConv> loads conversation_history, shows Load older, retries after 503 keeping scroll, then Jump to present.
    await wait("group dm history loaded", () => (one("[data-feed-list]")?.textContent ?? "").includes("Group DM message #22"));
    check(!(one("[data-feed-list]")?.textContent ?? "").includes("Public #general status update."), "group DM must not show #general rows");
    check(visible(one("[data-load-older]")), "Load older must appear when has_more is true");

    // Scroll to top of feed so auto-load (or manual Load older) triggers the first older read (which 503s).
    const scroller = one<HTMLElement>(".dashboard__feed-view")!;
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise(r => setTimeout(r, 80));
    if (!visible(one("[data-load-older-error]")) && !one<HTMLButtonElement>("[data-load-older]")?.disabled) {
      await click("[data-load-older]:visible");
    }
    await wait("older transient error shown", () => visible(one("[data-load-older-error]")));
    check((one("[data-feed-list]")?.textContent ?? "").includes("Group DM message #22"), "failed Load older must preserve loaded rows");

    // Retry Load older -> sends paired (before_created_at, before_id), appends older rows, preserves scroll position.
    const heightBeforeRetry = scroller.scrollHeight;
    await click("[data-load-older]:visible");
    await wait("older rows loaded", () => (one("[data-feed-list]")?.textContent ?? "").includes("Older group DM history #1"));
    const olderReq = f.historyRequests.find((r: any) => r.before_created_at && r.before_id);
    check(!!olderReq && olderReq.conversation_id === f.ids.dmGroupConv, "Load older must send paired before cursor");
    check(scroller.scrollHeight > heightBeforeRetry, "older rows must increase scroller height");
    check(scroller.scrollTop > 0, "Load older must preserve scroll position instead of snapping to top");

    // Jump to present brings us back to newest bottom.
    if (visible(one("[data-jump-present-button]"))) {
      await click("[data-jump-present-button]:visible");
      await wait("jumped to present", () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80);
    }

    // 2. Post in group DM via post_signal({ conversation_id }) (no mentions/channel/to).
    const input = one<HTMLTextAreaElement>("[data-composer-input]")!;
    input.value = "Group DM live post";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await click("[data-composer-send]:visible");
    await wait("group DM post landed", () => f.signalCommands.length === 1);
    check(
      f.signalCommands[0].conversation_id === f.ids.dmGroupConv &&
        !("mentions" in f.signalCommands[0]) &&
        !("channel" in f.signalCommands[0]) &&
        !("to" in f.signalCommands[0]),
      "group DM post must use conversation_id only: " + JSON.stringify(f.signalCommands[0]),
    );
    check((one("[data-feed-list]")?.textContent ?? "").includes("Group DM live post"), "posted group DM message must render");

    // 3. Switch to Notes to self and send via post_signal({ conversation_id: notesConv }).
    await openDrawerIfPhone();
    await click(`[data-rail-conversation="${f.ids.notesConv}"]:visible`);
    await wait("notes to self history loaded", () => (one("[data-feed-list]")?.textContent ?? "").includes("Private self note draft."));
    input.value = "Self note check";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await click("[data-composer-send]:visible");
    await wait("notes post landed", () => f.signalCommands.length === 2);
    check(f.signalCommands[1].conversation_id === f.ids.notesConv && !("mentions" in f.signalCommands[1]), "Notes to self must post by conversation_id");

    // 4. Switch to #general -> strict DM exclusion + post_signal({ conversation_id: generalConv, mentions: [] }).
    await openDrawerIfPhone();
    await click('[data-rail-channel="general"]:visible');
    await wait("#general history loaded", () => (one("[data-feed-list]")?.textContent ?? "").includes("Public #general status update."));
    const generalText = one("[data-feed-list]")?.textContent ?? "";
    check(!generalText.includes("Private 1:1 DM from Alex.") && !generalText.includes("Group DM message") && !generalText.includes("Private self note draft."), "#general must exclude all DM and group DM rows");

    // Stage a file in #general, then switch to 1:1 DM -> fail-closed attachment guard refuses upload before any upload starts.
    const dt = new DataTransfer();
    dt.items.add(new File(["secret"], "secret.txt", { type: "text/plain" }));
    const fileInput = one<HTMLInputElement>("[data-composer-file-input]")!;
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await wait("staged file chip", () => !!one("[data-composer-attachments] button"));

    await openDrawerIfPhone();
    await click(`[data-rail-conversation="${f.ids.dmAlexConv}"]:visible`);
    await wait("1:1 DM history loaded", () => (one("[data-feed-list]")?.textContent ?? "").includes("Private 1:1 DM from Alex."));
    if (visible(one("[data-entity-panel-close]"))) {
      await click("[data-entity-panel-close]:visible");
      await wait("entity panel closed", () => !visible(one("[data-entity-panel]")));
    }
    check(one<HTMLButtonElement>("[data-composer-attach]")?.disabled === true, "1:1 DM attach must be disabled");
    input.value = "Blocked attachment DM";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await click("[data-composer-send]:visible");
    await new Promise(r => setTimeout(r, 80));
    check(f.uploadCalls.length === 0, "DM must make 0 upload calls");
    check(f.signalCommands.length === 2, "DM with staged file must not send");
    await click("[data-composer-attachments] button:visible");
    await wait("staged file removed", () => !one("[data-composer-attachments] button"));

    // 5. All messages view excludes DM and group DM rows even when /rest/v1/signals returns them.
    await click(".hm-menu__trigger:visible");
    await wait("more menu open for all messages", () => visible(shown('[data-menu-channel-place=""]')));
    await click('[data-menu-channel-place=""]:visible');
    await wait("All messages loaded", () => !location.search.includes("dm=") && !location.search.includes("c=") && (one("[data-feed-list]")?.textContent ?? "").includes("Public #general status update."));
    const allText = one("[data-feed-list]")?.textContent ?? "";
    check(!allText.includes("Private 1:1 DM from Alex.") && !allText.includes("Group DM message") && !allText.includes("Private self note draft."), "All messages must exclude DM and group DM rows");

    // 6. Group DM leave clears local rows and localStorage draft immediately and returns to #general.
    await openDrawerIfPhone();
    await click(`[data-rail-conversation="${f.ids.dmGroupConv}"]:visible`);
    await wait("back in group dm", () => (one("[data-feed-list]")?.textContent ?? "").includes("Group DM message #22"));
    input.value = "Secret unsent group draft";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
    const draftKey = `commonswarm:composer-draft:${f.owner}:${f.workspace}:conv:${f.ids.dmGroupConv}`;
    await wait("group draft persisted", () => !!localStorage.getItem(draftKey));

    await openDrawerIfPhone();
    await click(`[data-rail-conversation-menu="${f.ids.dmGroupConv}"]:visible`);
    await wait("group row menu open", () => visible(one(".cs-context-menu")));
    await click('.cs-context-menu__item:has-text("Leave group")');
    await wait("group leave confirm open", () => one<HTMLDialogElement>("[data-group-leave-dialog]")?.open === true);
    await click("[data-group-leave-confirm]:visible");
    await wait("left group dm and returned to #general", () =>
      one<HTMLDialogElement>("[data-group-leave-dialog]")?.open === false &&
      !one(`[data-rail-conversation="${f.ids.dmGroupConv}"]`) &&
      location.search.includes("c=general"),
    );
    check(localStorage.getItem(draftKey) === null, "leaving group DM must wipe its localStorage draft immediately");
    check(!(one("[data-feed-list]")?.textContent ?? "").includes("Group DM message #22"), "leaving group DM must clear group rows immediately");
    check(input.value === "", "leaving group DM must clear unsent textarea draft immediately");

    document.documentElement.dataset.step3dObservation = JSON.stringify({
      ok: true,
      mode: "flow",
      historyReads: f.historyRequests.length,
      signals: f.signalCommands.length,
      uploads: f.uploadCalls.length,
    });
  } catch (error) {
    document.documentElement.dataset.step3dObservation = JSON.stringify({
      error: String(error),
      stage,
      errors: f.errors,
      unexpected: f.unexpected,
      signals: f.signalCommands,
      uploads: f.uploadCalls,
    });
  }
}

test("Step 3D-1 signed-in dashboard wires conversation_history cursors, post_signal({ conversation_id }), DM exclusion, 404 non-oracle, and leave clear", { timeout: 140_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const convFixture = await compileFixtureFunction(new URL(import.meta.url), "installConversations3DFixture");
  const observe = await compileFixtureFunction(new URL(import.meta.url), "observeConversations3D");
  const html = "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" + styles.join("\n") +
    "</style><script>" + install + convFixture + "</script></head><body>" + markup + "<script type='module'>" + observe + "</script></body></html>";
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
    const evidence = join(process.cwd(), "../site-observer-evidence/conversations-step3d-history");
    await mkdir(evidence, { recursive: true });
    const ws = "11111111-1111-4111-8111-111111111111";
    const groupConv = "bbbb2222-2222-4222-8222-222222222222";
    const unknownConv = "deadbeef-dead-4eef-8eef-deadbeef0000";
    const cases: { name: string; width: number; height: number; query: string; screenshot?: boolean }[] = [
      { name: "flow-1024-light", width: 1024, height: 1366, query: `w=${ws}&dm=${groupConv}&theme=light&capture=flow&fail_older=1` },
      { name: "designer-retry-360", width: 360, height: 740, query: `w=${ws}&dm=${groupConv}&theme=light&capture=designer-retry&fail_older_sticky=1` },
      { name: "designer-retry-1024", width: 1024, height: 1366, query: `w=${ws}&dm=${groupConv}&theme=light&capture=designer-retry&fail_older_sticky=1` },
      { name: "designer-retry-tab-away-1024", width: 1024, height: 1366, query: `w=${ws}&dm=${groupConv}&theme=light&capture=designer-retry-tab-away&fail_older_sticky=1` },
      { name: "hezsec-drafts-and-audience-1024", width: 1024, height: 1366, query: `w=${ws}&dm=${groupConv}&theme=light&capture=hezsec-drafts-and-audience` },
      { name: "hezsec-held-omission-and-fences-1024", width: 1024, height: 1366, query: `w=${ws}&dm=${groupConv}&theme=light&capture=hezsec-held-omission-and-fences&hold_first_history=${groupConv}` },
      { name: "hezsec-members-preflight-1024", width: 1024, height: 1366, query: `w=${ws}&c=66666666-6666-4666-8666-666666666666&theme=light&capture=hezsec-members-preflight` },
      { name: "hezsec-503-and-unjoined-1024", width: 1024, height: 1366, query: `w=${ws}&c=general&theme=light&capture=hezsec-503-and-unjoined&fail_conversations=invalid_request&unjoined_ops=1` },
      { name: "404-back-to-general-1024", width: 1024, height: 1366, query: `w=${ws}&dm=${unknownConv}&theme=light&capture=unavailable-404-back` },
      { name: "360x740-light-group-dm", width: 360, height: 740, query: `w=${ws}&dm=${groupConv}&theme=light&capture=group-dm-capture`, screenshot: true },
      { name: "360x740-dark-group-dm", width: 360, height: 740, query: `w=${ws}&dm=${groupConv}&theme=dark&capture=group-dm-capture`, screenshot: true },
      { name: "390x844-light-unavailable-404", width: 390, height: 844, query: `w=${ws}&dm=${unknownConv}&theme=light&capture=unavailable-404`, screenshot: true },
      { name: "390x844-dark-unavailable-404", width: 390, height: 844, query: `w=${ws}&dm=${unknownConv}&theme=dark&capture=unavailable-404`, screenshot: true },
      { name: "1024x1366-light-group-dm", width: 1024, height: 1366, query: `w=${ws}&dm=${groupConv}&theme=light&capture=group-dm-capture`, screenshot: true },
      { name: "1024x1366-dark-group-dm", width: 1024, height: 1366, query: `w=${ws}&dm=${groupConv}&theme=dark&capture=group-dm-capture`, screenshot: true },
    ];
    const outcomes: Record<string, any> = {};
    for (const item of cases) {
      const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, hasTouch: item.width < 1024 });
      activePage = await context.newPage();
      try {
        await activePage.goto(`http://127.0.0.1:${address.port}/app?${item.query}`);
        await activePage.waitForFunction(() => !!document.documentElement.dataset.step3dObservation, null, { timeout: 25_000 });
        outcomes[item.name] = await activePage.evaluate(() => JSON.parse(document.documentElement.dataset.step3dObservation!));
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
