import assert from "node:assert/strict";
import { test } from "node:test";
import { FITTED, clampView, closeUpScale, fittedSize, maxScale, zoomAbout } from "./image-viewer.ts";

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
