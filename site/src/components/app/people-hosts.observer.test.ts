/** Reached by `npm --prefix site test` and `test:ci` through the recursive component-observer glob. Pure: runs the
 * production People-page host functions from LiveDashboard.astro in a vm against a small fake DOM. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

/*
 * The People page borrows two persistent hosts from <live-dashboard>: the detail column and the sign-in block
 * ([data-member-details]: a refused removal's error and its sign-in controls). Code check, release 7: the
 * sign-in block was parked visible (so its error and buttons showed under another route), and a People
 * refresh moved the focused sign-in button out of the page and back without restoring focus. These run the
 * real functions; only the DOM and the page renderer are stand-ins.
 */
async function dashboardFunctions(names: string[]): Promise<string> {
  const raw = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)?.[1]; assert.ok(script);
  const ast = ts.createSourceFile("dashboard.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text)) found.set(node.name.text, `const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const name of names) assert.ok(found.has(name), `production declaration ${name}`);
  return ts.transpileModule(names.map((name) => found.get(name)).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

/* The fake DOM: tree moves, `hidden`, and focus that is lost when the focused node is removed or moved (a browser
   blurs it), leaves the document, or sits under a hidden ancestor (the browser's focus fixup). Selectors: `[data-x]` and `.class` only. */
const fakeDom = `
  class HTMLElement {
    constructor(tag, init = {}) { this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null; this.hidden = false; this.dataset = {}; this.className = ''; this.id = ''; this.attributes = {}; Object.assign(this, init); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    get isConnected() { let node = this; while (node.parentElement) node = node.parentElement; return node === documentRoot; }
    remove() { const parent = this.parentElement; if (!parent) return; if (focused && this.contains(focused)) focused = null; parent.children = parent.children.filter((child) => child !== this); this.parentElement = null; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    contains(node) { for (let at = node; at; at = at.parentElement) if (at === this) return true; return false; }
    closest(selector) { for (let at = this; at; at = at.parentElement) if (at.matches(selector)) return at; return null; }
    matches(selector) {
      if (selector === '[hidden]') return this.hidden;
      const data = selector.match(/^\\[data-([\\w-]+)\\]$/); if (data) return Object.keys(this.dataset).some((key) => key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) === data[1]);
      if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
      throw new Error('fake DOM selector ' + selector);
    }
    querySelector(selector) { for (const child of this.children) { if (child.matches(selector)) return child; const deeper = child.querySelector(selector); if (deeper) return deeper; } return null; }
    focus() { focused = this; }
  }
  class HTMLInputElement extends HTMLElement { setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } }
  class HTMLTextAreaElement extends HTMLInputElement {}
  const el = (tag, data, className = '') => { const node = new HTMLElement(tag, { className }); for (const key of [].concat(data || [])) node.dataset[key] = ''; return node; };
  let focused = null;
  const documentRoot = new HTMLElement('html'); const body = new HTMLElement('body'); documentRoot.append(body);
  const document = {
    get activeElement() { return focused && focused.isConnected && !focused.closest('[hidden]') ? focused : body; },
    createElement: (tag) => new HTMLElement(tag),
  };
  const app = el('live-dashboard'); body.append(app);
  const one = (selector) => app.querySelector(selector);
  const pane = el('section', 'homeRoutePane', 'hm-route-pane'); app.append(pane);
  const detailHost = el('section', 'peopleDetail', 'pd-detail'); detailHost.hidden = true; app.append(detailHost);
  const signIn = el('section', 'memberDetails', 'dashboard__roster-dialog-members'); signIn.hidden = true; app.append(signIn);
  const signInError = el('p', 'memberError'); signInError.hidden = true;
  const reauth = el('div', 'memberReauth'); reauth.hidden = true;
  const signInButton = new HTMLElement('button'); const emailField = new HTMLInputElement('input');
  reauth.append(signInButton, emailField); signIn.append(signInError, reauth);
  /* The app's own refusal handler (FreshLoginRequired) does this: show the error and the sign-in block, focus its button. */
  const refuse = () => { signInError.hidden = false; signInError.textContent = 'Sign in again, then press Remove once more.'; reauth.hidden = false; signInButton.focus(); };
  /* Stand-in for renderPeopleDialog in page layout: it replaces the page (header and side column), puts the detail
     column in the side column, and takes focus only for its own controls. */
  let renders = 0; let pageTitle = null;
  const renderPeopleDialog = (list, detail) => { renders += 1; const head = el('div', [], 'pd-page-head'); pageTitle = el('h1'); head.append(pageTitle); const side = el('aside'); side.append(detail); list.replaceChildren(head, side); };
  const syncPeopleDialogLayout = () => {}, peopleDialogModel = () => ({ agents: [], people: [] }), routeHref = () => '/app', confirmPeopleDialogAction = () => {};
  const peopleDialogState = { query: '', selected: null, rolePending: new Map() };
  let rosterFilter = '', peopleDialogFocus, activeWorkspaceId = 'W', workspaces = [{ id: 'W', name: 'Home' }], homeRoute = { view: 'people', workspaceId: 'W' };
  const head = () => pane.querySelector('.pd-page-head');
`;

async function fixture() {
  const context = createContext({});
  runInContext(fakeDom, context);
  runInContext(await dashboardFunctions(["parkMemberDetails", "mountMemberDetails", "parkPeopleHosts", "peopleDetailHost", "renderDialogRoster", "closeRosterDialog"]), context);
  return (code: string): unknown => runInContext(code, context);
}

test("a People refresh keeps focus on the sign-in button, and an input's selection, after a refusal", async () => {
  const run = await fixture();
  run("renderDialogRoster(); refuse();");
  /* Positive controls: the page rendered, the block is mounted under its header and visible, focus is on the button. */
  assert.equal(run("renders"), 1);
  assert.equal(run("signIn.parentElement === head() && !signIn.hidden && !reauth.hidden"), true);
  assert.equal(run("document.activeElement === signInButton"), true);
  run("renderDialogRoster();");
  assert.equal(run("renders"), 2, "the refresh really replaced the page");
  assert.equal(run("signIn.parentElement === head() && !signIn.hidden"), true, "the block is mounted again under the new header");
  assert.equal(run("document.activeElement === signInButton"), true, "focus stays on the sign-in button");
  /* A text control keeps its caret too. */
  run("emailField.value = 'tom@example.com'; emailField.selectionStart = 3; emailField.selectionEnd = 7; emailField.focus(); renderDialogRoster();");
  assert.equal(run("document.activeElement === emailField"), true);
  assert.equal(run("emailField.selectionStart + ',' + emailField.selectionEnd"), "3,7");
  /* Focus elsewhere on the page is not pulled into the sign-in block. */
  run("pageTitle.focus(); renderDialogRoster();");
  assert.equal(run("document.activeElement === signInButton || document.activeElement === emailField"), false);
});

test("leaving People in a refused state hides the sign-in block and the detail column", async () => {
  const run = await fixture();
  run("renderDialogRoster(); refuse();");
  assert.equal(run("!signIn.hidden && signIn.parentElement === head()"), true, "positive control: the refused block is on the page");
  /* Another route: applyHomePane and navigateHome park the hosts (parkPeopleHosts / closeRosterDialog). */
  run("homeRoute = { view: 'agent', workspaceId: 'W', agentId: 'A' }; closeRosterDialog();");
  assert.equal(run("signIn.parentElement === app && signIn.hidden"), true, "parked and hidden");
  assert.equal(run("detailHost.parentElement === app && detailHost.hidden"), true);
  assert.equal(run("document.activeElement === signInButton"), false, "nothing focusable is left showing under the other route");
  /* The pane is replaced by the agent page; the hosts are outside it, so they survive. */
  run("pane.replaceChildren(el('article'));");
  assert.equal(run("signIn.isConnected && detailHost.isConnected"), true);
  /* Back to People: the block is mounted and shown again with its refusal intact. */
  run("homeRoute = { view: 'people', workspaceId: 'W' }; renderDialogRoster();");
  assert.equal(run("signIn.parentElement === head() && !signIn.hidden && !reauth.hidden && !signInError.hidden"), true);
});

test("an in-page reload (closeRosterDialog while People is current) leaves both hosts on the page", async () => {
  const run = await fixture();
  run("renderDialogRoster(); refuse();");
  run("closeRosterDialog();");
  assert.equal(run("signIn.parentElement === head() && !signIn.hidden"), true);
  assert.equal(run("document.activeElement === signInButton"), true, "focus is not dropped by the reload's close");
  assert.equal(run("pane.contains(detailHost)"), true);
});
