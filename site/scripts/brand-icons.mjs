#!/usr/bin/env node
/**
 * Generates the three PNG app icons from the current CommonSwarm mark.
 *
 * Geometry source: public/favicon.svg (32-unit grid). Colour literals copied from it
 * (the sync boundary, as in og-card.mjs): tile #FAF8F3, circle #2471A8, square stroke #1E2A33.
 * The favicon's hairline (#DEDCD6) is dropped; it only separates the 32px favicon from browser chrome.
 *
 * Usage: node scripts/brand-icons.mjs [output-dir]   (default: public/ and public/brand/)
 *
 * - app-icon-512.png (any): tile and mark scaled x16, transparent outside the rounded tile (rx 128).
 * - apple-touch-icon.png (180): opaque full-bleed square, mark at the favicon's scale and position (x 180/32).
 * - app-icon-maskable-512.png: opaque full-bleed square. The mark's bounding box is centred on the
 *   tile centre (16,16); its farthest point is the square's outer rounded corner, at
 *   (26.56-4.032-16)*sqrt(2)+4.032 = 13.264 units from the centre. The safe zone has radius
 *   204.8px (80% of 512), so scale <= 204.8/13.264 = 15.44; scale 15 puts it at 198.96px.
 *
 * The PNGs are the shipping artifacts; open and inspect them after every regeneration.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const TILE = "#FAF8F3";
const mark = `<g transform="translate(4 4)">
    <circle cx="8.16" cy="8.16" r="6.72" fill="#2471A8"/>
    <rect x="10.12" y="10.12" width="11.44" height="11.44" rx="3.032" fill="none" stroke="#1E2A33" stroke-width="2"/>
  </g>`;

const svg = (size, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size.view} ${size.view}" width="${size.px}" height="${size.px}">
  ${body}
</svg>`;

const icons = [
  {
    file: join("brand", "app-icon-512.png"),
    svg: svg({ view: 32, px: 512 }, `<rect width="32" height="32" rx="8" fill="${TILE}"/>\n  ${mark}`),
  },
  {
    file: "apple-touch-icon.png",
    svg: svg({ view: 32, px: 180 }, `<rect width="32" height="32" fill="${TILE}"/>\n  ${mark}`),
  },
  {
    file: join("brand", "app-icon-maskable-512.png"),
    svg: svg(
      { view: 512, px: 512 },
      `<rect width="512" height="512" fill="${TILE}"/>\n  <g transform="translate(256 256) scale(15) translate(-16 -16)">${mark}</g>`,
    ),
  },
];

const outDir = process.argv[2];
for (const icon of icons) {
  const target = outDir ? join(outDir, icon.file.split(/[\\/]/).pop()) : join(root, "public", icon.file);
  await sharp(Buffer.from(icon.svg)).png({ compressionLevel: 9 }).toFile(target);
  const { width, height } = await sharp(target).metadata();
  console.log(`wrote ${target} (${width}x${height})`);
}
