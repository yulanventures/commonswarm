import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

import { PROVIDER_LABELS, renderConsentDestination, renderConsentPage } from "../src/interaction-page.js";
import { createInteractionHandler } from "../src/interactions.js";
import { createAdminInteractionHandler } from "../src/admin-interactions.js";
import { createHandler } from "../src/server.js";

// Parse this repository's line-oriented Caddy blocks. Only standalone block
// delimiters count; braces inside environment placeholders or JSON stay tokens.
function caddyTree(source) {
  const root = { tokens: [], children: [] };
  const stack = [root];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "}") {
      assert.ok(stack.length > 1, "unmatched Caddy closing brace");
      stack.pop();
      continue;
    }
    const block = line.endsWith(" {");
    const node = { tokens: (block ? line.slice(0, -2) : line).split(/\s+/u), children: [] };
    stack.at(-1).children.push(node);
    if (block) stack.push(node);
  }
  assert.equal(stack.length, 1, "unclosed Caddy block");
  return root;
}

test("production Caddy routes the rendered submit guard GET to the OAuth service", () => {
  const source = readFileSync(new URL("../../../deploy/supabase-stack/commonswarm-mcp.caddy", import.meta.url), "utf8");
  const config = caddyTree(source);
  const site = config.children.find((node) => node.tokens[0] === "mcp.commonswarm.com");
  assert.ok(site, "production MCP site exists");
  const snippets = new Map(config.children.filter((node) => /^\(.+\)$/u.test(node.tokens[0]))
    .map((node) => [node.tokens[0].slice(1, -1), node.children]));
  const expand = (nodes) => nodes.flatMap((node) => {
    if (node.tokens[0] !== "import") return [node];
    assert.ok(snippets.has(node.tokens[1]), "active import resolves to a parsed snippet");
    return expand(snippets.get(node.tokens[1]));
  });
  const route = site.children.find((node) => node.tokens[0] === "route");
  assert.ok(route, "production site has an active route block");
  const active = expand(route.children);
  const matchers = new Map(active.filter((node) => node.tokens[0].startsWith("@"))
    .map((node) => [node.tokens[0], node.children]));
  const matchesPath = (pattern, path) => new RegExp(`^${pattern.split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u").test(path);
  const oauthGet = (path) => active.some((node) => {
    if (node.tokens[0] !== "handle") return false;
    const matcher = matchers.get(node.tokens[1]);
    if (!matcher) return false;
    const methods = matcher.find((entry) => entry.tokens[0] === "method")?.tokens.slice(1) ?? [];
    const paths = matcher.find((entry) => entry.tokens[0] === "path")?.tokens.slice(1) ?? [];
    return methods.includes("GET") && paths.some((pattern) => matchesPath(pattern, path)) &&
      node.children.some((entry) => entry.tokens[0] === "reverse_proxy" &&
        entry.tokens[1] === "127.0.0.1:{$MCP_OAUTH_HOST_PORT}");
  });
  assert.ok(oauthGet("/authorize"), "positive control: a known OAuth GET is routed");
  assert.equal(oauthGet("/assets/consent-submit.js"), false, "the former asset path falls through");
  const script = one(htmlTree(page()), (node) => node.tag === "script");
  assert.ok(oauthGet(script.attrs.src), `submit guard GET ${script.attrs.src} must reach OAuth`);
});

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
  const response = {};
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

test("an HTTPS metadata client ID gets a neutral label, never a verified, trusted or safe claim", () => {
  const body = (html) => html.replace(/<style>[\s\S]*?<\/style>/u, "");
  const metadataClient = page();
  assert.match(metadataClient, /<span class="badge badge-neutral">HTTPS client ID<\/span>/u);
  assert.doesNotMatch(body(metadataClient), /verified|trusted|\btrust\b|\bsafe\b|<svg[^>]*>[^]*?<\/svg><\/span>HTTPS/iu);
  // Positive control: the same body filter still sees the unverified warning path.
  const unverified = page({ clientDisplay: { verified: false, primary: "agent.example", declaredName: null } });
  assert.match(body(unverified), /Unverified app/u);
  assert.match(body(unverified), /<p class="warning unverified-warning">/u);
  assert.doesNotMatch(unverified, /HTTPS client ID/u);
});

test("picker help states the server's home-workspace rule and the progress error keeps the danger colour", () => {
  assert.match(page(), /If you select more than one workspace, choose one of them as Home workspace\./u);
  const style = /<style>([\s\S]*?)<\/style>/u.exec(page())[1];
  assert.match(style, /\.progress \.error\{[^}]*color:var\(--danger\)/u);
});

test("the shared destination helper keeps one fact per line without this page's stylesheet", () => {
  // admin-interaction-page.js renders this helper with its own minimal stylesheet.
  const html = renderConsentDestination({ clientName: "Client <x>", redirectUri: "https://claude.ai/cb", metadataHost: "claude.ai" });
  const lines = html.replace(/<p[^>]*>|<\/p>/gu, "").split("<br>").map((line) => line.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim());
  assert.deepEqual(lines, [
    "Client name (supplied by the client): Client &lt;x&gt;",
    "After you approve, you return to claude.ai.",
    "Client ID URL host: claude.ai.",
  ]);
  assert.doesNotMatch(html, /<svg|style=/u);
  const noHost = renderConsentDestination({ clientName: null, redirectUri: "http://127.0.0.1:9/cb" });
  assert.equal(noHost.split("<br>").length, 2);
  assert.match(noHost, /After you approve, you return to <strong>a program on this computer \(localhost\)<\/strong>\./u);
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

test("workspace picker marks long lists with the is-long class, reports the count, and locked rows keep hidden copies", () => {
  const many = Array.from({ length: 40 }, (_, index) => ({
    id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, name: `Workspace ${index + 1}` }));
  const long = page({ workspaces: many });
  assert.match(long, /<ul class="workspace-list is-long">/u);
  assert.match(long, /40 workspaces · scroll for more/u);
  const short = page();
  assert.match(short, /<ul class="workspace-list">/u);
  assert.match(short, /3 workspaces</u);
  assert.match(page({ workspaces: [{ id: W1, name: "Only" }] }), /1 workspace</u);

  const locked = page({ switchAccount: SWITCH, selectionLocked: true, selectedWorkspaceIds: [W1, W2], homeWorkspaceId: W2, selectionVersion: 1 });
  const tree = htmlTree(locked);
  assert.equal(find(tree, (node) => node.tag === "form").length, 1);
  assert.doesNotMatch(locked, /Use a different account|\/switch-account/u);
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

test("the page submit guard disables both submit buttons, blocks repeat submits and restores a returned page", () => {
  const tree = htmlTree(page({ switchAccount: SWITCH }));
  const script = one(tree, (node) => node.tag === "script");
  const buttons = find(tree, (node) => node.tag === "button").map(() => ({ disabled: false }));
  assert.equal(buttons.length, 2);
  const listeners = new Map();
  const document = { addEventListener: (event, fn) => listeners.set(event, fn),
    querySelectorAll: () => buttons };
  const window = { addEventListener: (event, fn) => listeners.set(event, fn) };
  runInNewContext(readFileSync(new URL(`../src/${script.attrs.src.split("/").at(-1)}`, import.meta.url), "utf8"), { document, window });
  let prevented = 0;
  const submit = { defaultPrevented: false, preventDefault: () => { prevented += 1; } };
  listeners.get("submit")(submit);
  assert.ok(buttons.every((button) => button.disabled));
  assert.equal(prevented, 0, "first submit still uses the native form POST");
  listeners.get("submit")(submit);
  assert.equal(prevented, 1, "a second submit, including Enter, cannot send another POST");
  listeners.get("pageshow")({ persisted: true });
  assert.ok(buttons.every((button) => !button.disabled));
  listeners.get("submit")({ ...submit, defaultPrevented: true });
  assert.ok(buttons.every((button) => !button.disabled), "a cancelled submission does not lock the page");
  listeners.get("submit")(submit);
  assert.ok(buttons.every((button) => button.disabled));
  assert.equal(prevented, 1, "returning via back/forward permits one fresh submission");
});
