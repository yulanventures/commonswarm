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
