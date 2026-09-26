import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMPANY_ADDRESS_LINE } from "./company.ts";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() ? [path] : [];
  });
}

test("the company address is the operator-approved line", () => {
  assert.equal(
    COMPANY_ADDRESS_LINE,
    "Yulan Ventures, LLC, 1211 W 6th St, Ste #600-188, Austin, TX 78703",
  );
});

test("site source has no old company street number", () => {
  const oldStreet = ["1200", "W 6th"].join(" ");
  const files = sourceFiles(sourceRoot);
  assert.ok(files.length > 0, "site/src must be scanned");
  const offenders = files.filter((path) => readFileSync(path, "utf8").includes(oldStreet));
  assert.deepEqual(offenders.map((path) => relative(sourceRoot, path)), []);
});
