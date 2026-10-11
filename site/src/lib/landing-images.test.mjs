import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { LANDING_IMAGES, landingImage } from "./landing-images.ts";

const site = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const publicDir = join(site, "public");

test("every homepage srcset file exists at its declared width and the picture's aspect ratio", async () => {
  assert.ok(LANDING_IMAGES.length >= 8, "the homepage uses at least eight product images");
  for (const { name, width, height } of LANDING_IMAGES) {
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
    Object.fromEntries(LANDING_IMAGES.map(({ name, widths }) => [name, [...widths]])),
    "scripts/landing-shots.mjs IMAGES and src/lib/landing-images.ts IMAGES must list the same names and widths",
  );
  const expected = LANDING_IMAGES.flatMap(({ name, widths }) =>
    ["dark", "light"].flatMap((theme) => widths.map((width) => `${name}-${theme}-${width}.webp`))).sort();
  assert.deepEqual(readdirSync(join(publicDir, "landing")).sort(), expected, "public/landing holds an unused or missing file");
});
