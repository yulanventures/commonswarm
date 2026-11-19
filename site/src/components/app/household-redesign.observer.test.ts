import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { setupSteps, setupProgress } from "../../lib/setup-checklist";
import { createLatestRead } from "../../lib/latest-read";
import { approvalUntil, accessRefusalMessage, withdrawRefusalMessage, PERSONAL_PURPOSE_WARNING, CONTENT_OPERATIONS, CONTENT_OPERATION_LABELS, APPROVAL_CHOICE_LABELS, READ_ACCESS_INCLUDED, householdAccessChoice, householdConfirmLabel, householdDecisionKey } from "../../lib/household-access";
import { peopleDialogAccessUntil, peopleDialogCanAct, renderPeopleDialog, showPeopleConfirmation } from "../../lib/people-dialog-view";
import { peopleInvites } from "../../lib/people-invites";
import { homeConnectionAccess, homeConnectionPolicy, homeConnectionTokenMatches } from "../../lib/home-map";
import { HOSTED_LISTS_NOTE } from "../../lib/hosted-lists-note";
import { agentStatus, peopleAgentStatus } from "../../lib/agent-status";
import { classifyAgentPresence } from "../../../../src/cloud/agent-presence";
import { grantRiskBadge, STANDING_GRANT_COPY, connectionPolicyCopy, connectionPolicyState, renewalGrantEnded } from "../../lib/standing-grants";

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

test("the Lists & docs access card has no lead paragraph, a named agents group, and a button that names the change", () => {
  const card = section(markup, "data-household-consent", "</form>");
  assert.doesNotMatch(card, /dashboard__access-lead|Confirm your access to Lists/);
  // Three separate, named choices: who can use it (from PURPOSE_QUESTION), your access, your agents.
  assert.deepEqual([...card.matchAll(/<legend>([^<]+)<\/legend>/g)].map(match => match[1]), ["{PURPOSE_QUESTION}", "Your access", "Your agents"]);
  assert.match(card, /<input type="checkbox" data-household-allow-own-agents checked \/>/, "the agents choice keeps its default");
  assert.doesNotMatch(card, /data-household-(purpose|role)[^>]*\bchecked\b/, "who and which access are never preselected");
  // The button starts with the neutral label; the script writes the rest from what will be sent.
  const button = section(card, "data-household-confirm", "</button>");
  assert.match(button, /<span data-household-confirm-label>Turn on Lists &amp; docs<\/span>/);
  assert.doesNotMatch(button, /\bConfirm\b/);
  // One reader of the form feeds both the command and the label, so they cannot disagree.
  const confirm = section(script, "const confirmOwnAccess = async", "const openHouseholdView = async");
  assert.match(confirm, /const \{ purpose, role \} = householdChoice\(\);\s*if \(!purpose \|\| !role\) \{/);
  // A press is checked against the decision the button was showing; a stale one redraws and sends nothing.
  assert.match(confirm, /const shown = label\?\.dataset\.decision;\s*syncHouseholdConsentRole\(\);\s*if \(label && shown !== label\.dataset\.decision\) \{[\s\S]*?return;\s*\}\s*const owner = viewerRole\(\) === "owner";\s*const \{ purpose, role \}/);
  assert.match(confirm, /\{ kind: "household_permissions", purpose, content_role: role \}/);
  assert.doesNotMatch(confirm, /data-household-(purpose|role)/, "confirm reads the form only through householdChoice");
  const sync = section(script, "const syncHouseholdConfirmLabel =", "const resetHouseholdSurface =");
  assert.match(sync, /label\.textContent = householdConfirmLabel\(owner, choice\);/);
  assert.match(sync, /label\.dataset\.decision = householdDecisionKey\(owner, choice\);/);
  // The card follows the viewer's role: who is asked "who can use it", and the label, are redrawn together.
  assert.match(sync, /const syncHouseholdConsentRole = \(\): void => \{\s*const purposeSet = one<HTMLElement>\("\[data-household-purpose-set\]"\);\s*if \(purposeSet\) purposeSet\.hidden = viewerRole\(\) !== "owner";\s*syncHouseholdConfirmLabel\(\);/);
  // The roster's own repaint calls it, so every roster change that can move the viewer's role redraws the card.
  assert.match(section(script, "const renderRoster = (): void => {", "renderedWakeMarkKey = wakeMarkKey();"), /if \(typeof syncHouseholdConsentRole === "function"\) syncHouseholdConsentRole\(\);\s*$/);
  // The label is refreshed when a choice changes, when the card is drawn for a role, and when it is cleared.
  assert.match(script, /one<HTMLElement>\("\[data-household-consent\]"\)\?\.addEventListener\("change", \(\) => \{\s*syncHouseholdConfirmLabel\(\);/);
  assert.match(section(script, "const renderHouseholdAccess =", "const landing = listsAllowLanding;"), /syncHouseholdConsentRole\(\);\s*$/);
  assert.match(section(script, "const resetHouseholdSurface =", "const openWorkspace = async"), /input\.checked = false;\s*\}\s*syncHouseholdConfirmLabel\(\);/);
  assert.match(script, /"Choose who can use Lists & docs and your access first\."/);
  assert.match(script, /"Choose your access first\."/);
});

test("the access card's button says what will be sent: a member never sees an audience, whatever a hidden choice holds", () => {
  const say = (owner: boolean, purpose?: string, role?: string) => {
    const choice = householdAccessChoice(owner, purpose, role);
    return { ...choice, label: householdConfirmLabel(owner, choice) };
  };
  // The owner: nothing, one half, both halves. The role is named as their own.
  assert.deepEqual(say(true), { purpose: null, role: null, label: "Turn on Lists & docs" });
  assert.deepEqual(say(true, "personal"), { purpose: "personal", role: null, label: "Turn on for just me" });
  assert.deepEqual(say(true, undefined, "editor"), { purpose: null, role: "editor", label: "Turn on · My access: Editor" });
  assert.deepEqual(say(true, "personal", "editor"), { purpose: "personal", role: "editor", label: "Turn on for just me · My access: Editor" });
  assert.deepEqual(say(true, "shared", "reader"), { purpose: "shared", role: "reader", label: "Turn on for me and people I invite · My access: Reader" });
  // A member with a Personal choice left ticked in the hidden group: the command sends shared, and the
  // label names no audience at all. It must never say "just me".
  for (const lingering of ["personal", "shared", undefined, "nonsense"]) {
    assert.deepEqual(say(false, lingering, "editor"), { purpose: "shared", role: "editor", label: "Turn on · My access: Editor" });
    assert.deepEqual(say(false, lingering), { purpose: "shared", role: null, label: "Turn on Lists & docs" });
  }
  // Values the command does not accept are never sent or named.
  assert.deepEqual(say(true, "everyone", "admin"), { purpose: null, role: null, label: "Turn on Lists & docs" });
  // The decision key tells an owner's "just me" from the member decision that a demotion turns it into.
  assert.equal(householdDecisionKey(true, householdAccessChoice(true, "personal", "editor")), "owner|personal|editor");
  assert.equal(householdDecisionKey(false, householdAccessChoice(false, "personal", "editor")), "member|shared|editor");
  assert.notEqual(householdDecisionKey(true, householdAccessChoice(true, "shared", "editor")), householdDecisionKey(false, householdAccessChoice(false, "shared", "editor")));
});

test("approving an agent uses the independent server command without changing the person's role", () => {
  const approve = section(script, "const approveAgent = async (", "const withdrawAgent = async");
  assert.match(approve, /kind: "household_approve_connection"/);
  assert.doesNotMatch(approve, /readHouseholdAccess|content_role|purpose|household_permissions/);
  assert.match(approve, /approvalUntil\(/);
  assert.match(approve, /await loadHouseholdConnections\(\)/);
  assert.match(script, /for \(const operation of CONTENT_OPERATIONS\)/);
  assert.match(script, /APPROVAL_CHOICE_LABELS\[operation\]/);
});

test("every household result is dropped once its workspace, account, version or generation moved on", () => {
  /* R2 review: success and failure paths alike, including the shared Confirm button. */
  const current = section(script, "const householdCurrent = (scope: HouseholdScope): boolean =>", ";\n");
  for (const fact of ["scope.workspaceId === activeWorkspaceId", "session?.user.id === scope.session.user.id",
    "scope.version === requestVersion", "scope.generation === householdAccessGeneration"]) {
    assert.ok(current.includes(fact), `householdCurrent must check ${fact}`);
  }
  const load = section(script, "const loadHouseholdConnections = async", "const approveAgent = async");
  assert.match(load, /const ticket = connectionReads\.next\(\);/);
  const settled = section(load, "} catch {", "householdConnections = next;");
  assert.match(settled, /^\} catch \{\s*next = \[\];\s*\}/);
  assert.match(settled, /if \(!connectionReads\.isLatest\(ticket\) \|\| !householdCurrent\(scope\)\) return;\s*$/);
  const confirm = section(script, "const confirmOwnAccess = async", "const openHouseholdView = async");
  assert.match(confirm, /if \(button && token === householdConfirms\) button\.disabled = false;/);
  assert.match(confirm, /notice && householdCurrent\(scope\) && token === householdConfirms/);
  const refresh = section(script, "const refreshHouseholdAccess = async", "const renderHouseholdAccess =");
  assert.match(refresh, /const ticket = accessReads\.next\(\);/);
  assert.match(refresh, /if \(!accessReads\.isLatest\(ticket\) \|\| !householdCurrent\(scope\)\) return;/);
  /* A workspace or account change retires every outstanding household read. */
  const reset = section(script, "const resetHouseholdSurface = (): void => {", "    };\n");
  assert.match(reset, /accessReads\.invalidate\(\);\s*connectionReads\.invalidate\(\);/);
});

test("the Add an agent poll runs only while a connector app is chosen in the panel, and stops on any change", () => {
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
  assert.match(watch, /joinAttemptMatch\(nextAgents, \{ ownerUserId: me, known: hostJoinKnown, name: picker\?\.agentName \?\? "" \}\)/,
    "the watch takes this attempt's agent, by the name typed now");
  const selected = section(script, 'hostPicker?.addEventListener("agent-host-selected", () => {', "    });\n");
  assert.match(selected, /if \(hostPicker\.watchable\) startHostJoinWatch\(\);\s*else stopHostJoinWatch\(\);/,
    "a key route or an app that cannot connect yet stops the watch");
});

/* Real emitted doors are covered by the kylon-host owner. This separate dispatch guard
   retains application ownership: Invite returns to Chat before opening the original form. */
test("People Invite returns to Chat before opening the existing invite form", () => {
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
  assert.match(cards, /allow.textContent = approval \? "Save" : editor \? "Allow" : "Allow read access"/);
  // Reading has no box: it is a sentence, it is skipped in the loop, and it is always the first thing sent.
  assert.match(cards, /included\.textContent = READ_ACCESS_INCLUDED;/);
  assert.match(cards, /if \(operation === "read"\) continue;/);
  assert.match(cards, /const operations = \["read", \.\.\.\[\.\.\.choices\.querySelectorAll<HTMLInputElement>\("\[data-approval-operation\]"\)\]/);
  assert.doesNotMatch(cards, /input\.disabled/);
  assert.match(cards, /withdraw.textContent = "Withdraw access"/);
  assert.match(cards, /approvalDescription\(approval\)/);
  const model = section(script, "const peopleDialogModel", "const syncPeopleDialogLayout");
  assert.match(model, /const own = Boolean\(me && agent.ownerUserId === me.userId && !sampleMode/);
  assert.match(peopleView, /"data-withdraw-agent-access"/);
  assert.match(peopleView, /"data-agent-error"|dataset.agentError/);
  assert.match(peopleView, /dataset.agentContentResult/);
  assert.match(peopleView, /"pd-quiet-link"/);
  assert.match(peopleView, /fact\("Lists & docs", accessFact, accessAction\)/,
    "withdrawal now belongs to the detail fact; the surface has only its quiet access indicator");
  assert.match(script, /withdrawAgent\(id, agent.name, agent.transport === "hosted_mcp", button, notice, questionId \?\? uuid\(\)\)/);
  const withdraw = section(script, "const withdrawAgent = async", "const confirmOwnAccess = async");
  assert.doesNotMatch(script, /window\.confirm/, "no browser prompt anywhere on the page");
  const askPeople = section(script, "const confirmPeopleDialogAction = ", "/** Open above the current view");
  assert.match(askPeople, /const questionId = uuid\(\);\s*showPeopleConfirmation\(confirm, action, \{ \.\.\.item, workspaceName: model\.workspaceName \}/, "People & agents makes one command id per question and passes the workspace name");
  assert.match(askPeople, /peopleDialogAction\(action, id, button, notice, questionId, pinnedKey\)/, "and every press of that question uses it");
  assert.match(cards, /const hosted = connection.kind === "hosted";/);
  assert.match(cards, /askListsWithdraw\(principalId, agentName, hosted, withdraw, status\)/,
    "a card row decides hosted from its own connection, not from a roster lookup");
  assert.match(withdraw, /kind: "household_withdraw_connection", principal_id: principalId/);
  assert.match(withdraw, /withdrawRefusalMessage\(result.body.reason\)/);
  assert.match(withdraw, /await loadHouseholdConnections\(\)/);
  // Connector availability copy belongs to the shared host-note cases; the retired
  // prose is no longer a contract of this approval-control and withdrawal test.
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

// Tree, events and visibility only: both renderers run unchanged, with transport recorded below.
function approvalDom() {
  const doc: any = { activeElement: null };
  class Element {
    children: Element[] = []; dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
    textContent = ""; className = ""; hidden = false; disabled = false; checked = false; value = ""; scrollTop = 0;
    ownerDocument = doc; events = new Map<string, () => void>();
    classList = {
      add: (...names: string[]) => { this.className += ` ${names.join(" ")}`; },
      remove: (...names: string[]) => { this.className = this.className.split(" ").filter(name => !names.includes(name)).join(" "); },
      contains: (name: string) => this.className.split(" ").includes(name),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !this.className.split(" ").includes(name);
        if (on) this.classList.add(name); else this.classList.remove(name); return on;
      },
    };
    constructor(public tag: string) {}
    get childElementCount() { return this.children.filter(child => child.tag !== "#text").length; }
    setAttribute(name: string, value: string) { this.attributes[name] = value; }
    append(...nodes: Element[]) { this.children.push(...nodes); }
    prepend(...nodes: Element[]) { this.children.unshift(...nodes); }
    insertBefore(node: Element, ref: Element | null) {
      const at = ref ? this.children.indexOf(ref) : -1; if (at < 0) this.children.push(node); else this.children.splice(at, 0, node); return node;
    }
    remove() {}
    removeAttribute(name: string) { delete this.attributes[name]; }
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    toggleAttribute(name: string, force?: boolean) { if (force === false) delete this.attributes[name]; else this.attributes[name] = ""; return force !== false; }
    replaceChildren(...nodes: Element[]) { this.children = nodes; }
    addEventListener(event: string, callback: () => void) { this.events.set(event, callback); }
    click() { if (!this.disabled) this.events.get("click")?.(); }
    closest() { return null; }
    contains(node: Element) { return this === node || this.descendants().includes(node); }
    descendants(): Element[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
    querySelectorAll(selector: string) {
      const data = /^\[data-([\w-]+)\]$/.exec(selector);
      const key = data?.[1].replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      return this.descendants().filter(child => key ? key in child.dataset : child.tag === selector);
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  doc.createElement = (tag: string) => new Element(tag);
  doc.createElementNS = (_namespace: string, tag: string) => new Element(tag);
  doc.createTextNode = (text: string) => Object.assign(new Element("#text"), { textContent: text });
  return { root: new Element("section"), detail: new Element("section"), list: new Element("ul"), doc };
}

test("hosted and local owners use the same Allow controls and approval command; other viewers get no control", async () => {
  for (const kind of ["hosted", "local"]) {
    const f = dialogConnectionsFixture(), dom = approvalDom(), actions: any[] = [], calls: any[] = [];
    const principal = "00000000-0000-4000-8000-000000000001";
    const connection: any = { kind, principal_id: principal, name: "Muse", approval: null,
      connection_id: "00000000-0000-4000-8000-000000000002", grant_id: "00000000-0000-4000-8000-000000000003" };
    f.ctx.agents[0].principalId = principal;
    f.ctx.agents[0].transport = kind === "hosted" ? "hosted_mcp" : "local";
    f.ctx.postCommand = async (_session: any, _id: string, body: any, envelope: any) => {
      if (body.kind === "household_connections") return { status: 200, body: { status: "ok", connections: [connection] } };
      calls.push(JSON.parse(JSON.stringify({ body, envelope })));
      return { status: 200, body: { status: "committed", expires_at: null } };
    };
    await f.load();
    const paint = () => renderPeopleDialog(dom.root as any, dom.detail as any, f.model(),
      { selected: { type: "agent", id: principal }, query: "" },
      { render: () => {}, action: (action, id) => { actions.push([action, id]); }, saveModel: async () => {},
        confirm: () => assert.fail("Allow opens the existing Lists & docs choices") },
      { page: { homeLabel: "Home", homeHref: "/app" } });
    const allowButton = () => dom.detail.descendants().find(node => node.tag === "button" && node.textContent === "Allow");
    paint(); assert.ok(allowButton(), `${kind}: owner has Allow`);
    assert.equal(allowButton()!.attributes["data-allow-agent-access"], principal);
    allowButton()!.click(); assert.deepEqual(actions, [["allow", principal]]);
    for (const role of ["owner", "admin", "member"]) {
      f.ctx.agents[0].ownerUserId = "someone-else"; f.ctx.members[0].role = role;
      paint(); assert.equal(allowButton(), undefined, `${kind}: ${role} cannot approve another person's agent`);
    }
    f.ctx.agents[0].ownerUserId = "person";
    for (const state of ["pending", "failed"]) {
      f.ctx.householdConnectionsReadState = state; paint(); assert.equal(allowButton(), undefined);
    }
    f.ctx.householdConnectionsReadState = "succeeded";
    f.ctx.sampleMode = true; paint(); assert.equal(allowButton(), undefined); f.ctx.sampleMode = false;
    Object.assign(f.ctx, { document: dom.doc, one: (selector: string) => selector === "[data-household-agent-list]" ? dom.list : null,
      householdAccess: { contentRole: "editor" }, CONTENT_OPERATIONS, CONTENT_OPERATION_LABELS, APPROVAL_CHOICE_LABELS, READ_ACCESS_INCLUDED, HOSTED_LISTS_NOTE,
      initials: () => "M", markAgentAvatar: () => {}, approvalUntil, accessRefusalMessage, loadHouseholdConnections: f.load });
    const funcs = execute(`${section(script, "const connectionApproval =", "const connectionReads")}
      ${section(script, "const approveAgent = async", "const withdrawAgent = async")}; ({ renderAgentApprovals, approveAgent });`, { ...f.ctx });
    funcs.renderAgentApprovals();
    const choices = dom.list.descendants().find(node => node.tag === "fieldset");
    const allow = dom.list.descendants().find(node => node.tag === "button" && node.textContent === "Allow");
    assert.ok(choices && !choices.hidden); assert.ok(allow && !allow.hidden);
    // Reading is a sentence, not a box; the two real choices are named in full and start ticked, as before.
    const boxes = () => dom.list.descendants().filter(node => node.tag === "input");
    assert.ok(dom.list.descendants().some(node => node.tag === "p" && node.textContent === "Read access included."));
    assert.deepEqual(boxes().map(node => [node.value, node.checked, !!node.disabled]), [["create", true, false], ["update", true, false]]);
    assert.equal("approvalReadOnly" in dom.list.descendants().find(node => node.tag === "li")!.dataset, false);
    const said = dom.list.descendants().map(node => String(node.textContent ?? "").trim());
    for (const label of ["Add new lists and docs", "Change existing lists and docs"]) assert.ok(said.includes(label), label);
    assert.equal(said.some(text => /See lists and docs|Add new ones|Change them/.test(text)), false, "the old short labels are gone from this row");
    assert.equal(dom.list.descendants().some(node => node.textContent === HOSTED_LISTS_NOTE), kind === "hosted");
    allow.click();
    // The event starts an async command; one event-loop turn drains its resolved transport and read.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(calls, [{ body: { kind: "household_approve_connection", connection: {
      kind, principal_id: principal, connection_id: connection.connection_id, grant_id: connection.grant_id,
      operations: ["read", "create", "update"] } }, envelope: { workspace_id: "workspace", stream: { kind: "workspace" } } }]);
    assert.equal(allow.disabled, false);
    assert.ok(dom.list.descendants().some(node => node.textContent === "Allowed until you withdraw it."));
    connection.approval = { operations: ["read", "create", "update"], expires_at: null };
    paint(); assert.equal(allowButton(), undefined, "an approved agent offers withdrawal instead");
    assert.ok(dom.detail.descendants().some(node => node.tag === "button" && node.textContent === "Withdraw"));
    funcs.renderAgentApprovals();
    assert.ok(dom.list.descendants().some(node => node.tag === "button" && node.textContent === "Save"));
    const sentOperations = () => calls.at(-1)!.body.connection.operations;
    const press = async (text: string) => {
      const button = dom.list.descendants().find(node => node.tag === "button" && node.textContent === text);
      assert.ok(button, `a ${text} button`); button.click();
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    // A saved grant with only one optional permission keeps exactly that choice, and Save sends it with reading.
    connection.approval = { operations: ["read", "update"], expires_at: null };
    funcs.renderAgentApprovals();
    assert.deepEqual(boxes().map(node => [node.value, node.checked]), [["create", false], ["update", true]]);
    await press("Save");
    assert.deepEqual(sentOperations(), ["read", "update"]);
    // Either optional permission can be granted on its own alongside reading; with neither, reading alone is sent.
    funcs.renderAgentApprovals();
    boxes()[0].checked = true; boxes()[1].checked = false;
    await press("Save");
    assert.deepEqual(sentOperations(), ["read", "create"]);
    funcs.renderAgentApprovals();
    for (const box of boxes()) box.checked = false;
    await press("Save");
    assert.deepEqual(sentOperations(), ["read"]);
    // A reader can pass on reading only: no boxes, the action says so, and reading is what is sent.
    connection.approval = null;
    const reader = execute(`${section(script, "const connectionApproval =", "const connectionReads")}
      ${section(script, "const approveAgent = async", "const withdrawAgent = async")}; ({ renderAgentApprovals, approveAgent });`,
      { ...f.ctx, householdAccess: { contentRole: "reader" } });
    reader.renderAgentApprovals();
    assert.deepEqual(boxes(), []);
    // The reader's row is marked, so its longer button can take its own line on a narrow phone; an editor's is not.
    assert.equal(dom.list.descendants().find(node => node.tag === "li")!.dataset.approvalReadOnly, "");
    assert.ok(dom.list.descendants().some(node => node.tag === "p" && node.textContent === "Read access included."));
    assert.equal(dom.list.descendants().some(node => node.tag === "button" && node.textContent === "Allow"), false);
    await press("Allow read access");
    assert.deepEqual(sentOperations(), ["read"]);
  }
});

test("People Allow approves in place with the Lists & docs defaults, and only falls back to setup before it exists", async () => {
  const principal = "00000000-0000-4000-8000-000000000001";
  for (const [role, operations] of [["editor", ["read", "create", "update"]], ["reader", ["read"]]] as const) {
    const f = dialogConnectionsFixture(), calls: any[] = [];
    const connection: any = { kind: "local", principal_id: principal, name: "Muse", approval: null,
      connection_id: "00000000-0000-4000-8000-000000000002", grant_id: "00000000-0000-4000-8000-000000000003" };
    let reads = 0;
    f.ctx.postCommand = async (_session: any, _id: string, body: any, envelope: any) => {
      if (body.kind === "household_connections") { reads += 1; return { status: 200, body: { status: "ok", connections: [connection] } }; }
      calls.push(JSON.parse(JSON.stringify({ body, envelope })));
      return { status: 200, body: { status: "committed", expires_at: null } };
    };
    const focused: string[] = [];
    Object.assign(f.ctx, { householdAccess: { workspaceId: "workspace", status: "ok", contentRole: role }, CONTENT_OPERATIONS,
      approvalUntil, accessRefusalMessage, loadHouseholdConnections: f.load,
      peopleDialogFocusTarget: (_action: string, id: string) => ({ focus: () => focused.push(id) }) });
    const funcs = execute(`${section(script, "const approveAgent = async", "const withdrawAgent = async")}; ({ allowAgentFromPeople });`, f.ctx);
    // The People dialog disables the button for the click before it calls the action, as here.
    const button: any = { disabled: true }, status: any = { textContent: "" };
    // Connections not read yet: it reads them first, then approves the one seat, in place.
    assert.equal(await funcs.allowAgentFromPeople("workspace", principal, button, status), "approved");
    assert.equal(reads, 2, "read before approving, and again after");
    assert.deepEqual(calls, [{ body: { kind: "household_approve_connection", connection: {
      kind: "local", principal_id: principal, connection_id: connection.connection_id, grant_id: connection.grant_id, operations } },
      envelope: { workspace_id: "workspace", stream: { kind: "workspace" } } }], role);
    assert.equal(status.textContent, "Allowed until you withdraw it.");
    assert.equal(f.ctx.peopleDialogReceipts.get(`workspace:${principal}`), "Allowed until you withdraw it.",
      "the receipt outlives the roster being drawn again");
    assert.deepEqual(focused, [principal], "and focus returns to the seat");
    assert.equal(button.disabled, false);
    // No connection to approve for that seat: setup, and no command.
    assert.equal(await funcs.allowAgentFromPeople("workspace", "00000000-0000-4000-8000-00000000000f", button, status), "setup");
    assert.equal(calls.length, 1);
    // A refusal goes back to the dialog, which shows it on the row.
    f.ctx.postCommand = async (_session: any, _id: string, body: any) => body.kind === "household_connections"
      ? { status: 200, body: { status: "ok", connections: [connection] } }
      : { status: 200, body: { status: "refused", reason: "content_consent_required" } };
    await assert.rejects(funcs.allowAgentFromPeople("workspace", principal, { disabled: true }, { textContent: "" }),
      new RegExp(accessRefusalMessage("content_consent_required").slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const access of [{ workspaceId: "workspace", status: "refused", contentRole: null }, { workspaceId: "other", status: "ok", contentRole: "editor" }]) {
    const f = dialogConnectionsFixture(), calls: any[] = [];
    f.ctx.postCommand = async (_session: any, _id: string, body: any) => { calls.push(body.kind); return { status: 200, body: { status: "ok", connections: [] } }; };
    Object.assign(f.ctx, { householdAccess: access, CONTENT_OPERATIONS, approvalUntil, accessRefusalMessage, loadHouseholdConnections: f.load });
    const funcs = execute(`${section(script, "const approveAgent = async", "const withdrawAgent = async")}; ({ allowAgentFromPeople });`, f.ctx);
    assert.equal(await funcs.allowAgentFromPeople("workspace", principal, { disabled: false }, { textContent: "" }), "setup",
      `Lists & docs not set up here (${access.status}, ${access.workspaceId}): the setup page`);
    assert.deepEqual(calls, [], "and nothing is sent");
  }
});

test("every tab says loading, empty or could not load with Retry in the same place", async () => {
  const f = dialogConnectionsFixture(), dom = approvalDom(); let reloads = 0, inviteReloads = 0;
  await f.load();
  const paint = (tab: string, over: Record<string, unknown>) => renderPeopleDialog(dom.root as any, dom.detail as any, { ...f.model(), ...over },
    { selected: null, query: "", tab } as any,
    { render: () => {}, action: () => {}, saveModel: async () => {}, confirm: () => {}, reload: async () => { reloads += 1; }, reloadInvites: async () => { inviteReloads += 1; } },
    { page: { homeLabel: "Home", homeHref: "/app" } });
  const note = () => dom.root.descendants().find(node => (node as any).dataset?.tabState !== undefined) as any;
  const retry = () => dom.root.descendants().find(node => node.tag === "button" && (node as any).dataset?.tabRetry !== undefined) as any;
  paint("agents", {}); assert.equal(note(), undefined, "a tab with rows has no note");
  paint("agents", { agents: [], read: "pending" });
  assert.equal(note()!.textContent, "Loading…"); assert.equal(note()!.attributes.role, "status"); assert.equal(retry(), undefined);
  paint("agents", { agents: [] }); assert.equal(note()!.textContent, "No agents yet.");
  paint("invites", {}); assert.equal(note()!.textContent, "No invites waiting.");
  paint("agents", { agents: [], read: "failed" });
  assert.equal(note()!.attributes.role, "alert"); assert.ok(note()!.textContent.startsWith("Agents could not load."));
  assert.equal(retry()!.dataset.tabRetry, "agents"); await retry()!.click(); assert.deepEqual([reloads, inviteReloads], [1, 0]);
  paint("people", { read: "failed" });
  assert.ok(note()!.textContent.startsWith("This list may be out of date."), "rows that did arrive stay, under a line that says so");
  paint("invites", { pendingFailed: true });
  assert.ok(note()!.textContent.startsWith("Invites could not load.")); await retry()!.click(); assert.deepEqual([reloads, inviteReloads], [1, 1]);
  paint("agents", { agents: [], read: "failed", sample: true }); assert.notEqual(note()?.dataset.tabState, "error", "a sample never reports a failed read");
});

test("Invite a person opens a form on the Invites tab, and the link shows only while the integration holds it", async () => {
  const f = dialogConnectionsFixture(), dom = approvalDom(); const sent: string[] = []; let forgotten = 0;
  await f.load();
  const state: any = { selected: null, query: "", tab: "people" };
  let link = "", answer: any = { error: "Enter a full email address." };
  const callbacks: any = { render: () => paint(), action: () => {}, saveModel: async () => {}, confirm: () => {},
    createInvite: async (email: string) => { sent.push(email); return answer; }, forgetInvite: () => { forgotten += 1; link = ""; } };
  const model = () => { const base = f.model(); return { ...base, people: base.people.map((person: any) => ({ ...person, own: true, role: "owner" })) }; };
  function paint() { renderPeopleDialog(dom.root as any, dom.detail as any, model(), state, callbacks,
    { page: { homeLabel: "Home", homeHref: "/app", invite: () => { throw new Error("the older page is not used"); }, madeInviteLink: link } }); }
  const find = (test: (node: any) => boolean) => dom.root.descendants().find(test) as any;
  const byFocus = (key: string) => find(node => node.dataset?.pdFocus === key);
  paint(); byFocus("page-invite").click();
  assert.equal(state.tab, "invites", "the form lives on the Invites tab");
  assert.equal(byFocus("page-invite"), undefined, "the form stands where the button was");
  const input = () => byFocus("invite-email"); const form = () => find(node => node.tag === "form");
  assert.ok(find(node => node.tag === "p" && node.textContent === "Invites work only when workspace sharing in Lists & docs is set to ‘Me and people I invite’."),
    "the form says which sharing setting an invite needs, before the link is made");
  assert.ok(find(node => node.tag === "p" && node.textContent.endsWith("shared in this workspace.")), "and what the invited person can read is scoped to this workspace");
  input().value = "  mei@  "; input().events.get("input")();
  paint(); assert.equal(input().value, "  mei@  ", "a redraw keeps what was typed");
  await form().events.get("submit")({ preventDefault() {} }); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(sent, ["mei@"]);
  assert.equal(find(node => node.dataset?.peopleInviteError !== undefined).textContent, "Enter a full email address.");
  input().value = "mei@example.test"; input().events.get("input")();
  answer = { madeId: "inv-1" }; link = "https://example.test/invite#one-use";
  await form().events.get("submit")({ preventDefault() {} }); await Promise.resolve(); await Promise.resolve();
  assert.equal(form(), undefined); assert.equal(byFocus("invite-link").textContent, "https://example.test/invite#one-use");
  assert.ok(find(node => node.tag === "p" && node.textContent.startsWith("Private one-use link for mei@example.test")));
  // Copy asks the integration at the click and copies only the link its block shows.
  let asked = 0; callbacks.currentInviteLink = () => { asked += 1; return ""; };
  byFocus("invite-copy").click(); await Promise.resolve();
  assert.equal(asked, 1); assert.equal(find(node => node.tag === "p" && node.textContent.startsWith("Copied")), undefined, "a link that is no longer current is not copied");
  delete callbacks.currentInviteLink;
  link = ""; paint();
  assert.equal(byFocus("invite-link"), undefined, "a link the integration dropped is not kept by the view");
  assert.equal(state.invite, null); assert.ok(byFocus("page-invite"));
  byFocus("page-invite").click(); answer = { madeId: "inv-2" }; link = "https://example.test/invite#second";
  input().value = "sam@example.test"; input().events.get("input")();
  await form().events.get("submit")({ preventDefault() {} }); await Promise.resolve(); await Promise.resolve();
  byFocus("invite-done").click();
  assert.equal(forgotten, 1, "Done tells the integration to forget the link"); assert.equal(state.invite, null);
  renderPeopleDialog(dom.root as any, dom.detail as any, model(), state, callbacks,
    { page: { homeLabel: "Home", homeHref: "/app", inviteNotice: "The link for mei@example.test is no longer shown here because the workspace reloaded." } });
  assert.ok(find(node => node.dataset?.peopleInviteNotice !== undefined && node.textContent.startsWith("The link for mei@example.test is no longer shown here")),
    "a cleared link is said at the top of the Invites tab");
});

test("Admins lists who can manage, the admin access given to agents, and Remove only where the server would accept it", async () => {
  const f = dialogConnectionsFixture(), dom = approvalDom(); const ended: string[] = [];
  await f.load();
  const g = (n: number, over: Record<string, unknown> = {}) => ({ grantId: `00000000-0000-4000-8000-00000000000${n}`, principalId: `p${n}`, agentName: `Agent ${n}`,
    giverId: "someone", giverName: "Sam Rivera", level: "workspace", expiresAt: null, mayEnd: true, ...over });
  const state: any = { selected: null, query: "", tab: "admins" };
  let access: any = { read: "ready", all: true, grants: [g(1), g(2, { level: "organization", mayEnd: false })], notices: { [g(1).grantId]: "Refused." } };
  const callbacks: any = { render: () => paint(), action: () => {}, saveModel: async () => {}, confirm: () => {}, endAdmin: (grantId: string) => { ended.push(grantId); } };
  const model = () => { const base = f.model(); return { ...base, adminAccess: access,
    people: [...base.people.map((person: any) => ({ ...person, own: true, role: "owner" })), { id: "m", name: "Mei", role: "member", own: false, mayRemove: false }] }; };
  function paint() { renderPeopleDialog(dom.root as any, dom.detail as any, model(), state, callbacks, { page: { homeLabel: "Home", homeHref: "/app" } }); }
  const all = (test: (node: any) => boolean) => dom.root.descendants().filter(test) as any[];
  paint();
  assert.equal(all(node => node.dataset?.pdFocus?.startsWith("person-")).length, 1, "only owners and admins are listed");
  const rows = all(node => node.dataset?.adminGrant !== undefined);
  assert.deepEqual(rows.map(row => row.dataset.adminLevel), ["workspace", "organization"]);
  assert.ok(all(node => node.tag === "h3" && node.textContent === "Admin access given to agents").length);
  const removes = all(node => node.tag === "button" && node.dataset?.endAdmin !== undefined);
  assert.deepEqual(removes.map(button => button.dataset.endAdmin), [g(1).grantId], "no Remove where the server would refuse");
  assert.equal(removes[0].attributes["aria-label"], "Remove admin access: Agent 1");
  removes[0].click(); assert.deepEqual(ended, [g(1).grantId]);
  assert.deepEqual(all(node => node.dataset?.adminGrantNotice !== undefined).map(node => [node.textContent, node.hidden]), [["Refused.", false], ["", true]]);
  // This fixture's nodes cannot take focus; the selection and the tab are settled before the view moves it.
  try { all(node => node.dataset?.pdFocus?.startsWith("person-"))[0].click(); } catch { /* focus */ }
  assert.equal(state.selected?.type, "person"); assert.equal(state.tab, "admins", "opening a person from Admins stays on Admins");
  state.selected = null; access = { read: "ready", all: false, grants: [] }; paint();
  assert.ok(all(node => node.tag === "h3" && node.textContent === "Admin access you gave to agents").length, "a partial list says it is partial");
  assert.ok(all(node => node.dataset?.adminAccessState === "empty" && node.textContent === "No active admin grants from you here.").length);
  access = { read: "failed", all: true, grants: [] }; paint();
  assert.ok(all(node => node.dataset?.adminAccessState === "error" && node.textContent.startsWith("Admin access could not load.")).length);
  access = { read: "failed", all: true, grants: [g(1)] }; paint();
  assert.equal(all(node => node.dataset?.adminGrant !== undefined).length, 1, "rows kept under a failed read stay to look at");
  assert.equal(all(node => node.tag === "button" && node.dataset?.endAdmin !== undefined).length, 0, "but offer no Remove until a read succeeds");
  access = { read: "ready", all: true, grants: [g(1, { agentName: "Atlas", principalId: "aaaaaaaa-1" }), g(2, { agentName: "Atlas", principalId: "bbbbbbbb-2" })] }; paint();
  assert.deepEqual(all(node => node.tag === "button" && node.dataset?.endAdmin !== undefined).map(button => button.attributes["aria-label"]),
    ["Remove admin access: Atlas (agent aaaaaaaa)", "Remove admin access: Atlas (agent bbbbbbbb)"], "same-named agents are told apart beside Remove");
  assert.deepEqual(all(node => node.dataset?.adminGrantId !== undefined).map(node => node.textContent), ["agent aaaaaaaa", "agent bbbbbbbb"],
    "the id is its own field on the row, outside the name that may be cut short");
  assert.deepEqual(all(node => node.dataset?.adminGrant !== undefined).map(row => row.descendants().find((node: any) => node.tag === "strong").textContent), ["Atlas", "Atlas"]);
  access = { read: "pending", all: true, grants: [g(1)] }; paint();
  assert.equal(all(node => node.tag === "button" && node.dataset?.endAdmin !== undefined).length, 0, "no Remove while the list is being read again");
  access = undefined; paint();
  assert.equal(all(node => node.dataset?.adminAccess !== undefined).length, 0, "with agent admin access off, the tab lists people only");
});

test("People & agents keeps its scroll position across redraws on the same tab and profile, and resets when changing tab, query, focus or selection", () => {
  const f = dialogConnectionsFixture(), dom = approvalDom();
  const state: any = { selected: null, query: "", tab: "admins" };
  const paint = (options: any = {}) => renderPeopleDialog(dom.root as any, dom.detail as any, f.model(), state,
    { render: () => {}, action: () => {}, saveModel: async () => {}, confirm: () => {} },
    { page: { homeLabel: "Home", homeHref: "/app" }, ...options });
  const ctx = () => dom.root.querySelector("[data-people-context]")!;
  const side = () => dom.root.querySelector("[data-people-side]")!;
  paint();
  ctx().scrollTop = 178;
  paint();
  assert.equal(ctx().scrollTop, 178, "a background redraw on the same tab and query preserves scroll position");
  state.query = "m"; paint();
  assert.equal(ctx().scrollTop, 0, "typing a query resets scroll to the top of results");
  ctx().scrollTop = 90; state.tab = "agents"; paint();
  assert.equal(ctx().scrollTop, 0, "switching tabs resets scroll to the top");
  ctx().scrollTop = 120; paint({ focus: { kind: "person", id: "person" } });
  assert.equal(ctx().scrollTop, 0, "applying an initial focus target resets scroll");
  state.selected = { type: "person", id: "person" }; paint();
  side().scrollTop = 140; paint();
  assert.equal(side().scrollTop, 140, "a redraw of the same open profile preserves its scroll position");
  state.selected = { type: "agent", id: "principal" }; paint();
  assert.equal(side().scrollTop, 0, "switching to another profile resets the detail scroll");
});

test("agent profile keeps name, status and problem fix visible, groups routine key/access/removal under More, preserves More across same-agent redraws, and returns Escape focus to the same action", () => {
  const f = dialogConnectionsFixture(), dom = approvalDom();
  f.ctx.agents.push({ principalId: "other-agent", name: "Harbor", ownerUserId: "person", model: "claude-opus-5-5", transport: "local" });
  const baseModel = f.model();
  const atlas = { ...baseModel.agents[0], id: "principal", name: "Atlas", own: true, mayManage: true, liveKey: true, key: "Turned off. A new key can bring it back.",
    access: { until: null }, accessReadState: "succeeded" as const,
    status: { kind: "key-off" as const, label: "Key turned off", attention: true, sentence: "It needs a new key to connect again.", fix: { allowed: true, action: "new-key" as const } } };
  const harbor = { ...baseModel.agents[1], id: "other-agent", name: "Harbor", own: true, mayManage: true, liveKey: true, key: "Uses a key to connect.",
    access: null, accessReadState: "succeeded" as const,
    status: { kind: "active" as const, label: "Active", attention: false, sentence: "", fix: { allowed: false, action: null } } };
  const model = () => ({ ...baseModel, agents: [atlas, harbor] });
  const state: any = { selected: { type: "agent", id: "principal" }, query: "", tab: "agents" };
  const paint = (options: any = {}) => renderPeopleDialog(dom.root as any, dom.detail as any, model(), state,
    { render: () => {}, action: () => {}, saveModel: async () => {}, confirm: () => {} },
    { page: { homeLabel: "Home", homeHref: "/app" }, ...options });
  const more = () => dom.detail.querySelector("[data-people-agent-more]") as any;
  paint();
  assert.ok(more(), "agent profile renders a More disclosure");
  assert.notEqual(more().open, true, "More starts closed on fresh open");
  // Name, status, and the problem-fix action (Get a new key) stay outside More.
  const outsideMore = dom.detail.descendants().filter(node => node !== more() && !more().contains(node));
  assert.ok(outsideMore.some(node => node.tag === "h2" && node.textContent === "Atlas"), "name stays visible outside More");
  assert.ok(outsideMore.some(node => node.dataset?.agentStatus === "key-off"), "status chip stays visible outside More");
  assert.ok(outsideMore.some(node => node.tag === "button" && node.textContent === "Get a new key"), "current problem fix stays visible outside More");
  // Routine key management, Lists & docs access changes, technical details and removal sit inside More.
  const insideMore = more().descendants();
  assert.ok(insideMore.some((node: any) => node.attributes?.["data-withdraw-agent-access"] === "principal"), "Lists & docs Withdraw sits inside More");
  assert.ok(insideMore.some((node: any) => node.tag === "button" && node.textContent === "New key"), "routine Key management sits inside More");
  assert.ok(insideMore.some((node: any) => node.className?.includes("pd-technical")), "Technical details sits inside More");
  assert.ok(insideMore.some((node: any) => node.attributes?.["data-revoke-grant"] === "principal"), "Turn off key sits inside More");
  assert.ok(insideMore.some((node: any) => node.attributes?.["data-remove-agent"] === "principal"), "Remove sits inside More");
  // Opening More stays open across same-agent redraws, and resets closed when switching agents or applying focus.
  more().open = true;
  paint();
  assert.equal(more().open, true, "a background redraw for the same agent keeps More open");
  state.selected = { type: "agent", id: "other-agent" };
  paint();
  assert.notEqual(more().open, true, "switching to another agent starts with More closed");
  more().open = true;
  state.focusApplied = null;
  paint({ focus: { kind: "agent", id: "other-agent" } });
  assert.notEqual(more().open, true, "applying an initial focus target resets More to closed");
});

test("the People page puts Allow Lists & docs on an own seat's row, one click each", async () => {
  const f = dialogConnectionsFixture(), dom = approvalDom(), actions: any[] = [];
  const principal = "00000000-0000-4000-8000-000000000001";
  f.ctx.agents[0].principalId = principal;
  f.ctx.postCommand = async () => ({ status: 200, body: { status: "ok", connections: [{ kind: "local", principal_id: principal,
    name: "Muse", approval: null, connection_id: "00000000-0000-4000-8000-000000000002", grant_id: "00000000-0000-4000-8000-000000000003" }] } });
  await f.load();
  const paint = () => renderPeopleDialog(dom.root as any, dom.detail as any, f.model(),
    { selected: null, query: "" },
    { render: () => {}, action: (action, id) => { actions.push([action, id]); }, saveModel: async () => {}, confirm: () => {} },
    { page: { homeLabel: "Home", homeHref: "/app" } });
  const rowAllow = () => dom.root.descendants().find(node => node.tag === "button" && node.attributes["data-row-allow-agent-access"] === principal);
  paint();
  assert.ok(rowAllow(), "an own seat not yet allowed has the action on its row");
  assert.equal(rowAllow()!.textContent, "Allow Lists & docs");
  assert.equal(rowAllow()!.attributes["aria-label"], "Allow Lists & docs: Muse");
  rowAllow()!.click();
  assert.deepEqual(actions, [["allow", principal]], "one click sends the allow action");
  f.ctx.agents[0].ownerUserId = "someone-else"; paint();
  assert.equal(rowAllow(), undefined, "another person's agent has no allow");
  f.ctx.agents[0].ownerUserId = "person";
  f.ctx.sampleMode = true; paint(); assert.equal(rowAllow(), undefined, "never in a sample"); f.ctx.sampleMode = false;
});

// Run the actual read and dialog projection together; only transport and unrelated UI are stubbed.
function dialogConnectionsFixture() {
  const ctx: any = {
    session: { user: { id: "person" } }, activeWorkspaceId: "workspace", sampleMode: false,
    members: [{ userId: "person", name: "Tom", role: "owner" }],
    agents: [{ principalId: "principal", name: "Muse", ownerUserId: "person", model: null, transport: "local" }],
    accessStatuses: [], pendingAgentsLoadFailed: false, homePeopleReadState: "ready", people: new Map([["person", "Tom"]]),
    householdConnections: [], householdConnectionsReadState: "pending", householdReceipts: new Map(),
    peopleDialogReceipts: new Map(), identityRoster: () => ({ agents: [] }), identityDisplayLabel: (agent: any) => agent.name,
    workspaces: [{id:"workspace",name:"Home"}], homeConnectionAccess, homeConnectionPolicy, homeConnectionTokenMatches, agentStatus, peopleAgentStatus, classifyAgentPresence, grantRiskBadge, STANDING_GRANT_COPY, connectionPolicyCopy, connectionPolicyState, renewalGrantEnded,
    agentPresenceLine: () => null, wakePathMark: () => null, peopleInvites, pendingInvites: [], pendingAgents: [],
    formatTime: () => ({ relative: "just now" }), createLatestRead, uuid: () => "command-id",
    householdScope: () => ({ workspaceId: ctx.activeWorkspaceId, session: ctx.session }),
    householdCurrent: (scope: any) => scope.workspaceId === ctx.activeWorkspaceId && scope.session === ctx.session,
    renderAgentApprovals: () => {}, renderDialogRoster: () => {},
  };
  const source = section(script, "const renewalConnectionLive =", "const connectionDateFocus =")
    + section(script, "const connectionApproval =", "const approvalDescription =")
    + section(script, "const peopleDialogModel =", "const syncPeopleDialogLayout =")
    + section(script, "const connectionReads =", "const approveAgent = async");
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

test("server-confirmed key loss offers removal and a new key but no turn-off alternative", () => {
  const f = dialogConnectionsFixture();
  const grantId = "11111111-1111-4111-8111-111111111111", tokenId = "22222222-2222-4222-8222-222222222222";
  const grant = { workspaceId: "workspace", principalId: "principal", ownerUserId: "person", grantId, tokenId, grantKind: "timeboxed", horizonExpiresAt: "2000-01-01T00:00:00Z", revokedAt: null, grantRevokedAt: null, lastUsedAt: null };
  f.ctx.accessStatuses = [grant];
  f.ctx.agents[0].work = { facts: { connection: "key_ended", renewal_grant_id: grantId, token_id: tokenId } };
  const ended = f.model();
  assert.equal(ended.agents[0].status.kind, "key-ended");
  assert.equal(ended.agents[0].liveKey, false, "Remove confirmation uses liveKey for its alternative");
  assert.equal(peopleDialogCanAct(ended, "turn-off-key", "principal"), false);
  assert.equal(peopleDialogCanAct(ended, "remove-agent", "principal"), true);
  assert.equal(peopleDialogCanAct(ended, "new-key", "principal"), true);
  f.ctx.agents[0].work.facts.connection = "live";
  grant.horizonExpiresAt = "2099-01-01T00:00:00Z";
  assert.equal(peopleDialogCanAct(f.model(), "turn-off-key", "principal"), true, "a server-confirmed live key can still be turned off");
  grant.grantKind = "standing";
  grant.horizonExpiresAt = "2000-01-01T00:00:00Z";
  assert.equal(peopleDialogCanAct(f.model(), "turn-off-key", "principal"), true, "a technical horizon does not end a live standing connection");
});

function creationFixture(outcome: "committed" | "refused" | "unknown", existing = false, storage = new Map<string, string>()) {
  const events: string[] = [], commands: any[] = [];
  const radios = [{ value: "shared", checked: false, disabled: false }, { value: "personal", checked: false, disabled: false }];
  const warning = { textContent: "" }, receipt: { hidden: boolean; textContent: string; dataset: { setupWorkspaceId?: string } } = { hidden: true, textContent: "", dataset: {} };
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
  const source = section(script, "const syncCreatePurposeWarning =", "const SAMPLE_ROSTERS:");
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
  const sync = execute(`${section(script, "const syncCreatePurposeWarning =", "const recordCreatePermissions = async")}; syncCreatePurposeWarning;`, { ...f.ctx });
  assert.match(PERSONAL_PURPOSE_WARNING, /cannot be changed later/);
  assert.match(PERSONAL_PURPOSE_WARNING, /create another workspace/);
  f.radios[1].checked = true; sync(); assert.equal(f.warning.textContent, PERSONAL_PURPOSE_WARNING);
  f.radios[1].checked = false; f.radios[0].checked = true; sync(); assert.equal(f.warning.textContent, "");
});

test("approval sends only connection consent, withdrawal asks in the shared confirmation, and going back sends nothing", async () => {
  const calls: any[] = [], messages: string[] = [], asked: any[] = [], receipt = { textContent: "" };
  const scope = { workspaceId: "workspace", session: { user: { id: "person" } } };
  let current = true, reply: any = { status: "committed", expires_at: null }, ids = 0, lose = false;
  const dialog = {}, root = {}, title = { focused: 0, focus() { this.focused += 1; } };
  const ctx = {
    householdScope: () => scope, householdCurrent: () => current,
    postCommand: async (_session: any, id: string, body: any, envelope: any) => {
      calls.push(JSON.parse(JSON.stringify({ id, body, envelope })));
      if (lose) throw new Error("The result is unknown. Reload Lists & docs to check this agent's access.");
      return { status: 200, body: reply };
    },
    uuid: () => `command-${++ids}`, approvalUntil, accessRefusalMessage, withdrawRefusalMessage, readableError: (error: Error) => error.message,
    agents: [{ principalId: "principal", transport: "local" }], CSS: { escape: (value: string) => value },
    workspaces: [{ id: "workspace", name: "Herb garden" }],
    householdReceipts: new Map(),
    one: (selector: string) => selector === "[data-lists-confirm]" ? dialog : selector === "[data-household-agents]" ? root
      : selector === "#dashboard-agent-approvals-title" ? title : selector === "[data-people-receipt]" ? receipt : null,
    // The shared confirmation itself is tested with People & agents; here it records what it was asked and hands back its answer.
    showPeopleConfirmation: (...args: any[]) => { asked.push(args); },
    loadHouseholdConnections: async () => messages.push("reload"),
  };
  const commands = execute(`${section(script, "const approveAgent = async", "let householdConfirms =")}; ({ approveAgent, withdrawAgent, askListsWithdraw });`, ctx);
  const connection = { kind: "hosted", connection_id: "connection", grant_id: "grant", principal_id: "principal" };
  const button = { disabled: false }, status = { textContent: "" };
  await commands.approveAgent(connection, ["read"], button, status);
  assert.deepEqual(calls[0].body, { kind: "household_approve_connection", connection: { ...connection, operations: ["read"] } });
  assert.equal(status.textContent, "Allowed until you withdraw it.");
  assert.deepEqual(messages, ["reload"]);
  assert.equal(receipt.textContent, "", "approval is announced only on its card");

  // Withdraw on the card asks in the shared confirmation, with the agent's name and its kind.
  const opener = { disabled: false };
  commands.askListsWithdraw("principal", "Muse", false, opener, status);
  assert.equal(asked.length, 1);
  const [onDialog, action, item, from, commit, , , , host] = asked[0];
  assert.equal(onDialog, dialog); assert.equal(action, "withdraw"); assert.deepEqual(JSON.parse(JSON.stringify(item)), { name: "Muse", hosted: false, workspaceName: "Herb garden" }); assert.equal(from, opener);
  assert.equal(host.root, root, "focus goes back within the approvals, to the same agent's button");
  host.fallback(); assert.equal(calls.length, 1, "going back, or Escape, sends nothing");
  commands.askListsWithdraw("principal", "Muse", true, opener, status);
  assert.deepEqual(JSON.parse(JSON.stringify(asked[1][2])), { name: "Muse", hosted: true, workspaceName: "Herb garden" }, "a hosted row asks with the hosted consequences and workspace name");

  // Confirming sends one withdrawal for that agent in that workspace.
  reply = { status: "committed", withdrawn: 1 };
  await commit(button, status);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { id: "command-2", body: { kind: "household_withdraw_connection", principal_id: "principal" }, envelope: { workspace_id: "workspace", stream: { kind: "workspace" } } });
  assert.equal(status.textContent, "Withdrawn. Muse can no longer use Lists & docs here.");

  // A refusal keeps its own sentence and is thrown, so the confirmation stays open and says it.
  reply = { status: "refused", reason: "connection_access_refused" };
  await assert.rejects(commit(button, status), /Only the person who connected this agent/);
  assert.equal(status.textContent, "Only the person who connected this agent can withdraw its Lists & docs access. Nothing was changed.");
  assert.equal(button.disabled, false);

  // A hosted withdrawal reports the stored approval.
  reply = { status: "committed", withdrawn: 1 };
  await asked[1][4](button, status);
  assert.equal(status.textContent, "Withdrawn. The stored Lists & docs approval for Muse was removed.");
  assert.equal(receipt.textContent, "", "withdrawal has no duplicate section receipt");
  assert.deepEqual(messages, ["reload", "reload", "reload"]);

  // A lost answer: the question stays open, and pressing again repeats the same command, never a new one.
  calls.length = 0; lose = true;
  commands.askListsWithdraw("principal", "Muse", false, opener, status);
  const retry = asked.at(-1)[4];
  await assert.rejects(retry(button, status), /result is unknown/);
  lose = false; reply = { status: "committed", withdrawn: 1 };
  await retry(button, status);
  assert.deepEqual(calls.map((call: any) => call.id), [calls[0].id, calls[0].id], "the retry from the same question sends the same command id");
  commands.askListsWithdraw("principal", "Muse", false, opener, status);
  await asked.at(-1)[4](button, status);
  assert.notEqual(calls[2].id, calls[0].id, "a new question, after a fresh look, gets a new command id");
  calls.splice(0, calls.length, {}, {}, {}, {});

  // A question confirmed after the workspace changed sends nothing.
  const reloads = messages.length;
  current = false;
  await assert.rejects(asked[0][4](button, status), /This workspace changed/);
  assert.equal(calls.length, 4);
  status.textContent = "other workspace";
  await commands.approveAgent(connection, ["read"], button, status);
  assert.equal(messages.length, reloads, "stale committed replies do not reload the current workspace");
});

test("approval reads distinguish active permanent and local approvals from expired or missing ones", () => {
  const { read, describe } = execute(`${section(script, "const connectionApproval =", "const renderAgentApprovals =")}; ({ read: connectionApproval, describe: approvalDescription });`, { approvalUntil });
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
    session, requestVersion: 1, activeCreate: null, selectedOrgId: null,
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
  f.ctx.renderSetupChecklist = execute(`${section(script, "const renderSetupChecklist =", "const startHostJoinWatch =")}; renderSetupChecklist;`, f.ctx);
  f.ctx.refreshHouseholdAccess = execute(`${section(script, "const refreshHouseholdAccess =", "const renderHouseholdAccess =")}; refreshHouseholdAccess;`, f.ctx);
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
    accessStatuses: [], pendingAgents: [], pendingAgentsLoadFailed: false, homePeopleReadState: "ready",
    syncConnectWorkspace: () => {}, returnToChannel: () => {},
    // No Add an agent panel key is waiting here; that path has its own test in home-integration.
    finishPanelKeyMint: () => false,
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
  const branch = section(script, "        const pending = readCreateIntent(session.user.id);\n        if (pending && workspaces.some", "        await navigateHome(resolveHomeRoute(");
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
    householdConnectionsReadState: "succeeded", listsAllowLanding: null,
    householdAccessGeneration: 1, householdAccessRequestedFor: "workspace", householdAccess: null,
    accessReads: createLatestRead(), connectionReads: createLatestRead(), stopHostJoinWatch: () => {},
    labelSyncs: 0, syncHouseholdConfirmLabel() { ctx.labelSyncs += 1; },
  };
  const reset = execute(`${section(script, "const resetHouseholdSurface =", "const openWorkspace =")}; resetHouseholdSurface;`, ctx);
  reset();
  assert.equal(ctx.labelSyncs, 1, "the access card's button label is rebuilt once its choices are cleared");
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

test("openWorkspace settles each read independently so sibling failures keep loaded files or show the file error with retry", async () => {
  const sampleFile = {
    fileId: "file-1",
    name: "quote.txt",
    currentVersion: 1,
    sizeBytes: 110,
    uploadedByKind: "user",
    uploadedBy: "person",
    committedAt: "2026-11-09T00:00:00Z",
    tombstonedAt: null,
  };
  const makeCtx = (overrides: Record<string, unknown>) => {
    const rendered: string[] = [];
    const feedError = { textContent: "" };
    const ctx: Record<string, any> = {
      workspaces: [{ id: "workspace", name: "Home" }],
      homeRoute: { view: "files", workspaceId: "workspace" },
      activeWorkspaceId: "",
      session: { user: { id: "person" } },
      app: { dataset: { state: "loading" } },
      window: { history: { replaceState: () => {} }, dispatchEvent: () => {}, requestAnimationFrame: () => {} },
      CustomEvent: class { type: string; detail: unknown; constructor(type: string, detail?: unknown) { this.type = type; this.detail = detail; } },
      routeHref: () => "/app?w=workspace&v=files",
      one: (selector: string) => selector === "[data-feed-error]" ? feedError : null,
      closeEntityPanel: () => {},
      resetHouseholdSurface: () => {},
      previousSignalIds: new Set(),
      feedWasEmpty: false,
      pendingWorkspaceId: "",
      resetInviteSubmitControl: () => {},
      resetComposer: () => {},
      resetFreshInviteResult: () => {},
      inviteIntent: null,
      closeRosterDialog: () => {},
      closeWorkspaceDetailsDialog: () => {},
      rosterRefreshAttemptedAt: 0,
      pendingRefreshGate: { resetCooldown: () => {} },
      unknownAgentCandidates: new Set(),
      settledUnknownAgents: new Set(),
      stopPendingPoll: () => {},
      disposeCleanup: () => {},
      disposeSeatAdminDialog: () => {},
      resetHomeWorkspace: () => {},
      homeWorkClaims: [],
      homePeopleReadState: "pending",
      syncConnectWorkspace: () => {},
      requestVersion: 0,
      startAgentActivity: () => {},
      startFeedPush: () => {},
      agents: [],
      members: [],
      pendingInvites: [],
      accessStatuses: [],
      pendingAgents: [],
      pendingAgentsLoadFailed: false,
      renderedPendingAccessKey: "",
      syncPendingPoll: () => {},
      people: new Map(),
      removedAgents: new Map(),
      removedAgentOwners: new Map(),
      signals: [],
      deliveryReceiptCache: new Map(),
      deliveryReceiptRefreshOwner: "",
      resetMessageStatus: () => {},
      resetChoices: () => {},
      resetSignalMentions: () => {},
      resetSignalReactions: () => {},
      files: [],
      fileLoadError: "",
      signalFilter: "all",
      channels: [],
      channelListFailed: false,
      channelsLoaded: false,
      channelListReadAt: 0,
      channelUnreadRows: null,
      channelUnreadGeneration: 0,
      railArchivedOpen: false,
      railExpanded: false,
      readRailExpanded: () => false,
      activeChannelId: null,
      unknownChannelId: null,
      postedSinceReset: new Map(),
      disarmChannelArchive: () => {},
      signalCursor: null,
      signalHasMore: false,
      signalCutoff: "",
      channelLoadError: "",
      setLoading: () => {},
      channelReadGeneration: 0,
      removedAgentNames: async () => new Map(),
      readRemovedAgentOwners: async () => new Map(),
      homeWorkingOn: async () => [],
      roster: async () => [],
      memberRoster: async () => ({ names: new Map([["person", "Alex"]]), members: [] }),
      pendingMemberInvites: async () => [],
      agentAccessStatuses: async () => [],
      loadPendingAccess: async (fn: () => Promise<unknown>) => ({ rows: await fn(), failed: false }),
      pendingAgentAccess: async () => [],
      workspaceFiles: async () => [sampleFile],
      workspaceChannels: async () => [],
      readableError: (err: unknown) => err instanceof Error ? err.message : String(err),
      wakeRosterLastFetchedAt: 0,
      loadHomeWorkspace: async () => {},
      refreshChannelUnread: async () => {},
      applyChannelFromUrl: () => {},
      syncChannelUrl: () => {},
      freshInviteWorkspaceId: "",
      freshInviteId: "",
      shouldRetireFreshInvite: () => false,
      retireFreshInviteResult: () => {},
      addAgentViewOpen: () => false,
      renderChannel: () => { rendered.push("channel"); },
      renderMembers: () => {},
      renderPendingAccess: () => {},
      renderFiles: () => { rendered.push(`files:${ctx.files.length}:${ctx.fileLoadError}`); },
      renderBrain: () => { rendered.push(`brain:${ctx.files.length}:${ctx.fileLoadError}`); },
      renderHomeRail: () => {},
      renderHomeShell: () => {},
      renderHomeSide: () => {},
      loadSignals: async () => {},
      applyHomePane: () => { rendered.push("applyHomePane"); },
      showChannelView: (view: string) => { rendered.push(`view:${view}`); },
      ...overrides,
    };
    return { ctx, rendered, feedError };
  };

  const openSource = `${section(script, "const openWorkspace =", "const openAgentChoice =")}; openWorkspace;`;

  // 1. A transient invite/access status failure does not discard loaded files or fail the workspace open.
  {
    const { ctx, rendered } = makeCtx({
      pendingMemberInvites: async () => { throw new Error("invites timed out"); },
    });
    const openWorkspace = execute(openSource, ctx);
    await openWorkspace("workspace");
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.fileLoadError, "");
    assert.equal(ctx.pendingAgentsLoadFailed, true);
    assert.equal(ctx.channelLoadError, "");
    assert.ok(rendered.includes("files:1:"));
    assert.ok(rendered.includes("applyHomePane"));
  }

  // 2. A roster failure still commits the loaded files before surfacing the feed error.
  {
    const { ctx, rendered } = makeCtx({
      roster: async () => { throw new Error("roster unavailable"); },
    });
    const openWorkspace = execute(openSource, ctx);
    await openWorkspace("workspace");
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.fileLoadError, "");
    assert.equal(ctx.channelLoadError, "roster unavailable");
    assert.ok(rendered.includes("files:1:"));
    assert.ok(rendered.includes("view:feed-error"));
  }

  // 3. When workspaceFiles itself fails alongside a sibling failure, fileLoadError is set for the retry UI rather than leaving an empty state.
  {
    const { ctx, rendered } = makeCtx({
      roster: async () => { throw new Error("roster unavailable"); },
      workspaceFiles: async () => { throw new Error("Could not load files."); },
    });
    const openWorkspace = execute(openSource, ctx);
    await openWorkspace("workspace");
    assert.equal(ctx.files.length, 0);
    assert.equal(ctx.fileLoadError, "Could not load files. The signal feed is still available.");
    assert.ok(rendered.includes("files:0:Could not load files. The signal feed is still available."));
  }
});

test("standalone Invite someone page leads with workspace and email, drops the eyebrow, and keeps disclosure beside Create invite link", () => {
  const invite = section(markup, 'data-channel-view="invite"', "</section>");
  assert.doesNotMatch(invite, /dashboard__eyebrow/, "repeated Invite someone eyebrow is removed");
  const workspaceIdx = invite.indexOf("data-invite-workspace");
  const emailIdx = invite.indexOf('for="dashboard-invite-email"');
  const submitIdx = invite.indexOf("data-invite-submit");
  const hintIdx = invite.indexOf('id="dashboard-invite-email-hint"');
  const formEndIdx = invite.indexOf("</form>");
  const prereqIdx = invite.indexOf("dashboard__invite-prerequisite");
  const settingIdx = invite.indexOf('data-workspace-view="objects"');
  assert.ok(workspaceIdx > 0 && workspaceIdx < emailIdx, "workspace name precedes Their email");
  assert.ok(emailIdx < submitIdx && submitIdx < hintIdx && hintIdx < formEndIdx, "disclosure sits beside Create invite link inside the form");
  assert.ok(formEndIdx < prereqIdx && prereqIdx < settingIdx, "prerequisite and Open Lists & docs sit after the form");
  const hint = section(invite, 'id="dashboard-invite-email-hint"', "</p>");
  assert.match(hint, /email they sign in with/i);
  assert.match(hint, /earlier messages,[\s\S]*lists and files/i);
  assert.match(hint, /not your other workspaces/i);
});

test("turn-off-key pins the opened key, reuses one command id per question, cancels cleanly, and refuses across replacement", async () => {
  const dom = approvalDom();
  const doc = dom.doc as any;
  const focused: any[] = [];
  const makeDialog = () => {
    const dialog: any = doc.createElement("dialog");
    dialog.open = false;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    dialog.closest = () => null;
    dialog.toggleAttribute = (name: string, force?: boolean) => { if (force) dialog.attributes[name] = ""; else delete dialog.attributes[name]; };
    return dialog;
  };
  const origCreate = doc.createElement;
  doc.createElement = (tag: string) => {
    const el: any = origCreate(tag);
    el.focus = () => { focused.push(el); };
    el.closest = () => null;
    el.isConnected = true;
    el.getClientRects = () => [{}];
    return el;
  };
  doc.querySelector = () => null;
  doc.body = doc.createElement("body");
  const dialog = makeDialog();
  const opener: any = doc.createElement("button");
  opener.dataset.pdFocus = "turn-off-key-principal";
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const principalId = "22222222-2222-4222-8222-222222222222";
  const userId = "33333333-3333-4333-8333-333333333333";
  const grant1 = "44444444-4444-4444-8444-444444444441";
  const token1 = "55555555-5555-4555-8555-555555555551";
  const grant2 = "44444444-4444-4444-8444-444444444442";
  const token2 = "55555555-5555-4555-8555-555555555552";

  const makeAgent = (grantId: string, tokenId: string) => ({
    principalId, ownerUserId: userId, name: "Sprout", transport: "local",
    work: { facts: { transport: "local", renewal_grant_id: grantId, token_id: tokenId } },
  });
  const makeGrant = (grantId: string, tokenId: string) => ({
    workspaceId, principalId, ownerUserId: userId, grantId, tokenId,
  });

  let ids = 0, lose = false;
  const revocations: any[] = [], reloads: any[] = [];
  const ctx: any = {
    session: { user: { id: userId } },
    activeWorkspaceId: workspaceId,
    agents: [makeAgent(grant1, token1)],
    accessStatuses: [makeGrant(grant1, token1)],
    peopleDialogModel: () => ({
      sample: false, workspaceName: "Herb garden", people: [], invites: [],
      agents: [{ id: principalId, name: "Sprout", hosted: false, liveKey: true, own: true, mayManage: true }],
    }),
    peopleDialogCanAct, homeConnectionAccess, homeConnectionTokenMatches, showPeopleConfirmation,
    one: (sel: string) => sel === "[data-people-confirm]" ? dialog : null,
    uuid: () => `cmd-${++ids}`,
    readableError: (error: Error) => error.message,
    revokeAgentToken: async (_session: any, commandId: string, wsId: string, tokenId: string) => {
      revocations.push({ commandId, wsId, tokenId });
      if (lose) throw new Error("The result is unknown.");
    },
    reloadPeopleDialog: async (wsId: string, id: string, receipt: string, action: string) => {
      reloads.push({ wsId, id, receipt, action });
    },
    peopleDialogFocusTarget: () => opener,
  };
  const actions = execute(`${section(script, "const peopleDialogAction = async", "/** Open above the current view")}; ({ peopleDialogAction, confirmPeopleDialogAction });`, ctx);

  // 1. Both cancel paths (Go back and Escape) send nothing and return focus to opener.
  actions.confirmPeopleDialogAction("turn-off-key", principalId, opener);
  assert.equal(dialog.open, true);
  let buttons = dialog.querySelectorAll("button");
  assert.equal(buttons[0].textContent, "Go back");
  assert.equal(focused.at(-1), buttons[0], "Go back is focused on open");
  buttons[0].click();
  assert.equal(dialog.open, false);
  assert.equal(focused.at(-1), opener, "Go back returns focus to opener");
  assert.equal(revocations.length, 0, "Go back sends nothing");

  actions.confirmPeopleDialogAction("turn-off-key", principalId, opener);
  assert.equal(dialog.open, true);
  let prevented = false, stopped = false;
  dialog.oncancel({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented && stopped, true);
  assert.equal(dialog.open, false);
  assert.equal(focused.at(-1), opener, "Escape returns focus to opener");
  assert.equal(revocations.length, 0, "Escape sends nothing");

  // 2. Held question across same-agent key replacement (T1 -> T2) refuses with zero sends.
  actions.confirmPeopleDialogAction("turn-off-key", principalId, opener);
  assert.equal(dialog.open, true);
  ctx.agents = [makeAgent(grant2, token2)];
  ctx.accessStatuses = [makeGrant(grant2, token2)];
  buttons = dialog.querySelectorAll("button");
  await buttons[1].events.get("click")?.();
  assert.equal(revocations.length, 0, "replacement key must never be revoked by an earlier question");
  assert.equal(dialog.open, true, "dialog stays open to show refusal");
  assert.match(dialog.querySelectorAll("p").find((p: any) => p.attributes.role === "alert")?.textContent ?? "", /This key has changed/);
  buttons[0].click();

  // 3. Held question when key disappears / cannot be verified refuses with zero sends.
  ctx.agents = [makeAgent(grant1, token1)];
  ctx.accessStatuses = [makeGrant(grant1, token1)];
  actions.confirmPeopleDialogAction("turn-off-key", principalId, opener);
  ctx.accessStatuses = [];
  buttons = dialog.querySelectorAll("button");
  await buttons[1].events.get("click")?.();
  assert.equal(revocations.length, 0, "unverifiable key sends nothing");
  buttons[0].click();

  // 4. One correctly targeted send + retry after lost answer reuses the same command ID and pinned token.
  ctx.agents = [makeAgent(grant1, token1)];
  ctx.accessStatuses = [makeGrant(grant1, token1)];
  actions.confirmPeopleDialogAction("turn-off-key", principalId, opener);
  buttons = dialog.querySelectorAll("button");
  lose = true;
  await buttons[1].events.get("click")?.();
  assert.equal(dialog.open, true, "lost answer keeps question open for safe retry");
  assert.equal(revocations.length, 1);
  lose = false;
  await buttons[1].events.get("click")?.();
  assert.equal(dialog.open, false);
  assert.equal(revocations.length, 2);
  assert.equal(revocations[0].commandId, revocations[1].commandId, "retrying the same question reuses the same command ID");
  assert.equal(revocations[0].tokenId, token1);
  assert.equal(revocations[1].tokenId, token1);
  assert.match(reloads[0].receipt, /stopped immediately for new requests/);
});

test("remove-person confirmation names the workspace, reuses one command ID, and sends nothing on cancel or stale roster", async () => {
  const { peopleDialogCanAct, showPeopleConfirmation } = await import("../../lib/people-dialog-view.ts");
  const { doc } = approvalDom();
  const focused: any[] = [];
  const makeDialog = () => {
    const dialog: any = doc.createElement("dialog");
    dialog.open = false;
    dialog.ownerDocument = doc;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    dialog.closest = () => null;
    dialog.toggleAttribute = (name: string, force?: boolean) => { if (force) dialog.attributes[name] = ""; else delete dialog.attributes[name]; };
    return dialog;
  };
  const origCreate = doc.createElement;
  doc.createElement = (tag: string) => {
    const el: any = origCreate(tag);
    el.focus = () => { focused.push(el); };
    el.closest = () => null;
    el.isConnected = true;
    el.getClientRects = () => [{}];
    return el;
  };
  doc.querySelector = () => null;
  doc.body = doc.createElement("body");
  const dialog = makeDialog();
  const opener: any = doc.createElement("button");
  opener.dataset.pdFocus = "remove-person-sam";
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const workspaceName = "Rivera household & studio — shared with everyone, including the agents";
  const viewerId = "22222222-2222-4222-8222-222222222222";
  const targetId = "33333333-3333-4333-8333-333333333333";

  let ids = 0, lose = false, mayRemove = true;
  const removals: any[] = [], reloads: any[] = [];
  const ctx: any = {
    session: { user: { id: viewerId } },
    activeWorkspaceId: workspaceId,
    workspaces: [{ id: workspaceId, name: workspaceName }],
    members: [{ userId: viewerId, name: "Ana Rivera" }, { userId: targetId, name: "Sam Rivera" }],
    agents: [],
    accessStatuses: [],
    peopleDialogModel: () => ({
      sample: false, workspaceName, agents: [], invites: [],
      people: [
        { id: viewerId, name: "Ana Rivera", role: "owner", own: true, mayRemove: false },
        ...(ctx.members.some((m: any) => m.userId === targetId)
          ? [{ id: targetId, name: "Sam Rivera", role: "member", own: false, mayRemove }]
          : []),
      ],
    }),
    peopleDialogCanAct, showPeopleConfirmation,
    one: (sel: string) => sel === "[data-people-confirm]" ? dialog : null,
    uuid: () => `cmd-${++ids}`,
    readableError: (error: Error) => error.message,
    removeWorkspaceMember: async (_session: any, commandId: string, wsId: string, memberUserId: string) => {
      removals.push({ commandId, wsId, memberUserId });
      if (lose) throw new Error("The result is unknown.");
    },
    reloadPeopleDialog: async (wsId: string, id: string, receipt: string, action: string) => {
      reloads.push({ wsId, id, receipt, action });
    },
    peopleDialogFocusTarget: () => opener,
  };
  const actions = execute(`${section(script, "const peopleDialogAction = async", "/** Open above the current view")}; ({ peopleDialogAction, confirmPeopleDialogAction });`, ctx);

  // 1. Heading names the workspace; Go back and Escape both return focus and send nothing.
  actions.confirmPeopleDialogAction("remove-person", targetId, opener);
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelectorAll("h2")[0]?.textContent, `Remove Sam Rivera from ${workspaceName}?`);
  assert.equal(dialog.querySelectorAll("li").filter((li: any) => li.className === "stop").length, 2);
  assert.equal(dialog.querySelectorAll("li").filter((li: any) => li.className === "keep").length, 0);
  assert.equal(dialog.querySelectorAll("p").find((p: any) => p.className === "pd-confirm-note")?.textContent,
    "Workspace history stays. They keep their other memberships.");
  let buttons = dialog.querySelectorAll("button");
  assert.equal(buttons[0].textContent, "Go back");
  assert.equal(focused.at(-1), buttons[0], "Go back is focused on open");
  buttons[0].click();
  assert.equal(dialog.open, false);
  assert.equal(focused.at(-1), opener, "Go back returns focus to opener");
  assert.equal(removals.length, 0);

  actions.confirmPeopleDialogAction("remove-person", targetId, opener);
  let prevented = false, stopped = false;
  dialog.oncancel({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.equal(prevented && stopped, true);
  assert.equal(dialog.open, false);
  assert.equal(focused.at(-1), opener, "Escape returns focus to opener");
  assert.equal(removals.length, 0);

  // 2. Held question refuses with zero sends if member disappears or loses removal permission.
  actions.confirmPeopleDialogAction("remove-person", targetId, opener);
  mayRemove = false;
  buttons = dialog.querySelectorAll("button");
  await buttons[1].events.get("click")?.();
  assert.equal(removals.length, 0, "lost permission must not send removal");
  assert.equal(dialog.open, true);
  buttons[0].click();

  mayRemove = true;
  actions.confirmPeopleDialogAction("remove-person", targetId, opener);
  ctx.members = [{ userId: viewerId, name: "Ana Rivera" }];
  buttons = dialog.querySelectorAll("button");
  await buttons[1].events.get("click")?.();
  assert.equal(removals.length, 0, "already-removed person must not send removal");
  buttons[0].click();

  // 3. Confirmed removal and lost-answer retry reuse the same questionId and produce workspace-named receipt.
  ctx.members = [{ userId: viewerId, name: "Ana Rivera" }, { userId: targetId, name: "Sam Rivera" }];
  actions.confirmPeopleDialogAction("remove-person", targetId, opener);
  buttons = dialog.querySelectorAll("button");
  lose = true;
  await buttons[1].events.get("click")?.();
  assert.equal(dialog.open, true);
  assert.equal(removals.length, 1);
  lose = false;
  await buttons[1].events.get("click")?.();
  assert.equal(dialog.open, false);
  assert.equal(removals.length, 2);
  assert.equal(removals[0].commandId, removals[1].commandId, "retrying the same question reuses one command ID");
  assert.equal(removals[0].wsId, workspaceId);
  assert.equal(removals[0].memberUserId, targetId);
  assert.equal(reloads[0].receipt, `Sam Rivera removed from ${workspaceName}. They keep their other memberships.`);
});

test("cancel-invite confirmation identifies each invite kind, keeps Go back focused, cancels with zero sends, and reuses one command ID", async () => {
  const { peopleDialogCanAct, showPeopleConfirmation } = await import("../../lib/people-dialog-view.ts");
  const { cancelPeopleInvite, peopleInviteReceipt } = await import("../../lib/people-invites.ts");
  const { doc } = approvalDom();
  const focused: any[] = [];
  const makeDialog = () => {
    const dialog: any = doc.createElement("dialog");
    dialog.open = false;
    dialog.ownerDocument = doc;
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    dialog.closest = () => null;
    dialog.toggleAttribute = (name: string, force?: boolean) => { if (force) dialog.attributes[name] = ""; else delete dialog.attributes[name]; };
    return dialog;
  };
  const origCreate = doc.createElement;
  doc.createElement = (tag: string) => {
    const el: any = origCreate(tag);
    el.focus = () => { focused.push(el); };
    el.closest = () => null;
    el.isConnected = true;
    el.getClientRects = () => [{}];
    return el;
  };
  doc.querySelector = () => null;
  doc.body = doc.createElement("body");
  const dialog = makeDialog();
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const workspaceName = "Herb garden";
  const viewerId = "22222222-2222-4222-8222-222222222222";
  const invites = [
    { kind: "person", id: "inv-1", workspaceId, name: "mei@example.test", detail: "You invited · 2 days ago · ends in 5 days", mayCancel: true },
    { kind: "key", id: "key-1", workspaceId, name: "Sprout", detail: "Sam’s agent · made 3 days ago · ends in 4 days", mayCancel: true },
    { kind: "code", id: "code-1", workspaceId, name: "Connect code", detail: "Sam made it · 2 hours ago · 1 of 3 places used · ends in 22 hours", mayCancel: true },
  ];

  let ids = 0, lose = false;
  const sent: any[] = [], reloads: any[] = [];
  const ctx: any = {
    session: { user: { id: viewerId } },
    activeWorkspaceId: workspaceId,
    workspaces: [{ id: workspaceId, name: workspaceName }],
    members: [], agents: [], accessStatuses: [],
    activeInvites: [...invites],
    peopleDialogModel: () => ({ sample: false, workspaceName, people: [], agents: [], invites: ctx.activeInvites }),
    peopleDialogCanAct, showPeopleConfirmation, cancelPeopleInvite, peopleInviteReceipt,
    one: (sel: string) => sel === "[data-people-confirm]" ? dialog : null,
    uuid: () => `cmd-${++ids}`,
    readableError: (error: Error) => error.message,
    revokeWorkspaceInvitation: async (_s: any, commandId: string, wsId: string, id: string) => { sent.push({ kind: "person", commandId, wsId, id }); if (lose) throw new Error("lost"); },
    revokeAgentToken: async (_s: any, commandId: string, wsId: string, id: string) => { sent.push({ kind: "key", commandId, wsId, id }); if (lose) throw new Error("lost"); },
    revokeAgentJoinCredential: async (_s: any, commandId: string, wsId: string, id: string) => { sent.push({ kind: "code", commandId, wsId, id }); if (lose) throw new Error("lost"); },
    reloadPeopleDialog: async (wsId: string, id: string, receipt: string, action: string) => { reloads.push({ wsId, id, receipt, action }); },
    peopleDialogFocusTarget: () => null,
  };
  const actions = execute(`${section(script, "const peopleDialogAction = async", "/** Open above the current view")}; ({ peopleDialogAction, confirmPeopleDialogAction });`, ctx);

  for (const invite of invites) {
    const opener: any = doc.createElement("button");
    opener.dataset.pdFocus = `pending-${invite.kind}-${invite.id}`;
    actions.confirmPeopleDialogAction("cancel-invite", invite.id, opener);
    assert.equal(dialog.open, true);
    const title = dialog.querySelectorAll("h2")[0]?.textContent;
    const context = dialog.querySelectorAll("p").find((p: any) => p.className === "pd-confirm-context")?.textContent;
    const note = dialog.querySelectorAll("p").find((p: any) => p.className === "pd-confirm-note")?.textContent;
    if (invite.kind === "person") {
      assert.equal(title, "Cancel the invitation for mei@example.test?");
      assert.equal(context, undefined);
      assert.equal(note, "You can send a new invitation later.");
    } else if (invite.kind === "key") {
      assert.equal(title, "Cancel the key for Sprout?");
      assert.equal(context, undefined);
      assert.equal(note, "You can create a new key later.");
    } else {
      assert.equal(title, "Cancel this connect code for Herb garden?");
      assert.equal(context, invite.detail);
      assert.equal(note, "Agents that already joined with it stay. You can make a new code later.");
    }
    const buttons = dialog.querySelectorAll("button");
    assert.equal(buttons[0].textContent, "Go back");
    assert.equal(focused.at(-1), buttons[0], `Go back focused on open for ${invite.kind}`);
    let prevented = false, stopped = false;
    dialog.oncancel({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    assert.equal(prevented && stopped, true);
    assert.equal(dialog.open, false);
    assert.equal(focused.at(-1), opener, `Escape returns focus to the same ${invite.kind} row`);
    assert.equal(sent.length, 0, `Escape sends nothing for ${invite.kind}`);
  }

  // Disappeared invite refuses with zero sends.
  const codeOpener: any = doc.createElement("button");
  actions.confirmPeopleDialogAction("cancel-invite", "code-1", codeOpener);
  ctx.activeInvites = invites.slice(0, 2);
  await dialog.querySelectorAll("button")[1].events.get("click")?.();
  assert.equal(sent.length, 0, "missing invite sends nothing");
  dialog.querySelectorAll("button")[0].click();

  // Confirmed cancel + lost-answer retry reuses one command ID for the exact row kind.
  ctx.activeInvites = [...invites];
  actions.confirmPeopleDialogAction("cancel-invite", "code-1", codeOpener);
  const buttons = dialog.querySelectorAll("button");
  lose = true;
  await buttons[1].events.get("click")?.();
  assert.equal(dialog.open, true);
  assert.equal(sent.length, 1);
  lose = false;
  await buttons[1].events.get("click")?.();
  assert.equal(dialog.open, false);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].commandId, sent[1].commandId, "retry reuses one command ID");
  assert.deepEqual(sent[0], { kind: "code", commandId: sent[0].commandId, wsId: workspaceId, id: "code-1" });
  assert.equal(reloads[0].receipt, "Connect code canceled.");
});
