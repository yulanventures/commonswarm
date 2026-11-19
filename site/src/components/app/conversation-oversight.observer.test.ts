/** Signed-in mounted Step 3D-3 observer: read-only agent oversight on `?agent=<id>`, isolation, paging, 404, phone Escape, and axe-core AA. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";
import { chromium, type Page } from "playwright-core";
import { compileFixtureFunction, renderAstroFixture } from "../../../tests/astro-fixture";

function installOversightFixture() {
  const f = (window as any).existingFixture;
  const params = new URL(location.href).searchParams;
  f.oversightMode = params.get("oversight_mode") ?? "ready";
  f.capture = params.get("capture") ?? "flow";
  f.oversightReads = [] as any[];
  f.oversightHistoryReads = [] as any[];
  f.commandsAfterBoot = [] as any[];

  const peerAlex = "dddd4444-4444-4444-8444-444444444444";
  const ownedLead = "eeee5555-5555-4555-8555-555555555555";
  const ownedScout = "ffff6666-6666-4666-8666-666666666666";
  const unownedBot = "aaaa7777-7777-4777-8777-777777777777";
  const personalGeneral = "99990000-0000-4000-8000-000000000001";
  const personalDmAlex = "99990000-0000-4000-8000-000000000010";
  const oversightDmAlex = "bbbb1111-1111-4111-8111-111111111111";
  const oversightGroup = "bbbb2222-2222-4222-8222-222222222222";
  const scoutDm = "bbbb3333-3333-4333-8333-333333333333";

  f.ids = {
    peerAlex,
    ownedLead,
    ownedScout,
    unownedBot,
    personalDmAlex,
    oversightDmAlex,
    oversightGroup,
    scoutDm,
  };

  const recent = new Date(Date.now() - 60_000).toISOString();
  const makeAgentStatus = () => ({
    work: "idle",
    facts: {
      transport: "local",
      turn_only: false,
      connection: "live",
      last_activity_at: recent,
      messages_waiting_since: null,
      doing: null,
      working_on: null,
    },
  });

  const leadOversightList = [
    {
      conversation_id: oversightDmAlex,
      kind: "dm",
      channel_id: null,
      slug: null,
      description: null,
      archived_at: null,
      joined: true,
      generation: 1,
      lead_mode: null,
      lead_agent_principal_id: null,
      members: [
        { kind: "agent", id: ownedLead, name: "Lead", left_at: null },
        { kind: "user", id: peerAlex, name: "Alex", left_at: null },
      ],
      read_only: true,
      last_message_at: "2026-11-19T15:20:00Z",
      last_message_id: "55555555-5555-4555-8555-555555555502",
    },
    {
      conversation_id: oversightGroup,
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
        { kind: "agent", id: ownedLead, name: "Lead", left_at: null },
        { kind: "user", id: peerAlex, name: "Alex", left_at: null },
        { kind: "agent", id: ownedScout, name: "Scout", left_at: null },
      ],
      read_only: true,
      last_message_at: "2026-11-19T14:40:00Z",
      last_message_id: "55555555-5555-4555-8555-555555555510",
    },
  ];

  const scoutOversightList = [
    {
      conversation_id: scoutDm,
      kind: "dm",
      channel_id: null,
      slug: null,
      description: null,
      archived_at: null,
      joined: true,
      generation: 1,
      lead_mode: null,
      lead_agent_principal_id: null,
      members: [
        { kind: "agent", id: ownedScout, name: "Scout", left_at: null },
        { kind: "user", id: peerAlex, name: "Alex", left_at: null },
      ],
      read_only: true,
      last_message_at: "2026-11-19T15:10:00Z",
      last_message_id: "66666666-6666-4666-8666-666666666601",
    },
  ];

  const msgRow = (id: string, from: string, fromKind: "user" | "agent", body: string, createdAt: string) => ({
    id,
    from,
    from_kind: fromKind,
    kind: "message",
    body,
    created_at: createdAt,
    to: [],
    attachments: [],
  });

  const previous = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.test.invalid") return previous(input, init);

    if (url.pathname === "/rest/v1/member_profiles") {
      return Response.json([
        { user_id: f.owner, display_name: "Synthetic owner", role: "owner" },
        { user_id: peerAlex, display_name: "Alex", role: "member" },
      ]);
    }
    if (url.pathname === "/rest/v1/agent_principals") {
      if (url.searchParams.get("revoked_at") !== "is.null") return Response.json([]);
      if (url.searchParams.get("workspace_id") !== `eq.${f.workspace}`) return Response.json([]);
      return Response.json([
        { principal_id: ownedLead, name: "Lead", model: "Claude", transport: "local", turn_only: false, owner_user_id: f.owner, revoked_at: null, workspace_id: f.workspace, created_at: "2026-11-01T00:00:00Z" },
        { principal_id: ownedScout, name: "Scout", model: "Claude", transport: "local", turn_only: false, owner_user_id: f.owner, revoked_at: null, workspace_id: f.workspace, created_at: "2026-11-01T00:00:00Z" },
        { principal_id: unownedBot, name: "Alex Bot", model: "Claude", transport: "local", turn_only: false, owner_user_id: peerAlex, revoked_at: null, workspace_id: f.workspace, created_at: "2026-11-01T00:00:00Z" },
      ]);
    }
    if (url.pathname === "/rest/v1/rpc/home_overview") {
      return Response.json({
        viewer_user_id: f.owner,
        generated_at: recent,
        workspaces: [f.workspace, f.other].map((id: string) => ({
          workspace_id: id,
          name: id === f.workspace ? "Home" : "Studio",
          role: "owner",
          last_seen_at: recent,
          new_messages: 0,
          content: { open_todos: 0, lists: 0, docs: 0, files: 0 },
          people: id === f.workspace
            ? [
                {
                  user_id: f.owner,
                  display_name: "Synthetic owner",
                  role: "owner",
                  is_viewer: true,
                  agents: [
                    { principal_id: ownedLead, name: "Lead", status: makeAgentStatus(), queue: { working: 0, up_next: 0, not_yet: 0, requests: 0 } },
                    { principal_id: ownedScout, name: "Scout", status: makeAgentStatus(), queue: { working: 0, up_next: 0, not_yet: 0, requests: 0 } },
                  ],
                },
                {
                  user_id: peerAlex,
                  display_name: "Alex",
                  role: "member",
                  is_viewer: false,
                  agents: [
                    { principal_id: unownedBot, name: "Alex Bot", status: makeAgentStatus(), queue: { working: 0, up_next: 0, not_yet: 0, requests: 0 } },
                  ],
                },
              ]
            : [{ user_id: f.owner, display_name: "Synthetic owner", role: "owner", is_viewer: true, agents: [] }],
          needs_you: { asks: [], assigned: [], waiting: [] },
        })),
      });
    }
    if (url.pathname === "/rest/v1/rpc/agent_queue") {
      const body = await request.clone().json().catch(() => ({}));
      const pid = String(body?.p_principal_id ?? ownedLead);
      return Response.json({
        workspace_id: f.workspace,
        principal_id: pid,
        owner_user_id: pid === unownedBot ? peerAlex : f.owner,
        accepts_from: "anyone",
        content_access: "none",
        status: makeAgentStatus(),
        working: [],
        up_next: [],
        not_yet: [],
        requests: [],
        read_at: recent,
        next_offset: { working: null, up_next: null, not_yet: null, requests: null },
      });
    }
    if (url.pathname === "/functions/v1/read" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      if (body?.resource === "conversations") {
        return Response.json({
          conversations: [
            {
              conversation_id: personalGeneral, kind: "general", channel_id: null, slug: "general", description: null,
              archived_at: null, joined: true, generation: 0, lead_mode: "workspace", lead_agent_principal_id: null,
              members: [], notify_level: "everything", starred: false, star_rank: null,
              read_through_at: null, read_through_id: null, unread_count: 0, mention_count: 0,
              last_message_at: "2026-11-19T14:00:00Z", last_message_id: null,
            },
            {
              conversation_id: personalDmAlex, kind: "dm", channel_id: null, slug: null, description: null,
              archived_at: null, joined: true, generation: 1, lead_mode: null, lead_agent_principal_id: null,
              members: [
                { kind: "user", id: f.owner, name: "Synthetic owner", left_at: null },
                { kind: "user", id: peerAlex, name: "Alex", left_at: null },
              ],
              notify_level: "everything", starred: false, star_rank: null,
              read_through_at: null, read_through_id: null, unread_count: 3, mention_count: 1,
              last_message_at: "2026-11-19T15:00:00Z", last_message_id: null,
            },
          ],
        });
      }
      if (body?.resource === "conversation_oversight") {
        f.oversightReads.push(body);
        if (f.oversightMode === "404") {
          return Response.json(
            { error: "conversation_not_found", message: "This conversation isn't available in this workspace." },
            { status: 404 },
          );
        }
        if (f.oversightMode === "unsupported") {
          return Response.json({ error: "unsupported_resource", message: "Not deployed yet." }, { status: 400 });
        }
        if (f.oversightMode === "slow_switch" && String(body.agent_principal_id).toLowerCase() === ownedLead) {
          await new Promise<void>(resolve => setTimeout(resolve, 260));
        }
        const pid = String(body.agent_principal_id ?? "").toLowerCase();
        if (pid === ownedLead) return Response.json({ conversations: leadOversightList });
        if (pid === ownedScout) return Response.json({ conversations: scoutOversightList });
        return Response.json(
          { error: "conversation_not_found", message: "This conversation isn't available in this workspace." },
          { status: 404 },
        );
      }
      if (body?.resource === "conversation_oversight_history") {
        f.oversightHistoryReads.push(body);
        if (f.oversightMode === "history_404") {
          return Response.json(
            { error: "conversation_not_found", message: "This conversation isn't available in this workspace." },
            { status: 404 },
          );
        }
        const cid = String(body.conversation_id ?? "");
        const pid = String(body.agent_principal_id ?? "").toLowerCase();
        if (cid === oversightDmAlex && pid === ownedLead) {
          if (body.before_id === "55555555-5555-4555-8555-555555555501") {
            return Response.json({
              conversation: leadOversightList[0],
              messages: [
                msgRow("55555555-5555-4555-8555-555555555498", peerAlex, "user", "Can you pull the Q4 deploy notes before standup?", "2026-11-19T14:55:00Z"),
                msgRow("55555555-5555-4555-8555-555555555499", ownedLead, "agent", "On it, checking the staging log and release checklist now.", "2026-11-19T14:58:00Z"),
              ],
              has_more: false,
              next_before: null,
              next_after: null,
            });
          }
          return Response.json({
            conversation: leadOversightList[0],
            messages: [
              msgRow("55555555-5555-4555-8555-555555555501", peerAlex, "user", "Did the migration verify cleanly on staging?", "2026-11-19T15:18:00Z"),
              msgRow("55555555-5555-4555-8555-555555555502", ownedLead, "agent", "All three checks passed. Ready for owner review whenever you are.", "2026-11-19T15:20:00Z"),
            ],
            has_more: true,
            next_before: {
              created_at: "2026-11-19T15:18:00Z",
              id: "55555555-5555-4555-8555-555555555501",
            },
            next_after: null,
          });
        }
        if (cid === oversightGroup && pid === ownedLead) {
          return Response.json({
            conversation: leadOversightList[1],
            messages: [
              msgRow("55555555-5555-4555-8555-555555555510", ownedScout, "agent", "Summary posted to the group thread; no blockers left.", "2026-11-19T14:40:00Z"),
            ],
            has_more: false,
            next_before: null,
            next_after: null,
          });
        }
        if (cid === scoutDm && pid === ownedScout) {
          return Response.json({
            conversation: scoutOversightList[0],
            messages: [
              msgRow("66666666-6666-4666-8666-666666666601", ownedScout, "agent", "Scout private check-in completed.", "2026-11-19T15:10:00Z"),
            ],
            has_more: false,
            next_before: null,
            next_after: null,
          });
        }
        return Response.json(
          { error: "conversation_not_found", message: "This conversation isn't available in this workspace." },
          { status: 404 },
        );
      }
    }
    if (url.pathname === "/functions/v1/command" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      const kind = body?.command?.kind;
      if (kind && !["household_access", "household_tool", "household_connections"].includes(kind)) {
        f.commandsAfterBoot.push(body.command);
      }
      if (kind === "signals_seen") return Response.json({ status: "accepted" });
    }
    return previous(input, init);
  };
}

async function observeOversight() {
  const f = (window as any).existingFixture;
  const one = <T extends Element>(selector: string) => document.querySelector<T>(selector);
  const all = <T extends Element>(selector: string) => [...document.querySelectorAll<T>(selector)];
  const visible = (el: Element | null): el is HTMLElement => !!el && !el.closest("[hidden]") && el.getClientRects().length > 0;
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
  const target44 = (el: HTMLElement | null, label: string) => {
    check(el && visible(el), `${label} not visible`);
    const r = el!.getBoundingClientRect();
    check(r.width >= 44 && r.height >= 44, `${label} target too small: ${r.width}x${r.height}`);
  };
  const assertReadOnlyAndIsolated = (panel: HTMLElement | null) => {
    check(!!panel, "oversight panel must be mounted");
    check(panel!.querySelectorAll("textarea, input, form, [contenteditable]").length === 0, "oversight panel must not render composer or form inputs");
    const badCommands = f.commandsAfterBoot.filter((c: any) => String(c.kind ?? "").startsWith("conversation_") || c.kind === "signal");
    check(badCommands.length === 0, "oversight must not trigger write or mark-read commands: " + JSON.stringify(badCommands));
    const personalUnread = one<HTMLElement>(`[data-home-dms] [data-home-conversation="${f.ids.personalDmAlex}"]`);
    if (personalUnread) {
      check((personalUnread.textContent ?? "").includes("1") || (personalUnread.textContent ?? "").includes("3"), "personal DM unread count must remain isolated from oversight");
    }
  };

  try {
    const params = new URL(location.href).searchParams;
    const agentId = (params.get("agent") ?? "").toLowerCase();
    const isPhone = innerWidth <= 832;

    if (f.oversightMode === "unowned") {
      await wait("unowned agent page", () => visible(one<HTMLElement>(`.hm-agent[data-hm-agent="${f.ids.unownedBot}"]`)));
      await new Promise(resolve => setTimeout(resolve, 120));
      check(f.oversightReads.length === 0, "unowned agent must send zero conversation_oversight reads");
      check(f.oversightHistoryReads.length === 0, "unowned agent must send zero conversation_oversight_history reads");
      check(!one("[data-oversight-panel]"), "unowned agent must not render oversight panel");
      document.documentElement.dataset.oversightObservation = JSON.stringify({ ok: true, mode: "unowned" });
      return;
    }

    if (f.oversightMode === "unsupported") {
      await wait("owned agent page", () => visible(one<HTMLElement>(`.hm-agent[data-hm-agent="${f.ids.ownedLead}"]`)));
      await wait("unsupported oversight settled", () => f.oversightReads.length >= 1);
      await new Promise(resolve => setTimeout(resolve, 80));
      const slot = one<HTMLElement>(`[data-oversight-slot="${f.ids.ownedLead}"]`);
      check(!slot || slot.hidden, "pre-Step-2b unsupported 400 should hide oversight slot cleanly");
      document.documentElement.dataset.oversightObservation = JSON.stringify({ ok: true, mode: "unsupported" });
      return;
    }

    if (f.oversightMode === "404") {
      await wait("404 oversight panel", () => visible(one<HTMLElement>("[data-oversight-panel]")) && (one("[data-oversight-panel]")?.textContent ?? "").includes("isn't available in this workspace"));
      const panel = one<HTMLElement>("[data-oversight-panel]")!;
      check((panel.textContent ?? "").includes("Read-only"), "404 panel must keep Read-only badge");
      assertReadOnlyAndIsolated(panel);
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "404 page overflow");
      document.documentElement.dataset.oversightObservation = JSON.stringify({ ok: true, mode: "404" });
      return;
    }

    if (f.oversightMode === "slow_switch") {
      await wait("Lead oversight request started", () => f.oversightReads.some((r: any) => String(r.agent_principal_id).toLowerCase() === f.ids.ownedLead));
      // Immediately switch to Scout before Lead's delayed response arrives:
      const scoutHref = `/app?w=${f.workspace}&agent=${f.ids.ownedScout}`;
      const scoutLink = one<HTMLAnchorElement>(`a[href*="${f.ids.ownedScout}"]`);
      if (scoutLink && visible(scoutLink)) {
        await click(`a[href*="${f.ids.ownedScout}"]`);
      } else {
        history.pushState(null, "", scoutHref);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      await wait("Scout oversight loaded", () => (one("[data-oversight-panel]")?.textContent ?? "").includes("Scout private check-in completed."));
      // Wait past Lead's 260ms delay and confirm Lead's delayed payload never overwrote Scout:
      await new Promise(resolve => setTimeout(resolve, 350));
      const scoutText = one("[data-oversight-panel]")?.textContent ?? "";
      check(scoutText.includes("Scout’s conversations"), "panel heading must stay pinned to Scout");
      check(scoutText.includes("Scout private check-in completed."), "Scout transcript must remain intact");
      check(!scoutText.includes("Did the migration verify cleanly"), "delayed Lead response must not leak into Scout panel");

      // Now navigate away to #general and verify oversight DOM clears immediately:
      const generalLink = one<HTMLAnchorElement>('a[href*="c=general"]');
      if (generalLink && visible(generalLink)) {
        await click('a[href*="c=general"]');
      } else {
        history.pushState(null, "", `/app?w=${f.workspace}&c=general`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      await wait("left agent view", () => !visible(one("[data-oversight-panel]")));
      const leftover = all<HTMLElement>("[data-oversight-slot]").some(el => (el.textContent ?? "").trim().length > 0);
      check(!leftover, "leaving ?agent=<id> must clear oversight DOM text immediately");
      document.documentElement.dataset.oversightObservation = JSON.stringify({ ok: true, mode: "slow_switch" });
      return;
    }

    // Standard ready flow (desktop and phone, plus capture modes):
    await wait("oversight list ready", () => visible(one<HTMLElement>(`[data-oversight-conv="${f.ids.oversightDmAlex}"]`)));
    const currentPanel = () => one<HTMLElement>("[data-oversight-panel]")!;
    check((currentPanel().textContent ?? "").includes("Lead’s conversations"), "oversight heading must name the agent");
    check(!(currentPanel().textContent ?? "").includes("Your Lead’s conversations"), "oversight heading should use agent name cleanly");
    check((currentPanel().textContent ?? "").includes("Read-only"), "oversight panel must show Read-only badge");
    check(currentPanel().querySelectorAll("[data-oversight-badge]").length === 1, "oversight panel should show one Read-only badge");
    target44(one<HTMLElement>(`[data-oversight-conv="${f.ids.oversightDmAlex}"]`), "Alex DM row");
    target44(one<HTMLElement>(`[data-oversight-conv="${f.ids.oversightGroup}"]`), "Group DM row");

    if (f.capture === "phone-list") {
      check(isPhone, "phone-list capture requires phone viewport");
      check(currentPanel().dataset.oversightPhoneDetail === "false", "phone should open on conversation list");
      assertReadOnlyAndIsolated(currentPanel());
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "phone-list overflow");
      document.documentElement.dataset.oversightObservation = JSON.stringify({ ok: true, mode: "phone-list" });
      return;
    }

    if (isPhone) {
      check(currentPanel().dataset.oversightPhoneDetail === "false", "phone starts on conversation list");
      await click(`[data-oversight-conv="${f.ids.oversightDmAlex}"]`);
      await wait("phone detail opened", () => currentPanel().dataset.oversightPhoneDetail === "true" && (currentPanel().textContent ?? "").includes("All three checks passed."));
      check(document.activeElement?.hasAttribute("data-oversight-detail-title"), "opening phone detail should focus detail heading");
      target44(one<HTMLElement>("[data-oversight-back]"), "phone Back button");
    } else {
      await wait("desktop auto-selected transcript", () => (currentPanel().textContent ?? "").includes("All three checks passed."));
    }
    const senders = all<HTMLElement>(".cs-oversight__message-sender").map(el => el.textContent ?? "");
    check(senders.includes("Alex") && senders.includes("Lead"), "message senders must resolve to real names: " + JSON.stringify(senders));

    if (f.capture === "open-detail") {
      assertReadOnlyAndIsolated(currentPanel());
      await document.fonts.ready;
      check(document.documentElement.scrollWidth <= innerWidth, "open-detail overflow");
      document.documentElement.dataset.oversightObservation = JSON.stringify({ ok: true, mode: "open-detail" });
      return;
    }

    // Load older messages with paired (before_created_at, before_id) cursor:
    const loadOlder = one<HTMLButtonElement>("[data-oversight-load-older]");
    target44(loadOlder, "Load older messages button");
    await click("[data-oversight-load-older]");
    await wait("older messages prepended", () => (currentPanel().textContent ?? "").includes("Can you pull the Q4 deploy notes"));
    const cursorCall = f.oversightHistoryReads.find((r: any) => r.before_id === "55555555-5555-4555-8555-555555555501");
    check(!!cursorCall && cursorCall.before_created_at === "2026-11-19T15:18:00Z", "Load older must send paired (before_created_at, before_id) cursor");
    check(!one("[data-oversight-load-older]"), "Load older should hide once has_more is false");
    const bodies = all<HTMLElement>("[data-oversight-message] .cs-oversight__message-body").map(el => el.textContent ?? "");
    check(bodies.length === 4 && bodies[0]!.includes("Q4 deploy notes") && bodies[3]!.includes("All three checks passed."), "messages must be deduplicated in chronological order: " + JSON.stringify(bodies));

    if (isPhone) {
      // Escape returns to phone list and restores focus to originating row:
      await key("Escape");
      await wait("Escape returned to phone list", () => currentPanel().dataset.oversightPhoneDetail === "false");
      check(
        document.activeElement?.getAttribute("data-oversight-conv") === f.ids.oversightDmAlex,
        "Escape from phone detail must restore focus to originating conversation row",
      );
      // Open second conversation:
      await click(`[data-oversight-conv="${f.ids.oversightGroup}"]`);
      await wait("group oversight loaded", () => (currentPanel().textContent ?? "").includes("Summary posted to the group thread"));
    } else {
      await click(`[data-oversight-conv="${f.ids.oversightGroup}"]`);
      await wait("group oversight loaded", () => (currentPanel().textContent ?? "").includes("Summary posted to the group thread"));
    }

    assertReadOnlyAndIsolated(currentPanel());
    await document.fonts.ready;
    check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
    check(f.errors.length === 0, "app errors: " + f.errors.join(","));
    check(f.unexpected.length === 0, "unexpected HTTP: " + f.unexpected.join(","));
    document.documentElement.dataset.oversightObservation = JSON.stringify({
      ok: true,
      mode: "flow",
      agentId,
      reads: f.oversightReads.length,
      historyReads: f.oversightHistoryReads.length,
    });
  } catch (error) {
    document.documentElement.dataset.oversightObservation = JSON.stringify({
      error: String(error),
      stage,
      active: document.activeElement?.outerHTML.slice(0, 240),
      errors: f.errors,
      unexpected: f.unexpected,
      reads: f.oversightReads,
      historyReads: f.oversightHistoryReads,
    });
  }
}

test("Step 3D-3 signed-in read-only agent oversight UI enforces isolation, cursor paging, 404 non-oracle, phone Escape, and WCAG 2.2 AA", { timeout: 300_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const oversightFixture = await compileFixtureFunction(new URL(import.meta.url), "installOversightFixture");
  const observe = await compileFixtureFunction(new URL(import.meta.url), "observeOversight");
  const axeSource = await readFile(fileURLToPath(new URL("../../../node_modules/axe-core/axe.min.js", import.meta.url)), "utf8");
  const html = "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" + styles.join("\n") +
    "</style><script>" + install + oversightFixture + "</script></head><body>" + markup + "<script type='module'>" + observe + "</script></body></html>";
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
    const evidence = process.env.OVERSIGHT_CAPTURE_DIR || join(process.cwd(), "../site-observer-evidence/conversation-oversight");
    await mkdir(evidence, { recursive: true });
    const outcomes: Record<string, any> = {};
    const ws = "11111111-1111-4111-8111-111111111111";
    const ownedLead = "eeee5555-5555-4555-8555-555555555555";
    const unownedBot = "aaaa7777-7777-4777-8777-777777777777";
    const cases: { name: string; width: number; height: number; query: string; screenshot?: boolean; axe?: boolean; scrollOversight?: boolean }[] = [
      { name: "flow-desktop-1440-light", width: 1440, height: 900, query: `w=${ws}&agent=${ownedLead}&theme=light&capture=flow`, axe: true },
      { name: "flow-desktop-1024-dark", width: 1024, height: 768, query: `w=${ws}&agent=${ownedLead}&theme=dark&capture=flow`, axe: true },
      { name: "flow-phone-360-light", width: 360, height: 740, query: `w=${ws}&agent=${ownedLead}&theme=light&capture=flow`, axe: true },
      { name: "unowned-agent-1024", width: 1024, height: 768, query: `w=${ws}&agent=${unownedBot}&theme=light&oversight_mode=unowned` },
      { name: "unsupported-pre2b-1024", width: 1024, height: 768, query: `w=${ws}&agent=${ownedLead}&theme=light&oversight_mode=unsupported` },
      { name: "slow-switch-isolation-1024", width: 1024, height: 768, query: `w=${ws}&agent=${ownedLead}&theme=light&oversight_mode=slow_switch` },
      // Visual captures + axe-core checks for Designer at 360, 390, 1024, 1440 in light & dark:
      ...(["light", "dark"] as const).flatMap(theme => [
        { name: `1440x900-${theme}-oversight`, width: 1440, height: 900, query: `w=${ws}&agent=${ownedLead}&theme=${theme}&capture=open-detail`, screenshot: true, axe: true, scrollOversight: true },
        { name: `1024x768-${theme}-oversight`, width: 1024, height: 768, query: `w=${ws}&agent=${ownedLead}&theme=${theme}&capture=open-detail`, screenshot: true, axe: true, scrollOversight: true },
        { name: `390x844-${theme}-oversight-list`, width: 390, height: 844, query: `w=${ws}&agent=${ownedLead}&theme=${theme}&capture=phone-list`, screenshot: true, axe: true, scrollOversight: true },
        { name: `390x844-${theme}-oversight-detail`, width: 390, height: 844, query: `w=${ws}&agent=${ownedLead}&theme=${theme}&capture=open-detail`, screenshot: true, axe: true, scrollOversight: true },
        { name: `360x740-${theme}-oversight-list`, width: 360, height: 740, query: `w=${ws}&agent=${ownedLead}&theme=${theme}&capture=phone-list`, screenshot: true, axe: true, scrollOversight: true },
        { name: `360x740-${theme}-oversight-detail`, width: 360, height: 740, query: `w=${ws}&agent=${ownedLead}&theme=${theme}&capture=open-detail`, screenshot: true, axe: true, scrollOversight: true },
        { name: `1024x768-${theme}-oversight-404`, width: 1024, height: 768, query: `w=${ws}&agent=${ownedLead}&theme=${theme}&oversight_mode=404`, screenshot: true, axe: true, scrollOversight: true },
        { name: `360x740-${theme}-oversight-404`, width: 360, height: 740, query: `w=${ws}&agent=${ownedLead}&theme=${theme}&oversight_mode=404`, screenshot: true, axe: true, scrollOversight: true },
      ]),
    ];

    for (const item of cases) {
      const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, hasTouch: item.width < 1024 });
      activePage = await context.newPage();
      try {
        await activePage.goto(`http://127.0.0.1:${address.port}/app?${item.query}`);
        await activePage.waitForFunction(() => !!document.documentElement.dataset.oversightObservation, null, { timeout: 30_000 });
        const result = await activePage.evaluate(() => JSON.parse(document.documentElement.dataset.oversightObservation!));
        if (result.ok && item.scrollOversight) {
          await activePage.locator("[data-oversight-panel]").first().scrollIntoViewIfNeeded().catch(() => {});
        }
        if (result.ok && item.axe) {
          await activePage.addScriptTag({ content: axeSource });
          const axeRes = await activePage.evaluate(async () => {
            const panel = document.querySelector("[data-oversight-panel]");
            if (!panel) return { violations: [] };
            return (window as any).axe.run(panel, {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
            });
          });
          result.axeViolations = axeRes.violations.map((v: any) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            nodes: v.nodes.map((n: any) => n.html).slice(0, 3),
          }));
          if (result.axeViolations.length > 0) {
            result.ok = false;
            result.error = `axe violations: ${JSON.stringify(result.axeViolations)}`;
          }
        }
        outcomes[item.name] = result;
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
