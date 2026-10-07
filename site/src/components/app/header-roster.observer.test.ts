import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/*
 * Observer for the workspace-header agent roster, dialog model. Source-anchored like the
 * other app observers: it reads LiveDashboard.astro and asserts the mechanisms, not a
 * render. Picked up by site `npm test` through the observer glob in site package.json.
 *
 * Governing ruling (Lead7, 2026-07-30): the agent roster moves OUT of the rail into a
 * Slack-style header stack button that opens an accessible dialog (responsive sheet at
 * mobile widths). The rail keeps workspace switching, account, and details only, and must
 * not grow with agent count.
 */
const dashboard = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const shell = await readFile(new URL("../../lib/home-shell.ts", import.meta.url), "utf8");
const rail = await readFile(new URL("../../lib/home-rail.ts", import.meta.url), "utf8");
const homeShellCss = await readFile(new URL("../../styles/home/shell.css", import.meta.url), "utf8");
const integration = await readFile(new URL("../../styles/home/integration.css", import.meta.url), "utf8");
const view = await readFile(new URL("../../lib/people-dialog-view.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../../lib/home-route.ts", import.meta.url), "utf8");
const peopleCss = await readFile(new URL("../../styles/home/people.css", import.meta.url), "utf8");
const connect = await readFile(
  new URL("../connect/AgentConnect.astro", import.meta.url),
  "utf8",
);

test("the rail carries the nested people list without management doors or legacy collapse sync", () => {
  assert.doesNotMatch(
    dashboard,
    /data-agent-list/,
    "the rail's full agent list is superseded by the header dialog",
  );
  assert.doesNotMatch(dashboard, /data-add-agent-rail/);
  assert.doesNotMatch(dashboard, /rail-mobile-summary/);
  assert.doesNotMatch(
    dashboard,
    /narrowRail|syncAgentRail/,
    "nothing remains that needs collapsing on narrow screens",
  );
  assert.doesNotMatch(
    dashboard,
    /Workspace and agent navigation/,
    "the rail's accessible name went stale when agents moved to the header — it must not return",
  );
  assert.match(dashboard, /aria-label="Home navigation"/);
  assert.match(rail, /peopleList.dataset.sidebarParticipantList/);
  assert.doesNotMatch(rail, /data-add-agent|data-remove-agent|data-resume/);
});

/* ~~"the header control is one stack button with a dialog relationship"~~ (aria-haspopup="dialog",
   aria-controls="dashboard-roster-dialog", aria-expanded), retired 2026-10-07 by the home visual lane:
   People & agents is a PAGE now (the canvas Members artboard, route `?v=people`). A door that
   navigates must not claim a popup, so the claim is pinned ABSENT and the page relationship is
   pinned instead: the door is the current page while the page shows. */
test("the header control is one stack button that opens the People & agents page", () => {
  assert.match(dashboard, /buildWorkspaceHeader\(document, vm, callbacks\)/);
  assert.match(shell, /people.dataset.rosterOpen/);
  assert.doesNotMatch(shell, /aria-haspopup", "dialog"/, "a door to a page is not a popup");
  assert.match(route, /view: "people"; workspaceId: string \| null/);
  assert.match(dashboard, /navigateHome\(\{ view: "people", workspaceId \}, "push"\)/);
  assert.match(shell, /"People & agents"/);
  assert.match(shell, /people.addEventListener\("click", \(\) => callbacks.openPeople\(\)\)/);
  assert.match(shell, /compactCapsules\(doc, vm.people, 2\)/);
  assert.match(shell, /buildPhoneTopBar/);
  assert.doesNotMatch(dashboard, /aria-controls", "dashboard-roster-dialog"/);
  assert.match(dashboard, /if \(homeRoute.view === "people"\) button.setAttribute\("aria-current", "page"\)/);
});

test("pending access keeps the header management door reachable before the first agent", () => {
  // A real workspace always keeps the door, even with no agents or a failed pending read.
  assert.match(shell, /people: !vm.sample/);
  assert.match(shell, /if \(doors.people\)/);
  assert.match(dashboard, /openPeople: \(\) => openRosterDialog\(\)/);
  assert.match(dashboard, /buildPhoneTopBar\(document, vm, callbacks\)/);
  const header = dashboard.slice(dashboard.indexOf("const renderHeaderRoster ="), dashboard.indexOf("const renderDialogRoster ="));
  assert.match(header, /pendingTotal[^\n]*pending access/);
  assert.match(header, /button.textContent = `People & agents\$\{pendingTotal \? ` · \$\{pendingTotal\} pending` : ""\}`/);
  assert.match(header, /all<HTMLButtonElement>\("\[data-roster-open\]"\)/);
  const pending = dashboard.slice(dashboard.indexOf("const renderPendingAccess ="), dashboard.indexOf("const signalPage ="));
  assert.match(pending, /renderHeaderRoster\(total\);/);
});

test("agent avatars keep one shape and one tint mechanism", () => {
  assert.doesNotMatch(
    dashboard,
    /avatarShape|data-avatar-shape/,
    "mixed border-radii on identical initial tiles read as inconsistency, not identity",
  );
  assert.match(dashboard, /dashboard__avatar--tinted/);
  assert.match(dashboard, /--avatar-hue/);
});

/* ~~"management lives in a dialog whose first primary action is Add an agent"~~, retired
   2026-10-07: Members.dc.html puts the two doors beside the page title, Invite someone as the
   dark primary and Add an agent as the outlined secondary, then the filter, then the roster. */
test("management lives on the page: the two doors beside the title, then filter, then roster", () => {
  const page = view.slice(view.indexOf("if (page) {"), view.indexOf("const select = "));
  const invite = page.indexOf("Invite someone"), add = page.indexOf("Add an agent");
  const search = page.indexOf("pd-page-search"), columns = page.indexOf("pd-page-columns");
  assert.ok(invite > 0 && add > invite && search > add && columns > search,
    "the doors come first, then the filter, then the roster columns");
  assert.match(page, /button\(doc, "Invite someone", \(\) => nav.invite\?\.\(\), "pd-page-primary"\)/);
  assert.match(page, /link\(doc, "Add an agent", nav.addAgentHref, "pd-page-secondary", nav.navigate\)/);
  assert.match(page, /nav.addAgentHref && !model.sample/, "sample mode never shows an Add door that cannot mint");
  assert.match(dashboard, /layout: "page"/);
  assert.match(dashboard, /addAgentHref: routeHref\(\{ view: "add-agent", workspaceId: workspace.id \}\)/);
  assert.match(dashboard, /rosterFilter/);
  assert.match(view, /"data-remove-agent"/);
  assert.match(dashboard, /data-agent-error/);
});

test("Get prompt is own-agent only and reuses the existing prompt copy path", () => {
  const roster = dashboard.slice(
    dashboard.indexOf("const renderDialogRoster ="),
    dashboard.indexOf("const openRosterDialog ="),
  );
  assert.match(dashboard, /const own = Boolean\(me && agent\.ownerUserId === me\.userId && !sampleMode/,
    "another member's agent must never receive a new key action");
  assert.match(view, /"data-get-agent-prompt"/);
  assert.match(view, /"Get a new key"/);
  assert.match(roster, /requestPromptFor\(id\)/,
    "the real prompt flow receives the selected principal");

  const request = connect.slice(
    connect.indexOf("requestPromptFor(principalId"),
    connect.indexOf("finishPrompt(reason"),
  );
  const mint = connect.slice(
    connect.indexOf("async #mintGuarded()"),
    connect.indexOf("#watchForFirstUse"),
  );
  const copy = connect.slice(
    connect.indexOf("async #copy()"),
    connect.indexOf("\n  }\n\n  if (!customElements"),
  );
  assert.match(request, /#requestedPrincipalId = principalId/);
  assert.match(connect, /this\.#agents\.find\(\(agent\) => agent\.principalId === principalId\)/);
  assert.match(connect, /select\.value = identity\.principalId/);
  assert.match(mint, /mintAgentCredential\([\s\S]*identity/);
  assert.match(mint, /const promptInput = \{[\s\S]*credential[\s\S]*this\.#prompt = dashboardAgentPrompt\(promptInput\)/);
  assert.match(copy, /navigator\.clipboard\.writeText\(this\.#prompt\)/);
});

/* ~~"the dialog is modal with Escape, backdrop, close, and focus handling"~~, retired 2026-10-07:
   the page is not modal. What stays: confirmations are native modal alertdialogs, Back returns to
   where the reader came from, Escape closes an open details column, arrival focuses the page title
   (or the requested details), and focus after a removal reload lands on a real control. */
test("the page has Back, Escape for details, modal confirmations, and focus on arrival", () => {
  assert.match(view, /confirm\.showModal\(\)/, "a destructive confirmation is still a modal alertdialog");
  assert.match(dashboard, /<dialog class="pd-confirm" data-people-confirm role="alertdialog"/);
  assert.match(dashboard, /back: \(\) => homeBack\(\)/);
  assert.match(route, /route.view === "people"\) return \{ view: "chat", workspaceId: route.workspaceId \}/, "Back without history returns to the workspace");
  assert.match(dashboard, /event.key !== "Escape" \|\| homeRoute.view !== "people" \|\| !peopleDialogState.selected/);
  assert.match(dashboard, /\(peopleDialogFocus \? one<HTMLElement>\("#pd-detail-title"\) : null\)\s*\?\? one<HTMLElement>\("#pd-page-title"\)/);
  assert.match(
    dashboard,
    /one<HTMLButtonElement>\("\[data-roster-open\]"\)[\s\S]*?focus\(\{ preventScroll: true \}\)/,
    "after a cancel reload, focus lands back on the door that opened the flow",
  );
});

test("the dialog cannot outlive its workspace or session", () => {
  const openWorkspace = dashboard.slice(
    dashboard.indexOf("const openWorkspace ="),
    dashboard.indexOf("const openAgentChoice ="),
  );
  assert.match(openWorkspace, /closeRosterDialog\(\)/);
  const signout = dashboard.slice(
    dashboard.indexOf('for (const button of all<HTMLButtonElement>("[data-signout]"))'),
    dashboard.indexOf(
      'one<HTMLButtonElement>("[data-add-agent]")?.addEventListener("click", openAgentChoice)',
    ),
  );
  assert.match(signout, /resetWorkspaceSessionState\(\)/);
  const reset = dashboard.slice(
    dashboard.indexOf("const resetWorkspaceSessionState ="),
    dashboard.indexOf("armLiveFeed =", dashboard.indexOf("const resetWorkspaceSessionState =")),
  );
  assert.match(reset, /closeRosterDialog\(\)/);
});

/* ~~"the dialog is a bottom sheet at mobile widths"~~, retired 2026-10-07: the page is the route
   pane at every width, and its roster and side columns wrap to one column on a phone. */
test("the page wraps to one column on a phone", () => {
  assert.match(peopleCss, /section\.pd-page\[data-people-page\] \.pd-page-columns \{ display: flex; flex-wrap: wrap;/);
  assert.match(integration, /\.hm-frame--people \.hm-route-pane \{ padding: 20px clamp\(16px, 3vw, 40px\) 56px; \}/);
});

/* UI-SPEC 1.1 uses a phone top bar, an in-flow channel menu and bottom navigation.
   Preserve the compact header, tappable doors, accessible title and bounded composer. */
test("the narrow shell keeps a top bar, channel menu and bottom links above the bounded composer", () => {
  assert.match(dashboard, /buildPhoneTopBar\(document, vm, callbacks\)/);
  assert.match(dashboard, /buildWorkspaceNav\(document, vm, callbacks, "phone"\)/);
  assert.match(integration, /max-block-size: 100dvh/);
  assert.match(integration, /\.hm-frame__main.*min-block-size: 0/);
  assert.match(integration, /\[data-home-channel-menu\].*pointer-events: auto/);
  assert.match(shell, /anchor.setAttribute\("aria-current", "page"\)/);
  assert.match(integration, /clip-path: inset\(50%\)/);
  assert.doesNotMatch(integration, /channel-menu[^}]*display: none/);
  const shellCss = homeShellCss;
  assert.match(shellCss, /\.hm-phone-bar__people.*max-inline-size: 40vw/);
  assert.match(shellCss, /\.hm-channel-menu__label.*white-space: nowrap/);
  assert.doesNotMatch(dashboard, /\.dashboard__channel(?:--roster)? \.dashboard__channel-body\s*\{[\s\S]*min-block-size:\s*calc\(100svh/);
});

test("unknown agent-authored signals trigger a bounded roster refresh", () => {
  assert.match(
    dashboard,
    /signal\.fromKind === "agent" &&\s*!knownAgents\.has\(signal\.from\)/,
    "a new agent's first signal is the join event the roster learns from",
  );
  assert.match(dashboard, /rosterRefreshInFlight/);
  assert.match(
    dashboard,
    /Date\.now\(\) - rosterRefreshAttemptedAt < 10_000/,
    "a failing roster refresh must not retry on every two-second poll",
  );
  assert.match(dashboard, /void refreshRosterForUnknownAgents/);
  assert.match(
    dashboard,
    /feedPush\.arm\(\)/,
    "the live feed still arms a timer; fallback cadence is FEED_POLL_MS",
  );
});

/*
 * Release blocker (Lead7, 2026-07-30): after a Remove, the revoked principal is absent
 * from roster() but its immutable recent signals stay in every latest feed page, so an
 * unaware catch-up refetches roster+member every cooldown forever. The catch-up must be
 * principal-aware: only a SUCCESSFUL fetch may settle a principal, only principals still
 * absent from that fetch settle, a failure settles and drains nothing, and a workspace
 * switch clears both sets.
 */
test("roster catch-up is principal-aware: settle confirmed-absent, retry failed, reset on switch", () => {
  assert.match(
    dashboard,
    /!settledUnknownAgents\.has\(signal\.from\)/,
    "a settled (confirmed revoked/historical) principal must not re-trigger",
  );
  assert.match(
    dashboard,
    /if \(unknownAgentCandidates\.size > 0\)/,
    "queued candidates drive the attempt; the cooldown inside bounds it",
  );
  const refresh = dashboard.slice(
    dashboard.indexOf("const refreshRosterForUnknownAgents ="),
    dashboard.indexOf("const renderChannel ="),
  );
  assert.match(refresh, /const candidates = \[\.\.\.unknownAgentCandidates\]/);
  assert.match(
    refresh,
    /for \(const principalId of \[\.\.\.unknownAgentCandidates\]\) \{[\s\S]*if \(rosterIds\.has\(principalId\)\) unknownAgentCandidates\.delete\(principalId\)/,
    "principals queued during the flight and present in the fresh roster are pruned, not refetched",
  );
  assert.match(
    refresh,
    /unknownAgentCandidates\.delete\(principalId\);[\s\S]*if \(!rosterIds\.has\(principalId\)\) settledUnknownAgents\.add\(principalId\)/,
    "only a successful fetch may settle, and only captured principals still absent from it",
  );
  const catchBlock = refresh.slice(
    refresh.indexOf("} catch {"),
    refresh.indexOf("} finally {"),
  );
  assert.doesNotMatch(
    catchBlock,
    /settledUnknownAgents\.add|unknownAgentCandidates\.delete/,
    "a failed refresh settles and drains nothing — it stays retryable after the cooldown",
  );
  const openWorkspace = dashboard.slice(
    dashboard.indexOf("const openWorkspace ="),
    dashboard.indexOf("const openAgentChoice ="),
  );
  assert.match(openWorkspace, /unknownAgentCandidates\.clear\(\)/);
  assert.match(openWorkspace, /settledUnknownAgents\.clear\(\)/);
});

test("the catch-up state machine: no repeat after absent confirmation, retry after failure", () => {
  /* A pure model of the rules the regexes above pin to the real source, in the same
     spirit as the pagination model in dashboard-runtime.observer.test.ts. */
  const simulate = (
    fetchOutcomes: Array<"ok-absent" | "ok-present" | "fail">,
    polls: number,
  ): number => {
    const known = new Set<string>();
    const candidates = new Set<string>();
    const settled = new Set<string>();
    let attemptedAt = Number.NEGATIVE_INFINITY;
    let fetches = 0;
    let outcomeIx = 0;
    for (let poll = 0; poll < polls; poll++) {
      const now = poll * 2_000;
      /* Every page carries one historical signal from the revoked principal. */
      if (
        !known.has("revoked-1") &&
        !settled.has("revoked-1") &&
        !candidates.has("revoked-1")
      ) {
        candidates.add("revoked-1");
      }
      if (candidates.size === 0) continue;
      if (now - attemptedAt < 10_000) continue;
      attemptedAt = now;
      fetches++;
      const outcome = fetchOutcomes[Math.min(outcomeIx++, fetchOutcomes.length - 1)];
      if (outcome === "fail") continue; /* settles and drains nothing */
      candidates.delete("revoked-1");
      if (outcome === "ok-absent") settled.add("revoked-1");
      else known.add("revoked-1"); /* present in the fresh roster: now known */
    }
    return fetches;
  };
  assert.equal(
    simulate(["ok-absent"], 20),
    1,
    "a confirmed-absent principal must not be refetched every cooldown",
  );
  assert.equal(
    simulate(["ok-present"], 20),
    1,
    "a genuinely joined principal is fetched once and becomes known",
  );
  assert.equal(
    simulate(["fail", "fail", "ok-absent"], 20),
    3,
    "failed refreshes stay retryable after each cooldown until one succeeds",
  );

  /* Coalescing (Lead7 #18166): "new-2" first signals while the fetch for "old-1" is in
     flight, and the completed fetch's roster already contains it. It must be pruned from
     the queue — never settled, never refetched after the cooldown. */
  const simulateCoalesce = (): number => {
    const known = new Set<string>();
    const candidates = new Set<string>();
    const settled = new Set<string>();
    let attemptedAt = Number.NEGATIVE_INFINITY;
    let fetches = 0;
    let inFlight = false;
    let completesAt = -1;
    let captured: string[] = [];
    for (let poll = 0; poll < 20; poll++) {
      const now = poll * 2_000;
      for (const [principal, since] of [["old-1", 0], ["new-2", 1]] as const) {
        if (
          poll >= since &&
          !known.has(principal) &&
          !settled.has(principal) &&
          !candidates.has(principal)
        ) {
          candidates.add(principal);
        }
      }
      /* The one fetch takes a full poll, so "new-2" queues DURING its flight. */
      if (inFlight && poll >= completesAt) {
        const rosterIds = new Set(["old-1", "new-2"]);
        for (const principalId of [...candidates]) {
          if (rosterIds.has(principalId)) {
            candidates.delete(principalId);
            known.add(principalId); /* present in the fresh roster */
          }
        }
        for (const principalId of captured) {
          candidates.delete(principalId);
          if (!rosterIds.has(principalId)) settled.add(principalId);
          else known.add(principalId);
        }
        inFlight = false;
        continue;
      }
      if (candidates.size === 0 || inFlight) continue;
      if (now - attemptedAt < 10_000) continue;
      attemptedAt = now;
      fetches++;
      inFlight = true;
      captured = [...candidates];
      completesAt = poll + 1;
    }
    return fetches;
  };
  assert.equal(
    simulateCoalesce(),
    1,
    "a principal queued during the flight and present in the fetch is pruned, not refetched",
  );
});
