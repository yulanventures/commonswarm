import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { PROVIDER_LABELS, renderConsentPage } from "../src/interaction-page.js";
import { createInteractionHandler } from "../src/interactions.js";

const USER = "10000000-0000-4000-8000-000000000001";
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
function wrappingLabel(tree, input) {
  return find(tree, (node) => node.tag === "label" && node.children.includes(input))[0]
    ?? find(tree, (node) => node.tag === "label" && elements(node).includes(input))[0];
}

test("accessible names used by the staging kit and operator instructions stay byte-exact", () => {
  const tree = htmlTree(page({ switchAccount: SWITCH, homeWorkspaceId: W1 }));
  const allow = one(tree, (node) => node.tag === "button" && text(node) === "Allow connection");
  assert.equal(allow.attrs.type, "submit");
  const legend = one(tree, (node) => node.tag === "legend");
  assert.equal(text(legend), "Select at least one workspace");
  const cancel = one(tree, (node) => node.tag === "a" && text(node) === "Cancel and return to /app");
  assert.equal(cancel.attrs.href, "https://commonswarm.com/app");

  const radios = find(tree, (node) => node.tag === "input" && node.attrs.type === "radio");
  assert.deepEqual(radios.map((radio) => radio.attrs.value), [W1, W2, W3]);
  for (const radio of radios) {
    assert.equal(radio.attrs.name, "home_workspace_id");
    assert.equal(text(wrappingLabel(tree, radio)), "Home workspace");
  }
  const boxes = find(tree, (node) => node.tag === "input" && node.attrs.type === "checkbox");
  assert.deepEqual(boxes.map((box) => [box.attrs.name, box.attrs.value, text(wrappingLabel(tree, box))]), [
    ["workspace_ids", W1, "Workspace One"],
    ["workspace_ids", W2, "Workspace Two"],
    ["workspace_ids", W3, "Workspace Three"],
  ]);
  assert.ok("checked" in boxes[0].attrs && !("checked" in boxes[1].attrs));
  assert.ok("checked" in radios[0].attrs && !("checked" in radios[1].attrs));
  // Every checkbox and radio sits inside the one fieldset named by the legend.
  const fieldset = one(tree, (node) => node.tag === "fieldset");
  for (const input of [...boxes, ...radios]) assert.ok(elements(fieldset).includes(input));
});

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
  assert.equal(text(switchButton), "Use a different account");
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

test("without switchAccount the page keeps one form and shows the account without a switch button", () => {
  const html = page();
  const tree = htmlTree(html);
  assert.equal(find(tree, (node) => node.tag === "form").length, 1);
  assert.doesNotMatch(html, /Use a different account|switch-account/u);
  assert.match(html, /Signed in as <strong>Human<\/strong>/u);
});

test("provider label map names Google, GitHub and email; anything else falls back to the plain account text", () => {
  assert.deepEqual([...PROVIDER_LABELS], [["google", "Google"], ["github", "GitHub"], ["email", "email"]]);
  for (const [provider, label] of [["google", "Google"], ["github", "GitHub"], ["email", "email"]]) {
    const html = page({ identity: { ...identity, provider } });
    assert.ok(html.includes(`Signed in with ${label} as <strong>Human</strong>`), provider);
  }
  for (const provider of [null, undefined, "", "okta", "GitHub", "constructor", "__proto__", "toString", 42, { toString: () => "github" }]) {
    const html = page({ identity: { ...identity, provider } });
    assert.match(html, /Signed in as <strong>Human<\/strong>/u, String(provider));
    assert.doesNotMatch(html, /Signed in with/u, String(provider));
    assert.doesNotMatch(html, /okta|constructor|__proto__|toString|class="provider-badge/u, String(provider));
  }
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
  assert.doesNotMatch(html, /<script|<img|onerror=alert\(1\)>|x"><|alert\("x"\)|&'/u);
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

test("client identity strings pinned by the authorize-state suite stay in the page", () => {
  const unverified = page({ clientDisplay: { verified: false, primary: "claude.ai", declaredName: "Registered <app>" } });
  assert.match(unverified, /Unverified app/u);
  assert.match(unverified, /Choose workspaces for claude\.ai/u);
  assert.match(unverified, /calls itself &ldquo;Registered &lt;app&gt;&rdquo;/u);
  assert.match(unverified, /Authorization will return to <strong>claude\.ai<\/strong>/u);
  assert.match(unverified, /<strong>Not verified:<\/strong> CommonSwarm has not checked who runs this app\./u);
  assert.equal(text(one(htmlTree(unverified), (node) => node.tag === "h1")), "Choose workspaces for claude.ai");

  const verified = page();
  assert.match(verified, /Choose workspaces for claude\.ai/u);
  assert.doesNotMatch(verified, /Unverified app|Not verified:/u);
  assert.match(verified, /Client: <strong>claude\.ai<\/strong>/u);
  for (const html of [verified, page({ switchAccount: SWITCH })]) {
    assert.equal(/name="csrf_token" value="([^"]+)"/u.exec(html)[1], CSRF);
    assert.equal(/name="selection_version" value="([^"]+)"/u.exec(html)[1], "0");
  }
});

test("the page makes no external requests and carries no script", () => {
  const html = page({ switchAccount: SWITCH, identity: { ...identity, provider: "google" } });
  assert.doesNotMatch(html, /<script|<link|<img|<iframe|\bsrc=|url\(|@import|@font-face|javascript:/iu);
  assert.deepEqual(html.match(/https?:\/\/[^\s"'<)]+/giu), ["https://commonswarm.com/app"]);
});

test("workspace picker bounds long lists and reports the count; locked rows keep hidden copies", () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, name: `Workspace ${index + 1}` }));
  const long = page({ workspaces: many });
  assert.match(long, /<ul class="workspace-list is-long">/u);
  assert.match(long, /40 workspaces · scroll for more/u);
  const short = page();
  assert.match(short, /<ul class="workspace-list">/u);
  assert.match(short, /3 workspaces</u);
  assert.match(page({ workspaces: [{ id: W1, name: "Only" }] }), /1 workspace</u);

  const locked = page({ selectionLocked: true, selectedWorkspaceIds: [W1, W2], homeWorkspaceId: W2, selectionVersion: 1 });
  const tree = htmlTree(locked);
  const hidden = find(tree, (node) => node.tag === "input" && node.attrs.type === "hidden").map((node) => [node.attrs.name, node.attrs.value]);
  assert.deepEqual(hidden, [["selection_version", "1"], ["csrf_token", CSRF], ["home_workspace_id", W2],
    ["workspace_ids", W1], ["workspace_ids", W2]]);
  for (const input of find(tree, (node) => node.tag === "input" && ["checkbox", "radio"].includes(node.attrs.type))) {
    assert.ok("disabled" in input.attrs);
  }
  assert.match(locked, /These choices are locked because this connection has already started\./u);
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
      requireSession: async () => ({ user_id: USER, user_email: identity.email,
        user_display_name: identity.displayName, authenticated_at: new Date().toISOString() }),
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
