import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { setupSteps, setupProgress } from "../../lib/setup-checklist";
import { createLatestRead } from "../../lib/latest-read";
import { approvalUntil, accessRefusalMessage, withdrawRefusalMessage, PERSONAL_PURPOSE_WARNING } from "../../lib/household-access";
import { peopleDialogAccessUntil, peopleDialogCanAct, withdrawConfirmText } from "../../lib/people-dialog-view";
import { agentStatus, peopleAgentStatus } from "../../lib/agent-status";
import { classifyAgentPresence } from "../../../../src/cloud/agent-presence";
import { grantRiskBadge, STANDING_GRANT_COPY } from "../../lib/standing-grants";

/*
 * Source-level guards for the 2026-10-04 household redesign of /app (setup checklist, Add an
 * agent by app, Invite someone, Lists & docs access). Behaviour that needs a browser is covered
 * by the redesign's screenshot harness and the CI browser suites; these pin the contracts a
 * regex can honestly check.
 */
const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const peopleView = readFileSync(new URL("../../lib/people-dialog-view.ts", import.meta.url), "utf8");
const markup = dashboard.slice(0, dashboard.indexOf("<script>")).replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
const script = dashboard.slice(dashboard.indexOf("<script>"), dashboard.indexOf("</script>"));

const section = (source: string, start: string, end: string): string => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing anchor ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing anchor ${end}`);
  return source.slice(from, to);
};

test("every function the script calls from commonswarm.ts is imported (the Shared objects crash)", () => {
  /* The household wiring called postCommand without importing it, so the built page threw
     ReferenceError on opening Shared objects. Pin the import beside every use. */
  const importList = section(script, "import {\n    ClientTooOld", '} from "../../lib/commonswarm";');
  assert.match(script, /postCommand\(/);
  assert.match(importList, /\bpostCommand,/);
});

test("the zero-agent state is the setup checklist, with exactly one agent door and one person door", () => {
  const checklist = section(markup, "data-setup-checklist", "</section>");
  assert.equal([...checklist.matchAll(/data-add-agent(?=[\s>])/g)].length, 1);
  assert.equal([...checklist.matchAll(/data-invite-collaborator(?=[\s>])/g)].length, 1);
  assert.match(checklist, /data-setup-access/);
  for (const step of ["access", "agent", "invite"]) {
    assert.match(checklist, new RegExp(`data-setup-step="${step}"`));
  }
  assert.match(script, /import \{ setupProgress, setupSteps \} from "\.\.\/\.\.\/lib\/setup-checklist";/);
  assert.match(script, /const steps = setupSteps\(\{/);
});

test("person-facing redesign markup uses plain words, not protocol words", () => {
  const surfaces = [
    section(markup, "data-setup-checklist", "</section>"),
    section(markup, 'data-channel-view="invite"', "</section>"),
    section(markup, 'data-channel-view="objects"', "<HouseholdObjects"),
    section(markup, 'data-channel-view="agent-choice"', "</section>"),
  ].join("\n");
  /* Visible text only: drop tags (with their attributes) and template expressions, which carry
     hook names such as data-household-purpose that a person never reads. */
  let visible = surfaces.replace(/<[^>]*>/g, " ");
  // Template expressions nest ({list.map(... => {label})}); strip from the inside out.
  for (let previous = ""; previous !== visible;) {
    previous = visible;
    visible = visible.replace(/\{[^{}]*\}/g, " ");
  }
  assert.match(visible, /Choose who can use Lists &amp; docs/, "positive control: visible text survives the strip");
  assert.doesNotMatch(visible, /\b(seat|grant|claim|OAuth|MCP|signal|principal|purpose|content access)\b/i);
  // Control: the instrument fires on the retired sentence it replaced.
  assert.match("the workspace owner must choose Shared in content settings and confirm content access", /content access/i);
  assert.doesNotMatch(dashboard, /Before inviting someone to a household, the workspace owner must choose Shared/);
});

test("Lists & docs access is two described radio groups, generated from the enforced values", () => {
  const objects = section(markup, 'data-channel-view="objects"', "<HouseholdObjects");
  assert.doesNotMatch(objects, /<select\b/, "no bare select boxes");
  assert.match(objects, /\(\["shared", "personal"\] as const\)\.map\(\(purpose\) =>/);
  assert.match(objects, /PURPOSE_COPY\[purpose\]\.label/);
  assert.match(objects, /CONTENT_ROLES\.map\(\(role\) =>/);
  assert.match(objects, /CONTENT_ROLE_COPY\[role\]\.detail/);
  assert.match(script, /one<HTMLInputElement>\("\[data-household-purpose\]:checked"\)/);
  assert.match(script, /one<HTMLInputElement>\("\[data-household-role\]:checked"\)/);
  /* Only the owner chooses the purpose; the server refuses anyone else's first choice. */
  assert.match(script, /if \(purposeSet\) purposeSet\.hidden = viewerRole\(\) !== "owner";/);
});

test("approving an agent uses the independent server command without changing the person's role", () => {
  const approve = section(script, "const approveAgent = async (", "/** Withdrawal leaves");
  assert.match(approve, /kind: "household_approve_connection"/);
  assert.doesNotMatch(approve, /readHouseholdAccess|content_role|purpose|household_permissions/);
  assert.match(approve, /approvalUntil\(/);
  assert.match(approve, /await loadHouseholdConnections\(\)/);
  assert.match(script, /for \(const operation of CONTENT_OPERATIONS\)/);
  assert.match(script, /CONTENT_OPERATION_LABELS\[operation\]/);
});

test("every household result is dropped once its workspace, account, version or generation moved on", () => {
  /* R2 review: success and failure paths alike, including the shared Confirm button. */
  const current = section(script, "const householdCurrent = (scope: HouseholdScope): boolean =>", ";\n");
  for (const fact of ["scope.workspaceId === activeWorkspaceId", "session?.user.id === scope.session.user.id",
    "scope.version === requestVersion", "scope.generation === householdAccessGeneration"]) {
    assert.ok(current.includes(fact), `householdCurrent must check ${fact}`);
  }
  const load = section(script, "const loadHouseholdConnections = async", "/** Approve only the agent;");
  assert.match(load, /const ticket = connectionReads\.next\(\);/);
  assert.match(load, /\} catch \{\s*next = \[\];\s*\}\s*\/\/ Success and failure are both dropped once the scope moved on or a newer read started\.\s*if \(!connectionReads\.isLatest\(ticket\) \|\| !householdCurrent\(scope\)\) return;/);
  const confirm = section(script, "const confirmOwnAccess = async", "/** Open Lists & docs:");
  assert.match(confirm, /if \(button && token === householdConfirms\) button\.disabled = false;/);
  assert.match(confirm, /notice && householdCurrent\(scope\) && token === householdConfirms/);
  const refresh = section(script, "const refreshHouseholdAccess = async", "/** Show the access card");
  assert.match(refresh, /const ticket = accessReads\.next\(\);/);
  assert.match(refresh, /if \(!accessReads\.isLatest\(ticket\) \|\| !householdCurrent\(scope\)\) return;/);
  /* A workspace or account change retires every outstanding household read. */
  const reset = section(script, "const resetHouseholdSurface = (): void => {", "    };\n");
  assert.match(reset, /accessReads\.invalidate\(\);\s*connectionReads\.invalidate\(\);/);
});

test("the Add an agent poll runs only while its own host page is open, and stops on any change", () => {
  const watch = section(script, "const startHostJoinWatch = (): void => {", "    };\n");
  assert.match(watch, /const watch = hostJoinGeneration;/);
  assert.match(watch, /watch === hostJoinGeneration &&/);
  assert.match(watch, /version === requestVersion &&/);
  assert.match(watch, /workspaceId === activeWorkspaceId &&/);
  assert.match(watch, /app\.dataset\.channelView === "agent-choice"/);
  assert.match(watch, /15 \* 60_000/);
  assert.match(watch, /if \(!live\(\)\) return;/, "a reply from a replaced watch is ignored");
  const stop = section(script, "const stopHostJoinWatch = (): void => {", "    };\n");
  assert.match(stop, /hostJoinGeneration \+= 1;/);
  assert.match(script, /hostPicker\?\.addEventListener\("agent-host-selected", \(\) => startHostJoinWatch\(\)\);/);
  assert.match(script, /hostPicker\?\.addEventListener\("agent-host-back", \(\) => stopHostJoinWatch\(\)\);/);
});

/* The doors moved with People & agents from a dialog to a page (2026-10-07, the canvas Members
   artboard). Two doors still, built by the page, and Invite still opens the existing invite form. */
test("a person and an agent have separate doors on the People & agents page", () => {
  const page = section(peopleView, "if (page) {", "const select = ");
  assert.match(page, /data-people-page-add-agent|peoplePageAddAgent/);
  assert.match(page, /"Add an agent"/);
  assert.match(page, /peoplePageInvite/);
  assert.match(page, /"Invite someone"/);
  assert.match(script, /invite: \(\) => \{ void navigateHome\(\{ view: "chat", workspaceId: workspace.id \}, "push"\)\.then\(\(\) => openInvite\("channel"\)\); \}/);
});

test("creation asks for purpose without a default and states the owner's Editor access", () => {
  const create = readFileSync(new URL("../../lib/home-new-workspace.ts", import.meta.url), "utf8");
  assert.match(create, /legend: "Who is it for\?"/);
  assert.match(create, /input.type = "radio"/);
  assert.match(create, /input.checked = purposeChoices.value === option.value/);
  assert.match(create, /label: option.label/);
  assert.match(create, /Your access: \$\{CONTENT_ROLE_COPY.editor.label\}\. You can \$\{CONTENT_ROLE_COPY.editor.detail.charAt\(0\).toLowerCase\(\) \+ CONTENT_ROLE_COPY.editor.detail.slice\(1\)\}`/);
  assert.match(script, /detail: CREATE_PURPOSE_DETAILS\[purpose as HouseholdPurpose\]/);
  assert.match(create, /personalWarning.dataset.createPersonalWarning = ""/);
  assert.match(create, /personalWarning.setAttribute\("aria-live", "polite"\)/);
  assert.match(create, /personalWarning.textContent = newWorkspacePersonalWarning\(vm.purpose\)/);
  assert.match(script, /setCreateError\("Choose who can use Lists & docs here\."\)/);
  assert.match(script, /one<HTMLInputElement>\("\[data-create-purpose\]"\)\?\.focus\(\)/);
});

test("active approvals expose Save and withdrawal in both places, owned agents only in the dialog", () => {
  const cards = section(script, "const renderAgentApprovals", "const connectionReads");
  assert.match(cards, /input.checked = approval \? approval.operations.includes\(operation\) : true/);
  assert.match(cards, /allow.textContent = approval \? "Save" : "Allow"/);
  assert.match(cards, /withdraw.textContent = "Withdraw access"/);
  assert.match(cards, /approvalDescription\(approval\)/);
  const model = section(script, "const peopleDialogModel", "const syncPeopleDialogLayout");
  assert.match(model, /const own = Boolean\(me && agent.ownerUserId === me.userId && !sampleMode/);
  assert.match(peopleView, /"data-withdraw-agent-access"/);
  assert.match(peopleView, /"data-agent-error"|dataset.agentError/);
  assert.match(peopleView, /dataset.agentContentAccess/);
  assert.match(peopleView, /dataset.agentContentResult/);
  assert.match(peopleView, /"pd-quiet-link"/);
  assert.match(peopleView, /fact\("Lists & docs", accessFact, accessAction\)/,
    "withdrawal now belongs to the detail fact; the surface has only its quiet access indicator");
  assert.match(peopleView, /"Can use Lists & docs"/);
  assert.match(script, /withdrawAgent\(id, agent.name, button, notice, true\)/,
    "the dialog's nested confirmation suppresses the card's native confirmation");
  const withdraw = section(script, "const withdrawAgent = async", "const confirmOwnAccess = async");
  assert.match(withdraw, /window.confirm\(withdrawConfirmText\(agentName, /);
  assert.match(withdraw, /kind: "household_withdraw_connection", principal_id: principalId/);
  assert.match(withdraw, /withdrawRefusalMessage\(result.body.reason\)/);
  assert.match(withdraw, /await loadHouseholdConnections\(\)/);
  assert.match(markup, /A computer agent keeps it until its key ends or you withdraw it/);
  assert.match(markup, /Lists &amp; docs is not available through the Claude connector yet, so an agent in a chat app cannot use it/);
  /* Hosted rows show the note and keep controls only for an existing approval (withdraw stays reachable). */
  assert.match(cards, /connection.kind === "hosted"[\s\S]*?HOSTED_LISTS_NOTE[\s\S]*?if \(!approval\) \{ choices.hidden = true; allow.hidden = true; \}/);
  assert.doesNotMatch(markup, /24 hours|Three short steps/);
});

test("history reads removed identities separately and leaves the live roster unchanged", () => {
  const removed = section(script, "const removedAgentNames = async", "const roster = async");
  assert.match(removed, /if \(!api \|\| sampleMode\) return result/);
  assert.match(removed, /\.not\("revoked_at", "is", null\)/);
  assert.match(removed, /offset < 200/);
  const open = section(script, "const openWorkspace =", "const syncCreatePurposeWarning =");
  assert.match(open, /const removedAgentsRead = removedAgentNames\(selected.id\)/);
  assert.match(open, /const nextRemovedAgents = await removedAgentsRead;/);
  assert.match(open, /removedAgents = nextRemovedAgents/);
  assert.match(script, /removedAgentLabel\(name\)/);
  assert.match(script, /historicalAgentName\(signal.from\)/);
  assert.match(script, /historicalAgentName\(signal.toAgent\)/);
  assert.match(script, /historicalAgentName\(file.uploadedBy\)/);
});

// Execute the real component functions. Only I/O and DOM nodes are substituted; no test exports.
function execute(source: string, context: Record<string, unknown>): any {
  return runInNewContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022 }), context);
}

// Run the actual read and dialog projection together; only transport and unrelated UI are stubbed.
function dialogConnectionsFixture() {
  const ctx: any = {
    session: { user: { id: "person" } }, activeWorkspaceId: "workspace", sampleMode: false,
    members: [{ userId: "person", name: "Tom", role: "owner" }],
    agents: [{ principalId: "principal", name: "Muse", ownerUserId: "person", model: null, transport: "local" }],
    accessStatuses: [], pendingAgentsLoadFailed: false, people: new Map([["person", "Tom"]]),
    householdConnections: [], householdConnectionsReadState: "pending", householdReceipts: new Map(),
    peopleDialogReceipts: new Map(), identityRoster: () => ({ agents: [] }), identityDisplayLabel: (agent: any) => agent.name,
    workspaces: [{id:"workspace",name:"Home"}], agentStatus, peopleAgentStatus, classifyAgentPresence, grantRiskBadge, STANDING_GRANT_COPY,
    agentPresenceLine: () => null, wakePathMark: () => null, currentPendingAccessRows: () => [],
    formatTime: () => ({ relative: "just now" }), createLatestRead, uuid: () => "command-id",
    householdScope: () => ({ workspaceId: ctx.activeWorkspaceId, session: ctx.session }),
    householdCurrent: (scope: any) => scope.workspaceId === ctx.activeWorkspaceId && scope.session === ctx.session,
    renderAgentApprovals: () => {}, renderDialogRoster: () => {},
  };
  const source = section(script, "const connectionApproval =", "const approvalDescription =")
    + section(script, "const peopleDialogModel =", "const syncPeopleDialogLayout =")
    + section(script, "const connectionReads =", "/** Approve only the agent;");
  const funcs = execute(`${source}; ({ peopleDialogModel, loadHouseholdConnections });`, ctx);
  return { ctx, model: funcs.peopleDialogModel, load: funcs.loadHouseholdConnections };
}

test("dialog connection facts stay unknown until a successful owner-scoped read, including retries", async () => {
  const f = dialogConnectionsFixture();
  const currentAgent = () => f.model().agents[0];
  assert.equal(peopleDialogAccessUntil(currentAgent()), null, "first render has no approval answer");
  let answer: any = { status: 200, body: { status: "ok", connections: [] } };
  f.ctx.postCommand = async () => answer;
  await f.load();
  assert.equal(peopleDialogAccessUntil(currentAgent()), "Not allowed.");
  assert.equal(peopleDialogCanAct(f.model(), "allow", "principal"), true);
  const approval = { principal_id: "principal", approval: { operations: ["read"], expires_at: null } };
  answer = { status: 200, body: { status: "ok", connections: [approval] } };
  await f.load();
  assert.equal(peopleDialogAccessUntil(currentAgent()), "Allowed until you withdraw it.");
  assert.equal(peopleDialogCanAct(f.model(), "withdraw", "principal"), true);
  f.ctx.agents[0].ownerUserId = "someone-else";
  assert.equal(peopleDialogAccessUntil(currentAgent()), null);
  assert.equal(currentAgent().access, null, "another owner's agent has no indicator even with a cached row");
  f.ctx.agents[0].ownerUserId = "person";
  let reject: (error: Error) => void = () => {};
  f.ctx.postCommand = () => new Promise((_resolve, fail) => { reject = fail; });
  const loading = f.load();
  assert.equal(peopleDialogAccessUntil(currentAgent()), null, "refresh cannot reuse the old approval");
  assert.equal(currentAgent().access, null);
  reject(new Error("read failed"));
  await loading;
  assert.equal(peopleDialogAccessUntil(currentAgent()), null, "failed reads cannot assert denial");
  assert.equal(currentAgent().accessReadState, "failed");
  f.ctx.postCommand = async () => ({ status: 403, body: { status: "refused" } });
  await f.load();
  assert.equal(peopleDialogAccessUntil(currentAgent()), null, "refused reads are also unknown");
  f.ctx.postCommand = async () => ({ status: 200, body: { status: "ok" } });
  await f.load();
  assert.equal(peopleDialogAccessUntil(currentAgent()), null, "an incomplete response is not a successful empty read");
});

test("an ended timeboxed key offers removal and a new key but no turn-off alternative", () => {
  const f = dialogConnectionsFixture();
  const grant = { principalId: "principal", grantKind: "timeboxed", horizonExpiresAt: "2000-01-01T00:00:00Z", revokedAt: null, grantRevokedAt: null, lastUsedAt: null };
  f.ctx.accessStatuses = [grant];
  const ended = f.model();
  assert.equal(ended.agents[0].status.kind, "key-ended");
  assert.equal(ended.agents[0].liveKey, false, "Remove confirmation uses liveKey for its alternative");
  assert.equal(peopleDialogCanAct(ended, "turn-off-key", "principal"), false);
  assert.equal(peopleDialogCanAct(ended, "remove-agent", "principal"), true);
  assert.equal(peopleDialogCanAct(ended, "new-key", "principal"), true);
  grant.horizonExpiresAt = "2099-01-01T00:00:00Z";
  assert.equal(peopleDialogCanAct(f.model(), "turn-off-key", "principal"), true, "a future key can still be turned off");
  grant.grantKind = "standing";
  grant.horizonExpiresAt = "2000-01-01T00:00:00Z";
  assert.equal(peopleDialogCanAct(f.model(), "turn-off-key", "principal"), true, "standing keys have no horizon");
});

function creationFixture(outcome: "committed" | "refused" | "unknown", existing = false, storage = new Map<string, string>()) {
  const events: string[] = [], commands: any[] = [];
  const radios = [{ value: "shared", checked: false, disabled: false }, { value: "personal", checked: false, disabled: false }];
  const warning = { textContent: "" }, receipt = { hidden: true, textContent: "", dataset: {} };
  const session = { user: { id: "person" } };
  const ctx: any = {
    homeRoute: {view:"new"}, routeHref: () => "?w=workspace", focusHomeView: () => {},
    inviteOpens: [], openInvite: (origin: string) => ctx.inviteOpens.push(origin),
    PERSONAL_PURPOSE_WARNING, householdSetupNeeded: new Set(),
    window: { history: {pushState() {}}, localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    } },
    requestVersion: 1, householdAccessGeneration: 1, session, activeCreate: null, activeWorkspaceId: "", householdAccess: null,
    workspaces: existing ? [{ id: "workspace", name: "Home" }] : [],
    one: (selector: string) => selector === "[data-create-personal-warning]" ? warning
      : selector === "[data-create-purpose]:checked" ? radios.find(radio => radio.checked)
      : selector === "[data-channel-receipt]" ? receipt : null,
    all: () => radios, setCreateError: () => {},
    refreshHouseholdAccess: async () => { ctx.householdAccess = { status: outcome === "refused" ? "refused" : "unknown" }; },
    writeCreateIntent: (_user: string, value: any) => { ctx.saved = { ...value }; },
    clearCreateIntent: () => { events.push("clear"); ctx.saved = null; },
    rememberPurpose: (_workspace: string, purpose: string) => events.push(`remember:${purpose}`),
    createWorkspace: async () => { events.push("create"); return { workspaceId: "workspace", name: "Home" }; },
    postCommand: async (_session: any, id: string, body: any, envelope: any) => {
      events.push("permissions"); commands.push(JSON.parse(JSON.stringify({ id, body, envelope })));
      if (outcome === "unknown") throw new Error("network failure");
      return { status: 200, body: { status: outcome, reason: "owner_confirmation_required" } };
    },
    openWorkspace: async (id: string) => { events.push("open"); ctx.activeWorkspaceId = id; ctx.requestVersion++; ctx.householdAccessGeneration++; },
  };
  Object.assign(ctx, execute(`${section(script, "const householdSetupKey =", "let removedAgents =")}; ({ needsHouseholdSetup, setHouseholdSetupNeeded });`, ctx));
  const source = section(script, "const syncCreatePurposeWarning =", "/* THE SAMPLE ROSTER");
  const create = execute(`${source}; createFromIntent;`, ctx);
  return { ctx, create, events, commands, session, warning, radios, receipt, storage };
}

const createIntent = { workspaceId: "workspace", commandId: "create-id", permissionsCommandId: "permissions-id", name: "Home", purpose: "personal" };

test("creation records the chosen purpose before clearing or opening, and legacy intents skip permissions", async () => {
  const f = creationFixture("committed");
  await f.create(f.session, { ...createIntent });
  assert.deepEqual(f.events, ["create", "permissions", "remember:personal", "clear", "open"]);
  assert.deepEqual(f.commands, [{ id: "permissions-id", body: { kind: "household_permissions", purpose: "personal", content_role: "editor" }, envelope: { workspace_id: "workspace", stream: { kind: "workspace" } } }]);
  assert.equal(f.warning.textContent, PERSONAL_PURPOSE_WARNING);
  const old = creationFixture("committed");
  const { purpose, permissionsCommandId, ...legacy } = createIntent;
  await old.create(old.session, legacy);
  assert.deepEqual(old.events, ["create", "clear", "open"]);
});

test("submit retries permissions with the saved id; refusal and uncertain outcomes still open the workspace", async () => {
  for (const outcome of ["committed", "refused", "unknown"] as const) {
    const f = creationFixture(outcome, true);
    f.ctx.saved = { ...createIntent };
    await f.create(f.session, f.ctx.saved);
    assert.equal(f.events.includes("create"), false, "membership already proves creation");
    assert.equal(f.commands[0].id, "permissions-id");
    assert.equal(f.events.includes("open"), true);
    assert.equal(f.ctx.saved === null, outcome !== "unknown", "uncertain permissions keep the retry intent");
    if (outcome !== "committed") {
      assert.equal(f.receipt.textContent, "Your workspace is ready. Choose who can use Lists & docs in the steps below.");
      assert.equal(f.receipt.hidden, false);
      assert.equal(f.ctx.householdAccess.status, outcome === "refused" ? "refused" : "unknown");
    }
  }
});

test("a session change during creation permissions cannot clear the retry intent or open a workspace", async () => {
  const f = creationFixture("committed");
  let release: (value: unknown) => void = () => {};
  f.ctx.postCommand = () => new Promise(resolve => { release = resolve; });
  const pending = f.create(f.session, { ...createIntent });
  await Promise.resolve();
  f.ctx.session = { user: { id: "other-person" } };
  release({ status: 200, body: { status: "committed" } });
  await pending;
  assert.deepEqual(f.events, ["create"]);
});

test("the Just me warning is final, names the way out, and clears when Shared is selected", () => {
  const f = creationFixture("committed");
  const sync = execute(`${section(script, "const syncCreatePurposeWarning =", "/** Creation and its permissions")}; syncCreatePurposeWarning;`, { ...f.ctx });
  assert.match(PERSONAL_PURPOSE_WARNING, /cannot be changed later/);
  assert.match(PERSONAL_PURPOSE_WARNING, /create another workspace/);
  f.radios[1].checked = true; sync(); assert.equal(f.warning.textContent, PERSONAL_PURPOSE_WARNING);
  f.radios[1].checked = false; f.radios[0].checked = true; sync(); assert.equal(f.warning.textContent, "");
});

test("approval sends only connection consent, withdrawal uses the principal, and cancelled withdrawal sends nothing", async () => {
  const calls: any[] = [], messages: string[] = [], confirms: string[] = [], receipt = { textContent: "" };
  const scope = { workspaceId: "workspace", session: { user: { id: "person" } } };
  let current = true, confirm = true, reply: any = { status: "committed", expires_at: null };
  const ctx = {
    householdScope: () => scope, householdCurrent: () => current,
    postCommand: async (_session: any, _id: string, body: any, envelope: any) => {
      calls.push(JSON.parse(JSON.stringify({ body, envelope }))); return { status: 200, body: reply };
    },
    uuid: () => "command-id", approvalUntil, accessRefusalMessage, withdrawRefusalMessage, withdrawConfirmText,
    agents: [{ principalId: "principal", transport: "local" }],
    householdReceipts: new Map(), one: () => receipt,
    loadHouseholdConnections: async () => messages.push("reload"), window: { confirm: (text: string) => { confirms.push(text); return confirm; } },
  };
  const commands = execute(`${section(script, "const approveAgent = async", "/** The person's own access")}; ({ approveAgent, withdrawAgent });`, ctx);
  const connection = { kind: "hosted", connection_id: "connection", grant_id: "grant", principal_id: "principal" };
  const button = { disabled: false }, status = { textContent: "" };
  await commands.approveAgent(connection, ["read"], button, status);
  assert.deepEqual(calls[0].body, { kind: "household_approve_connection", connection: { ...connection, operations: ["read"] } });
  assert.equal(status.textContent, "Allowed until you withdraw it.");
  assert.deepEqual(messages, ["reload"]);
  assert.equal(receipt.textContent, "", "approval is announced only on its card");
  confirm = false;
  await commands.withdrawAgent("principal", "Muse", button, status);
  assert.equal(calls.length, 1);
  assert.deepEqual(confirms, [withdrawConfirmText("Muse", false)], "a local agent sees the local confirm text");
  confirm = true; reply = { status: "refused", reason: "connection_access_refused" };
  await commands.withdrawAgent("principal", "Muse", button, status);
  assert.equal(status.textContent, "Only the person who connected this agent can withdraw its Lists & docs access. Nothing was changed.");
  reply = { status: "committed", withdrawn: 1 };
  await commands.withdrawAgent("principal", "Muse", button, status);
  assert.deepEqual(calls[2].body, { kind: "household_withdraw_connection", principal_id: "principal" });
  assert.equal(status.textContent, "Withdrawn. Muse can no longer use Lists & docs here.");
  assert.equal(receipt.textContent, "", "withdrawal has no duplicate section receipt");
  assert.deepEqual(messages, ["reload", "reload"]);
  current = false;
  status.textContent = "other workspace";
  await commands.approveAgent(connection, ["read"], button, status);
  assert.equal(messages.length, 2, "stale committed replies do not reload the current workspace");
});

test("approval reads distinguish active permanent and local approvals from expired or missing ones", () => {
  const { read, describe } = execute(`${section(script, "const connectionApproval =", "/** One approval card")}; ({ read: connectionApproval, describe: approvalDescription });`, { approvalUntil });
  assert.equal(describe({ operations: ["read", "create", "update"], expires_at: null }), "Allowed until you withdraw it.");
  assert.equal(read({ approval: null }), null);
  assert.deepEqual(JSON.parse(JSON.stringify(read({ approval: { operations: ["read"], expires_at: null } }))), { operations: ["read"], expires_at: null });
  assert.ok(read({ approval: { operations: ["read"], expires_at: new Date(Date.now() + 60_000).toISOString() } }));
  assert.equal(read({ approval: { operations: ["read"], expires_at: new Date(0).toISOString() } }), null);
  assert.equal(read({ approval: { operations: ["read"] } }), null);
});

test("the real creation submit blocks a missing purpose, then reuses only matching name and purpose", async () => {
  const session = { user: { id: "person" } };
  let handler: (event: any) => Promise<void> = async () => {};
  let choice: string | undefined, saved: any = null, id = 0, focus = "", error = "";
  const creations: any[] = [];
  const ctx = {
    session, requestVersion: 1, activeCreate: null,
    one: (selector: string) => selector === "[data-create-form]" ? { addEventListener: (_event: string, callback: any) => { handler = callback; } }
      : selector === "#dashboard-workspace-name" ? { value: "Home" }
      : selector === "[data-create-purpose]:checked" ? choice ? { value: choice } : undefined
      : selector === "[data-create-purpose]" ? { focus: () => { focus = "purpose"; } } : undefined,
    setCreateError: (message: string) => { error = message; },
    readCreateIntent: () => saved,
    writeCreateIntent: (_user: string, intent: any) => { saved = JSON.parse(JSON.stringify(intent)); },
    createFromIntent: async (_session: any, intent: any) => { creations.push(JSON.parse(JSON.stringify(intent))); },
    uuid: () => `id-${++id}`,
  };
  handler = execute(section(script, 'const submitWorkspaceCreate =', 'for (const button of all<HTMLButtonElement>("[data-signout]"))') + '; submitWorkspaceCreate;', ctx);
  await handler({ preventDefault: () => {} });
  assert.equal(creations.length, 0);
  assert.equal(saved, null);
  assert.equal(error, "Choose who can use Lists & docs here.");
  assert.equal(focus, "purpose");
  choice = "shared";
  await handler({ preventDefault: () => {} });
  await handler({ preventDefault: () => {} });
  assert.deepEqual(creations[0], creations[1], "same name and purpose reuse all request ids");
  choice = "personal";
  await handler({ preventDefault: () => {} });
  assert.notEqual(creations[2].workspaceId, creations[1].workspaceId);
  assert.notEqual(creations[2].commandId, creations[1].commandId);
  assert.notEqual(creations[2].permissionsCommandId, creations[1].permissionsCommandId);
});

test("removed-agent reads stop at 200, soft-fail, and never query in sample mode", async () => {
  const ranges: number[][] = [], filters: any[] = [];
  let failure = false;
  const query: any = {
    schema: () => query, from: () => query, select: () => query,
    eq: (...args: any[]) => { filters.push(args); return query; },
    not: (...args: any[]) => { filters.push(args); return query; },
    order: () => query,
    range: async (start: number, end: number) => {
      ranges.push([start, end]);
      return failure ? { error: { code: "denied" } } : { data: Array.from({ length: end - start + 1 }, (_value, n) => ({ principal_id: `old-${start + n}`, name: "Muse" })) };
    },
  };
  const ctx = { client: () => query, sampleMode: false };
  const read = execute(`${section(script, "const removedAgentNames = async", "const roster = async")}; removedAgentNames;`, ctx);
  const names = await read("workspace");
  assert.equal(names.size, 200);
  assert.deepEqual(ranges, [[0, 99], [100, 199]]);
  assert.ok(filters.some(values => JSON.stringify(values) === JSON.stringify(["workspace_id", "workspace"])));
  assert.ok(filters.some(values => JSON.stringify(values) === JSON.stringify(["revoked_at", "is", null])));
  failure = true;
  assert.equal((await read("workspace")).size, 0);
  const before = ranges.length;
  ctx.sampleMode = true;
  assert.equal((await read("workspace")).size, 0);
  assert.equal(ranges.length, before);
});

// Keep the real creation, access-read and checklist render paths together: an outage after
// creation must leave a visible Choose action rather than merely record a failed status.
function attachAccessFixture(f: ReturnType<typeof creationFixture>) {
  const rows = ["access", "agent", "invite"].map(id => ({
    dataset: { setupStep: id }, hidden: false, querySelector: () => null,
  }));
  const progress = { textContent: "" };
  const root = { querySelectorAll: () => rows, querySelector: (selector: string) => selector === "[data-setup-progress]" ? progress : null };
  const originalOne = f.ctx.one;
  let answer: "ok" | "unknown" = "unknown";
  Object.assign(f.ctx, {
    one: (selector: string) => selector === "[data-setup-checklist]" ? root : originalOne(selector),
    app: { dataset: { channelView: "no-agents" } }, sampleMode: false,
    agents: [], members: [], pendingInvites: [], householdAccessRequestedFor: "workspace",
    householdAccess: { workspaceId: "workspace", status: "unknown", contentRole: null },
    viewerRole: () => "owner", setupSteps, setupProgress, accessReads: createLatestRead(),
    householdScope: () => ({ workspaceId: f.ctx.activeWorkspaceId, session: f.ctx.session }),
    householdCurrent: (scope: any) => scope.workspaceId === f.ctx.activeWorkspaceId && scope.session === f.ctx.session,
    readHouseholdAccess: async (scope: any) => ({ workspaceId: scope.workspaceId, status: answer, contentRole: answer === "ok" ? "editor" : null }),
    renderHouseholdAccess: () => {},
  });
  f.ctx.renderSetupChecklist = execute(`${section(script, "const renderSetupChecklist =", "/** Notice the agent")}; renderSetupChecklist;`, f.ctx);
  f.ctx.refreshHouseholdAccess = execute(`${section(script, "const refreshHouseholdAccess =", "/** Show the access card")}; refreshHouseholdAccess;`, f.ctx);
  return { rows, progress, succeed: () => { answer = "ok"; } };
}

function attachAgentReceiptFixture(f: ReturnType<typeof creationFixture>) {
  let handler: (event: any) => void = () => {};
  const timers: (() => void)[] = [];
  const originalOne = f.ctx.one;
  let receiptId = 0;
  Object.assign(f.ctx, {
    app: { ...f.ctx.app, addEventListener: (_name: string, callback: any) => { handler = callback; } },
    one: (selector: string) => selector === "agent-connect" ? {} : originalOne(selector),
    pendingWorkspaceId: "", pendingWorkspaceCreate: false, livePromptPrincipalId: "principal",
    accessStatuses: [], pendingAgents: [], pendingAgentsLoadFailed: false,
    syncConnectWorkspace: () => {}, returnToChannel: () => {},
    agentAccessStatuses: async () => [], loadPendingAccess: async () => ({ rows: [], failed: false }),
    pendingAgentAccess: async () => [], renderPendingAccess: () => {},
    uuid: () => `receipt-${++receiptId}`,
  });
  Object.assign(f.ctx.window, { setTimeout: (callback: () => void) => { timers.push(callback); }, requestAnimationFrame: () => {} });
  execute(section(script, 'app.addEventListener("commonswarm:agent-secret-cleared"', "const queueAuthReload ="), f.ctx);
  return { consumed: () => handler({ detail: { reason: "consumed" } }), timers };
}

test("an ok access read preserves the newer agent-connected receipt after failed setup", async () => {
  const f = creationFixture("unknown");
  const access = attachAccessFixture(f);
  const agent = attachAgentReceiptFixture(f);
  await f.create(f.session, { ...createIntent });
  assert.equal(f.receipt.dataset.setupWorkspaceId, "workspace");
  agent.consumed();
  access.succeed();
  await f.ctx.refreshHouseholdAccess();
  assert.equal(f.receipt.textContent, "Agent connected. Its one-time prompt has been cleared.");
  assert.equal(f.receipt.hidden, false);
  assert.equal(f.receipt.dataset.setupWorkspaceId, undefined);
  agent.timers[0]();
  assert.equal(f.receipt.hidden, true, "the timer still hides the receipt it owns");
});

test("an older agent receipt timer cannot hide a newer connection or creation setup receipt", async () => {
  const f = creationFixture("unknown");
  attachAccessFixture(f);
  const agent = attachAgentReceiptFixture(f);
  await f.create(f.session, { ...createIntent });
  agent.consumed();
  agent.consumed();
  agent.timers[0]();
  assert.equal(f.receipt.hidden, false, "the second connection owns its own six seconds");
  await f.create(f.session, { ...createIntent });
  assert.equal(f.receipt.dataset.setupWorkspaceId, "workspace");
  const setupText = f.receipt.textContent;
  agent.timers[1]();
  assert.equal(f.receipt.textContent, setupText);
  assert.equal(f.receipt.hidden, false, "setup remains visible after the older connection timer fires");
});

test("failed creation plus an unknown access read keeps Choose visible, then ok clears the step and receipt", async () => {
  for (const outcome of ["refused", "unknown"] as const) {
    const f = creationFixture(outcome);
    const access = attachAccessFixture(f);
    await f.create(f.session, { ...createIntent });
    await f.ctx.refreshHouseholdAccess();
    assert.equal(f.ctx.householdAccess.status, "unknown", "outage also affects the follow-up access read");
    assert.equal(access.rows[0].hidden, false, "Choose stays available after failed creation permissions");
    assert.equal(access.progress.textContent, "0 of 3 done");
    assert.equal(f.receipt.hidden, false);
    // The failure belongs to the original account/workspace only.
    f.ctx.activeWorkspaceId = "other-workspace";
    f.ctx.renderSetupChecklist();
    assert.equal(access.rows[0].hidden, true);
    f.ctx.activeWorkspaceId = "workspace";
    f.ctx.session = { user: { id: "other-person" } };
    f.ctx.renderSetupChecklist();
    assert.equal(access.rows[0].hidden, true);
    f.ctx.session = f.session;
    access.succeed();
    await f.ctx.refreshHouseholdAccess();
    assert.equal(access.rows[0].hidden, true);
    assert.equal(access.progress.textContent, "0 of 2 done");
    assert.equal(f.receipt.textContent, "");
    assert.equal(f.receipt.hidden, true);
    // A later unknown read does not revive a settled setup failure.
    f.ctx.householdAccess.status = "unknown";
    f.ctx.renderSetupChecklist();
    assert.equal(access.rows[0].hidden, true);
  }
});

test("boot resumes permissions once with the saved id and clears failed intents; legacy intent sends nothing", async () => {
  const branch = section(script, "        const pending = readCreateIntent(session.user.id);\n        if (pending && workspaces.some", "        /* ?w=");
  for (const outcome of ["committed", "refused", "unknown"] as const) {
    const f = creationFixture(outcome, true);
    f.ctx.saved = { ...createIntent };
    Object.assign(f.ctx, { readCreateIntent: () => f.ctx.saved, createFromIntent: f.create });
    const bootResume = execute(`(async () => { ${branch} });`, f.ctx);
    await bootResume();
    assert.equal(f.commands.length, 1);
    assert.equal(f.commands[0].id, "permissions-id");
    assert.equal(f.events.includes("create"), false);
    assert.equal(f.events.includes("open"), true);
    assert.equal(f.ctx.saved, null, "boot consumes even an unknown outcome");
    // A fresh page has no retry intent: it reads only the setup reminder.
    const nextPage = creationFixture("committed", true, f.storage);
    const checklist = attachAccessFixture(nextPage);
    nextPage.ctx.activeWorkspaceId = "workspace";
    await nextPage.ctx.refreshHouseholdAccess();
    assert.equal(checklist.rows[0].hidden, outcome === "committed", "failed boot setup remains available through a later unknown read");
    assert.equal(nextPage.commands.length, 0);
    checklist.succeed();
    await nextPage.ctx.refreshHouseholdAccess();
    assert.equal(nextPage.ctx.needsHouseholdSetup("person", "workspace"), false);
    await bootResume();
    assert.equal(f.commands.length, 1, "a later page load cannot replay a persistent failure");
  }
  const old = creationFixture("committed", true);
  const { purpose, permissionsCommandId, ...legacy } = createIntent;
  old.ctx.saved = legacy;
  Object.assign(old.ctx, { readCreateIntent: () => old.ctx.saved, createFromIntent: old.create });
  await execute(`(async () => { ${branch} });`, old.ctx)();
  assert.equal(old.ctx.saved, null);
  assert.equal(old.commands.length, 0);
  assert.deepEqual(old.events, ["clear"]);
});

test("workspace change clears only the creation setup receipt and retires known connection facts", () => {
  const receipt = { dataset: { setupWorkspaceId: "workspace" }, textContent: "Your workspace is ready.", hidden: false };
  const ctx = {
    one: (selector: string) => selector === "[data-channel-receipt]" ? receipt : null,
    all: () => [], householdDashboard: null, householdConnections: [], householdReceipts: new Map(), removedAgents: new Map(), removedAgentOwners: new Map([["old-agent", "person"]]),
    householdConnectionsReadState: "succeeded",
    householdAccessGeneration: 1, householdAccessRequestedFor: "workspace", householdAccess: null,
    accessReads: createLatestRead(), connectionReads: createLatestRead(), stopHostJoinWatch: () => {},
  };
  const reset = execute(`${section(script, "const resetHouseholdSurface =", "const openWorkspace =")}; resetHouseholdSurface;`, ctx);
  reset();
  assert.equal(receipt.textContent, "");
  assert.equal(receipt.hidden, true);
  assert.equal(receipt.dataset.setupWorkspaceId, undefined);
  assert.equal(ctx.householdConnectionsReadState, "pending");
  assert.equal(ctx.removedAgentOwners.size, 0, "past-agent ownership is workspace scoped");
  receipt.textContent = "Agent connected."; receipt.hidden = false;
  reset();
  assert.equal(receipt.textContent, "Agent connected.");
  assert.equal(receipt.hidden, false);
});


test("new shared workspaces open chat and the invite door once; personal and resumed creates do not", async () => {
  const shared = creationFixture("committed");
  await shared.create(shared.session, {...createIntent,purpose:"shared"});
  assert.deepEqual(JSON.parse(JSON.stringify(shared.ctx.homeRoute)),{view:"chat",workspaceId:"workspace"});
  assert.deepEqual(shared.ctx.inviteOpens,["channel"]);
  await shared.create(shared.session, {...createIntent,purpose:"shared"});
  assert.deepEqual(shared.ctx.inviteOpens,["channel"], "retrying the same workspace does not reopen the invite door");
  for (const [purpose,resume] of [["personal",false],["shared",true]] as const) {
    const f=creationFixture("committed"); await f.create(f.session,{...createIntent,purpose},resume);
    assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.homeRoute)),{view:"chat",workspaceId:"workspace"});assert.deepEqual(f.ctx.inviteOpens,[]);
  }
});
