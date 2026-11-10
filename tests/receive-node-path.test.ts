/** Hooks and the channel config name a node path that survives a package-manager upgrade. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { stableNodePath } from "../src/onboarding-cli.js";

test("a versioned node path becomes the PATH symlink that resolves to the same binary", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-node-path-"));
  const cellar = join(root, "Cellar", "node", "26.7.0", "bin");
  const bin = join(root, "bin");
  const elsewhere = join(root, "elsewhere");
  await mkdir(cellar, { recursive: true }); await mkdir(bin); await mkdir(elsewhere);
  const versioned = join(cellar, "node");
  await writeFile(versioned, "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(elsewhere, "node"), "#!/bin/sh\n", { mode: 0o755 }); // A different node earlier on PATH.
  await symlink(versioned, join(bin, "node"));
  assert.equal(await stableNodePath(versioned, [elsewhere, "relative/bin", bin].join(delimiter)), join(bin, "node"));
  // No matching entry, or the binary's own directory first: keep the real path.
  assert.equal(await stableNodePath(versioned, elsewhere), versioned);
  assert.equal(await stableNodePath(versioned, [cellar, bin].join(delimiter)), versioned);
});
