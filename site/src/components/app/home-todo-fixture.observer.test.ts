import assert from "node:assert/strict";
import { test } from "node:test";
import { agentOrb, capsule, choiceChips, notice, personAvatar } from "../../lib/home-primitives.ts";

const primitiveStub = `
const span = (doc, text) => { const el = doc.createElement("span"); el.dataset.hmStub = ""; el.textContent = text; return el; };
export function personAvatar(doc, p) { return span(doc, p.initials); }
export function agentOrb(doc, a) { return span(doc, a.name.slice(0, 1)); }
export function capsule(doc, c) { return span(doc, c.person.name); }
export function statusLine(doc, s) { return span(doc, s.word); }
export function objectCard(doc, o) { return span(doc, o.title); }
export function needsYouCard(doc) { return span(doc, ""); }
export function choiceChips(doc, c) {
  const set = doc.createElement("fieldset"); set.dataset.hmStub = "";
  const legend = doc.createElement("legend"); legend.textContent = c.legend; set.append(legend);
  for (const option of c.options) set.append(span(doc, option.label));
  return set;
}
export function switchRow(doc, s) { return span(doc, s.label); }
export function queueRow(doc, q) { return span(doc, q.title); }
export function notice(doc, text, tone) { const el = doc.createElement("p"); el.dataset.hmStub = ""; el.dataset.tone = tone; el.textContent = text; return el; }
`;
const usedByLaneT = [personAvatar, agentOrb, capsule, choiceChips, notice];
const pendingSource = (fn: unknown) => /\bpending\s*\(/.test(Function.prototype.toString.call(fn));
const implemented = usedByLaneT.every((fn) => !pendingSource(fn));


test("geometry stand-ins render no targets and never fake 44 px; the real primitives replace them once they exist", () => {
  for (const banned of ["44", "minHeight", "minWidth", "min-height", "min-width", "<button", "<a ", "\"button\"", "\"a\"", "\"input\"", "tabIndex"])
    assert.equal(primitiveStub.includes(banned), false, `stand-ins contain ${banned}`);
  // Positive control: the detector sees pending() in a scaffold body and not in a real one.
  assert.equal(pendingSource(() => { const pending = (name: string) => name; return pending("x"); }), true);
  assert.equal(pendingSource((doc: Document) => doc.createElement("span")), false);
  assert.equal(implemented, !usedByLaneT.some(pendingSource));
});
