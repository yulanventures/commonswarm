/** Signed-in Carbon dialog border and WCAG 2.2 AA contrast audit across light/dark and desktop/phone viewports. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";
import { chromium, type Page } from "playwright-core";
import { compileFixtureFunction, renderAstroFixture } from "../../../tests/astro-fixture";

function installCarbonDialogsFixture() {
  const f = (window as any).existingFixture;
  const params = new URL(location.href).searchParams;
  f.scene = params.get("scene") ?? "channel-create";
  f.simulateShellDangerToken = params.get("shell_danger") === "1";

  const peerLead = "eeee5555-5555-4555-8555-555555555555";
  const previous = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.test.invalid") return previous(input, init);
    if (url.pathname === "/rest/v1/agent_principals") {
      if (url.searchParams.get("revoked_at") !== "is.null") return Response.json([]);
      return Response.json([
        {
          principal_id: peerLead,
          name: "Lead",
          model: "Claude",
          transport: "local",
          turn_only: false,
          owner_user_id: f.owner,
          revoked_at: null,
          workspace_id: f.workspace,
          created_at: "2026-11-01T00:00:00Z",
        },
      ]);
    }
    if (url.pathname === "/rest/v1/rpc/my_account_agents") {
      return Response.json([
        {
          principal_id: peerLead,
          name: "Lead",
          model: "Claude",
          transport: "local",
          turn_only: false,
          owner_user_id: f.owner,
          workspace_id: f.workspace,
          workspace_name: "Home",
          org_name: "Personal",
          created_at: "2026-11-01T00:00:00Z",
          revoked_at: null,
          last_seen_at: "2026-11-19T18:00:00Z",
        },
      ]);
    }
    if (url.pathname === "/rest/v1/hosted_mcp_connections") {
      return Response.json([
        {
          grant_id: "77777777-7777-4777-8777-777777777777",
          client_id: "claude-desktop",
          home_workspace_id: f.workspace,
          selected_workspace_ids: [f.workspace],
          state: "active",
          revoked_at: null,
          connection_expires_at: null,
          connection_expired_at: null,
        },
      ]);
    }
    if (url.pathname === "/rest/v1/hosted_mcp_seats") {
      return Response.json([
        {
          seat_id: "88888888-8888-4888-8888-888888888888",
          grant_id: "77777777-7777-4777-8777-777777777777",
          workspace_id: f.workspace,
          principal_id: peerLead,
          name: "Lead",
          revoked_at: null,
        },
      ]);
    }
    if (url.pathname === "/functions/v1/command" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      if (body?.command?.kind === "channel_create") {
        return Response.json({ error: "channel_slug_taken", message: "That channel name is already in use." }, { status: 409 });
      }
    }
    if (url.pathname === "/functions/v1/read" && request.method === "POST") {
      const body = await request.clone().json().catch(() => null);
      if (body?.resource === "conversations") {
        return Response.json({
          conversations: [
            {
              conversation_id: "99990000-0000-4000-8000-000000000001",
              kind: "general",
              channel_id: null,
              slug: "general",
              description: null,
              archived_at: null,
              joined: true,
              generation: 0,
              lead_mode: "workspace",
              lead_agent_principal_id: null,
              members: [],
              notify_level: "everything",
              starred: false,
              star_rank: null,
              read_through_at: null,
              read_through_id: null,
              unread_count: 0,
              mention_count: 0,
              last_message_at: "2026-11-19T14:00:00Z",
              last_message_id: null,
            },
          ],
        });
      }
    }
    return previous(input, init);
  };
}

async function observeCarbonDialogs() {
  const f = (window as any).existingFixture;
  const tick = () => fetch("/__observer-tick");
  const click = async (selector: string) => {
    const res = await fetch(`/__click?selector=${encodeURIComponent(selector)}`);
    if (!res.ok) throw new Error(`click failed (${selector}): ${await res.text()}`);
  };
  const key = async (name: string) => {
    const res = await fetch(`/__key?key=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`key failed (${name}): ${await res.text()}`);
  };
  const one = <T extends Element>(s: string) => document.querySelector<T>(s);
  const visible = (el: Element | null) => !!el && !el.closest("[hidden]") && el.getClientRects().length > 0;
  let stage = "boot";
  const wait = async (label: string, testFn: () => boolean, limit = 8000) => {
    stage = label;
    const end = Date.now() + limit;
    while (Date.now() < end) {
      if (testFn()) return;
      await tick();
    }
    throw new Error(`timed out: ${label}`);
  };
  const openDrawerIfPhone = async () => {
    if (innerWidth <= 832 && !one("dialog.cs-org-drawer[open]")) {
      await click('button[aria-label="Open navigation"]:visible');
      await wait("drawer open", () => !!one("dialog.cs-org-drawer[open]"));
    }
  };
  const hasVisibleBorder = (el: Element | null): boolean => {
    if (!el) return false;
    const border = getComputedStyle(el).borderTopColor;
    return !!border && border !== "rgba(0, 0, 0, 0)" && border !== "transparent";
  };
  const parseRgb = (css: string): [number, number, number] | null => {
    const m = css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const contrastRatio = (fgCss: string, bgCss: string): number => {
    const fg = parseRgb(fgCss);
    const bg = parseRgb(bgCss);
    if (!fg || !bg) return 0;
    const lum = (rgb: [number, number, number]) => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const l1 = lum(fg);
    const l2 = lum(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  try {
    await import("/app.js");
    await document.fonts.ready;
    await wait("channel loaded", () => one("live-dashboard")?.getAttribute("data-state") === "channel" &&
      (one("live-dashboard")?.getAttribute("data-channel-view") === "feed" || one("live-dashboard")?.getAttribute("data-channel-view") === "feed-empty"));

    if (f.simulateShellDangerToken) {
      // Simulate PR #671 dark-mode foreground danger token to verify filled danger buttons stay independent.
      document.documentElement.style.setProperty("--k-shell-danger", "#f87171");
    }

    if (f.scene === "channel-create") {
      await openDrawerIfPhone();
      await click("[data-home-new-channel]:visible");
      await wait("channel dialog open", () => one<HTMLDialogElement>("[data-channel-dialog]")?.open === true);
      // Enter a slug and submit so the server refusal renders inside [data-channel-dialog-error]:
      const slug = one<HTMLInputElement>("[data-channel-new-slug]")!;
      slug.value = "ops";
      slug.dispatchEvent(new Event("input", { bubbles: true }));
      await click("[data-channel-create-submit]:visible");
      await wait("channel dialog error shown", () => {
        const err = one<HTMLElement>("[data-channel-create-form] [data-channel-dialog-error]");
        return !!err && !err.hidden && (err.textContent ?? "").trim().length > 0;
      });
      const cancelBtn = one<HTMLButtonElement>("[data-channel-create-form] [data-channel-dialog-cancel]");
      const borderOk = hasVisibleBorder(cancelBtn);
      document.documentElement.dataset.carbonDialogs = JSON.stringify({
        ok: borderOk,
        scene: f.scene,
        axeRoot: "[data-channel-dialog][open]",
        borderOk,
        error: borderOk ? undefined : "Cancel button in [data-channel-dialog] has a transparent border",
      });
      return;
    }

    if (f.scene === "command-palette") {
      await key("Control+k");
      await wait("command palette open", () => one<HTMLDialogElement>("dialog.dashboard__command-palette")?.open === true);
      await wait("command palette items rendered", () => document.querySelectorAll("dialog.dashboard__command-palette .cp-item__button").length > 0);
      const input = one<HTMLInputElement>("dialog.dashboard__command-palette .cp-input")!;
      const badge = one<HTMLElement>("dialog.dashboard__command-palette .cp-item__badge");
      const inputBorderOk = hasVisibleBorder(input);
      const badgeBorderOk = !badge || hasVisibleBorder(badge);
      const placeholderStyle = getComputedStyle(input, "::placeholder");
      const inputBg = getComputedStyle(input).backgroundColor;
      const placeholderContrast = Math.round(contrastRatio(placeholderStyle.color, inputBg) * 100) / 100;
      const placeholderOk = input.value === "" && Number(placeholderStyle.opacity) === 1 && placeholderContrast >= 4.5;
      document.documentElement.dataset.carbonDialogs = JSON.stringify({
        ok: inputBorderOk && badgeBorderOk && placeholderOk,
        scene: f.scene,
        axeRoot: "dialog.dashboard__command-palette[open]",
        inputBorderOk,
        badgeBorderOk,
        placeholderColor: placeholderStyle.color,
        inputBg,
        placeholderContrast,
        placeholderOk,
        error: inputBorderOk && badgeBorderOk && placeholderOk
          ? undefined
          : `Command palette check failed (inputBorder=${inputBorderOk}, badgeBorder=${badgeBorderOk}, placeholderContrast=${placeholderContrast})`,
      });
      return;
    }

    if (f.scene === "signout-others") {
      one<HTMLButtonElement>("[data-signout-others-open]")?.click();
      await wait("signout others open", () => one<HTMLDialogElement>("[data-signout-others-dialog]")?.open === true);
      const confirmBtn = one<HTMLButtonElement>("[data-signout-others-confirm]");
      const bg = confirmBtn ? getComputedStyle(confirmBtn).backgroundColor : "";
      const cancelBtn = one<HTMLButtonElement>("[data-signout-others-cancel]");
      const borderOk = hasVisibleBorder(cancelBtn);
      // Verify filled danger button keeps dark red (#b91c1c = rgb(185, 28, 28)), never #f87171:
      const fillOk = bg === "rgb(185, 28, 28)";
      document.documentElement.dataset.carbonDialogs = JSON.stringify({
        ok: borderOk && fillOk,
        scene: f.scene,
        axeRoot: "[data-signout-others-dialog][open]",
        bg,
        borderOk,
        fillOk,
        error: borderOk && fillOk ? undefined : `Unexpected signout confirm fill (${bg}) or cancel border (${borderOk})`,
      });
      return;
    }

    if (f.scene === "connected-apps") {
      one<HTMLButtonElement>("[data-connected-apps-open]")?.click();
      await wait("connected apps open", () => one<HTMLDialogElement>("[data-connected-apps-dialog]")?.open === true);
      await wait("connected app rendered", () => !!one("[data-connected-apps-list] .dashboard__connected-app"));
      document.documentElement.dataset.carbonDialogs = JSON.stringify({
        ok: true,
        scene: f.scene,
        axeRoot: "[data-connected-apps-dialog][open]",
      });
      return;
    }

    if (f.scene === "password") {
      one<HTMLButtonElement>("[data-password-open]")?.click();
      await wait("password dialog open", () => one<HTMLDialogElement>("[data-password-dialog]")?.open === true);
      document.documentElement.dataset.carbonDialogs = JSON.stringify({
        ok: true,
        scene: f.scene,
        axeRoot: "[data-password-dialog][open]",
      });
      return;
    }

    if (f.scene === "account-agents") {
      one<HTMLButtonElement>("[data-account-agents-open]")?.click();
      await wait("account agents open", () => one<HTMLDialogElement>("[data-account-agents-dialog]")?.open === true);
      await wait("agent listed", () => !!one("[data-account-agents-list] .account-agents__agent"));
      document.documentElement.dataset.carbonDialogs = JSON.stringify({
        ok: true,
        scene: f.scene,
        axeRoot: "[data-account-agents-dialog][open]",
      });
      return;
    }

    throw new Error(`unknown scene: ${f.scene}`);
  } catch (error) {
    document.documentElement.dataset.carbonDialogs = JSON.stringify({
      ok: false,
      stage,
      error: String(error),
    });
  }
}

test("Carbon dialogs border and WCAG 2.2 AA contrast audit", { timeout: 300_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const fixture = await compileFixtureFunction(new URL(import.meta.url), "installCarbonDialogsFixture");
  const observe = await compileFixtureFunction(new URL(import.meta.url), "observeCarbonDialogs");
  const axeSource = await readFile(fileURLToPath(new URL("../../../node_modules/axe-core/axe.min.js", import.meta.url)), "utf8");
  const html = "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" + styles.join("\n") +
    "</style><script>" + install + fixture + "</script></head><body>" + markup + "<script type='module'>" + observe + "</script></body></html>";
  const fonts = fileURLToPath(new URL("../../../public/fonts/", import.meta.url));
  let activePage: Page | null = null;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/__observer-tick") { setTimeout(() => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ now: Date.now() })); }, 2); return; }
    if (url.pathname === "/__click") { void activePage!.locator(url.searchParams.get("selector")!).first().click({ timeout: 8_000 }).then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
    if (url.pathname === "/__key") { void activePage!.keyboard.press(url.searchParams.get("key")!).then(() => response.end("ok"), error => { response.writeHead(500); response.end(String(error)); }); return; }
    if (url.pathname.startsWith("/fonts/") && url.pathname.endsWith(".woff2")) { void readFile(join(fonts, basename(url.pathname))).then(data => { response.writeHead(200, { "Content-Type": "font/woff2" }); response.end(data); }, () => { response.writeHead(404); response.end(); }); return; }
    response.writeHead(200, { "Content-Type": url.pathname === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
    response.end(url.pathname === "/app.js" ? bundled.join("\n") : html);
  });
  const browser = await launchPlaywrightChromium(chromium);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const evidence = process.env.CARBON_DIALOGS_OUT || join(process.cwd(), "../site-observer-evidence/carbon-dialogs-a11y");
    await mkdir(evidence, { recursive: true });
    const ws = "11111111-1111-4111-8111-111111111111";
    const cases: { name: string; width: number; height: number; query: string; screenshot?: boolean }[] = [
      ...(["light", "dark"] as const).flatMap((theme) => [
        { name: `1440x900-${theme}-channel-create`, width: 1440, height: 900, query: `w=${ws}&c=general&theme=${theme}&scene=channel-create`, screenshot: true },
        { name: `360x740-${theme}-channel-create`, width: 360, height: 740, query: `w=${ws}&c=general&theme=${theme}&scene=channel-create`, screenshot: true },
        { name: `1440x900-${theme}-command-palette`, width: 1440, height: 900, query: `w=${ws}&c=general&theme=${theme}&scene=command-palette`, screenshot: true },
        { name: `360x740-${theme}-command-palette`, width: 360, height: 740, query: `w=${ws}&c=general&theme=${theme}&scene=command-palette`, screenshot: true },
        { name: `1440x900-${theme}-signout-others`, width: 1440, height: 900, query: `w=${ws}&c=general&theme=${theme}&scene=signout-others&shell_danger=1`, screenshot: true },
        { name: `360x740-${theme}-signout-others`, width: 360, height: 740, query: `w=${ws}&c=general&theme=${theme}&scene=signout-others&shell_danger=1`, screenshot: true },
        { name: `1440x900-${theme}-connected-apps`, width: 1440, height: 900, query: `w=${ws}&c=general&theme=${theme}&scene=connected-apps`, screenshot: true },
        { name: `1440x900-${theme}-password`, width: 1440, height: 900, query: `w=${ws}&c=general&theme=${theme}&scene=password`, screenshot: true },
        { name: `1440x900-${theme}-account-agents`, width: 1440, height: 900, query: `w=${ws}&c=general&theme=${theme}&scene=account-agents`, screenshot: true },
      ]),
    ];
    const report: Record<string, any> = {};
    for (const item of cases) {
      const context = await browser.newContext({ viewport: { width: item.width, height: item.height }, hasTouch: item.width < 1024 });
      activePage = await context.newPage();
      try {
        await activePage.goto(`http://127.0.0.1:${address.port}/app?${item.query}`);
        await activePage.waitForFunction(() => !!document.documentElement.dataset.carbonDialogs, null, { timeout: 30_000 });
        const result = await activePage.evaluate(() => JSON.parse(document.documentElement.dataset.carbonDialogs!));
        if (result.axeRoot) {
          await activePage.addScriptTag({ content: axeSource });
          const axeRes = await activePage.evaluate(async (sel: string) => {
            const visibleNodes = [...document.querySelectorAll(sel)].filter(el => !el.closest("[hidden]") && el.getClientRects().length > 0);
            const target = visibleNodes[0] ?? document.querySelector(sel) ?? document.body;
            return (window as any).axe.run(target, {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
            });
          }, result.axeRoot);
          result.axeViolations = axeRes.violations.map((v: any) => ({
            id: v.id,
            impact: v.impact,
            help: v.help,
            nodes: v.nodes.map((n: any) => ({ html: n.html.slice(0, 180), summary: n.failureSummary?.slice(0, 200) })).slice(0, 5),
          }));
        }
        report[item.name] = result;
        if (item.screenshot) {
          await activePage.screenshot({ path: join(evidence, `${item.name}.png`), fullPage: false });
        }
      } catch (error) {
        report[item.name] = { ok: false, error: String(error) };
      } finally {
        await context.close();
        activePage = null;
      }
    }
    await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
    const failures = Object.entries(report).filter(([, r]) => !r.ok || (r.axeViolations?.length ?? 0) > 0);
    assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
