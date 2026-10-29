import assert from "node:assert/strict";
import { test } from "node:test";

import { authReturnError } from "./commonswarm.ts";

test("another auth error gets a plain sentence and never the raw description", () => {
  const message = authReturnError({ hash: "#error=server_error&error_description=secret+detail", search: "" });
  assert.equal(message, "That sign-in did not work.");
});
