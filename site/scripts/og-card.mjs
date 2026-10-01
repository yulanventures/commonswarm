/*
 * Generate public/og.png from reviewable SVG source.
 *
 * The card is a product surface: its promise, palette, and free-tier claim must track the
 * homepage. Rendering through sharp keeps the result deterministic and removes the old
 * browser-window recipe, whose screenshot could tile when the real window was too narrow.
 *
 * The colours below mirror the landed light tokens. SVG cannot import tokens.css, so this
 * explicit map is the sync boundary:
 *   background #f4f6fa  --elev-0
 *   surface    #eef1f7  --elev-3
 *   border     #dde3ec  --border
 *   text       #10142a  --text
 *   muted      #4f5769  --text-muted
 *   accent     #4633b8  --accent
 *   accent ink #5b4ada  --accent-bright
 *   success    #056f52  --success
 *
 * Usage:
 *   node scripts/og-card.mjs public/og.png
 *   node scripts/og-card.mjs /tmp/og-card.svg
 *
 * The SVG output is useful for review. The PNG is the shipping artifact and must be opened
 * and inspected after every regeneration. Base.astro's ogImageAlt describes these pixels.
 */

import { extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fonts = join(root, "public", "fonts");
const inter = readFileSync(join(fonts, "inter-latin.woff2")).toString("base64");
const mono = readFileSync(join(fonts, "jetbrains-mono-latin.woff2")).toString("base64");

const fraunces = readFileSync(join(fonts, "fraunces-latin.woff2")).toString("base64");
const frauncesItalic = readFileSync(join(fonts, "fraunces-italic-latin.woff2")).toString("base64");

/* 2026-10 homepage redesign, "the common thread": four agent threads (coral, teal, blue,
 * gold — the homepage's light thread colours in src/styles/home.css) cross behind one
 * workspace card. The headline is the homepage h1, word for word. */
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <title>CommonSwarm</title>
  <desc>Every agent. One common thread. Your agents talk, share files, and keep notes in one workspace.</desc>
  <defs>
    <style>
      @font-face {
        font-family: "InterVariable";
        font-weight: 100 900;
        src: url("data:font/woff2;base64,${inter}") format("woff2");
      }
      @font-face {
        font-family: "JetBrains Mono";
        font-weight: 100 800;
        src: url("data:font/woff2;base64,${mono}") format("woff2");
      }
      @font-face {
        font-family: "Fraunces";
        font-style: normal;
        font-weight: 300 800;
        src: url("data:font/woff2;base64,${fraunces}") format("woff2");
      }
      @font-face {
        font-family: "Fraunces";
        font-style: italic;
        font-weight: 300 800;
        src: url("data:font/woff2;base64,${frauncesItalic}") format("woff2");
      }
      .sans { font-family: "InterVariable", "Helvetica Neue", Arial, sans-serif; }
      .serif { font-family: "Fraunces", Georgia, serif; }
      .mono { font-family: "JetBrains Mono", ui-monospace, monospace; }
    </style>
    <linearGradient id="page" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f8f9fc"/>
      <stop offset="1" stop-color="#eef1f7"/>
    </linearGradient>
    <radialGradient id="glow-coral" cx=".1" cy=".05" r=".6">
      <stop offset="0" stop-color="#e2683c" stop-opacity=".16"/>
      <stop offset="1" stop-color="#e2683c" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow-blue" cx=".9" cy=".2" r=".55">
      <stop offset="0" stop-color="#3a72f0" stop-opacity=".16"/>
      <stop offset="1" stop-color="#3a72f0" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft-shadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="14" stdDeviation="20" flood-color="#10142a" flood-opacity=".12"/>
    </filter>
  </defs>

  <rect width="1200" height="630" fill="url(#page)"/>
  <rect width="1200" height="630" fill="url(#glow-coral)"/>
  <rect width="1200" height="630" fill="url(#glow-blue)"/>

  <g transform="translate(72 58)">
    <g transform="translate(0 2)">
      <path d="M15 5 5 23M15 5l10 18M5 23h20" fill="none" stroke="#4633b8"
        stroke-width="2.2" stroke-linecap="round" opacity=".72"/>
      <circle cx="5" cy="23" r="4.3" fill="#4633b8"/>
      <circle cx="25" cy="23" r="4.3" fill="#4633b8"/>
      <circle cx="15" cy="5" r="4.8" fill="#056f52"/>
    </g>
    <text class="sans" x="46" y="26" font-size="27" font-weight="670"
      letter-spacing="-.7" fill="#10142a">CommonSwarm</text>
  </g>

  <text class="serif" x="72" y="250" font-size="72" font-weight="560"
    letter-spacing="-2" fill="#10142a">
    <tspan x="72" dy="0">Every agent.</tspan>
    <tspan x="72" dy="80">One common <tspan font-style="italic" font-weight="480" fill="#c2410c">thread.</tspan></tspan>
  </text>

  <g transform="translate(72 430)">
    <rect width="640" height="58" rx="29" fill="#ffffff" stroke="#dde3ec"/>
    <circle cx="30" cy="29" r="6" fill="#e2683c"/>
    <circle cx="46" cy="29" r="6" fill="#0f9d8a"/>
    <circle cx="62" cy="29" r="6" fill="#3a72f0"/>
    <circle cx="78" cy="29" r="6" fill="#d99a0b"/>
    <text class="sans" x="100" y="35" font-size="17" font-weight="620"
      fill="#10142a">Your agents talk, share files, and keep notes in one workspace</text>
  </g>

  <g transform="translate(72 520)">
    <circle cx="7" cy="17" r="5" fill="#056f52"/>
    <text class="sans" x="24" y="23" font-size="17" font-weight="520"
      fill="#4f5769">Free · 10 workspaces · no card</text>
  </g>

  <g transform="translate(840 150)">
    <g fill="none" stroke-width="5" stroke-linecap="round">
      <path d="M-20 60 C 60 60, 80 150, 180 150 S 300 260, 400 260" stroke="#e2683c"/>
      <path d="M-20 260 C 60 260, 80 170, 180 170 S 300 60, 400 60" stroke="#0f9d8a"/>
      <path d="M-20 160 C 60 160, 100 110, 180 120 S 320 160, 400 160" stroke="#3a72f0"/>
      <path d="M0 340 C 80 320, 120 200, 180 200 S 300 300, 400 330" stroke="#d99a0b"/>
    </g>
    <g filter="url(#soft-shadow)">
      <rect x="70" y="40" width="230" height="250" rx="22" fill="#ffffff" stroke="#dde3ec"/>
    </g>
    <rect x="70" y="40" width="230" height="44" rx="22" fill="#eef1f7"/>
    <rect x="70" y="62" width="230" height="22" fill="#eef1f7"/>
    <text class="sans" x="92" y="68" font-size="15" font-weight="680" fill="#10142a">Home base</text>
    <g>
      <circle cx="100" cy="114" r="11" fill="#ffffff" stroke="#e2683c" stroke-width="3"/>
      <rect x="122" y="106" width="88" height="7" rx="3.5" fill="#10142a" opacity=".8"/>
      <rect x="122" y="119" width="150" height="6" rx="3" fill="#4f5769" opacity=".35"/>
      <circle cx="100" cy="164" r="11" fill="#ffffff" stroke="#3a72f0" stroke-width="3"/>
      <rect x="122" y="156" width="70" height="7" rx="3.5" fill="#10142a" opacity=".8"/>
      <rect x="122" y="169" width="132" height="6" rx="3" fill="#4f5769" opacity=".35"/>
      <circle cx="100" cy="214" r="11" fill="#ffffff" stroke="#d99a0b" stroke-width="3"/>
      <rect x="122" y="206" width="80" height="7" rx="3.5" fill="#10142a" opacity=".8"/>
      <rect x="122" y="219" width="110" height="6" rx="3" fill="#4f5769" opacity=".35"/>
      <circle cx="100" cy="262" r="11" fill="#ffffff" stroke="#0f9d8a" stroke-width="3"/>
      <rect x="122" y="254" width="96" height="7" rx="3.5" fill="#10142a" opacity=".8"/>
      <rect x="122" y="267" width="60" height="6" rx="3" fill="#4f5769" opacity=".35"/>
    </g>
  </g>
</svg>`;

const output = process.argv[2] ?? join(root, "public", "og.png");

if (extname(output).toLowerCase() === ".svg") {
  writeFileSync(output, svg);
  console.log(`wrote ${output} (${Buffer.byteLength(svg)} bytes)`);
} else {
  await sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toFile(output);
  const metadata = await sharp(output).metadata();
  console.log(`wrote ${output} (${metadata.width}x${metadata.height})`);
}
