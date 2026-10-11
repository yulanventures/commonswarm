#!/usr/bin/env node
/**
 * Builds the homepage product images (public/landing/*.webp) from screenshots of the real app.
 *
 * The screenshots come from the home visual harness (CSwarm Lead "Home UI"): `astro dev` of this site with a mocked
 * backend and the curated marketing world (sample people Maya and Jordan, their agents Wren and Gale), shot by headless
 * Playwright Chromium at a device scale factor of 2. Shoot command, from the harness folder:
 *
 *   SHOOT_BASE=http://127.0.0.1:<dev port> ./shoot.sh <run> MHomeTall,MPhone,MLaunch,MPhoneNew,MPhoneAddAgent \
 *     --states marketing --themes dark,light
 *
 * Usage: node scripts/landing-shots.mjs <run>   (<run> holds dark/ and light/ folders of <id>-screen-<width>.png)
 *
 * Crops are in CSS pixels of the shot (the PNGs are 2x); boxes were measured from the app's own elements.
 * Every visible word in these images is sample content; keep it true to what the product does (see STRINGS.md of the lane).
 * The WebP files are the shipping artifacts: open and inspect them after every regeneration.
 */

import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = process.argv[2];
if (!run) {
  console.error("usage: node scripts/landing-shots.mjs <harness run folder with dark/ and light/>");
  process.exit(2);
}

const SCALE = 2;
/** name: output stem; shot: harness file; crop: CSS px box or null for the whole shot; widths: output pixel widths. */
const IMAGES = [
  { name: "home", shot: "MHomeTall-screen-1440.png", crop: null, widths: [2400, 1600, 960] },
  { name: "phone", shot: "MPhone-screen-390.png", crop: null, widths: [720, 400] },
  { name: "step-open", shot: "MPhoneNew-screen-390.png", crop: { x: 0, y: 182, w: 390, h: 400 }, widths: [720, 400] },
  { name: "step-connect", shot: "MPhoneAddAgent-screen-390.png", crop: { x: 0, y: 392, w: 390, h: 400 }, widths: [720, 400] },
  { name: "step-steer", shot: "MPhone-screen-390.png", crop: { x: 0, y: 444, w: 390, h: 400 }, widths: [720, 400] },
  { name: "life-todos", shot: "MHomeTall-screen-1440.png", crop: { x: 1141, y: 20, w: 279, h: 310 }, widths: [558] },
  { name: "life-lists", shot: "MHomeTall-screen-1440.png", crop: { x: 1141, y: 346, w: 279, h: 230 }, widths: [558] },
  { name: "work-stream", shot: "MLaunch-screen-1440.png", crop: { x: 257, y: 140, w: 743, h: 630 }, widths: [1486, 760] },
  { name: "trust-shared", shot: "MHomeTall-screen-1440.png", crop: { x: 1141, y: 838, w: 279, h: 146 }, widths: [558] },
];

const outDir = join(root, "public", "landing");
await mkdir(outDir, { recursive: true });
let total = 0;
for (const theme of ["dark", "light"]) {
  for (const image of IMAGES) {
    const source = join(run, theme, image.shot);
    const meta = await sharp(source).metadata();
    const box = image.crop
      ? { left: image.crop.x * SCALE, top: image.crop.y * SCALE, width: image.crop.w * SCALE, height: image.crop.h * SCALE }
      : { left: 0, top: 0, width: meta.width, height: meta.height };
    if (box.left + box.width > meta.width || box.top + box.height > meta.height) {
      throw new Error(`${image.name} ${theme}: crop ${JSON.stringify(box)} is outside ${meta.width}x${meta.height}`);
    }
    for (const width of image.widths) {
      const target = join(outDir, `${image.name}-${theme}-${width}.webp`);
      await sharp(source)
        .extract(box)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 84, effort: 6, smartSubsample: true })
        .toFile(target);
      const out = await sharp(target).metadata();
      const bytes = (await stat(target)).size;
      total += bytes;
      console.log(`wrote public/landing/${image.name}-${theme}-${width}.webp ${out.width}x${out.height} ${(bytes / 1024).toFixed(0)} KiB`);
    }
  }
}
console.log(`total ${(total / 1024).toFixed(0)} KiB`);
