import assert from "node:assert/strict";
import { test } from "node:test";
import { listenerPermissionMode } from "../../src/cli.js";

/* Historical ACP permission defaults, retained for compatibility. Since 0.1.61
 * the listener routes to the main session and starts no model. The incident below
 * describes the retired worker path.
 *
 * The default permission mode for a listener, pinned.
 *
 * WHY THIS FILE EXISTS AT ALL: the default was flipped from deny to allow and **747 tests passed
 * unchanged** — `npm test` 499/499 and `test:p1-cli` 248/248. Nothing exercised the omitted-flag
 * path in either direction. Two `permissionMode: "deny"` literals appear in the suite and both are
 * fixture fields being handed IN, not the resolver's answer. A default that can be inverted
 * silently is not a default anyone is holding.
 *
 * WHAT WAS MEASURED, 2026-08-11: on the two-agent dogfood (OpenCode; the other three providers
 * were not exercised) a worker started under `deny` had Bash and Write refused, so it could not
 * hash, persist, or initiate — and `cswarm listen status` reported it healthy throughout. The
 * agent on the other end read it as uncooperative. Operator direction the same day: "we want low
 * friction here by default."
 *
 * SCOPE OF `deny`, since the first version of this comment overstated it: deny governs only the
 * operations the PROVIDER raises a permission request for. Which those are is the provider's
 * choice, not ours.
 *
 * WHAT `allow` IS: allow-once PER REQUEST, falling back to deny when the host offers no such
 * option. Not a blanket grant. The permission-boundary canary forces deny regardless of the mode,
 * so the proof that CommonSwarm controls ACP permissions is untouched by this default.
 *
 * WHAT IS NOT ESTABLISHED: steady-state `allow` is unmeasured — the canary's own limit strings in
 * src/cli.ts say exactly that and remain true. This file pins the DEFAULT, not the safety of the
 * mode it selects. */

test("omitting --permissions selects allow, not deny", { timeout: 10_000 }, () => {
  assert.equal(listenerPermissionMode(undefined), "allow");
});

test("--permissions deny is still reachable, and still means deny", { timeout: 10_000 }, () => {
  /* CONTROL, and the one that carries the weight. "Low friction by default" is satisfiable by
   * deleting deny entirely, which would pass the assertion above while removing the only answer
   * for a listener that takes work from outside your account. The harder mode has to survive its
   * own demotion. */
  assert.equal(listenerPermissionMode("deny"), "deny");
  assert.equal(listenerPermissionMode("allow"), "allow");
});

test("an unrecognised value is still rejected rather than defaulted", { timeout: 10_000 }, () => {
  /* A resolver written as `value === "deny" ? "deny" : "allow"` passes both tests above and
   * silently upgrades a TYPO to allow — `--permissions den` would grant tool use. That is a worse
   * defect than the one being fixed, because the operator asked for the safe mode and got the
   * permissive one with no error. */
  assert.throws(() => listenerPermissionMode("den"), /must be deny or allow/);
  assert.throws(() => listenerPermissionMode("Allow"), /must be deny or allow/);
  assert.throws(() => listenerPermissionMode(""), /must be deny or allow/);
});

// Retired in 0.1.61: onboarding no longer launches ACP workers or chooses their
// permissions. The earlier tests required --permissions allow and every bridge;
// those assertions defended a setup path the listener no longer executes.
