import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// BRAND_ICONS_DIR holds the three PNGs by basename; used to prove the test fails on the old icons.
const dir = process.env.BRAND_ICONS_DIR;
const path = (name, sub) => (dir ? join(dir, name) : join(root, "public", sub, name));

// Coordinates are favicon grid units (32x32); `map` converts them to each icon's pixels.
const icons = [
  { name: "apple-touch-icon.png", size: 180, map: (u) => (u * 180) / 32, corner: "opaque" },
  { name: "app-icon-512.png", sub: "brand", size: 512, map: (u) => u * 16, corner: "clear" },
  { name: "app-icon-maskable-512.png", sub: "brand", size: 512, map: (u) => 256 + (u - 16) * 15, corner: "opaque" },
];
const CIRCLE = [12.16, 12.16]; // 4 + 8.16
const STROKE = [19.84, 25.56]; // bottom edge of the square, clear of the circle

async function load(icon) {
  const { data, info } = await sharp(path(icon.name, icon.sub ?? ""))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = (x, y) => {
    const i = (Math.round(y) * info.width + Math.round(x)) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  return { data, info, px };
}
const near = (got, hex) => {
  const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return want.every((v, i) => Math.abs(got[i] - v) <= 3);
};

for (const icon of icons) {
  test(`${icon.name} shows the current mark`, async () => {
    const { info, px } = await load(icon);
    assert.equal(info.width, icon.size);
    assert.equal(info.height, icon.size);
    const c = px(icon.map(CIRCLE[0]), icon.map(CIRCLE[1]));
    assert.ok(near(c, "#2471A8") && c[3] === 255, `circle centre ${c}`);
    const s = px(icon.map(STROKE[0]), icon.map(STROKE[1]));
    assert.ok(near(s, "#1E2A33") && s[3] === 255, `square stroke ${s}`);
    const corner = px(0, 0);
    if (icon.corner === "clear") assert.equal(corner[3], 0);
    else assert.ok(near(corner, "#FAF8F3") && corner[3] === 255, `corner ${corner}`);
  });
}

test("maskable icon keeps the whole mark inside the safe zone", async () => {
  const { info, data } = await load(icons[2]);
  let far = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      if (near([data[i], data[i + 1], data[i + 2]], "#FAF8F3")) continue;
      far = Math.max(far, Math.hypot(x + 0.5 - 256, y + 0.5 - 256));
    }
  }
  assert.ok(far > 100, "mark is present");
  assert.ok(far <= 204.8, `farthest mark pixel ${far}`);
});

test("generator uses the current colours and none of the old ones", () => {
  const src = readFileSync(join(root, "scripts", "brand-icons.mjs"), "utf8").toLowerCase();
  for (const c of ["#2471a8", "#1e2a33"]) assert.ok(src.includes(c), c);
  for (const c of ["#b8adf2", "#f3b89d", "#aacbb7", "#315cff"]) assert.ok(!src.includes(c), c);
});
