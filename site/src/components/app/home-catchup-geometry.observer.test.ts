import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
import { homeFixture } from "./home-fixture.js";

type Geometry = {
  width: number;
  overflow: boolean;
  touchTargets: boolean;
  hostileElements: number;
  hostileText: boolean;
  subline: string;
  loadingBusy: boolean;
  loadingName: string;
  workspaceFacts: string;
  failedCopy: boolean;
  latestHeading: string;
  needsYouCards: number;
  showMoreLabel: string | null;
  showMoreExpanded: string | null;
  showMoreControls: string | null;
  expandedNeedsYouCards: number;
  sinceLastLookedCopy: string | null;
  sampleActions: number;
  sampleLinks: number;
};

test("Catch up geometry keeps 44px targets and hostile text as plain text", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-catchup-geometry-"));
  const fixture = join(directory, "index.html");
  try {
    await writeFile(fixture, await homeFixture({
      entryPoint: "src/lib/home-catchup.ts",
      globalName: "CatchUp",
      body: '<main id="mount"></main><main id="sample"></main>',
      script: `
      (async () => {
        const hostile = '<img src=x onerror="document.title=1">';
        const person = (id, firstName, you = false) => ({ id, name: firstName + hostile, firstName, initials: firstName[0], you, role: "member" });
        const capsule = (personId, firstName, you = false) => ({ person: person(personId, firstName, you), agents: [] });
        const needsYou = (id, workspaceId) => ({
          id, kind: "ask",
          workspace: { id: workspaceId, name: workspaceId, href: "?w=" + workspaceId },
          from: person("claude", "Claude"), what: hostile, when: "7:40 am",
          primary: { label: "Reply", action: "reply" },
        });
        const vm = {
          sample: false,
          viewerFirstName: "Tom",
          now: "2026-10-05T09:00:00",
          needsYou: ["a", "b", "c", "d", "e"].map((id) => needsYou(id, "paper")),
          workspaces: [
            { id: "home", name: "Home", href: "?w=home", peopleSummary: "You and Nikki", capsules: [capsule("t", "Tom", true), capsule("n", "Nikki")],
              openTodos: 4, lists: 3, files: 3, agentsNeedingAttention: 0, newMessagesSinceLastLooked: 3, state: "ready" },
            { id: "trip", name: "Summer trip", href: "?w=trip", peopleSummary: "You and Nikki", capsules: [capsule("t", "Tom", true)],
              openTodos: null, lists: null, files: null, agentsNeedingAttention: 1, newMessagesSinceLastLooked: null, state: "ready" },
            { id: "broken", name: "Launch crew", href: "?w=crew", peopleSummary: "Just you", capsules: [],
              openTodos: null, lists: null, files: null, agentsNeedingAttention: 0, newMessagesSinceLastLooked: null, state: "failed" },
            { id: "loading", name: "My paperwork", href: "?w=paper", peopleSummary: "Just you", capsules: [],
              openTodos: null, lists: null, files: null, agentsNeedingAttention: 0, newMessagesSinceLastLooked: null, state: "loading" },
          ],
          latest: [
            { id: "1", authorLabel: "Your Claude", workspace: { name: "Home", href: "?w=home" }, excerpt: hostile, when: "8:12 am" },
            { id: "2", authorLabel: "Muse", workspace: { name: "Summer trip", href: "?w=trip" }, excerpt: "Plans?", when: "7:40 am" },
          ],
        };
        let needsYouExpanded = false;
        const callbacks = {
          onNeedsYouAction: () => {},
          onShowMoreNeedsYou: () => { needsYouExpanded = true; },
        };
        const root = CatchUp.renderCatchUp(document, vm, callbacks);
        document.getElementById("mount").append(root);
        const showMoreButton = root.querySelector(".hm-catchup-show-more");
        if (showMoreButton) showMoreButton.click();
        const visibleTargets = [...root.querySelectorAll("button, a")].filter((el) => el.getClientRects().length);
        const touchTargets = visibleTargets.length > 0 && visibleTargets.every((el) => {
          const box = el.getBoundingClientRect();
          return box.height >= 44 && box.width >= 44;
        });
        const loadingCard = root.querySelector('[data-workspace-id="loading"]');
        const showMore = root.querySelector(".hm-catchup-show-more");
        const homeCard = root.querySelector('[data-workspace-id="home"]');
        const collapsedMetrics = {
          width: innerWidth,
          overflow: root.scrollWidth > root.clientWidth,
          touchTargets,
          hostileElements: document.querySelectorAll("img").length,
          hostileText: root.textContent.includes(hostile),
          subline: root.querySelector(".hm-catchup-subline").textContent,
          loadingBusy: loadingCard.getAttribute("aria-busy") === "true",
          // This card has only its visible title/status; its name must contain
          // those words together, without a conflicting replacement label.
          loadingName: loadingCard.getAttribute("aria-label") ?? loadingCard.innerText.replace(/\\s+/g, " ").trim(),
          workspaceFacts: homeCard.textContent,
          failedCopy: root.querySelector('[data-workspace-id="broken"]').textContent.includes("Couldn't load Launch crew"),
          latestHeading: root.querySelector("#hm-catchup-latest-title").textContent,
          needsYouCards: root.querySelectorAll(".hm-needs-you").length,
          showMoreLabel: showMore ? showMore.textContent : null,
          showMoreExpanded: showMore ? showMore.getAttribute("aria-expanded") : null,
          showMoreControls: showMore ? showMore.getAttribute("aria-controls") : null,
          sinceLastLookedCopy: homeCard.querySelector(".hm-catchup-card-since")?.textContent ?? null,
        };
        const expandedRoot = CatchUp.renderCatchUp(document, { ...vm, needsYouExpanded: needsYouExpanded }, callbacks);
        document.getElementById("mount").replaceChildren(expandedRoot);
        const expandedNeedsYouCards = expandedRoot.querySelectorAll(".hm-needs-you").length;
        const sampleRoot = CatchUp.renderCatchUp(document, { ...vm, sample: true }, callbacks);
        document.getElementById("sample").append(sampleRoot);
        const metrics = {
          ...collapsedMetrics,
          expandedNeedsYouCards,
          sampleActions: sampleRoot.querySelectorAll("button").length,
          sampleLinks: sampleRoot.querySelectorAll("a").length,
        };
        document.documentElement.dataset.metrics = btoa(unescape(encodeURIComponent(JSON.stringify(metrics))));
      })();
      `,
    }), "utf8");
    const chrome = await findChrome();
    for (const width of [390]) {
      const { stdout } = await launchChrome(chrome, [
        "--allow-file-access-from-files",
        `--window-size=${width},900`,
        "--dump-dom",
        `file://${fixture}`,
      ], { maxBuffer: 10 * 1024 * 1024, timeout: 15_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(encoded, `the catch up builder must finish at ${width}px`);
      const geometry = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Geometry;

      assert.equal(geometry.hostileElements, 0);
      assert.equal(geometry.hostileText, true);

      assert.equal(geometry.sampleActions, 0, "sample mode must render no buttons");
      assert.equal(geometry.sampleLinks, 0, "sample mode must render no links");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
