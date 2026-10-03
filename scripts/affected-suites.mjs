#!/usr/bin/env node
// Print which CI suites a git diff range affects, so leads can run them first.
// Usage: node scripts/affected-suites.mjs [RANGE]   (default origin/main...HEAD)
//        node scripts/affected-suites.mjs --paths a b c
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SUITES = ["server", "p1-cli", "site", "unit", "box-dry-run", "mcp-auth"];

// First-match-free table: every matching rule contributes its suites.
export const RULES = [
  [/^src\/protocol\//, ["server", "p1-cli", "unit"]],
  [/^src\//, ["p1-cli", "unit"]],
  [/^supabase\//, ["server", "unit", "mcp-auth"]],
  [/^services\/mcp-auth\//, ["mcp-auth", "p1-cli", "unit"]],
  [/^deploy\/mcp-auth\//, ["mcp-auth", "box-dry-run", "unit"]],
  [/^deploy\/(supabase-stack|edge-runtime|site)\//, ["box-dry-run", "unit"]],
  [/^deploy\//, ["box-dry-run"]],
  [/^hetzner-handoff\//, ["box-dry-run"]],
  [/^site\//, ["site"]],
  [/^tests\/p1-server\//, ["server"]],
  [/^tests\/p1-cli\//, ["p1-cli"]],
  [/^tests\/box-dry-run(\/|\.)/, ["box-dry-run", "unit"]],
  [/^tests\/[^/]+$/, ["unit"]],
  [/^docs\/(evidence|org)\//, ["unit"]],
  [/^scripts\/(build-release|require-cli-build|run-gates)/, ["p1-cli", "unit"]],
  [/^scripts\//, ["unit"]],
  [/^(package\.json|package-lock\.json|tsconfig[^/]*\.json)$/, ["server", "p1-cli", "unit"]],
  [/^\.github\/workflows\//, ["server", "p1-cli", "site", "unit", "box-dry-run", "mcp-auth"]],
];

export function affectedSuites(paths) {
  const hit = new Set();
  for (const path of paths) {
    const rules = RULES.filter(([re]) => re.test(path));
    // Fail safe: a changed path that no rule names could affect anything, so run everything.
    if (rules.length === 0) return [...SUITES];
    for (const [, suites] of rules) suites.forEach((s) => hit.add(s));
  }
  return SUITES.filter((s) => hit.has(s));
}

function main(argv) {
  let paths;
  if (argv[0] === "--paths") paths = argv.slice(1);
  else {
    const range = argv[0] ?? "origin/main...HEAD";
    paths = execFileSync("git", ["diff", "--name-only", range], { encoding: "utf8" }).split("\n").filter(Boolean);
  }
  for (const s of affectedSuites(paths)) console.log(s);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
