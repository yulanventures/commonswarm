import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  allowedChromePath, browserSkipMessage, browserTest, buildChromeArgs, findChrome,
  findChromeFromCandidates, launchChrome, playwrightCachePaths, requireBrowserTests,
} from "./chrome.js";

const forbiddenBrowser = "/Applications/ChromeGuardFake.app/Contents/MacOS/ChromeGuardFake";
const bundledBrowser = "/home/runner/.cache/ms-playwright/chromium_headless_shell-123/chrome-linux/headless_shell";
const caches = ["/home/runner/.cache/ms-playwright"];
const browserRule = /AGENTS\.md Browser work: tests must never start the installed Chrome app/u;

test("browser selection rejects installed apps before considering an allowed fallback", async () => {
  for (const path of [forbiddenBrowser, "/Applications/../Applications/Chromium.app/chrome"]) {
    await assert.rejects(findChromeFromCandidates(
      [path, bundledBrowser], async (candidate) => candidate, caches,
    ), browserRule);
  }
  assert.equal(allowedChromePath(bundledBrowser, bundledBrowser, caches), bundledBrowser);
  for (const path of ["/usr/bin/chromium", "/usr/bin/google-chrome", "/opt/chrome", `${caches[0]}-other/chrome`]) {
    assert.throws(() => allowedChromePath(path, path, caches), /only Playwright's bundled Chromium/u);
  }
});

test("CHROME_BIN cannot opt into an installed macOS app", async () => {
  const previous = process.env.CHROME_BIN;
  const previousGate = process.env.RUN_BROWSER_TESTS;
  try {
    process.env.RUN_BROWSER_TESTS = "1";
    process.env.CHROME_BIN = forbiddenBrowser;
    await assert.rejects(findChrome(), browserRule);
  } finally {
    if (previous === undefined) delete process.env.CHROME_BIN;
    else process.env.CHROME_BIN = previous;
    if (previousGate === undefined) delete process.env.RUN_BROWSER_TESTS;
    else process.env.RUN_BROWSER_TESTS = previousGate;
  }
});

test("browser selection rejects a symlink resolving into Applications", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrome-guard-"));
  try {
    const link = join(directory, "chrome");
    // The target is a fake path string: never create or inspect an installed app.
    await symlink(forbiddenBrowser, link);
    const target = await readlink(link);
    assert.throws(() => allowedChromePath(link, target), browserRule);
    // Simulate realpath for the deliberately dangling target, at the same selection boundary.
    await assert.rejects(findChromeFromCandidates([link], async () => target), browserRule);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser selection skips missing files and resolves an allowed symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrome-guard-"));
  try {
    const cache = join(directory, "ms-playwright");
    await mkdir(cache);
    const file = join(cache, "fake-chromium");
    const link = join(directory, "chrome");
    await writeFile(file, "not a browser; must never be executed\n");
    await symlink(file, link);
    assert.equal(
      await findChromeFromCandidates([join(cache, "missing"), link], realpath, [await realpath(cache)]),
      await realpath(file),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing allowed browsers fail with Playwright installation instructions", async () => {
  await assert.rejects(findChromeFromCandidates(["missing"], async () => {
    throw new Error("ENOENT");
  }), /install Playwright's bundled Chromium: npx playwright install chromium-headless-shell; the installed Chrome app is never used/u);
});

test("Playwright searches its explicit path, real user cache, then HOME cache", () => {
  assert.deepEqual(playwrightCachePaths(
    { PLAYWRIGHT_BROWSERS_PATH: "/private/tmp/bundled" }, "/Users/real", "/private/tmp/fake-home", "darwin",
  ), [
    "/private/tmp/bundled",
    "/Users/real/Library/Caches/ms-playwright",
    "/private/tmp/fake-home/Library/Caches/ms-playwright",
  ]);
  assert.deepEqual(playwrightCachePaths({}, "/Users/real", "/Users/real", "darwin"), [
    "/Users/real/Library/Caches/ms-playwright",
  ]);
  assert.deepEqual(playwrightCachePaths({}, "/home/real", "/tmp/fake-home", "linux"), [
    "/home/real/.cache/ms-playwright", "/tmp/fake-home/.cache/ms-playwright",
  ]);
});

test("Chrome arguments isolate the profile and keychain without duplicating caller flags", () => {
  const args = buildChromeArgs(["--headless=new", "--dump-dom", "about:blank"], "/tmp/fresh-profile", false);
  for (const flag of ["--headless=new", "--password-store=basic", "--use-mock-keychain", "--user-data-dir=/tmp/fresh-profile"]) {
    assert.equal(args.filter((arg) => arg === flag).length, 1);
  }
  assert.deepEqual(args.slice(-2), ["--dump-dom", "about:blank"]);
  assert.throws(() => buildChromeArgs(["about:blank"], undefined, false), /fresh temporary Chrome profile/u);
});

test("caller profiles and keychain flags are preserved in both flag syntaxes", () => {
  for (const flags of [
    ["--password-store=basic", "--user-data-dir=/tmp/caller-profile"],
    ["--password-store", "basic", "--user-data-dir", "/tmp/caller-profile"],
  ]) {
    const callerFlags = ["--use-mock-keychain", ...flags, "about:blank"];
    const args = buildChromeArgs(callerFlags, undefined, false);
    assert.deepEqual(args.slice(-callerFlags.length), callerFlags);
    for (const name of ["--password-store", "--use-mock-keychain", "--user-data-dir"]) {
      assert.equal(args.filter((arg) => arg === name || arg.startsWith(`${name}=`)).length, 1);
    }
  }
});

test("Chrome arguments retain local process flags and remove them on GitHub Actions", () => {
  const flags = ["--single-process", "--no-zygote", "about:blank"];
  const local = buildChromeArgs(flags, "/tmp/profile", false);
  const ci = buildChromeArgs(flags, "/tmp/profile", true);
  for (const flag of flags.slice(0, 2)) {
    assert.ok(local.includes(flag));
    assert.ok(!ci.includes(flag));
  }
  assert.ok(ci.includes("--password-store=basic"));
  assert.ok(ci.includes("--use-mock-keychain"));
});

test("browser admission refuses setup and launches unless explicitly enabled", async () => {
  const previous = process.env.RUN_BROWSER_TESTS;
  try {
    for (const gate of [undefined, "0", "true"]) {
      if (gate === undefined) delete process.env.RUN_BROWSER_TESTS;
      else process.env.RUN_BROWSER_TESTS = gate;
      assert.throws(requireBrowserTests, { message: browserSkipMessage });
      await assert.rejects(findChrome(), { message: browserSkipMessage });
      await assert.rejects(launchChrome(forbiddenBrowser, ["about:blank"]), { message: browserSkipMessage });
    }
    let ran = false;
    await browserTest("disabled browser callback", { timeout: 10 }, () => { ran = true; });
    assert.equal(ran, false);
    process.env.RUN_BROWSER_TESTS = "1";
    assert.doesNotThrow(requireBrowserTests);
    await browserTest("enabled browser callback (no launch)", () => { ran = true; });
    assert.equal(ran, true);
    await assert.rejects(launchChrome(forbiddenBrowser, ["about:blank"]), browserRule);
  } finally {
    if (previous === undefined) delete process.env.RUN_BROWSER_TESTS;
    else process.env.RUN_BROWSER_TESTS = previous;
  }
});

test("finder discovers both Linux headless-shell layouts and rejects escaping overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chrome-guard-"));
  const saved = { CHROME_BIN: process.env.CHROME_BIN, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    RUN_BROWSER_TESTS: process.env.RUN_BROWSER_TESTS };
  try {
    const cache = join(directory, "ms-playwright");
    process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    process.env.RUN_BROWSER_TESTS = "1";
    delete process.env.CHROME_BIN;
    for (const [layout, binary] of [["chrome-linux", "headless_shell"],
      ["chrome-headless-shell-linux64", "chrome-headless-shell"]]) {
      const install = join(cache, `chromium_headless_shell-${layout === "chrome-linux" ? "1" : "2"}`, layout);
      await mkdir(install, { recursive: true });
      const file = join(install, binary);
      await writeFile(file, "not executable; browser-free discovery only\n");
      assert.equal(await findChrome(), await realpath(file));
      process.env.CHROME_BIN = file;
      assert.equal(await findChrome(), await realpath(file));
      delete process.env.CHROME_BIN;
    }
    const outside = join(directory, "installed-chrome");
    await writeFile(outside, "not a browser\n");
    const escape = join(cache, "escaping-chrome");
    await symlink(outside, escape);
    for (const path of [outside, escape]) {
      process.env.CHROME_BIN = path;
      await assert.rejects(findChrome(), /only Playwright's bundled Chromium/u);
    }
    await assert.rejects(launchChrome(escape, ["about:blank"]), /only Playwright's bundled Chromium/u);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("Chrome finder never includes installed-browser candidates", async () => {
  const source = await readFile(new URL("./chrome.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /["']\/usr\/bin\/(?:google-chrome|chromium)/u);
  assert.doesNotMatch(source, /systemChromeCandidates/u);
});
