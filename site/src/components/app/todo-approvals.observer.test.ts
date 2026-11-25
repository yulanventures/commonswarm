/**
 * Mounted site & observer tests for #742 Approve Action on To-Dos and #730 login-generation fencing.
 *
 * Covers R4 Section 5 item 4 end-to-end with real DOM builders (`renderWaitingPanel`, `buildOfferCard`,
 * `todoView`), real `createHomeServer` + bundled `commonswarm.ts` `postCommand`, and real extracted
 * `LiveDashboard.astro` handlers (`markWaitingTodoDone`, `decideWaitingTodo`, `answerWaitingTodoOffer`,
 * `answerOffer`, `homeWrite`, `waitingActionGuard`, `mapWaitingTodosQueue`, `renderHomeObjectPane`).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import ts from "typescript";
import {
  createHomeServer,
  HomeCommandRefused,
  HomeOperationRetired,
  HomeToolsUnavailable,
  parseWaitingArchivedPage,
  parseWaitingTodosQueue,
  WAITING_ARCHIVED_OUTCOMES,
} from "../../lib/home/client.ts";
import { mapHomePeople, mapHomeTodo } from "../../lib/home-map.ts";
import { tagOptions } from "../../lib/home-pickers.ts";
import { routeHref } from "../../lib/home-route.ts";
import { buildOfferCard, pendingOfferCards } from "../../lib/home-stream-approvals.ts";
import { todoView } from "../../lib/home-todo.ts";
import { evaluateInlineOfferTerms, formatExactOfferAt, TODO_CONFLICT_MESSAGE } from "../../lib/todo-offer-terms.ts";
import { mapWaitingArchivedEntry, renderWaitingPanel, type WaitingPlace, type WaitingTodoItem } from "../../lib/waiting-panel.ts";
import type { Todo, TodoSummary } from "../../lib/home/contract.ts";

// ---------- Strict fake DOM (throws on innerHTML to prove textContent-only XSS inertness) ----------

class FakeText {
  nodeType = 3;
  parentNode: FakeElement | null = null;
  constructor(public textContent: string) {}
}

class FakeElement {
  tagName: string;
  nodeType = 1;
  ownerDocument: FakeDocument;
  parentNode: FakeElement | null = null;
  children: Array<FakeElement | FakeText> = [];
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = "";
  id = "";
  href = "";
  hidden = false;
  disabled = false;
  readOnly = false;
  checked = false;
  required = false;
  type = "";
  name = "";
  value = "";
  title = "";
  dateTime = "";
  placeholder = "";
  maxLength = 0;
  autocomplete = "";
  noValidate = false;
  tabIndex = 0;
  rows = 0;
  listeners = new Map<string, Array<(event: unknown) => void>>();
  onclick: ((event: unknown) => void) | null = null;
  private _text = "";

  constructor(doc: FakeDocument, tag: string) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
  }

  set innerHTML(_v: string) {
    throw new Error("XSS guard: innerHTML must never be used");
  }
  get innerHTML(): string {
    return "";
  }
  get textContent(): string {
    if (this.children.length > 0) {
      return this.children.map(c => c.textContent).join("");
    }
    return this._text;
  }
  set textContent(v: string) {
    this._text = String(v ?? "");
    this.children = [];
  }
  get firstChild(): FakeElement | FakeText | null {
    return this.children[0] ?? null;
  }
  get nextSibling(): FakeElement | FakeText | null {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    return idx >= 0 ? this.parentNode.children[idx + 1] ?? null : null;
  }
  get options(): FakeElement[] {
    return this.children.filter((c): c is FakeElement => c instanceof FakeElement && c.tagName === "OPTION");
  }
  get classList() {
    return {
      add: (...names: string[]) => {
        const set = new Set(this.className.split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        this.className = [...set].join(" ");
      },
      contains: (n: string) => this.className.split(/\s+/).includes(n),
    };
  }
  setAttribute(name: string, value: string): void {
    const v = String(value);
    if (name === "id") this.id = v;
    else if (name === "class") this.className = v;
    else this.attrs.set(name, v);
  }
  getAttribute(name: string): string | null {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    return this.attrs.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  append(...nodes: Array<FakeElement | FakeText | string>): void {
    for (const item of nodes) {
      if (typeof item === "string") {
        const t = new FakeText(item);
        t.parentNode = this;
        this.children.push(t);
      } else if (item) {
        if (item.parentNode) item.parentNode.removeChild(item);
        item.parentNode = this;
        this.children.push(item);
      }
    }
  }
  insertBefore(node: FakeElement | FakeText, ref: FakeElement | FakeText | null): void {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    if (!ref) {
      this.children.push(node);
      return;
    }
    const idx = this.children.indexOf(ref);
    if (idx < 0) this.children.push(node);
    else this.children.splice(idx, 0, node);
  }
  removeChild(node: FakeElement | FakeText): void {
    const idx = this.children.indexOf(node);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      node.parentNode = null;
    }
  }
  replaceChildren(...nodes: Array<FakeElement | FakeText | string>): void {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }
  replaceWith(node: FakeElement): void {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx < 0) return;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this.parentNode;
    this.parentNode.children[idx] = node;
    this.parentNode = null;
  }
  remove(): void {
    this.parentNode?.removeChild(this);
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  click(): void {
    if (this.disabled) return;
    const event = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    this.onclick?.(event);
    for (const fn of this.listeners.get("click") ?? []) fn(event);
  }
  focus(): void {
    this.ownerDocument.activeElement = this;
  }
  contains(other: FakeElement | FakeText | null): boolean {
    let cur: FakeElement | FakeText | null = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  matches(selector: string): boolean {
    return selector.split(",").map(s => s.trim()).some(part => {
      if (part.startsWith(".")) return this.classList.contains(part.slice(1));
      const attrMatch = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/u.exec(part);
      if (attrMatch) {
        const camel = attrMatch[1]!.replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase());
        if (!(camel in this.dataset)) return false;
        return attrMatch[2] === undefined ? true : this.dataset[camel] === attrMatch[2];
      }
      if (/^[a-z0-9]+$/iu.test(part)) return this.tagName === part.toUpperCase();
      return false;
    });
  }
  closest(selector: string): FakeElement | null {
    let cur: FakeElement | null = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (el: FakeElement) => {
      for (const child of el.children) {
        if (child instanceof FakeElement) {
          if (child.matches(selector)) found.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return found;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeDocument {
  activeElement: FakeElement | null = null;
  body: FakeElement;
  constructor() {
    this.body = new FakeElement(this, "body");
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  createElementNS(_ns: string, tag: string): FakeElement {
    return new FakeElement(this, tag);
  }
  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }
  getElementById(id: string): FakeElement | null {
    const walk = (el: FakeElement): FakeElement | null => {
      if (el.id === id) return el;
      for (const c of el.children) {
        if (c instanceof FakeElement) {
          const hit = walk(c);
          if (hit) return hit;
        }
      }
      return null;
    };
    return walk(this.body);
  }
}

function makeDoc(): Document {
  return new FakeDocument() as unknown as Document;
}

// ---------- Fixtures ----------

const WS = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const TODO_1 = "44444444-4444-4444-8444-444444444441";
const TODO_2 = "44444444-4444-4444-8444-444444444442";
const TODO_3 = "44444444-4444-4444-8444-444444444443";
const OFFER_1 = "55555555-5555-4555-8555-555555555551";
const OFFER_2 = "55555555-5555-4555-8555-555555555552";
const NOW = Date.parse("2026-11-25T15:00:00.000Z");
const AT_ISO = "2026-11-26T20:30:00.000Z";
const XSS_PAYLOAD = `<img src=x onerror="alert(1)"><script>window.__xss=1</script>`;

const PLACE: WaitingPlace = {
  workspaceId: WS,
  workspaceName: "Home",
  kind: "all",
  channelId: null,
  label: "All channels",
};

function makeWaitingVM(todos: WaitingTodoItem[], extra: Record<string, unknown> = {}) {
  return {
    tab: "active" as const,
    scope: "workspace" as const,
    place: PLACE,
    items: [],
    plainAsks: [],
    todos,
    counts: {
      channel: { min: todos.length, complete: true },
      workspace: { min: todos.length, complete: true },
      all: { min: todos.length, complete: true },
    },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "",
    statusSeq: 0,
    ...extra,
  };
}

function makeOfferSummary(overrides: Partial<TodoSummary> = {}): TodoSummary {
  return {
    todo_id: TODO_1,
    version: 3,
    kind: "task",
    decision_status: null,
    has_notes: false,
    title: "Deploy release",
    state: "open",
    due_on: "2026-11-28",
    assignee: null,
    offer: {
      offer_id: OFFER_1,
      to: { kind: "agent", id: AGENT },
      decider_user_id: OWNER,
      start: "queue",
      gate: { kind: "none" },
      by: { user_id: OTHER_USER, principal_id: null },
      at: "2026-11-25T14:00:00.000Z",
    },
    gate: { kind: "none", clear: true },
    queue_position: null,
    comment_count: 0,
    state_at: "2026-11-25T14:00:00.000Z",
    ...overrides,
  };
}

// ---------- Dashboard function extractor & bundled commonswarm harness ----------

let cachedDashboardAst: { source: string; file: ts.SourceFile } | null = null;
async function extractDashboardFunctions(names: readonly string[]): Promise<string> {
  if (!cachedDashboardAst) {
    const raw = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
    const script = raw.match(/<script>([\s\S]*?)<\/script>/u)?.[1] ?? "";
    assert.ok(script.length > 1000, "found LiveDashboard script");
    cachedDashboardAst = {
      source: script,
      file: ts.createSourceFile("LiveDashboard.ts", script, ts.ScriptTarget.Latest, true),
    };
  }
  const { file } = cachedDashboardAst;
  const wanted = new Set(names);
  const found = new Map<string, string>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const name = decl.name.getText(file);
        if (wanted.has(name)) {
          found.set(name, `const ${decl.getText(file)};`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const name of names) {
    assert.ok(found.has(name), `extracted ${name} from LiveDashboard.astro`);
  }
  const combined = names.map(name => found.get(name)!).join("\n");
  return ts.transpileModule(combined, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

function makeJwt(claims: Record<string, unknown>, sig = "sig"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

function makeSession(accessToken: string, userId = OWNER) {
  return {
    access_token: accessToken,
    refresh_token: "refresh-1",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: "owner@example.test",
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-11-01T00:00:00.000Z",
    },
  };
}

let cachedCommonswarmBundle: string | null = null;
async function loadCommonswarmBundle(): Promise<string> {
  if (cachedCommonswarmBundle) return cachedCommonswarmBundle;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../../lib/commonswarm.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "browser",
    format: "cjs",
    define: {
      "import.meta.env": JSON.stringify({
        PUBLIC_SUPABASE_URL: "https://api.test.invalid",
        PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-key",
      }),
    },
  });
  cachedCommonswarmBundle = bundle.outputFiles[0]!.text;
  return cachedCommonswarmBundle;
}

const activeCleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (activeCleanup.length > 0) {
    await activeCleanup.pop()!();
  }
});

async function createRealPostCommandEnv(initialSession: ReturnType<typeof makeSession>) {
  const code = await loadCommonswarmBundle();
  const map = new Map<string, string>();
  const STORAGE_KEY = "sb-api-auth-token";
  map.set(STORAGE_KEY, JSON.stringify(initialSession));
  const storage = {
    get length() { return map.size; },
    clear() { map.clear(); },
    key(index: number) { return [...map.keys()][index] ?? null; },
    getItem(key: string) { return map.get(key) ?? null; },
    setItem(key: string, value: string) { map.set(key, String(value)); },
    removeItem(key: string) { map.delete(key); },
  };
  const posted: Array<{ command_id: string; command: Record<string, unknown>; bearer: string }> = [];
  let commandResponder: ((call: { command_id: string; command: Record<string, unknown>; bearer: string }) => Response | Promise<Response>) | null = null;
  const activeTimers = new Set<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();
  const fetcher: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === "/auth/v1/user") return Response.json(initialSession.user);
    if (url.pathname === "/functions/v1/command") {
      const body = await req.json() as { command_id: string; command: Record<string, unknown> };
      const call = { command_id: body.command_id, command: body.command, bearer: req.headers.get("authorization") ?? "" };
      posted.push(call);
      if (commandResponder) return await commandResponder(call);
      return Response.json({ status: "committed", value: { todo_id: TODO_1, version: 4, state: "done" }, notices: [], replayed: false });
    }
    return Response.json({ error: "unexpected" }, { status: 404 });
  };
  const ctx = createContext({
    module: { exports: {} },
    fetch: fetcher,
    AbortSignal,
    AbortController,
    setTimeout: ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id = setTimeout(() => { activeTimers.delete(id); fn(...args); }, ms);
      activeTimers.add(id);
      return id;
    }) as typeof setTimeout,
    clearTimeout: ((id: ReturnType<typeof setTimeout>) => { activeTimers.delete(id); clearTimeout(id); }) as typeof clearTimeout,
    setInterval: ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const id = setInterval(fn, ms, ...args);
      id.unref?.();
      activeTimers.add(id);
      return id;
    }) as typeof setInterval,
    clearInterval: ((id: ReturnType<typeof setInterval>) => { activeTimers.delete(id); clearInterval(id); }) as typeof clearInterval,
    WebSocket: class { readyState = 3; close() {} send() {} },
    console, Error, URL, URLSearchParams, Headers, Request, Response, TextEncoder, TextDecoder, atob, btoa, crypto,
    localStorage: storage,
    addEventListener: () => {},
    removeEventListener: () => {},
    window: undefined,
    document: { querySelector: () => null },
  });
  runInContext(code, ctx);
  const lib = ctx.module.exports as typeof import("../../lib/commonswarm.ts");
  const supa = lib.client()!;
  await supa.auth.getSession();

  let heldSessionResolve: (() => void) | null = null;
  let holdNextGetSession = false;
  let currentStorageSession: ReturnType<typeof makeSession> | null = initialSession;
  let getSessionStartedResolve: (() => void) | null = null;
  let getSessionStarted = new Promise<void>(r => { getSessionStartedResolve = r; });

  supa.auth.getSession = (async () => {
    getSessionStartedResolve?.();
    if (holdNextGetSession) {
      holdNextGetSession = false;
      await new Promise<void>(r => { heldSessionResolve = r; });
    }
    return { data: { session: currentStorageSession as never }, error: null };
  }) as typeof supa.auth.getSession;

  activeCleanup.push(async () => {
    try { await supa.auth.stopAutoRefresh(); } catch { /* ignore */ }
    for (const id of activeTimers) {
      clearTimeout(id as ReturnType<typeof setTimeout>);
      clearInterval(id as ReturnType<typeof setInterval>);
    }
    activeTimers.clear();
  });

  return {
    lib,
    posted,
    setCommandResponder(fn: typeof commandResponder) { commandResponder = fn; },
    armGetSessionHold() {
      holdNextGetSession = true;
      getSessionStarted = new Promise<void>(r => { getSessionStartedResolve = r; });
    },
    waitForGetSessionStart() { return getSessionStarted; },
    setStorageSession(next: ReturnType<typeof makeSession> | null) {
      currentStorageSession = next;
      if (next) storage.setItem(STORAGE_KEY, JSON.stringify(next));
      else storage.removeItem(STORAGE_KEY);
    },
    releaseGetSession() {
      const fn = heldSessionResolve;
      heldSessionResolve = null;
      fn?.();
    },
  };
}

// ---------- 1. Contract, client parsers, and #730 Fix #1 (householdSurface forwards isAlive) ----------

test("client parsers handle additive Waiting todos, todo_read decision fields, and Archived 'approved' outcome; householdSurface forwards isAlive", async () => {
  assert.ok(WAITING_ARCHIVED_OUTCOMES.has("approved"));

  const waiting = parseWaitingTodosQueue({
    workspace_id: WS,
    generated_at: "2026-11-25T15:00:00Z",
    total: 2,
    truncated: false,
    todos: [
      {
        todo_id: TODO_1,
        version: 5,
        kind: "approval",
        title: "Approve vendor invoice",
        notes_preview: "Total $420",
        notes_truncated: false,
        requested_by: { kind: "agent", id: AGENT, name: "Claude" },
        state: "open",
        due_on: "2026-11-30",
        reason: "assigned",
        agent_id: null,
        state_at: "2026-11-25T14:00:00Z",
        placement: "general",
        channel_id: null,
        conversation_id: null,
      },
      {
        todo_id: TODO_2,
        version: 7,
        kind: "task",
        title: "Run nightly export",
        notes_preview: null,
        notes_truncated: false,
        requested_by: { kind: "user", id: OTHER_USER, name: "Nikki" },
        state: "open",
        due_on: null,
        reason: "request",
        agent_id: AGENT,
        state_at: "2026-11-25T14:30:00Z",
        placement: "workspace",
        channel_id: null,
        conversation_id: null,
        offer_id: OFFER_1,
        offer_to: { kind: "agent", id: AGENT, name: "Claude" },
        offer_start: "now",
        offer_gate: { kind: "at", at: AT_ISO },
      },
    ],
  }, WS);
  assert.ok(waiting);
  assert.equal(waiting.todos[0]!.version, 5);
  assert.equal(waiting.todos[0]!.kind, "approval");
  assert.equal(waiting.todos[0]!.notes_preview, "Total $420");
  assert.equal(waiting.todos[0]!.notes_truncated, false);
  assert.deepEqual(waiting.todos[0]!.requested_by, { kind: "agent", id: AGENT, name: "Claude" });
  assert.equal(waiting.todos[1]!.offer_id, OFFER_1);
  assert.equal(waiting.todos[1]!.offer_start, "now");
  assert.deepEqual(waiting.todos[1]!.offer_gate, { kind: "at", at: AT_ISO });

  const archived = parseWaitingArchivedPage({
    workspace_id: WS,
    generated_at: "2026-11-25T15:00:00Z",
    total: 1,
    truncated: false,
    items: [{
      item_key: `todo:${TODO_1}`,
      kind: "todo",
      id: TODO_1,
      todo_id: TODO_1,
      ask_kind: null,
      title: "Approve vendor invoice",
      from: { kind: "agent", id: AGENT, name: "Claude" },
      outcome_kind: "approved",
      outcome_text: `Approved · ${XSS_PAYLOAD}`,
      archived_at: "2026-11-25T15:00:00Z",
      answered_by: { kind: "user", id: OWNER, name: "Owner", by_viewer: true },
      placement: "general",
      channel_id: null,
      conversation_id: null,
      conversation_kind: "general",
    }],
  }, WS);
  assert.equal(archived?.items[0]!.outcome_kind, "approved");

  // #730 Fix #1: householdSurface forwards isAlive to postCommand and surfaces HomeOperationRetired on retirement.
  const capturedOpts: Array<unknown> = [];
  const aliveFn = () => true;
  const server = createHomeServer(makeSession("tok") as never, {
    postCommand: async (_s, _id, _cmd, _extra, _u, opts) => {
      capturedOpts.push(opts);
      return { status: 0, body: { error: "operation_retired", message: "Action cancelled." } };
    },
    client: () => null,
  }, null, { accountRouted: true, isAlive: aliveFn });

  await assert.rejects(
    () => server.decideTodo(WS, { todo_id: TODO_1, base_version: 5, decision: "approve" }, "req-1"),
    HomeOperationRetired,
  );
  await assert.rejects(
    () => server.answerRequest(WS, { todo_id: TODO_2, offer_id: OFFER_1, base_version: 7, answer: "accept" }, "req-2"),
    HomeOperationRetired,
  );
  assert.equal(capturedOpts.length, 2);
  for (const opt of capturedOpts) {
    assert.equal((opt as { isAlive?: unknown }).isAlive, aliveFn, "householdSurface must forward isAlive");
    assert.equal((opt as { accountWideWorkspace?: unknown }).accountWideWorkspace, true);
  }

  // readTodo preserves kind, decision_status, and decision.
  const readServer = createHomeServer(makeSession("tok") as never, {
    postCommand: async () => ({
      status: 200,
      body: {
        status: "ok",
        todo: {
          workspace_id: WS,
          todo_id: TODO_1,
          version: 6,
          kind: "approval",
          title: "Approve vendor invoice",
          notes: "Full notes",
          state: "done",
          due_on: "2026-11-30",
          created_by: { user_id: OWNER, principal_id: AGENT },
          created_at: "2026-11-25T13:00:00Z",
          assignee: { kind: "user", id: OWNER },
          assigned_by: { user_id: OWNER, principal_id: AGENT },
          assigned_at: "2026-11-25T13:00:00Z",
          offer: null,
          gate: { kind: "none" },
          gate_clear: true,
          queue_position: null,
          state_by: { user_id: OWNER, principal_id: null },
          state_at: "2026-11-25T14:55:00Z",
          comment_count: 0,
          decision_status: "approved",
          decision: { status: "approved", by: OWNER, at: "2026-11-25T14:55:00Z", note: "Ship it" },
        },
        comments: [],
        next_comment_offset: null,
      },
    }),
    client: () => null,
  });
  const read = await readServer.readTodo(WS, TODO_1);
  assert.equal(read.todo.kind, "approval");
  assert.equal(read.todo.decision_status, "approved");
  assert.deepEqual(read.todo.decision, { status: "approved", by: OWNER, at: "2026-11-25T14:55:00Z", note: "Ship it" });
});

// ---------- 2. Waiting on you approval cards & regular task cards ----------

test("Waiting on you approval cards: inline Approve/Decline with optional note & base_version, truncated notes route to Review & decide, regular tasks keep Mark done", () => {
  const doc = makeDoc();
  const host = doc.createElement("div");
  const decisions: Array<{ id: string; version?: number; decision: string; note: string | null }> = [];
  const opened: string[] = [];
  const markedDone: string[] = [];

  const approvalItem: WaitingTodoItem = {
    id: TODO_1,
    workspaceId: WS,
    workspaceName: "Home",
    title: "Approve quarterly budget",
    state: "open",
    dueOn: "2026-11-30",
    reason: "assigned",
    href: `/app?w=${WS}&v=todo&t=${TODO_1}`,
    canMarkDone: false,
    version: 4,
    kind: "approval",
    notesPreview: `Includes travel line ${XSS_PAYLOAD}`,
    notesTruncated: false,
    requestedBy: { kind: "agent", id: AGENT, name: "Claude" },
    placement: "general",
  };
  const truncatedApproval: WaitingTodoItem = {
    ...approvalItem,
    id: TODO_2,
    title: "Approve long contract",
    href: `/app?w=${WS}&v=todo&t=${TODO_2}`,
    notesPreview: "A".repeat(200),
    notesTruncated: true,
  };
  const regularTask: WaitingTodoItem = {
    id: TODO_3,
    workspaceId: WS,
    workspaceName: "Home",
    title: "Buy milk",
    state: "open",
    dueOn: null,
    reason: "assigned",
    href: `/app?w=${WS}&v=todo&t=${TODO_3}`,
    canMarkDone: true,
    version: 2,
    kind: "task",
    placement: "workspace",
  };

  renderWaitingPanel(host, makeWaitingVM([approvalItem, truncatedApproval, regularTask]), {
    onScopeChange: () => {},
    onClose: () => {},
    onRetryLoad: () => {},
    onSubmitChoice: () => {},
    onRetryChoice: () => {},
    onDraftChoice: () => {},
    onMarkTodoDone: item => markedDone.push(item.id),
    onDecideTodo: (item, decision, note) => decisions.push({ id: item.id, version: item.version, decision, note }),
    onOpenTodo: item => opened.push(item.id),
    onDismissTodo: () => {},
  });

  // 1) Non-truncated approval card
  const card1 = host.querySelector(`[data-waiting-todo="${TODO_1}"]`) as unknown as FakeElement;
  assert.ok(card1);
  assert.equal(card1.querySelector("[data-waiting-todo-done]"), null, "approval must not show Mark done");
  assert.ok(card1.textContent.includes("From Claude"));
  assert.ok(card1.textContent.includes("Due Nov 30"));
  const notesEl = card1.querySelector(`[data-waiting-todo-notes="${TODO_1}"]`) as unknown as FakeElement;
  assert.equal(notesEl.textContent, `Includes travel line ${XSS_PAYLOAD}`);
  assert.equal(notesEl.querySelectorAll("img").length, 0, "notesPreview XSS inert");
  assert.equal(notesEl.querySelectorAll("script").length, 0, "notesPreview script inert");

  const noteToggle = card1.querySelector(`[data-waiting-todo-note-toggle="${TODO_1}"]`) as unknown as FakeElement;
  const noteInput = card1.querySelector(`[data-waiting-todo-note="${TODO_1}"]`) as unknown as FakeElement;
  assert.ok(noteToggle && noteInput);
  assert.equal(noteInput.maxLength, 500);
  noteToggle.click();
  noteInput.value = "Approved for Q4";
  (card1.querySelector(`[data-waiting-todo-approve="${TODO_1}"]`) as unknown as FakeElement).click();
  (card1.querySelector(`[data-waiting-todo-decline="${TODO_1}"]`) as unknown as FakeElement).click();
  assert.deepEqual(decisions, [
    { id: TODO_1, version: 4, decision: "approve", note: "Approved for Q4" },
    { id: TODO_1, version: 4, decision: "decline", note: "Approved for Q4" },
  ]);
  assert.ok(card1.querySelector(`[data-waiting-dismiss="todo"]`), "Dismiss remains available as Not yet");
  assert.ok(card1.querySelector(`[data-waiting-todo-open="${TODO_1}"]`), "Open link present");

  // 2) Truncated approval routes to Review & decide (hides inline Approve/Decline)
  const card2 = host.querySelector(`[data-waiting-todo="${TODO_2}"]`) as unknown as FakeElement;
  assert.ok(card2);
  assert.equal(card2.querySelector(`[data-waiting-todo-approve="${TODO_2}"]`), null);
  assert.equal(card2.querySelector(`[data-waiting-todo-decline="${TODO_2}"]`), null);
  const review2 = card2.querySelector(`[data-waiting-todo-review="${TODO_2}"]`) as unknown as FakeElement;
  assert.ok(review2);
  assert.equal(review2.textContent, "Review & decide");
  review2.click();
  assert.deepEqual(opened, [TODO_2]);

  // 3) Regular task stays Mark done
  const card3 = host.querySelector(`[data-waiting-todo="${TODO_3}"]`) as unknown as FakeElement;
  assert.ok(card3);
  assert.equal(card3.querySelector(`[data-waiting-todo-approve="${TODO_3}"]`), null);
  const doneBtn = card3.querySelector(`[data-waiting-todo-done="${TODO_3}"]`) as unknown as FakeElement;
  assert.equal(doneBtn.textContent, "Mark done");
  doneBtn.click();
  assert.deepEqual(markedDone, [TODO_3]);

  // 4) todoCardSignature re-renders when any additive field (e.g. version or notesPreview) changes
  renderWaitingPanel(host, makeWaitingVM([{ ...approvalItem, version: 5, notesPreview: "Updated $450" }]), {
    onScopeChange: () => {},
    onClose: () => {},
    onRetryLoad: () => {},
    onSubmitChoice: () => {},
    onRetryChoice: () => {},
    onDraftChoice: () => {},
    onDecideTodo: () => {},
    onOpenTodo: () => {},
    onDismissTodo: () => {},
  });
  const card1After = host.querySelector(`[data-waiting-todo="${TODO_1}"]`) as unknown as FakeElement;
  assert.notEqual(card1After, card1, "version/notesPreview change must replace card DOM");
  assert.equal(card1After.dataset.waitingTodoVersion, "5");
  assert.equal(card1After.querySelector(`[data-waiting-todo-notes="${TODO_1}"]`)!.textContent, "Updated $450");
});

// ---------- 3. Mounted offer gate-terms tests on BOTH inline Chat OfferCard AND Waiting on you ----------

test("Mounted offer decisions on BOTH Waiting on you and inline Chat OfferCard enforce exact R4 Section 2.3 gate-terms rules and XSS inertness", () => {
  const exactAt = formatExactOfferAt(AT_ISO);
  assert.ok(exactAt && exactAt.includes("2026"), `expected formatted exact date/time, got ${exactAt}`);

  const doc = makeDoc();
  const cases: Array<{
    name: string;
    gate: unknown;
    hasNotes: boolean;
    expectInline: boolean;
    expectGateKind?: "at" | "hold";
    expectGateSubstr?: string;
  }> = [
    { name: "none gate, no notes", gate: { kind: "none" }, hasNotes: false, expectInline: true },
    { name: "valid at gate", gate: { kind: "at", at: AT_ISO }, hasNotes: false, expectInline: true, expectGateKind: "at", expectGateSubstr: exactAt! },
    { name: "missing at timestamp", gate: { kind: "at", at: "" }, hasNotes: false, expectInline: false },
    { name: "invalid at timestamp", gate: { kind: "at", at: "not-a-date" }, hasNotes: false, expectInline: false },
    { name: "valid hold note with XSS payload", gate: { kind: "hold", note: `Wait for signoff ${XSS_PAYLOAD}` }, hasNotes: false, expectInline: true, expectGateKind: "hold", expectGateSubstr: `Wait for signoff ${XSS_PAYLOAD}` },
    { name: "hold note null", gate: { kind: "hold", note: null }, hasNotes: false, expectInline: false },
    { name: "hold note empty", gate: { kind: "hold", note: "   " }, hasNotes: false, expectInline: false },
    { name: "hold note truncated (>200 chars)", gate: { kind: "hold", note: "x".repeat(201) }, hasNotes: false, expectInline: false },
    { name: "hold note flagged truncated", gate: { kind: "hold", note: "Wait", truncated: true }, hasNotes: false, expectInline: false },
    { name: "after gate", gate: { kind: "after", todo_id: TODO_3 }, hasNotes: false, expectInline: false },
    { name: "unrecognized gate", gate: { kind: "custom_gate" }, hasNotes: false, expectInline: false },
    { name: "missing gate", gate: null, hasNotes: false, expectInline: false },
    { name: "notesTruncated / hasNotes true with none gate", gate: { kind: "none" }, hasNotes: true, expectInline: false },
    { name: "notesTruncated / hasNotes true with valid at gate", gate: { kind: "at", at: AT_ISO }, hasNotes: true, expectInline: false },
  ];

  for (const c of cases) {
    // Direct helper check
    const evalRes = evaluateInlineOfferTerms({ hasUnshownNotes: c.hasNotes, offerGate: c.gate });
    assert.equal(evalRes.eligible, c.expectInline, `helper eligibility for: ${c.name}`);

    // A) Waiting on you mounted DOM
    const waitingHost = doc.createElement("div");
    const waitingAnswers: Array<{ id: string; offerId?: string | null; version?: number; answer: string }> = [];
    const waitingOpens: string[] = [];
    const waitingItem: WaitingTodoItem = {
      id: TODO_1,
      workspaceId: WS,
      workspaceName: "Home",
      title: "Deploy release",
      state: "open",
      dueOn: "2026-11-28",
      reason: "request",
      href: `/app?w=${WS}&v=todo&t=${TODO_1}`,
      canMarkDone: false,
      version: 9,
      kind: "task",
      notesPreview: c.hasNotes ? "A".repeat(200) : null,
      notesTruncated: c.hasNotes,
      requestedBy: { kind: "user", id: OTHER_USER, name: "Nikki" },
      offerId: OFFER_1,
      offerTo: { kind: "agent", id: AGENT, name: "Claude" },
      offerStart: "now",
      offerGate: c.gate as never,
      placement: "workspace",
    };
    renderWaitingPanel(waitingHost, makeWaitingVM([waitingItem]), {
      onScopeChange: () => {},
      onClose: () => {},
      onRetryLoad: () => {},
      onSubmitChoice: () => {},
      onRetryChoice: () => {},
      onDraftChoice: () => {},
      onAnswerTodoOffer: (item, answer) => waitingAnswers.push({ id: item.id, offerId: item.offerId, version: item.version, answer }),
      onOpenTodo: item => waitingOpens.push(item.id),
      onDismissTodo: () => {},
    });
    const wCard = waitingHost.querySelector(`[data-waiting-todo="${TODO_1}"]`) as unknown as FakeElement;
    assert.ok(wCard, `Waiting card mounted for ${c.name}`);
    assert.equal(wCard.querySelectorAll("img").length, 0, `Waiting XSS img check (${c.name})`);
    assert.equal(wCard.querySelectorAll("script").length, 0, `Waiting XSS script check (${c.name})`);

    if (c.expectInline) {
      const approveBtn = wCard.querySelector(`[data-waiting-todo-approve="${TODO_1}"]`) as unknown as FakeElement;
      const declineBtn = wCard.querySelector(`[data-waiting-todo-decline="${TODO_1}"]`) as unknown as FakeElement;
      assert.ok(approveBtn && declineBtn, `Waiting inline buttons expected for ${c.name}`);
      assert.equal(wCard.querySelector(`[data-waiting-todo-review="${TODO_1}"]`), null);
      if (c.expectGateKind && c.expectGateSubstr) {
        const term = wCard.querySelector(`[data-offer-gate-term="${c.expectGateKind}"]`) as unknown as FakeElement;
        assert.ok(term && term.textContent.includes(c.expectGateSubstr), `Waiting exact gate text for ${c.name}`);
      }
      approveBtn.click();
      declineBtn.click();
      assert.deepEqual(waitingAnswers, [
        { id: TODO_1, offerId: OFFER_1, version: 9, answer: "accept" },
        { id: TODO_1, offerId: OFFER_1, version: 9, answer: "decline" },
      ]);
    } else {
      assert.equal(wCard.querySelector(`[data-waiting-todo-approve="${TODO_1}"]`), null, `Waiting hides Approve for ${c.name}`);
      assert.equal(wCard.querySelector(`[data-waiting-todo-decline="${TODO_1}"]`), null, `Waiting hides Decline for ${c.name}`);
      const review = wCard.querySelector(`[data-waiting-todo-review="${TODO_1}"]`) as unknown as FakeElement;
      assert.ok(review && review.textContent === "Review & decide", `Waiting shows Review & decide for ${c.name}`);
      review.click();
      assert.deepEqual(waitingOpens, [TODO_1]);
    }

    // B) Inline Chat OfferCard mounted DOM
    const summary = makeOfferSummary({
      version: 9,
      has_notes: c.hasNotes,
      offer: {
        offer_id: OFFER_1,
        to: { kind: "agent", id: AGENT },
        decider_user_id: OWNER,
        start: "now",
        gate: c.gate as never,
        by: { user_id: OTHER_USER, principal_id: null },
        at: "2026-11-25T14:00:00.000Z",
      },
    });
    const cards = pendingOfferCards(
      [summary],
      OWNER,
      p => p.kind === "agent" ? "Claude" : "Nikki",
      id => `/app?w=${WS}&v=todo&t=${id}`,
    );
    assert.equal(cards.length, 1);
    const chatAnswers: Array<{ todoId: string; offerId: string; version: number; answer: string }> = [];
    const chatOpens: string[] = [];
    const cardEl = buildOfferCard(doc, cards[0]!, {
      answer: (card, answer) => chatAnswers.push({ todoId: card.todoId, offerId: card.offerId, version: card.version, answer }),
      openDetail: card => chatOpens.push(card.todoId),
    }) as unknown as FakeElement;

    assert.equal(cardEl.querySelectorAll("img").length, 0, `Chat OfferCard XSS img check (${c.name})`);
    assert.equal(cardEl.querySelectorAll("script").length, 0, `Chat OfferCard XSS script check (${c.name})`);

    if (c.expectInline) {
      const acceptBtn = cardEl.querySelector(`[data-offer-answer="accept"]`) as unknown as FakeElement;
      const declineBtn = cardEl.querySelector(`[data-offer-answer="decline"]`) as unknown as FakeElement;
      assert.ok(acceptBtn && declineBtn, `Chat OfferCard inline buttons expected for ${c.name}`);
      assert.equal(cardEl.querySelector(`[data-offer-review="${TODO_1}"]`), null);
      if (c.expectGateKind && c.expectGateSubstr) {
        const term = cardEl.querySelector(`[data-offer-gate-term="${c.expectGateKind}"]`) as unknown as FakeElement;
        assert.ok(term && term.textContent.includes(c.expectGateSubstr), `Chat OfferCard exact gate text for ${c.name}`);
      }
      acceptBtn.click();
      declineBtn.click();
      assert.deepEqual(chatAnswers, [
        { todoId: TODO_1, offerId: OFFER_1, version: 9, answer: "accept" },
        { todoId: TODO_1, offerId: OFFER_1, version: 9, answer: "decline" },
      ]);
    } else {
      assert.equal(cardEl.querySelector(`[data-offer-answer="accept"]`), null, `Chat OfferCard hides Accept for ${c.name}`);
      assert.equal(cardEl.querySelector(`[data-offer-answer="decline"]`), null, `Chat OfferCard hides Decline for ${c.name}`);
      const review = cardEl.querySelector(`[data-offer-review="${TODO_1}"]`) as unknown as FakeElement;
      assert.ok(review && review.textContent === "Review & decide", `Chat OfferCard shows Review & decide for ${c.name}`);
      review.click();
      assert.deepEqual(chatOpens, [TODO_1]);
    }
  }
});

// ---------- 4. To-do detail view (pending approval, pending offer with full terms, decided approval) ----------

test("To-do detail view renders pending approval, pending offer full terms, and decided approval with XSS-inert note and disabled edits", () => {
  const people = mapHomePeople({
    workspaceId: WS,
    viewerId: OWNER,
    members: [
      { userId: OWNER, name: "Alex Owner", role: "owner" },
      { userId: OTHER_USER, name: "Nikki Member", role: "member" },
    ],
    agents: [{ principalId: AGENT, name: "Claude", ownerUserId: OWNER }],
    access: [],
    signals: [],
    now: NOW,
    sample: false,
  });
  const ctx = { workspaceId: WS, people, viewerId: OWNER, editor: true, sample: false, now: NOW };
  const doc = makeDoc();

  // A) Pending approval
  const pendingApprovalRow: Todo = {
    workspace_id: WS,
    todo_id: TODO_1,
    version: 3,
    kind: "approval",
    title: "Publish release notes",
    notes: "Full release notes body for review.",
    state: "open",
    due_on: "2026-11-30",
    created_by: { user_id: OWNER, principal_id: AGENT },
    created_at: "2026-11-25T13:00:00Z",
    assignee: { kind: "user", id: OWNER },
    assigned_by: { user_id: OWNER, principal_id: AGENT },
    assigned_at: "2026-11-25T13:00:00Z",
    offer: null,
    gate: { kind: "none" },
    gate_clear: true,
    queue_position: null,
    state_by: { user_id: OWNER, principal_id: AGENT },
    state_at: "2026-11-25T13:00:00Z",
    comment_count: 0,
    decision_status: null,
    decision: null,
  };
  const pendingVM = mapHomeTodo(pendingApprovalRow, ctx, [], []);
  const detailDecisions: Array<{ decision: string; note: string | null }> = [];
  const pendingEl = todoView(doc, {
    workspace: { name: "Home", todosHref: `/app?w=${WS}&v=todos`, homeHref: `/app?w=${WS}` },
    view: { kind: "ready", todo: pendingVM },
    now: NOW,
    people,
    openTodos: [],
    save: "idle",
  }, {
    complete: () => {},
    assign: () => {},
    setStart: () => {},
    comment: () => {},
    decide: (decision, note) => detailDecisions.push({ decision, note }),
  }) as unknown as FakeElement;

  assert.equal(pendingEl.querySelector("[data-todo-complete]"), null, "approval detail must not show Mark done checkbox");
  assert.ok(pendingEl.textContent.includes("Publish release notes"));
  assert.ok(pendingEl.textContent.includes("Full release notes body for review."));
  assert.ok(pendingEl.textContent.includes("Requested by Your Claude"));
  const noteInput = pendingEl.querySelector("[data-todo-decision-note-input]") as unknown as FakeElement;
  assert.equal(noteInput.maxLength, 500);
  noteInput.value = "Looks solid";
  (pendingEl.querySelector("[data-todo-approve]") as unknown as FakeElement).click();
  (pendingEl.querySelector("[data-todo-decline]") as unknown as FakeElement).click();
  assert.deepEqual(detailDecisions, [
    { decision: "approve", note: "Looks solid" },
    { decision: "decline", note: "Looks solid" },
  ]);

  // B) Pending offer with full terms (by, to, start, authoritative after prerequisite)
  const offerRow: Todo = {
    ...pendingApprovalRow,
    todo_id: TODO_2,
    kind: "task",
    assignee: null,
    offer: {
      offer_id: OFFER_2,
      to: { kind: "agent", id: AGENT },
      decider_user_id: OWNER,
      start: "now",
      gate: { kind: "after", todo_id: TODO_3 },
      by: { user_id: OTHER_USER, principal_id: null },
      at: "2026-11-25T14:00:00Z",
    },
    offer_prerequisite: {
      todo_id: TODO_3,
      title: "Finish QA checklist",
      state: "open",
    },
  };
  const prereqSummary = makeOfferSummary({ todo_id: TODO_3, title: "Finish QA checklist", offer: null });
  const offerVM = mapHomeTodo(offerRow, ctx, [prereqSummary], []);
  const offerAnswers: string[] = [];
  const offerEl = todoView(doc, {
    workspace: { name: "Home", todosHref: `/app?w=${WS}&v=todos`, homeHref: `/app?w=${WS}` },
    view: { kind: "ready", todo: offerVM },
    now: NOW,
    people,
    openTodos: [{ id: TODO_3, title: "Finish QA checklist" }],
    save: "idle",
  }, {
    complete: () => {},
    assign: () => {},
    setStart: () => {},
    comment: () => {},
    answerOffer: answer => offerAnswers.push(answer),
  }) as unknown as FakeElement;

  const offerPanel = offerEl.querySelector(`[data-todo-offer-panel="${OFFER_2}"]`) as unknown as FakeElement;
  assert.ok(offerPanel);
  assert.ok(offerPanel.textContent.includes("Requested by Nikki"));
  assert.ok(offerPanel.textContent.includes("For Your Claude"));
  assert.ok(offerPanel.textContent.includes("Start now"));
  assert.ok(offerPanel.textContent.includes("After ‘Finish QA checklist’"));
  (offerPanel.querySelector(`[data-todo-offer-answer="accept"]`) as unknown as FakeElement).click();
  (offerPanel.querySelector(`[data-todo-offer-answer="decline"]`) as unknown as FakeElement).click();
  assert.deepEqual(offerAnswers, ["accept", "decline"]);

  // C) Decided approval: status line Approved/Declined by <name> · <time>, XSS-inert note, edits hidden/disabled
  for (const status of ["approved", "declined"] as const) {
    const decidedRow: Todo = {
      ...pendingApprovalRow,
      state: status === "approved" ? "done" : "dropped",
      decision_status: status,
      decision: {
        status,
        by: OWNER,
        at: "2026-11-25T14:40:00Z",
        note: `Decision note ${XSS_PAYLOAD}`,
      },
    };
    const decidedVM = mapHomeTodo(decidedRow, ctx, [], []);
    assert.equal(decidedVM.may.edit, false);
    assert.equal(decidedVM.may.assign, false);
    assert.equal(decidedVM.may.complete, false);
    assert.equal(decidedVM.may.comment, false);
    const decidedEl = todoView(doc, {
      workspace: { name: "Home", todosHref: `/app?w=${WS}&v=todos`, homeHref: `/app?w=${WS}` },
      view: { kind: "ready", todo: decidedVM },
      now: NOW,
      timeZone: "UTC",
      people,
      openTodos: [],
      save: "idle",
    }, { complete: () => {}, assign: () => {}, setStart: () => {}, comment: () => {}, decide: () => {} }) as unknown as FakeElement;

    const statusEl = decidedEl.querySelector(`[data-todo-decision-status="${status}"]`) as unknown as FakeElement;
    assert.ok(statusEl);
    assert.match(statusEl.textContent, status === "approved" ? /^Approved by you · / : /^Declined by you · /);
    const noteEl = decidedEl.querySelector("[data-todo-decision-note]") as unknown as FakeElement;
    assert.equal(noteEl.textContent, `Decision note ${XSS_PAYLOAD}`);
    assert.equal(noteEl.querySelectorAll("img").length, 0);
    assert.equal(noteEl.querySelectorAll("script").length, 0);
    assert.equal(decidedEl.querySelector("[data-todo-complete]"), null, "no Mark done checkbox on decided approval");
    assert.equal(decidedEl.querySelector("[data-todo-assigned]"), null, "edit/assign panel hidden on decided approval");
    assert.equal(decidedEl.querySelector("[data-todo-comment-form]"), null, "comment edit form hidden on decided approval");
  }
});

// ---------- 5. Stale base_version conflict (ZERO silent auto-retry) + unchanged control on Waiting, OfferCard, Detail ----------

test("Stale base_version fails cleanly with ZERO silent auto-retry across Waiting, Chat OfferCard, and To-do detail; unchanged control succeeds", async () => {
  const code = await extractDashboardFunctions([
    "homeRefusalCopy",
    "homeWrite",
    "applyWaitingTodoConflictTerms",
    "runWaitingTodoDecision",
    "decideWaitingTodo",
    "answerWaitingTodoOffer",
    "answerOffer",
  ]);

  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let mode: "conflict" | "committed" = "conflict";
  const updatedTodo: Todo = {
    workspace_id: WS,
    todo_id: TODO_1,
    version: 6,
    kind: "approval",
    title: "Updated title after edit",
    notes: "Updated notes",
    state: "open",
    due_on: "2026-12-01",
    created_by: { user_id: OWNER, principal_id: AGENT },
    created_at: "2026-11-25T13:00:00Z",
    assignee: { kind: "user", id: OWNER },
    assigned_by: { user_id: OWNER, principal_id: AGENT },
    assigned_at: "2026-11-25T13:00:00Z",
    offer: null,
    gate: { kind: "none" },
    gate_clear: true,
    queue_position: null,
    state_by: { user_id: OWNER, principal_id: AGENT },
    state_at: "2026-11-25T14:50:00Z",
    comment_count: 0,
    decision_status: null,
  };

  const waitingItem: WaitingTodoItem = {
    id: TODO_1,
    workspaceId: WS,
    workspaceName: "Home",
    title: "Original title",
    state: "open",
    dueOn: null,
    reason: "assigned",
    href: `/app?w=${WS}&v=todo&t=${TODO_1}`,
    canMarkDone: false,
    version: 5,
    kind: "approval",
    notesPreview: "Original notes",
    notesTruncated: false,
  };
  const waitingOfferItem: WaitingTodoItem = {
    ...waitingItem,
    id: TODO_2,
    reason: "request",
    kind: "task",
    offerId: OFFER_1,
    offerStart: "queue",
    offerGate: { kind: "none" },
  };

  const serverStub = {
    decideTodo: async (_ws: string, input: Record<string, unknown>) => {
      calls.push({ method: "decideTodo", input });
      return mode === "conflict"
        ? { status: "conflict", current: updatedTodo }
        : { status: "committed", value: { ...updatedTodo, state: "done", decision_status: "approved" }, notices: [], replayed: false };
    },
    answerRequest: async (_ws: string, input: Record<string, unknown>) => {
      calls.push({ method: "answerRequest", input });
      return mode === "conflict"
        ? { status: "conflict", current: { ...updatedTodo, todo_id: TODO_2, kind: "task", offer: { offer_id: OFFER_2, to: { kind: "agent", id: AGENT }, decider_user_id: OWNER, start: "now", gate: { kind: "hold", note: "Wait" }, by: { user_id: OTHER_USER, principal_id: null }, at: "2026-11-25T14:50:00Z" } } }
        : { status: "committed", value: { ...updatedTodo, todo_id: TODO_2, kind: "task", offer: null }, notices: [], replayed: false };
    },
  };

  const ctx = createContext({
    TODO_CONFLICT_MESSAGE,
    TODO_SAVE_FAILED: "Not saved.",
    TODO_RESULT_UNKNOWN: "Unknown.",
    HomeCommandRefused,
    HomeOperationRetired,
    HomeToolsUnavailable,
    CommandOutcomeUnknown: class extends Error {},
    crypto: { randomUUID: () => "cmd-1" },
    uuid: () => "cmd-1",
    sampleMode: false,
    activeWorkspaceId: WS,
    workspaces: [{ id: WS, name: "Home" }],
    homeWorkspaceGeneration: 1,
    homeNavigation: 1,
    homeTodoSave: "idle",
    homeTodoReceipt: "",
    homeTodoNotice: null,
    homeTodoRead: { todo: { ...updatedTodo, version: 5 }, comments: [] },
    homeDetailKey: "k",
    homeTodosState: "ready",
    homeTodoRows: [],
    homeQueue: null,
    homeQueueRead: "ready",
    homeRoute: { view: "todo" },
    homePolicies: new Map(),
    homeOverviewCounts: new Map([[WS, 2]]),
    waitingAuthGeneration: 1,
    waitingActionGuard: () => () => true,
    homeViewerId: () => OWNER,
    homeServer: () => serverStub,
    waitingTodoTickets: new Map(),
    waitingTodoErrors: new Map(),
    waitingPanelTodos: new Map([[WS, [waitingItem, waitingOfferItem]]]),
    newWaitingAttemptId: () => "att-1",
    one: () => null,
    all: () => [],
    document: { activeElement: null },
    waitingPanelMod: null,
    waitingSurface: null,
    showWaitingStatus: () => {},
    renderWaitingPanelView: () => {},
    renderHomeRail: () => {},
    renderHomeObjectPane: () => {},
    renderHomeSide: () => {},
    renderHomeShell: () => {},
    renderFeed: () => {},
    invalidateWaitingArchived: () => {},
    scheduleWaitingRefresh: () => {},
    loadHomeWorkspace: async () => {},
  });
  runInContext(code, ctx);

  // 1) Waiting approval conflict -> 1 call only, error message set, cached terms updated to v6
  await runInContext("decideWaitingTodo(waitingPanelTodos.get(activeWorkspaceId)[0], 'approve', 'ok')", ctx);
  assert.equal(calls.length, 1, "Waiting approval must NOT silently auto-retry on conflict");
  assert.equal(calls[0]!.input.base_version, 5);
  assert.equal(runInContext(`waitingTodoErrors.get("${TODO_1}")`, ctx), TODO_CONFLICT_MESSAGE);
  assert.equal(runInContext(`waitingPanelTodos.get(activeWorkspaceId)[0].version`, ctx), 6);
  assert.equal(runInContext(`waitingPanelTodos.get(activeWorkspaceId)[0].title`, ctx), "Updated title after edit");

  // 2) Waiting offer conflict -> 1 call only, error message set, cached offer updated to OFFER_2/v6
  await runInContext("answerWaitingTodoOffer(waitingPanelTodos.get(activeWorkspaceId)[1], 'accept')", ctx);
  assert.equal(calls.length, 2, "Waiting offer must NOT silently auto-retry on conflict");
  assert.equal(calls[1]!.input.base_version, 5);
  assert.equal(calls[1]!.input.offer_id, OFFER_1);
  assert.equal(runInContext(`waitingTodoErrors.get("${TODO_2}")`, ctx), TODO_CONFLICT_MESSAGE);
  assert.equal(runInContext(`waitingPanelTodos.get(activeWorkspaceId)[1].offerId`, ctx), OFFER_2);
  assert.equal(runInContext(`waitingPanelTodos.get(activeWorkspaceId)[1].version`, ctx), 6);

  // 3) Chat OfferCard conflict -> 1 call only, status text set, buttons disabled (no silent retry)
  const chatControls = { buttons: [{ disabled: false }, { disabled: false }], status: { textContent: "" } };
  (ctx as Record<string, unknown>).chatControls = chatControls;
  (ctx as Record<string, unknown>).chatCard = {
    todoId: TODO_2, offerId: OFFER_1, version: 5, title: "T", who: "Claude", toViewer: false,
    dueOn: null, requesterName: null, start: "queue", offerGate: { kind: "none" }, hasNotes: false,
  };
  runInContext("answerOffer(chatCard, 'accept', chatControls)", ctx);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 3, "Chat OfferCard must NOT silently auto-retry on conflict");
  assert.equal(calls[2]!.input.base_version, 5);
  assert.equal(chatControls.status.textContent, TODO_CONFLICT_MESSAGE);
  assert.equal(chatControls.buttons[0]!.disabled, true);

  // 4) To-do detail homeWrite conflict -> 1 call only, receipt updated, homeTodoRead refreshed
  await runInContext(`homeWrite((s, id) => s.decideTodo("${WS}", { todo_id: "${TODO_1}", base_version: 5, decision: "approve" }, id))`, ctx);
  assert.equal(calls.length, 4, "To-do detail must NOT silently auto-retry on conflict");
  assert.equal(runInContext("homeTodoReceipt", ctx), TODO_CONFLICT_MESSAGE);
  assert.equal(runInContext("homeTodoRead.todo.version", ctx), 6);

  // 5) Unchanged-version controls succeed across all 3 surfaces
  mode = "committed";
  await runInContext("decideWaitingTodo(waitingPanelTodos.get(activeWorkspaceId)[0], 'approve', 'ok')", ctx);
  assert.equal(calls.length, 5);
  assert.equal(calls[4]!.input.base_version, 6);
  assert.equal(runInContext(`waitingTodoErrors.has("${TODO_1}")`, ctx), false);

  await runInContext("answerWaitingTodoOffer(waitingPanelTodos.get(activeWorkspaceId)[0], 'accept')", ctx);
  assert.equal(calls.length, 6);
  assert.equal(calls[5]!.input.base_version, 6);
  assert.equal(calls[5]!.input.offer_id, OFFER_2);

  (ctx as Record<string, unknown>).chatCard = { ...(ctx as Record<string, unknown>).chatCard as object, offerId: OFFER_2, version: 6 };
  runInContext("answerOffer(chatCard, 'accept', chatControls)", ctx);
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 7);
  assert.equal(chatControls.status.textContent, "Accepted.");
});

// ---------- 6. #730 login-generation fence regression test (observer) ----------

test("#730 login-generation fence: Mark done, Approve, Decline, and answerRequest across Waiting, Chat OfferCard, and To-do detail abort with operation_retired, 0 requests, and 0 UI mutations across sign-out, same-user re-sign-in, and account switch", async () => {
  const code = await extractDashboardFunctions([
    "homeRefusalCopy",
    "waitingActionGuard",
    "homeWrite",
    "markWaitingTodoDone",
    "applyWaitingTodoConflictTerms",
    "runWaitingTodoDecision",
    "decideWaitingTodo",
    "answerWaitingTodoOffer",
    "answerOffer",
  ]);

  type TransitionKind = "sign-out" | "re-sign-in" | "account-switch" | "unchanged-control";
  type ActionKind =
    | "waiting-mark-done"
    | "waiting-approve"
    | "waiting-decline"
    | "waiting-offer"
    | "chat-offer"
    | "detail-approve"
    | "detail-offer";

  const transitions: TransitionKind[] = ["sign-out", "re-sign-in", "account-switch", "unchanged-control"];
  const actions: ActionKind[] = [
    "waiting-mark-done",
    "waiting-approve",
    "waiting-decline",
    "waiting-offer",
    "chat-offer",
    "detail-approve",
    "detail-offer",
  ];

  const login1Token = makeJwt({ sub: OWNER, session_id: "sess-login-1" });
  const login2SameUserToken = makeJwt({ sub: OWNER, session_id: "sess-login-2" });
  const login3OtherUserToken = makeJwt({ sub: OTHER_USER, session_id: "sess-login-3" });

  for (const transition of transitions) {
    for (const action of actions) {
      const initialSession = makeSession(login1Token, OWNER);
      const env = await createRealPostCommandEnv(initialSession);
      const isAccountSwitch = transition === "account-switch";
      let pinnedCurrent = true;
      const fakePinned = {
        userId: OWNER,
        isCurrent: () => pinnedCurrent,
        runtime: { client: null },
      };

      const waitingTask: WaitingTodoItem = {
        id: TODO_1, workspaceId: WS, workspaceName: "Home", title: "Task", state: "open",
        dueOn: null, reason: "assigned", href: `/app?w=${WS}&v=todo&t=${TODO_1}`,
        canMarkDone: true, version: 3, kind: "task",
      };
      const waitingApproval: WaitingTodoItem = {
        ...waitingTask, id: TODO_2, title: "Approval", canMarkDone: false, kind: "approval",
        notesPreview: "Note", notesTruncated: false,
      };
      const waitingOffer: WaitingTodoItem = {
        ...waitingTask, id: TODO_3, title: "Offer", reason: "request", canMarkDone: false,
        offerId: OFFER_1, offerStart: "queue", offerGate: { kind: "none" },
      };

      let postTransitionRenders = 0;
      let postTransitionStatusCalls = 0;
      let postTransitionRefreshes = 0;
      let transitioned = false;

      const chatControls = { buttons: [{ disabled: false }, { disabled: false }], status: { textContent: "" } };

      const ctx = createContext({
        TODO_CONFLICT_MESSAGE,
        TODO_SAVE_FAILED: "Not saved.",
        TODO_RESULT_UNKNOWN: "Unknown.",
        HomeCommandRefused,
        HomeOperationRetired,
        HomeToolsUnavailable,
        CommandOutcomeUnknown: class extends Error {},
        crypto: { randomUUID: () => `cmd-${transition}-${action}` },
        uuid: () => `cmd-${transition}-${action}`,
        sampleMode: false,
        session: initialSession,
        renderedAuthUserId: OWNER,
        renderedAuthLoginId: "sess-login-1",
        authLoginIdFor: (s: { access_token?: string } | null) => {
          if (!s?.access_token) return "";
          const parts = s.access_token.split(".");
          if (parts.length !== 3) return "";
          return (JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { session_id?: string }).session_id ?? "";
        },
        activeWorkspaceId: WS,
        workspaces: [{ id: WS, name: "Home" }],
        homeWorkspaceGeneration: 1,
        homeNavigation: 1,
        homeTodoSave: "idle",
        homeTodoReceipt: "",
        homeTodoNotice: null,
        homeTodoRead: { todo: { todo_id: TODO_1, version: 3, state: "open", kind: "approval" }, comments: [] },
        homeDetailKey: "k",
        homeTodosState: "ready",
        homeTodoRows: [{ todo_id: TODO_1, version: 3, state: "open" }],
        homeQueue: null,
        homeQueueRead: "ready",
        homeRoute: { view: "todo" },
        homePolicies: new Map(),
        homeOverviewCounts: new Map([[WS, 3]]),
        waitingAuthGeneration: 1,
        homeViewerId: () => (ctx as Record<string, unknown>).renderedAuthUserId as string,
        isMultiAccountEnabled: () => false,
        pinAccountContext: () => (isAccountSwitch ? fakePinned : null),
        homeServer: (pinned: unknown, opts?: { accountRouted?: boolean; isAlive?: () => boolean }) => {
          const activeSession = (ctx as Record<string, unknown>).session as ReturnType<typeof makeSession> | null;
          if (!activeSession) return null;
          return createHomeServer(
            activeSession as never,
            { postCommand: env.lib.postCommand as never, client: () => null },
            pinned as never,
            opts,
          );
        },
        waitingTodoTickets: new Map(),
        waitingTodoErrors: new Map(),
        waitingPanelTodos: new Map([[WS, [waitingTask, waitingApproval, waitingOffer]]]),
        newWaitingAttemptId: () => "att-1",
        one: () => null,
        all: () => [],
        document: { activeElement: null },
        waitingPanelMod: null,
        waitingSurface: null,
        showWaitingStatus: () => { if (transitioned) postTransitionStatusCalls += 1; },
        renderWaitingPanelView: () => { if (transitioned) postTransitionRenders += 1; },
        renderHomeRail: () => { if (transitioned) postTransitionRenders += 1; },
        renderHomeObjectPane: () => { if (transitioned) postTransitionRenders += 1; },
        renderHomeSide: () => { if (transitioned) postTransitionRenders += 1; },
        renderHomeShell: () => { if (transitioned) postTransitionRenders += 1; },
        renderFeed: () => { if (transitioned) postTransitionRenders += 1; },
        invalidateWaitingArchived: () => { if (transitioned) postTransitionRefreshes += 1; },
        scheduleWaitingRefresh: () => { if (transitioned) postTransitionRefreshes += 1; },
        loadHomeWorkspace: async () => { if (transitioned) postTransitionRefreshes += 1; },
        chatControls,
        chatCard: {
          todoId: TODO_3, offerId: OFFER_1, version: 3, title: "Offer", who: "Claude", toViewer: false,
          dueOn: null, requesterName: null, start: "queue", offerGate: { kind: "none" }, hasNotes: false,
        },
      });
      runInContext(code, ctx);

      env.armGetSessionHold();

      // Launch action while in-flight at auth.getSession()
      let actionPromise: Promise<unknown>;
      if (action === "waiting-mark-done") {
        actionPromise = runInContext("markWaitingTodoDone(waitingPanelTodos.get(activeWorkspaceId)[0])", ctx);
      } else if (action === "waiting-approve") {
        actionPromise = runInContext("decideWaitingTodo(waitingPanelTodos.get(activeWorkspaceId)[1], 'approve', null)", ctx);
      } else if (action === "waiting-decline") {
        actionPromise = runInContext("decideWaitingTodo(waitingPanelTodos.get(activeWorkspaceId)[1], 'decline', 'no')", ctx);
      } else if (action === "waiting-offer") {
        actionPromise = runInContext("answerWaitingTodoOffer(waitingPanelTodos.get(activeWorkspaceId)[2], 'accept')", ctx);
      } else if (action === "chat-offer") {
        runInContext("answerOffer(chatCard, 'accept', chatControls)", ctx);
        actionPromise = new Promise(r => setImmediate(r));
      } else if (action === "detail-approve") {
        actionPromise = runInContext(`homeWrite((s, id) => s.decideTodo("${WS}", { todo_id: "${TODO_2}", base_version: 3, decision: "approve" }, id), () => "Approved.")`, ctx);
      } else {
        actionPromise = runInContext(`homeWrite((s, id) => s.answerRequest("${WS}", { todo_id: "${TODO_3}", offer_id: "${OFFER_1}", base_version: 3, answer: "accept" }, id), () => "Accepted.")`, ctx);
      }

      await env.waitForGetSessionStart();

      // Trigger the transition while command acquisition is in flight
      if (transition === "sign-out") {
        transitioned = true;
        env.setStorageSession(null);
        runInContext(`session = null; renderedAuthUserId = ""; renderedAuthLoginId = ""; waitingAuthGeneration += 1; homeTodoReceipt = "Signed out";`, ctx);
      } else if (transition === "re-sign-in") {
        transitioned = true;
        const nextSess = makeSession(login2SameUserToken, OWNER);
        env.setStorageSession(nextSess);
        (ctx as Record<string, unknown>)._nextSess = nextSess;
        runInContext(`session = _nextSess; renderedAuthUserId = "${OWNER}"; renderedAuthLoginId = "sess-login-2"; waitingAuthGeneration += 1; homeTodoReceipt = "Fresh login";`, ctx);
      } else if (transition === "account-switch") {
        transitioned = true;
        pinnedCurrent = false;
        const nextSess = makeSession(login3OtherUserToken, OTHER_USER);
        env.setStorageSession(nextSess);
        (ctx as Record<string, unknown>)._nextSess = nextSess;
        runInContext(`session = _nextSess; renderedAuthUserId = "${OTHER_USER}"; renderedAuthLoginId = "sess-login-3"; waitingAuthGeneration += 1; homeTodoReceipt = "Other account";`, ctx);
      }

      env.releaseGetSession();
      await actionPromise;
      // Flush microtasks for fire-and-forget answerOffer promise chain
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));

      if (transition === "unchanged-control") {
        assert.equal(env.posted.length, 1, `unchanged control must send exactly 1 command (${action})`);
        assert.equal(env.posted[0]!.bearer, `Bearer ${login1Token}`);
      } else {
        assert.equal(env.posted.length, 0, `${transition} + ${action} must dispatch ZERO commands under new login`);
        assert.equal(postTransitionRenders, 0, `${transition} + ${action} must cause ZERO post-transition UI renders`);
        assert.equal(postTransitionStatusCalls, 0, `${transition} + ${action} must emit ZERO post-transition status updates`);
        assert.equal(postTransitionRefreshes, 0, `${transition} + ${action} must trigger ZERO post-transition refreshes`);
        assert.equal(runInContext("waitingTodoErrors.size", ctx), 0, `${transition} + ${action} must record ZERO errors`);
        assert.equal(runInContext("waitingPanelTodos.get(activeWorkspaceId).length", ctx), 3, `${transition} + ${action} must remove ZERO cards`);
        if (action === "chat-offer") {
          assert.equal(chatControls.status.textContent, "Saving…", `${transition} + chat-offer must not mutate status after retirement`);
        }
        if (action === "detail-approve" || action === "detail-offer") {
          const expectedReceipt = transition === "sign-out" ? "Signed out" : transition === "re-sign-in" ? "Fresh login" : "Other account";
          assert.equal(runInContext("homeTodoReceipt", ctx), expectedReceipt, `${transition} + ${action} must not overwrite new-login receipt`);
        }
      }
    }
  }
});

// ---------- 7. Archived 'Approved' (positive tone) / 'Declined' (muted tone) + optional note XSS inertness ----------

test("Waiting Archived tab renders Approved (positive tone) and Declined (muted tone) with XSS-inert optional notes via textContent", () => {
  const doc = makeDoc();
  const host = doc.createElement("div");

  const approvedItem = mapWaitingArchivedEntry({
    item_key: `todo:${TODO_1}`,
    kind: "todo",
    id: TODO_1,
    todo_id: TODO_1,
    ask_kind: null,
    title: "Approve budget",
    from: { kind: "agent", id: AGENT, name: "Claude" },
    outcome_kind: "approved",
    outcome_text: `Approved · ${XSS_PAYLOAD}`,
    archived_at: "2026-11-25T14:55:00Z",
    answered_by: { kind: "user", id: OWNER, name: "Owner", by_viewer: true },
    placement: "general",
    channel_id: null,
    conversation_id: null,
    conversation_kind: "general",
  }, { workspaceId: WS, workspaceName: "Home", channelLabel: "#general", href: `/app?w=${WS}&v=todo&t=${TODO_1}`, viewerId: OWNER, now: NOW });

  const declinedItem = mapWaitingArchivedEntry({
    item_key: `todo:${TODO_2}`,
    kind: "todo",
    id: TODO_2,
    todo_id: TODO_2,
    ask_kind: null,
    title: "Approve extra license",
    from: { kind: "agent", id: AGENT, name: "Claude" },
    outcome_kind: "declined",
    outcome_text: `Declined · ${XSS_PAYLOAD}`,
    archived_at: "2026-11-25T14:50:00Z",
    answered_by: { kind: "user", id: OWNER, name: "Owner", by_viewer: true },
    placement: "workspace",
    channel_id: null,
    conversation_id: null,
    conversation_kind: null,
  }, { workspaceId: WS, workspaceName: "Home", channelLabel: "", href: `/app?w=${WS}&v=todo&t=${TODO_2}`, viewerId: OWNER, now: NOW });

  renderWaitingPanel(host, {
    ...makeWaitingVM([]),
    tab: "archived",
    archived: {
      items: [approvedItem, declinedItem],
      counts: {
        channel: { min: 1, complete: true },
        workspace: { min: 2, complete: true },
        all: { min: 2, complete: true },
      },
      loading: false,
      loadingMore: false,
      complete: true,
      failed: false,
      hasMore: false,
    },
  }, {
    onScopeChange: () => {},
    onClose: () => {},
    onRetryLoad: () => {},
    onSubmitChoice: () => {},
    onRetryChoice: () => {},
    onDraftChoice: () => {},
  });

  const approvedCard = host.querySelector(`[data-waiting-archived-item="todo:${TODO_1}"]`) as unknown as FakeElement;
  const declinedCard = host.querySelector(`[data-waiting-archived-item="todo:${TODO_2}"]`) as unknown as FakeElement;
  assert.ok(approvedCard && declinedCard);

  const approvedOutcome = approvedCard.querySelector(`[data-waiting-archived-outcome="approved"]`) as unknown as FakeElement;
  const declinedOutcome = declinedCard.querySelector(`[data-waiting-archived-outcome="declined"]`) as unknown as FakeElement;
  assert.equal(approvedOutcome.dataset.outcomeTone, "positive");
  assert.equal(declinedOutcome.dataset.outcomeTone, "muted");
  assert.equal(approvedCard.querySelector(".cs-waiting-archived__answer")!.textContent, `Approved · ${XSS_PAYLOAD}`);
  assert.equal(declinedCard.querySelector(".cs-waiting-archived__answer")!.textContent, `Declined · ${XSS_PAYLOAD}`);
  assert.equal(approvedCard.querySelectorAll("img").length, 0);
  assert.equal(approvedCard.querySelectorAll("script").length, 0);
  assert.equal(declinedCard.querySelectorAll("img").length, 0);
  assert.equal(declinedCard.querySelectorAll("script").length, 0);
});

// ---------- 8. Mounted HezSec R1 witnesses (Fixes 1, 2, 3) ----------

function makePeopleForDetail() {
  return mapHomePeople({
    workspaceId: WS,
    viewerId: OWNER,
    members: [
      { userId: OWNER, name: "Alex Owner", role: "owner" },
      { userId: OTHER_USER, name: "Nikki Member", role: "member" },
    ],
    agents: [{ principalId: AGENT, name: "Claude", ownerUserId: OWNER }],
    access: [],
    signals: [],
    now: NOW,
    sample: false,
  });
}

async function mountLiveDetailHarness(options: {
  initialRead: { todo: Todo; comments: [] };
  initialRows?: TodoSummary[];
  onDecideTodo?: (ws: string, input: Record<string, unknown>, reqId: string) => Promise<unknown>;
  onAnswerRequest?: (ws: string, input: Record<string, unknown>, reqId: string) => Promise<unknown>;
}) {
  const code = await extractDashboardFunctions([
    "homeRefusalCopy",
    "homeWrite",
    "completeHomeTodo",
    "steerHomeTodo",
    "renderHomeObjectPane",
  ]);
  const doc = new FakeDocument();
  const slot = new FakeElement(doc, "div");
  slot.dataset.homeRoutePane = "";
  doc.body.append(slot);
  const people = makePeopleForDetail();

  const calls: Array<{ method: string; workspaceId: string; input: Record<string, unknown> }> = [];
  const serverStub = {
    decideTodo: async (ws: string, input: Record<string, unknown>, reqId: string) => {
      calls.push({ method: "decideTodo", workspaceId: ws, input: { ...input } });
      if (options.onDecideTodo) return await options.onDecideTodo(ws, input, reqId);
      return {
        status: "committed",
        value: { ...options.initialRead.todo, version: Number(input.base_version) + 1, state: "done", decision_status: "approved" },
        notices: [],
        replayed: false,
      };
    },
    answerRequest: async (ws: string, input: Record<string, unknown>, reqId: string) => {
      calls.push({ method: "answerRequest", workspaceId: ws, input: { ...input } });
      if (options.onAnswerRequest) return await options.onAnswerRequest(ws, input, reqId);
      return {
        status: "committed",
        value: { ...options.initialRead.todo, version: Number(input.base_version) + 1, offer: null },
        notices: [],
        replayed: false,
      };
    },
    assignTodo: async (ws: string, input: Record<string, unknown>) => {
      calls.push({ method: "assignTodo", workspaceId: ws, input: { ...input } });
      return { status: "committed", value: options.initialRead.todo, notices: [], replayed: false };
    },
    setTodoState: async (ws: string, input: Record<string, unknown>) => {
      calls.push({ method: "setTodoState", workspaceId: ws, input: { ...input } });
      return { status: "committed", value: options.initialRead.todo, notices: [], replayed: false };
    },
    steerQueue: async (ws: string, input: Record<string, unknown>) => {
      calls.push({ method: "steerQueue", workspaceId: ws, input: { ...input } });
      return { status: "committed", value: options.initialRead.todo, notices: [], replayed: false };
    },
    comment: async (ws: string, input: Record<string, unknown>) => {
      calls.push({ method: "comment", workspaceId: ws, input: { ...input } });
      return { status: "committed", value: {}, notices: [], replayed: false };
    },
  };

  const ctx = createContext({
    TODO_CONFLICT_MESSAGE,
    TODO_SAVE_FAILED: "Not saved.",
    TODO_RESULT_UNKNOWN: "Unknown.",
    HomeCommandRefused,
    HomeOperationRetired,
    HomeToolsUnavailable,
    CommandOutcomeUnknown: class extends Error {},
    crypto: { randomUUID: () => `cmd-${calls.length + 1}` },
    sampleMode: false,
    activeWorkspaceId: WS,
    workspaces: [{ id: WS, name: "Home" }],
    homeWorkspaceGeneration: 1,
    homeNavigation: 1,
    homeTodoSave: "idle",
    homeTodoReceipt: "",
    homeTodoNotice: null,
    homeTodoRead: options.initialRead,
    homeDetailKey: "k",
    homeTodosState: "ready",
    homeTodoRows: options.initialRows ?? [],
    homeQueue: null,
    homeQueueRead: "ready",
    homeRoute: { view: "todo", workspaceId: WS, todoId: options.initialRead.todo.todo_id },
    homePolicies: new Map(),
    homeGateEditorId: null,
    waitingAuthGeneration: 1,
    waitingActionGuard: () => () => true,
    homeViewerId: () => OWNER,
    homeServer: () => serverStub,
    homeTodoContext: () => ({ workspaceId: WS, people, viewerId: OWNER, editor: true, sample: false, now: NOW }),
    mapHomeTodo,
    todoView,
    routeHref,
    tagOptions,
    peopleDialogModel: () => ({ agents: [] }),
    parkPeopleHosts: () => {},
    homePaneMessage: () => {},
    homeBack: () => {},
    replaceHomeRegion: (host: FakeElement, _kind: string, nodes: FakeElement[]) => {
      host.replaceChildren(...nodes);
    },
    one: (sel: string) => (sel === "[data-home-route-pane]" ? slot : slot.querySelector(sel)),
    all: () => [],
    document: doc,
    renderHomeSide: () => {},
    renderHomeShell: () => {},
    renderFeed: () => {},
    invalidateWaitingArchived: () => {},
    loadHomeWorkspace: async () => {},
  });
  runInContext(code, ctx);
  runInContext("renderHomeObjectPane()", ctx);
  return { ctx, slot, calls };
}

test("Witness 1 (Fix 1): mounted detail withholds after-offer decisions when offer_prerequisite is absent even if todo_list is missing or stale, and enables with exact rendered offer_id/version once authoritative detail arrives", async () => {
  const baseAfterTodo: Todo = {
    workspace_id: WS,
    todo_id: TODO_2,
    version: 7,
    kind: "task",
    title: "Run production migration",
    notes: "Needs review first.",
    state: "open",
    due_on: "2026-12-01",
    created_by: { user_id: OTHER_USER, principal_id: null },
    created_at: "2026-11-25T13:00:00Z",
    assignee: null,
    assigned_by: null,
    assigned_at: null,
    offer: {
      offer_id: OFFER_2,
      to: { kind: "agent", id: AGENT },
      decider_user_id: OWNER,
      start: "queue",
      gate: { kind: "after", todo_id: TODO_3 },
      by: { user_id: OTHER_USER, principal_id: null },
      at: "2026-11-25T14:00:00Z",
    },
    offer_prerequisite: null,
    gate: { kind: "none" },
    gate_clear: true,
    queue_position: null,
    state_by: { user_id: OTHER_USER, principal_id: null },
    state_at: "2026-11-25T14:00:00Z",
    comment_count: 0,
  };

  // Case 1a: Prerequisite absent from todo_list AND offer_prerequisite: null on todo_read
  {
    const { slot, calls } = await mountLiveDetailHarness({
      initialRead: { todo: baseAfterTodo, comments: [] },
      initialRows: [],
    });
    const gateEl = slot.querySelector(`[data-offer-gate-term="after"]`) as unknown as FakeElement;
    assert.ok(gateEl);
    assert.equal(gateEl.textContent, "Prerequisite details unavailable. Reload to review before deciding.");
    assert.equal(slot.textContent.includes("another to-do"), false, "must never render placeholder with offer panel");
    const acceptBtn = slot.querySelector(`[data-todo-offer-answer="accept"]`) as unknown as FakeElement;
    const declineBtn = slot.querySelector(`[data-todo-offer-answer="decline"]`) as unknown as FakeElement;
    assert.ok(acceptBtn && declineBtn);
    assert.equal(acceptBtn.disabled, true);
    assert.equal(declineBtn.disabled, true);
    acceptBtn.click();
    declineBtn.click();
    // Even if click listener were invoked directly, guard blocks submission.
    for (const fn of acceptBtn.listeners.get("click") ?? []) fn({});
    for (const fn of declineBtn.listeners.get("click") ?? []) fn({});
    await new Promise(r => setImmediate(r));
    assert.equal(calls.length, 0, "0 household_todo_answer commands emitted when prerequisite unavailable");
  }

  // Case 1b: todo_list has a STALE prerequisite title, while todo_read has offer_prerequisite: null
  const staleListRow = makeOfferSummary({ todo_id: TODO_3, title: "Stale list title", offer: null });
  {
    const { slot, calls } = await mountLiveDetailHarness({
      initialRead: { todo: baseAfterTodo, comments: [] },
      initialRows: [staleListRow],
    });
    const gateEl = slot.querySelector(`[data-offer-gate-term="after"]`) as unknown as FakeElement;
    assert.ok(gateEl);
    assert.equal(gateEl.textContent, "Prerequisite details unavailable. Reload to review before deciding.");
    assert.equal(slot.textContent.includes("Stale list title"), false, "must never fall back to stale list title");
    const acceptBtn = slot.querySelector(`[data-todo-offer-answer="accept"]`) as unknown as FakeElement;
    const declineBtn = slot.querySelector(`[data-todo-offer-answer="decline"]`) as unknown as FakeElement;
    assert.equal(acceptBtn.disabled, true);
    assert.equal(declineBtn.disabled, true);
    acceptBtn.click();
    declineBtn.click();
    await new Promise(r => setImmediate(r));
    assert.equal(calls.length, 0, "0 household_todo_answer commands emitted when only stale list has title");
  }

  // Case 1c: authoritative todo_read provides offer_prerequisite while todo_list is missing OR stale
  for (const listRows of [[], [staleListRow]]) {
    const authTodo: Todo = {
      ...baseAfterTodo,
      offer_prerequisite: {
        todo_id: TODO_3,
        title: "Authoritative prerequisite title",
        state: "open",
      },
    };
    const { slot, calls } = await mountLiveDetailHarness({
      initialRead: { todo: authTodo, comments: [] },
      initialRows: listRows,
    });
    const gateEl = slot.querySelector(`[data-offer-gate-term="after"]`) as unknown as FakeElement;
    assert.ok(gateEl);
    assert.equal(gateEl.textContent, "After ‘Authoritative prerequisite title’");
    assert.equal(slot.textContent.includes("Stale list title"), false, "authoritative detail overrides stale list");
    const acceptBtn = slot.querySelector(`[data-todo-offer-answer="accept"]`) as unknown as FakeElement;
    const declineBtn = slot.querySelector(`[data-todo-offer-answer="decline"]`) as unknown as FakeElement;
    assert.equal(acceptBtn.disabled, false);
    assert.equal(declineBtn.disabled, false);
    acceptBtn.click();
    await new Promise(r => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "answerRequest");
    assert.equal(calls[0]!.workspaceId, WS);
    assert.deepEqual(calls[0]!.input, {
      todo_id: TODO_2,
      offer_id: OFFER_2,
      base_version: 7,
      answer: "accept",
    });
  }
});

test("Witness 2 (Fix 2): mounted detail handlers pin rendered todo_id, base_version, and offer_id across superseded projections for both answerOffer and decide, plus unchanged controls", async () => {
  // --- A) answerOffer: superseded projection vs unchanged control ---
  {
    const offerV3: Todo = {
      workspace_id: WS,
      todo_id: TODO_2,
      version: 3,
      kind: "task",
      title: "Run export v3",
      notes: "Original terms",
      state: "open",
      due_on: null,
      created_by: { user_id: OTHER_USER, principal_id: null },
      created_at: "2026-11-25T13:00:00Z",
      assignee: null,
      assigned_by: null,
      assigned_at: null,
      offer: {
        offer_id: OFFER_1,
        to: { kind: "agent", id: AGENT },
        decider_user_id: OWNER,
        start: "queue",
        gate: { kind: "none" },
        by: { user_id: OTHER_USER, principal_id: null },
        at: "2026-11-25T14:00:00Z",
      },
      offer_prerequisite: null,
      gate: { kind: "none" },
      gate_clear: true,
      queue_position: null,
      state_by: { user_id: OTHER_USER, principal_id: null },
      state_at: "2026-11-25T14:00:00Z",
      comment_count: 0,
    };
    const offerV4: Todo = {
      ...offerV3,
      version: 4,
      title: "Run export v4 (superseded)",
      offer: {
        ...offerV3.offer!,
        offer_id: OFFER_2,
        start: "now",
      },
    };
    const { ctx, slot, calls } = await mountLiveDetailHarness({
      initialRead: { todo: offerV3, comments: [] },
      onAnswerRequest: async (_ws, input) => {
        if (input.base_version !== 4 || input.offer_id !== OFFER_2) {
          return { status: "conflict", current: offerV4 };
        }
        return {
          status: "committed",
          value: { ...offerV4, version: 5, offer: null },
          notices: [],
          replayed: false,
        };
      },
    });
    const retainedV3Accept = slot.querySelector(`[data-todo-offer-answer="accept"]`) as unknown as FakeElement;
    assert.ok(retainedV3Accept);

    // Supersede mutable homeTodoRead to v4 / OFFER_2 WITHOUT clicking v4's button
    (ctx as Record<string, unknown>)._v4Read = { todo: offerV4, comments: [] };
    runInContext("homeTodoRead = _v4Read; renderHomeObjectPane();", ctx);

    // Click the retained v3 button -> MUST dispatch base_version: 3 and offer_id: OFFER_1 (never 4 / OFFER_2)
    retainedV3Accept.click();
    await new Promise(r => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "answerRequest");
    assert.deepEqual(calls[0]!.input, {
      todo_id: TODO_2,
      offer_id: OFFER_1,
      base_version: 3,
      answer: "accept",
    });
    assert.equal(runInContext("homeTodoReceipt", ctx), TODO_CONFLICT_MESSAGE);

    // Unchanged control: click the live v4 button -> dispatches base_version: 4 / OFFER_2 and commits
    const liveV4Accept = slot.querySelector(`[data-todo-offer-answer="accept"]`) as unknown as FakeElement;
    assert.ok(liveV4Accept);
    liveV4Accept.click();
    await new Promise(r => setImmediate(r));
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.method, "answerRequest");
    assert.deepEqual(calls[1]!.input, {
      todo_id: TODO_2,
      offer_id: OFFER_2,
      base_version: 4,
      answer: "accept",
    });
    assert.equal(runInContext("homeTodoReceipt", ctx), "Accepted.");
  }

  // --- B) decide: superseded projection vs unchanged control ---
  {
    const approvalV3: Todo = {
      workspace_id: WS,
      todo_id: TODO_1,
      version: 3,
      kind: "approval",
      title: "Approve budget v3",
      notes: "Spend $100",
      state: "open",
      due_on: null,
      created_by: { user_id: OWNER, principal_id: AGENT },
      created_at: "2026-11-25T13:00:00Z",
      assignee: { kind: "user", id: OWNER },
      assigned_by: { user_id: OWNER, principal_id: AGENT },
      assigned_at: "2026-11-25T13:00:00Z",
      offer: null,
      offer_prerequisite: null,
      gate: { kind: "none" },
      gate_clear: true,
      queue_position: null,
      state_by: { user_id: OWNER, principal_id: AGENT },
      state_at: "2026-11-25T13:00:00Z",
      comment_count: 0,
      decision_status: null,
      decision: null,
    };
    const approvalV4: Todo = {
      ...approvalV3,
      version: 4,
      title: "Approve budget v4",
      notes: "Spend $900",
    };
    const { ctx, slot, calls } = await mountLiveDetailHarness({
      initialRead: { todo: approvalV3, comments: [] },
      onDecideTodo: async (_ws, input) => {
        if (input.base_version !== 4) {
          return { status: "conflict", current: approvalV4 };
        }
        return {
          status: "committed",
          value: { ...approvalV4, version: 5, state: "done", decision_status: "approved" },
          notices: [],
          replayed: false,
        };
      },
    });
    const retainedV3Approve = slot.querySelector("[data-todo-approve]") as unknown as FakeElement;
    assert.ok(retainedV3Approve);

    // Supersede mutable homeTodoRead to v4
    (ctx as Record<string, unknown>)._v4ApprovalRead = { todo: approvalV4, comments: [] };
    runInContext("homeTodoRead = _v4ApprovalRead; renderHomeObjectPane();", ctx);

    // Click retained v3 Approve button -> MUST dispatch base_version: 3 (never 4)
    retainedV3Approve.click();
    await new Promise(r => setImmediate(r));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "decideTodo");
    assert.deepEqual(calls[0]!.input, {
      todo_id: TODO_1,
      base_version: 3,
      decision: "approve",
    });
    assert.equal(runInContext("homeTodoReceipt", ctx), TODO_CONFLICT_MESSAGE);

    // Unchanged control: click live v4 Approve button -> dispatches base_version: 4 and commits
    const liveV4Approve = slot.querySelector("[data-todo-approve]") as unknown as FakeElement;
    assert.ok(liveV4Approve);
    liveV4Approve.click();
    await new Promise(r => setImmediate(r));
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.method, "decideTodo");
    assert.deepEqual(calls[1]!.input, {
      todo_id: TODO_1,
      base_version: 4,
      decision: "approve",
    });
    assert.equal(runInContext("homeTodoReceipt", ctx), "Approved.");
  }
});

test("Witness 3 (Fix 3): two accepted scheduled times in the same displayed minute render distinct exact instants (seconds, milliseconds, explicit offset) on mounted Detail, Chat OfferCard, and Waiting views before Accept", () => {
  const t1 = "2026-11-30T15:00:05.120Z";
  const t2 = "2026-11-30T15:00:45.789Z";
  const people = makePeopleForDetail();
  const ctx = { workspaceId: WS, people, viewerId: OWNER, editor: true, sample: false, now: NOW };
  const doc = makeDoc();

  // 1) Mounted Detail view
  const renderDetailAt = (atIso: string) => {
    const row: Todo = {
      workspace_id: WS,
      todo_id: TODO_2,
      version: 5,
      kind: "task",
      title: "Scheduled offer",
      notes: "",
      state: "open",
      due_on: null,
      created_by: { user_id: OTHER_USER, principal_id: null },
      created_at: "2026-11-25T13:00:00Z",
      assignee: null,
      assigned_by: null,
      assigned_at: null,
      offer: {
        offer_id: OFFER_1,
        to: { kind: "agent", id: AGENT },
        decider_user_id: OWNER,
        start: "queue",
        gate: { kind: "at", at: atIso },
        by: { user_id: OTHER_USER, principal_id: null },
        at: "2026-11-25T14:00:00Z",
      },
      offer_prerequisite: null,
      gate: { kind: "none" },
      gate_clear: true,
      queue_position: null,
      state_by: { user_id: OTHER_USER, principal_id: null },
      state_at: "2026-11-25T14:00:00Z",
      comment_count: 0,
    };
    const vm = mapHomeTodo(row, ctx, [], []);
    const answers: string[] = [];
    const el = todoView(doc, {
      workspace: { name: "Home", todosHref: `/app?w=${WS}&v=todos`, homeHref: `/app?w=${WS}` },
      view: { kind: "ready", todo: vm },
      now: NOW,
      timeZone: "UTC",
      people,
      openTodos: [],
      save: "idle",
    }, {
      complete: () => {},
      assign: () => {},
      setStart: () => {},
      comment: () => {},
      answerOffer: ans => answers.push(ans),
    }) as unknown as FakeElement;
    return { el, answers };
  };

  const detail1 = renderDetailAt(t1);
  const detail2 = renderDetailAt(t2);
  const term1 = (detail1.el.querySelector(`[data-offer-gate-term="at"]`) as unknown as FakeElement).textContent;
  const term2 = (detail2.el.querySelector(`[data-offer-gate-term="at"]`) as unknown as FakeElement).textContent;
  assert.notEqual(term1, term2, "detail view must distinguish two accepted times in the same minute");
  assert.equal(term1, "Scheduled Nov 30, 2026, 3:00:05.120 pm GMT");
  assert.equal(term2, "Scheduled Nov 30, 2026, 3:00:45.789 pm GMT");
  (detail1.el.querySelector(`[data-todo-offer-answer="accept"]`) as unknown as FakeElement).click();
  assert.deepEqual(detail1.answers, ["accept"]);

  // 2) Mounted Chat OfferCard
  const cardFor = (atIso: string) => {
    const cards = pendingOfferCards(
      [makeOfferSummary({
        offer: {
          offer_id: OFFER_1,
          to: { kind: "agent", id: AGENT },
          decider_user_id: OWNER,
          start: "queue",
          gate: { kind: "at", at: atIso },
          by: { user_id: OTHER_USER, principal_id: null },
          at: "2026-11-25T14:00:00Z",
        },
      })],
      OWNER,
      p => p.kind === "agent" ? "Claude" : "Nikki",
    );
    return buildOfferCard(doc, cards[0]!, { answer: () => {}, timeZone: "UTC" }) as unknown as FakeElement;
  };
  const chatTerm1 = (cardFor(t1).querySelector(`[data-offer-gate-term="at"]`) as unknown as FakeElement).textContent;
  const chatTerm2 = (cardFor(t2).querySelector(`[data-offer-gate-term="at"]`) as unknown as FakeElement).textContent;
  assert.notEqual(chatTerm1, chatTerm2);
  assert.equal(chatTerm1, "Scheduled Nov 30, 2026, 3:00:05.120 pm GMT");
  assert.equal(chatTerm2, "Scheduled Nov 30, 2026, 3:00:45.789 pm GMT");

  // 3) Mounted Waiting on you panel
  const waitingTermFor = (atIso: string) => {
    const host = doc.createElement("div");
    renderWaitingPanel(host, makeWaitingVM([{
      id: TODO_1,
      workspaceId: WS,
      workspaceName: "Home",
      title: "Scheduled offer",
      state: "open",
      dueOn: null,
      reason: "request",
      href: `/app?w=${WS}&v=todo&t=${TODO_1}`,
      canMarkDone: false,
      version: 5,
      kind: "task",
      notesTruncated: false,
      offerId: OFFER_1,
      offerTo: { kind: "agent", id: AGENT, name: "Claude" },
      offerStart: "queue",
      offerGate: { kind: "at", at: atIso },
      placement: "workspace",
    }]), {
      onScopeChange: () => {},
      onClose: () => {},
      onRetryLoad: () => {},
      onSubmitChoice: () => {},
      onRetryChoice: () => {},
      onDraftChoice: () => {},
      onAnswerTodoOffer: () => {},
      onOpenTodo: () => {},
      onDismissTodo: () => {},
    });
    return (host.querySelector(`[data-offer-gate-term="at"]`) as unknown as FakeElement).textContent;
  };
  const waitTerm1 = waitingTermFor(t1);
  const waitTerm2 = waitingTermFor(t2);
  assert.notEqual(waitTerm1, waitTerm2, "waiting view must distinguish two accepted times in the same minute");
  assert.ok(waitTerm1.includes(":05.120") && waitTerm1.includes("GMT"), `expected exact ms + offset, got ${waitTerm1}`);
  assert.ok(waitTerm2.includes(":45.789") && waitTerm2.includes("GMT"), `expected exact ms + offset, got ${waitTerm2}`);
});
