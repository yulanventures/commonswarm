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

type PeopleState = { search: string; page: boolean; detailInPage: boolean; detailHosts: number; openers: number };
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
    const settle = (ms) => new Promise((resolve) => view.setTimeout(resolve, ms || 150));
    const until = async (check, label) => { for (let i = 0; i < 80; i += 1) { if (check()) return true; await settle(100); } throw new Error("timed out waiting for " + label); };
    const visible = (element) => !!element && !element.closest("[hidden]") && element.getClientRects().length > 0;
    const app = doc.querySelector("live-dashboard");
    await until(() => app && app.dataset.state === "channel", "the sample workspace");
    view.__peopleReturnDocument = true;
    const go = (search) => { view.history.pushState({ home: true }, "", "/app" + search); view.dispatchEvent(new view.PopStateEvent("popstate", { state: { home: true } })); };
    const state = () => {
      const page = doc.querySelector("[data-people-page]"); const detail = doc.querySelector("[data-people-detail]");
      return { search: view.location.search, page: visible(page), detailInPage: !!page && !!detail && page.contains(detail),
        detailHosts: doc.querySelectorAll("[data-people-detail]").length, openers: doc.querySelectorAll("[data-people-page] [aria-controls='pd-detail']").length };
    };
    go("?w=" + workspace + "&v=people");
    await until(() => visible(doc.querySelector("[data-people-page]")), "the People page");
    await settle(200);
    const before = state();
    const original = doc.querySelector("[data-people-detail]");
    /* A refused removal, as the app's FreshLoginRequired handler leaves it: the error and the sign-in block shown
       under the page header. (The sample build cannot reach the server refusal itself.) */
    const signInError = doc.querySelector("[data-member-error]"), reauth = doc.querySelector("[data-member-reauth]");
    if (signInError) { signInError.textContent = "Sign in again, then press Remove once more."; signInError.hidden = false; }
    if (reauth) reauth.hidden = false;
    const signInControls = () => Array.from(doc.querySelectorAll("[data-member-error], [data-member-reauth] button")).filter(visible).length;
    const signInBefore = signInControls();
    const agentRow = doc.querySelector("[data-people-page] [id^='pd-agent-']");
    const agentId = agentRow ? agentRow.id.slice("pd-agent-".length) : "";
    const away = { manage: "?w=" + workspace + "&agent=" + agentId, agent: "?w=" + workspace + "&agent=" + agentId,
      todos: "?w=" + workspace + "&v=todos", catchup: "?v=catchup" }[scenario];
    if (!away || ((scenario === "manage" || scenario === "agent") && !agentId)) throw new Error("no route for scenario " + scenario + " (agent " + agentId + ")");
    go(away);
    await until(() => view.location.search === away, "the route " + away);
    await settle(600);
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
    await until(() => view.location.search.includes("v=people"), "the People route again").catch(() => {});
    await until(() => visible(doc.querySelector("[data-people-page]")), "the People page again").catch(() => {});
    await settle(300);
    const after = state();
    const host = doc.querySelector("[data-member-details]");
    const signInAfter = { mounted: !!host && !!host.closest("[data-people-page] .pd-page-head") && !host.hidden, visible: signInControls() };
    let detail = { opened: false, title: null };
    const opener = Array.from(doc.querySelectorAll("[data-people-page] [aria-controls='pd-detail']")).find(visible);
    if (opener) {
      opener.click(); await settle(300);
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
      response.end(`<!doctype html><html><body style="margin:0"><iframe title="People return" src="/app" style="border:0;width:1360px;height:1100px"></iframe><script>${peopleReturnScript}</script></body></html>`);
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

const runScenario = async (chrome: string, origin: string, scenario: string): Promise<ScenarioResult> => {
  const { stdout, stderr } = await launchChrome(chrome, [
    "--single-process", "--no-zygote", "--run-all-compositor-stages-before-draw", "--window-size=1600,1200",
    "--virtual-time-budget=20000", "--dump-dom",
    `${origin}/__people-return?scenario=${scenario}&workspace=${WORKSPACE}`,
  ], { maxBuffer: 10 * 1024 * 1024, timeout: 40_000, killSignal: "SIGKILL" });
  const encoded = stdout.match(/data-people-return="([^"]+)"/)?.[1];
  const failure = stdout.match(/data-people-return-error="([^"]+)"/)?.[1];
  assert.ok(encoded, `${scenario}: the app did not report\npage error: ${failure ? decodeURIComponent(failure) : "none"}\n` +
    `stderr: ${stderr.slice(-1_000)}\nDOM: ${stdout.slice(-1_500)}`);
  return JSON.parse(decodeURIComponent(encoded)) as ScenarioResult;
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
      assert.equal(result.away.peoplePageInDom, false, `${label}: the other route did not replace the pane, so this measures nothing: ${facts}`);
      assert.equal(result.sameDocument, true, `${label}: the app reloaded, so this is not the in-app path: ${facts}`);
      assert.match(result.after.search, /v=people/, `${label}: the route did not return to People: ${facts}`);
      assert.ok(result.after.page, `${label}: the URL says People but the page is blank: ${facts}`);
      assert.ok(result.after.detailInPage, `${label}: the page came back without its detail column: ${facts}`);
      assert.equal(result.after.detailHosts, 1, `${label}: there must be exactly one detail host: ${facts}`);
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
