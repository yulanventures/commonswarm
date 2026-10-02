import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const launcher = join(repoRoot, "site/tests/chrome.ts");
const cdpLauncher = join(repoRoot, "tests/p1-local/human-seen-browser.test.ts");
const sourceRoots = ["src", "tests", "scripts", "site", "deploy", "services"];
const sourceExtensions = new Set([".js", ".mjs", ".ts", ".tsx", ".sh"]);
const browserFreeChecks = new Set([
  join(repoRoot, "site/tests/chrome-guard.test.ts"),
  join(repoRoot, "site/tests/chrome-launch-sweep.test.ts"),
]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "dist-release", ".git"].includes(entry.name)) return [];
      return sourceFiles(path);
    }
    return sourceExtensions.has(extname(entry.name)) ? [path] : [];
  }));
  return files.flat();
}

test("repository browser launches use the shared safety helpers and gated test registration", async () => {
  const sources = new Map(await Promise.all(
    (await Promise.all(sourceRoots.map((root) => sourceFiles(join(repoRoot, root))))).flat()
      .filter((file) => file !== launcher && !browserFreeChecks.has(file))
      .map(async (file) => [file, await readFile(file, "utf8")] as const),
  ));
  const browserFiles = new Set<string>();
  const violations: string[] = [];
  for (const [file, source] of sources) {
    const hasHeadlessFlag = /["']--headless(?:=|["'])/u.test(source);
    const launchesChrome = /\b(?:execFile|spawn|run)\s*\(\s*(?:await\s+)?(?:\w*chrome\w*|["'][^"']*(?:chrome|chromium)[^"']*["'])/iu.test(source);
    const launchesBrowserLibrary = /\b(?:chromium|puppeteer|browserType)\s*\.\s*launch(?:PersistentContext)?\s*\(/u.test(source);
    if (hasHeadlessFlag || launchesChrome || launchesBrowserLibrary) {
      browserFiles.add(file);
      // The CDP test owns a long-lived process, but shares admission, realpath validation and flags.
      if (file !== cdpLauncher || !["requireBrowserTests", "resolveChromePath", "buildChromeArgs"]
        .every((helper) => new RegExp(`\\b${helper}\\s*\\(`, "u").test(source))) {
        violations.push(`${relative(repoRoot, file)}: direct launch must use site/tests/chrome.ts`);
      }
    }
    if (/\b(?:findChrome|launchChrome)\b/u.test(source)) browserFiles.add(file);
  }
  // Follow relative imports to catch indirect browser use through any current or future fixture.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, source] of sources) {
      if (browserFiles.has(file)) continue;
      const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["'](\.[^"']+)["']/gu)];
      if (imports.some((match) => {
        const dependency = resolve(file, "..", match[1]!);
        return [dependency, dependency.replace(/\.js$/u, ".ts"), `${dependency}.ts`]
          .some((path) => browserFiles.has(path));
      })) {
        browserFiles.add(file);
        changed = true;
      }
    }
  }
  for (const file of browserFiles) {
    const source = sources.get(file)!;
    if (!/\.(?:test|observer)\.(?:ts|js|mjs)$/u.test(file)) continue;
    const gatedRegistration = /import\s*\{\s*browserTest\s+as\s+test\s*\}\s*from\s*["'][^"']*\/tests\/chrome\.js["']/u.test(source);
    const ungatedRegistration = /\bfrom\s*["']node:test["']/u.test(source);
    if (!gatedRegistration || ungatedRegistration) {
      violations.push(`${relative(repoRoot, file)}: browser cases must use browserTest as test`);
    }
  }
  assert.ok(browserFiles.size > 0, "the sweep must find browser callers");
  assert.deepEqual(violations, [], `browser safety violations:\n${violations.join("\n")}`);
});
