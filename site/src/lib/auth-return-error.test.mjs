import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { authReturnError } from "./commonswarm.ts";

const EXPIRED = "That sign-in link has expired or was already used.";

test("an expired link in the hash says it expired or was already used", () => {
  const hash = "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired";
  assert.equal(authReturnError({ hash, search: "" }), EXPIRED);
});

test("the same error in the query string is read the same way", () => {
  assert.equal(authReturnError({ hash: "", search: "?error_code=otp_expired&error=access_denied" }), EXPIRED);
});

test("another auth error gets a plain sentence and never the raw description", () => {
  const message = authReturnError({ hash: "#error=server_error&error_description=secret+detail", search: "" });
  assert.equal(message, "That sign-in did not work.");
});

test("control: an address without an auth error shows no message", () => {
  assert.equal(authReturnError({ hash: "", search: "" }), null);
  assert.equal(authReturnError({ hash: "#access_token=abc&type=magiclink", search: "?w=123" }), null);
});

test("the sign-in view reads the error once and offers a resend action; the button is wired", () => {
  const source = readFileSync(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  assert.match(source, /let returnedAuthError = authReturnError\(window\.location\)/);
  assert.match(source, /data-auth-link-error-text/);
  assert.match(source, /data-auth-resend>Send a new link<\/button>/);
  assert.match(source, /authLinkError\(returnedAuthError\);\s*returnedAuthError = null;/);
  assert.match(source, /\[data-auth-resend\]"\)\?\.addEventListener\("click"/);
});
