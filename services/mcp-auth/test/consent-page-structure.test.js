import { verifiedSignIn } from "./fixtures/verified-sign-in.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { test } from "node:test";

import { renderConsentPage } from "../src/interaction-page.js";
import { createInteractionHandler } from "../src/interactions.js";
import { createAdminInteractionHandler } from "../src/admin-interactions.js";
import { createHandler } from "../src/server.js";

// Parse this repository's line-oriented Caddy blocks. Only standalone block
// delimiters count; braces inside environment placeholders or JSON stay tokens.

test("the rendered submit guard is served before interaction lookup with JavaScript security headers", async () => {
  const script = one(htmlTree(page()), (node) => node.tag === "script");
  const unexpected = () => assert.fail("the static script must not touch provider, browser session or database state");
  const handler = createHandler({
    provider: { callback: () => unexpected },
    pool: { query: unexpected },
    publicAuthorizationEnabled: true,
    maxBodyBytes: 1024,
    logger: { info() {} },
    interactionHandler: unexpected,
  });
  for (const [method, status] of [["GET", 200], ["HEAD", 200], ["POST", 405]]) {
    const request = Readable.from([]);
    Object.assign(request, { method, url: script.attrs.src, headers: {} });
    const response = {
      headers: {}, statusCode: 0, body: "",
      setHeader(name, value) { this.headers[name] = value; },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
      end(body = "") { this.body += body; },
    };
    await handler(request, response);
    assert.equal(response.statusCode, status, method);
    assert.equal(response.headers["cache-control"], "no-store");
    if (status === 200) {
      assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.equal(response.body, method === "GET"
        ? readFileSync(new URL("../src/consent-submit.js", import.meta.url), "utf8") : "");
    } else {
      assert.equal(response.headers.allow, "GET, HEAD");
      assert.deepEqual(JSON.parse(response.body), { error: "method_not_allowed" });
    }
  }
});

test("neither interaction parser treats the submit guard filename as a UID, including encoded aliases", async () => {
  const script = one(htmlTree(page()), (node) => node.tag === "script");
  const sentinel = new Error("interaction lookup reached");
  const options = {
    provider: { interactionDetails: async () => { throw sentinel; } },
    store: { requireSession: async () => ({}) },
  };
  const request = { method: "GET", headers: { cookie: "__Host-cswarm-oauth=browser-session-long-enough" } };
  const response = { setHeader() {} };
  for (const make of [createInteractionHandler, createAdminInteractionHandler]) {
    const handler = make(options);
    // Positive control: an ordinary UID really reaches provider lookup.
    await assert.rejects(handler(request, response, new URL(`https://mcp.commonswarm.com/interaction/${UID}`)),
      (error) => error === sentinel);
    for (const path of [script.attrs.src, script.attrs.src.replace(".", "%2E"),
      script.attrs.src.replace("consent", "%63onsent")]) {
      for (const operation of ["", "/selection", "/consent", "/sign-in", "/switch-account"]) {
        assert.equal(await handler(request, response, new URL(`https://mcp.commonswarm.com${path}${operation}`)), false,
          `${make.name}: ${path}${operation} must not become a UID`);
      }
    }
  }
});

const USER = "10000000-0000-4000-8000-000000000001";
const evidence = verifiedSignIn({ userId: USER });
const W1 = "20000000-0000-4000-8000-000000000001";
const W2 = "20000000-0000-4000-8000-000000000002";
const W3 = "20000000-0000-4000-8000-000000000003";
const CSRF = "csrf-token-value-long-enough";
const UID = "interaction-structure";
const SWITCH = { action: `/interaction/${UID}/switch-account` };

const identity = { userId: USER, email: "human@example.test", displayName: "Human", identityVerified: true };

function page(overrides = {}) {
  return renderConsentPage({
    interactionUid: UID,
    clientDisplay: { verified: true, primary: "claude.ai", metadataHost: "claude.ai", declaredName: "Claude" },
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    identity,
    workspaces: [{ id: W1, name: "Workspace One" }, { id: W2, name: "Workspace Two" }, { id: W3, name: "Workspace Three" }],
    selectedWorkspaceIds: [W1],
    selectionVersion: 0,
    csrfToken: CSRF,
    ...overrides,
  });
}

// Parse the hosted HTML with the standard-library HTML parser (same approach as
// admin-consent-accessibility.test.js): no browser and no synthetic DOM.
function htmlTree(html) {
  const parsed = spawnSync("python3", ["-c", `
import json,sys
from html.parser import HTMLParser
class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root={'tag':'document','attrs':{},'children':[]}; self.stack=[self.root]
    def handle_starttag(self,tag,attrs):
        node={'tag':tag,'attrs':dict(attrs),'children':[]}
        self.stack[-1]['children'].append(node)
        if tag not in ('input','meta','br','hr','img','link','path','rect','circle'): self.stack.append(node)
    def handle_startendtag(self,tag,attrs):
        self.stack[-1]['children'].append({'tag':tag,'attrs':dict(attrs),'children':[]})
    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,0,-1):
            if self.stack[i]['tag']==tag:
                del self.stack[i:]; break
    def handle_data(self,data): self.stack[-1]['children'].append(data)
p=Tree(); p.feed(sys.stdin.read()); print(json.dumps(p.root))
`], { input: html, encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  return JSON.parse(parsed.stdout);
}
const elements = (node) => [node, ...node.children.flatMap((child) => typeof child === "string" ? [] : elements(child))];
const text = (node) => node.children.map((child) => typeof child === "string" ? child : text(child)).join("").replace(/\s+/g, " ").trim();
const find = (node, predicate) => elements(node).filter(predicate);
function one(node, predicate) {
  const matches = find(node, predicate);
  assert.equal(matches.length, 1, "expected exactly one rendered element");
  return matches[0];
}
// The label element that wraps an input (implicit labelling, as rendered).

test("switch account is its own POST form outside the consent form with the same CSRF token", () => {
  const html = page({ switchAccount: SWITCH });
  const tree = htmlTree(html);
  const forms = find(tree, (node) => node.tag === "form");
  assert.equal(forms.length, 2);
  const consent = one(tree, (node) => node.tag === "form" && node.attrs.action === `/interaction/${UID}/consent`);
  const switcher = one(tree, (node) => node.tag === "form" && node.attrs.action === `/interaction/${UID}/switch-account`);
  assert.equal(consent.attrs.method, "post");
  assert.equal(switcher.attrs.method, "post");
  // No nesting either way, in the parsed tree and in the raw markup.
  assert.ok(!elements(consent).includes(switcher));
  assert.ok(!elements(switcher).includes(consent));
  assert.ok(html.indexOf("</form>") < html.indexOf(`action="/interaction/${UID}/consent"`));

  const switchButton = one(switcher, (node) => node.tag === "button");
  assert.equal(switchButton.attrs.type, "submit");
  assert.equal(text(switchButton), "Use another account");
  assert.deepEqual(find(switcher, (node) => node.tag === "input").map((input) => input.attrs),
    [{ type: "hidden", name: "csrf_token", value: CSRF }]);

  // The consent form is the only form with Allow connection, and holds every consent field.
  assert.equal(find(tree, (node) => node.tag === "button" && text(node) === "Allow connection").length, 1);
  assert.equal(find(consent, (node) => node.tag === "button" && text(node) === "Allow connection").length, 1);
  assert.equal(find(consent, (node) => node.tag === "button").length, 1, "Enter in the consent form submits Allow");
  assert.equal(find(consent, (node) => node.tag === "input" && node.attrs.name === "csrf_token")[0].attrs.value, CSRF);
  assert.equal(find(consent, (node) => node.tag === "input" && node.attrs.name === "selection_version")[0].attrs.value, "0");
  assert.equal(find(consent, (node) => node.tag === "input" && node.attrs.name === "workspace_ids").length, 3);
  assert.equal(find(consent, (node) => node.tag === "input" && node.attrs.name === "home_workspace_id").length, 3);
});

test("provider-supplied and user-supplied values are escaped everywhere they appear", () => {
  const evil = `<script>alert("x")</script>&'`;
  const html = page({
    clientDisplay: { verified: false, primary: `host${evil}`, declaredName: `App ${evil}` },
    redirectUri: "https://callback.example/return",
    identity: { ...identity, provider: "github", displayName: `<img src=x onerror=alert(1)>`, email: `mail${evil}@example.test` },
    workspaces: [{ id: `id-${evil}`, name: `Name ${evil}` }],
    selectedWorkspaceIds: [`id-${evil}`],
    homeWorkspaceId: `id-${evil}`,
    csrfToken: `csrf"${evil}`,
    switchAccount: { action: `/interaction/x"><script>bad()</script>/switch-account` },
    validationError: `Bad ${evil}`,
  });
  assert.doesNotMatch(html, /<script(?! src="\/interaction\/consent-submit\.js" defer><\/script>)|<img|onerror=alert\(1\)>|x"><|alert\("x"\)|&'/u);
  const escaped = "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;";
  for (const fragment of [`host${escaped}`, `App ${escaped}`, `mail${escaped}@example.test`, `Name ${escaped}`,
    `value="id-${escaped}"`, `value="csrf&quot;${escaped}"`, `Bad ${escaped}`, "&lt;img src=x onerror=alert(1)&gt;",
    'action="/interaction/x&quot;&gt;&lt;script&gt;bad()&lt;/script&gt;/switch-account"']) {
    assert.ok(html.includes(fragment), fragment);
  }
  // The avatar initials are escaped too.
  assert.match(html, /<span class="app-mark">H<\/span>/u);
  assert.match(html, /<span class="avatar" aria-hidden="true">&lt;/u);
});

test("the tab title is first-party text and never carries a client-supplied name", () => {
  // A client can name itself anything (even "CommonSwarm"); unlabelled in the tab and history it would read as a
  // first-party prompt. The body labels the client name as supplied by the client; the title stays neutral.
  for (const declaredName of ["Claude", "CommonSwarm", "Evil <b>App</b>"]) {
    const html = page({ clientDisplay: { verified: false, primary: "evil.example", declaredName } });
    const titles = [...html.matchAll(/<title>([^<]*)<\/title>/gu)].map((match) => match[1]);
    assert.deepEqual(titles, ["Connect an app to CommonSwarm"]);
  }
  // Positive control: the same scan sees a client name if one were put in the title.
  assert.deepEqual([..."<title>Connect Claude to CommonSwarm</title>".matchAll(/<title>([^<]*)<\/title>/gu)].map((m) => m[1]),
    ["Connect Claude to CommonSwarm"]);
});

test("the page loads only the local submit guard and makes no external requests", () => {
  const html = page({ switchAccount: SWITCH, identity: { ...identity, provider: "google" } });
  const tree = htmlTree(html);
  const script = one(tree, (node) => node.tag === "script");
  assert.deepEqual(script.attrs, { src: "/interaction/consent-submit.js", defer: null });
  assert.equal(text(script), "");
  const withoutGuard = html.replace('<script src="/interaction/consent-submit.js" defer></script>', "");
  assert.doesNotMatch(withoutGuard, /<script|<link|<img|<iframe|\bsrc=|url\(|@import|@font-face|javascript:/iu);
  assert.deepEqual(html.match(/https?:\/\/[^\s"'<)]+/giu), ["https://commonswarm.com/app"]);
});

test("the served consent page never renders the OAuth state", async () => {
  const handler = createInteractionHandler({
    provider: {
      interactionDetails: async () => ({
        uid: "interaction-state",
        params: {
          client_id: "https://client.example/oauth.json",
          redirect_uri: "https://client.example/callback",
          resource: "https://mcp.commonswarm.com/mcp",
          scope: "openid mcp",
          code_challenge: "a".repeat(43),
          state: "oauth-state-must-not-render",
        },
        prompt: { name: "consent", details: {} },
      }),
    },
    store: {
      pool: evidence.pool,
      requireSession: async () => ({ ...evidence.browserSession }),
      bindInteraction: async () => ({ selected_workspace_ids: [] }),
      issueConsentToken: async () => ({ token: "csrf-token-long-enough", selectionVersion: 0 }),
    },
    gotrue: {},
    consentOrchestrator: { status: async () => [] },
    workspaceReader: async () => [{ id: W1, name: "Workspace One" }],
    allowedOrigins: new Set(["https://mcp.commonswarm.com"]),
    callbackUrl: "https://mcp.commonswarm.com/oauth/callback/gotrue",
  });
  const response = {
    headers: {}, status: 0, body: "",
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
    end(body = "") { this.body += body; },
  };
  await handler({ method: "GET", headers: { cookie: "__Host-cswarm-oauth=browser-session-long-enough" } }, response,
    new URL("https://mcp.commonswarm.com/interaction/interaction-state"));
  assert.equal(response.status, 200);
  assert.match(response.body, /Allow connection/u, "positive control: the consent page rendered");
  assert.doesNotMatch(response.body, /oauth-state-must-not-render/u);
  assert.match(response.headers["content-security-policy"], /^default-src 'none'; style-src 'unsafe-inline';/u);
});

// The workspace picker: Home is asked only when it is a real choice, and what is sent matches what is shown.
function pickerDocument(rows, { picker = true } = {}) {
  const listeners = [];
  const nodes = rows.map((row) => ({
    pick: { type: "checkbox", name: "workspace_ids", checked: !!row.ticked, disabled: !!row.locked },
    home: { type: "radio", name: "home_workspace_id", checked: !!row.home, disabled: !!row.locked },
  }));
  const needed = { textContent: "", dataset: { text: "Choose which one is Home." } };
  const document = {
    documentElement: { dataset: {} },
    addEventListener: (name, listener) => { listeners.push([name, listener]); },
    querySelector: (selector) => !picker ? null : selector === ".workspace-list" ? {} : selector === ".home-needed" ? needed : null,
    querySelectorAll: (selector) => selector === ".workspace-choice"
      ? nodes.map((node) => ({ querySelector: (inner) => inner.includes("workspace_ids") ? node.pick : node.home }))
      : [],
  };
  const window = { addEventListener: (name, listener) => { listeners.push([`window:${name}`, listener]); } };
  const fire = (name, event) => { for (const [type, listener] of listeners) if (type === name) listener(event); };
  new Function("document", "window", readFileSync(new URL("../src/consent-submit.js", import.meta.url), "utf8"))(document, window);
  return {
    document, nodes, needed,
    homes: () => nodes.map((node) => node.home.checked),
    tick(index, ticked) { nodes[index].pick.checked = ticked; fire("change", { target: nodes[index].pick }); },
    // A real radio group clears its other members; the stand-in does it by hand.
    choose(index) { nodes.forEach((node, at) => { node.home.checked = at === index; }); fire("change", { target: nodes[index].home }); },
    restore(state) { state.forEach(([ticked, home], at) => { nodes[at].pick.checked = ticked; nodes[at].home.checked = home; }); fire("window:pageshow", { persisted: false }); },
  };
}

test("the picker script sends one workspace as Home, and leaves the choice to the person with two or more", () => {
  const picker = pickerDocument([{}, {}, {}]);
  assert.equal(picker.document.documentElement.dataset.homeAuto, "one");
  assert.deepEqual(picker.homes(), [false, false, false]);
  // One ticked: that one is Home and the form says so (the hidden choice is filled in, never left stale).
  picker.tick(1, true);
  assert.deepEqual(picker.homes(), [false, true, false]);
  assert.equal(picker.needed.textContent, "");
  // A second tick makes it a real choice: the filled-in Home is cleared and the page asks.
  picker.tick(0, true);
  assert.equal(picker.document.documentElement.dataset.homeAuto, "choose");
  assert.deepEqual(picker.homes(), [false, false, false]);
  assert.equal(picker.needed.textContent, "Choose which one is Home.");
  // The person's own choice is kept, and the ask goes away.
  picker.choose(0);
  assert.deepEqual(picker.homes(), [true, false, false]);
  assert.equal(picker.needed.textContent, "");
  picker.tick(2, true);
  assert.deepEqual(picker.homes(), [true, false, false]);
  // Unticking the Home row clears its Home while two remain, and the page asks again.
  picker.tick(0, false);
  assert.deepEqual(picker.homes(), [false, false, false]);
  assert.equal(picker.needed.textContent, "Choose which one is Home.");
  // Back to one: that one is Home. Back to none: no Home.
  picker.tick(1, false);
  assert.equal(picker.document.documentElement.dataset.homeAuto, "one");
  assert.deepEqual(picker.homes(), [false, false, true]);
  picker.tick(2, false);
  assert.deepEqual(picker.homes(), [false, false, false]);
});

test("the picker script keeps a Home the person chose, and follows ticks the browser restores", () => {
  // Chosen with two ticked, then down to one and back to two: the choice was theirs, so it stays.
  const chosen = pickerDocument([{ ticked: true, home: true }, { ticked: true }]);
  assert.deepEqual(chosen.homes(), [true, false]);
  chosen.tick(1, false);
  chosen.tick(1, true);
  assert.deepEqual(chosen.homes(), [true, false]);
  // Dropping to the other workspace moves Home with it, since one workspace has one possible Home.
  chosen.tick(0, false);
  assert.deepEqual(chosen.homes(), [false, true]);
  // A reload can restore ticks after the script first ran: the page catches up when it is shown.
  const restored = pickerDocument([{}, {}]);
  restored.restore([[true, false], [true, false]]);
  assert.equal(restored.document.documentElement.dataset.homeAuto, "choose");
  assert.equal(restored.needed.textContent, "Choose which one is Home.");
  restored.restore([[true, false], [false, true]]);
  assert.deepEqual(restored.homes(), [true, false]);
  // A locked selection is carried by hidden fields; its disabled controls are left as rendered.
  assert.deepEqual(pickerDocument([{ ticked: true, home: true, locked: true }]).homes(), [true]);
  assert.deepEqual(pickerDocument([{ ticked: true, locked: true }]).homes(), [false]);
  // A page with no picker is not marked.
  assert.equal(pickerDocument([], { picker: false }).document.documentElement.dataset.homeAuto, undefined);
});

test("the picker says what the app can reach directly above Allow, and ties hiding Home to its script", () => {
  const html = page();
  const tree = htmlTree(html);
  const form = one(tree, (node) => node.tag === "form" && node.attrs.action?.endsWith("/consent"));
  const reach = one(form, (node) => node.tag === "p" && node.attrs.class === "reach");
  assert.equal(text(reach), "It can reach only the workspaces you tick, and create up to 10 hosted seats across them. You can revoke it, or a single seat, later in /app → Connected apps.");
  const actions = one(form, (node) => node.tag === "div" && node.attrs.class === "actions");
  const blocks = form.children.filter((child) => typeof child !== "string");
  assert.equal(blocks.indexOf(actions) - blocks.indexOf(reach), 1, "nothing sits between the reach line and the buttons");
  assert.equal(text(one(actions, (node) => node.tag === "button")), "Allow connection");
  assert.doesNotMatch(html, /What this connection can do|This app is asking to connect|Check each workspace this app may reach/u);
  // Every workspace row still carries both fields with the same names; the page itself preselects no Home.
  assert.equal(html.match(/type="checkbox" name="workspace_ids"/gu).length, 3);
  assert.equal(html.match(/type="radio" name="home_workspace_id"/gu).length, 3);
  assert.doesNotMatch(html, /name="home_workspace_id"[^>]* checked/u);
  // The ask for Home is a status message that starts empty; the script fills it in.
  const needed = one(form, (node) => node.attrs.class === "home-needed");
  assert.deepEqual([needed.attrs.role, needed.attrs["data-text"], text(needed)], ["status", "Choose which one is Home.", ""]);
  // Hiding Home is tied to the script that keeps it honest; without the script the choice stays in view.
  assert.match(html, /html\[data-home-auto\] \.workspace-choice \.home-choice\{display:none\}/u);
  assert.match(html, /html\[data-home-auto="choose"\] \.workspace-choice:has\(\.workspace-pick input:checked\) \.home-choice\{display:inline-flex\}/u);
  assert.doesNotMatch(html.replaceAll(/html\[data-home-auto[^{]*\{[^}]*\}/gu, ""), /\.home-choice\{display:none\}/u);
  // A stray brace silently drops the rule after it (it once took the selected count with it).
  let depth = 0;
  for (const character of /<style>([\s\S]*?)<\/style>/u.exec(html)[1]) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    assert.ok(depth >= 0, "a closing brace with nothing open");
  }
  assert.equal(depth, 0);
  // :has() cannot be nested; a nested one would silently drop the whole rule and hide Home for good.
  for (const [, selector] of html.matchAll(/(html\[data-home-auto[^{]*)\{/gu)) {
    assert.doesNotMatch(selector, /:has\([^()]*:has\(/u, selector);
  }
});
