/** Stand-ins used only while home-primitives.ts still calls pending(). They render no targets. */
export const primitiveStub = `
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
