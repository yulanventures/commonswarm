/** CI only; registered by the component-observer glob, never launches locally. */
import assert from "node:assert/strict";
import { browserTest as test } from "../../../tests/chrome.js";
import { imagePreviewFixture } from "./chat-image-preview.fixture.js";
import { imagePreviewDriver } from "./chat-image-preview.driver.fixture.js";

test("chat images use cross-origin image requests without CORS, retry once, and keep Download navigation", { timeout: 90_000 }, async () => {
  const fixture = await imagePreviewFixture();
  const { requests, storageOrigin } = fixture;
  const driver = imagePreviewDriver(fixture.origin, fixture.started, requests);
  try {
    const observation = await driver.observe();
    assert.equal(observation.error, undefined);
    const preview = observation.preview;
    assert.ok(preview, "image loading must finish before Download navigation");
    assert.equal(preview.corsFetchRejected, true, "the fetch control must reproduce missing CORS");
    assert.equal(preview.currentCachedUrl, `${storageOrigin}/storage/v1/object/sign/normal/1`,
      "the fresh signed URL must be stored before checking its expiry");
    assert.equal(preview.returnedExpiryUsed, true, "the signing client's 60s expiry must reach the cache");
    assert.deepEqual(preview.counts, { normal: 1, recover: 2, broken: 2 });
    for (const id of ["normal", "recover"]) {
      assert.ok(preview.images[id].width > 0, `${id} PNG must decode`);
      assert.equal(preview.images[id].state, null);
      assert.equal(preview.images[id].alt, `${id}.png`);
      assert.equal(preview.images[id].referrerPolicy, "no-referrer");
      assert.equal(preview.images[id].loading, "lazy");
      assert.equal(preview.images[id].crossOrigin, null);
    }
    assert.equal(preview.images.broken.width, 0);
    assert.equal(preview.images.broken.state, "unavailable");
    assert.equal(preview.images.broken.alt, "broken.png preview unavailable");
    assert.ok(preview.imageTimingTypes.length >= 5);
    assert.ok(preview.imageTimingTypes.every(type => type === "img"), "storage previews must not use fetch/XHR");
    const imageRequests = requests.filter(request => request.path.startsWith("/storage/") && request.resourceType === "image");
    assert.equal(imageRequests.length, 5);
    assert.ok(imageRequests.every(request => request.mode === "no-cors" && request.referer === undefined));
    assert.ok(requests.some(request => request.path === "/control" && request.mode === "cors"));
    assert.equal(observation.download, `${storageOrigin}/storage/v1/object/sign/normal/2`);
    assert.ok(requests.some(request => request.path.endsWith("/normal/2") && request.resourceType === "iframe" && request.mode === "navigate"));
  } catch (error) {
    throw await driver.failure(error);
  } finally {
    try { await driver.close(); } finally { await fixture.close(); }
  }
});
