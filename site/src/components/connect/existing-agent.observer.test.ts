/** Real mounted app, buttons and browser client; only HTTP answers are synthetic. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAstroFixture, compileFixtureFunction } from "../../../tests/astro-fixture";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

// Owner boundary: a source/string test cannot prove the third click sends the intended human command,
// that a refused add stays actionable, or that a late response cannot repaint a different workspace.

async function observeExistingAgent() {
  const f = (window as any).existingFixture;
  let stage = "boot";
  const one = <T extends Element>(selector: string) => document.querySelector<T>(selector);
  const visible = (node: Element | null) => !!node && !node.closest("[hidden]") && node.getClientRects().length > 0;
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const wait = async (name: string, predicate: () => unknown) => {
    stage = name;
    if (predicate()) return;
    // Node's clock is real elapsed time; Chromium's virtual-time budget can jump
    // while the full app bundle is still parsing. The old 250 ticks allowed only ~0.5s.
    const now = async () => (await (await fetch("/__observer-tick")).json()).now as number;
    const deadline = await now() + 10_000;
    while (await now() < deadline) { if (predicate()) return; }
    throw new Error("timed out after 10 real seconds at " + name);
  };
  const notice = () => one<HTMLElement>("[data-ahp-existing-list] .workspace-agent-picker__notice")!;
  const add = () => one<HTMLButtonElement>("[data-ahp-existing-list] .pd-choice-add")!;
  const switchWorkspace = async () => {
    const menu = one<HTMLButtonElement>('button[aria-label="Open navigation"]');
    if (visible(menu)) menu!.click();
    one<HTMLElement>("[data-workspace-picker] summary")!.click();
    await wait("workspace choice", () => visible(one(`.cs-workspace-picker__item[value="${f.other}"]`)));
    one<HTMLButtonElement>(`.cs-workspace-picker__item[value="${f.other}"]`)!.click();
    await wait("new workspace", () => document.querySelector("live-dashboard")?.getAttribute("data-admin-workspace") === f.other
      && !visible(one("[data-ahp-existing-view]")));
  };
  try {
    const width = Number(new URL(location.href).searchParams.get("width")), desktop = width >= 1024;
    check(innerWidth === width, "wrong viewport: " + innerWidth);
    check(matchMedia("(hover: hover) and (pointer: fine)").matches === desktop, "wrong mouse/touch media");
    await wait("Add an agent entry", () => visible(one("[data-add-agent]")));
    one<HTMLButtonElement>("[data-add-agent]")!.click(); // action 1, existing route navigation
    await wait("host picker", () => visible(one("[data-ahp-existing]")));
    one<HTMLButtonElement>("[data-ahp-existing]")!.click(); // action 2
    await wait("existing view", () => visible(one("[data-ahp-existing-view]")));
    if (f.scenario === "empty") {
      await wait("empty directory", () => notice()?.textContent === "No agents to add to this workspace.");
      check(!add() && f.commands.length === 0, "an empty directory offered an add");
      one<HTMLButtonElement>("[data-ahp-existing-back]")!.click();
      check(!visible(one("[data-ahp-existing-view]")) && document.activeElement === one("[data-ahp-existing]"), "Back did not restore the opener");
    } else if (f.scenario === "stale-read" || f.scenario === "stale-account") {
      await wait("held directory", () => f.held);
      if (f.scenario === "stale-account") {
        one<HTMLButtonElement>("[data-user-menu-trigger]")!.click();
        await wait("account menu", () => visible(one("[data-user-menu] [data-signout]")));
        one<HTMLButtonElement>("[data-user-menu] [data-signout]")!.click();
        await wait("signed out", () => visible(one('[data-panel="signed-out"]')));
      } else await switchWorkspace();
      f.release(); await fetch("/__observer-tick");
      check(f.commands.length === 0 && !visible(one("[data-ahp-existing-view]")) && !add()
        && one<HTMLElement>("[data-ahp-existing-list]")?.dataset.agentPickerState === "loading", "a stale read painted the old picker");
    } else {
      if (f.scenario === "read-error") {
        await wait("directory retry", () => visible(one("[data-ahp-existing-list] .workspace-agent-picker__retry")));
        one<HTMLButtonElement>("[data-ahp-existing-list] .workspace-agent-picker__retry")!.click();
      }
      await wait("eligible identity", () => visible(add()));
      await fetch("/__observer-tick");
      check(one("[data-ahp-existing-view]")?.contains(document.activeElement), "a background render stole the picker focus");
      check(f.commands.length === 0, "opening the list submitted a command");
      const rect = add().getBoundingClientRect();
      check(rect.width >= 44 && rect.height >= 44, "Add target is under 44px");
      add().scrollIntoView({ block: "center" });
      const box = add().getBoundingClientRect();
      check(add().contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)), "Add target is obscured");
      add().focus(); check(document.activeElement === add(), "Add is not keyboard focusable");
      add().click(); // action 3: the explicit human membership command
      if (f.scenario === "stale-write") {
        await wait("held add", () => f.held);
        await switchWorkspace(); f.release(); await fetch("/__observer-tick");
        check(!visible(one("[data-ahp-existing-view]")) && add().textContent !== "Added"
          && !notice().textContent?.includes("added."), "a stale accepted add painted the old picker");
      } else if (f.scenario === "refused") {
        await wait("refusal", () => notice().textContent?.includes("Couldn't add") && !add().disabled);
        check(!notice().textContent?.includes("added."), "a refusal claimed success");
      } else {
        await wait("added receipt", () => notice().textContent?.includes("added.") && add().textContent === "Added");
        if (f.scenario === "refresh-error") {
          await wait("refresh accepted add", () => notice().textContent?.includes("Couldn't refresh"));
          f.failRoster = false; // The read service recovers; the UI retry must not post another add.
          one<HTMLButtonElement>("[data-ahp-existing-list] .workspace-agent-picker__retry")!.click();
        }
        await wait("authoritative roster", () => !!one(`[data-kylon-agent="${f.agent}"], [data-home-agent="${f.agent}"], [data-rail-agent="${f.agent}"]`));
        check(f.commands.length === 1, "a roster retry resubmitted the add");
        check(!/reconnect|sign in again/i.test(notice().textContent ?? ""), "added copy asked for OAuth reconnection");
      }
      check(f.commands.length === 1 && f.commands[0].command.kind === "add_agent_to_workspace"
        && f.commands[0].command.principal_id === f.agent && f.commands[0].workspace_id === f.workspace,
        "wrong identity, workspace or command");
    }
    await document.fonts.ready;
    check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
    check(f.unexpected.length === 0, "unexpected HTTP: " + f.unexpected.join(","));
    document.documentElement.dataset.existingObservation = JSON.stringify({ ok: true, scenario: f.scenario, commands: f.commands.length });
  } catch (error) {
    document.documentElement.dataset.existingObservation = JSON.stringify({ error: String(error), stage,
      notice: notice()?.textContent, view: document.querySelector("live-dashboard")?.getAttribute("data-channel-view"),
      accountReads: f.accountReads, pickerHost: (one("agent-host-picker") as any)?.hostId,
      appState: document.querySelector("live-dashboard")?.getAttribute("data-state"), requests: f.requests.slice(-12), errors: f.errors,
      commands: f.commands.map((c: any) => ({ kind: c.command?.kind, principal: c.command?.principal_id, workspace: c.workspace_id })) });
  }
}

test("existing agents: three real clicks add the selected identity; reads, refusals and stale results remain honest", { timeout: 180_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("../app/LiveDashboard.astro", import.meta.url));
  const app = "<!doctype html><html><head><meta charset='utf-8'><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" +
    styles.join("\n") + "</style><script>" + await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture") + "</script></head><body>" + markup +
    "<script>" + await compileFixtureFunction(new URL(import.meta.url), "observeExistingAgent") + "</script></body></html>";
  const fonts = fileURLToPath(new URL("../../../public/fonts/", import.meta.url));
  const server = createServer((request, response) => {
    if (request.url === "/__observer-tick") {
      setTimeout(() => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ now: Date.now() })); }, 2);
      return;
    }
    if (request.url?.startsWith("/fonts/") && request.url.endsWith(".woff2")) {
      void readFile(join(fonts, basename(request.url))).then(data => { response.writeHead(200, { "Content-Type": "font/woff2" }); response.end(data); }, () => { response.writeHead(404); response.end(); }); return;
    }
    response.writeHead(200, { "Content-Type": request.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
    response.end(request.url === "/app.js" ? bundled.join("\n") : app);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const evidence = join(process.cwd(), "../site-observer-evidence/existing-agent");
    await mkdir(evidence, { recursive: true });
    const outcomes: Record<string, unknown> = {}, chrome = await findChrome();
    const sizes = { 360: 740, 390: 844, 430: 932, 768: 1024, 820: 1180, 844: 390, 1024: 1366, 1440: 900 };
    const cases = [...Object.keys(sizes).flatMap(size => ["light", "dark"].map(theme => `success-${size}-${theme}`)),
      "read-error-390-dark", "empty-390-dark", "refused-390-dark", "refresh-error-390-dark",
      "stale-read-1440-dark", "stale-write-1440-dark", "stale-account-1440-dark"];
    for (const entry of cases) {
      const [, scenario, size, theme] = entry.match(/^(.*)-(\d+)-(light|dark)$/)!;
      const { stdout } = await launchChrome(chrome, [`--window-size=${size},${sizes[Number(size) as keyof typeof sizes]}`,
        ...(Number(size) >= 1024 ? ["--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"] : []),
        "--virtual-time-budget=60000", "--dump-dom",
        `--screenshot=${join(evidence, entry + ".png")}`,
        `http://127.0.0.1:${address.port}/app?w=11111111-1111-4111-8111-111111111111&case=${scenario}&theme=${theme}&width=${size}`],
        { timeout: 60000, maxBuffer: 12 * 1024 * 1024 });
      const raw = stdout.match(/data-existing-observation="([^"]*)"/)?.[1];
      outcomes[entry] = raw ? JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")) : { error: "observer did not finish" };
    }
    assert.deepEqual(Object.entries(outcomes).filter(([, value]: [string, any]) => !value.ok), [], JSON.stringify(outcomes));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
