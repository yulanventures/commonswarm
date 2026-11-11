/** Real site DOM/transport proof for mounted seat-admin panels and dialogs with synthetic HTTP. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build, type Plugin } from "esbuild";
import ts from "typescript";
import { transform } from "@astrojs/compiler-rs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

function installSeatAdminFixture() {
  const w = window as any;
  const initialPathname = location.pathname;
  const initialSearch = location.search;
  const continuationRaw = sessionStorage.getItem("__seatAdminTestContinuation");
  if (continuationRaw) {
    sessionStorage.removeItem("__seatAdminTestContinuation");
  }
  const continuation = continuationRaw ? JSON.parse(continuationRaw) : null;
  const scenario = continuation
    ? String(continuation.scenario)
    : new URL(location.href).searchParams.get("case") || "flag-off";

  const realDateNow = Date.now.bind(Date);
  let clockOffsetMs = continuation ? Number(continuation.clockOffsetMs || 0) : 0;
  Date.now = () => realDateNow() + clockOffsetMs;

  const principal = "22222222-2222-4222-8222-222222222222";
  const owner = "33333333-3333-4333-8333-333333333333";
  const otherOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const workspace = "11111111-1111-4111-8111-111111111111";
  const workspace2 = "12121212-1212-4212-8212-121212121212";
  const org1 = "44444444-4444-4444-8444-444444444444";
  const org2 = "55555555-5555-4555-8555-555555555555";
  const wsGrantId = "77777777-7777-4777-8777-777777777777";
  const ws2GrantId = "77777777-7777-4777-8777-777777777778";
  const org1GrantId = "88888888-8888-4888-8888-888888888881";
  const org2GrantId = "88888888-8888-4888-8888-888888888882";
  const unmatchedGrantId = "99999999-9999-4999-8999-999999999999";
  const multiWorkspace = scenario === "pending-workspace-switch";
  const recent = new Date(Date.now() - 60000).toISOString();
  const before = new Date(Date.now() - 86400000).toISOString();
  const user = {
    id: owner,
    aud: "authenticated",
    role: "authenticated",
    email: "owner@example.test",
    app_metadata: {},
    user_metadata: {},
    created_at: before,
  };
  const otherUser = {
    id: otherOwner,
    aud: "authenticated",
    role: "authenticated",
    email: "other@example.test",
    app_metadata: {},
    user_metadata: {},
    created_at: before,
  };
  const b64 = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const makeJwt = (sub: string, amr: unknown[]) => {
    const nowSec = Math.floor(Date.now() / 1000);
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
      sub,
      role: "authenticated",
      iat: nowSec,
      amr,
    })}.sig`;
  };
  const mintSessionPayload = (targetUser: typeof user, method: string, ageSec = 5) => {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      access_token: makeJwt(targetUser.id, [{ method, timestamp: nowSec - ageSec }]),
      refresh_token: "synthetic-refresh-" + method,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: nowSec + 3600,
      user: targetUser,
    };
  };
  const makeActiveOrgGrant = (orgId: string) => {
    const grantId = orgId === org1 ? org1GrantId : org2GrantId;
    return {
      grant_id: grantId,
      principal_id: principal,
      level: "organization",
      organization_id: orgId,
      scope_names: ["role:organization_admin"],
      workspace_ids: [],
      registry_version: 3,
      expires_at: null,
      state: "active",
      created_at: new Date(Date.now() - 30000).toISOString(),
      ended_at: null,
      end_reason: null,
    };
  };

  const f = (w.seatAdminFixture = {
    scenario,
    continuation,
    initialPathname,
    initialSearch,
    principal,
    owner,
    otherOwner,
    workspace,
    workspace2,
    org1,
    org2,
    wsGrantId,
    ws2GrantId,
    org1GrantId,
    org2GrantId,
    unmatchedGrantId,
    get clockOffsetMs() {
      return clockOffsetMs;
    },
    set clockOffsetMs(next: number) {
      clockOffsetMs = next;
    },
    mintSessionPayload,
    makeActiveOrgGrant,
    enabled: scenario !== "flag-off",
    unresolved: scenario === "unresolved",
    commandMode: scenario === "unknown-and-reauth" ? "unknown-once" : "accept",
    authMode: "fresh" as "fresh" | "refreshed-only" | "other-user" | "magiclink-fresh",
    activeUser: user,
    holdGrantReads: false,
    releaseGrantReads: (() => {}) as () => void,
    holdGrantCommand: false,
    releaseGrantCommand: (() => {}) as () => void,
    grants: continuation ? [...continuation.grants] : ([] as any[]),
    activeGrantIds: continuation
      ? [...continuation.activeGrantIds]
      : scenario === "unresolved"
      ? [unmatchedGrantId]
      : ([] as string[]),
    requests: [] as any[],
    grantReadCount: 0,
    statusReadCount: 0,
  });

  const makeOverviewWorkspace = (wsId: string, wsName: string) => ({
    workspace_id: wsId,
    name: wsName,
    role: "owner",
    last_seen_at: recent,
    new_messages: 0,
    content: null,
    people: [
      {
        user_id: owner,
        display_name: "Synthetic owner",
        role: "owner",
        is_viewer: true,
        agents: [
          {
            principal_id: principal,
            name: "Synthetic assistant",
            status: {
              work: "idle",
              facts: {
                renewal_grant_id: "66666666-6666-4666-8666-666666666666",
                token_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                transport: "local",
                turn_only: false,
                connection: "live",
                last_activity_at: recent,
                messages_waiting_since: null,
                doing: null,
                working_on: null,
              },
            },
            queue: null,
          },
        ],
      },
    ],
    needs_you: { asks: [], assigned: [], waiting: [] },
  });

  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === location.origin) return network(input, init);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : null;
    f.requests.push({ path: url.pathname, search: url.search, body });

    if (url.origin === "https://api.test.invalid") {
      if (url.pathname === "/auth/v1/user") return Response.json(f.activeUser);
      if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
      if (url.pathname === "/auth/v1/token") {
        const now = Math.floor(Date.now() / 1000);
        const nextUser = f.authMode === "other-user" ? otherUser : user;
        f.activeUser = nextUser;
        const amr =
          f.authMode === "refreshed-only"
            ? [
                { method: "password", timestamp: now - 600 },
                { method: "token_refresh", timestamp: now },
              ]
            : f.authMode === "magiclink-fresh"
            ? [{ method: "magiclink", timestamp: now - 5 }]
            : [{ method: "password", timestamp: now - 5 }];
        const token = makeJwt(nextUser.id, amr);
        return Response.json({
          access_token: token,
          refresh_token: "synthetic-refresh-2",
          token_type: "bearer",
          expires_in: 3600,
          expires_at: now + 3600,
          user: nextUser,
        });
      }
      if (url.pathname === "/functions/v1/read") {
        if (body?.resource === "seat_admin_status") {
          f.statusReadCount++;
          if (!f.enabled) return Response.json({ enabled: false });
          const eligibleWs = multiWorkspace ? [workspace, workspace2] : [workspace];
          return Response.json({
            enabled: true,
            registry_version: 3,
            agents: [
              {
                principal_id: principal,
                name: "Synthetic assistant",
                eligible: {
                  workspace: eligibleWs,
                  organization: [org1, org2],
                  scoped: eligibleWs,
                },
                active_grant_ids: [...f.activeGrantIds],
              },
            ],
          });
        }
        if (body?.resource === "renewal_grants") {
          return Response.json({
            grants: [
              {
                renewal_grant_id: "66666666-6666-4666-8666-666666666666",
                principal_id: principal,
                owner_user_id: owner,
                agent_name: "Synthetic assistant",
                model: null,
                kind: "standing",
                horizon_expires_at: null,
                bound_device_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                last_used_at: recent,
                last_used_device_id: null,
                last_used_from: null,
                new_host_at: null,
                suspended_at: null,
                revoked_at: null,
                token_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                issued_at: before,
                token_expires_at: before,
                first_used_at: recent,
                token_revoked_at: null,
                connection_expires_at: null,
                connection_expired_at: null,
              },
            ],
          });
        }
        if (body?.resource === "pending_access") return Response.json({ pending: [], agents: [] });
      }
      if (url.pathname === "/rest/v1/rpc/my_seat_admin_grants") {
        f.grantReadCount++;
        if (f.holdGrantReads) {
          await new Promise<void>(resolve => {
            f.releaseGrantReads = resolve;
          });
        }
        return Response.json({ grants: [...f.grants] });
      }
      if (url.pathname === "/rest/v1/organizations") {
        return Response.json([
          { id: org1, name: "First Org", role: "owner", archived_at: null },
          { id: org2, name: "Second Org", role: "owner", archived_at: null },
        ]);
      }
      if (url.pathname === "/functions/v1/command") {
        const c = body?.command;
        if (c?.kind === "grant_seat_admin") {
          if (f.holdGrantCommand) {
            await new Promise<void>(resolve => {
              f.releaseGrantCommand = resolve;
            });
          }
          if (c.expires_at !== null && (typeof c.expires_at !== "number" || !Number.isInteger(c.expires_at))) {
            return Response.json({ error: "invalid_expires_at" }, { status: 400 });
          }
          if (f.commandMode === "unknown-once") {
            f.commandMode = "accept";
            return Response.json({ error: "bad_gateway" }, { status: 502 });
          }
          if (f.commandMode === "reauth") {
            return Response.json(
              { error: "human_confirmation_required", message: "Sign in again to confirm agent admin access." },
              { status: 401 },
            );
          }
          const grantId =
            c.level === "workspace"
              ? c.workspace_ids?.[0] === workspace2
                ? ws2GrantId
                : wsGrantId
              : c.organization_id === org1
              ? org1GrantId
              : org2GrantId;
          const expiresIso = c.expires_at === null ? null : new Date(c.expires_at).toISOString();
          const createdAt = new Date(Date.now()).toISOString();
          const row = {
            grant_id: grantId,
            principal_id: c.principal_id,
            level: c.level,
            organization_id: c.organization_id,
            scope_names: c.scope_names,
            workspace_ids: c.workspace_ids,
            registry_version: 3,
            expires_at: expiresIso,
            state: "active",
            created_at: createdAt,
            ended_at: null,
            end_reason: null,
          };
          f.grants = [row, ...f.grants.filter((g: any) => g.grant_id !== grantId)];
          if (!f.activeGrantIds.includes(grantId)) f.activeGrantIds.push(grantId);
          return Response.json({
            status: "accepted",
            seat_admin_grant: {
              grant_id: grantId,
              principal_id: c.principal_id,
              level: c.level,
              organization_id: c.organization_id,
              scope_names: c.scope_names,
              workspace_ids: c.workspace_ids,
              capability_names: [],
              expires_at: expiresIso,
              state: "active",
              created_at: createdAt,
              ended_at: null,
              end_reason: null,
              manifest_digest: "0".repeat(64),
            },
          });
        }
        if (c?.kind === "end_seat_admin") {
          const targetId = c.grant_id;
          const endedAt = new Date(Date.now()).toISOString();
          f.grants = f.grants.map((g: any) =>
            g.grant_id === targetId ? { ...g, state: "downgraded", ended_at: endedAt, end_reason: "owner_downgrade" } : g,
          );
          f.activeGrantIds = f.activeGrantIds.filter((id: string) => id !== targetId);
          const updated = f.grants.find((g: any) => g.grant_id === targetId);
          return Response.json({
            status: "accepted",
            seat_admin_grant: {
              ...(updated ?? {
                grant_id: targetId,
                principal_id: principal,
                level: "workspace",
                organization_id: null,
                scope_names: ["role:workspace_admin"],
                workspace_ids: [workspace],
                expires_at: null,
                created_at: before,
              }),
              capability_names: [],
              state: "downgraded",
              ended_at: endedAt,
              end_reason: "owner_downgrade",
              manifest_digest: "0".repeat(64),
            },
          });
        }
        if (c?.kind === "household_access") return Response.json({ status: "ok", content_role: null });
        if (c?.kind === "household_tool" && c?.tool === "todo_queue") {
          const cmdWs = body?.workspace_id || c?.workspace_id || workspace;
          return Response.json({
            status: "ok",
            queue: {
              workspace_id: cmdWs,
              principal_id: principal,
              owner_user_id: owner,
              read_at: new Date(Date.now()).toISOString(),
              accepts_from: "owner",
              content_access: "none",
              working: [],
              up_next: [],
              not_yet: [],
              requests: [],
              next_offset: { working: null, up_next: null, not_yet: null, requests: null },
              status: {
                work: "idle",
                facts: {
                  transport: "local",
                  turn_only: false,
                  connection: "live",
                  renewal_grant_id: "66666666-6666-4666-8666-666666666666",
                  token_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                  connection_expires_at: null,
                  connection_expired_at: null,
                  last_activity_at: recent,
                  messages_waiting_since: null,
                  doing: null,
                  working_on: null,
                },
              },
            },
          });
        }
        if (c?.kind === "household_tool") return Response.json({ status: "refused", reason: "content_consent_required" });
        if (c?.kind === "todo_list") return Response.json({ status: "ok", todos: [], next_offset: null });
        return Response.json({ status: "refused", reason: "content_consent_required" });
      }
      if (url.pathname === "/rest/v1/rpc/channel_unread") {
        const reqWs = body?.p_workspace_id || workspace;
        return Response.json({
          workspace_id: reqWs,
          generated_at: new Date(Date.now()).toISOString(),
          channels: [{ channel_id: null, slug: "general", unread: null }],
        });
      }
      if (url.pathname === "/rest/v1/rpc/decision_queue") {
        const reqWs = body?.p_workspace_id || workspace;
        return Response.json({
          workspace_id: reqWs,
          generated_at: new Date(Date.now()).toISOString(),
          total: 0,
          truncated: false,
          asks: [],
        });
      }
      if (url.pathname === "/rest/v1/rpc/home_overview") {
        return Response.json({
          viewer_user_id: owner,
          generated_at: new Date(Date.now()).toISOString(),
          workspaces: multiWorkspace
            ? [makeOverviewWorkspace(workspace, "Home"), makeOverviewWorkspace(workspace2, "Studio")]
            : [makeOverviewWorkspace(workspace, "Home")],
        });
      }
      if (url.pathname === "/rest/v1/workspaces") {
        return Response.json(
          multiWorkspace
            ? [
                { workspace_id: workspace, org_id: org1, name: "Home", archived_at: null },
                { workspace_id: workspace2, org_id: org1, name: "Studio", archived_at: null },
              ]
            : [{ workspace_id: workspace, org_id: org1, name: "Home", archived_at: null }],
        );
      }
      if (url.pathname === "/rest/v1/member_profiles") {
        return Response.json([{ user_id: owner, display_name: "Synthetic owner", role: "owner" }]);
      }
      if (url.pathname === "/rest/v1/agent_principals") {
        const eqWs = url.searchParams.get("workspace_id")?.replace(/^eq\./, "") || workspace;
        return Response.json(
          url.searchParams.get("revoked_at")?.startsWith("not.")
            ? []
            : [
                {
                  principal_id: principal,
                  name: "Synthetic assistant",
                  model: null,
                  transport: "local",
                  turn_only: false,
                  owner_user_id: owner,
                  revoked_at: null,
                  workspace_id: eqWs,
                  created_at: before,
                },
              ],
        );
      }
      if (url.pathname === "/rest/v1/hosted_mcp_connections") return Response.json([]);
      if (
        [
          "account_agents",
          "agent_presence",
          "agent_wake_path",
          "pending_invitations",
          "files",
          "channels",
          "signals",
          "hosted_mcp_seats",
          "my_devices",
        ].some(table => url.pathname === "/rest/v1/" + table)
      ) {
        return Response.json([]);
      }
    }
    return Response.json({ error: "unexpected_fixture_request", path: url.pathname }, { status: 404 });
  };

  if (!continuation) {
    localStorage.setItem(
      "sb-api-auth-token",
      JSON.stringify(mintSessionPayload(user, "password", 10)),
    );
  }
}

async function observeSeatAdminApp() {
  const w = window as any;
  const f = w.seatAdminFixture;
  const copyContract = w.__seatAdminCopyContract;
  const one = (selector: string): any => document.querySelector(selector);
  const assert = (ok: unknown, msg: string) => {
    if (!ok) throw new Error(f.scenario + ": " + msg);
  };
  const tick = async () => {
    const r = fetch("/__observer-tick");
    await navigator.locks?.query();
    await r;
  };
  const wait = async (fn: () => unknown, label = "condition") => {
    for (let i = 0; i < 450; i++) {
      const value = fn();
      if (value) return value;
      await tick();
    }
    throw new Error(
      f.scenario +
        ": timeout waiting for " +
        label +
        " (" +
        location.search +
        "; state=" +
        one("live-dashboard")?.dataset.state +
        ")",
    );
  };
  const seatCommands = () =>
    f.requests
      .filter(
        (r: any) =>
          r.path === "/functions/v1/command" &&
          ["grant_seat_admin", "end_seat_admin"].includes(r.body?.command?.kind),
      )
      .map((r: any) => r.body);
  const findDialogBtn = (dlg: Element, label: string): HTMLButtonElement | null =>
    Array.from(dlg.querySelectorAll<HTMLButtonElement>("button")).find(
      btn => btn.textContent === label && !btn.hidden,
    ) ?? null;
  const formatEndNote = (ms: number): string =>
    "Ends " +
    new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(ms) +
    ".";
  const verifyPermissionSections = (
    dlg: Element,
    roleKey: "role:workspace_admin" | "role:organization_admin",
  ) => {
    const expectedRole = copyContract.SEAT_ADMIN_ROLE_COPY[roleKey];
    const sections = Array.from(dlg.querySelectorAll("section.sa-confirm__permissions"));
    assert(sections.length === 3, roleKey + ": renders all three permission sections");
    const expected: Array<[string, readonly string[]]> = [
      ["Available now", expectedRole.included],
      ["Included, not available yet", expectedRole.deferred],
      ["Not allowed", expectedRole.excluded],
    ];
    for (let i = 0; i < expected.length; i++) {
      const [heading, lines] = expected[i]!;
      const section = sections[i]!;
      assert(
        section.querySelector("h3")?.textContent === heading,
        roleKey + ": section heading matches '" + heading + "'",
      );
      const renderedItems = Array.from(section.querySelectorAll("li")).map(li => li.textContent);
      assert(
        renderedItems.length === lines.length &&
          renderedItems.every((text, idx) => text === lines[idx]),
        roleKey + ": items match approved copy for '" + heading + "'",
      );
    }
  };

  try {
    if (
      f.scenario === "flag-off" ||
      f.scenario === "grant-and-remove" ||
      f.scenario === "unresolved"
    ) {
      await wait(() => one('[data-rail-agent="' + f.principal + '"]'), "Home overview agent row");
      one('[data-rail-agent="' + f.principal + '"]').click();
      await wait(
        () =>
          one("[data-home-route-pane] [data-connection-end-date]") &&
          f.requests.some((r: any) => r.body?.command?.tool === "todo_queue") &&
          !one("[data-home-route-pane]")?.textContent?.includes("Checking the line"),
        "agent page settled after queue read",
      );
    }

    if (f.scenario === "flag-off") {
      await wait(() => f.statusReadCount >= 1, "seat_admin_status read");
      await tick();
      assert(!document.querySelector("[data-seat-admin]"), "panel stays hidden when flag is off");
      assert(f.grantReadCount === 0, "no my_seat_admin_grants probe when flag is off");
    } else if (f.scenario === "grant-and-remove") {
      const panel = (await wait(
        () => document.querySelector<HTMLElement>('[data-seat-admin="ready"]'),
        "seat-admin panel",
      )) as HTMLElement;
      assert(panel.closest(".hm-agent__aside"), "mounted inside .hm-agent__aside on agent profile");
      const wsToggle = panel.querySelector<HTMLButtonElement>('[data-seat-admin-toggle="workspace"]')!;
      const orgToggle = panel.querySelector<HTMLButtonElement>('[data-seat-admin-toggle="organization"]')!;
      assert(wsToggle.getAttribute("aria-checked") === "false", "workspace starts off");
      assert(orgToggle.getAttribute("aria-checked") === "false", "organization starts off");

      wsToggle.click();
      const wsDialog = (await wait(
        () => document.querySelector<HTMLDialogElement>('dialog[data-seat-admin-confirm="workspace"]'),
        "workspace dialog",
      )) as HTMLDialogElement;
      verifyPermissionSections(wsDialog, "role:workspace_admin");

      const wsDuration = wsDialog.querySelector<HTMLSelectElement>("[data-seat-admin-duration]")!;
      wsDuration.value = "7";
      wsDuration.dispatchEvent(new Event("change", { bubbles: true }));
      const wsEndNote = wsDialog.querySelector<HTMLElement>(".sa-confirm__end-note")!.textContent!;
      wsDialog.querySelector<HTMLButtonElement>("[data-seat-admin-grant]")!.click();

      await wait(
        () =>
          document.querySelector<HTMLElement>('[data-seat-admin-toggle="workspace"]')?.getAttribute("aria-checked") ===
          "true",
        "workspace turned on after server read",
      );
      assert(
        document
          .querySelector<HTMLElement>('[data-seat-admin-toggle="organization"]')
          ?.getAttribute("aria-checked") === "false",
        "organization stays off when workspace turns on",
      );
      const firstCmd = seatCommands()[0];
      assert(
        firstCmd.command.kind === "grant_seat_admin" && firstCmd.command.level === "workspace",
        "workspace grant command sent",
      );
      assert(
        typeof firstCmd.command.expires_at === "number" && Number.isInteger(firstCmd.command.expires_at),
        "pinned numeric epoch-ms expires_at sent",
      );
      assert(
        wsEndNote === formatEndNote(firstCmd.command.expires_at),
        "displayed end note matches submitted numeric expires_at",
      );

      document.querySelector<HTMLButtonElement>('[data-seat-admin-toggle="organization"]')!.click();
      const orgDialog = (await wait(
        () => document.querySelector<HTMLDialogElement>('dialog[data-seat-admin-confirm="organization"]'),
        "organization dialog",
      )) as HTMLDialogElement;
      verifyPermissionSections(orgDialog, "role:organization_admin");

      const orgConfirm = orgDialog.querySelector<HTMLButtonElement>("[data-seat-admin-grant]")!;
      const orgSelect = orgDialog.querySelector<HTMLSelectElement>("[data-seat-admin-scope]")!;
      assert(orgConfirm.disabled && orgSelect.value === "", "multiple organizations require explicit selection");
      orgSelect.value = f.org2;
      orgSelect.dispatchEvent(new Event("change", { bubbles: true }));
      const orgDuration = orgDialog.querySelector<HTMLSelectElement>("[data-seat-admin-duration]")!;
      orgDuration.value = "none";
      orgDuration.dispatchEvent(new Event("change", { bubbles: true }));
      assert(
        orgDialog.querySelector<HTMLElement>(".sa-confirm__end-note")?.textContent ===
          copyContract.SEAT_ADMIN_NO_END_DATE_LINE,
        "no-end-date duration displays approved SEAT_ADMIN_NO_END_DATE_LINE",
      );
      assert(!orgConfirm.disabled, "confirm enabled after choosing organization");
      orgConfirm.click();

      await wait(
        () =>
          document
            .querySelector<HTMLElement>('[data-seat-admin-toggle="organization"]')
            ?.getAttribute("aria-checked") === "true",
        "organization turned on after server read",
      );
      const secondCmd = seatCommands()[1];
      assert(
        secondCmd.command.level === "organization" &&
          secondCmd.command.organization_id === f.org2 &&
          secondCmd.command.expires_at === null,
        "organization grant command sent with selected org2 and null expires_at",
      );

      // One-click removal of workspace admin leaves organization admin on and records state="downgraded".
      document.querySelector<HTMLButtonElement>('[data-seat-admin-toggle="workspace"]')!.click();
      await wait(
        () =>
          document.querySelector<HTMLElement>('[data-seat-admin-toggle="workspace"]')?.getAttribute("aria-checked") ===
          "false",
        "workspace removed",
      );
      assert(
        document
          .querySelector<HTMLElement>('[data-seat-admin-toggle="organization"]')
          ?.getAttribute("aria-checked") === "true",
        "organization remains active after workspace removal",
      );
      assert(
        document
          .querySelector<HTMLElement>("[data-seat-admin] .sa-admin__notice")
          ?.textContent?.includes("Organization admin remains on"),
        "removal receipt confirms remaining level",
      );
      assert(
        f.grants.find((g: any) => g.grant_id === f.wsGrantId)?.state === "downgraded",
        "end_seat_admin writes downgraded state",
      );
    } else if (f.scenario === "pending-workspace-switch") {
      await wait(
        () => one("live-dashboard")?.dataset.state === "channel" && document.getElementById("pd-agent-" + f.principal),
        "Home workspace people roster row",
      );
      (document.getElementById("pd-agent-" + f.principal) as HTMLElement).click();
      const ws1Panel = (await wait(
        () => document.querySelector<HTMLElement>('[data-people-detail] [data-seat-admin="ready"]'),
        "Home workspace seat-admin panel",
      )) as HTMLElement;
      f.holdGrantCommand = true;
      ws1Panel.querySelector<HTMLButtonElement>('[data-seat-admin-toggle="workspace"]')!.click();
      const dialog = (await wait(
        () => document.querySelector<HTMLDialogElement>('dialog[data-seat-admin-confirm="workspace"]'),
        "Home workspace dialog",
      )) as HTMLDialogElement;
      dialog.querySelector<HTMLButtonElement>("[data-seat-admin-grant]")!.click();
      await wait(() => seatCommands().length === 1 && findDialogBtn(dialog, "Close"), "pending command in flight");

      // Close the pending dialog and switch to Studio workspace before the server responds.
      findDialogBtn(dialog, "Close")!.click();
      assert(
        document.querySelector('[data-people-detail] [data-seat-admin-level="workspace"] .sa-admin__unresolved')
          ?.textContent === "Not checked",
        "Home workspace row shows Not checked while command is pending",
      );
      const studioAgentReadsBefore = f.requests.filter(
        (r: any) => r.path === "/rest/v1/agent_principals" && r.search.includes(f.workspace2),
      ).length;
      const studioMemberReadsBefore = f.requests.filter(
        (r: any) => r.path === "/rest/v1/member_profiles" && r.search.includes(f.workspace2),
      ).length;
      const studioBtn = (await wait(
        () => document.querySelector<HTMLButtonElement>('[data-workspace-picker-root] button[value="' + f.workspace2 + '"]'),
        "Studio workspace picker button",
      )) as HTMLButtonElement;
      studioBtn.click();
      await wait(
        () =>
          one("live-dashboard")?.dataset.adminWorkspace === f.workspace2 &&
          f.requests.filter((r: any) => r.path === "/rest/v1/agent_principals" && r.search.includes(f.workspace2))
            .length > studioAgentReadsBefore &&
          f.requests.filter((r: any) => r.path === "/rest/v1/member_profiles" && r.search.includes(f.workspace2))
            .length > studioMemberReadsBefore &&
          one("[data-roster-open]"),
        "switched active workspace to Studio and loaded roster",
      );
      one("[data-roster-open]").click();
      const studioAgentRow = (await wait(
        () =>
          location.search.includes("w=" + f.workspace2) &&
          location.search.includes("v=people") &&
          document.getElementById("pd-agent-" + f.principal),
        "Studio people roster row",
      )) as HTMLElement;
      if (studioAgentRow.getAttribute("aria-expanded") !== "true") {
        studioAgentRow.click();
      }
      const ws2Panel = (await wait(() => {
        const p = document.querySelector<HTMLElement>('[data-people-detail]:not([hidden]) [data-seat-admin="ready"]');
        return p?.querySelector('[data-seat-admin-level="workspace"] .sa-admin__scope')?.textContent === "Studio"
          ? p
          : null;
      }, "Studio seat-admin panel")) as HTMLElement;
      assert(
        ws2Panel.querySelector('[data-seat-admin-toggle="workspace"]')?.getAttribute("aria-checked") === "false",
        "Studio workspace switch is independent of Home's pending workspace attempt",
      );

      // Settle Home's pending command while Studio is the active workspace.
      const readsBeforeRelease = f.grantReadCount;
      f.holdGrantCommand = false;
      f.releaseGrantCommand();
      await wait(
        () =>
          f.grants.some((g: any) => g.grant_id === f.wsGrantId && g.state === "active") &&
          f.grantReadCount > readsBeforeRelease,
        "Home grant settled and refreshed while viewing Studio",
      );

      // Return to Home workspace and verify the workspace row reflects server truth (on), not stuck on Not checked.
      const homeAgentReadsBefore = f.requests.filter(
        (r: any) => r.path === "/rest/v1/agent_principals" && r.search.includes(f.workspace),
      ).length;
      const homeMemberReadsBefore = f.requests.filter(
        (r: any) => r.path === "/rest/v1/member_profiles" && r.search.includes(f.workspace),
      ).length;
      document.querySelector<HTMLButtonElement>('[data-workspace-picker-root] button[value="' + f.workspace + '"]')!.click();
      await wait(
        () =>
          one("live-dashboard")?.dataset.adminWorkspace === f.workspace &&
          f.requests.filter((r: any) => r.path === "/rest/v1/agent_principals" && r.search.includes(f.workspace))
            .length > homeAgentReadsBefore &&
          f.requests.filter((r: any) => r.path === "/rest/v1/member_profiles" && r.search.includes(f.workspace))
            .length > homeMemberReadsBefore &&
          one("[data-roster-open]"),
        "returned to Home workspace and loaded roster",
      );
      one("[data-roster-open]").click();
      const homeAgentRow = (await wait(
        () =>
          location.search.includes("w=" + f.workspace) &&
          location.search.includes("v=people") &&
          document.getElementById("pd-agent-" + f.principal),
        "Home people roster row on return",
      )) as HTMLElement;
      if (homeAgentRow.getAttribute("aria-expanded") !== "true") {
        homeAgentRow.click();
      }
      const returnedPanel = (await wait(() => {
        const p = document.querySelector<HTMLElement>('[data-people-detail]:not([hidden]) [data-seat-admin="ready"]');
        return p?.querySelector('[data-seat-admin-level="workspace"] .sa-admin__scope')?.textContent === "Home"
          ? p
          : null;
      }, "Home seat-admin panel on return")) as HTMLElement;
      assert(
        !returnedPanel.querySelector('[data-seat-admin-level="workspace"] .sa-admin__unresolved'),
        "pending attempt did not stay stuck as Not checked across workspace switch",
      );
      assert(
        returnedPanel.querySelector('[data-seat-admin-toggle="workspace"]')?.getAttribute("aria-checked") === "true",
        "Home workspace switch shows server truth (active) on return",
      );
    } else if (f.scenario === "unresolved") {
      const panel = (await wait(
        () => document.querySelector<HTMLElement>('[data-seat-admin="ready"]'),
        "unresolved panel",
      )) as HTMLElement;
      assert(
        panel.querySelector('[data-seat-admin-level="workspace"] .sa-admin__unresolved')?.textContent ===
          "Not checked" && !panel.querySelector('[data-seat-admin-toggle="workspace"]'),
        "workspace row shows unresolved instead of off",
      );
      assert(
        panel.querySelector('[data-seat-admin-level="organization"] .sa-admin__unresolved')?.textContent ===
          "Not checked" && !panel.querySelector('[data-seat-admin-toggle="organization"]'),
        "organization row shows unresolved instead of off",
      );
    } else if (f.scenario === "unknown-and-reauth") {
      await wait(
        () => one("live-dashboard")?.dataset.state === "channel" && document.getElementById("pd-agent-" + f.principal),
        "people roster row",
      );
      (document.getElementById("pd-agent-" + f.principal) as HTMLElement).click();
      const panel = (await wait(
        () => document.querySelector<HTMLElement>('[data-people-detail] [data-seat-admin="ready"]'),
        "people detail seat-admin panel",
      )) as HTMLElement;
      panel.querySelector<HTMLButtonElement>('[data-seat-admin-toggle="workspace"]')!.click();
      const dialog = (await wait(
        () => document.querySelector<HTMLDialogElement>('dialog[data-seat-admin-confirm="workspace"]'),
        "workspace dialog",
      )) as HTMLDialogElement;
      const durationSelect = dialog.querySelector<HTMLSelectElement>("[data-seat-admin-duration]")!;
      durationSelect.value = "1";
      durationSelect.dispatchEvent(new Event("change", { bubbles: true }));
      const initialEndNote = dialog.querySelector<HTMLElement>(".sa-confirm__end-note")!.textContent!;
      dialog.querySelector<HTMLButtonElement>("[data-seat-admin-grant]")!.click();

      await wait(() => findDialogBtn(dialog, "Refresh admin access"), "unknown outcome refresh button");
      const firstCommandId = seatCommands()[0].command_id;
      const firstExpiresAt = seatCommands()[0].command.expires_at;
      assert(typeof firstExpiresAt === "number", "initial command uses numeric epoch-ms expires_at");
      assert(initialEndNote === formatEndNote(firstExpiresAt), "initial displayed end date matches submitted expires_at");

      // Hold the background grant read so we can observe the panel immediately after closing an unknown dialog.
      f.holdGrantReads = true;
      (findDialogBtn(dialog, "Cancel") ?? findDialogBtn(dialog, "Close"))!.click();
      assert(
        document.querySelector('[data-people-detail] [data-seat-admin-level="workspace"] .sa-admin__unresolved')
          ?.textContent === "Not checked" &&
          !document.querySelector('[data-people-detail] [data-seat-admin-toggle="workspace"]'),
        "closing unknown dialog leaves panel unresolved (Not checked) until reconciled",
      );
      f.holdGrantReads = false;
      f.releaseGrantReads();

      // Reconciled read confirms no grant exists; panel returns to Off with retry notice.
      await wait(
        () =>
          document
            .querySelector<HTMLElement>('[data-people-detail] [data-seat-admin-toggle="workspace"]')
            ?.getAttribute("aria-checked") === "false",
        "panel reconciled back to Off after read confirms no active grant",
      );

      // Advance clock by 45 minutes before reopening: reopened unresolved attempt keeps pinned display + transport expiry.
      f.clockOffsetMs += 45 * 60_000;
      document.querySelector<HTMLButtonElement>('[data-people-detail] [data-seat-admin-toggle="workspace"]')!.click();
      const reopened = (await wait(
        () => document.querySelector<HTMLDialogElement>('dialog[data-seat-admin-confirm="workspace"]'),
        "reopened workspace dialog",
      )) as HTMLDialogElement;
      assert(
        reopened.querySelector<HTMLSelectElement>("[data-seat-admin-duration]")?.value === "1",
        "reopened dialog retains 1-day duration",
      );
      const reopenedEndNote = reopened.querySelector<HTMLElement>(".sa-confirm__end-note")!.textContent!;
      assert(reopenedEndNote === initialEndNote, "reopened dialog keeps displaying the original pinned end date");
      assert(
        reopenedEndNote !== formatEndNote(Date.now() + 86_400_000),
        "clock advanced by 45m so unpinned recomputation would differ",
      );

      f.commandMode = "reauth";
      reopened.querySelector<HTMLButtonElement>("[data-seat-admin-grant]")!.click();
      const reauthBtn = (await wait(
        () => findDialogBtn(reopened, "Sign in again"),
        "reauth button",
      )) as HTMLButtonElement;
      assert(seatCommands()[1].command_id === firstCommandId, "reopened retry reuses the same command_id");
      assert(seatCommands()[1].command.expires_at === firstExpiresAt, "reopened retry reuses the pinned numeric expires_at");
      assert(
        reopenedEndNote === formatEndNote(seatCommands()[1].command.expires_at),
        "reopened dialog displayed end date matches exact submitted numeric expires_at",
      );

      reauthBtn.click();
      await wait(
        () => document.querySelector<HTMLElement>("live-dashboard")?.dataset.state === "signed-out",
        "signed-out panel shown for reauth",
      );
      assert(seatCommands().length === 2, "reauth transition never auto-submits a grant command");
      const reauthLogouts = f.requests.filter((r: any) => r.path === "/auth/v1/logout");
      assert(
        reauthLogouts.length === 1 && reauthLogouts[0].search === "?scope=local",
        "reauth sign-out uses local scope (?scope=local) and never global logout",
      );
      const reauthKey = "commonswarm:seat-admin-reauth:v1:" + f.owner;
      const savedIntentRaw = sessionStorage.getItem(reauthKey);
      assert(savedIntentRaw, "reauth intent saved in sessionStorage under user-scoped key");
      const savedIntent = JSON.parse(savedIntentRaw!);
      assert(
        savedIntent.days === 1 && savedIntent.routeView === "people",
        "reauth intent preserves 1-day duration and routeView",
      );
      assert(
        !("expiresAt" in savedIntent) && !("commandId" in savedIntent),
        "reauth intent excludes expiresAt and commandId",
      );

      // Step 1 after sign-out: signing in as a DIFFERENT account clears the previous owner's intent and never opens confirmation.
      f.authMode = "other-user";
      const passwordInput = document.querySelector<HTMLInputElement>("#dashboard-password")!;
      passwordInput.value = "synthetic-password";
      document.querySelector<HTMLFormElement>("[data-signin-form]")!.requestSubmit();
      await wait(
        () => document.querySelector<HTMLElement>("live-dashboard")?.dataset.state === "channel",
        "different user signed in",
      );
      assert(sessionStorage.getItem(reauthKey) === null, "different account sign-in clears prior user's reauth intent");
      assert(!document.querySelector("dialog[data-seat-admin-confirm]"), "different account never opens prior user's confirmation dialog");

      // Step 2: Ordinary Sign out stays global (?scope=global); restore owner's reauth intent and verify refreshed-only AMR is refused.
      document.querySelector<HTMLButtonElement>("[data-signout]")!.click();
      await wait(
        () => document.querySelector<HTMLElement>("live-dashboard")?.dataset.state === "signed-out",
        "signed out different user",
      );
      assert(
        f.requests.some((r: any) => r.path === "/auth/v1/logout" && r.search === "?scope=global"),
        "ordinary Sign out button preserves global scope",
      );
      sessionStorage.setItem(reauthKey, savedIntentRaw!);
      f.authMode = "refreshed-only";
      const emailInput = document.querySelector<HTMLInputElement>("#dashboard-email")!;
      emailInput.value = "owner@example.test";
      passwordInput.value = "synthetic-password";
      document.querySelector<HTMLFormElement>("[data-signin-form]")!.requestSubmit();
      await wait(
        () =>
          document
            .querySelector<HTMLElement>("[data-people-detail] [data-seat-admin] .sa-admin__notice")
            ?.textContent?.includes("refreshed without an interactive sign-in"),
        "refreshed-only AMR token refused on reauth return",
      );
      assert(!document.querySelector("dialog[data-seat-admin-confirm]"), "refreshed-only session does not open confirmation dialog");
      assert(seatCommands().length === 2, "zero grant commands sent on refreshed-only return");

      // Step 3: Navigate to Agent page, trigger reauth for Second Org (org2, 1 day), then load a FRESH DOCUMENT at plain /app
      // while First Org (org1) is ALREADY active on the server (proving exact-scope org reconciliation + fresh-document OAuth return).
      const manageLink = (await wait(
        () => document.querySelector<HTMLAnchorElement>('a[data-pd-focus="manage-' + f.principal + '"]'),
        "Manage agent link on People page",
      )) as HTMLAnchorElement;
      manageLink.click();
      const agentOrgToggle = (await wait(
        () => document.querySelector<HTMLButtonElement>('.hm-agent__aside [data-seat-admin-toggle="organization"]'),
        "organization toggle on Agent page",
      )) as HTMLButtonElement;
      agentOrgToggle.click();
      const orgDialog = (await wait(
        () => document.querySelector<HTMLDialogElement>('dialog[data-seat-admin-confirm="organization"]'),
        "organization dialog before reauth",
      )) as HTMLDialogElement;
      const orgSelect = orgDialog.querySelector<HTMLSelectElement>("[data-seat-admin-scope]")!;
      orgSelect.value = f.org2;
      orgSelect.dispatchEvent(new Event("change", { bubbles: true }));
      const orgDuration = orgDialog.querySelector<HTMLSelectElement>("[data-seat-admin-duration]")!;
      orgDuration.value = "1";
      orgDuration.dispatchEvent(new Event("change", { bubbles: true }));
      const preReauthEndNote = orgDialog.querySelector<HTMLElement>(".sa-confirm__end-note")!.textContent!;
      f.commandMode = "reauth";
      orgDialog.querySelector<HTMLButtonElement>("[data-seat-admin-grant]")!.click();
      const orgReauthBtn = (await wait(
        () => findDialogBtn(orgDialog, "Sign in again"),
        "organization reauth button",
      )) as HTMLButtonElement;
      const preReauthCommandId = seatCommands()[2].command_id;
      const preReauthExpiresAt = seatCommands()[2].command.expires_at;
      orgReauthBtn.click();
      await wait(
        () => document.querySelector<HTMLElement>("live-dashboard")?.dataset.state === "signed-out",
        "signed-out panel before fresh-document plain-/app OAuth return",
      );
      const savedOrgIntent = JSON.parse(sessionStorage.getItem(reauthKey)!);
      assert(
        savedOrgIntent.routeView === "agent" &&
          savedOrgIntent.level === "organization" &&
          savedOrgIntent.scopeId === f.org2 &&
          savedOrgIntent.days === 1,
        "saved organization reauth intent preserves routeView='agent', org2 scopeId, and 1-day duration",
      );

      // Advance clock another 45 minutes, persist an OAuth session token, make org1 active, and load a fresh document at plain /app.
      f.clockOffsetMs += 45 * 60_000;
      localStorage.setItem(
        "sb-api-auth-token",
        JSON.stringify(f.mintSessionPayload(f.activeUser, "oauth", 5)),
      );
      const org1Active = f.makeActiveOrgGrant(f.org1);
      sessionStorage.setItem(
        "__seatAdminTestContinuation",
        JSON.stringify({
          scenario: "reauth-fresh-doc-return",
          clockOffsetMs: f.clockOffsetMs,
          grants: [org1Active],
          activeGrantIds: [org1Active.grant_id],
          preReauthCommandId,
          preReauthExpiresAt,
          preReauthEndNote,
        }),
      );
      location.assign("/app");
      return;
    } else if (f.scenario === "reauth-fresh-doc-return") {
      assert(
        f.initialPathname === "/app" && f.initialSearch === "",
        "OAuth/email-link return booted a fresh document on plain /app with empty query string",
      );
      const returnDialog = (await wait(
        () => document.querySelector<HTMLDialogElement>('dialog[data-seat-admin-confirm="organization"]'),
        "organization confirmation dialog reopened on Agent page after fresh-document /app return",
      )) as HTMLDialogElement;
      assert(
        Boolean(document.querySelector('.hm-agent__aside [data-seat-admin="ready"]')),
        "fresh-document plain-/app return routed to the saved Agent page destination",
      );
      assert(
        document
          .querySelector<HTMLElement>('.hm-agent__aside [data-seat-admin-toggle="organization"]')
          ?.getAttribute("aria-checked") === "true",
        "panel reflects existing First Org (org1) grant while Second Org (org2) confirmation still opens",
      );
      assert(
        returnDialog.querySelector<HTMLSelectElement>("[data-seat-admin-scope]")?.value === f.org2,
        "reopened confirmation preserves exact Second Org (org2) scope",
      );
      assert(
        returnDialog.querySelector<HTMLSelectElement>("[data-seat-admin-duration]")?.value === "1",
        "reopened confirmation preserves 1-day duration",
      );
      assert(
        returnDialog
          .querySelector<HTMLElement>(".sa-confirm__notice")
          ?.textContent?.includes("Signed in. Confirm admin access to finish."),
        "reopened confirmation shows signed-in prompt",
      );
      const postReauthEndNote = returnDialog.querySelector<HTMLElement>(".sa-confirm__end-note")!.textContent!;
      assert(
        postReauthEndNote !== f.continuation.preReauthEndNote,
        "fresh-document auth return displays a newly computed end date rather than the pre-reauth expiry",
      );
      assert(
        seatCommands().length === 0,
        "fresh-document auth return dispatches zero grant commands before explicit click",
      );

      returnDialog.querySelector<HTMLButtonElement>("[data-seat-admin-grant]")!.click();
      await wait(
        () =>
          seatCommands().length === 1 &&
          f.grants.some((g: any) => g.organization_id === f.org2 && g.state === "active"),
        "Second Org grant accepted after explicit click",
      );
      const postReauthCmd = seatCommands()[0];
      assert(
        postReauthCmd.command.level === "organization" && postReauthCmd.command.organization_id === f.org2,
        "explicit confirmation grants Second Org (org2)",
      );
      assert(
        postReauthCmd.command_id !== f.continuation.preReauthCommandId,
        "post-reauth confirmation mints a fresh command_id",
      );
      assert(
        typeof postReauthCmd.command.expires_at === "number" &&
          postReauthCmd.command.expires_at > f.continuation.preReauthExpiresAt,
        "post-reauth confirmation submits newly computed numeric expires_at",
      );
      assert(
        postReauthEndNote === formatEndNote(postReauthCmd.command.expires_at),
        "post-reauth displayed end date matches submitted numeric expires_at",
      );
      document.documentElement.dataset.seatAdminObservation = JSON.stringify({
        scenario: "unknown-and-reauth",
        commands: seatCommands().length,
      });
      return;
    }

    document.documentElement.dataset.seatAdminObservation = JSON.stringify({
      scenario: f.scenario,
      commands: seatCommands().length,
    });
  } catch (error) {
    document.documentElement.dataset.seatAdminObservation = JSON.stringify({
      scenario: f.scenario === "reauth-fresh-doc-return" ? "unknown-and-reauth" : f.scenario,
      error: String(error),
    });
  }
}

test(
  "mounted seat-admin panels and confirmation dialogs enforce flag-off, independent levels, workspace-switch settlement, unresolved safety, and unknown/reauth recovery",
  { timeout: 120_000 },
  async () => {
    const component = fileURLToPath(new URL("./LiveDashboard.astro", import.meta.url));
    const scripts = new Map<string, string[]>();
    const styles: string[] = [];
    const compiler: Plugin = {
      name: "seat-admin-astro-container",
      setup(builder) {
        builder.onLoad({ filter: /\.astro$/ }, async args => {
          const compiled = transform(await readFile(args.path, "utf8"), {
            filename: args.path,
            internalURL: "astro/compiler-runtime",
            resultScopedSlot: true,
            resolvePath: specifier => specifier,
          });
          assert.deepEqual(
            compiled.diagnostics.filter(d => d.severity === "error"),
            [],
          );
          scripts.set(
            args.path,
            compiled.scripts.map(s => s.code).filter((code): code is string => typeof code === "string"),
          );
          styles.push(...compiled.css);
          return {
            contents: compiled.code.replace(/import "[^"\n]+\?astro&type=style[^"\n]+";\n/gu, ""),
            loader: "ts",
            resolveDir: dirname(args.path),
          };
        });
        builder.onLoad({ filter: /\.css$/ }, async args => {
          styles.push(await readFile(args.path, "utf8"));
          return { contents: "", loader: "js" };
        });
      },
    };
    const rendered = await build({
      entryPoints: [component],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      plugins: [compiler],
      external: ["astro/compiler-runtime"],
      define: { "import.meta.env": "{}" },
    });
    const code = rendered.outputFiles[0]!.text.replaceAll(
      '"astro/compiler-runtime"',
      JSON.stringify(new URL("../../../node_modules/astro/dist/runtime/compiler/index.js", import.meta.url).href),
    );
    const module = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
    const container = await AstroContainer.create({ resolve: async () => "/app.js" });
    const markup = await container.renderToString(module.default);
    const bundled: string[] = [];
    for (const [path, contents] of scripts) {
      for (const content of contents) {
        bundled.push(
          (
            await build({
              stdin: { contents: content, loader: "ts", resolveDir: dirname(path) },
              bundle: true,
              write: false,
              format: "iife",
              platform: "browser",
              define: { "import.meta.env": JSON.stringify({ PUBLIC_H0_LINK_JOIN: "0" }) },
            })
          ).outputFiles[0]!.text,
        );
      }
    }
    const scenarios = [
      "flag-off",
      "grant-and-remove",
      "pending-workspace-switch",
      "unresolved",
      "unknown-and-reauth",
    ];
    const testSource = await readFile(new URL(import.meta.url), "utf8");
    const ast = ts.createSourceFile("fixture.ts", testSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const fixtureFunction = (name: string) => {
      const found = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
      assert.ok(found, "test fixture function " + name);
      return found.getText(ast);
    };
    const compileFixture = async (name: string, extraPrefix = "") =>
      (
        await build({
          stdin: {
            contents: extraPrefix + fixtureFunction(name) + "\nvoid " + name + "();",
            loader: "ts",
            resolveDir: dirname(component),
          },
          bundle: true,
          write: false,
          platform: "browser",
          format: "iife",
        })
      ).outputFiles[0]!.text;
    const setup = "<script>" + (await compileFixture("installSeatAdminFixture")) + "</script>";
    const copySetupPrefix =
      'import { SEAT_ADMIN_NO_END_DATE_LINE, SEAT_ADMIN_ROLE_COPY } from "../../../../src/protocol/seat-admin-copy";\n' +
      "(window as any).__seatAdminCopyContract = { SEAT_ADMIN_NO_END_DATE_LINE, SEAT_ADMIN_ROLE_COPY };\n";
    const observation = "<script>" + (await compileFixture("observeSeatAdminApp", copySetupPrefix)) + "</script>";
    const app =
      "<!doctype html><html><head><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" +
      styles.join("\n") +
      "</style>" +
      setup +
      "</head><body>" +
      markup +
      observation +
      "</body></html>";

    const parent = () =>
      "<!doctype html><html><body><script>(async()=>{ const results=[]; try { for(const scenario of " +
      JSON.stringify(scenarios) +
      "){ const frame=document.createElement('iframe'); frame.style.width='1280px'; frame.style.height='900px'; const route = (scenario === 'unknown-and-reauth' || scenario === 'pending-workspace-switch') ? 'people&w=11111111-1111-4111-8111-111111111111' : 'catchup'; frame.src='/app?v='+route+'&case='+scenario; document.body.append(frame);" +
      "for(let i=0;i<1400;i++){const value=frame.contentDocument?.documentElement?.dataset?.seatAdminObservation;if(value){results.push(JSON.parse(value));document.documentElement.dataset.seatAdminResults=btoa(unescape(encodeURIComponent(JSON.stringify(results))));break;}await fetch('/__observer-tick');}" +
      "frame.remove();if(results.at(-1)?.scenario!==scenario||results.at(-1)?.error)break;} } catch (error) { results.push({ error: String(error) }); } finally { document.documentElement.dataset.seatAdminResults=btoa(unescape(encodeURIComponent(JSON.stringify(results)))); } })();</script></body></html>";

    const server = createServer((request, response) => {
      if (request.url === "/__observer-tick") {
        setTimeout(() => {
          response.writeHead(204);
          response.end();
        }, 2);
        return;
      }
      response.writeHead(200, { "Content-Type": request.url === "/app.js" ? "text/javascript" : "text/html" });
      response.end(
        request.url === "/app.js"
          ? bundled.join("\n")
          : request.url === "/app" || request.url?.startsWith("/app?")
          ? app
          : parent(),
      );
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const chrome = await findChrome();
      const { stdout } = await launchChrome(
        chrome,
        ["--virtual-time-budget=240000", "--dump-dom", "http://127.0.0.1:" + address.port + "/"],
        { timeout: 60000, maxBuffer: 10 * 1024 * 1024 },
      );
      const encoded = stdout.match(/data-seat-admin-results="([A-Za-z0-9+/=]+)"/)?.[1];
      assert.ok(encoded, "mounted app must finish seat-admin observations: " + stdout.slice(0, 1000));
      const results = JSON.parse(Buffer.from(encoded, "base64").toString());
      assert.equal(
        results.find((row: any) => row.error),
        undefined,
        JSON.stringify(results),
      );
      assert.deepEqual(
        results.map((row: any) => row.scenario),
        scenarios,
      );
    } finally {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
      }
    }
  },
);
