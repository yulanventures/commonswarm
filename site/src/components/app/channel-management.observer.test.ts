/** Mounted channel lifecycle, native keyboard/focus and responsive captures. Synthetic HTTP, real app. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test } from "../../../tests/chrome.js";
import { launchPlaywrightChromium } from "../../../tests/chrome.js";
import { chromium, type Page } from "playwright-core";
import { compileFixtureFunction, renderAstroFixture } from "../../../tests/astro-fixture";

function installChannelFixture() {
  const f = (window as any).existingFixture;
  f.added = true;
  f.channelCommands = []; f.channelFailure = null; f.holdChannel = false; f.channelHeld = false; f.channelSettled = false;
  f.activeChannel = "66666666-6666-4666-8666-666666666666";
  f.archivedChannel = "77777777-7777-4777-8777-777777777777";
  const reader = new URL(location.href).searchParams.get("reader") === "1";
  f.reader = reader; f.capture = new URL(location.href).searchParams.get("capture");
  const make = (id: string, slug: string, description: string | null, archived = false) => ({
    channel_id: id, workspace_id: f.workspace, slug, purpose: description,
    created_by_principal: reader ? "88888888-8888-4888-8888-888888888888" : f.owner, created_by_kind: "user",
    created_at: "2026-11-01T00:00:00Z", archived_at: archived ? "2026-11-02T00:00:00Z" : null,
  });
  f.channelRows = [make(f.activeChannel, "design", "Decisions, references and release work for the team."),
    make(f.archivedChannel, "research-archive", "Old notes and useful references", true),
    ...Array.from({ length: 7 }, (_, i) => make(`99999999-9999-4999-8999-${String(i).padStart(12, "0")}`, `project-${i}`, `Project ${i} working notes`))];
  const previous = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin !== "https://api.test.invalid") return previous(input, init);
    if (url.pathname === "/rest/v1/channels") return Response.json(url.searchParams.get("workspace_id") === `eq.${f.workspace}` ? f.channelRows : []);
    if (url.pathname === "/rest/v1/member_profiles" && reader) return Response.json([{ user_id: f.owner, display_name: "Synthetic member", role: "member" }]);
    if (url.pathname === "/rest/v1/rpc/channel_unread") return Response.json({ workspace_id: f.workspace, generated_at: new Date().toISOString(),
      channels: [{ channel_id: null, slug: "general", unread: false }, ...f.channelRows.filter((r: any) => !r.archived_at).map((r: any) => ({ channel_id: r.channel_id, slug: r.slug, unread: r.channel_id === f.activeChannel }))] });
    if (url.pathname === "/functions/v1/command" && request.method === "POST") {
      const body = await request.clone().json(), command = body.command;
      if (String(command?.kind).startsWith("channel_")) {
        f.channelCommands.push(body); f.channelSettled = false;
        const failure = f.channelFailure;
        if (f.holdChannel) { f.channelHeld = true; await new Promise<void>(resolve => { f.releaseChannel = () => { f.holdChannel = false; resolve(); }; }); }
        f.channelSettled = true;
        if (failure) return Response.json({ error: "channel_exists", message: failure }, { status: 409 });
        const row = f.channelRows.find((r: any) => r.channel_id === command.channel_id);
        if (command.kind === "channel_update" && row) {
          if (Object.hasOwn(command, "slug")) row.slug = command.slug;
          if (Object.hasOwn(command, "purpose")) row.purpose = command.purpose;
        } else if (command.kind === "channel_archive" && row) row.archived_at = new Date().toISOString();
        else if (command.kind === "channel_unarchive" && row) row.archived_at = null;
        else return Response.json({ error: "unexpected_channel_command" }, { status: 400 });
        return Response.json({ status: "accepted", channel: row });
      }
      if (command?.kind === "signals_seen") return Response.json({ status: "accepted" });
    }
    return previous(input, init);
  };
}

async function observeChannelManagement() {
  const f = (window as any).existingFixture;
  const one = <T extends Element>(selector: string) => document.querySelector<T>(selector);
  const visible = (el: Element | null): el is HTMLElement => !!el && !el.closest("[hidden]") && el.getClientRects().length > 0;
  const shown = <T extends HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)].find(visible)!;
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  let stage = "boot";
  const wait = async (name: string, ready: () => unknown) => {
    stage = name;
    const now = async () => (await (await fetch("/__observer-tick")).json()).now;
    const until = await now() + 10_000;
    while (!ready()) { if (await now() > until) throw new Error("timed out at " + name); }
  };
  const key = async (value: string, shift = false) => {
    const response = await fetch(`/__key?key=${value}&shift=${shift ? 1 : 0}`);
    check(response.ok, "keyboard command failed: " + await response.text());
  };
  const click = async (selector: string) => {
    const response = await fetch(`/__click?selector=${encodeURIComponent(selector)}`);
    check(response.ok, "click failed: " + await response.text());
  };
  const input = (selector: string, value: string) => {
    const el = one<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); return el;
  };
  const settings = () => one<HTMLDialogElement>("[data-channel-dialog]")!;
  const directory = () => one<HTMLDialogElement>("[data-channel-directory]")!;
  const openSettings = async () => { await click("[data-channel-settings-open]:visible"); await wait("settings open", () => settings().open); };
  const target44 = (el: HTMLElement) => { const r = el.getBoundingClientRect(); check(r.width >= 44 && r.height >= 44, `small target: ${el.outerHTML.slice(0, 150)}`); };
  const fits = (dialog: HTMLDialogElement) => {
    const r = dialog.getBoundingClientRect();
    check(r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1, "dialog exceeds viewport");
    check(dialog.scrollWidth <= dialog.clientWidth + 1, "dialog overflows horizontally");
  };
  const save = async () => { one<HTMLFormElement>("[data-channel-rename-form]")!.requestSubmit(); await wait("settings saved", () => !settings().open); };
  try {
    await wait("channel header", () => visible(shown("[data-channel-settings-open]")) && visible(shown("[data-channel-header-description]")));
    const opener = shown<HTMLButtonElement>("[data-channel-settings-open]");
    target44(opener);
    check(one(".hm-frame")?.hasAttribute("data-feed-quiet"), "header test did not reach the quiet channel view");
    opener.focus(); await click("[data-channel-settings-open]:visible");
    await wait("settings modal", () => settings().matches(":modal"));
    fits(settings()); target44(one<HTMLElement>("[data-channel-dialog-cancel]")!);
    check(one<HTMLInputElement>("[data-channel-rename-slug]")?.value === "design", "settings show the wrong channel");
    check(one<HTMLTextAreaElement>("[data-channel-edit-description]")?.maxLength === 500, "description bound drifted");
    opener.focus(); check(settings().contains(document.activeElement), "background stole modal focus");
    const nameField = one<HTMLInputElement>("[data-channel-rename-slug]")!;
    nameField.focus(); await key("Tab");
    check(document.activeElement === one("[data-channel-edit-description]"), "Tab did not reach Description");
    await key("Tab", true); check(document.activeElement === nameField, "Shift+Tab did not return to Name");
    await key("Escape"); await wait("settings escape", () => !settings().open);
    check(document.activeElement === shown("[data-channel-settings-open]"), "Escape lost the current settings opener");
    await openSettings();
    const reader = f.reader;
    if (reader) {
      check(one<HTMLInputElement>("[data-channel-rename-slug]")!.readOnly && one<HTMLTextAreaElement>("[data-channel-edit-description]")!.readOnly, "reader can edit fields");
      check(!visible(one("[data-channel-rename-submit]")) && !visible(one("[data-channel-settings-archive]")), "reader sees write actions");
    } else if (f.capture !== "settings") {
      const unchangedSave = one<HTMLButtonElement>("[data-channel-rename-submit]")!;
      check(unchangedSave.disabled && !unchangedSave.hasAttribute("aria-busy") && getComputedStyle(unchangedSave).cursor !== "wait", "unchanged Save looks like a pending request");
      input("[data-channel-rename-slug]", "design-refresh"); input("[data-channel-edit-description]", "Updated decisions and references");
      f.channelFailure = "This channel name is already used.";
      one<HTMLFormElement>("[data-channel-rename-form]")!.requestSubmit();
      await wait("rename refusal", () => one("[data-channel-rename-form] [role=alert]")?.textContent?.includes(f.channelFailure));
      check(settings().open && one<HTMLInputElement>("[data-channel-rename-slug]")!.value === "design-refresh", "refusal lost the draft");
      f.channelFailure = null; await save();
      await wait("accepted header", () => shown("[data-channel-header-description]")?.textContent === "Updated decisions and references");
      check(f.channelCommands.at(-1).command.slug === "design-refresh", "name update was not sent");
      await openSettings(); input("[data-channel-edit-description]", ""); await save();
      check(f.channelCommands.at(-1).command.purpose === null && !Object.hasOwn(f.channelCommands.at(-1).command, "slug"), "clear must send null without overwriting an unchanged name");
      await openSettings(); input("[data-channel-edit-description]", "Release decisions and references");
      one<HTMLButtonElement>("[data-channel-settings-archive]")!.click();
      one<HTMLButtonElement>("[data-channel-archive-cancel]")!.click();
      check(one<HTMLTextAreaElement>("[data-channel-edit-description]")!.value === "Release decisions and references", "archive cancellation lost description draft");
      await save(); await openSettings(); one<HTMLButtonElement>("[data-channel-settings-archive]")!.click();
      one<HTMLFormElement>("[data-channel-archive-form]")!.requestSubmit();
      await wait("archived in place", () => !settings().open && visible(one("[data-channel-archived]")));
      check(!visible(one("[data-composer]")), "archived channel still has a composer");
      check(!!one(`[data-rail-channel-menu="${f.activeChannel}"]`), "archived row lost its management door");
      shown<HTMLButtonElement>("[data-channel-unarchive]").click();
      await wait("unarchived in place", () => !visible(one("[data-channel-archived]")) && visible(one("[data-composer]")));
      if (!visible(shown("[data-home-all-channels]"))) await click('button[aria-label="Open navigation"]:visible');
      await wait("All channels door", () => visible(shown("[data-home-all-channels]")));
      const browse = shown<HTMLButtonElement>("[data-home-all-channels]"); browse.focus(); await click("[data-home-all-channels]:visible");
      await wait("directory", () => directory().matches(":modal")); fits(directory());
      check(document.activeElement === one("[data-channel-directory-search]"), "directory did not focus Search");
      check(directory().querySelectorAll("[data-channel-directory-row]").length === 10, "directory omitted rail overflow or archived channels");
      check(!!directory().querySelector('[aria-label="Unread"]'), "reported unread state is missing");
      input("[data-channel-directory-search]", "#design-refresh");
      check(directory().querySelectorAll("[data-channel-directory-row]").length === 1, "search did not match the displayed channel name");
      input("[data-channel-directory-search]", "old notes");
      check(directory().querySelectorAll("[data-channel-directory-row]").length === 1, "search did not match description");
      input("[data-channel-directory-search]", "no matching channel"); check(one("[data-channel-directory-status]")?.textContent === "No channels found", "empty search is not explicit");
      input("[data-channel-directory-search]", "old notes");
      f.channelFailure = "Could not restore this channel.";
      const archivedAction = () => one<HTMLButtonElement>(`[data-channel-directory-action="unarchive:${f.archivedChannel}"]`)!;
      target44(archivedAction()); archivedAction().focus(); archivedAction().click();
      await wait("directory refusal", () => directory().querySelector('[role="alert"]')?.textContent?.includes(f.channelFailure));
      f.channelFailure = null; archivedAction().click();
      await wait("directory restored row", () => !archivedAction());
      check(document.activeElement?.getAttribute("data-channel-directory-action") === `open:${f.archivedChannel}`, "Unarchive lost row focus");
      const create = one<HTMLButtonElement>("[data-channel-directory-new]")!; await click("[data-channel-directory-new]");
      await wait("new from directory", () => settings().open && !directory().open);
      await key("Escape"); await wait("return to directory", () => directory().open);
      check(document.activeElement === create && one<HTMLInputElement>("[data-channel-directory-search]")!.value === "old notes", "new-channel cancellation lost directory focus or search");
      await click("[data-channel-directory-new]"); await wait("new again", () => settings().open);
      input("[data-channel-new-slug]", "late-refusal"); f.channelFailure = "Late refusal for the old draft"; f.holdChannel = true;
      one<HTMLFormElement>("[data-channel-create-form]")!.requestSubmit(); await wait("held create", () => f.channelHeld);
      check(one<HTMLButtonElement>("[data-channel-create-submit]")!.disabled && one("[data-channel-create-submit]")!.getAttribute("aria-busy") === "true", "pending write lost its busy state");
      check(settings().contains(document.activeElement), "disabling inputs dropped modal focus");
      await key("Escape"); await wait("directory while write held", () => directory().open);
      await click("[data-channel-directory-new]"); await wait("newer dialog", () => settings().open); input("[data-channel-new-slug]", "fresh-draft");
      f.releaseChannel(); await wait("old write settled", () => f.channelSettled);
      await (await fetch("/__observer-tick")).json();
      check(settings().open && one<HTMLInputElement>("[data-channel-new-slug]")!.value === "fresh-draft" && !visible(settings().querySelector('[role="alert"]')), "old refusal changed a newer dialog");
      await key("Escape"); await wait("directory restored", () => directory().open);
      await key("Escape"); await wait("directory escape", () => !directory().open);
      check(visible(document.activeElement) && (document.activeElement === browse || document.activeElement?.hasAttribute("data-home-all-channels")), "directory Escape lost its opener");
      if (!visible(shown("[data-home-all-channels]"))) await click('button[aria-label="Open navigation"]:visible');
      await click("[data-home-all-channels]:visible"); await wait("capture directory", () => directory().open);
      input("[data-channel-directory-search]", ""); fits(directory());
      for (const el of directory().querySelectorAll<HTMLElement>("button, a, input")) if (visible(el)) target44(el);
    }
    await document.fonts.ready;
    check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
    check(f.errors.length === 0, "app errors: " + f.errors.join(","));
    check(f.unexpected.length === 0, "unexpected HTTP: " + f.unexpected.join(","));
    document.documentElement.dataset.channelObservation = JSON.stringify({ ok: true, width: innerWidth, reader, capture: f.capture });
  } catch (error) {
    document.documentElement.dataset.channelObservation = JSON.stringify({ error: String(error), stage, active: document.activeElement?.outerHTML.slice(0, 300), app: one("live-dashboard")?.getAttribute("data-state"), errors: f.errors, requests: f.requests.slice(-10) });
  } finally { f.releaseChannel?.(); }
}

test("channel settings and directory preserve drafts, rights, native focus, archive lifecycle and changed-field commands", { timeout: 300_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const channelFixture = await compileFixtureFunction(new URL(import.meta.url), "installChannelFixture");
  const observe = await compileFixtureFunction(new URL(import.meta.url), "observeChannelManagement");
  const html = "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" + styles.join("\n") +
    "</style><script>" + install + channelFixture + "</script></head><body>" + markup + "<script type='module'>" + observe + "</script></body></html>";
  const fonts = fileURLToPath(new URL("../../../public/fonts/", import.meta.url));
  let activePage: Page | null = null;
  const keyboard = async (key: string, shift: boolean) => {
    assert.ok(key === "Tab" || key === "Escape");
    assert.ok(activePage);
    await activePage.keyboard.press(shift ? `Shift+${key}` : key);
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/__observer-tick") { setTimeout(() => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ now: Date.now() })); }, 2); return; }
    if (url.pathname === "/__key") { void keyboard(url.searchParams.get("key")!, url.searchParams.get("shift") === "1").then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
    if (url.pathname === "/__click") { void activePage!.locator(url.searchParams.get("selector")!).click().then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
    if (url.pathname.startsWith("/fonts/") && url.pathname.endsWith(".woff2")) { void readFile(join(fonts, basename(url.pathname))).then(data => { response.writeHead(200, { "Content-Type": "font/woff2" }); response.end(data); }, () => { response.writeHead(404); response.end(); }); return; }
    response.writeHead(200, { "Content-Type": url.pathname === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
    response.end(url.pathname === "/app.js" ? bundled.join("\n") : html);
  });
  const browser = await launchPlaywrightChromium(chromium);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const evidence = join(process.cwd(), "../site-observer-evidence/channel-management"); await mkdir(evidence, { recursive: true });
    const outcomes: Record<string, any> = {};
    const cases = [390, 1024, 1440].flatMap(width => ["light", "dark"].flatMap(theme => ["settings", "directory"].map(capture => ({ width, theme, capture, reader: false }))));
    cases.push({ width: 390, theme: "dark", capture: "settings", reader: true });
    for (const { width, theme, capture, reader } of cases) {
      const name = `${width}-${theme}-${capture}${reader ? "-reader" : ""}`;
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390 });
      activePage = await context.newPage();
      try {
        await activePage.goto(`http://127.0.0.1:${address.port}/app?w=11111111-1111-4111-8111-111111111111&c=66666666-6666-4666-8666-666666666666&case=channels&theme=${theme}&capture=${capture}${reader ? "&reader=1" : ""}`);
        await activePage.waitForFunction(() => !!document.documentElement.dataset.channelObservation, null, { timeout: 30_000 });
        outcomes[name] = await activePage.evaluate(() => JSON.parse(document.documentElement.dataset.channelObservation!));
        await activePage.screenshot({ path: join(evidence, name + ".png"), fullPage: true });
      } catch (error) {
        outcomes[name] = { error: String(error) };
        await activePage.screenshot({ path: join(evidence, name + ".png"), fullPage: true }).catch(() => {});
      } finally { await context.close(); activePage = null; }
    }
    await writeFile(join(evidence, "results.json"), JSON.stringify(outcomes, null, 2));
    assert.deepEqual(Object.entries(outcomes).filter(([, outcome]) => !outcome.ok), [], JSON.stringify(outcomes));
  } finally { await browser.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
