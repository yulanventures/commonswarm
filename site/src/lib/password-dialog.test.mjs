import assert from "node:assert/strict";
import { test } from "node:test";
import { PasswordDialogGuard } from "./password-dialog.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

test("a ticket is live only for the opening user and the current generation", () => {
  const guard = new PasswordDialogGuard();
  const ticket = guard.open(A);
  assert.equal(guard.live(ticket, A), true);
  assert.equal(guard.live(ticket, B), false, "another account in this tab cannot use A's dialog");
  assert.equal(guard.live(ticket, null), false, "a signed-out page cannot use it");
  assert.equal(guard.live(null, A), false);
});

test("sign-out or a different account ends the dialog; a token refresh for the same account does not", () => {
  const guard = new PasswordDialogGuard();
  const ticket = guard.open(A);
  assert.equal(guard.observeAuth("TOKEN_REFRESHED", A), false);
  assert.equal(guard.live(ticket, A), true);
  assert.equal(guard.observeAuth("SIGNED_IN", B), true, "account switch in another tab");
  assert.equal(guard.live(ticket, A), false);
  const again = guard.open(A);
  assert.equal(guard.observeAuth("SIGNED_OUT", A), true, "sign-out in another tab");
  assert.equal(guard.live(again, A), false);
  assert.equal(guard.observeAuth("SIGNED_OUT", null), false, "nothing open: nothing to close");
});

test("a late completion from an earlier opening is dropped after close or reopen", () => {
  const guard = new PasswordDialogGuard();
  const first = guard.open(A);
  guard.reset(); // closed while Save was in flight
  assert.equal(guard.live(first, A), false);
  const second = guard.open(A); // reopened by the same account
  assert.equal(guard.live(first, A), false, "the first opening's reply never updates the second");
  assert.equal(guard.live(second, A), true);
});

test("the dashboard closes the dialog on auth events and sends every call with the opening account's session", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  assert.match(source, /onAuthStateChange\(\(event, nextSession\) => \{\s*\/\/[^\n]*\n\s*if \(passwordGuard\.observeAuth\(event, nextSession\?\.user\.id\)\) closePasswordDialog\(\);/);
  assert.match(source, /setPassword\(ownSession\(ticket\), fresh\.value/);
  assert.match(source, /sendPasswordCode\(ownSession\(ticket\)\)/);
  assert.match(source, /signOutOtherDevices\(ownSession\(ticket\)\)/);
  assert.doesNotMatch(source, /setPassword\(fresh\.value|sendPasswordCode\(\)/, "no call may use the SDK's current session");
  // After each awaited call the dialog re-checks its ticket before touching the page.
  assert.ok((source.match(/if \(!passwordGuard\.live\(ticket, session\?\.user\.id\)\) return;/g) ?? []).length >= 4);
});
