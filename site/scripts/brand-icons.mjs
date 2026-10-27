#!/usr/bin/env node
/** Generate app icons from the junction-C geometry in public/brand/mark.svg.
 * Usage: node scripts/brand-icons.mjs [output-dir]
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const TILE = "#FAF8F3";
const mark = `<g transform="translate(4 4) scale(.75)">
    <path d="M22.6 8.15a9.7 9.7 0 1 0 0 15.7" fill="none" stroke="#292C25" stroke-width="4.8" stroke-linecap="round"/>
    <rect x="18.35" y="11.4" width="9.2" height="9.2" rx="2.35" fill="#BA3D23"/>
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
