// Node-only finish-page contracts: dummy display models in, rendered HTML and
// browser-script effects out. A minimal DOM/clock observes native keyboard clicks,
// fixed same-tab paths, no code/callback disclosure, and expiry unaffected by pause.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { FINISH_SECURITY_HEADERS, finishPaths, renderFinishPage, renderFinishExpiredPage } from "../src/finish-page.js";
import { renderConsentPage } from "../src/interaction-page.js";

const model = { interactionUid: "interaction-test", clientDisplay: { verified: true, primary: "client.example.test" },
  identity: { displayName: "Human", email: "user@example.test" }, workspaceNames: ["One", "Two"], homeWorkspaceName: "One", deadline: 120001 };
const decode = (value) => value.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

function browser(overrides = {}, clientNow = 1) {
  const realNow = Date.now;
  let html;
  try {
    Date.now = () => 1; // Server render clock is independent of the device clock.
    html = renderFinishPage({ ...model, ...overrides });
  } finally { Date.now = realNow; }
  let now = clientNow, sequence = 0;
  const timers = new Map(), elements = new Map(), listeners = new Map(), navigations = [];
  const document = { activeElement: null, getElementById: (id) => elements.get(id) };
  for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/gu)) {
    const attrs = Object.fromEntries([...match[2].matchAll(/([\w-]+)="([^"]*)"/gu)].map((m) => [m[1], decode(m[2])]));
    const handlers = new Map();
    const element = { attrs, dataset: {}, disabled: /\bdisabled\b/u.test(match[2]), hidden: /\bhidden\b/u.test(match[2]),
      textContent: decode(html.slice(match.index + match[0].length).split(`</${match[1]}>`)[0].replace(/<[^>]*>/gu, "")),
      addEventListener: (name, fn) => handlers.set(name, fn), getAttribute: (name) => attrs[name] ?? null,
      removeAttribute: (name) => { delete attrs[name]; }, setAttribute: (name, value) => { attrs[name] = value; },
      focus: () => { document.activeElement = element; }, handlers };
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith("data-")) {
      element.dataset[key.slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = value;
    }
    elements.set(match[3], element);
  }
  const window = { addEventListener: (name, fn) => listeners.set(name, fn),
    location: { search: "?code=dummy-code&callback=https://callback.example.test/ignored",
      replace: (path) => navigations.push(path), assign: (path) => navigations.push(path) } };
  const scriptPath = /<script src="([^"]+)"/u.exec(html)[1];
  runInNewContext(readFileSync(new URL(`../src/${scriptPath.split("/").at(-1)}`, import.meta.url), "utf8"), {
    document, window, Date: { now: () => now }, performance: { now: () => 0 }, clearTimeout: (id) => timers.delete(id),
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
  });
  return { elements, timers, document, navigations, event: (name) => listeners.get(name)(),
    time: (value) => { now = value; }, advance: (value) => {
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= value).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = value;
    }, click: (id, properties = {}, name = "click") => {
      const element = elements.get(id); element.focus();
      const event = { button: 0, defaultPrevented: false, ...properties, preventDefault() { this.defaultPrevented = true; } };
      if (!element.disabled) element.handlers.get(name)(event);
      if (name === "click" && !event.defaultPrevented && element.attrs.href) navigations.push(element.attrs.href); // Native Enter/click.
      return event;
    } };
}

test("finish model escapes names, retains client trust disclosure, and emits only fixed navigation paths", () => {
  const evil = '<img src=x> & "friend\'s"';
  const html = renderFinishPage({ ...model, clientDisplay: { verified: false, primary: evil, declaredName: evil },
    identity: { displayName: evil, email: evil }, workspaceNames: [evil], homeWorkspaceName: evil,
    code: "dummy-code", callbackUrl: "https://callback.example.test/private", finishPath: "//evil.example.test" });
  assert.ok(html.includes("&lt;img src=x&gt; &amp; &quot;friend&#39;s&quot;"));
  assert.match(html, /Unverified app/u);
  assert.match(html, /Not verified:/u);
  assert.doesNotMatch(html, /<img|dummy-code|callback\.example|evil\.example|http-equiv|target=|onclick=/iu);
  assert.match(html, /href="\/interaction\/interaction-test\/finish"/u);
  assert.match(html, /data-connected-path="\/interaction\/interaction-test\/connected"/u);
  assert.match(renderFinishPage({ ...model, workspaceNames: [], workspaceCount: 12 }), /12 workspaces as Human \(user@example.test\)/u);
  assert.match(renderFinishPage(model), /HTTPS client ID/u);
  assert.match(renderFinishPage(model), /Home workspace: <strong>One<\/strong>/u);
  assert.match(renderFinishPage(model), /<button id="finish-pause"[^>]* hidden/u);
  assert.deepEqual(finishPaths("interaction-test"), { connectedPath: "/interaction/interaction-test/connected", finishPath: "/interaction/interaction-test/finish" });
  for (const uid of ["../bad", "x?code=dummy", "x#bad", "https://bad", "", "finish-timer.js"]) assert.throws(() => finishPaths(uid), TypeError);
  assert.match(renderFinishExpiredPage({ clientDisplay: { primary: evil, verified: false } }), /Return link expired\. Return to &lt;img/u);
  assert.doesNotMatch(renderFinishExpiredPage(model), /<script|href=/u);
});

test("navigation-only headers forbid caching, referrers, framing and third-party scripts", () => {
  assert.equal(FINISH_SECURITY_HEADERS["cache-control"], "no-store");
  assert.equal(FINISH_SECURITY_HEADERS["referrer-policy"], "no-referrer");
  assert.equal(FINISH_SECURITY_HEADERS["content-security-policy"], "default-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
});

test("both pages show the account email once; consent escapes fallbacks and keeps switch separate from approval", () => {
  for (const [identity, expected] of [[model.identity, "Continue as <strong>Human</strong> (user@example.test)"],
    [{ email: "user@example.test", identityVerified: true }, "Continue as <strong>user@example.test</strong>"],
    [{ displayName: "user@example.test", email: "user@example.test" }, "Continue as <strong>user@example.test</strong>"],
    [{ displayName: "<Human>" }, "Continue as <strong>&lt;Human&gt;</strong> (Email unavailable)"],
    [{ userId: "dummy-user" }, "Continue as <strong>Email unavailable</strong>"]]) {
    const html = renderConsentPage({ interactionUid: model.interactionUid, clientDisplay: model.clientDisplay, identity,
      redirectUri: "https://callback.example.test/return", workspaces: [], csrfToken: "dummy-csrf", switchAccount: { action: "/interaction/interaction-test/switch-account" } });
    assert.ok(html.includes(expected)); assert.match(html, /Use another account/u);
    const accountText = identity.email || "Email unavailable";
    assert.equal(html.split(accountText).length - 1, 1);
    if (identity.email || !identity.displayName) {
      assert.equal(renderFinishPage({ ...model, identity }).split(accountText).length - 1, 1);
    }
    assert.match(html, /method="post" action="\/interaction\/interaction-test\/switch-account"/u);
    assert.match(html, /name="csrf_token" value="dummy-csrf"/u);
    assert.match(html, /Allow connection/u); assert.doesNotMatch(html, /<input[^>]+checked|<Human>/u);
  }
});

test("automatic return waits three seconds; keyboard Continue cancels it synchronously and stays native", () => {
  const automatic = browser();
  assert.equal(automatic.elements.get("finish-pause").hidden, false);
  automatic.advance(3000); assert.deepEqual(automatic.navigations, []);
  automatic.advance(3001); assert.deepEqual(automatic.navigations, ["/interaction/interaction-test/finish"]);
  const manual = browser(); manual.advance(3000);
  assert.equal(manual.click("finish-continue").defaultPrevented, false); assert.equal(manual.timers.size, 0);
  manual.advance(130001); assert.deepEqual(manual.navigations, ["/interaction/interaction-test/finish"]);
  assert.equal(manual.click("finish-continue").defaultPrevented, true);
});

test("server remaining time allows automatic return when the device clock is ahead", () => {
  const clientNow = model.deadline + 60000;
  const skewed = browser({}, clientNow);
  assert.equal(skewed.elements.get("finish-page").dataset.remainingMs, "120000");
  assert.equal(skewed.elements.get("finish-continue").getAttribute("href"), "/interaction/interaction-test/finish");
  skewed.advance(clientNow + 3000);
  assert.deepEqual(skewed.navigations, ["/interaction/interaction-test/finish"]);
});

test("auxclick and context menu pause automatic return without extending expiry", () => {
  for (const gesture of ["auxclick", "contextmenu"]) {
    const paused = browser(); paused.click("finish-continue", { button: 1 }, gesture);
    paused.advance(3001); assert.deepEqual(paused.navigations, []);
    assert.equal(paused.elements.get("finish-return-status").textContent, "Automatic return paused. Continue when you are ready.");
    paused.advance(120001);
    assert.equal(paused.elements.get("finish-continue").getAttribute("href"), null);
  }
});

test("auxclick and context menu are blocked once automatic return starts", () => {
  for (const gesture of ["auxclick", "contextmenu"]) {
    const automatic = browser(); automatic.advance(3001);
    assert.deepEqual(automatic.navigations, ["/interaction/interaction-test/finish"]);
    assert.equal(automatic.click("finish-continue", { button: 1 }, gesture).defaultPrevented, true);
    automatic.advance(130001);
    assert.deepEqual(automatic.navigations, ["/interaction/interaction-test/finish"]);
  }
});

test("modified clicks navigate once in this tab and still reject expired return links", () => {
  for (const properties of [{ button: 1 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
    const manual = browser();
    assert.equal(manual.click("finish-continue", properties).defaultPrevented, true);
    assert.equal(manual.timers.size, 0);
    manual.advance(130001); assert.deepEqual(manual.navigations, ["/interaction/interaction-test/finish"]);
    const expired = browser(); expired.time(120001);
    assert.equal(expired.click("finish-continue", properties).defaultPrevented, true);
    assert.deepEqual(expired.navigations, []);
  }
});

test("keyboard Pause keeps expiry alive, permits manual Continue, and disables stale continuation", () => {
  const paused = browser(); paused.click("finish-pause"); paused.advance(3001);
  assert.equal(paused.document.activeElement, paused.elements.get("finish-continue")); assert.deepEqual(paused.navigations, []); assert.equal(paused.timers.size, 1);
  paused.advance(120001); assert.equal(paused.elements.get("finish-title").textContent, "Return link expired");
  assert.equal(paused.elements.get("finish-status").textContent, "Return link expired. Return to client.example.test and start a new connection.");
  assert.equal(paused.elements.get("finish-continue").getAttribute("aria-disabled"), "true"); assert.equal(paused.document.activeElement, paused.elements.get("finish-page"));
  assert.equal(paused.click("finish-continue").defaultPrevented, true); assert.deepEqual(paused.navigations, []);
  const continued = browser(); continued.click("finish-pause"); continued.click("finish-continue"); continued.advance(120001);
  assert.deepEqual(continued.navigations, ["/interaction/interaction-test/finish"]);
});

test("page exit cancels timers and click, pageshow and focus recheck deadlines after suspension", () => {
  const exited = browser(); exited.event("pagehide"); assert.equal(exited.timers.size, 0);
  exited.advance(3001); assert.deepEqual(exited.navigations, []); exited.event("pageshow");
  exited.click("finish-continue"); assert.equal(exited.navigations.length, 1);
  for (const event of ["pageshow", "focus", "click"]) {
    const stale = browser(); stale.time(120001);
    if (event === "click") stale.click("finish-continue"); else stale.event(event);
    assert.equal(stale.elements.get("finish-title").textContent, "Return link expired");
    assert.equal(stale.elements.get("finish-continue").getAttribute("href"), null); assert.deepEqual(stale.navigations, []);
  }
});
