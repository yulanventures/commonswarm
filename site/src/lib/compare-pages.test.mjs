import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const siteRoot = resolve(import.meta.dirname, "../..");

const comparePages = [
  {
    file: "src/pages/compare/reason-machines.astro",
    route: "/compare/reason-machines",
    requiredCitations: [
      "https://reasonmachines.com/",
      "https://reasonmachines.com/network",
      "https://reasonmachines.com/grokbot",
      "9 November 2026",
    ],
    coexistenceHeading: "Running both together",
  },
  {
    file: "src/pages/compare/codeman.astro",
    route: "/compare/codeman",
    requiredCitations: [
      "https://github.com/Ark0N/Codeman",
      "9 November 2026",
    ],
    coexistenceHeading: "How they work together",
  },
  {
    file: "src/pages/compare/microsoft-agent-365.astro",
    route: "/compare/microsoft-agent-365",
    requiredCitations: [
      "https://learn.microsoft.com/en-us/microsoft-agent-365/overview",
      "https://learn.microsoft.com/en-us/microsoft-365/admin/manage/agent-registry",
      "9 November 2026",
    ],
    coexistenceHeading: "Coexistence in organizations",
  },
];

test("compare pages cite primary sources checked 9 November 2026, include Waiting on you preview, and keep coexistence framing", async () => {
  for (const page of comparePages) {
    const source = await readFile(resolve(siteRoot, page.file), "utf8");
    assert.ok(source.includes(`const path = "${page.route}"`), `${page.file} must declare ${page.route}`);
    assert.ok(source.includes("<SeoPage"), `${page.file} must use SeoPage layout`);
    assert.ok(source.includes("<WaitingOnYouPreview"), `${page.file} must render WaitingOnYouPreview`);
    assert.ok(source.includes(page.coexistenceHeading), `${page.file} must include coexistence section`);
    for (const citation of page.requiredCitations) {
      assert.ok(source.includes(citation), `${page.file} missing citation: ${citation}`);
    }
  }
});

test("compare pages are linked in SiteFooter and never inside /app", async () => {
  const footer = await readFile(resolve(siteRoot, "src/components/SiteFooter.astro"), "utf8");
  for (const page of comparePages) {
    assert.ok(footer.includes(`href: "${page.route}"`), `SiteFooter must link ${page.route}`);
  }

  for (const appFile of ["src/pages/app.astro", "src/components/app/LiveDashboard.astro"]) {
    const appSource = await readFile(resolve(siteRoot, appFile), "utf8");
    assert.equal(appSource.includes("/compare/"), false, `${appFile} must not link to /compare/`);
  }
});
