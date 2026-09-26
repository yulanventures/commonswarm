import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { test } from "node:test";

const siteRoot = join(import.meta.dirname, "..");
const launcher = join(siteRoot, "tests", "chrome.ts");
const sourceRoots = [join(siteRoot, "src"), join(siteRoot, "scripts")];
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".tsx"]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.has(extname(entry.name)) ? [path] : [];
  }));
  return files.flat();
}

test("site Chrome processes go through the shared launcher", async () => {
  const violations: string[] = [];
  for (const file of (await Promise.all(sourceRoots.map(sourceFiles))).flat()) {
    if (file === launcher) continue;
    const source = await readFile(file, "utf8");
    const hasHeadlessFlag = /["']--headless(?:=|["'])/u.test(source);
    const launchesChrome = /\b(?:execFile|spawn|run)\s*\(\s*(?:await\s+)?(?:\w*chrome\w*|["'][^"']*(?:chrome|chromium)[^"']*["'])/iu.test(source);
    if (hasHeadlessFlag || launchesChrome) violations.push(relative(siteRoot, file));
  }
  assert.deepEqual(
    violations,
    [],
    `direct Chrome launches must use tests/chrome.ts:\n${violations.join("\n")}`,
  );
});
