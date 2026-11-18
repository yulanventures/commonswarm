// /app's startup screen on a phone: one calm mark and one line in the middle, nothing wider than the screen.
// Source checks; the picture is taken by the mobile audit in CI.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dashboard = readFileSync(new URL("../src/components/app/LiveDashboard.astro", import.meta.url), "utf8");
const recovery = readFileSync(new URL("../src/styles/kylon-chat-empty.css", import.meta.url), "utf8");
const rule = (source, selector) => {
  const at = source.indexOf(`${selector} {`);
  assert.notEqual(at, -1, selector);
  return source.slice(at, source.indexOf("}", at));
};

test("the loading panel holds the mark and one live line, and no row of placeholders", () => {
  const start = dashboard.indexOf('<section class="dashboard__loading"');
  const panel = dashboard.slice(start, dashboard.indexOf("</section>", start));
  assert.match(panel, /data-panel="loading" role="status" aria-live="polite" aria-busy="true"/);
  assert.match(panel, /<span class="dashboard__loading-mark" aria-hidden="true"><Wordmark markOnly markSize=\{44\} \/><\/span>\s*<span data-loading-label>Opening CommonSwarm…<\/span>/);
  assert.doesNotMatch(panel, /Skeleton|dashboard__spinner/);
});

test("the loading panel is a centred column sized by the small viewport, clear of the safe areas", () => {
  const panel = rule(dashboard, "  .dashboard__loading");
  // 100svh, not dvh or vh: the mark must not move when a phone's address bar slides away.
  assert.match(panel, /min-block-size: 100svh;/);
  assert.match(panel, /flex-direction: column;[\s\S]*align-items: center;[\s\S]*justify-content: center;/);
  for (const side of ["top", "right", "bottom", "left"]) assert.match(panel, new RegExp(`env\\(safe-area-inset-${side}\\)`));
  assert.match(panel, /box-sizing: border-box;/, "padding must not make the panel taller than the screen");
});

test("the mark's pulse stops for people who ask for less motion", () => {
  assert.match(rule(dashboard, "  .dashboard__loading-mark"), /animation: dashboard-breathe/);
  assert.match(dashboard, /@media \(prefers-reduced-motion: reduce\) \{\s*\.dashboard__loading-mark \{\s*animation: none;\s*\}/);
  assert.doesNotMatch(dashboard, /dashboard-spin\b/);
});

test("the recovery screen spans the screen, with its content in a centred column", () => {
  const start = recovery.indexOf("The recovery screen paints its own background");
  const block = recovery.slice(start, recovery.indexOf("}", start));
  assert.match(block, /inline-size: auto;[\s\S]*margin-inline: 0;[\s\S]*grid-template-columns: minmax\(0, 42rem\);[\s\S]*justify-content: center;/);
  for (const side of ["top", "right", "bottom", "left"]) assert.match(block, new RegExp(`env\\(safe-area-inset-${side}\\)`));
});
