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
    dispatch(type, event) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
}

function makeFixture(initialType = "password", autocomplete = "current-password") {
  const form = makeTarget();
  const win = makeTarget();
  const inputAttrs = new Map([["autocomplete", autocomplete]]);
  const attrs = new Map();
  const buttonTarget = makeTarget();
  const input = {
    type: initialType,
    disabled: false,
    spellcheck: true,
    form,
    ownerDocument: { defaultView: win },
    setAttribute(name, value) {
      inputAttrs.set(name, value);
    },
    getAttribute(name) {
      return inputAttrs.get(name) ?? null;
    },
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
  return { form, win, input, button };
}

function assertTextAssistanceOptOuts(input, expectedAutocomplete = "current-password") {
  assert.equal(input.spellcheck, false);
  assert.equal(input.getAttribute("spellcheck"), "false");
  assert.equal(input.getAttribute("autocorrect"), "off");
  assert.equal(input.getAttribute("autocapitalize"), "none");
  assert.equal(input.getAttribute("writingsuggestions"), "false");
  assert.equal(input.getAttribute("autocomplete"), expectedAutocomplete);
}

test("initializes to hidden password state, pins text-assistance opt-outs, and forces button type", () => {
  const { input, button } = makeFixture("text", "new-password");
  wirePasswordToggle(input, button);
  assert.equal(input.type, "password");
  assertTextAssistanceOptOuts(input, "new-password");
  assert.equal(button.getAttribute("type"), "button");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.textContent, "Show");
  assert.equal(button.getAttribute("aria-label"), "Show password");
});

test("toggles between hidden and visible without touching input.value and re-pins opt-outs on reveal", () => {
  const { input, button } = makeFixture("password", "current-password");
  wirePasswordToggle(input, button);

  // Tamper with text-assistance attributes before reveal to prove runtime pinning.
  input.spellcheck = true;
  input.setAttribute("spellcheck", "true");
  input.setAttribute("autocorrect", "on");
  input.setAttribute("autocapitalize", "sentences");
  input.setAttribute("writingsuggestions", "true");

  button.click();
  assert.equal(input.type, "text");
  assertTextAssistanceOptOuts(input, "current-password");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.textContent, "Hide");
  assert.equal(button.getAttribute("aria-label"), "Hide password");

  button.click();
  assert.equal(input.type, "password");
  assertTextAssistanceOptOuts(input, "current-password");
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

test("remasks synchronously on pagehide and persisted pageshow, allows fresh reveal control, and never touches input.value", () => {
  const { win, input, button } = makeFixture("password", "current-password");
  wirePasswordToggle(input, button);

  button.click();
  assert.equal(input.type, "text");
  assertTextAssistanceOptOuts(input, "current-password");

  // Synchronous departure remasking.
  win.dispatch("pagehide", { persisted: true });
  assert.equal(input.type, "password");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.textContent, "Show");
  assert.equal(button.getAttribute("aria-label"), "Show password");
  assertTextAssistanceOptOuts(input, "current-password");

  // Tamper state as if a bfcache snapshot restored a revealed field; persisted pageshow remasks.
  input.type = "text";
  button.setAttribute("aria-pressed", "true");
  button.textContent = "Hide";
  win.dispatch("pageshow", { persisted: true });
  assert.equal(input.type, "password");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.textContent, "Show");
  assertTextAssistanceOptOuts(input, "current-password");

  // Fresh explicit reveal control still succeeds after navigation events.
  button.click();
  assert.equal(input.type, "text");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.textContent, "Hide");
  assertTextAssistanceOptOuts(input, "current-password");

  // Non-persisted pageshow does not disturb an actively revealed field.
  win.dispatch("pageshow", { persisted: false });
  assert.equal(input.type, "text");
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.textContent, "Hide");
});

test("supports explicit targetWindow override for pagehide and persisted pageshow", () => {
  const explicitWin = makeTarget();
  const { win: ownerWin, input, button } = makeFixture("password", "new-password");
  wirePasswordToggle(input, button, explicitWin);

  button.click();
  assert.equal(input.type, "text");

  // Owner window is ignored when caller supplies an explicit targetWindow.
  ownerWin.dispatch("pagehide", { persisted: true });
  assert.equal(input.type, "text");

  explicitWin.dispatch("pagehide", { persisted: true });
  assert.equal(input.type, "password");
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.textContent, "Show");
  assertTextAssistanceOptOuts(input, "new-password");
});

test("returns a safe no-op handle when input or button is null", () => {
  const { input, button } = makeFixture();
  assert.doesNotThrow(() => wirePasswordToggle(null, button).reset());
  assert.doesNotThrow(() => wirePasswordToggle(input, null).reset());
});

test("dashboard and invite password fields keep safe defaults, text-assistance opt-outs, button types, forgot-password delegation, and reset wiring", async () => {
  const [dashboard, invite, inviteCss] = await Promise.all([
    readFile(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8"),
    readFile(new URL("../components/invite/InviteOnramp.astro", import.meta.url), "utf8"),
    readFile(new URL("../styles/kylon-invite-onramp.css", import.meta.url), "utf8"),
  ]);

  // All 4 revealable password inputs declare all 4 text-assistance opt-outs while preserving autocomplete.
  const extractInputTag = (source, id) => {
    const match = source.match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`, "u"));
    assert.ok(match, `expected input#${id} in source markup`);
    return match[0];
  };
  const expectedInputs = [
    { source: dashboard, id: "dashboard-password", autocomplete: "current-password" },
    { source: dashboard, id: "dashboard-new-password", autocomplete: "new-password" },
    { source: dashboard, id: "add-account-password", autocomplete: "current-password" },
    { source: invite, id: "invite-password", autocomplete: "current-password" },
  ];
  for (const { source, id, autocomplete } of expectedInputs) {
    const tag = extractInputTag(source, id);
    assert.match(tag, /type="password"/u, `${id} must default to type="password"`);
    assert.match(tag, new RegExp(`autocomplete="${autocomplete}"`, "u"), `${id} must preserve autocomplete="${autocomplete}"`);
    assert.match(tag, /spellcheck="false"/u, `${id} must declare spellcheck="false"`);
    assert.match(tag, /autocapitalize="none"/u, `${id} must declare autocapitalize="none"`);
    assert.match(tag, /autocorrect="off"/u, `${id} must declare autocorrect="off"`);
    assert.match(tag, /writingsuggestions="false"/u, `${id} must declare writingsuggestions="false"`);
  }

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

  // Reset invariants on view/entry switches, dialog close, pagehide, and teardown.
  assert.match(dashboard, /signInPasswordToggle\.reset\(\);/u);
  assert.match(dashboard, /newPasswordToggle\.reset\(\);/u);
  assert.match(dashboard, /addAccountPasswordToggle\.reset\(\);/u);
  assert.match(
    dashboard,
    /window\.addEventListener\("pagehide",\s*\(\)\s*=>\s*\{[\s\S]*?resetSignInPasswordVisibility\(\);[\s\S]*?resetAddAccountPasswordVisibility\(\);[\s\S]*?resetChangePasswordVisibility\(\);[\s\S]*?flushComposerDraft\(\);/u,
  );
  assert.match(invite, /const show = \(name: string\): void => \{\s*invitePasswordToggle\.reset\(\);/u);
  assert.match(invite, /const showInviteAuthStep = \(step: "entry" \| "code"\): void => \{\s*invitePasswordToggle\.reset\(\);/u);

  // Invite clutter removed (steps preview list and review tagline).
  assert.doesNotMatch(invite, /invite-onramp__steps/u);
  assert.doesNotMatch(invite, /invite-onramp__intro/u);
  assert.doesNotMatch(inviteCss, /invite-onramp__steps/u);
  assert.doesNotMatch(inviteCss, /invite-onramp__intro/u);
});
