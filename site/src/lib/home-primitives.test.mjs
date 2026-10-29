import assert from "node:assert/strict";
import { test } from "node:test";
import { safeHomeHref } from "./home-primitives.ts";

test("safe links keep normal references and refuse script, data and disguised schemes", () => {
  for (const href of ["/app?w=W&todo=T", "#todo", "https://example.test/file", "http://example.test/file"]) assert.equal(safeHomeHref(href), href);
  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>1</script>", "//example.test", "/\\example.test", "\njavascript:alert(1)", "java\tscript:alert(1)", "", "relative"]) assert.equal(safeHomeHref(href), null);
});
