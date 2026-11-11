/** Mounted native-modal behavior; synthetic HTTP only. Replaces the retired borrowed-page-host fixture. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
import { renderAstroFixture, compileFixtureFunction } from "../../../tests/astro-fixture";

async function observePeopleModal() {
  const f = (window as any).existingFixture;
  const visible = (el: Element | null): el is HTMLElement => !!el && !el.closest("[hidden]") && el.getClientRects().length > 0;
  const one = <T extends Element>(selector: string) => document.querySelector<T>(selector);
  const check = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
  let stage = "boot";
  const wait = async (name: string, predicate: () => unknown) => {
    stage = name;
    const now = async () => (await (await fetch("/__observer-tick")).json()).now;
    const until = await now() + 10_000;
    while (!predicate()) { if (await now() >= until) throw new Error("timed out at " + name); }
  };
  const door = () => [...document.querySelectorAll<HTMLButtonElement>('[data-roster-open], button[aria-label="Open navigation"]')].find(visible)!;
  const openPeople = async () => {
    const entry = door(); entry.focus();
    if (entry.matches('[aria-label="Open navigation"]')) {
      entry.click();
      await wait("drawer person", () => visible(one(`[data-rail-person="${f.owner}"]`)));
      const person = one<HTMLElement>(`[data-rail-person="${f.owner}"]`)!;
      person.focus(); person.click(); return person;
    }
    entry.click(); return entry;
  };
  const selectAgent = async () => {
    const row = () => one<HTMLButtonElement>(`#pd-agent-${f.agent}`)!;
    if (!visible(row())) {
      const back = one<HTMLButtonElement>("[data-people-profile-back]");
      check(visible(back), "selected phone profile has no visible Back to People"); back!.click();
    }
    await wait("agent row visible", () => visible(row())); row().click();
    await wait("selected agent", () => visible(one("#pd-detail-title")));
  };
  const modal = () => one<HTMLDialogElement>("[data-roster-dialog]")!;
  const deepLink = new URL(location.href).searchParams.get("deep") === "1";
  try {
    await wait("workspace door", () => visible(door()));
    let opener: HTMLElement = door(); const background = one<HTMLElement>("[data-home-route-pane]")!;
    let before = location.pathname + location.search;
    if (!deepLink) opener = await openPeople();
    await wait("People content", () => visible(one("[data-people-context]")) || visible(one("#pd-detail-title")));
    check(modal()?.matches(":modal"), "People & agents must be a native modal, not a page");
    check(new URL(location.href).searchParams.get("v") === "people", "open modal URL is missing");
    check(!background.contains(one("[data-people-context]")), "People replaced the background route");
    const detail = one<HTMLElement>("[data-people-detail]")!;
    door().focus();
    check(modal().contains(document.activeElement), "background control took modal focus");
    const rect = modal().getBoundingClientRect();
    check(rect.width <= innerWidth && rect.height <= innerHeight && rect.left >= 0 && rect.top >= 0, "dialog exceeds viewport");
    const close = one<HTMLElement>("[data-roster-close]")!.getBoundingClientRect();
    check(close.width >= 44 && close.height >= 44, "Close target is below 44px");
    if (innerWidth <= 832) check(Math.abs(rect.bottom - innerHeight) <= 1, "phone modal is not a bottom sheet");
    await selectAgent();
    check(modal().contains(detail), "detail escaped the modal");
    one<HTMLButtonElement>("[data-edit-model]")!.click();
    const input = one<HTMLInputElement>("[data-model-editor] input")!;
    input.value = "Claude — confirmed model";
    one<HTMLFormElement>("[data-model-editor]")!.requestSubmit();
    await wait("spoken receipt after refresh", () => one("[data-people-receipt]")?.textContent?.includes("Model changed"));
    check(modal().open && detail.isConnected && modal().contains(detail), "refresh closed the modal or lost its detail");
    const remove = one<HTMLButtonElement>('[data-people-detail] [data-pd-focus^="remove-agent-"]')
      ?? [...document.querySelectorAll<HTMLButtonElement>("[data-people-detail] button")].find(b => /Remove/.test(b.textContent ?? ""));
    check(!!remove, "selected agent lost its removal action");
    remove!.click();
    await wait("nested confirmation", () => one<HTMLDialogElement>("[data-people-confirm]")?.open);
    const confirmation = one<HTMLDialogElement>("[data-people-confirm]")!;
    check(confirmation.matches(":modal") && modal().open, "confirmation is not stacked above People");
    confirmation.requestClose();
    await wait("inner cancel", () => !confirmation.open);
    check(modal().open && modal().contains(document.activeElement), "inner cancel closed the outer dialog or lost focus");
    one<HTMLButtonElement>("[data-roster-close]")!.click();
    check(!modal().open && !new URL(location.href).searchParams.has("v"), "Close left People in the URL");
    if (!deepLink) check(location.pathname + location.search === before, "Close changed the underlying route");
    check(document.activeElement === opener || document.activeElement?.matches('[data-roster-open], button[aria-label="Open navigation"]'), "Close did not return focus to a workspace door");
    await openPeople();
    await wait("reopen", () => modal().open && (visible(one("[data-people-context]")) || visible(one("#pd-detail-title"))));
    check(one("[data-people-detail]") === detail, "reopen lost the persistent detail host");
    await selectAgent();
    await document.fonts.ready;
    check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
    check(f.unexpected.length === 0, "unexpected HTTP: " + f.unexpected.join(","));
    document.documentElement.dataset.peopleObservation = JSON.stringify({ ok: true, width: innerWidth, deepLink });
  } catch (error) {
    document.documentElement.dataset.peopleObservation = JSON.stringify({ error: String(error), stage,
      state: one("live-dashboard")?.getAttribute("data-state"), open: modal()?.open, requests: f.requests.slice(-10), errors: f.errors });
  }
}

test("People & agents is a native modal with persistent details, safe nested confirmation, receipts and focus return", { timeout: 180_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const observe = await compileFixtureFunction(new URL(import.meta.url), "observePeopleModal");
  const html = "<!doctype html><html><head><meta charset='utf-8'><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" + styles.join("\n") +
    "</style><script>" + install + "</script></head><body>" + markup + "<script type='module'>" + observe + "</script></body></html>";
  const fonts = fileURLToPath(new URL("../../../public/fonts/", import.meta.url));
  const server = createServer((request, response) => {
    if (request.url === "/__observer-tick") { setTimeout(() => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ now: Date.now() })); }, 2); return; }
    if (request.url?.startsWith("/fonts/") && request.url.endsWith(".woff2")) {
      void readFile(join(fonts, basename(request.url))).then(data => { response.writeHead(200, { "Content-Type": "font/woff2" }); response.end(data); }, () => { response.writeHead(404); response.end(); }); return;
    }
    response.writeHead(200, { "Content-Type": request.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
    response.end(request.url === "/app.js" ? bundled.join("\n") : html);
  });
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const evidence = join(process.cwd(), "../site-observer-evidence/people-modal"); await mkdir(evidence, { recursive: true });
    const chrome = await findChrome(), outcomes: Record<string, unknown> = {};
    for (const [width, height, theme, deep] of [[390,844,"light",false],[390,844,"dark",false],[1440,900,"light",false],[1440,900,"dark",false],[390,844,"dark",true],[1440,900,"dark",true]] as const) {
      const name = `${width}-${theme}${deep ? "-deep-link" : ""}`;
      const { stdout } = await launchChrome(chrome, [`--window-size=${width},${height}`, ...(width > 832 ? ["--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4"] : []), "--virtual-time-budget=120000", "--dump-dom", `--screenshot=${join(evidence,name+".png")}`,
        `http://127.0.0.1:${address.port}/app?w=11111111-1111-4111-8111-111111111111&case=people&theme=${theme}${deep ? "&v=people&deep=1" : ""}`], { timeout: 60000, maxBuffer: 12*1024*1024 });
      const raw = stdout.match(/data-people-observation="([^"]*)"/)?.[1];
      outcomes[name] = raw ? JSON.parse(raw.replaceAll("&quot;",'"').replaceAll("&amp;","&").replaceAll("&lt;","<").replaceAll("&gt;",">")) : { error: "observer did not finish" };
    }
    assert.deepEqual(Object.entries(outcomes).filter(([,v]: [string,any]) => !v.ok), [], JSON.stringify(outcomes));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
