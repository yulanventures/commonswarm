import assert from "node:assert/strict";
import { mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  allowedChromePath, buildChromeArgs, findChrome, findChromeFromCandidates, playwrightCachePaths,
} from "./chrome.js";

const forbiddenBrowser = "/Applications/ChromeGuardFake.app/Contents/MacOS/ChromeGuardFake";
const browserRule = /AGENTS\.md Browser work: tests must never start the installed Chrome app/u;

test("browser selection rejects installed apps before considering an allowed fallback", async () => {
  for (const path of [forbiddenBrowser, "/Applications/../Applications/Chromium.app/chrome"]) {
    await assert.rejects(findChromeFromCandidates(
      [path, "/usr/bin/chromium"], async (candidate) => candidate,
    ), browserRule);
  }
  assert.equal(allowedChromePath("/usr/bin/chromium"), "/usr/bin/chromium");
});

test("CHROME_BIN cannot opt into an installed macOS app", async () => {
  const previous = process.env.CHROME_BIN;
  try {
    process.env.CHROME_BIN = forbiddenBrowser;
    await assert.rejects(findChrome(), browserRule);
  } finally {
    if (previous === undefined) delete process.env.CHROME_BIN;
    else process.env.CHROME_BIN = previous;
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
    const file = join(directory, "fake-chromium");
    const link = join(directory, "chrome");
    await writeFile(file, "not a browser; must never be executed\n");
    await symlink(file, link);
    assert.equal(
      await findChromeFromCandidates([join(directory, "missing"), link]),
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

test("Chrome candidate lists never include installed macOS apps", async () => {
  const source = await readFile(new URL("./chrome.ts", import.meta.url), "utf8");
  const candidates = source.match(/const systemChromeCandidates = \[([\s\S]*?)\];/u);
  assert.ok(candidates, "the system candidate list must be checked");
  assert.ok(!candidates[1]!.includes("/Applications/"));
});
