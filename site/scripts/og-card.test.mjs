import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import sharp from "sharp";
import { LANDING_COPY } from "../src/lib/landing-copy.ts";

// Protect the published asset and metadata boundary: a copy edit without PNG
// regeneration, or an alt tag retaining the previous promise, must fail here.
// The fingerprint avoids comparing font pixels produced by different platforms.
const decode = (text) => text.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const text = (markup) => decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const headline = LANDING_COPY.headline.join(" ");
const lede = LANDING_COPY.lede.join(" ");
let source;
const svgSource = () => source ??= (async () => {
  const dir = await mkdtemp(join(tmpdir(), "commonswarm-og-"));
  try {
    const svg = join(dir, "card.svg");
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL("./og-card.mjs", import.meta.url)), svg]);
    return await readFile(svg, "utf8");
  } finally { await rm(dir, { recursive: true, force: true }); }
})();

test("the shipped social card uses the live homepage copy and was regenerated from its current source", async () => {
  const svg = await svgSource();
  const visible = Array.from(svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g), ([, value]) => text(value));
  assert.ok(visible.includes(headline), "the visible card headline matches the homepage");
  assert.ok(visible.includes(lede), "the visible card lede matches the homepage");
  const description = text(svg.match(/<desc>([\s\S]*?)<\/desc>/)?.[1] ?? "");
  assert.ok(description.includes(headline) && description.includes(lede), "the image description includes its actual headline and lede");
  const png = await sharp(fileURLToPath(new URL("../public/og.png", import.meta.url))).metadata();
  assert.deepEqual([png.format, png.width, png.height], ["png", 1200, 630]);
  assert.equal(png.xmpAsString?.match(/cs:sourceSha256="([a-f0-9]{64})"/)?.[1], createHash("sha256").update(svg).digest("hex"),
    "og.png is stale: regenerate it with node scripts/og-card.mjs and inspect the image");
});

test("the built homepage publishes matching Open Graph and Twitter image descriptions", async (t) => {
  let html;
  try { html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8"); }
  catch (error) { if (error.code === "ENOENT") { t.skip("site build required; CI builds before this suite"); return; } throw error; }
  const description = text((await svgSource()).match(/<desc>([\s\S]*?)<\/desc>/)?.[1] ?? "");
  const meta = (name) => {
    const tag = Array.from(html.matchAll(/<meta\b[^>]*>/g), ([value]) => value)
      .find(value => new RegExp(`(?:name|property)=["']${name}["']`).test(value));
    return decode(tag?.match(/content="([^"]*)"/)?.[1] ?? "");
  };
  assert.equal(meta("og:image:alt"), description);
  assert.equal(meta("twitter:image:alt"), description);
  assert.ok(meta("og:image").endsWith("/og.png"));
  assert.equal(meta("twitter:image"), meta("og:image"));
});
