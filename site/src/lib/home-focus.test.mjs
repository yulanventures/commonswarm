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
