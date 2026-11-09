import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("shell tokens define canonical primary accent and 16px dialog radius (D14, D17)", async () => {
  const tokens = await readFile(new URL("../styles/kylon-tokens.css", import.meta.url), "utf8");
  assert.match(tokens, /--k-shell-accent:\s*#697344;/u);
  assert.match(tokens, /--k-shell-accent-hover:\s*#535d33;/u);
  assert.match(tokens, /--k-shell-accent-ink:\s*#ffffff;/u);
  assert.match(tokens, /--k-shell-dialog-radius:\s*16px;/u);

  const layoutTokens = await readFile(new URL("../styles/kylon-layout/tokens.css", import.meta.url), "utf8");
  assert.match(layoutTokens, /--cs-accent:\s*var\(--k-shell-accent,\s*#697344\);/u);
  assert.match(layoutTokens, /--cs-accent-hover:\s*var\(--k-shell-accent-hover,\s*#535d33\);/u);
  assert.match(layoutTokens, /--cs-on-accent:\s*var\(--k-shell-accent-ink,\s*#ffffff\);/u);
});

test("primary buttons across Lists, Invite, New workspace, and Welcome share --k-shell-accent (D14)", async () => {
  const lists = await readFile(new URL("../styles/kylon-lists.css", import.meta.url), "utf8");
  assert.match(lists, /--accent:\s*var\(--k-shell-accent\);/u);
  assert.doesNotMatch(lists, /#697344/u);

  const onboarding = await readFile(new URL("../styles/kylon-onboarding.css", import.meta.url), "utf8");
  assert.match(onboarding, /--home-accent:\s*var\(--k-shell-accent\);/u);
  assert.match(onboarding, /background:\s*var\(--k-shell-accent\);/u);

  const newWorkspace = await readFile(new URL("../styles/kylon-new-workspace.css", import.meta.url), "utf8");
  assert.match(newWorkspace, /--home-accent:\s*var\(--k-shell-accent\);/u);
  assert.match(newWorkspace, /--home-accent-hover:\s*var\(--k-shell-accent-hover\);/u);

  const welcome = await readFile(new URL("../styles/kylon-welcome.css", import.meta.url), "utf8");
  assert.match(welcome, /--accent:\s*var\(--k-shell-accent\);/u);
  assert.doesNotMatch(welcome, /#697344/u);
});

test("setup checklist, workspace-error, and feed states use Kylon shell type and accent (D13)", async () => {
  const chatEmpty = await readFile(new URL("../styles/kylon-chat-empty.css", import.meta.url), "utf8");
  assert.match(chatEmpty, /\[data-panel="workspace-error"\]/u);
  assert.match(chatEmpty, /\[data-setup-checklist\]/u);
  assert.match(chatEmpty, /\[data-channel-view="feed-pending"\]/u);
  assert.match(chatEmpty, /\[data-channel-view="feed-error"\]/u);
  assert.match(chatEmpty, /\[data-setup-checklist\]\s+\.dashboard__eyebrow[\s\S]*?text-transform:\s*none;/u);
});

test("dialogs use 16px radius, menu group labels are sentence-cased, and welcome/lists type stays on scale (D17)", async () => {
  const accountDialogs = await readFile(new URL("../styles/kylon-account-dialogs.css", import.meta.url), "utf8");
  assert.match(accountDialogs, /border-radius:\s*var\(--k-shell-dialog-radius,\s*16px\);/u);
  assert.doesNotMatch(accountDialogs, /border-radius:\s*12px;/u);

  const homeShell = await readFile(new URL("../styles/home/shell.css", import.meta.url), "utf8");
  assert.match(homeShell, /\.hm-menu__group-label\s*\{[^}]*text-transform:\s*none;/u);
  assert.doesNotMatch(homeShell, /\.hm-menu__group-label\s*\{[^}]*text-transform:\s*uppercase;/u);

  const welcome = await readFile(new URL("../styles/kylon-welcome.css", import.meta.url), "utf8");
  assert.doesNotMatch(welcome, /font-size:\s*32px;/u);

  const lists = await readFile(new URL("../styles/kylon-lists.css", import.meta.url), "utf8");
  assert.doesNotMatch(lists, /10px\/1/u);
});

test("homepage preloads Bricolage Grotesque and DM Sans, sets root attributes early, and avoids font-display swap snap", async () => {
  const base = await readFile(new URL("../layouts/Base.astro", import.meta.url), "utf8");
  assert.match(base, /isHome\s*\?\s*\["\/fonts\/bricolage-grotesque-latin\.woff2",\s*"\/fonts\/dm-sans-latin\.woff2"\]/u);
  assert.match(base, /data-home=\{isHome \? "" : undefined\}/u);
  assert.match(base, /data-marketing=\{!isAppShell \? "" : undefined\}/u);

  const globalCss = await readFile(new URL("../styles/global.css", import.meta.url), "utf8");
  assert.doesNotMatch(globalCss, /font-display:\s*swap;/u);
  assert.match(globalCss, /font-family:\s*"Bricolage Grotesque";[\s\S]*?font-display:\s*block;/u);
  assert.match(globalCss, /font-family:\s*"DM Sans";[\s\S]*?font-display:\s*block;/u);
  assert.match(globalCss, /font-family:\s*"Bricolage Grotesque Fallback";/u);
  assert.match(globalCss, /font-family:\s*"DM Sans Fallback";/u);

  const landingCss = await readFile(new URL("../styles/landing.css", import.meta.url), "utf8");
  assert.match(landingCss, /:root:is\(\[data-home\],\s*:has\(main \.lp-home\)\)/u);
  assert.match(landingCss, /--font-display:\s*"Bricolage Grotesque",\s*"Bricolage Grotesque Fallback"/u);
  assert.match(landingCss, /\.lp-home\s+:is\(h1,h2,h3\)\s*\{\s*font-family:\s*var\(--font-display\);/u);
});

test("app loading and empty surfaces share status live regions and Skeleton, EmptyState, and Toast primitives (D18)", async () => {
  const appPage = await readFile(new URL("../pages/app.astro", import.meta.url), "utf8");
  assert.match(appPage, /import Toast from "\.\.\/components\/ui\/Toast\.astro";/u);
  assert.match(appPage, /<Toast \/>/u);

  const dashboard = await readFile(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  assert.match(dashboard, /import EmptyState from "\.\.\/ui\/EmptyState\.astro";/u);
  assert.match(dashboard, /import Skeleton from "\.\.\/ui\/Skeleton\.astro";/u);
  assert.match(
    dashboard,
    /data-channel-view="feed-pending"[\s\S]*?role="status"[\s\S]*?aria-live="polite"[\s\S]*?aria-busy="true"/u,
  );
  assert.match(dashboard, /<EmptyState[\s\S]*?data-feed-empty-title[\s\S]*?data-feed-empty-detail/u);

  const homeTodo = await readFile(new URL("./home-todo.ts", import.meta.url), "utf8");
  assert.match(homeTodo, /hm-todo-skeleton/u);
  assert.match(homeTodo, /skeleton skeleton--text/u);
});

test("new-workspace form shows the purpose question visibly, keeps both option details visible, and preselects shared by default (D8)", async () => {
  const newWorkspace = await readFile(new URL("./home-new-workspace.ts", import.meta.url), "utf8");
  assert.match(newWorkspace, /purposeLegend\.className = "hm-new-workspace__label";/u);
  assert.doesNotMatch(newWorkspace, /purposeLegend\.className = "visually-hidden";/u);
  assert.match(newWorkspace, /for \(const line of details\) line\.hidden = false;/u);

  const dashboard = await readFile(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  assert.match(
    dashboard,
    /purpose:\s*\(previousPurpose === "personal"\s*\?\s*"personal"\s*:\s*"shared"\)\s*as HouseholdPurpose/u,
  );
});

test("workspace chat composer spans the column and workspace switching paints shell and skeleton immediately", async () => {
  const composerCss = await readFile(new URL("../styles/kylon-composer.css", import.meta.url), "utf8");
  assert.doesNotMatch(composerCss, /calc\(100%\s*-\s*980px\)/u);
  assert.match(composerCss, /padding:\s*8px 20px calc\(8px \+ env\(safe-area-inset-bottom\)\);/u);

  const dashboard = await readFile(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  assert.match(dashboard, /data-feed-skeleton/u);
  assert.match(dashboard, /dashboard__feed-skeleton-row/u);
  assert.doesNotMatch(dashboard, /Opening the live channel…/u);
  assert.match(
    dashboard,
    /if \(keepShell\) \{\s*renderChannel\(selected, true\);\s*renderHomeShell\(\);\s*renderHomeSide\(\);/u,
  );
  assert.match(dashboard, /const claimsRead = homeWorkingOn\(selected\.id\);/u);
});

test("dark mode lifts surface off black, softens text contrast, and steps column backgrounds while keeping WCAG AA and light mode unchanged", async () => {
  const carbon = await readFile(new URL("../styles/carbon-theme.css", import.meta.url), "utf8");
  const kylonTokens = await readFile(new URL("../styles/kylon-tokens.css", import.meta.url), "utf8");
  const integration = await readFile(new URL("../styles/kylon-layout/integration.css", import.meta.url), "utf8");
  const channel = await readFile(new URL("../styles/kylon-channel.css", import.meta.url), "utf8");
  const entityProfile = await readFile(new URL("../styles/kylon-entity-profile.css", import.meta.url), "utf8");

  // Light mode tokens stay untouched.
  assert.match(carbon, /--k-shell-surface:\s*#ffffff;/u);
  assert.match(carbon, /--k-shell-subtle:\s*#f4f4f5;/u);
  assert.match(carbon, /--k-shell-selected:\s*#e4e4e7;/u);
  assert.match(carbon, /--k-shell-ink:\s*#09090b;/u);

  // Dark mode uses a background lighter than #0a0a0b black, softer ink than #fafafa, and distinct column steps.
  assert.doesNotMatch(carbon, /--k-shell-dark-surface:\s*#0a0a0b;/u);
  assert.doesNotMatch(carbon, /--k-shell-dark-ink:\s*#fafafa;/u);
  assert.match(carbon, /--k-shell-dark-rail-deep:\s*#111317;/u);
  assert.match(carbon, /--k-shell-dark-rail:\s*#14161b;/u);
  assert.match(carbon, /--k-shell-dark-side:\s*#15171c;/u);
  assert.match(carbon, /--k-shell-dark-surface:\s*#191b20;/u);
  assert.match(carbon, /--k-shell-dark-subtle:\s*#20232a;/u);
  assert.match(carbon, /--k-shell-dark-selected:\s*#282c35;/u);
  assert.match(carbon, /--k-shell-dark-ink:\s*#e4e6eb;/u);
  assert.match(carbon, /--k-shell-dark-secondary:\s*#a0a6b2;/u);
  assert.match(carbon, /--k-shell-dark-muted:\s*#8d94a2;/u);
  assert.match(carbon, /--k-shell-dark-control:\s*#9ba1ae;/u);

  // Column tokens map in both dark branches and bridge to the four columns.
  assert.match(kylonTokens, /--k-shell-rail-deep:\s*var\(--k-shell-dark-rail-deep\);/u);
  assert.match(kylonTokens, /--k-shell-rail:\s*var\(--k-shell-dark-rail\);/u);
  assert.match(kylonTokens, /--k-shell-side:\s*var\(--k-shell-dark-side\);/u);
  assert.match(integration, /--home-rail-bg:\s*var\(--k-shell-rail,\s*var\(--k-shell-subtle\)\);/u);
  assert.match(integration, />\s*:is\(\.cs-org-rail,\s*\.cs-org-rail-account\)\s*\{\s*background:\s*var\(--k-shell-rail-deep,\s*var\(--cs-rail-bg\)\);/u);
  assert.match(channel, /\.hm-frame\s+:is\(\.hm-frame__side,\s*\.hm-frame__profile\)\s*\{\s*background:\s*var\(--k-shell-side,\s*var\(--k-shell-surface\)\);/u);
  assert.match(entityProfile, /\[data-entity-panel\]\s*\{\s*background:\s*var\(--k-shell-side,\s*var\(--k-shell-surface\)\);/u);

  // Verify WCAG 2.1 AA contrast (>= 4.5:1 text, >= 3:1 controls) across all stepped dark surfaces.
  const luminance = (hex) => {
    const rgb = hex.slice(1).match(/../gu).map((x) => parseInt(x, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const contrast = (a, b) => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  for (const bg of ["#111317", "#14161b", "#15171c", "#191b20", "#20232a", "#282c35"]) {
    for (const fg of ["#e4e6eb", "#a0a6b2", "#8d94a2"]) {
      assert.ok(contrast(fg, bg) >= 4.5, `expected >= 4.5:1 contrast for ${fg} on ${bg}, got ${contrast(fg, bg).toFixed(2)}`);
    }
    assert.ok(contrast("#9ba1ae", bg) >= 3.0, `expected >= 3.0:1 control contrast on ${bg}`);
  }
});
