/** Reached by `npm --prefix site test` and `test:ci` through the recursive component-observer glob. CI only:
 * browserTest skips unless RUN_BROWSER_TESTS=1 (server-suite.yml builds dist/ first). */
import assert from "node:assert/strict";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

/*
 * People & agents is a page in the route pane. It borrows two persistent hosts (the detail column and
 * the sign-in block). Release 1-6 parked only the sign-in block when another route took the pane, so an
 * agent, to-do, To-dos or Catch up render detached the detail column, and the next visit to People
 * returned early on the missing host: the URL said People and the page was blank until a reload
 * (code review, release 7). This drives the built app (sample mode, no backend) through
 * People -> X -> People in ONE document and checks that the page and its detail column come back.
 *
 * Navigation uses the app's own router: a same-document history entry plus the popstate the app
 * listens to (what the browser's Forward does), and the browser's Back for the return. The sample
 * build has no Manage link and no To-dos link on the People page, so the route is entered directly;
 * the agent route is the one Manage opens.
 */
const siteRoot = join(import.meta.dirname, "..", "..", "..");
const distRoot = join(siteRoot, "dist");
const WORKSPACE = "sample-design-studio";

type PeopleState = { search: string; page: boolean; detailInPage: boolean; detailHosts: number; openers: number;
  contexts: number; contextInShell: boolean; contextInPage: boolean };
type ScenarioResult = {
  scenario: string;
  before: PeopleState;
  away: { search: string; peoplePageInDom: boolean; detailConnected: boolean; visibleSignIn: number };
  after: PeopleState;
  signInBefore: number;
  signInAfter: { mounted: boolean; visible: number };
  sameDetailHost: boolean;
  detail: { opened: boolean; title: string | null };
  sameDocument: boolean;
  returnedBy: string;
};
type DetailFocusResult = {
  viewport: { width: number; height: number };
  cases: Array<{ kind: string; via: string; id: string; before: FocusGeometry; opened: FocusGeometry; initial: FocusGeometry; returnNeedsScroll: boolean;
    after: FocusGeometry; collapsed: boolean; escapeHandled: boolean; sameDocument: boolean }>;
};
type FocusGeometry = {
  active: boolean; focusVisible: boolean; indicator: boolean; outside: boolean; insideViewport: boolean;
  shown: boolean; hiddenReasons: unknown[]; paneScroll: number;
  rect: { width: number; height: number }; clipped: unknown[];
};

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/* The script runs in the outer page and drives the app inside the iframe. Keep it free of backticks:
   the local probe (agent-shots/fix7) reads it from this file and runs the same steps. */
const peopleReturnScript = `
  const frame = document.querySelector("iframe");
  const report = (key, value) => { document.documentElement.setAttribute(key, encodeURIComponent(JSON.stringify(value))); };
  const run = async () => {
    const scenario = new URLSearchParams(location.search).get("scenario");
    const workspace = new URLSearchParams(location.search).get("workspace");
    const view = frame.contentWindow, doc = frame.contentDocument;
    const visible = (element) => !!element && !element.closest("[hidden],[inert]") && element.getClientRects().length > 0 && view.getComputedStyle(element).visibility === "visible";
    const diagnostics = () => ({ search: view.location.search, viewport: [view.innerWidth, view.innerHeight],
      phone: view.matchMedia("(max-width:52rem)").matches, fonts: doc.fonts.status, active: doc.activeElement?.outerHTML,
      page: !!doc.querySelector("[data-people-page]"), contexts: [...doc.querySelectorAll("[data-people-context]")].map(node => ({ parent: node.parentElement?.className, shown: visible(node) })),
      detail: { shown: visible(doc.querySelector("[data-people-detail]")), hosts: doc.querySelectorAll("[data-people-detail]").length },
      dialog: [...doc.querySelectorAll("dialog")].map(node => ({ open: node.open, modal: node.matches(":modal") })),
      inert: [...doc.querySelectorAll("[inert]")].map(node => node.className), signIn: doc.querySelector("[data-member-details]")?.parentElement?.className });
    const until = async (check, label, budget = 2000) => {
      const deadline = view.performance.now() + budget;
      while (!check()) {
        if (view.performance.now() >= deadline) throw new Error("timed out waiting for " + label + ": " + JSON.stringify(diagnostics()));
        await new Promise(resolve => view.setTimeout(resolve, budget === 8000 ? 100 : 20));
      }
    };
    const app = doc.querySelector("live-dashboard");
    await until(() => app && app.dataset.state === "channel", "the sample workspace", 8000);
    view.__peopleReturnDocument = true;
    const go = (search) => { view.history.pushState({ home: true }, "", "/app" + search); view.dispatchEvent(new view.PopStateEvent("popstate", { state: { home: true } })); };
    if (scenario === "detail-focus") {
      /* Real built app, Sample data and actual close/keydown handlers. No layout override or
         scroll/focus repair: the only actions after opening are Close or Escape. Escape uses a
         DOM KeyboardEvent, not a claim about trusted physical keyboard delivery. */
      const number = (value) => Number.parseFloat(value) || 0;
      const box = (rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height });
      const measure = (element) => {
        const rect = box(element.getBoundingClientRect()), style = view.getComputedStyle(element);
        const opaque = (color) => color !== "transparent" && !/^rgba\\([^)]*,\\s*0(?:\\.0+)?\\)$/.test(color) && !/\\/\\s*0(?:\\.0+)?\\)$/.test(color);
        const outline = style.outlineStyle !== "none" && style.outlineStyle !== "hidden" && number(style.outlineWidth) > 0 && opaque(style.outlineColor);
        const edge = outline ? Math.max(0, number(style.outlineWidth) + number(style.outlineOffset)) : 0;
        const outset = { left: edge, right: edge, top: edge, bottom: edge }; let shadow = false;
        for (const part of style.boxShadow.split(/,(?![^()]*\\))/)) {
          if (part === "none" || part.includes("inset")) continue;
          const color = part.match(/rgba?\\([^)]*\\)/)?.[0];
          const values = part.replace(/(?:rgba?|color|oklch|hsl)a?\\([^)]*\\)/g, "").match(/-?\\d+(?:\\.\\d+)?px/g)?.map(number);
          if (!values || values.length < 2 || (color && !opaque(color))) continue;
          const [x, y, blur = 0, spread = 0] = values, extent = Math.max(0, blur + spread);
          shadow ||= extent > 0 || x !== 0 || y !== 0;
          outset.left = Math.max(outset.left, extent - x); outset.right = Math.max(outset.right, extent + x);
          outset.top = Math.max(outset.top, extent - y); outset.bottom = Math.max(outset.bottom, extent + y);
        }
        const ring = { left: rect.left - outset.left, right: rect.right + outset.right, top: rect.top - outset.top, bottom: rect.bottom + outset.bottom };
        const viewport = { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight };
        const intersection = { ...viewport }, ancestors = [], ignoredNonbox = [], hiddenReasons = []; let opacity = number(style.opacity);
        for (let node = element; node; node = node.parentElement) {
          const css = view.getComputedStyle(node);
          if (node.hidden || node.inert || css.display === "none" || css.visibility !== "visible")
            hiddenReasons.push({ tag: node.tagName, classes: node.className, hidden: node.hidden, inert: node.inert, display: css.display, visibility: css.visibility });
        }
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const css = view.getComputedStyle(ancestor);
          opacity *= number(css.opacity);
          if (css.display === "contents") { ignoredNonbox.push({ tag: ancestor.tagName, classes: ancestor.className }); continue; }
          const clipX = /auto|scroll|hidden|clip/.test(css.overflowX), clipY = /auto|scroll|hidden|clip/.test(css.overflowY);
          if (!clipX && !clipY) continue;
          const r = ancestor.getBoundingClientRect();
          const bounds = { left: r.left + ancestor.clientLeft, right: r.left + ancestor.clientLeft + ancestor.clientWidth,
            top: r.top + ancestor.clientTop, bottom: r.top + ancestor.clientTop + ancestor.clientHeight };
          if (clipX) { intersection.left = Math.max(intersection.left, bounds.left); intersection.right = Math.min(intersection.right, bounds.right); }
          if (clipY) { intersection.top = Math.max(intersection.top, bounds.top); intersection.bottom = Math.min(intersection.bottom, bounds.bottom); }
          ancestors.push({ tag: ancestor.tagName, classes: ancestor.className, bounds, clipX, clipY, scrollTop: ancestor.scrollTop, scrollLeft: ancestor.scrollLeft,
            cutsX: clipX && (ring.left < bounds.left - .5 || ring.right > bounds.right + .5), cutsY: clipY && (ring.top < bounds.top - .5 || ring.bottom > bounds.bottom + .5) });
        }
        const shown = element.getClientRects().length > 0 && hiddenReasons.length === 0 && opacity > 0;
        return { active: doc.activeElement === element, focusVisible: element.matches(":focus-visible"), indicator: shown && (outline || shadow), shown, hiddenReasons,
          paneScroll: doc.querySelector("[data-home-route-pane]").scrollTop,
          rect, ring, outset, opacity, outline: style.outline, outlineOffset: style.outlineOffset, boxShadow: style.boxShadow, viewport, intersection, ancestors, ignoredNonbox,
          clipped: ancestors.filter((ancestor) => ancestor.cutsX || ancestor.cutsY),
          outside: rect.bottom <= intersection.top || rect.top >= intersection.bottom || rect.right <= intersection.left || rect.left >= intersection.right,
          insideViewport: ring.left >= -.5 && ring.right <= view.innerWidth + .5 && ring.top >= -.5 && ring.bottom <= view.innerHeight + .5 };
      };
      const waitFor = until;
      go("?w=" + workspace + "&v=people");
      await waitFor(() => visible(doc.querySelector("[data-people-page]")) && doc.querySelectorAll("[data-people-context] .pd-agent-disclosure").length === 9 && doc.fonts.status === "loaded", "Field lab roster and fonts");
      const cases = [];
      for (const kind of ["person", "agent"]) for (const via of ["Close", "Escape"]) {
        const rows = [...doc.querySelectorAll("[data-people-context] .pd-" + kind + "-disclosure")];
        const opener = kind === "agent" ? rows.at(-1) : rows[0];
        if (!opener) throw new Error("missing " + kind + " disclosure");
        // Explicit pre-action positioning only. No scroll/focus correction follows Close/Escape.
        doc.querySelector("[data-home-route-pane]").scrollTop = 0;
        const initial = measure(opener), id = opener.id;
        if (kind === "agent" && (!initial.shown || !initial.outside)) throw new Error("last Field lab agent must start genuinely below the phone viewport: " + JSON.stringify(initial));
        opener.scrollIntoView({ block: "center" });
        await waitFor(() => { const q = measure(opener); return q.shown && q.insideViewport && !q.clipped.length; }, "painted starting " + kind + " row");
        const before = measure(opener);
        if (!before.shown || before.outside) throw new Error("the starting disclosure is not painted: " + JSON.stringify(before));
        opener.click();
        await waitFor(() => visible(doc.querySelector("[data-people-detail]")) && doc.activeElement === doc.querySelector("#pd-detail-title"), "focused " + kind + " detail");
        const opened = measure(doc.getElementById(id));
        if (opened.shown && !opened.outside) throw new Error("opening details must hide or genuinely move its row offscreen: " + JSON.stringify(opened));
        const returnNeedsScroll = before.rect.top + before.paneScroll - opened.paneScroll >= before.intersection.bottom;
        if (kind === "agent" && !returnNeedsScroll) throw new Error("last-agent counterfactual does not require native return scrolling: " + JSON.stringify({ initial, before, opened }));
        let escapeHandled = false;
        if (via === "Close") doc.querySelector("[data-people-detail] .pd-close-detail").click();
        else { const event = new view.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }); doc.dispatchEvent(event); escapeHandled = event.defaultPrevented; }
        await waitFor(() => !visible(doc.querySelector("[data-people-detail]")) && doc.activeElement === doc.getElementById(id), "closed " + kind + " detail and returned focus via " + via);
        const returned = doc.getElementById(id), after = measure(returned);
        cases.push({ kind, via, id, initial, before, opened, after, returnNeedsScroll, escapeHandled, collapsed: returned.getAttribute("aria-expanded") === "false", sameDocument: view.__peopleReturnDocument === true });
        report("data-people-return-partial", { viewport: [view.innerWidth, view.innerHeight], cases });
        // Stop at the first product failure, preserving the exact uncorrected geometry in the report.
        if (!after.shown || !after.active || !after.focusVisible || !after.indicator || !after.insideViewport || after.clipped.length)
          throw new Error("returned " + kind + " focus via " + via + " is not fully visible: " + JSON.stringify(cases));
      }
      return { viewport: { width: view.innerWidth, height: view.innerHeight }, cases };
    }
    const state = () => {
      const page = doc.querySelector("[data-people-page]"), context = doc.querySelector("[data-people-context]"), detail = doc.querySelector("[data-people-detail]");
      return { search: view.location.search, page: visible(page), detailInPage: !!page && !!detail && page.contains(detail),
        detailHosts: doc.querySelectorAll("[data-people-detail]").length, openers: doc.querySelectorAll("[data-people-context] [aria-controls='pd-detail']").length,
        contexts: doc.querySelectorAll("[data-people-context]").length, contextInShell: !!context?.closest(".cs-org-context-body"), contextInPage: !!page && !!context && page.contains(context) };
    };
    const pageReady = () => { const q = state(); return q.page && q.detailInPage && q.detailHosts === 1 && q.contexts === 1 && q.openers > 0 &&
      (view.matchMedia("(max-width:52rem)").matches ? q.contextInPage : q.contextInShell) && doc.fonts.status === "loaded" &&
      visible(doc.querySelector("[data-people-context] .pd-page-head [data-member-details]")); };
    go("?w=" + workspace + "&v=people");
    await until(pageReady, "the People page/context/sign-in host/fonts");
    const before = state();
    const original = doc.querySelector("[data-people-detail]");
    /* A refused removal, as the app's FreshLoginRequired handler leaves it: the error and the sign-in block shown
       under the page header. (The sample build cannot reach the server refusal itself.) */
    const signInError = doc.querySelector("[data-member-error]"), reauth = doc.querySelector("[data-member-reauth]");
    if (signInError) { signInError.textContent = "Sign in again, then press Remove once more."; signInError.hidden = false; }
    if (reauth) reauth.hidden = false;
    const signInControls = () => Array.from(doc.querySelectorAll("[data-member-error], [data-member-reauth] button")).filter(visible).length;
    const signInBefore = signInControls();
    const agentRow = doc.querySelector("[data-people-context] .pd-agent-disclosure");
    const agentId = agentRow ? agentRow.id.slice("pd-agent-".length) : "";
    const away = { manage: "?w=" + workspace + "&agent=" + agentId, agent: "?w=" + workspace + "&agent=" + agentId,
      todos: "?w=" + workspace + "&v=todos", catchup: "?v=catchup" }[scenario];
    if (!away || ((scenario === "manage" || scenario === "agent") && !agentId)) throw new Error("no route for scenario " + scenario + " (agent " + agentId + ")");
    go(away);
    await until(() => view.location.search === away && !doc.querySelector("[data-people-page],[data-people-context]") &&
      original.isConnected && original.hidden && !original.closest("[data-home-route-pane]") && signInControls() === 0 &&
      (scenario === "catchup" ? visible(doc.querySelector("[data-home-catchup]")) : visible(doc.querySelector("[data-home-route-pane]"))), "settled away route " + away);
    const awayState = { search: view.location.search, peoplePageInDom: !!doc.querySelector("[data-people-page]"),
      detailConnected: !!original && original.isConnected && !!original.closest("[data-home-route-pane]"), visibleSignIn: signInControls() };
    let returnedBy = "Back";
    if (scenario === "agent") {
      /* The second way back: the agent page's own Manage action, else the workspace People door. */
      const manage = Array.from(doc.querySelectorAll("[data-hm-manage]")).find(visible);
      const door = Array.from(doc.querySelectorAll("[data-roster-open]")).find(visible);
      if (manage) { returnedBy = "agent page Manage"; manage.click(); }
      else if (door) { returnedBy = "People door"; door.click(); }
      else { returnedBy = "route"; go("?w=" + workspace + "&v=people"); }
    } else view.history.back();
    await until(() => view.location.search.includes("v=people") && pageReady(), "the People route/context/sign-in host again");
    const after = state();
    const host = doc.querySelector("[data-member-details]");
    const signInAfter = { mounted: !!host && !!host.closest("[data-people-context] .pd-page-head") && !host.hidden, visible: signInControls() };
    let detail = { opened: false, title: null };
    const opener = Array.from(doc.querySelectorAll("[data-people-context] [aria-controls='pd-detail']")).find(visible);
    if (opener) {
      opener.click(); await until(() => visible(doc.querySelector("[data-people-detail]")) && doc.activeElement === doc.querySelector("#pd-detail-title"), "the returned page's focused detail");
      const host = doc.querySelector("[data-people-detail]"); const title = doc.querySelector("#pd-detail-title");
      detail = { opened: !!host && visible(host) && !!title && !!host.closest("[data-people-page]"), title: title ? title.textContent : null };
    }
    return { scenario, before, away: awayState, after, sameDetailHost: doc.querySelector("[data-people-detail]") === original,
      detail, sameDocument: view.__peopleReturnDocument === true, returnedBy, signInBefore, signInAfter };
  };
  const start = () => void run().then((value) => report("data-people-return", value), (error) => report("data-people-return-error", String((error && error.stack) || error)));
  frame.addEventListener("load", start, { once: true });
`;

const startDistServer = async (): Promise<{ close(): Promise<void>; origin: string }> => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__people-return") {
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      const phone = url.searchParams.get("size") === "320" ? [320, 568] : url.searchParams.get("size") === "390" ? [390, 844] : [1360, 1100];
      response.end(`<!doctype html><html><body style="margin:0"><iframe title="People return" src="/app" style="border:0;width:${phone[0]}px;height:${phone[1]}px"></iframe><script>${peopleReturnScript}</script></body></html>`);
      return;
    }
    const relative = url.pathname === "/app" || url.pathname === "/app/" ? "app/index.html" : url.pathname.replace(/^\/+/, "");
    const filePath = normalize(join(distRoot, relative));
    if (!filePath.startsWith(`${distRoot}/`)) { response.writeHead(403).end("Forbidden"); return; }
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      response.writeHead(200, { "content-length": stat.size, "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream" });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "people-return observer server must bind a port");
  return {
    close: () => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); }),
    origin: `http://127.0.0.1:${address.port}`,
  };
};

const runScenario = async <T = ScenarioResult>(chrome: string, origin: string, scenario: string, size?: number): Promise<T> => {
  const { stdout, stderr } = await launchChrome(chrome, [
    "--single-process", "--no-zygote", "--run-all-compositor-stages-before-draw", "--window-size=1600,1200",
    "--virtual-time-budget=20000", "--dump-dom",
    `${origin}/__people-return?scenario=${scenario}&workspace=${size ? "sample-field-lab" : WORKSPACE}${size ? `&size=${size}` : ""}`,
  ], { maxBuffer: 10 * 1024 * 1024, timeout: 40_000, killSignal: "SIGKILL" });
  const encoded = stdout.match(/data-people-return="([^"]+)"/)?.[1];
  const failure = stdout.match(/data-people-return-error="([^"]+)"/)?.[1];
  assert.ok(encoded, `${scenario}: the app did not report\npage error: ${failure ? decodeURIComponent(failure) : "none"}\n` +
    `stderr: ${stderr.slice(-1_000)}\nDOM: ${stdout.slice(-1_500)}`);
  return JSON.parse(decodeURIComponent(encoded)) as T;
};

const SCENARIOS: Array<[string, string]> = [
  ["manage", "People -> Manage (the agent page) -> Back to People"],
  ["todos", "People -> To-dos -> Back to People"],
  ["catchup", "People -> Catch up (resets the session state) -> Back to People"],
  ["agent", "People -> an agent page -> its own way back to People"],
];

test("People & agents comes back with its detail column after another route took the pane, without a reload", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    for (const [scenario, label] of SCENARIOS) {
      const result = await runScenario(chrome, server.origin, scenario);
      const facts = JSON.stringify(result);
      /* Positive controls on the same run: the page was really on screen with its detail column before
         leaving, and the other route really replaced the pane (the page left the document). Without them,
         an unrendered page or a route that never left would pass the checks below. */
      assert.ok(result.before.page && result.before.detailInPage && result.before.openers > 0, `${label}: the People page never rendered: ${facts}`);
      assert.ok(result.before.contexts === 1 && result.before.contextInShell && !result.before.contextInPage, `${label}: the actual desktop roster must be projected once into context: ${facts}`);
      assert.equal(result.away.peoplePageInDom, false, `${label}: the other route did not replace the pane, so this measures nothing: ${facts}`);
      assert.equal(result.sameDocument, true, `${label}: the app reloaded, so this is not the in-app path: ${facts}`);
      assert.match(result.after.search, /v=people/, `${label}: the route did not return to People: ${facts}`);
      assert.ok(result.after.page, `${label}: the URL says People but the page is blank: ${facts}`);
      assert.ok(result.after.detailInPage, `${label}: the page came back without its detail column: ${facts}`);
      assert.equal(result.after.detailHosts, 1, `${label}: there must be exactly one detail host: ${facts}`);
      assert.ok(result.after.contexts === 1 && result.after.contextInShell && !result.after.contextInPage && result.after.openers === result.before.openers,
        `${label}: return must restore the whole desktop roster once, outside the main profile: ${facts}`);
      /* Parking keeps the one host (and any state on it); a recreated host means a route cleared the pane unparked. */
      assert.equal(result.sameDetailHost, true, `${label}: the detail host was lost and recreated, so a pane replacement skipped parkPeopleHosts: ${facts}`);
      assert.equal(result.detail.opened, true, `${label}: a person's details did not open on the returned page: ${facts}`);
      /* The sign-in block of a refused removal: shown on the page (control), gone under the other route, back on return. */
      assert.ok(result.signInBefore > 0, `${label}: the refused sign-in block never showed, so its hiding measures nothing: ${facts}`);
      assert.equal(result.away.visibleSignIn, 0, `${label}: the refusal's error or sign-in controls showed under another route: ${facts}`);
      assert.ok(result.signInAfter.mounted && result.signInAfter.visible > 0, `${label}: the sign-in block did not come back under the page header: ${facts}`);
    }
  } finally {
    await server.close();
  }
});

test("closing a person's or agent's details returns visible focus to its row on a phone", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    for (const [width, height] of [[390, 844], [320, 568]]) {
      const result = await runScenario<DetailFocusResult>(chrome, server.origin, "detail-focus", width);
      assert.deepEqual(result.viewport, { width, height });
      assert.deepEqual(result.cases.map(({ kind, via }) => [kind, via]), [["person", "Close"], ["person", "Escape"], ["agent", "Close"], ["agent", "Escape"]]);
      for (const row of result.cases) {
        const facts = `${width}×${height} ${row.kind}/${row.via}: ${JSON.stringify(row)}`;
        assert.ok(row.before.shown && !row.before.outside, `the origin must be painted before the real action: ${facts}`);
        assert.ok(!row.opened.shown || row.opened.outside, `selection must actually hide or move the origin offscreen: ${facts}`);
        if (row.kind === "agent") assert.ok(row.initial.shown && row.initial.outside && row.returnNeedsScroll,
          `the real last Field lab row must require return scrolling, making preventScroll:true a failing negative: ${facts}`);
        assert.ok(row.after.shown && row.after.active && row.collapsed && row.sameDocument, `Close must restore the actual matching painted row in the same app: ${facts}`);
        assert.ok(row.after.focusVisible && row.after.indicator, `the returned row must paint its focus indicator: ${facts}`);
        assert.ok(row.after.insideViewport, `the whole painted ring must fit the iframe viewport: ${facts}`);
        assert.deepEqual(row.after.clipped, [], `every generated clipping ancestor must contain the whole ring: ${facts}`);
        assert.ok(row.after.rect.width >= 44 && row.after.rect.height >= 44, `the actual row target remains at least 44px: ${facts}`);
        if (row.via === "Escape") assert.equal(row.escapeHandled, true, `the production Escape handler must consume the event: ${facts}`);
      }
    }
  } finally {
    await server.close();
  }
});
