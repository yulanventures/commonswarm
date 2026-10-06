import assert from "node:assert/strict";
import { test } from "node:test";
import { capsuleLabel, agentAccessibleName, queueMoveReceipt, safeHomeHref } from "./home-primitives.ts";

test("capsule names include every agent even when only three orbs fit", () => {
  const c = { person: { name: "Tom Langridge", firstName: "Tom" }, agents: [] };
  assert.equal(capsuleLabel(c), "Tom Langridge");
  c.agents = [{ nestedLabel: "Claude" }]; assert.equal(capsuleLabel(c), "Tom with Claude");
  c.agents.push({ nestedLabel: "dot" }); assert.equal(capsuleLabel(c), "Tom with Claude and dot");
  c.agents.push({ nestedLabel: "Muse" }, { nestedLabel: "Grok" }); assert.equal(capsuleLabel(c), "Tom with Claude, dot, Muse and Grok");
});

test("accessible agent names carry owner and state, not just an orb's colour", () => {
  const a = { name: "Muse", ownerFirstName: "Nikki", yours: false, state: { word: "Idle" } };
  assert.equal(agentAccessibleName(a), "Muse, Nikki’s agent, Idle");
  assert.equal(agentAccessibleName({ ...a, yours: true, state: { word: "Working" } }), "Muse, your agent, Working");
  assert.equal(agentAccessibleName({ ...a, ownerFirstName: null }), "Muse, owner left, Idle");
  assert.equal(agentAccessibleName({ ...a, name: "Claude", label: "Your Claude · 3dab8f40", nestedLabel: "Claude", yours: true, state: { word: "Idle" } }), "Claude · 3dab8f40, your agent, Idle");
  assert.equal(agentAccessibleName({ ...a, name: "Claude", label: "Your Claude", nestedLabel: "Claude" }), "Claude, Nikki’s agent, Idle");
  assert.equal(queueMoveReceipt("Book plumber", 1), "Moved ‘Book plumber’ to 1st.");
  assert.equal(queueMoveReceipt("Book plumber", 22), "Moved ‘Book plumber’ to 22nd.");
});

test("safe links keep normal references and refuse script, data and disguised schemes", () => {
  for (const href of ["/app?w=W&todo=T", "#todo", "https://example.test/file", "http://example.test/file"]) assert.equal(safeHomeHref(href), href);
  for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>1</script>", "//example.test", "/\\example.test", "\njavascript:alert(1)", "java\tscript:alert(1)", "", "relative"]) assert.equal(safeHomeHref(href), null);
});
