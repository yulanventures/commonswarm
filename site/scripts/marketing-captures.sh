#!/usr/bin/env bash
# Requires an existing gstack browse installation. Run after the real Astro build/preview.
set -euo pipefail
origin="${1:-http://127.0.0.1:4327}"
output="${2:?Usage: bash scripts/marketing-captures.sh [origin] /tmp/output-directory}"
browse_bin="${BROWSE_BIN:-$HOME/.claude/skills/gstack/browse/dist/browse}"
if [ ! -x "$browse_bin" ]; then
  echo 'Set BROWSE_BIN to an installed browse executable.' >&2
  exit 1
fi
mkdir -p "$output"
"$browse_bin" goto "$origin"
for width in 390 768 820 1024 1440; do
  "$browse_bin" viewport "${width}x1000"
  "$browse_bin" js 'document.documentElement.dataset.theme="light"; window.scrollTo(0,0)'
  "$browse_bin" js 'await document.fonts.ready; await new Promise(r=>setTimeout(r,250)); return "Ready"'
  "$browse_bin" screenshot "$output/home-${width}.png"
  "$browse_bin" js 'JSON.stringify({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,brokenImages:[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.currentSrc),headings:[...document.querySelectorAll("main h1,main h2,main h3")].filter(e=>e.getClientRects().length).map(e=>({text:e.textContent.trim(),lines:Math.round(e.getBoundingClientRect().height/parseFloat(getComputedStyle(e).lineHeight))}))})' > "$output/geometry-${width}.json"
done
"$browse_bin" js 'document.documentElement.dataset.theme="dark"'
"$browse_bin" js 'await new Promise(r=>setTimeout(r,250)); return "Theme ready"'
"$browse_bin" screenshot "$output/home-dark-1440.png"
"$browse_bin" viewport 390x844
"$browse_bin" screenshot "$output/home-dark-390.png"
"$browse_bin" js 'document.documentElement.dataset.theme="light"; window.scrollTo(0,0)'
