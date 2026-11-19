import assert from "node:assert/strict";
import { test } from "node:test";
import { FITTED, clampView, closeUpScale, fittedSize, maxScale, openImageViewer, zoomAbout } from "./image-viewer.ts";

const near = (a, b) => Math.abs(a - b) < 1e-9;

test("a picture is fitted whole, and a small one is not blown up", () => {
  assert.deepEqual(fittedSize({ w: 4000, h: 2000 }, { w: 1000, h: 800 }), { w: 1000, h: 500 });
  assert.deepEqual(fittedSize({ w: 1000, h: 4000 }, { w: 1000, h: 800 }), { w: 200, h: 800 });
  assert.deepEqual(fittedSize({ w: 320, h: 200 }, { w: 1000, h: 800 }), { w: 320, h: 200 });
});

test("Zoom goes to actual size, or to twice the size of a picture already shown at its own", () => {
  assert.equal(closeUpScale({ w: 4000, h: 2000 }, { w: 1000, h: 500 }), 4);
  assert.equal(closeUpScale({ w: 320, h: 200 }, { w: 320, h: 200 }), 2);
  assert.equal(maxScale({ w: 4000, h: 2000 }, { w: 1000, h: 500 }), 8);
  assert.equal(maxScale({ w: 320, h: 200 }, { w: 320, h: 200 }), 4);
});

test("zooming about a point keeps what is under the point under it", () => {
  const point = { x: 120, y: -40 };
  const from = { scale: 1.5, x: 30, y: 10 };
  const to = zoomAbout(from, 3, point);
  // The picture-local position under the point is (point - translate) / scale, before and after.
  for (const axis of ["x", "y"]) assert.ok(near((point[axis] - from[axis]) / from.scale, (point[axis] - to[axis]) / to.scale), axis);
  assert.deepEqual(zoomAbout(FITTED, 2, { x: 0, y: 0 }), { scale: 2, x: 0, y: 0 });
});

test("the picture cannot be dragged off the stage, and the scale stays in range", () => {
  const fitted = { w: 1000, h: 500 }, stage = { w: 1000, h: 800 };
  // At 2x it is 2000x1000: 500 of reach sideways, 100 up and down.
  assert.deepEqual(clampView({ scale: 2, x: 9000, y: -9000 }, fitted, stage, 8), { scale: 2, x: 500, y: -100 });
  assert.deepEqual(clampView({ scale: 2, x: -9000, y: 9000 }, fitted, stage, 8), { scale: 2, x: -500, y: 100 });
  // Where it is still smaller than the stage it stays centred.
  assert.deepEqual(clampView({ scale: 1.2, x: 50, y: 300 }, fitted, stage, 8), { scale: 1.2, x: 50, y: 0 });
  // Fitted cannot move at all, and the scale cannot leave its range.
  assert.deepEqual(clampView({ scale: 0.4, x: 70, y: 70 }, fitted, stage, 8), FITTED);
  assert.equal(clampView({ scale: 40, x: 0, y: 0 }, fitted, stage, 8).scale, 8);
});

test("trailing keypress, keyup and repeat keydown from opening Enter/Space are blocked until a keydown starts inside the viewer", () => {
  const makeNode = (tag) => {
    const listeners = [];
    const node = {
      tagName: tag.toUpperCase(), className: "", dataset: {}, hidden: false, open: false, children: [],
      style: { removeProperty() {}, setProperty() {} },
      setAttribute() {}, toggleAttribute() {}, removeAttribute() {},
      append(...kids) { this.children.push(...kids); this.firstElementChild = this.children[0]; },
      querySelector() { return { setAttribute() {} }; },
      addEventListener(type, fn, capture = false) { listeners.push({ type, fn, capture: Boolean(capture) }); },
      removeEventListener() {},
      dispatch(type, props = {}) {
        const event = { type, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
        for (const l of listeners) if (l.type === type) l.fn(event);
        return event;
      },
      showModal() { this.open = true; },
      close() { this.open = false; this.dispatch("close"); },
      remove() {},
    };
    return node;
  };
  const win = { matchMedia: () => ({ matches: true }), addEventListener() {}, removeEventListener() {} };
  const doc = { defaultView: win, activeElement: null, createElement: makeNode, createElementNS: (_ns, tag) => makeNode(tag) };
  const host = { ownerDocument: doc, append() {} };
  const dialog = openImageViewer(host, { name: "boiler-label.png", link: () => new Promise(() => {}), forget() {}, download() {} }, () => {});
  assert.equal(dialog.open, true);
  // Trailing events from the keystroke that opened the dialog must be cancelled before they can click autofocused Close.
  assert.equal(dialog.dispatch("keypress", { key: "Enter" }).defaultPrevented, true, "trailing Enter keypress is cancelled");
  assert.equal(dialog.dispatch("keyup", { key: " " }).defaultPrevented, true, "trailing Space keyup is cancelled");
  assert.equal(dialog.dispatch("keydown", { key: "Enter", repeat: true }).defaultPrevented, true, "initial repeat keydown is cancelled");
  assert.equal(dialog.open, true, "viewer stays open");
  // Once a fresh keydown starts inside the viewer, keypress and keyup proceed normally.
  assert.equal(dialog.dispatch("keydown", { key: "Enter", repeat: false }).defaultPrevented, false);
  assert.equal(dialog.dispatch("keypress", { key: "Enter" }).defaultPrevented, false, "keypress after keydown inside viewer is allowed");
  assert.equal(dialog.dispatch("keyup", { key: " " }).defaultPrevented, false, "keyup after keydown inside viewer is allowed");
});
