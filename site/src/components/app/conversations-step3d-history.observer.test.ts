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
  f.signalCommands = [] as any[];
  f.uploadCalls = [] as string[];
  f.convCommands = [] as any[];
  f.failNextOlder = params.get("fail_older") === "1";
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
      description: "Release coordination.", archived_at: null, joined: true, generation: 0,
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
    if (url.pathname.startsWith("/storage/v1/")) {
      f.uploadCalls.push(url.pathname);
      return Response.json({ Key: "synthetic" });
    }
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
      ]);
    }
    if (url.pathname === "/rest/v1/signals") {
      // Simulate All messages returning mixed public + DM + group DM rows so strict client DM exclusion is proven!
      return Response.json([
        ...historyByConv[generalConv].newest,
        ...historyByConv[opsConv].newest,
        ...historyByConv[dmAlexConv].newest,
        groupNewest[0],
        ...historyByConv[notesConv].newest,
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
        const list = f.revokeGroup
          ? f.conversations.filter((c: any) => c.conversation_id !== dmGroupConv)
          : f.conversations;
        return Response.json({ conversations: list });
      }
      if (body?.resource === "conversation_history") {
        f.historyRequests.push(body);
        const convId = String(body.conversation_id ?? "");
        const conv = f.conversations.find((c: any) => c.conversation_id === convId);
        if (!conv || (f.revokeGroup && convId === dmGroupConv)) {
          return Response.json(
            { error: "conversation_not_found", message: "This conversation isn't available in this workspace." },
            { status: 404 },
          );
        }
        const store = historyByConv[convId] ?? { newest: [], older: [] };
        if (body.before_created_at && body.before_id) {
          if (f.failNextOlder) {
            f.failNextOlder = false;
            return Response.json({ error: "service_unavailable", message: "History read failed." }, { status: 503 });
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
      if (command?.kind === "file_create" || command?.kind === "file_upload_url") {
        f.uploadCalls.push(command.kind);
        return Response.json({ status: "accepted", file_id: "55555555-5555-4555-8555-555555555555", version_n: 1 });
      }
      if (command?.kind === "post_signal") {
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
  const openDrawerIfPhone = async () => {
    if (!visible(shown("[data-home-dms]"))) {
      await click('button[aria-label="Open navigation"]:visible');
      await wait("phone drawer open", () => visible(shown("[data-home-dms]")));
    }
  };
  try {
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

    // Scroll to top of feed so Load older is in view and scroll preservation can be verified.
    const scroller = one<HTMLElement>(".dashboard__feed-view")!;
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll"));
    await click("[data-load-older]:visible");
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
