/*
 * Generate public/og.png from reviewable SVG source.
 *
 * The card is a product surface: its promise, palette, and free-tier claim must track the
 * homepage. Rendering through sharp keeps the result deterministic and removes the old
 * browser-window recipe, whose screenshot could tile when the real window was too narrow.
 *
 * Daylight Orbs (2026-10-01). The colours below mirror tokens.css and the brand spec. SVG
 * cannot import tokens.css, so this explicit map is the sync boundary:
 *   canvas     #faf8f3  --elev-0 / --canvas
 *   surface    #ffffff  --surface
 *   border     #dedcd6  --border
 *   ink        #252a32  --text / --ink
 *   muted      #626773  --text-muted
 *   orbs       lavender #b8adf2, peach #f3b89d, sage #aacbb7, sky #a8cbed, pearl centre
 *   mark       ink centre, lavender N, peach E, sage S, cobalt #315cff W (Wordmark.astro)
 *
 * Usage:
 *   node scripts/og-card.mjs public/og.png
 *   node scripts/og-card.mjs /tmp/og-card.svg
 *
 * KNOWN LIMIT (2026-10-01): sharp's bundled librsvg ignores the @font-face data URIs below,
 * so the PNG's text renders in the "Helvetica Neue" fallback rather than Plus Jakarta Sans /
 * DM Sans. Pango text with `fontfile` and a FONTCONFIG_FILE pointing at TTF copies were both
 * tried and also fell back. Colours, geometry and copy are on brand; only the face differs.
 * The SVG output (opened in a browser) shows the intended faces.
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
const display = readFileSync(join(fonts, "plus-jakarta-sans-latin.woff2")).toString("base64");
const body = readFileSync(join(fonts, "dm-sans-latin.woff2")).toString("base64");

/* One radial-gradient orb, lit from the upper left like the homepage's CSS orbs. */
const orb = (id, light, mid, hue, edge) => `
    <radialGradient id="${id}" cx=".3" cy=".22" r=".85">
      <stop offset="0" stop-color="${light}"/>
      <stop offset=".27" stop-color="${mid}"/>
      <stop offset=".64" stop-color="${hue}"/>
      <stop offset="1" stop-color="${edge}"/>
    </radialGradient>`;

/* The headline is the homepage h1, word for word. */
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <title>CommonSwarm</title>
  <desc>Your people. Your agents. One shared workspace. Share messages, files and notes about home and work.</desc>
  <defs>
    <style>
      @font-face {
        font-family: "Plus Jakarta Sans";
        font-weight: 200 800;
        src: url("data:font/woff2;base64,${display}") format("woff2");
      }
      @font-face {
        font-family: "DM Sans";
        font-weight: 100 1000;
        src: url("data:font/woff2;base64,${body}") format("woff2");
      }
      .display { font-family: "Plus Jakarta Sans", "Helvetica Neue", Arial, sans-serif; }
      .body { font-family: "DM Sans", "Helvetica Neue", Arial, sans-serif; }
    </style>
    <radialGradient id="glow-lav" cx=".62" cy=".38" r=".42">
      <stop offset="0" stop-color="#b8adf2" stop-opacity=".26"/>
      <stop offset="1" stop-color="#b8adf2" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow-peach" cx=".92" cy=".5" r=".4">
      <stop offset="0" stop-color="#f3b89d" stop-opacity=".24"/>
      <stop offset="1" stop-color="#f3b89d" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow-sage" cx=".8" cy=".95" r=".38">
      <stop offset="0" stop-color="#aacbb7" stop-opacity=".2"/>
      <stop offset="1" stop-color="#aacbb7" stop-opacity="0"/>
    </radialGradient>${orb("orb-lav", "#f6f0ff", "#ded1ff", "#b8adf2", "#9387ce")}${orb("orb-peach", "#fff5e9", "#ffe0c8", "#f3b89d", "#dca088")}${orb("orb-sage", "#f0f8ec", "#d2e4d3", "#aacbb7", "#85aa96")}${orb("orb-sky", "#eff8ff", "#d0e8fb", "#a8cbed", "#81add8")}${orb("orb-pearl", "#ffffff", "#fcfaf4", "#e8e7e0", "#d3d7d8")}
    <filter id="card-shadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="16" stdDeviation="22" flood-color="#252a32" flood-opacity=".1"/>
    </filter>
    <filter id="orb-shadow" x="-30%" y="-30%" width="160%" height="170%">
      <feDropShadow dx="0" dy="12" stdDeviation="9" flood-color="#252a32" flood-opacity=".12"/>
    </filter>
  </defs>

  <rect width="1200" height="630" fill="#faf8f3"/>
  <rect width="1200" height="630" fill="url(#glow-lav)"/>
  <rect width="1200" height="630" fill="url(#glow-peach)"/>
  <rect width="1200" height="630" fill="url(#glow-sage)"/>

  <g transform="translate(72 60)">
    <g transform="scale(.75)">
      <circle cx="24" cy="24" r="5.5" fill="#252a32"/>
      <circle cx="24" cy="8" r="5.5" fill="#b8adf2"/>
      <circle cx="40" cy="24" r="5.5" fill="#f3b89d"/>
      <circle cx="24" cy="40" r="5.5" fill="#aacbb7"/>
      <circle cx="8" cy="24" r="5.5" fill="#315cff"/>
    </g>
    <text class="display" x="48" y="27" font-size="27" font-weight="600"
      letter-spacing="-1.08" fill="#252a32">CommonSwarm</text>
  </g>

  <text class="display" x="72" y="206" font-size="56" font-weight="600"
    letter-spacing="-2" fill="#252a32">
    <tspan x="72" dy="0">Your people.</tspan>
    <tspan x="72" dy="64">Your agents.</tspan>
    <tspan x="72" dy="64">One shared workspace.</tspan>
  </text>

  <text class="body" x="72" y="402" font-size="23" font-weight="400" fill="#626773">
    <tspan x="72" dy="0">Share messages, files and notes</tspan>
    <tspan x="72" dy="32">about home and work.</tspan>
  </text>

  <g transform="translate(72 506)">
    <rect width="272" height="52" rx="26" fill="#315cff"/>
    <text class="body" x="136" y="33" text-anchor="middle" font-size="19" font-weight="500"
      fill="#ffffff">Start a workspace</text>
    <text class="body" x="300" y="33" font-size="17" font-weight="500"
      fill="#626773">Free · 10 workspaces · no card</text>
  </g>

  <g transform="translate(700 70)">
    <ellipse cx="230" cy="250" rx="235" ry="96" fill="none" stroke="#d8d5e2" stroke-opacity=".8" stroke-width="1.5"/>
    <g filter="url(#orb-shadow)">
      <circle cx="230" cy="78" r="50" fill="url(#orb-pearl)"/>
      <circle cx="70" cy="110" r="66" fill="url(#orb-lav)"/>
      <circle cx="392" cy="116" r="62" fill="url(#orb-peach)"/>
      <circle cx="60" cy="384" r="64" fill="url(#orb-sky)"/>
      <circle cx="404" cy="380" r="60" fill="url(#orb-sage)"/>
    </g>
    <g filter="url(#card-shadow)">
      <rect x="85" y="150" width="290" height="250" rx="24" fill="#ffffff" stroke="#dedcd6"/>
    </g>
    <g transform="translate(109 174) scale(.6)">
      <circle cx="24" cy="24" r="5.5" fill="#252a32"/>
      <circle cx="24" cy="8" r="5.5" fill="#b8adf2"/>
      <circle cx="40" cy="24" r="5.5" fill="#f3b89d"/>
      <circle cx="24" cy="40" r="5.5" fill="#aacbb7"/>
      <circle cx="8" cy="24" r="5.5" fill="#315cff"/>
    </g>
    <text class="display" x="149" y="192" font-size="18" font-weight="600" letter-spacing="-.4" fill="#252a32">Home base</text>
    <text class="body" x="149" y="211" font-size="13" fill="#626773">Example workspace</text>
    <rect x="109" y="232" width="242" height="1" fill="#dedcd6"/>
    <rect x="109" y="230" width="58" height="3" rx="1.5" fill="#315cff"/>
    <circle cx="124" cy="266" r="14" fill="url(#orb-lav)"/>
    <rect x="148" y="258" width="150" height="8" rx="4" fill="#252a32" opacity=".78"/>
    <rect x="148" y="272" width="96" height="6" rx="3" fill="#626773" opacity=".3"/>
    <circle cx="124" cy="314" r="14" fill="url(#orb-peach)"/>
    <rect x="148" y="306" width="170" height="8" rx="4" fill="#252a32" opacity=".78"/>
    <rect x="148" y="320" width="120" height="6" rx="3" fill="#626773" opacity=".3"/>
    <rect x="109" y="346" width="242" height="34" rx="10" fill="#ffffff" stroke="#dedcd6"/>
    <rect x="123" y="355" width="12" height="16" rx="3" fill="none" stroke="#626773" stroke-width="1.6"/>
    <rect x="145" y="360" width="104" height="7" rx="3.5" fill="#252a32" opacity=".7"/>
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
