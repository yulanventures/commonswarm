/**
 * The Add an agent invite uses the server's limits. Reached by test:p1-cli's glob.
 * `npm test` names this file too, so the pure gate runs it.
 */
import test from "node:test";
import { assertJoinLimitsMatchEnforcement } from "./h0-link-join-limits.js";

test("join invite limits match the command edge, the migration, and the document path", async () => {
  await assertJoinLimitsMatchEnforcement();
});
