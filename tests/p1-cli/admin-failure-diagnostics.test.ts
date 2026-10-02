import assert from "node:assert/strict";
import { test } from "node:test";
import { safeAdminError } from "../../supabase/functions/command/failures.js";

test("admin failure diagnostics retain the internal error class and safe message", () => {
  const error = new Error("permission denied for table events");
  error.name = "PostgresError";
  assert.equal(safeAdminError(error), "PostgresError: permission denied for table events");
  assert.equal(safeAdminError(new TypeError("routine workspace stream missing")),
    "TypeError: routine workspace stream missing");
  assert.equal(safeAdminError({ message: "must not serialize arbitrary objects" }), "unknown error");
});

test("admin failure diagnostics remove credential material, SQL values and log controls before bounding", () => {
  const secrets = ["swm_adm_" + "a".repeat(43), "swm_adr_" + "b".repeat(43),
    "swm_agt_" + "c".repeat(43), "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhIn0.signature",
    "quoted-private-value", "https://user:password@example.test/path", "opaque-unquoted-secret"];
  const error = Object.assign(new Error(`invalid input ${secrets.slice(0, 4).join(" ")} "${secrets[4]}" ${secrets[5]} secret=${secrets[6]}\n\u001b\u202e`),
    { detail: "private database detail", query: "private SQL", parameters: ["private parameter"] });
  const diagnostic = safeAdminError(error);
  for (const secret of [...secrets, error.detail, error.query, ...error.parameters]) {
    assert.ok(!diagnostic.includes(secret));
  }
  assert.ok(!/[\n\u001b\u202e]/u.test(diagnostic));
  assert.match(diagnostic, /^Error: invalid input/u);
  assert.ok(safeAdminError(new Error("x".repeat(1000))).length <= 512);
});
