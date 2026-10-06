import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { agentOrb, capsule, choiceChips, notice, personAvatar } from "../../lib/home-primitives.ts";

const usedByLaneT = [personAvatar, agentOrb, capsule, choiceChips, notice];
const pendingSource = (fn: unknown) => /\bpending\s*\(/.test(Function.prototype.toString.call(fn));
const implemented = usedByLaneT.every((fn) => !pendingSource(fn));


test("geometry stand-ins render no targets and never fake 44 px; the real primitives replace them once they exist", async () => {
  const stubSource = await readFile(new URL("./home-todo-primitive-stub.ts", import.meta.url), "utf8");
  const geometrySource = await readFile(new URL("./home-todo-geometry.observer.test.ts", import.meta.url), "utf8");
  assert.match(geometrySource, /from\s+["']\.\/home-todo-primitive-stub\.ts["']/);
  assert.match(geometrySource, /contents:\s*primitiveStub\b/);
  assert.doesNotMatch(geometrySource, /const primitiveStub\s*=\s*`/);
  for (const banned of ["44", "minHeight", "minWidth", "min-height", "min-width", "<button", "<a ", "\"button\"", "\"a\"", "\"input\"", "tabIndex"])
    assert.equal(stubSource.includes(banned), false, `stand-ins contain ${banned}`);
  // Positive control: the detector sees pending() in a scaffold body and not in a real one.
  assert.equal(pendingSource(() => { const pending = (name: string) => name; return pending("x"); }), true);
  assert.equal(pendingSource((doc: Document) => doc.createElement("span")), false);
  assert.equal(implemented, !usedByLaneT.some(pendingSource));
});
