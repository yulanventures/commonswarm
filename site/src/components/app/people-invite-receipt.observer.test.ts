/**
 * The dashboard's own invite functions, lifted from LiveDashboard.astro and run with synthetic links: who holds the
 * one-use link after an invite is made, and what erases it. The security review of #570 asked for this at the
 * dashboard boundary, not only at the renderer: closing, a same-workspace reload, a late answer, two surfaces at
 * once, and a list that cannot be read after an accepted create.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { isInviteSubmitCurrent, runInviteCreate } from "../../lib/invite-submit";
import { bindDialogInvite, dialogInviteCurrent, dialogInviteLink, dialogInviteNotice, settleDialogInvite } from "../../lib/people/invite-receipt";

const NAMES = ["createMemberInvite", "peopleDialogInviteScope", "erasePeopleDialogInvite", "settlePeopleDialogInvite", "peopleDialogInviteLink",
  "peopleDialogInviteNoticeText", "createPeopleDialogInvite", "closeRosterDialog", "reloadPeopleDialog"];

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

class Unknown extends Error {}

/** One page: a signed-in account in workspace w1, the dialog open on a form. Every link is synthetic. */
async function page() {
  let token = 0;
  const sent: Array<{ email: string; commandId: string }> = [];
  const removed: string[] = [];
  const io: { create: null | ((email: string) => Promise<any>); list: null | (() => Promise<any[]>) } = { create: null, list: null };
  const dialog = { open: true, close() { this.open = false; }, querySelectorAll: () => [] };
  const context = createContext({
    isInviteSubmitCurrent, runInviteCreate, bindDialogInvite, dialogInviteCurrent, dialogInviteLink, dialogInviteNotice, settleDialogInvite,
    CommandOutcomeUnknown: Unknown, NoDeployment: class extends Error {},
    uuid: () => `cmd-${++token}`,
    deployment: () => ({ url: "https://api.example.test", anonKey: "anon" }),
    accountName: () => "Ana", readableError: (error: Error) => error.message, inviteEmailValidationMessage: (email: string) => (email.includes("@") && email.includes(".") ? "" : "Enter a full email address."),
    memberInviteUrl: (_origin: string, parts: { invitation_token: string }) => `https://example.test/invite#${parts.invitation_token}`,
    inviteWorkspaceMember: async (_session: unknown, commandId: string, workspaceId: string, email: string) => {
      sent.push({ email, commandId });
      if (io.create) return io.create(email);
      return { invitationId: `inv-${sent.length}`, workspaceId, invitationToken: `synthetic-${sent.length}`, workspaceName: "Rivera", inviterDisplayName: "Ana", inviterUserId: "u1" };
    },
    pendingMemberInvites: async () => (io.list ? io.list() : sent.map((_, index) => ({ invitationId: `inv-${index + 1}` }))),
    renderPendingAccess: () => {}, disposeSeatAdminDialog: () => {}, parkPeopleHosts: () => {}, renderDialogRoster: () => {},
    peopleDialogFocusTarget: () => null, peopleDialogReceipts: new Map(),
    openWorkspace: async () => { runInContext("requestVersion += 1; pendingInvites = [];", context); },
    one: (selector: string) => (selector === "[data-roster-dialog]" ? dialog : null),
    all: (selector: string) => (selector === "[data-people-invite-made]" ? [{ remove: () => removed.push("made") }] : []),
    window: { location: { origin: "https://example.test", search: "" }, history: { state: null, replaceState() {} }, requestAnimationFrame: () => 0 },
    URLSearchParams,
  });
  runInContext(`
    var session = { user: { id: "u1" } }, activeWorkspaceId = "w1", requestVersion = 1, sampleMode = false;
    var workspaces = [{ id: "w1", name: "Rivera" }], pendingInvites = [], pendingAgentsLoadFailed = false, inviteIntent = null;
    var peopleAdminAccess = { key: "", access: undefined }, peopleAdminGeneration = 0;
    var peopleDialogInvite = null, peopleDialogInviteCleared = null, peopleDialogReturn = null, peopleDialogFocus = undefined, rosterFilter = "";
    var peopleDialogState = { selected: null, invite: { email: "", busy: false, error: "", madeId: "", copied: "" } };
    var peopleDialogOpen = () => one("[data-roster-dialog]").open === true;
    // The older page's own receipt: the dialog must never write or clear these.
    var freshInviteLink = "https://example.test/invite#older-page", freshInviteId = "inv-older", freshInviteWorkspaceId = "w1";
  `, context);
  runInContext(await dashboardFunctions(NAMES), context);
  const run = <T>(code: string): T => runInContext(code, context) as T;
  // Values made inside the sandbox belong to another realm; compare them as plain data.
  return { run, sent, removed, io, dialog };
}
const plain = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
const olderPage = (p: Awaited<ReturnType<typeof page>>) => plain(p.run<string[]>("[freshInviteLink, freshInviteId, freshInviteWorkspaceId]"));
const OLDER = ["https://example.test/invite#older-page", "inv-older", "w1"];

test("the form that asked gets the link; Done forgets it; the older page's receipt is never touched", async () => {
  const p = await page();
  assert.deepEqual(plain(await p.run("createPeopleDialogInvite('mei@example.test')")), { madeId: "inv-1" });
  assert.equal(p.run("peopleDialogInviteLink()"), "https://example.test/invite#synthetic-1");
  assert.deepEqual(olderPage(p), OLDER, "an accepted create in the dialog leaves the older page's link as it was");
  p.run("settlePeopleDialogInvite()");
  assert.equal(p.run("peopleDialogInviteLink()"), "https://example.test/invite#synthetic-1", "the list read after the create shows the invite, so the link stays");
  p.run("erasePeopleDialogInvite()");
  assert.equal(p.run("peopleDialogInviteLink()"), ""); assert.deepEqual(p.removed, ["made"], "its block is taken off the page");
  assert.deepEqual(olderPage(p), OLDER, "Done clears only the dialog's own receipt");
});

test("closing erases the link from state and from the page, and a reopened dialog has none", async () => {
  const p = await page();
  await p.run("createPeopleDialogInvite('mei@example.test')");
  p.run("closeRosterDialog()");
  assert.equal(p.run("peopleDialogInvite"), null); assert.deepEqual(p.removed, ["made"], "a closed dialog is not redrawn, so the block is removed at close");
  p.dialog.open = true; p.run("peopleDialogState.invite = { email: '', busy: false, error: '', madeId: '', copied: '' }");
  assert.equal(p.run("peopleDialogInviteLink()"), "");
  assert.deepEqual(olderPage(p), OLDER);
});

test("an answer that arrives after its form was closed is never stored, and the tab says the invite exists", async () => {
  const p = await page(); let release!: () => void;
  p.io.create = () => new Promise(resolve => { release = () => resolve({ invitationId: "inv-late", workspaceId: "w1", invitationToken: "synthetic-late" }); });
  const pending = p.run<Promise<unknown>>("createPeopleDialogInvite('mei@example.test')");
  p.run("closeRosterDialog()"); release();
  assert.deepEqual(plain(await pending), { error: "Invite created. Its link is no longer shown here. If you need a new link, cancel the invite when it appears below, then create another." });
  assert.equal(p.run("peopleDialogInvite"), null, "the late link is dropped, not kept for a later form");
  p.dialog.open = true; p.run("peopleDialogState.invite = { email: '', busy: false, error: '', madeId: '', copied: '' }");
  assert.equal(p.run("peopleDialogInviteLink()"), "", "a new form in the reopened dialog does not inherit it");
  p.run("pendingInvites = [{ invitationId: 'inv-late' }]");
  assert.equal(p.run("peopleDialogInviteNoticeText()"),
    "The link for mei@example.test is no longer shown here because the invite form closed. The invite is still listed below. If you need a new link, cancel it and create another.");
});

test("a same-workspace reload clears a shown link at once, and a late answer cannot restore one", async () => {
  const p = await page();
  await p.run("createPeopleDialogInvite('mei@example.test')");
  await p.run("reloadPeopleDialog('w1', '', '')");
  assert.equal(p.run("peopleDialogInvite"), null); assert.deepEqual(p.removed, ["made"]);
  assert.match(p.run<string>("peopleDialogInviteNoticeText()"), /^The link for mei@example\.test is no longer shown here because the workspace reloaded\. If you need a new link, cancel the invite when it appears below/,
    "the list has not been read again yet, so the tab does not claim it shows the invite");
  p.run("pendingInvites = [{ invitationId: 'inv-1' }]");
  assert.match(p.run<string>("peopleDialogInviteNoticeText()"), /The invite is still listed below\./);

  const late = await page(); let release!: () => void;
  late.io.create = () => new Promise(resolve => { release = () => resolve({ invitationId: "inv-late", workspaceId: "w1", invitationToken: "synthetic-late" }); });
  const pending = late.run<Promise<unknown>>("createPeopleDialogInvite('mei@example.test')");
  late.run("requestVersion += 1"); release();
  assert.deepEqual(plain(await pending), { error: "The workspace reloaded before we could confirm the invite. Check the list below before trying again. If the invite appears and you need a new link, cancel it first." });
  assert.equal(late.run("peopleDialogInvite"), null);
  assert.equal(late.run("inviteIntent.email"), "mei@example.test", "the command id is kept, so the same address again repeats the same command");
});

test("an accepted create keeps its link when the list cannot be read afterwards, and the list failure is reported apart", async () => {
  const p = await page();
  p.io.list = async () => { throw new Error("read failed"); };
  assert.deepEqual(plain(await p.run("createPeopleDialogInvite('mei@example.test')")), { madeId: "inv-1" });
  assert.equal(p.run("peopleDialogInviteLink()"), "https://example.test/invite#synthetic-1");
  assert.equal(p.run("pendingAgentsLoadFailed"), true, "the Invites tab's own could-not-load line, with Retry");
  assert.equal(p.run("inviteIntent"), null);
  p.run("settlePeopleDialogInvite()");
  assert.equal(p.run("peopleDialogInviteLink()"), "https://example.test/invite#synthetic-1", "a list that was not read cannot retire the link");
  assert.equal(p.sent.length, 1, "nothing invites a second create while the first invite is live");
});

test("an invite the list has shown and then no longer shows takes the dialog's link with it", async () => {
  const p = await page();
  await p.run("createPeopleDialogInvite('mei@example.test')"); p.run("settlePeopleDialogInvite()");
  p.run("pendingInvites = []; settlePeopleDialogInvite()");
  assert.equal(p.run("peopleDialogInvite"), null, "cancelled, used or expired");
  assert.deepEqual(olderPage(p), OLDER);
});

test("the first successful list read after acceptance already leaves the invite out: the link is cleared, and the create is still reported as made", async () => {
  const p = await page();
  p.io.list = async () => [{ invitationId: "someone-else" }];
  assert.deepEqual(plain(await p.run("createPeopleDialogInvite('mei@example.test')")), { error: "Invite created, but it is no longer pending, so its link is not shown." });
  assert.equal(p.run("peopleDialogInvite"), null, "never shown, though the list had never listed it"); assert.deepEqual(p.removed, ["made"]);
  assert.equal(p.run("peopleDialogInviteLink()"), "");
  assert.equal(p.run("pendingAgentsLoadFailed"), false, "the read succeeded; this is not the failed-read case");
  assert.equal(p.run("inviteIntent"), null, "the create was accepted: its command id is spent, and the sentence says it was created");
  assert.equal(p.sent.length, 1); assert.deepEqual(olderPage(p), OLDER);
});

test("an incomplete address and a refusal send or keep nothing", async () => {
  const p = await page();
  assert.deepEqual(plain(await p.run("createPeopleDialogInvite('mei@')")), { error: "Enter a full email address." });
  assert.equal(p.sent.length, 0);
  p.io.create = async () => { throw new Error("This address cannot be invited."); };
  assert.deepEqual(plain(await p.run("createPeopleDialogInvite('mei@example.test')")), { error: "This address cannot be invited." });
  assert.equal(p.run("peopleDialogInvite"), null); assert.equal(p.run("inviteIntent"), null);
});
