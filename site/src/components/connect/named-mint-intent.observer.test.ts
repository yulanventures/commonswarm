/**
 * A queued key request belongs to the account that asked for it (HezSec C1 on #474).
 *
 * The Add an agent panel asks <agent-connect> for a named agent's prompt while the element may
 * still be loading. If the account changes before the load lands, the request must not create,
 * mint, show or copy anything for the account now signed in. This runs the element's real class
 * (its <script>, transpiled, imports removed) against a fake DOM, a held roster read and stubbed
 * commands, so each case holds the load exactly where the race happens.
 *
 * Browser-only, not covered here: the dashboard wiring that calls clearPrompt on an auth change
 * (resetWorkspaceSessionState) and retirePending on abandonment, and real clipboard permission.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const SOURCE = readFileSync(new URL("./AgentConnect.astro", import.meta.url), "utf8");
const SCRIPT = (() => {
  const script = SOURCE.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const file = ts.createSourceFile("agent-connect.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const kept = file.statements.filter((statement) => !ts.isImportDeclaration(statement)).map((statement) => statement.getFullText(file));
  return ts.transpileModule(kept.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
})();

class FakeNode {
  textContent = ""; hidden = false; disabled = false; dataset: Record<string, string> = {};
  addEventListener() {}
  setAttribute() {}
  removeAttribute() {}
  // Real elements can always be asked for an ancestor; the prompt asks for its disclosure.
  closest(): null { return null; }
}

interface Fixture {
  element: {
    dataset: Record<string, string>;
    setAttribute(name: string, value: string): void;
    connectedCallback(): void;
    readonly intentTicket: number;
    requestPromptNamed(name: string, userId: string, workspaceId: string, ticket: number): void;
    requestPromptFor(principalId: string, userId: string, workspaceId: string, ticket: number): void;
    clearPrompt(notify?: boolean): void;
    retirePending(): void;
    querySelector(selector: string): FakeNode;
    events: Array<{ type: string; detail: unknown }>;
  };
  calls: string[][];
  copied: string[];
  signIn(userId: string | null): void;
  hold: { roster: boolean; device: boolean; mint: boolean; rosterFails: boolean };
  release(): Promise<void>;
  settle(): Promise<void>;
  shown(): string;
}

function fixture(): Fixture {
  const calls: string[][] = [], copied: string[] = [];
  const held: Array<() => void> = [];
  const hold = { roster: false, device: false, mint: false, rosterFails: false };
  let user: string | null = "A";
  const wait = <T>(when: boolean, value: () => T): Promise<T> => new Promise<T>((resolve, reject) => {
    const answer = () => { try { resolve(value()); } catch (error) { reject(error); } };
    if (when) held.push(answer); else answer();
  });
  class FakeElement {
    dataset: Record<string, string> = { state: "loading" };
    attrs = new Map<string, string>();
    nodes = new Map<string, FakeNode>();
    events: Array<{ type: string; detail: unknown }> = [];
    isConnected = true;
    getAttribute(name: string) { return this.attrs.get(name) ?? null; }
    setAttribute(name: string, value: string) {
      this.attrs.set(name, value);
      (this as unknown as { attributeChangedCallback?: () => void }).attributeChangedCallback?.();
    }
    hasAttribute(name: string) { return this.attrs.has(name); }
    toggleAttribute(name: string, force: boolean) { if (force) this.attrs.set(name, ""); else this.attrs.delete(name); }
    querySelector(selector: string) {
      if (!this.nodes.has(selector)) this.nodes.set(selector, new FakeNode());
      return this.nodes.get(selector)!;
    }
    querySelectorAll() { return []; }
    dispatchEvent(event: { type: string; detail: unknown }) { this.events.push({ type: event.type, detail: event.detail }); return true; }
  }
  class Refusal extends Error {}
  let defined: (new () => Fixture["element"]) | undefined;
  const context = createContext({
    HTMLElement: FakeElement,
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    customElements: { get: () => undefined, define: (_name: string, element: new () => Fixture["element"]) => { defined = element; } },
    window: { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, addEventListener() {}, getSelection: () => null },
    navigator: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
    queueMicrotask,
    AGENT_TOKEN_MAX_TTL_MS: 1,
    AgentConnectRefused: Refusal, AgentNameTaken: Refusal, ClientTooOld: Refusal, CredentialNotShown: Refusal, MintOutcomeUnknown: Refusal,
    NoDeployment: Refusal,
    currentSession: async () => (user ? { user: { id: user }, access_token: `jwt-${user}` } : null),
    myAgents: (session: { user: { id: string } }) => {
      calls.push(["read-roster", session.user.id]);
      const fails = hold.rosterFails;
      return wait(hold.roster, () => { if (fails) throw new Error("read failed"); return [{ principalId: "P", name: "Scout", model: null }]; });
    },
    myWorkspaces: async () => [],
    ensureBrowserDevice: (session: { user: { id: string } }) => wait(hold.device, () => `device-${session.user.id}`),
    createAgentIdentity: async (session: { user: { id: string } }, _id: string, workspaceId: string, name: string) => {
      calls.push(["create", session.user.id, workspaceId, name]);
      return { principalId: `agent-${name}`, name, model: null };
    },
    mintAgentCredential: (session: { user: { id: string } }, _id: string, workspaceId: string, identity: { principalId: string; name: string }) => {
      calls.push(["mint", session.user.id, workspaceId, identity.principalId]);
      return wait(hold.mint, () => ({ principalId: identity.principalId, principalName: identity.name, tokenId: `token-${session.user.id}` }));
    },
    agentAccessStatuses: async () => [],
    connectionPolicyCopy: () => "",
    deployment: () => ({ url: "https://deployment.test", anonKey: "anon" }),
    uuid: () => "id",
    dashboardAgentPrompt: (input: { credential: { tokenId: string } }) => `SECRET PROMPT ${input.credential.tokenId}`,
    dashboardAgentConnection: () => "{}",
    dashboardAgentFilePrompt: () => "file prompt",
    promptCopyPayload: (_selected: string, prompt: string) => prompt,
    h0LinkJoinEnabled: false,
    loadLinkJoin: () => null, callLinkJoin() {}, concealJoinInvite: (value: unknown) => value,
    dismissShownJoin: (value: unknown) => value, shownJoinAfterRevoke: () => null,
  });
  runInContext(SCRIPT, context);
  assert.ok(defined, "the element class is defined");
  const element = new defined();
  element.setAttribute("workspace-id", "W");
  const settle = async () => { for (let turn = 0; turn < 30; turn++) await new Promise((resolve) => setImmediate(resolve)); };
  return {
    element, calls, copied, hold,
    signIn: (next) => { user = next; },
    release: async () => { while (held.length) held.shift()!(); await settle(); },
    settle,
    shown: () => element.querySelector('[data-slot="prompt"]').textContent,
  };
}

const writes = (calls: string[][]) => calls.filter(([kind]) => kind === "create" || kind === "mint");

test("A's queued name, held behind the load, creates nothing for B after an account switch; B's own request works", async () => {
  const f = fixture();
  f.hold.roster = true;
  f.element.connectedCallback();
  f.element.requestPromptNamed("Scout", "A", "W", f.element.intentTicket);
  await f.settle();
  assert.equal(f.element.dataset.state, "loading", "the load is held with A's request queued");
  // The dashboard's auth reset (resetWorkspaceSessionState) clears the element, then B opens W.
  f.element.clearPrompt(false);
  f.signIn("B");
  f.element.setAttribute("workspace-id", "W");
  await f.settle(); // B's own load reaches the held roster read too
  await f.release();
  const reads = f.calls.filter(([kind]) => kind === "read-roster").map(([, user]) => user);
  assert.deepEqual([reads[0], reads.at(-1)], ["A", "B"], "A's load was held, then B's load ran in the same workspace");
  assert.deepEqual(writes(f.calls), [], "nothing is created or minted for A's request");
  assert.equal(f.shown(), "");
  assert.deepEqual(f.copied, []);
  assert.equal(f.element.dataset.state, "ready", "B's own load still finishes");
  f.hold.roster = false;
  f.element.requestPromptNamed("Scout", "B", "W", f.element.intentTicket);
  await f.settle();
  assert.deepEqual(writes(f.calls), [["create", "B", "W", "Scout"], ["mint", "B", "W", "agent-Scout"]]);
  assert.equal(f.shown(), "SECRET PROMPT token-B");
  assert.deepEqual(f.copied, ["SECRET PROMPT token-B"], "Copy setup prompt copies B's own prompt");
});

test("without any reset, a load that lands under another account still mints nothing for the request", async () => {
  const f = fixture();
  f.hold.roster = true;
  f.element.connectedCallback();
  f.element.requestPromptNamed("Scout", "A", "W", f.element.intentTicket);
  await f.settle();
  f.signIn("B");
  await f.release();
  assert.deepEqual(writes(f.calls), [], "the session now signed in is never used for A's request");
  assert.equal(f.shown(), "");
  assert.deepEqual(f.copied, []);
  assert.equal(f.element.events.some((event) => event.type === "commonswarm:agent-prompt-failed"), false,
    "B is not told about a request B did not make");
});

test("a reset mid-mint stops before create, and a reset after the mint shows and copies nothing", async () => {
  const beforeCreate = fixture();
  beforeCreate.element.connectedCallback();
  await beforeCreate.settle();
  beforeCreate.hold.device = true;
  beforeCreate.element.requestPromptNamed("Scout", "A", "W", beforeCreate.element.intentTicket);
  await beforeCreate.settle();
  beforeCreate.element.clearPrompt(false);
  beforeCreate.signIn("B");
  await beforeCreate.release();
  assert.deepEqual(writes(beforeCreate.calls), [], "no agent is created once the request is retired");

  const beforeReveal = fixture();
  beforeReveal.element.connectedCallback();
  await beforeReveal.settle();
  beforeReveal.hold.mint = true;
  beforeReveal.element.requestPromptNamed("Scout", "A", "W", beforeReveal.element.intentTicket);
  await beforeReveal.settle();
  assert.deepEqual(writes(beforeReveal.calls), [["create", "A", "W", "Scout"], ["mint", "A", "W", "agent-Scout"]]);
  beforeReveal.signIn("B");
  await beforeReveal.release();
  assert.equal(beforeReveal.shown(), "", "a key minted for A is never shown once B is signed in");
  assert.deepEqual(beforeReveal.copied, []);
  assert.notEqual(beforeReveal.element.dataset.state, "done");
});

/* 474 R2 deferred P2: B asks while A's retired mint is still unwinding (held in ensureBrowserDevice).
   The single-mint guard stays; B's request waits for the old operation, then runs for B alone. */
test("a request made while a retired mint is still busy waits for it, then runs for its own account", async () => {
  const f = fixture();
  f.element.connectedCallback();
  await f.settle();
  f.hold.device = true;
  f.element.requestPromptNamed("Scout", "A", "W", f.element.intentTicket);
  await f.settle();
  f.element.clearPrompt(false); // the auth reset retires A
  f.signIn("B");
  f.element.requestPromptNamed("Planner", "B", "W", f.element.intentTicket); // before A's held device call settles
  await f.settle();
  assert.deepEqual(writes(f.calls), [], "nothing is created while A's retired operation still holds the guard");
  f.hold.device = false;
  await f.release();
  assert.deepEqual(writes(f.calls), [["create", "B", "W", "Planner"], ["mint", "B", "W", "agent-Planner"]],
    "A's request created nothing; B's ran once the old operation settled, under B's session");
  assert.equal(f.shown(), "SECRET PROMPT token-B");
  assert.deepEqual(f.copied, ["SECRET PROMPT token-B"]);
  assert.equal(f.element.dataset.state, "done");
  const ready = f.element.events.filter((event) => event.type === "commonswarm:agent-prompt-ready");
  assert.equal(ready.length, 1, "B's panel hears its result");
  assert.equal((ready[0]!.detail as { name: string }).name, "Planner");

  // A reset while B's request waits retires it too: still nothing is created, and the panel hears it.
  const g = fixture();
  g.element.connectedCallback();
  await g.settle();
  g.hold.device = true;
  g.element.requestPromptNamed("Scout", "A", "W", g.element.intentTicket);
  await g.settle();
  g.element.clearPrompt(false);
  g.signIn("B");
  g.element.requestPromptNamed("Planner", "B", "W", g.element.intentTicket);
  const before = g.element.events.length;
  g.element.clearPrompt(false);
  assert.equal(g.element.events.slice(before).some((event) => event.type === "commonswarm:agent-prompt-retired"), true);
  g.hold.device = false;
  await g.release();
  assert.deepEqual(writes(g.calls), []);
  assert.equal(g.shown(), "");
});

test("a request while a live prompt is open, or a live mint is running, is answered, never left waiting", async () => {
  const f = fixture();
  f.element.connectedCallback();
  await f.settle();
  f.hold.mint = true;
  f.element.requestPromptNamed("Scout", "A", "W", f.element.intentTicket);
  await f.settle();
  const before = f.element.events.length;
  f.element.requestPromptNamed("Planner", "A", "W", f.element.intentTicket); // the live mint is still running
  assert.deepEqual(f.element.events.slice(before).map((event) => event.type), ["commonswarm:agent-prompt-retired"],
    "the second request is turned away at once, so its Copy setup prompt is usable again");
  f.hold.mint = false;
  await f.release();
  assert.deepEqual(writes(f.calls), [["create", "A", "W", "Scout"], ["mint", "A", "W", "agent-Scout"]], "only the live request mints");
  assert.equal(f.shown(), "SECRET PROMPT token-A");
  const shown = f.element.events.length;
  f.element.requestPromptNamed("Planner", "A", "W", f.element.intentTicket); // the prompt is still on screen
  await f.settle();
  assert.deepEqual(f.element.events.slice(shown).map((event) => event.type), ["commonswarm:agent-prompt-retired"]);
  assert.equal(f.shown(), "SECRET PROMPT token-A", "the open prompt is never replaced");
  assert.equal(writes(f.calls).length, 2);
});

test("abandoning the request, or a blocked load, retires it for good; a later load does not revive it", async () => {
  const abandoned = fixture();
  abandoned.hold.roster = true;
  abandoned.element.connectedCallback();
  abandoned.element.requestPromptNamed("Scout", "A", "W", abandoned.element.intentTicket);
  await abandoned.settle();
  abandoned.element.retirePending(); // the panel closed, the app changed, or Back left the key view
  assert.deepEqual(abandoned.element.events.map((event) => event.type), ["commonswarm:agent-prompt-retired"],
    "the panel hears its Copy setup prompt is free again");
  abandoned.element.retirePending();
  assert.equal(abandoned.element.events.length, 1, "retiring with nothing pending says nothing");
  abandoned.element.setAttribute("workspace-id", "W");
  await abandoned.release();
  assert.deepEqual(writes(abandoned.calls), []);

  const blocked = fixture();
  blocked.hold.roster = true;
  blocked.hold.rosterFails = true;
  blocked.element.connectedCallback();
  blocked.element.requestPromptNamed("Scout", "A", "W", blocked.element.intentTicket);
  await blocked.settle();
  await blocked.release();
  assert.equal(blocked.element.dataset.state, "blocked");
  assert.ok(blocked.element.events.some((event) => event.type === "commonswarm:agent-prompt-failed"),
    "the panel hears the request was dropped");
  blocked.hold.rosterFails = false;
  blocked.hold.roster = false;
  blocked.element.setAttribute("workspace-id", "W"); // Try again
  await blocked.settle();
  assert.equal(blocked.element.dataset.state, "ready");
  assert.deepEqual(writes(blocked.calls), [], "Try again does not revive the dropped request");
  assert.deepEqual(blocked.copied, []);
});

test("a request with no signed-in account, or for another workspace, is never queued or minted", async () => {
  const f = fixture();
  f.element.connectedCallback();
  await f.settle();
  f.element.requestPromptNamed("Scout", "", "W", f.element.intentTicket);
  await f.settle();
  assert.deepEqual(writes(f.calls), [], "no initiating account, no request");
  f.hold.roster = true;
  f.element.setAttribute("workspace-id", "X");
  f.element.requestPromptNamed("Scout", "A", "X", f.element.intentTicket);
  f.element.setAttribute("workspace-id", "W");
  await f.release();
  assert.deepEqual(writes(f.calls), [], "a request asked in X does not mint in W");
});

test("the element refuses a request for a workspace other than the one it is pinned to", async () => {
  const f = fixture();
  f.element.connectedCallback();
  await f.settle();
  f.element.requestPromptFor("P", "A", "X", f.element.intentTicket);
  f.element.requestPromptNamed("Scout", "A", "X", f.element.intentTicket);
  f.element.requestPromptFor("P", "A", "", f.element.intentTicket);
  await f.settle();
  assert.deepEqual(writes(f.calls), [], "the handoff names its workspace, and only that one may mint");
  // A ticket taken before a retirement is refused: the element never lends its newer generation to it.
  const ticket = f.element.intentTicket;
  f.element.retirePending();
  f.element.requestPromptFor("P", "A", "W", ticket);
  await f.settle();
  assert.deepEqual(writes(f.calls), [], "a retired ticket asks for nothing");
  f.element.requestPromptFor("P", "A", "W", f.element.intentTicket);
  await f.settle();
  assert.deepEqual(writes(f.calls), [["mint", "A", "W", "P"]], "control: the pinned workspace and a live ticket mint once");
});

/*
 * HezSec C1 on #479: a new key for an agent that exists (People's New key, Get a new key and Reconnect,
 * the agent page's fix) awaits navigation to the workspace's chat and a frame before it asks. A click
 * made in W1 and superseded on its way must never mint in W2 for an agent that is in both. This runs the
 * dashboard's real peopleDialogAction and the helper it calls against the element's real class above,
 * with the navigation and the animation frame held.
 */
const DASHBOARD = (() => {
  const raw = readFileSync(new URL("../app/LiveDashboard.astro", import.meta.url), "utf8");
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const ast = ts.createSourceFile("dashboard.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Map<string, string>();
  const wanted = ["requestNewKeyFor", "peopleDialogAction", "closeConnect"];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && wanted.includes(node.name.text)) found.set(node.name.text, `const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(found.has("peopleDialogAction"), "production declaration peopleDialogAction");
  // requestNewKeyFor is new with the fix; the older source inlines the same steps in peopleDialogAction.
  return ts.transpileModule(wanted.filter(name => found.has(name)).map(name => found.get(name)).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
})();

function newKeyFixture() {
  const f = fixture();
  f.element.setAttribute("workspace-id", "W1");
  f.element.connectedCallback();
  const held = { nav: false, raf: false };
  const navs: Array<() => void> = [], frames: Array<() => void> = [];
  const context = createContext({
    element: f.element, held, navs, frames,
    peopleDialogCanAct: (_model: unknown, action: string, id: string) => action === "new-key" && id === "P",
    peopleDialogModel: () => ({}), homeConnectionAccess: () => undefined,
    window: { requestAnimationFrame: (fn: () => void) => { if (held.raf) frames.push(fn); else fn(); return 1; } },
  });
  runInContext(`
    let session = { user: { id: "A" } }, activeWorkspaceId = "W1", sampleMode = false, homeNavigation = 0, requestVersion = 1;
    let homeRoute = { view: "people", workspaceId: "W1" };
    const agents = [{ principalId: "P", name: "Scout" }], accessStatuses = [];
    const one = (selector) => selector === "agent-connect" ? element : null;
    // The workspace switch the dashboard makes: a new read generation, and the key element follows it.
    const enter = (workspaceId) => { if (activeWorkspaceId !== workspaceId) { activeWorkspaceId = workspaceId; requestVersion++; element.setAttribute("workspace-id", workspaceId); } };
    // navigateHome claims its navigation number and switches at once, then waits for the workspace's reads.
    const navigateHome = (route) => {
      homeNavigation++; homeRoute = route; enter(route.workspaceId);
      return held.nav ? new Promise((resolve) => navs.push(resolve)) : Promise.resolve();
    };
    const openConnect = () => { element.setAttribute("workspace-id", activeWorkspaceId); };
    // Back from the key view, on the chat route: the feed again, with no navigation and no new read.
    const keepConnectCredentialVisible = () => false, returned = [];
    const returnToChannel = () => { returned.push(activeWorkspaceId); };
  `, context);
  runInContext(DASHBOARD, context);
  const click = (id = "P") => runInContext(`peopleDialogAction("new-key", ${JSON.stringify(id)}, {}, {})`, context) as Promise<void>;
  const run = (code: string) => runInContext(code, context);
  const releaseNav = async () => { while (navs.length) navs.shift()!(); await f.settle(); };
  const releaseFrames = async () => { while (frames.length) frames.shift()!(); await f.settle(); };
  return { f, held, click, run, releaseNav, releaseFrames };
}

test("C1: a W1 New key click superseded by a switch to W2 while its navigation is held mints nothing", async () => {
  const k = newKeyFixture();
  await k.f.settle();
  k.held.nav = true;
  const clicked = k.click();
  await k.f.settle();
  k.held.nav = false;
  await k.run(`navigateHome({ view: "chat", workspaceId: "W2" })`); // the person opens W2
  await k.f.settle();
  await k.releaseNav(); // the W1 workspace read comes back late
  await clicked;
  await k.f.settle();
  assert.deepEqual(writes(k.f.calls), [], "nothing is created or minted in W2 for the W1 click");
  assert.equal(k.f.shown(), "");
  assert.deepEqual(k.f.copied, []);
  // A fresh click in W2 is that workspace's own and mints there, once.
  await k.click();
  await k.f.settle();
  assert.deepEqual(writes(k.f.calls), [["mint", "A", "W2", "P"]]);
  assert.equal(k.f.shown(), "SECRET PROMPT token-A");
});

test("C1: the same click superseded while its animation frame is held mints nothing", async () => {
  const k = newKeyFixture();
  await k.f.settle();
  k.held.raf = true;
  const clicked = k.click();
  await k.f.settle();
  await k.run(`navigateHome({ view: "chat", workspaceId: "W2" })`);
  await k.f.settle();
  await k.releaseFrames();
  await clicked;
  await k.f.settle();
  assert.deepEqual(writes(k.f.calls), [], "the frame finds the scope changed and asks for nothing");
  assert.equal(k.f.shown(), "");
  assert.deepEqual(k.f.copied, []);
  // Any later navigation, even inside W2, also retires a waiting frame.
  const again = k.click();
  await k.f.settle();
  await k.run(`navigateHome({ view: "lists", workspaceId: "W2" })`);
  await k.releaseFrames();
  await again;
  await k.f.settle();
  assert.deepEqual(writes(k.f.calls), []);
});

test("C1: an account switch during the held navigation or frame mints nothing; an unmoved click mints once in W1", async () => {
  for (const hold of ["nav", "raf"] as const) {
    const k = newKeyFixture();
    await k.f.settle();
    k.held[hold] = true;
    const clicked = k.click();
    await k.f.settle();
    k.f.signIn("B");
    await k.run(`session = { user: { id: "B" } }`);
    await (hold === "nav" ? k.releaseNav() : k.releaseFrames());
    await clicked;
    await k.f.settle();
    assert.deepEqual(writes(k.f.calls), [], `${hold}: nothing for A's click under B, and nothing for B`);
    assert.equal(k.f.shown(), "");
  }
  const k = newKeyFixture();
  await k.f.settle();
  k.held.nav = true;
  k.held.raf = true;
  const clicked = k.click();
  await k.f.settle();
  await k.releaseNav();
  await k.releaseFrames();
  await clicked;
  await k.f.settle();
  assert.deepEqual(writes(k.f.calls), [["mint", "A", "W1", "P"]], "control: nothing moved, one mint in W1");
  assert.equal(k.f.shown(), "SECRET PROMPT token-A");
});

/* HezSec C1 on #479, narrowed: Back in the same workspace changes no navigation, read, account or
   workspace. The click's ticket is what Back retires, so the held frame must ask for nothing. */
test("C1: Back (the real closeConnect) while the frame is held retires the click; nothing is asked, minted, shown or copied", async () => {
  for (const back of ["closeConnect", "retirePending"] as const) {
    const k = newKeyFixture();
    await k.f.settle();
    k.held.raf = true;
    const clicked = k.click();
    await k.f.settle();
    const counters = () => k.run("JSON.stringify([homeNavigation, requestVersion, activeWorkspaceId, session.user.id])");
    const before = counters();
    await k.run(back === "closeConnect" ? "closeConnect()" : "element.retirePending()");
    if (back === "closeConnect") assert.equal(k.run("returned.join('|')"), "W1", "Back returned to the W1 feed");
    assert.equal(counters(), before, `${back}: navigation, reads, workspace and account are unchanged`);
    const events = k.f.element.events.length;
    await k.releaseFrames();
    await clicked;
    await k.f.settle();
    assert.deepEqual(writes(k.f.calls), [], `${back}: nothing is created or minted`);
    assert.equal(k.f.shown(), "");
    assert.deepEqual(k.f.copied, []);
    assert.equal(k.f.element.events.slice(events).some((event) => event.type === "commonswarm:agent-prompt-ready"), false);
    // The same agent, asked for again after Back, is a new click and mints once.
    k.held.raf = false;
    await k.click();
    await k.f.settle();
    assert.deepEqual(writes(k.f.calls), [["mint", "A", "W1", "P"]], `${back}: a fresh click mints once`);
  }
});
