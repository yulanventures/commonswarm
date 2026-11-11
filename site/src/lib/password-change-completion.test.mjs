import assert from "node:assert/strict";
import { test } from "node:test";
import { completePasswordChange } from "./password-change-completion.ts";

// CS-E04: what follows a successful password change, bound to the account that changed it.
const A = { userId: "aaaaaaaa-0000-4000-8000-000000000001", accessToken: "token-a" };
const B = "bbbbbbbb-0000-4000-8000-000000000002";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A page: which account it shows (or none), and a completion that stays current until superseded. */
function page() {
  const state = { shown: A.userId, current: true, logoutTokens: [], checks: 0 };
  return { state, live: () => state.current && (state.shown === null || state.shown === A.userId) };
}

test("a confirmed logout and a removed local copy sign this device out", async () => {
  const { state, live } = page();
  const outcome = await completePasswordChange(A, {
    signOutEverywhere: async (token) => { state.logoutTokens.push(token); },
    verifyCurrent: async () => { state.checks += 1; state.shown = null; return { kind: "expired" }; },
    live,
  });
  assert.deepEqual(outcome, { kind: "signed-out", remote: "ended" });
  assert.deepEqual(state.logoutTokens, ["token-a"], "the server logout uses the opening account's own token");
});

test("account B signing in while the local check is pending supersedes A's completion, resolved or rejected", async () => {
  for (const settle of ["resolve-b", "resolve-expired", "reject"]) {
    const { state, live } = page();
    const check = deferred();
    const running = completePasswordChange(A, {
      signOutEverywhere: async () => {},
      verifyCurrent: () => check.promise,
      live,
    });
    await new Promise((r) => setImmediate(r));
    state.shown = B; // a peer account signs in while A's local shutdown is paused
    if (settle === "resolve-b") check.resolve({ kind: "session", userId: B });
    else if (settle === "resolve-expired") check.resolve({ kind: "expired" });
    else check.reject(new Error("lock lost"));
    assert.deepEqual(await running, { kind: "superseded" }, settle);
  }
});

test("account B signing in during the server logout skips A's local check entirely", async () => {
  const { state, live } = page();
  const logout = deferred();
  const running = completePasswordChange(A, {
    signOutEverywhere: () => logout.promise,
    verifyCurrent: async () => { state.checks += 1; return { kind: "expired" }; },
    live,
  });
  await new Promise((r) => setImmediate(r));
  state.shown = B;
  logout.resolve();
  assert.deepEqual(await running, { kind: "superseded" });
  assert.equal(state.checks, 0, "B's credential is never checked or removed on A's behalf");
});

test("a newer completion supersedes an older one", async () => {
  const { state, live } = page();
  const check = deferred();
  const running = completePasswordChange(A, { signOutEverywhere: async () => {}, verifyCurrent: () => check.promise, live });
  await new Promise((r) => setImmediate(r));
  state.current = false;
  check.resolve({ kind: "expired" });
  assert.deepEqual(await running, { kind: "superseded" });
});

test("a refused, failed or unanswered server logout is reported unconfirmed, never as every session ended", async () => {
  for (const failure of [new Error("HTTP 500"), new TypeError("network"), new Error("timeout")]) {
    const { live } = page();
    // The account's session is still live here: nothing removed it.
    const still = await completePasswordChange(A, {
      signOutEverywhere: async () => { throw failure; },
      verifyCurrent: async () => ({ kind: "session", userId: A.userId }),
      live,
    });
    assert.deepEqual(still, { kind: "still-signed-in", remote: "unconfirmed" }, failure.message);
    // The server had already ended it (a later change revoked it): this device is signed out, still unconfirmed.
    const gone = await completePasswordChange(A, {
      signOutEverywhere: async () => { throw failure; },
      verifyCurrent: async () => ({ kind: "expired" }),
      live: page().live,
    });
    assert.deepEqual(gone, { kind: "signed-out", remote: "unconfirmed" }, failure.message);
  }
});

test("a local check that fails or throws is an unknown outcome, not a sign-out", async () => {
  for (const verifyCurrent of [async () => ({ kind: "unknown" }), async () => { throw new Error("storage"); }]) {
    const outcome = await completePasswordChange(A, { signOutEverywhere: async () => {}, verifyCurrent, live: page().live });
    assert.deepEqual(outcome, { kind: "unknown", remote: "ended" });
  }
});

test("no account left on this device is signed out", async () => {
  const outcome = await completePasswordChange(A, {
    signOutEverywhere: async () => {}, verifyCurrent: async () => ({ kind: "none" }), live: page().live,
  });
  assert.deepEqual(outcome, { kind: "signed-out", remote: "ended" });
});
