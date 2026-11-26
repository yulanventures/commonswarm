import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { wirePasswordToggle } from "./password-visibility.ts";

function makeTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    dispatch(type) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  };
}

function makeFixture(initialType = "password") {
  const form = makeTarget();
  const attrs = new Map();
  const buttonTarget = makeTarget();
  const input = {
    type: initialType,
    disabled: false,
    form,
    get value() {
      throw new Error("wirePasswordToggle must never read input.value");
    },
    set value(_next) {
      throw new Error("wirePasswordToggle must never mutate input.value");
    },
  };
  const button = {
    disabled: false,
    textContent: "",
    setAttribute(name, value) {
      attrs.set(name, value);
    },
    getAttribute(name) {
      return attrs.get(name) ?? null;
    },
    addEventListener: buttonTarget.addEventListener,
    click() {
      buttonTarget.dispatch("click");
    },
  };
  return { form, input, button };
}

test("initializes to hidden password state and forces button type", () => {
  const { input, button } = makeFixture("text");
  wirePasswordToggle(input, button);
  assert.equal(input.type, "password");
  assert.equal(button.getAttribute("type"), "button");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.textContent, "Show");
  assert.equal(button.getAttribute("aria-label"), "Show password");
});

test("toggles between hidden and visible without touching input.value", () => {
  const { input, button } = makeFixture();
  wirePasswordToggle(input, button);

  button.click();
  assert.equal(input.type, "text");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.textContent, "Hide");
  assert.equal(button.getAttribute("aria-label"), "Hide password");

  button.click();
  assert.equal(input.type, "password");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.textContent, "Show");
  assert.equal(button.getAttribute("aria-label"), "Show password");
});

test("reset() forces masked state back from visible", () => {
  const { input, button } = makeFixture();
  const handle = wirePasswordToggle(input, button);

  button.click();
  assert.equal(input.type, "text");

  handle.reset();
  assert.equal(input.type, "password");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.textContent, "Show");
  assert.equal(button.getAttribute("aria-label"), "Show password");
});

test("resets automatically on enclosing form submit and reset events", () => {
  const { form, input, button } = makeFixture();
  wirePasswordToggle(input, button);

  button.click();
  assert.equal(input.type, "text");
  form.dispatch("submit");
  assert.equal(input.type, "password");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.textContent, "Show");

  button.click();
  assert.equal(input.type, "text");
  form.dispatch("reset");
  assert.equal(input.type, "password");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.textContent, "Show");
});

test("resolves enclosing form via closest() when input.form is absent", () => {
  const form = makeTarget();
  const { input, button } = makeFixture();
  input.form = null;
  input.closest = (selector) => (selector === "form" ? form : null);

  wirePasswordToggle(input, button);
  button.click();
  assert.equal(input.type, "text");
  form.dispatch("submit");
  assert.equal(input.type, "password");
});

test("does not reveal when input or button is disabled", () => {
  const { input, button } = makeFixture();
  wirePasswordToggle(input, button);

  input.disabled = true;
  button.click();
  assert.equal(input.type, "password");
  assert.equal(button.getAttribute("aria-pressed"), "false");

  input.disabled = false;
  button.disabled = true;
  button.click();
  assert.equal(input.type, "password");
  assert.equal(button.getAttribute("aria-pressed"), "false");
});

test("returns a safe no-op handle when input or button is null", () => {
  const { input, button } = makeFixture();
  assert.doesNotThrow(() => wirePasswordToggle(null, button).reset());
  assert.doesNotThrow(() => wirePasswordToggle(input, null).reset());
});

test("dashboard and invite password fields keep safe defaults, button types, forgot-password delegation, and reset wiring", async () => {
  const [dashboard, invite, inviteCss] = await Promise.all([
    readFile(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8"),
    readFile(new URL("../components/invite/InviteOnramp.astro", import.meta.url), "utf8"),
    readFile(new URL("../styles/kylon-invite-onramp.css", import.meta.url), "utf8"),
  ]);

  // Every password toggle and Forgot password control is type="button" (never submits).
  for (const id of ["dashboard-password", "dashboard-new-password", "add-account-password"]) {
    assert.match(dashboard, new RegExp(`type="button"\\s+data-password-toggle="${id}"`, "u"));
  }
  assert.match(invite, /type="button"\s+data-password-toggle="invite-password"/u);
  assert.match(dashboard, /type="button"\s+data-forgot-password\s+data-signin-only/u);
  assert.match(invite, /type="button"\s+data-forgot-password/u);

  // Forgot password delegates strictly to the existing email sign-in link/code trigger.
  assert.match(dashboard, /one<HTMLButtonElement>\("\[data-forgot-password\]"\)\?\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*one<HTMLButtonElement>\("\[data-email-link\]"\)\?\.click\(\);\s*\}\);/u);
  assert.match(invite, /one<HTMLButtonElement>\("\[data-forgot-password\]"\)\?\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*one<HTMLButtonElement>\("\[data-email-link\]"\)\?\.click\(\);\s*\}\);/u);

  // Reset invariants on view/entry switches, dialog close, and teardown.
  assert.match(dashboard, /signInPasswordToggle\.reset\(\);/u);
  assert.match(dashboard, /newPasswordToggle\.reset\(\);/u);
  assert.match(dashboard, /addAccountPasswordToggle\.reset\(\);/u);
  assert.match(invite, /const show = \(name: string\): void => \{\s*invitePasswordToggle\.reset\(\);/u);
  assert.match(invite, /const showInviteAuthStep = \(step: "entry" \| "code"\): void => \{\s*invitePasswordToggle\.reset\(\);/u);

  // Invite clutter removed (steps preview list and review tagline).
  assert.doesNotMatch(invite, /invite-onramp__steps/u);
  assert.doesNotMatch(invite, /invite-onramp__intro/u);
  assert.doesNotMatch(inviteCss, /invite-onramp__steps/u);
  assert.doesNotMatch(inviteCss, /invite-onramp__intro/u);
});
