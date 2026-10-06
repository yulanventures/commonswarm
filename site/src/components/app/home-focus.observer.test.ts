import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
import { focusFixture } from "./home-focus.fixture.js";

// File fixtures use the shared CI launcher; all expectations stay in the host test.
test("home refreshes keep rail controls, view headings and workspace menu focus", { timeout: 60_000 }, async () => {
  const { setup, production } = await focusFixture();
  const siteRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const fixtureScript = `
    import { buildHomeRail } from './src/lib/home-rail';
    import { buildPhoneTopBar, buildWorkspaceHeader, buildWorkspaceNav } from './src/lib/home-shell';
    import { renderCatchUp as buildCatchUp } from './src/lib/home-catchup';
    import { homeStructureKey, replaceHomeRegion, refreshHomeRailTimes, refreshHomeCatchUpTimes } from './src/lib/home-focus';
    import { mapHomePeople, mapHomeRail, mapCatchUp, initialCatchUpData } from './src/lib/home-map';
    import { routeHref } from './src/lib/home-route';
    import { PendingRefreshGate } from './src/lib/pending-refresh';
    import './src/styles/tokens.css'; import './src/styles/home/index.css';
    ${setup}
    ${production()}
    renderRoster();
    window.fixture = {
      poll,
      rename: () => { workspaces = workspaces.map(w => w.id === 'X' ? {...w,name:'Summer trip'} : w); renderRoster(); },
      removeTrip: () => { workspaces = workspaces.filter(w => w.id !== 'X'); renderRoster(); },
      changeShell: () => { workspaces = workspaces.map(w => w.id === 'W' ? {...w,name:'House'} : w); renderHomeShell(); },
      catchup: () => { homeRoute = {view:'catchup'}; catchUpData = initialCatchUpData(workspaces); renderHomeCatchUp(); },
      fillCard: () => { catchUpData[0] = {...catchUpData[0],state:'open'}; renderHomeCatchUp(); },
      repaint: () => { now += 60000; renderHomeCatchUp(); }
    };
    (async () => {
      const checks = [];
      const assert = {
        equal: (actual, expected, name) => checks.push({ actual, expected, name }),
        deepEqual: (actual, expected, name) => checks.push({ actual, expected, name }),
        notEqual: (actual, expected, name) => checks.push({ actual, expected, name, different: true })
      };
      const assertPollCompleted = (progress, reads) => {
        assert.equal(progress.reads, reads, 'each poll completed a roster read');
        assert.equal(progress.rendered, reads + 1, 'each poll reached the end of renderRoster');
      };
      const evaluate = async expression => (0, eval)(expression);
    assert.equal(await evaluate("!!window.fixture"), true, "production refresh functions initialized");
    const sequential = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')]
      .filter(node => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length > 0);
    assert.equal(sequential[2]?.dataset.railWorkspace, "X", "the third native keyboard target is the Trip link");
    sequential[2].focus();
    assert.equal(await evaluate("document.activeElement.dataset.railWorkspace"), "X", "the Trip link accepts focus");
    await evaluate("window.original = document.activeElement");
    const statusTitle = () => evaluate("document.querySelector('[data-rail-agent] .hm-status').title");
    assert.equal(await statusTitle(), "Active 13 minutes ago", "initial paint exposes an aging status detail");
    const pollTitles: string[] = [];
    for (const expectedReads of [1, 2]) {
      assertPollCompleted(await evaluate("fixture.poll()"), expectedReads);
      assert.equal(await evaluate("document.activeElement === window.original"), true, "unchanged/time-only polls retain the same DOM control");
      pollTitles.push(await statusTitle());
    }
    assert.deepEqual(pollTitles, ["Active 13 minutes ago", "Active 14 minutes ago"], "time labels refresh across the minute boundary");
    assert.notEqual(pollTitles[0], pollTitles[1], "the two polls exercise a time-only text change");
    await evaluate("fixture.rename()");
    assert.equal(await evaluate("document.activeElement.dataset.railWorkspace"), "X", "a changed workspace keeps its stable focus identity");
    assert.equal(await evaluate("document.activeElement === window.original"), false, "the real change rebuilt the control");
    await evaluate("fixture.removeTrip()");
    assert.equal(await evaluate("document.activeElement.id"), "hm-rail-workspaces-title", "removal falls back to the rail heading");

    await evaluate("document.querySelector('#hm-ws-menu-trigger').click(); window.menuItem = document.activeElement");
    assert.deepEqual(await evaluate("fixture.poll(60001)"), { reads: 3, rendered: 6 }, "the menu poll completes after the initial paint, two polls, rename and removal");
    assert.equal(await statusTitle(), "Active 15 minutes ago", "the open-menu poll crosses another minute boundary");
    assert.equal(await evaluate("document.activeElement === window.menuItem && document.querySelector('#hm-ws-menu-trigger').getAttribute('aria-expanded') === 'true'"), true, "aging detail leaves the menu open");
    await evaluate("fixture.changeShell()");
    assert.equal(await evaluate("document.activeElement.id"), "hm-ws-menu-trigger", "a shell rebuild returns focus to the closed menu's trigger");
    assert.equal(await evaluate("document.activeElement.getAttribute('aria-expanded')"), "false");

    await evaluate("fixture.catchup(); document.querySelector('#hm-catchup-title').focus(); window.heading = document.activeElement; fixture.repaint()");
    assert.equal(await evaluate("document.activeElement === window.heading"), true, "clock-only Catch up repaint preserves the H1 node");
    await evaluate("fixture.fillCard()");
    assert.equal(await evaluate("document.activeElement.id"), "hm-catchup-title", "a returned detail read preserves H1 focus");
    await evaluate("document.querySelector('.hm-catchup-card').focus(); fixture.catchup()");
    assert.equal(await evaluate("document.activeElement.dataset.workspaceId"), "W", "Catch up card identity survives a data rebuild");

      document.documentElement.dataset.focusChecks = btoa(unescape(encodeURIComponent(JSON.stringify(checks))));
    })().catch(error => { document.documentElement.dataset.fixtureError = String(error); });
  `;
  const bundle = await build({ absWorkingDir: siteRoot, bundle: true, write: false, format: "iife", platform: "browser",
    outfile: "focus.js", stdin: { contents: fixtureScript, resolveDir: siteRoot, loader: "ts" } });
  const js = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const css = bundle.outputFiles.find(file => file.path.endsWith(".css"))!.text;
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-home-focus-"));
  const fixturePath = join(directory, "index.html");
  await writeFile(fixturePath, `<!doctype html><html><head><style>${css}
    [hidden] {display:none!important} .hm-phone-bar,.hm-ws-nav {display:none}
    </style></head><body><div data-home-rail-slot></div><div data-home-workspace-shell></div>
    <div data-home-phone-nav></div><section data-home-catchup></section>
    <script>${js.replace(/<\/script/giu, "<\\/script")}</script></body></html>`);
  const { stdout } = await launchChrome(await findChrome(),
    ["--window-size=1440,900", "--dump-dom", "--virtual-time-budget=5000", pathToFileURL(fixturePath).href],
    { maxBuffer: 10 * 1024 * 1024, timeout: 45_000, killSignal: "SIGKILL" });
  const encoded = stdout.match(/<html\b[^>]*\bdata-focus-checks="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
  assert.ok(encoded, `focus refresh scenarios must complete: ${stdout.match(/data-fixture-error="([^"]*)"/)?.[1] ?? "no result"}`);
  const checks: { actual: unknown; expected: unknown; name: string; different?: boolean }[] =
    JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.equal(checks.length, 23, "every focus and poll expectation must run");
  for (const check of checks) {
    if (check.different) assert.notDeepEqual(check.actual, check.expected, check.name);
    else assert.deepEqual(check.actual, check.expected, check.name);
  }
  // Retain only task-created CI fixture directories for failure inspection.
});
