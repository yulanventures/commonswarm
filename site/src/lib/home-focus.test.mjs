/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { replaceHomeRegion } from "./home-focus.ts";

/* Just enough of a document for a region swap: controls with data attributes, no layout. */
const focused = [];
const control = (tag, dataset) => ({
  tag, dataset: { ...dataset }, id: "", className: "", attributes: [], tabIndex: 0,
  hasAttribute(name) { return name.replace(/^data-/, "").replace(/-(.)/g, (_, c) => c.toUpperCase()) in this.dataset; },
  getAttribute() { return null; },
  matches(selector) { return selector.split(",").some((part) => part.trim() === this.tag); },
  closest() { return null; },
  getClientRects() { return [{}]; },
  focus() { focused.push(this); },
});
/** One rail row: its link and its menu button. */
const row = (id) => {
  const link = control("a", { railChannel: id }), menu = control("button", { railChannelMenu: id });
  return { link, menu, querySelectorAll: () => [link, menu] };
};
const region = () => {
  const doc = { activeElement: null };
  const slot = {
    ownerDocument: doc, rows: [], tabIndex: 0,
    controls() { return this.rows.flatMap((item) => [item.link, item.menu]); },
    contains(node) { return this.controls().includes(node); },
    querySelector: () => null,
    querySelectorAll(selector) { return selector === "[data-home-focus-key]" ? this.controls().filter((node) => node.dataset.homeFocusKey) : []; },
    replaceChildren(...rows) { this.rows = rows; },
    matches: () => false,
    focus() { focused.push(this); },
  };
  return { doc, slot };
};

test("a redrawn rail keeps focus on the same row or menu button, and leaves focus alone when it is elsewhere", () => {
  const { doc, slot } = region();
  const first = [row("ch-1"), row("ch-2")];
  replaceHomeRegion(slot, "rail", first);
  assert.deepEqual(focused, [], "nothing was focused, so nothing is");

  // Focus on a row's menu button; the rail is redrawn in a new order.
  doc.activeElement = first[1].menu;
  const second = [row("ch-2"), row("ch-1")];
  replaceHomeRegion(slot, "rail", second);
  assert.deepEqual(focused, [second[0].menu], "the new button for the same channel, wherever it now sits");

  // Focus on a row itself.
  focused.length = 0;
  doc.activeElement = second[1].link;
  const third = [row("ch-1"), row("ch-2")];
  replaceHomeRegion(slot, "rail", third);
  assert.deepEqual(focused, [third[0].link]);

  // The person has moved to something outside the rail before the redraw.
  focused.length = 0;
  doc.activeElement = control("textarea", {});
  replaceHomeRegion(slot, "rail", [row("ch-2"), row("ch-1")]);
  assert.deepEqual(focused, [], "focus outside the rail is never taken");
});

test("Catch up's rebuild keeps focus on the same card's control, a later checkbox included, and the Other caret", () => {
  /* Two needs-you cards (two workspaces' asks), each with two checkboxes and an Other field: elements that know their
     ancestors, so the real markFocusKeys reads the card and the decision around each control. */
  const element = (tag, dataset, parent, extra = {}) => {
    const el = { tagName: tag.toUpperCase(), dataset: { ...dataset }, id: "", className: "", tabIndex: 0, parent, ...extra,
      get attributes() { return Object.keys(this.dataset).map(key => ({ name: `data-${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}` })); },
      hasAttribute(name) { return this.attributes.some(attribute => attribute.name === name); },
      getAttribute() { return null; },
      matches(selector) { return selector.split(",").some(part => part.trim().split(/[[ ]/)[0] === tag); },
      closest(selector) {
        const key = selector.match(/^\[data-([a-z-]+)\]$/)?.[1]?.replace(/-(.)/g, (_, c) => c.toUpperCase());
        for (let at = this; at; at = at.parent) if (key && key in at.dataset) return at;
        return null;
      },
      getClientRects() { return [{}]; },
      focus() { doc.activeElement = this; focusLog.push(this); },
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    };
    return el;
  };
  const doc = { activeElement: null }; const focusLog = [];
  const card = (workspace, ask) => {
    const root = element("article", { needsYou: ask, needsWorkspace: workspace }, null);
    const decision = element("div", { decision: ask }, root);
    const controls = [
      element("input", { decisionOption: "kitchen" }, decision, { type: "checkbox" }),
      element("input", { decisionOption: "meter" }, decision, { type: "checkbox" }),
      element("input", { decisionOtherInput: "" }, decision, { type: "text", value: "", selectionStart: 0, selectionEnd: 0 }),
    ];
    return { root, controls, querySelectorAll: () => controls };
  };
  const slot = {
    ownerDocument: doc, cards: [], tabIndex: 0,
    all() { return this.cards.flatMap(item => item.controls); },
    contains(node) { return this.all().includes(node); },
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === "[data-home-focus-key]") return this.all().filter(node => node.dataset.homeFocusKey);
      if (selector === "textarea, input[type=text]") return this.all().filter(node => node.type === "text");
      return [];
    },
    replaceChildren(...cards) { this.cards = cards; },
    matches: () => false, focus() { focusLog.push(this); },
  };
  const first = [card("W1", "ask-a"), card("W2", "ask-b")];
  replaceHomeRegion(slot, "catchup", first);
  const keys = slot.all().map(node => node.dataset.homeFocusKey);
  assert.equal(new Set(keys).size, keys.length, "every control of both cards has its own key");

  // A later checkbox on the second card.
  doc.activeElement = first[1].controls[1];
  const second = [card("W1", "ask-a"), card("W2", "ask-b")];
  replaceHomeRegion(slot, "catchup", second);
  assert.equal(doc.activeElement, second[1].controls[1], "the same card's meter checkbox, not the first card's first one");

  // The second card's Other field, its caret in the middle of the text.
  const field = second[1].controls[2];
  Object.assign(field, { value: "the side gate", selectionStart: 4, selectionEnd: 4 });
  doc.activeElement = field;
  const third = [card("W1", "ask-a"), card("W2", "ask-b")];
  third[1].controls[2].value = "the side gate"; // the card is rebuilt from its draft
  replaceHomeRegion(slot, "catchup", third);
  assert.equal(doc.activeElement, third[1].controls[2]);
  assert.deepEqual([third[1].controls[2].selectionStart, third[1].controls[2].selectionEnd], [4, 4], "the caret stays where it was");
  assert.equal(third[0].controls[2].selectionStart, 0, "the other card's field is untouched");
});
