import assert from "node:assert/strict";
import { test } from "node:test";
import { modelGlyphSvg } from "./model-glyph.ts";

test("modelGlyphSvg: class names cannot break out of the class attribute", () => {
  const glyph = modelGlyphSvg(null, 'glyph" onload="alert(1)');

  assert.match(glyph, /class="glyph&quot; onload=&quot;alert\(1\)"/);
  assert.doesNotMatch(glyph, /class="glyph" onload=/);
});
