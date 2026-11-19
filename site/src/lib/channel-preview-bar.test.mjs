import assert from "node:assert/strict";
import { test } from "node:test";
import { renderChannelMembershipRetryBar, renderChannelPreviewBar } from "./channel-preview-bar.ts";

function previewRoot() {
  const focusCalls = [];
  const doc = {
    createElement(tag) {
      const el = {
        tag,
        className: "",
        textContent: "",
        type: "",
        disabled: false,
        hidden: false,
        isConnected: true,
        children: [],
        dataset: {},
        attrs: {},
        listeners: {},
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; },
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        addEventListener(k, fn) { this.listeners[k] = fn; },
        focus() { focusCalls.push(el); },
      };
      return el;
    },
  };
  const root = doc.createElement("div");
  root.ownerDocument = doc;
  return { root, focusCalls };
}

test("public channel preview bar joins once while busy, keeps preview open with Retry on refusal, and confirms on retry", async () => {
  const { root, focusCalls } = previewRoot();
  let calls = 0;
  let joined = 0;
  let finishFirst;
  let shouldSucceed = false;

  const { button, error } = renderChannelPreviewBar(root, {
    slug: "design",
    onJoin: () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => { finishFirst = resolve; });
      }
      return Promise.resolve(shouldSucceed ? { ok: true } : { ok: false, message: "Still unavailable." });
    },
    onJoined: () => { joined += 1; },
  });

  assert.equal(button.textContent, "Join #design");
  assert.equal(error.hidden, true);

  // Double-clicking while busy sends only one join request.
  const first = button.listeners.click();
  await button.listeners.click();
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  assert.equal(button.attrs["aria-busy"], "true");
  assert.equal(button.textContent, "Joining…");

  // Refusal keeps the preview open with Retry and keeps focus on the button.
  finishFirst({ ok: false, message: "That channel is archived, so nobody joins it." });
  await first;
  assert.equal(joined, 0);
  assert.equal(button.disabled, false);
  assert.equal(button.attrs["aria-busy"], undefined);
  assert.equal(button.textContent, "Retry");
  assert.equal(button.attrs["aria-label"], "Retry joining #design");
  assert.equal("channelPreviewRetry" in button.dataset, true);
  assert.equal(error.hidden, false);
  assert.equal(error.textContent, "That channel is archived, so nobody joins it.");
  assert.equal(focusCalls.at(-1), button);

  // Retrying after recovery calls onJoined so the caller replaces the preview with the composer.
  shouldSucceed = true;
  await button.listeners.click();
  assert.equal(calls, 2);
  assert.equal(joined, 1);
});

test("membership retry bar runs once while busy and keeps Retry focused when read stays failed", async () => {
  const { root, focusCalls } = previewRoot();
  let calls = 0;
  let release;
  const { button, error } = renderChannelMembershipRetryBar(root, {
    message: "Service unavailable.",
    onRetry: () => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });

  assert.equal(button.textContent, "Retry");
  assert.equal(error.attrs.role, "alert");
  assert.equal(error.textContent, "Service unavailable.");

  const first = button.listeners.click();
  await button.listeners.click();
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Checking…");

  release();
  await first;
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Retry");
  assert.equal(focusCalls.at(-1), button);
});
