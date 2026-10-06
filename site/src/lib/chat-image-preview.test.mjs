import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  canPreviewChatImage,
  ChatImagePreviewCache,
  chatImagePreviewFailure,
} from "./chat-image-preview.ts";

test("chat previews allow only PNG, JPEG, GIF and WebP", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    assert.equal(canPreviewChatImage(type), true, type);
  }
  for (const type of ["image/svg+xml", "image/heic", "text/html", "", "image/jpg"]) {
    assert.equal(canPreviewChatImage(type), false, type);
  }
});

test("preview cache isolates files and versions, and reuses links inside their lifetime", () => {
  const cache = new ChatImagePreviewCache();
  cache.remember("photo", 1, { url: "https://storage.example/one" }, 100_000);
  assert.equal(cache.get("photo", 1, 200_000), "https://storage.example/one");
  assert.equal(cache.get("photo", 2, 200_000), undefined);
  assert.equal(cache.get("another-photo", 1, 200_000), undefined);
  cache.remember("photo", 2, { url: "https://storage.example/two" }, 100_000);
  cache.forget("photo", 1);
  assert.equal(cache.get("photo", 1, 200_000), undefined);
  assert.equal(cache.get("photo", 2, 200_000), "https://storage.example/two");
  cache.clear();
  assert.equal(cache.get("photo", 2, 200_000), undefined);
});

test("links are not reused at the 30 second margin, within it, or after expiry", () => {
  for (const now of [370_000, 380_000, 400_000, 401_000]) {
    const cache = new ChatImagePreviewCache();
    cache.remember("photo", 1, { url: "https://storage.example/one" }, 100_000);
    assert.equal(cache.get("photo", 1, 369_999), "https://storage.example/one");
    assert.equal(cache.get("photo", 1, now), undefined, `now=${now}`);
  }
});

test("the returned expiry overrides the fallback measured from signing start", () => {
  const cache = new ChatImagePreviewCache();
  cache.remember("photo", 1, { url: "https://storage.example/short", expiresAt: 160_000 }, 100_000);
  assert.equal(cache.get("photo", 1, 129_999), "https://storage.example/short");
  assert.equal(cache.get("photo", 1, 130_000), undefined);
  cache.remember("photo", 1, { url: "https://storage.example/fresh", expiresAt: 500_000 }, 130_000);
  assert.equal(cache.get("photo", 1, 400_000), "https://storage.example/fresh");
});

test("a failed image gets one retry, then the unavailable state", () => {
  assert.equal(chatImagePreviewFailure(0), "retry");
  assert.equal(chatImagePreviewFailure(1), "unavailable");
  assert.equal(chatImagePreviewFailure(2), "unavailable");
});

// Independent transport contract: signed storage images must use the image loader,
// which works without CORS. Controls prove the prohibition reaches each old path.
const forbiddenPreviewTransport = (source) =>
  /\bfetch\s*\(|\bcreateObjectURL\s*\(|\bcrossOrigin\b|\bcrossorigin\b/i.test(source);

test("chat attachment rendering cannot fetch blobs or opt into CORS", () => {
  for (const fixture of [
    "const response = await fetch(signedUrl);",
    "image.src = URL.createObjectURL(blob);",
    'image.crossOrigin = "anonymous";',
    'image.setAttribute("crossorigin", "anonymous");',
  ]) assert.equal(forbiddenPreviewTransport(fixture), true, fixture);
  const dashboard = readFileSync(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  const start = dashboard.indexOf("const renderMessageAttachments =");
  const end = dashboard.indexOf("\n    };", start);
  assert.ok(start >= 0 && end > start, "the renderer must be present for this probe");
  assert.equal(forbiddenPreviewTransport(dashboard.slice(start, end)), false);
});
