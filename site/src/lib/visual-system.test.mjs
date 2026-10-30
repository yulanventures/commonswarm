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
