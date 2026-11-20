/** Real-Chromium witness for keeping Add an agent inside <dialog[data-roster-dialog]> (Owner Bug 88fd8b36). */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";
import { chromium } from "playwright-core";
import { compileFixtureFunction, renderAstroFixture } from "../../../tests/astro-fixture";

const WS = "11111111-1111-4111-8111-111111111111";

function installRosterAddAgentFixture() {
  const f = (window as any).existingFixture;
  const previous = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.test.invalid") return previous(input, init);
    if (url.pathname === "/functions/v1/command") {
      const body = await request.clone().json().catch(() => ({}));
      const cmd = body?.command ?? {};
      if (cmd.kind === "register_device") {
        return Response.json({ status: "accepted", device_id: cmd.device_id });
      }
      if (cmd.kind === "create_agent_principal") {
        return Response.json({
          status: "accepted",
          principal_id: "bbbb2222-2222-4222-8222-222222222222",
          name: cmd.name ?? "DialogCLI",
        });
      }
      if (cmd.kind === "mint_agent_token") {
        return Response.json({
          status: "accepted",
          token_id: "cccc3333-3333-4333-8333-333333333333",
          principal_id: cmd.principal_id,
          run_id: cmd.run_id,
          agent_token: "swm_agt_" + "D".repeat(43),
          expires_at: "2099-01-01T00:00:00.000Z",
          message: "Agent credential minted. It is bound to this run, so the agent's work is attributable to it.",
        });
      }
    }
    if (url.pathname === "/functions/v1/read") {
      const body = await request.clone().json().catch(() => ({}));
      if (body.resource === "conversations") {
        return Response.json({
          conversations: [
            {
              conversation_id: "aaaa1111-1111-4111-8111-111111111111",
              workspace_id: f.ids.ws,
              kind: "general",
              channel_id: null,
              slug: "general",
              description: null,
              archived_at: null,
              joined: true,
              generation: 1,
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
              last_message_at: "2026-11-20T08:00:00Z",
              last_message_id: null,
            },
          ],
        });
      }
      if (body.resource === "conversation_history") {
        return Response.json({
          conversation: {
            conversation_id: "aaaa1111-1111-4111-8111-111111111111",
            kind: "general",
            channel_id: null,
            slug: "general",
            description: null,
            archived_at: null,
            joined: true,
            generation: 1,
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
            last_message_at: null,
            last_message_id: null,
          },
          messages: [],
          has_more: false,
          next_before: null,
          next_after: null,
        });
      }
    }
    return previous(input, init);
  };
}

test("Add an agent stays inside <dialog[data-roster-dialog]>, returns to roster, cleans watches on Escape, and preserves ?v=add-agent", { timeout: 180_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const installBase = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const installOverlay = await compileFixtureFunction(new URL(import.meta.url), "installRosterAddAgentFixture");
  const axeSource = await readFile(resolve(process.cwd(), "node_modules/axe-core/axe.min.js"), "utf8");
  const fontsDir = fileURLToPath(new URL("../../../public/fonts/", import.meta.url));

  const html =
    "<!doctype html><html><head><meta charset='utf-8'>" +
    "<meta name='commonswarm:url' content='https://api.test.invalid'>" +
    "<meta name='commonswarm:anon-key' content='synthetic-public'>" +
    "<style>" + styles.join("\n") + "</style>" +
    "<script>" + installBase + "\n" + installOverlay + "</script>" +
    "</head><body>" + markup + "</body></html>";

  const server = createServer((request, response) => {
    const reqUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname === "/app.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(bundled.join("\n"));
      return;
    }
    if (reqUrl.pathname.startsWith("/fonts/") && reqUrl.pathname.endsWith(".woff2")) {
      void readFile(join(fontsDir, basename(reqUrl.pathname))).then(
        (data) => { response.writeHead(200, { "Content-Type": "font/woff2" }); response.end(data); },
        () => { response.writeHead(404); response.end(); },
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
  });

  const evidenceDir = process.env.ROSTER_ADD_AGENT_CAPTURE_DIR
    ? resolve(process.env.ROSTER_ADD_AGENT_CAPTURE_DIR)
    : resolve(process.cwd(), "../site-observer-evidence/roster-dialog-add-agent");
  await mkdir(evidenceDir, { recursive: true });

  const browser = await launchPlaywrightChromium(chromium);
  const summary: Record<string, unknown> = {};

  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const origin = `http://127.0.0.1:${addr.port}`;

    const cases = [
      { width: 1024, height: 768, theme: "light" as const },
      { width: 1024, height: 768, theme: "dark" as const },
      { width: 360, height: 740, theme: "light" as const },
      { width: 360, height: 740, theme: "dark" as const },
    ];

    for (const { width, height, theme } of cases) {
      const label = `${width}x${height}-${theme}`;
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
      });
      // Track active 5_000 ms host-join watch intervals via plain JS string init script.
      await context.addInitScript(`
        (() => {
          const active = new Map();
          const origSet = window.setInterval.bind(window);
          const origClear = window.clearInterval.bind(window);
          window.__activeWatchIntervals = () => [...active.values()].filter((ms) => ms === 5000).length;
          window.setInterval = function(fn, ms, ...rest) {
            const id = origSet(fn, ms, ...rest);
            active.set(id, Number(ms));
            return id;
          };
          window.clearInterval = function(id) {
            active.delete(id);
            return origClear(id);
          };
        })();
      `);
      const page = await context.newPage();
      try {
        await page.goto(`${origin}/app?w=${WS}&case=people&theme=${theme}`, { waitUntil: "load" });
        await page.addScriptTag({ content: axeSource });

        // Open People & agents modal from the visible workspace door (matching people-hosts.observer.test.ts).
        await page.waitForFunction(() =>
          [...document.querySelectorAll('[data-roster-open], button[aria-label="Open navigation"]')]
            .some((el) => !el.closest("[hidden]") && el.getClientRects().length > 0),
        );
        const beforeUrl = await page.evaluate(() => location.pathname + location.search);

        const openedNav = await page.evaluate(() => {
          const door = [...document.querySelectorAll<HTMLElement>('[data-roster-open], button[aria-label="Open navigation"]')]
            .find((el) => !el.closest("[hidden]") && el.getClientRects().length > 0)!;
          door.focus();
          door.click();
          return door.matches('[aria-label="Open navigation"]');
        });
        if (openedNav) {
          await page.waitForFunction(() => {
            const person = [...document.querySelectorAll<HTMLElement>("[data-rail-person]")]
              .find((el) => !el.closest("[hidden]") && el.getClientRects().length > 0);
            if (!person) return false;
            person.focus();
            person.click();
            return true;
          });
        }

        await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("[data-roster-dialog]")?.matches(":modal") === true);

        // Ensure we are on the Agents tab so "Add an agent" is visible.
        const backToList = page.locator("[data-people-profile-back]");
        if (await backToList.isVisible()) await backToList.click();
        await page.locator('[data-roster-dialog] [data-pd-focus="tab-agents"]').click();
        await page.waitForSelector("[data-roster-dialog] [data-people-page-add-agent]");

        // 1. Click "Add an agent" inside <dialog[data-roster-dialog]>.
        await page.click("[data-roster-dialog] [data-people-page-add-agent]");
        await page.waitForSelector('[data-roster-dialog] [data-roster-add-agent]:not([hidden]) [data-channel-view="agent-choice"]:not([hidden]) [data-ahp-host="claude"]');

        const inModalState = await page.evaluate(() => {
          const dialog = document.querySelector<HTMLDialogElement>("[data-roster-dialog]")!;
          const app = document.querySelector<HTMLElement>("live-dashboard")!;
          const choice = document.querySelector<HTMLElement>('[data-channel-view="agent-choice"]')!;
          const backLabel = document.querySelector<HTMLElement>("[data-ahp-home-back-label]")?.textContent?.trim();
          const rect = dialog.getBoundingClientRect();
          return {
            modal: dialog.matches(":modal"),
            open: dialog.open,
            urlView: new URL(location.href).searchParams.get("v"),
            channelView: app.dataset.channelView,
            choiceInsideDialog: dialog.contains(choice),
            choiceVisible: !choice.hidden && choice.getClientRects().length > 0,
            backLabel,
            overflow: document.documentElement.scrollWidth > window.innerWidth,
            dialogFits: rect.width <= window.innerWidth + 1 && rect.height <= window.innerHeight + 1,
          };
        });
        assert.equal(inModalState.modal, true, `${label}: dialog must stay :modal`);
        assert.equal(inModalState.open, true, `${label}: dialog must stay open`);
        assert.equal(inModalState.urlView, "people", `${label}: URL must not navigate to v=add-agent`);
        assert.notEqual(inModalState.channelView, "agent-choice", `${label}: background channelView must not switch to agent-choice`);
        assert.equal(inModalState.choiceInsideDialog, true, `${label}: agent-choice must live inside dialog`);
        assert.equal(inModalState.choiceVisible, true, `${label}: agent-choice must be visible`);
        assert.equal(inModalState.backLabel, "People & agents", `${label}: back crumb must name People & agents`);
        assert.equal(inModalState.overflow, false, `${label}: zero horizontal page overflow`);
        assert.equal(inModalState.dialogFits, true, `${label}: dialog fits viewport`);

        // Select Claude to exercise the host-join watch & full compose panel inside the modal.
        await page.click('[data-roster-dialog] [data-ahp-host="claude"]');
        await page.waitForSelector('[data-roster-dialog] [data-ahp-paste]:not([hidden]) [data-ahp-copy-sentence]');
        await page.screenshot({ path: join(evidenceDir, `in-dialog-add-agent-${label}.png`) });

        const watchActiveBeforeBack = await page.evaluate(() => (window as any).__activeWatchIntervals());
        assert.ok(watchActiveBeforeBack >= 1, `${label}: choosing Claude inside modal must start scoped host-join watch`);

        // Run WCAG 2.2 AA axe-core check on the open dialog.
        const axeViolations = await page.evaluate(async () => {
          const dialog = document.querySelector("[data-roster-dialog]")!;
          const res = await (window as any).axe.run(dialog, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
          });
          return res.violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n: any) => n.html) }));
        });
        assert.deepEqual(axeViolations, [], `${label}: axe violations inside in-dialog Add an agent: ${JSON.stringify(axeViolations)}`);

        // 2. Click in-dialog Back ("People & agents") -> stays inside open dialog, returns to roster, stops watch, restores focus.
        await page.click("[data-roster-dialog] [data-ahp-home-back]");
        await page.waitForSelector("[data-roster-dialog] [data-people-page-add-agent]");
        const afterBack = await page.evaluate(() => {
          const dialog = document.querySelector<HTMLDialogElement>("[data-roster-dialog]")!;
          const choice = document.querySelector<HTMLElement>('[data-channel-view="agent-choice"]')!;
          return {
            modal: dialog.matches(":modal"),
            open: dialog.open,
            addAgentHostHidden: document.querySelector<HTMLElement>("[data-roster-add-agent]")?.hidden,
            choiceOutsideDialog: !dialog.contains(choice),
            choiceHidden: choice.hidden,
            activeWatchIntervals: (window as any).__activeWatchIntervals(),
            focusInsideDialog: dialog.contains(document.activeElement),
          };
        });
        assert.equal(afterBack.modal, true, `${label}: Back must keep dialog :modal`);
        assert.equal(afterBack.open, true, `${label}: Back must keep dialog open`);
        assert.equal(afterBack.addAgentHostHidden, true, `${label}: Back must hide add-agent host`);
        assert.equal(afterBack.choiceOutsideDialog, true, `${label}: Back must park agent-choice home`);
        assert.equal(afterBack.choiceHidden, true, `${label}: parked agent-choice must be hidden`);
        assert.equal(afterBack.activeWatchIntervals, 0, `${label}: Back must stop host-join watch`);
        assert.equal(afterBack.focusInsideDialog, true, `${label}: Back must keep focus inside dialog`);

        // 3. Re-open Add an agent -> Terminal -> Copy setup prompt stays inside dialog -> Back to Add an agent returns to choice inside dialog.
        await page.click("[data-roster-dialog] [data-people-page-add-agent]");
        await page.waitForSelector('[data-roster-dialog] details.hm-ahp__more > summary');
        await page.click("[data-roster-dialog] details.hm-ahp__more > summary");
        await page.click('[data-roster-dialog] button[data-ahp-host="terminal"]');
        await page.fill("[data-roster-dialog] [data-ahp-name]", "DialogCLI");
        await page.click("[data-roster-dialog] [data-ahp-mint]");
        await page.waitForSelector('[data-roster-dialog] [data-channel-view="connect"]:not([hidden])');
        const connectInside = await page.evaluate(() => {
          const dialog = document.querySelector<HTMLDialogElement>("[data-roster-dialog]")!;
          const connect = document.querySelector<HTMLElement>('[data-channel-view="connect"]')!;
          return {
            modal: dialog.matches(":modal"),
            connectInDialog: dialog.contains(connect),
            backText: document.querySelector<HTMLElement>("[data-close-connect-label]")?.textContent?.trim(),
          };
        });
        assert.equal(connectInside.modal, true, `${label}: Connect must stay in modal`);
        assert.equal(connectInside.connectInDialog, true, `${label}: Connect view must mount inside dialog`);
        assert.equal(connectInside.backText, "Back to Add an agent", `${label}: Connect back label must target Add an agent`);

        // Wait for the synthetic mint to settle into done state inside the modal before clicking Back.
        await page.waitForSelector('[data-roster-dialog] agent-connect[data-state="done"]');
        await page.click("[data-roster-dialog] [data-close-connect]");
        await page.waitForSelector('[data-roster-dialog] [data-channel-view="agent-choice"]:not([hidden])');

        // 4. Select Claude (starts watch), then press Escape -> closes modal, clears watch, parks views, restores URL & focus.
        await page.click('[data-roster-dialog] [data-ahp-host="claude"]');
        await page.waitForFunction(() => (window as any).__activeWatchIntervals() >= 1);
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => document.querySelector<HTMLDialogElement>("[data-roster-dialog]")?.open === false);
        const afterEscape = await page.evaluate(() => {
          const dialog = document.querySelector<HTMLDialogElement>("[data-roster-dialog]")!;
          const choice = document.querySelector<HTMLElement>('[data-channel-view="agent-choice"]')!;
          const active = document.activeElement as HTMLElement | null;
          return {
            open: dialog.open,
            url: location.pathname + location.search,
            choiceOutsideDialog: !dialog.contains(choice),
            choiceHidden: choice.hidden,
            activeWatchIntervals: (window as any).__activeWatchIntervals(),
            activeTag: active?.tagName ?? null,
            activeNotBody: !!active && active !== document.body,
          };
        });
        assert.equal(afterEscape.open, false, `${label}: Escape must close modal`);
        assert.equal(afterEscape.url, beforeUrl, `${label}: Escape must restore underlying URL`);
        assert.equal(afterEscape.choiceOutsideDialog, true, `${label}: Escape must park views home`);
        assert.equal(afterEscape.choiceHidden, true, `${label}: parked choice must stay hidden`);
        assert.equal(afterEscape.activeWatchIntervals, 0, `${label}: Escape must clear host-join watch`);
        assert.equal(afterEscape.activeNotBody, true, `${label}: Escape must restore focus to workspace control`);

        summary[label] = { ok: true, inModalState, afterBack, afterEscape };
      } finally {
        await context.close();
      }
    }

    // 5. Direct ?v=add-agent URL still works as full-page view cleanly.
    const directContext = await browser.newContext({ viewport: { width: 1024, height: 768 }, colorScheme: "dark" });
    const directPage = await directContext.newPage();
    try {
      await directPage.goto(`${origin}/app?w=${WS}&v=add-agent&theme=dark`, { waitUntil: "load" });
      await directPage.waitForSelector('[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-host="claude"]');
      const directState = await directPage.evaluate(() => {
        const dialog = document.querySelector<HTMLDialogElement>("[data-roster-dialog]")!;
        const app = document.querySelector<HTMLElement>("live-dashboard")!;
        const choice = document.querySelector<HTMLElement>('[data-channel-view="agent-choice"]')!;
        const backLabel = document.querySelector<HTMLElement>("[data-ahp-home-back-label]")?.textContent?.trim();
        return {
          dialogOpen: dialog.open,
          channelView: app.dataset.channelView,
          choiceOutsideDialog: !dialog.contains(choice),
          backLabel,
        };
      });
      assert.equal(directState.dialogOpen, false, "direct ?v=add-agent must not open roster dialog");
      assert.equal(directState.channelView, "agent-choice", "direct ?v=add-agent must show full-page agent-choice");
      assert.equal(directState.choiceOutsideDialog, true, "direct ?v=add-agent must keep agent-choice in page slot");
      assert.equal(directState.backLabel, "Home", "direct ?v=add-agent must keep Home back label");
      summary["direct-url"] = directState;
    } finally {
      await directContext.close();
    }

    await writeFile(join(evidenceDir, "summary.json"), JSON.stringify(summary, null, 2));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
