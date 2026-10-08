import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");
const dashboard = readFileSync(join(componentDir, "LiveDashboard.astro"), "utf8");
const builtAppPath = join(siteRoot, "dist", "app", "index.html");
const style = dashboard.match(/<style\b[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? "";
const declarations = style.replace(/\/\*[\s\S]*?\*\//g, "");

test("the dashboard consumes the shared site tokens without a local colour system", () => {
  assert.match(dashboard, /import "\.\.\/\.\.\/styles\/tokens\.css"/);
  for (const token of [
    "--bg",
    "--bg-raised",
    "--surface",
    "--text",
    "--text-muted",
    "--text-faint",
    "--border",
    "--border-strong",
    "--border-interactive",
    "--accent",
    "--accent-dim",
    "--accent-ink",
    "--success",
    "--warning",
    "--danger",
  ]) {
    assert.ok(style.includes(`var(${token})`), `dashboard CSS does not consume ${token}`);
  }
  assert.doesNotMatch(
    declarations,
    /#[0-9a-f]{3,8}\b/i,
    "a raw hex declaration would leave part of the dashboard outside the shared scheme",
  );
  assert.doesNotMatch(declarations, /--dashboard-(?:field|panel|rail-field|ink|muted|faint|line|direct)\s*:/);
  assert.doesNotMatch(declarations, /color-scheme:\s*light\b/);
});

test("the emitted dashboard CSS carries the token system's light and dark paths", {
  skip: !process.env.CI && !existsSync(builtAppPath) ? "site/dist is absent; compiled CSS verification runs after the CI build" : false,
}, () => {
  const appHtml = readFileSync(builtAppPath, "utf8");
  const assetPaths = Array.from(
    appHtml.matchAll(/(?:src|href)="\/(_astro\/[^"?#]+\.(?:js|css))/g),
    (match) => match[1]!,
  );
  const builtAssets = assetPaths
    .map((assetPath) => readFileSync(join(siteRoot, "dist", assetPath), "utf8"))
    .join("\n");
  assert.ok(assetPaths.length > 0, "the built app must reference emitted assets");
  assert.match(builtAssets, /--elev-0:/);
  // The signed-in app paints the home canvas (neutral household palette); that token has a light value and a
  // dark value mapped by both dark branches, so the dashboard background follows the scheme.
  assert.match(builtAssets, /\.dashboard\{[^}]*background:var\(--home-canvas\)/);
  assert.match(builtAssets, /--home-canvas:\s*#ffffff/i);
  assert.match(builtAssets, /--d-home-canvas:\s*#1b1d20/i);
  assert.match(builtAssets, /:root:not\(\[data-theme=light\]\)\{[^}]*--home-canvas:\s*var\(--d-home-canvas\)/, "the OS dark branch maps the canvas");
  assert.match(builtAssets, /\[data-theme=dark\]\{[^}]*--home-canvas:\s*var\(--d-home-canvas\)/, "the forced dark branch maps the canvas");
  assert.match(builtAssets, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(builtAssets, /:root:not\(\[data-theme=light\]\)/);
  assert.match(builtAssets, /\[data-theme=dark\]/);
});
