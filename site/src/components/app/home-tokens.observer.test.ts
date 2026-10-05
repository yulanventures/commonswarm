import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

const styles = new URL("../../styles/home/", import.meta.url);
const tokens = await readFile(new URL("../../styles/tokens.css", import.meta.url), "utf8");
const declared = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/gu)].map(match => match[1]));
function violations(css: string): string[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const errors: string[] = [];
  if (/#[\da-f]{3,8}\b/iu.test(source)) errors.push("raw hex");
  if (/var\(\s*--d-/u.test(source)) errors.push("dark storage value");
  // Local custom properties create a second palette even when aliased to a site token.
  if (/--[\w-]+\s*:/u.test(source)) errors.push("local custom property");
  for (const match of source.matchAll(/var\(\s*(--[\w-]+)/gu)) if (!declared.has(match[1])) errors.push(`undeclared ${match[1]}`);
  if (/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/iu.test(source)) errors.push("raw colour");
  return errors;
}

test("every home stylesheet consumes only declared site colour and design tokens", async () => {
  const files = (await readdir(styles)).filter(name => name.endsWith(".css")).sort();
  assert.ok(files.includes("index.css") && files.includes("primitives.css"));
  const checked = [];
  for (const file of files) {
    assert.deepEqual(violations(await readFile(new URL(file, styles), "utf8")), [], file);
    checked.push(file);
  }
  assert.equal(checked.length, files.length);
  // Positive and negative controls use the same scanner as the production files.
  assert.deepEqual(violations(".hm-example { color: var(--text); background: var(--surface) }"), []);
  for (const css of ["a{color:#abcdef}", "a{color:var(--d-text)}", "a{--own:var(--text)}", "a{color:var(--not-declared)}", "a{color:rgb(0,0,0)}"]) assert.ok(violations(css).length > 0);
});
