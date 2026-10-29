import assert from "node:assert/strict";
import { test } from "node:test";
import { commentSegments } from "./home-pickers.ts";

// Nikki's group comes first in the input: the picker must still put the viewer first.

test("comment bodies split into text and tag pieces; hostile text stays a plain string", () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const tags = [{ id: "n", label: "Nikki" }, { id: "m", label: "Nikki’s Muse" }];
  assert.deepEqual(commentSegments(`@Nikki’s Muse and @Nikki: ${hostile}`, tags), [
    { text: "@Nikki’s Muse", tag: tags[1] }, { text: " and ", tag: null }, { text: "@Nikki", tag: tags[0] }, { text: `: ${hostile}`, tag: null },
  ]);
  assert.deepEqual(commentSegments("plain", []), [{ text: "plain", tag: null }]);
  assert.deepEqual(commentSegments("", tags), []);
  assert.equal(commentSegments(`x ${hostile} @Nikki`, tags).map((piece) => piece.text).join(""), `x ${hostile} @Nikki`, "nothing is lost or added");
});
