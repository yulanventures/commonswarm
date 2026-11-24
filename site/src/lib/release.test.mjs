/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  DESKTOP_MAC_ARM64_URL,
  DESKTOP_MAC_X64_URL,
  DESKTOP_VERSION,
  RELEASES_URL,
} from "./release.ts";

test("Mac desktop download URLs are built from desktop/package.json version and expected release tag and file names", async () => {
  const desktopPkg = JSON.parse(
    await readFile(new URL("../../../desktop/package.json", import.meta.url), "utf8"),
  );
  assert.equal(DESKTOP_VERSION, desktopPkg.version);
  assert.equal(RELEASES_URL, "https://github.com/yulanventures/commonswarm/releases");
  assert.equal(
    DESKTOP_MAC_ARM64_URL,
    `https://github.com/yulanventures/commonswarm/releases/download/desktop-v${desktopPkg.version}/CommonSwarm-${desktopPkg.version}-arm64.dmg`,
  );
  assert.equal(
    DESKTOP_MAC_X64_URL,
    `https://github.com/yulanventures/commonswarm/releases/download/desktop-v${desktopPkg.version}/CommonSwarm-${desktopPkg.version}.dmg`,
  );
});
