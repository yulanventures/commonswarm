#!/usr/bin/env node
// Compare failures in a node:test log (spec or TAP) with tests/ci-known-failures.json.
// Usage: node scripts/ci-compare-failures.mjs --log FILE [--suite NAME] [--manifest FILE] [--gate]
// Prints NEW and KNOWN failures. Exit 1 only with --gate and at least one NEW failure.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function parseFailures(text) {
  const names = new Set();
  for (const raw of text.split(/\r?\n/)) {
    let m = /^\s*not ok \d+ - (.+?)\s*$/.exec(raw);
    if (m) {
      if (/#\s*(SKIP|TODO)\b/i.test(m[1])) continue;
      names.add(m[1].replace(/\s+#\s*(?!SKIP|TODO).*$/i, "").trim());
      continue;
    }
    m = /^\s*✖\s+(.+?)\s*$/.exec(raw);
    if (!m) continue;
    let name = m[1].replace(/\s+\(\d+(?:\.\d+)?ms\)$/, "").trim();
    if (/^(failing tests|tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/i.test(name) && /:$|^\w+\s+\d/.test(name)) continue;
    if (/^failing tests:?$/i.test(name)) continue;
    names.add(name);
  }
  return [...names];
}

export function knownNames(manifest, suite) {
  const suites = manifest.suites ?? {};
  const selected = suite ? [suites[suite] ?? []] : Object.values(suites);
  return new Set(selected.flat().map((entry) => (typeof entry === "string" ? entry : entry.name)));
}

export function compare(failures, manifest, suite) {
  const known = knownNames(manifest, suite);
  return {
    newFailures: failures.filter((name) => !known.has(name)),
    knownFailures: failures.filter((name) => known.has(name)),
  };
}

function main(argv) {
  const opts = { gate: false, manifest: fileURLToPath(new URL("../tests/ci-known-failures.json", import.meta.url)) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gate") opts.gate = true;
    else if (a === "--log" || a === "--suite" || a === "--manifest") opts[a.slice(2)] = argv[++i];
    else { console.error(`unknown argument: ${a}`); return 2; }
  }
  if (!opts.log) { console.error("--log FILE is required"); return 2; }
  const manifest = JSON.parse(readFileSync(opts.manifest, "utf8"));
  const { newFailures, knownFailures } = compare(parseFailures(readFileSync(opts.log, "utf8")), manifest, opts.suite);
  console.log(`NEW failures: ${newFailures.length}`);
  for (const name of newFailures) console.log(`  NEW   ${name}`);
  console.log(`KNOWN failures: ${knownFailures.length}`);
  for (const name of knownFailures) console.log(`  KNOWN ${name}`);
  return opts.gate && newFailures.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
