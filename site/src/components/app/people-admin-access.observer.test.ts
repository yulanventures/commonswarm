/**
 * The dashboard's own Admins-tab functions, lifted from LiveDashboard.astro and run on synthetic rows: what is read
 * for whom, what a workspace switch does to a read in flight, and what Remove sends.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { peopleAdminCoverage, peopleAdminLabel, WorkspaceAdminGrantsRefused } from "../../lib/people/admins";

const NAMES = ["peopleAdminKey", "currentPeopleAdminAccess", "ownPeopleAdminGrants", "loadPeopleAdminAccess", "endPeopleAdminGrant", "closeRosterDialog"];

async function dashboardFunctions(names: string[]): Promise<string> {
  const raw = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert.ok(script);
  const ast = ts.createSourceFile("dashboard.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text) && !found.has(node.name.text)) found.set(node.name.text, `const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const name of names) assert.ok(found.has(name), `production declaration ${name}`);
  return ts.transpileModule(names.map(name => found.get(name)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const plain = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const grant = (n: number, over: Record<string, unknown> = {}) => ({ grantId: `g${n}`, principalId: `p${n}`, agentName: `Agent ${n}`, giverId: "u2", giverName: "Sam Rivera",
  level: "workspace", expiresAt: null, mayEnd: true, ...over });

/** One page: account u1 in workspace w1, the dialog open. */
async function page(options: { role?: string; enabled?: boolean } = {}) {
  const calls: string[] = []; const ends: Array<{ commandId: string; grantId: string }> = []; const events: string[] = [];
  let token = 0;
  const receipt = { textContent: "" };
  const io: { all: null | (() => Promise<unknown>); end: null | (() => Promise<any>); confirm: boolean | "hold"; held: null | (() => void) } = { all: null, end: null, confirm: true, held: null };
  const context = createContext({
    peopleAdminCoverage, peopleAdminLabel, WorkspaceAdminGrantsRefused, URLSearchParams, uuid: () => `cmd-${++token}`, CustomEvent: class { constructor(public type: string) {} },
    __events: events,
    readWorkspaceAdminGrants: async () => { calls.push("all"); return io.all ? io.all() : [grant(1), grant(2, { level: "organization", mayEnd: false })]; },
    refreshSeatAdminState: async () => { calls.push("mine"); runInContext(`seatAdminStatusState = { phase: "loaded", status: { enabled: ${options.enabled !== false} } };
      seatAdminGrantsState = { phase: "loaded", grants: [
        { grantId: "MINE-1", principalId: "A1", level: "workspace", workspaceIds: ["W1"], expiresAt: null, state: "active" },
        { grantId: "mine-2", principalId: "a1", level: "workspace", workspaceIds: ["other"], expiresAt: null, state: "active" },
        { grantId: "mine-3", principalId: "gone", level: "organization", organizationId: "org-1", workspaceIds: [], expiresAt: null, state: "active" },
        { grantId: "org-here", principalId: "a1", level: "organization", organizationId: "ORG-1", workspaceIds: [], expiresAt: null, state: "active" },
        { grantId: "org-other", principalId: "a1", level: "organization", organizationId: "org-2", workspaceIds: [], expiresAt: null, state: "active" },
        { grantId: "org-unknown", principalId: "a1", level: "organization", organizationId: null, workspaceIds: [], expiresAt: null, state: "active" },
        { grantId: "mine-4", principalId: "a1", level: "workspace", workspaceIds: ["w1"], expiresAt: null, state: "ended" }] };`, context); },
    endSeatAdmin: async (_session: unknown, commandId: string, grantId: string) => { ends.push({ commandId, grantId }); return io.end ? io.end() : { kind: "accepted" }; },
    buildSeatAdminEndConfirmation: (_doc: unknown, opts: { confirm(): void; cancel(): void; agentName: string; level: string; coverage: string[]; restoredBy?: string }) => {
      calls.push(`ask:${opts.agentName}:${opts.level}:${opts.coverage.join("|")}`); calls.push(`restoredBy:${opts.restoredBy}`);
      // "hold": the question stays open; the test presses End access later through io.held.
      return { dialog: { remove() {} }, open() { if (io.confirm === "hold") io.held = () => opts.confirm(); else if (io.confirm) opts.confirm(); else opts.cancel(); } };
    },
    disposeSeatAdminDialog: () => {}, renderDialogRoster: () => {}, document: {}, app: { append() {} },
    one: (selector: string) => (selector === "[data-roster-dialog]" ? { get open() { return runInContext("dialogOpen", context); }, close() { runInContext("dialogOpen = false", context); }, querySelectorAll: () => [] }
      : selector === "[data-people-receipt]" ? receipt : null),
    all: () => [], parkPeopleHosts: () => {}, erasePeopleDialogInvite: () => {},
    seatAdminRemoveCommandIds: new Map(),
  });
  runInContext(`
    var session = { user: { id: "u1" } }, activeWorkspaceId = "w1", sampleMode = false;
    var workspaces = [{ id: "w1", name: "Rivera household", orgId: "org-1" }, { id: "w2", name: "Studio", orgId: "org-2" }, { id: "w3", name: "Unknown", orgId: "" }], members = [{ userId: "u1", role: "${options.role ?? "owner"}" }], agents = [{ principalId: "a1", name: "Atlas" }];
    var seatAdminStatusState = { phase: "idle" }, seatAdminGrantsState = { phase: "idle" };
    var peopleAdminAccess = { key: "", access: undefined }, peopleAdminGeneration = 0, peopleAdminDialogLifetime = 0, peopleAdminEnding = new Set(), activeSeatAdminEndDialog = null;
    var dialogOpen = true;
    var peopleDialogReturn = null, peopleDialogFocus = undefined, peopleDialogInviteCleared = null, peopleDialogState = { selected: null, invite: null };
    var window = { location: { search: "" }, history: { state: null, replaceState() {} }, dispatchEvent: (event) => { __events.push(event.type); } };
  `, context);
  runInContext(`var peopleDialogOpen = () => dialogOpen === true;`, context);
  runInContext(await dashboardFunctions(NAMES), context);
  const run = <T>(code: string): T => runInContext(code, context) as T;
  return { run, calls, ends, events, io, receipt };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test("an owner reads every grant on record; anyone else only what they gave; off means nothing is read", async () => {
  const owner = await page();
  await owner.run("loadPeopleAdminAccess()");
  assert.deepEqual(plain(owner.run("currentPeopleAdminAccess()")), { read: "ready", all: true, grants: [grant(1), grant(2, { level: "organization", mayEnd: false })], notices: {} });

  const member = await page({ role: "admin" });
  await member.run("loadPeopleAdminAccess()");
  assert.ok(!member.calls.includes("all"), "a non-owner never asks for the workspace's whole list");
  const own = plain(member.run<any>("currentPeopleAdminAccess()"));
  assert.equal(own.all, false);
  assert.deepEqual(own.grants.map((row: any) => [row.grantId, row.level]), [["mine-1", "workspace"], ["org-here", "organization"]],
    "only active grants for this workspace or its own organization, for agents in its roster");
  assert.deepEqual(own.grants[0], { grantId: "mine-1", principalId: "a1", agentName: "Atlas", giverId: "u1", giverName: null, level: "workspace", expiresAt: null, mayEnd: true });

  const off = await page({ enabled: false });
  await off.run("loadPeopleAdminAccess()");
  assert.equal(off.run("currentPeopleAdminAccess()"), undefined); assert.ok(!off.calls.includes("all"), "agent admin access is off: no read, and the tab lists people only");
});

test("a server answer of null (not an owner, or the read not deployed yet) falls back to the viewer's own grants", async () => {
  const p = await page(); p.io.all = async () => null;
  await p.run("loadPeopleAdminAccess()");
  const access = plain(p.run<any>("currentPeopleAdminAccess()"));
  assert.equal(access.all, false); assert.deepEqual(access.grants.map((row: any) => row.grantId), ["mine-1", "org-here"]);
});

test("a failed read keeps what was shown and says so; a read that lands after a workspace switch is dropped", async () => {
  const p = await page();
  await p.run("loadPeopleAdminAccess()");
  p.io.all = async () => { throw new Error("down"); };
  await p.run("loadPeopleAdminAccess()");
  const failed = plain(p.run<any>("currentPeopleAdminAccess()"));
  assert.equal(failed.read, "failed"); assert.equal(failed.grants.length, 2, "the last good rows stay under the could-not-load line");

  const moved = await page(); let release!: (rows: unknown) => void;
  moved.io.all = () => new Promise(resolve => { release = resolve; });
  const loading = moved.run<Promise<void>>("loadPeopleAdminAccess()"); await settle();
  moved.run("activeWorkspaceId = 'w2'"); release([grant(9)]); await loading;
  assert.equal(moved.run("currentPeopleAdminAccess()"), undefined, "the other workspace never shows these rows");
  moved.run("activeWorkspaceId = 'w1'");
  assert.notDeepEqual(plain(moved.run<any>("currentPeopleAdminAccess()"))?.grants, [grant(9)], "and they were not stored for the first one after it was left");
});

test("Remove asks with the grant's reach, ends that grant by id, reads again and tells the other surfaces", async () => {
  const p = await page();
  await p.run("loadPeopleAdminAccess()"); p.calls.length = 0;
  p.io.all = async () => [grant(2, { level: "organization", mayEnd: false })];
  p.run("endPeopleAdminGrant('g1', {})"); await settle(); await settle();
  assert.deepEqual(p.calls.filter(call => call.startsWith("ask")), ["ask:Agent 1:workspace:Rivera household"]);
  assert.deepEqual(p.ends, [{ commandId: "cmd-1", grantId: "g1" }]);
  assert.deepEqual(p.events, ["commonswarm:seat-admin-changed"]);
  assert.deepEqual(plain(p.run<any>("currentPeopleAdminAccess()")).grants.map((row: any) => row.grantId), ["g2"], "the list was read again");
  p.run("endPeopleAdminGrant('g2', {})"); await settle();
  assert.equal(p.ends.length, 1, "no Remove where the server said it would refuse");
});

test("declining the question sends nothing; an unknown outcome keeps its command id; a refusal is shown on the row", async () => {
  const p = await page();
  await p.run("loadPeopleAdminAccess()");
  p.io.confirm = false; p.run("endPeopleAdminGrant('g1', {})"); await settle();
  assert.equal(p.ends.length, 0);
  p.io.confirm = true; p.io.end = async () => ({ kind: "unknown", message: "The result is unknown. Check the list before trying again." });
  p.run("endPeopleAdminGrant('g1', {})"); await settle(); await settle();
  assert.equal(plain(p.run<any>("currentPeopleAdminAccess()")).notices.g1, "The result is unknown. Check the list before trying again.");
  p.run("endPeopleAdminGrant('g1', {})"); await settle(); await settle();
  assert.deepEqual(p.ends.map(end => end.commandId), ["cmd-1", "cmd-1"], "pressing Remove again repeats the same command");
  assert.deepEqual(p.events, [], "nothing is announced as changed until an end is accepted");
  p.io.end = async () => ({ kind: "refused", message: "Only its owner can end this." });
  p.run("endPeopleAdminGrant('g1', {})"); await settle(); await settle();
  assert.equal(plain(p.run<any>("currentPeopleAdminAccess()")).notices.g1, "Only its owner can end this.");
  p.io.end = null; p.io.all = async () => [];
  p.run("endPeopleAdminGrant('g1', {})"); await settle(); await settle();
  assert.equal(p.ends[3].commandId, "cmd-2", "a refusal spent its command id; the next try is a new command");
  assert.deepEqual(p.events, ["commonswarm:seat-admin-changed"]);
});

test("the fallback lists an organization grant only in that organization's own workspaces", async () => {
  // The same agent sits in both workspaces, which belong to different organizations.
  const p = await page({ role: "admin" });
  await p.run("loadPeopleAdminAccess()");
  const ids = () => plain(p.run<any>("currentPeopleAdminAccess()")).grants.map((row: any) => row.grantId);
  assert.deepEqual(ids(), ["mine-1", "org-here"], "in organization 1: its grant, not organization 2's");
  p.run("closeRosterDialog(); activeWorkspaceId = 'w2'; members = [{ userId: 'u1', role: 'admin' }]"); await p.run("loadPeopleAdminAccess()");
  assert.deepEqual(ids(), ["org-other"], "in organization 2: only its own, so 'this organization' can never end the other one's grant");
  p.run("closeRosterDialog(); activeWorkspaceId = 'w3'"); await p.run("loadPeopleAdminAccess()");
  assert.deepEqual(ids(), [], "a workspace whose organization is not known lists no organization grant; a grant without one is never listed");
});

test("a refusal clears every row; a read held across leaving and coming back never lands", async () => {
  const p = await page();
  await p.run("loadPeopleAdminAccess()");
  p.io.all = async () => { throw new WorkspaceAdminGrantsRefused("no"); };
  await p.run("loadPeopleAdminAccess()");
  assert.deepEqual(plain(p.run("currentPeopleAdminAccess()")), { read: "failed", all: false, grants: [], notices: {} }, "signed out or not allowed: nothing shown before stays");

  const back = await page(); let release!: (rows: unknown) => void;
  back.io.all = () => new Promise(resolve => { release = resolve; });
  const loading = back.run<Promise<void>>("loadPeopleAdminAccess()"); await settle();
  // A workspace switch, a sign-out and a dead session all close the dialog before anything else.
  back.run("closeRosterDialog(); activeWorkspaceId = 'w2'"); back.run("closeRosterDialog(); activeWorkspaceId = 'w1'");
  release([grant(9)]); await loading;
  assert.equal(back.run("currentPeopleAdminAccess()"), undefined, "back in the first workspace with no new read: the old read is not accepted");
});

test("a question held open across a changed list sends nothing", async () => {
  for (const [why, change] of [
    ["the grant left the list", async (p: any) => { p.io.all = async () => [grant(2)]; await p.run("loadPeopleAdminAccess()"); }],
    ["the server would no longer accept an end", async (p: any) => { p.io.all = async () => [grant(1, { mayEnd: false })]; await p.run("loadPeopleAdminAccess()"); }],
    ["the read was refused", async (p: any) => { p.io.all = async () => { throw new WorkspaceAdminGrantsRefused("no"); }; await p.run("loadPeopleAdminAccess()"); }],
    ["the read failed and the rows are only kept to look at", async (p: any) => { p.io.all = async () => { throw new Error("down"); }; await p.run("loadPeopleAdminAccess()"); }],
    ["the workspace changed", async (p: any) => { p.run("closeRosterDialog(); activeWorkspaceId = 'w2'"); }],
    ["the account changed", async (p: any) => { p.run("session = { user: { id: 'u9' } }"); }],
  ] as const) {
    const p = await page();
    await p.run("loadPeopleAdminAccess()");
    p.io.confirm = "hold"; p.run("endPeopleAdminGrant('g1', {})"); assert.ok(p.io.held, why);
    await change(p);
    p.io.held!(); await settle(); await settle();
    assert.equal(p.ends.length, 0, `no command when ${why}`); assert.deepEqual(p.events, [], why);
    // Where the row is still on screen, it says why nothing happened. The grant itself may be unchanged.
    if (why === "the server would no longer accept an end") assert.equal(plain(p.run<any>("currentPeopleAdminAccess()")).notices.g1,
      "We couldn’t verify the current admin access. No removal request was sent.");
  }
  const still = await page();
  await still.run("loadPeopleAdminAccess()");
  still.io.confirm = "hold"; still.run("endPeopleAdminGrant('g1', {})");
  await still.run("loadPeopleAdminAccess()");
  still.io.held!(); await settle(); await settle();
  assert.deepEqual(still.ends.map(end => end.grantId), ["g1"], "a refresh that still shows the same usable row lets the end go through");
});

test("rows that would read the same are told apart in the question", async () => {
  const p = await page();
  p.io.all = async () => [grant(1, { agentName: "Atlas", principalId: "aaaaaaaa-1111" }), grant(2, { agentName: "Atlas", principalId: "bbbbbbbb-2222" })];
  await p.run("loadPeopleAdminAccess()"); p.calls.length = 0;
  p.run("endPeopleAdminGrant('g2', {})"); await settle();
  assert.deepEqual(p.calls.filter(call => call.startsWith("ask")), ["ask:Atlas (agent bbbbbbbb):workspace:Rivera household"]);
});

test("a refresh in flight retires Remove: the rows stay as pending, and a question confirmed meanwhile sends nothing", async () => {
  const p = await page();
  await p.run("loadPeopleAdminAccess()");
  p.io.confirm = "hold"; p.run("endPeopleAdminGrant('g1', {})"); assert.ok(p.io.held);
  let release!: (rows: unknown) => void;
  p.io.all = () => new Promise(resolve => { release = resolve; });
  const refreshing = p.run<Promise<void>>("loadPeopleAdminAccess()"); await settle();
  const during = plain(p.run<any>("currentPeopleAdminAccess()"));
  assert.equal(during.read, "pending", "what is on screen is no longer a current list"); assert.equal(during.grants.length, 2, "the rows stay to look at");
  p.io.held!(); await settle(); await settle();
  assert.equal(p.ends.length, 0, "confirming while the read is out sends nothing, whatever the read will say");
  p.io.confirm = true; p.run("endPeopleAdminGrant('g1', {})"); await settle();
  assert.equal(p.ends.length, 0, "and Remove cannot start a new question either");
  release([grant(2)]); await refreshing;
  assert.equal(p.ends.length, 0); assert.deepEqual(p.events, []);
});

test("a Remove answered after its dialog closed is settled, but starts no read and gives no receipt to another dialog", async () => {
  for (const reopen of [false, true]) {
    const p = await page(); let answer!: (outcome: unknown) => void;
    await p.run("loadPeopleAdminAccess()");
    p.io.end = () => new Promise(resolve => { answer = resolve; });
    p.run("endPeopleAdminGrant('g1', {})"); await settle();
    assert.equal(p.ends.length, 1);
    p.run("closeRosterDialog()");
    if (reopen) { p.run("dialogOpen = true"); await p.run("loadPeopleAdminAccess()"); }
    const reads = p.calls.filter(call => call === "all").length;
    answer({ kind: "accepted" }); await settle(); await settle();
    assert.deepEqual(p.events, ["commonswarm:seat-admin-changed"], "the command is settled and the other surfaces are told");
    assert.equal(p.run("seatAdminRemoveCommandIds.size"), 0, "its command id is spent"); assert.equal(p.run("peopleAdminEnding.size"), 0);
    assert.equal(p.calls.filter(call => call === "all").length, reads, `no read is started for a dialog that ${reopen ? "is not the one that asked" : "is closed"}`);
    assert.equal(p.receipt.textContent, "", "and no receipt is announced there");
    if (reopen) assert.deepEqual(plain(p.run<any>("currentPeopleAdminAccess()")).notices, {}, "nor a notice put on its rows");
  }
  const refused = await page(); let answer!: (outcome: unknown) => void;
  await refused.run("loadPeopleAdminAccess()");
  refused.io.end = () => new Promise(resolve => { answer = resolve; });
  refused.run("endPeopleAdminGrant('g1', {})"); await settle();
  refused.run("closeRosterDialog(); dialogOpen = true"); await refused.run("loadPeopleAdminAccess()");
  answer({ kind: "refused", message: "Only its owner can end this." }); await settle(); await settle();
  assert.deepEqual(plain(refused.run<any>("currentPeopleAdminAccess()")).notices, {}, "a refusal that arrives late is not shown on the reopened dialog's row");
});

test("the question says who can give the access again: you for a grant you gave, the agent's owner for anyone else's", async () => {
  const p = await page();
  p.io.all = async () => [grant(1, { giverId: "u1" }), grant(2, { giverId: "u2" })];
  await p.run("loadPeopleAdminAccess()"); p.io.confirm = false; p.calls.length = 0;
  p.run("endPeopleAdminGrant('g1', {})"); p.run("endPeopleAdminGrant('g2', {})");
  assert.deepEqual(p.calls.filter(call => call.startsWith("restoredBy")), ["restoredBy:you", "restoredBy:owner"],
    "an owner ending another member's grant is not told they can turn it back on");
});
