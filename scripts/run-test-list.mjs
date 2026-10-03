#!/usr/bin/env node
/* Runs the test files named in a list file: node scripts/run-test-list.mjs <list> [--list-only] [node --test flags...]
 * The list holds one path per line; blank lines and lines starting with # are ignored.
 * A path with a glob character is passed to node --test as written (node expands it).
 * Any other path must exist, and no path may appear twice; otherwise exit 1.
 * --list-only prints the expanded file set (sorted, one per line) and runs nothing. */
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync } from "node:fs";

const GLOB = /[*?[\]{}]/;

export function parseList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

export function checkList(entries, exists = existsSync) {
  const problems = [];
  const seen = new Set();
  const duplicates = new Set();
  for (const entry of entries) {
    if (seen.has(entry)) duplicates.add(entry);
    seen.add(entry);
  }
  for (const entry of duplicates) problems.push(`duplicate entry: ${entry}`);
  for (const entry of seen) {
    if (!GLOB.test(entry) && !exists(entry)) problems.push(`missing file: ${entry}`);
  }
  return problems;
}

export function expand(entries) {
  const files = new Set();
  for (const entry of entries) {
    if (GLOB.test(entry)) for (const match of globSync(entry)) files.add(match);
    else files.add(entry);
  }
  return [...files].sort();
}

function main(argv) {
  const [listPath, ...rest] = argv;
  if (!listPath) {
    console.error("usage: run-test-list.mjs <list-file> [--list-only] [node --test flags...]");
    return 2;
  }
  const listOnly = rest.includes("--list-only");
  const flags = rest.filter((flag) => flag !== "--list-only");
  if (!existsSync(listPath)) {
    console.error(`list file not found: ${listPath}`);
    return 1;
  }
  const entries = parseList(readFileSync(listPath, "utf8"));
  if (entries.length === 0) {
    console.error(`list is empty: ${listPath}`);
    return 1;
  }
  const problems = checkList(entries);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`${listPath}: ${problem}`);
    return 1;
  }
  if (listOnly) {
    console.log(expand(entries).join("\n"));
    return 0;
  }
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--test", ...flags, ...entries], {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
