/**
 * The dashboard's own Admins-tab functions, lifted from LiveDashboard.astro and run on synthetic rows: what is read
 * for whom, what a workspace switch does to a read in flight, and what Remove sends.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { peopleAdminCoverage } from "../../lib/people/admins";

const NAMES = ["peopleAdminKey", "currentPeopleAdminAccess", "ownPeopleAdminGrants", "loadPeopleAdminAccess", "endPeopleAdminGrant"];

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
  const io: { all: null | (() => Promise<unknown>); end: null | (() => Promise<any>); confirm: boolean } = { all: null, end: null, confirm: true };
  const context = createContext({
    peopleAdminCoverage, uuid: () => `cmd-${++token}`, CustomEvent: class { constructor(public type: string) {} },
    window: { dispatchEvent: (event: { type: string }) => { events.push(event.type); } },
    readWorkspaceAdminGrants: async () => { calls.push("all"); return io.all ? io.all() : [grant(1), grant(2, { level: "organization", mayEnd: false })]; },
    refreshSeatAdminState: async () => { calls.push("mine"); runInContext(`seatAdminStatusState = { phase: "loaded", status: { enabled: ${options.enabled !== false} } };
      seatAdminGrantsState = { phase: "loaded", grants: [
        { grantId: "MINE-1", principalId: "A1", level: "workspace", workspaceIds: ["W1"], expiresAt: null, state: "active" },
        { grantId: "mine-2", principalId: "a1", level: "workspace", workspaceIds: ["other"], expiresAt: null, state: "active" },
        { grantId: "mine-3", principalId: "gone", level: "organization", workspaceIds: [], expiresAt: null, state: "active" },
        { grantId: "mine-4", principalId: "a1", level: "workspace", workspaceIds: ["w1"], expiresAt: null, state: "ended" }] };`, context); },
    endSeatAdmin: async (_session: unknown, commandId: string, grantId: string) => { ends.push({ commandId, grantId }); return io.end ? io.end() : { kind: "accepted" }; },
    buildSeatAdminEndConfirmation: (_doc: unknown, opts: { confirm(): void; cancel(): void; agentName: string; level: string; coverage: string[] }) => {
      calls.push(`ask:${opts.agentName}:${opts.level}:${opts.coverage.join("|")}`);
      return { dialog: { remove() {} }, open() { if (io.confirm) opts.confirm(); else opts.cancel(); } };
    },
    disposeSeatAdminDialog: () => {}, renderDialogRoster: () => {}, peopleDialogOpen: () => true, document: {}, app: { append() {} }, one: () => null,
    seatAdminRemoveCommandIds: new Map(),
  });
  runInContext(`
    var session = { user: { id: "u1" } }, activeWorkspaceId = "w1", sampleMode = false;
    var workspaces = [{ id: "w1", name: "Rivera household" }], members = [{ userId: "u1", role: "${options.role ?? "owner"}" }], agents = [{ principalId: "a1", name: "Atlas" }];
    var seatAdminStatusState = { phase: "idle" }, seatAdminGrantsState = { phase: "idle" };
    var peopleAdminAccess = { key: "", access: undefined }, peopleAdminGeneration = 0, peopleAdminEnding = new Set(), activeSeatAdminEndDialog = null;
  `, context);
  runInContext(await dashboardFunctions(NAMES), context);
  const run = <T>(code: string): T => runInContext(code, context) as T;
  return { run, calls, ends, events, io };
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
  assert.deepEqual(own.grants, [{ grantId: "mine-1", principalId: "a1", agentName: "Atlas", giverId: "u1", giverName: null, level: "workspace", expiresAt: null, mayEnd: true }],
    "only active grants for this workspace, for agents in its roster, named from the roster");

  const off = await page({ enabled: false });
  await off.run("loadPeopleAdminAccess()");
  assert.equal(off.run("currentPeopleAdminAccess()"), undefined); assert.ok(!off.calls.includes("all"), "agent admin access is off: no read, and the tab lists people only");
});

test("a server answer of null (not an owner, or the read not deployed yet) falls back to the viewer's own grants", async () => {
  const p = await page(); p.io.all = async () => null;
  await p.run("loadPeopleAdminAccess()");
  const access = plain(p.run<any>("currentPeopleAdminAccess()"));
  assert.equal(access.all, false); assert.deepEqual(access.grants.map((row: any) => row.grantId), ["mine-1"]);
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
