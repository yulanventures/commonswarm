/** CS-E04: a person's command transaction admits its session before it plans, locks or writes
 * anything else, so a queued credential change (exclusive fence lock) can never wait between this
 * transaction's own row locks. Source order is the contract here; the lock behaviour itself is
 * proven against the database in tests/p1-server/credential-change-fence.test.ts. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../supabase/functions/command/index.ts", import.meta.url), "utf8");

function after(from: number, needle: string): number {
  const at = source.indexOf(needle, from);
  assert.ok(at >= 0, `missing: ${needle}`);
  return at;
}

test("the generic transaction admits a person right after setTransaction, before any planning or lock", () => {
  const start = after(0, "const result = await (async (): Promise<HttpResult> => {");
  const setTx = after(start, "await setTransaction(tx);");
  const admit = after(start, "admitHumanSession(tx, verifiedHuman)");
  assert.ok(setTx < admit, "admission follows setTransaction");
  for (const later of ["assertHouseholdContentServiceReady(tx)", "invitationTokenForRoute(body)", "planLocalOperation(",
    "lockLocalAuthPlan(", "authenticateHuman(tx, verifiedHuman)"]) {
    assert.ok(admit < after(start, later), `admission precedes ${later}`);
  }
  // Nothing between setTransaction and the admission statement touches the database.
  const statement = after(start, "if (verifiedHuman !== null && !(await admitHumanSession(tx, verifiedHuman)))");
  assert.doesNotMatch(source.slice(setTx + "await setTransaction(tx);".length, statement), /tx`|await /);
});

test("the seat-admin and admin-account runners admit before the account upsert", () => {
  for (const runner of ["async function runSeatAdminCommand", "async function runAdminAccountCommand"]) {
    const start = after(0, runner);
    const setTx = after(start, "await setTransaction(tx);");
    const admit = after(start, "admitHumanSession(tx,");
    const upsert = after(start, "await authenticateHuman(tx,");
    assert.ok(setTx < admit && admit < upsert, runner);
  }
  // authenticateHuman itself only upserts; admission is never folded back into it.
  const body = source.slice(after(0, "async function authenticateHuman("), after(0, "async function authenticateHuman(") + 1200);
  assert.doesNotMatch(body, /admit_human_session/);
});
