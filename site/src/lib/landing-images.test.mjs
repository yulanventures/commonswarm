import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { IMAGES, landingImage } from "./landing-images.ts";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const publicDir = join(site, "public");
const shipped = () => readdirSync(join(publicDir, "landing")).sort();

test("every homepage srcset file exists at its declared width and the picture's aspect ratio", async () => {
  const names = Object.keys(IMAGES);
  assert.ok(names.length >= 8, "the homepage uses at least eight product images");
  for (const name of names) {
    const { width, height } = IMAGES[name];
    const image = landingImage(name);
    for (const theme of ["light", "dark"]) {
      const entries = image.srcset[theme].split(", ").map((entry) => entry.split(" "));
      assert.ok(entries.length > 0, `${name} ${theme}: empty srcset`);
      for (const [url, descriptor] of entries) {
        const meta = await sharp(join(publicDir, url)).metadata();
        assert.equal(`${meta.width}w`, descriptor, `${url}: width ${meta.width} does not match ${descriptor}`);
        const ratio = meta.width / meta.height;
        assert.ok(Math.abs(ratio - width / height) / (width / height) < 0.01, `${url}: aspect ${ratio} is not ${width}/${height}`);
        assert.equal(meta.format, "webp", `${url}: not WebP`);
      }
      assert.ok(image.srcset[theme].includes(image.src[theme]), `${name} ${theme}: src is not one of the srcset files`);
    }
  }
});

test("the build script writes exactly the images the homepage uses, and nothing else is shipped", () => {
  const script = readFileSync(join(site, "scripts", "landing-shots.mjs"), "utf8");
  const declared = [...script.matchAll(/\{ name: "([a-z-]+)", shot: "[^"]+", crop: (?:null|\{[^}]*\}), widths: \[([0-9, ]+)\] \}/g)]
    .map((match) => [match[1], match[2].split(",").map((value) => Number(value.trim()))]);
  assert.deepEqual(
    Object.fromEntries(declared),
    Object.fromEntries(Object.entries(IMAGES).map(([name, { widths }]) => [name, [...widths]])),
    "scripts/landing-shots.mjs IMAGES and src/lib/landing-images.ts IMAGES must list the same names and widths",
  );
  const expected = Object.entries(IMAGES).flatMap(([name, { widths }]) =>
    ["dark", "light"].flatMap((theme) => widths.map((width) => `${name}-${theme}-${width}.webp`))).sort();
  assert.deepEqual(shipped(), expected, "public/landing holds an unused or missing file");
});

/* The two tests above trust the helper; this one reads what the built page actually references, so a URL written by
 * hand into a <picture>, or a helper bug, cannot pass. CI builds the site right before this suite. Locally a missing
 * or stale dist is a skip with the reason, never a silent pass on old output. */
const built = join(site, "dist", "index.html");
/* Any page, layout or component can change what the homepage renders, so the whole source tree counts, as in
 * consumer-copy.observer.mjs; tests and observers do not. */
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name);
  if (entry.isDirectory()) return walk(full);
  return /\.(astro|ts|mjs|js|md)$/.test(entry.name) && !/\.(observer|test)\.(mjs|ts)$/.test(entry.name) ? [full] : [];
});
const sources = [...walk(join(site, "src")), ...shipped().map((file) => join(publicDir, "landing", file))];
const staleReason = !existsSync(built)
  ? "no site/dist/index.html: run npm --prefix site run build"
  : sources.some((file) => statSync(file).mtimeMs > statSync(built).mtimeMs)
    ? "site/dist is older than the landing sources: run npm --prefix site run build"
    : "";

test("every image URL in the built homepage exists at the width its srcset declares, and every shipped file is used",
  { skip: staleReason && !process.env.CI ? staleReason : false }, async () => {
    assert.equal(staleReason, "", staleReason);
    const html = readFileSync(built, "utf8");
    const refs = new Map();
    for (const [, attribute, value] of html.matchAll(/\s(srcset|src)="([^"]*)"/g)) {
      const entries = attribute === "src" ? [value] : value.split(",").map((entry) => entry.trim()).filter(Boolean);
      for (const entry of entries) {
        const [url, descriptor = ""] = entry.split(/\s+/);
        if (url.startsWith("/landing/")) refs.set(`${url} ${descriptor}`, { url, descriptor });
      }
    }
    assert.ok(refs.size >= shipped().length, `the built homepage references ${refs.size} landing image entries`);
    for (const { url, descriptor } of refs.values()) {
      const file = join(publicDir, url);
      assert.ok(existsSync(file), `${url} is referenced but not shipped`);
      if (descriptor) assert.equal(`${(await sharp(file).metadata()).width}w`, descriptor, `${url}: srcset says ${descriptor}`);
    }
    const used = new Set([...refs.values()].map(({ url }) => url.slice("/landing/".length)));
    assert.deepEqual(shipped().filter((file) => !used.has(file)), [], "shipped landing files the built page never references");
    const pictures = [...html.matchAll(/<picture\b[\s\S]*?<\/picture>/g)].map(([markup]) => markup);
    assert.ok(pictures.length >= 9, `expected the homepage pictures, found ${pictures.length}`);
    const nameOf = (url) => (url.match(/^\/landing\/([a-z-]+?)-(?:light|dark)-\d+\.webp$/) ?? [])[1];
    for (const markup of pictures) {
      const img = markup.match(/<img\b[^>]*\ssrc="([^"]*)"[^>]*>/);
      assert.ok(img && img[1].startsWith("/landing/"), `a <picture> image does not load from /landing/: ${markup.slice(0, 160)}`);
      const name = nameOf(img[1]);
      assert.ok(name in IMAGES, `${img[1]} is not a known homepage image`);
      assert.match(img[0], new RegExp(`\\swidth="${IMAGES[name].width}"`), `${name}: img width is not ${IMAGES[name].width}`);
      assert.match(img[0], new RegExp(`\\sheight="${IMAGES[name].height}"`), `${name}: img height is not ${IMAGES[name].height}`);
      assert.match(img[0], /\salt="[^"]+"/, "every homepage image carries alt text");
      // A source that swaps in a different picture (art direction) must reserve that picture's own shape.
      for (const [source] of markup.matchAll(/<source\b[^>]*>/g)) {
        const url = (source.match(/\ssrcset="([^"\s,]+)/) ?? [])[1] ?? "";
        const other = nameOf(url);
        if (!other || other === name) continue;
        assert.match(source, new RegExp(`\\swidth="${IMAGES[other].width}"`), `${other}: <source> width is not ${IMAGES[other].width}`);
        assert.match(source, new RegExp(`\\sheight="${IMAGES[other].height}"`), `${other}: <source> height is not ${IMAGES[other].height}`);
      }
    }
  });
