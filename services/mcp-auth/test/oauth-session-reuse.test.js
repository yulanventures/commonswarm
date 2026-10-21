// P9a acceptance: dummy callbacks and HTTP consent exercise the real handler,
// P2 policy and P9b handoff. Outputs are redirects/errors/HTML and effect counts.
// Synthetic storage isolates wiring; P1/P2/P9c CI gates own DB/logout/provider proof.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createInteractionHandler, ensureSession } from "../src/interactions.js";
import { createFinishFlow } from "../src/finish-flow.js";
import { SESSION_COOKIE } from "../src/browser-security.js";

const issuer = "https://mcp.commonswarm.com", userId = "10000000-0000-4000-8000-000000000001";
const authId = "20000000-0000-4000-8000-000000000001", uid = "DUMMYINTERACTION";
const cookie = "DUMMYBROWSER-long-enough", csrf = "DUMMYCSRF-long-enough";
function fixture({ finish = true, failure = false, revokeOnConsume = false } = {}) {
  const at = Math.floor(Date.now() / 1000) - 120, expires = new Date((at + 604800) * 1000);
  let live = true, saved, completed = 0, activated = 0, finished = [], begun = 0;
  const session = { user_id: userId, user_email: "TEST@example.test", user_display_name: "TEST <human>",
    gotrue_session_id: authId, authenticated_at: new Date(at * 1000), expires_at: expires };
  const details = { uid, params: { client_id: "https://client.example/oauth.json",
    redirect_uri: "https://client.example/callback", resource: `${issuer}/mcp`, scope: "openid mcp",
    code_challenge: "a".repeat(43), state: "DUMMYSTATE" }, prompt: { name: "login" } };
  const consent = { user_id: userId, client_id: details.params.client_id, selected_workspace_ids: ["W1"],
    provider_grant_id: "DUMMYGRANT", commonswarm_grant_id: "DUMMYCOMMONGRANT" };
  const provider = { issuer, interactionDetails: async () => details,
    interactionFinished: async (_req, res, result) => {
      finished.push(result); res.writeHead(303, { location: "/authorize/DUMMYRESUME" }); res.end();
    }, Interaction: { find: async () => ({ persist: async function () { saved = this.lastSubmission; } }) },
    Client: { find: async () => ({ clientName: "TEST client" }) }, Grant: { find: async () => ({}) } };
  const store = { pool: { query: async () => ({ rows: live ? [{ session_id: authId, user_id: userId,
    authenticated_at: session.authenticated_at }] : [] }) },
    requireSession: async () => live ? session : { user_id: null }, createSession: async () => cookie,
    consumeSignIn: async () => ({ signin_pkce_verifier: "DUMMYVERIFIER", resource: `${issuer}/mcp` }),
    attachUser: async (_uid, _sid, identity) => {
      session.user_id = identity.id; session.user_email = identity.email; session.user_display_name = identity.displayName;
      session.gotrue_session_id = identity.gotrueSessionId;
      session.authenticated_at = identity.identityVerified ? new Date(identity.interactiveAuthAtSeconds * 1000) : null;
    }, rotateSession: async () => "DUMMYROTATED-long-enough",
    bindInteraction: async () => ({ ...consent, commonswarm_grant_id: null }),
    beginSignIn: async () => { begun++; }, issueConsentToken: async () => ({ token: csrf, selectionVersion: 0 }),
    consumeConsent: async () => { if (revokeOnConsume) live = false; return consent; },
    selectAndConsumeConsent: async () => consent,
    complete: async () => { completed++; } };
  const flow = finish ? createFinishFlow({ provider, store, finishStore: {
    prepareFinish: async (binding, input) => { saved = { binding, input }; },
  } }) : undefined;
  const handler = createInteractionHandler({ provider, store, finishFlow: flow,
    gotrue: { providers: ["google", "github"], exchange: async () => ({ identity: { userId,
      email: "TEST@example.test", displayName: "TEST <human>", identityVerified: true,
      gotrueSessionId: authId, interactiveAuthAtSeconds: at } }), begin: () => ({ url: `${issuer}/dummy-sign-in` }) },
    workspaceReader: async () => [{ id: "W1", name: "TEST Home" }],
    consentOrchestrator: { activate: async () => { activated++; if (failure) throw new Error("DUMMYFAILURE"); } },
    allowedOrigins: new Set([issuer]), callbackUrl: `${issuer}/oauth/callback/gotrue` });
  async function run(path = `/interaction/${uid}`, { method = "GET", form = false, origin = issuer } = {}) {
    const body = { selection_version: 0, home_workspace_id: "W1", workspace_ids: ["W1"], csrf_token: csrf };
    const req = Object.assign(Readable.from(method === "POST" ? [Buffer.from(form
      ? new URLSearchParams(body).toString() : JSON.stringify(body))] : []), { method,
      headers: { cookie: `${SESSION_COOKIE}=${cookie}`, origin, "x-cswarm-csrf": csrf,
        "content-type": form ? "application/x-www-form-urlencoded" : "application/json" } });
    const res = { status: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; },
      writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
      end(body = "") { this.body += body; } };
    assert.equal(await handler(req, res, new URL(path, issuer)), true);
    return res;
  }
  return { run, details, session, at, expires, setLive(value) { live = value; },
    state: () => ({ saved, completed, activated, finished, begun }) };
}

test("verified callback rotates the browser; the second connect reuses the live account and still asks consent", async () => {
  const h = fixture();
  h.session.user_id = null;
  const callback = await h.run(`/oauth/callback/gotrue?interaction=${uid}&state=DUMMYSTATE&code=DUMMYCODE&provider=github`);
  assert.equal(callback.status, 303);
  assert.match(callback.headers["set-cookie"], /DUMMYROTATED-long-enough/u);
  assert.match(callback.headers["set-cookie"], /; Max-Age=34560000$/u);
  assert.doesNotMatch(callback.headers["set-cookie"], /Domain=/iu);
  assert.equal(h.session.gotrue_session_id, authId);
  assert.equal(h.session.authenticated_at.getTime(), h.at * 1000);
  assert.equal(h.session.expires_at, h.expires);
  assert.equal(h.state().saved.login.ts, h.at);
  await h.run();
  assert.equal(h.state().finished[0].login.ts, h.at);
  h.details.prompt = { name: "consent", details: {} };
  const consent = await h.run();
  assert.match(consent.body, /Continue as/u);
  assert.match(consent.body, /TEST &lt;human&gt;/u);
  assert.match(consent.body, /Use another account/u);
  assert.equal(h.state().begun, 0);
  assert.equal(h.state().activated, 0);
});

test("forced/stale/unproved reuse fails; silent requests get provider errors without UI", async () => {
  for (const params of [{ prompt: "login" }, { max_age: "0" }, { max_age: "1" }]) {
    const h = fixture(); Object.assign(h.details.params, params);
    const res = await h.run();
    assert.equal(res.status, 400); assert.equal(JSON.parse(res.body).error, "unsupported_fresh_login");
    assert.equal(h.state().finished.length, 0); assert.equal(h.state().begun, 0);
  }
  const fresh = fixture(); fresh.details.params.max_age = "600";
  await fresh.run(); assert.equal(fresh.state().finished.length, 1);
  const unproved = fixture(); unproved.session.gotrue_session_id = null;
  assert.equal((await unproved.run()).status, 403); assert.equal(unproved.state().finished.length, 0);
  for (const [revoked, promptName, expected] of [[true, "login", "login_required"], [false, "consent", "interaction_required"]]) {
    const h = fixture(); h.setLive(!revoked); h.details.params.prompt = "none"; h.details.prompt = { name: promptName, details: {} };
    const res = await h.run(); assert.equal(res.status, 303); assert.equal(res.body, "");
    assert.equal(h.state().finished[0].error, expected); assert.equal(h.state().activated, 0);
  }
  const revoked = fixture(); revoked.setLive(false);
  const res = await revoked.run(); assert.match(res.body, /Continue with/u);
  assert.equal(revoked.state().finished.length, 0);
});

test("activation delegates form/JSON to the same bound finish; disabled finish keeps immediate handoff", async () => {
  for (const form of [false, true]) {
    const h = fixture(); h.details.prompt = { name: "consent", details: {} };
    const res = await h.run(`/interaction/${uid}/consent`, { method: "POST", form });
    assert.equal(res.status, 303); assert.equal(res.headers.location, `/interaction/${uid}/connected`);
    assert.equal(res.headers["cache-control"], "no-store"); assert.equal(res.headers["referrer-policy"], "no-referrer");
    const state = h.state(); assert.equal(state.activated, 1); assert.equal(state.completed, 1); assert.equal(state.finished.length, 0);
    assert.deepEqual(state.saved.binding.request, { clientId: h.details.params.client_id, redirectUri: h.details.params.redirect_uri,
      resource: `${issuer}/mcp`, scopes: ["openid", "mcp"], pkceChallenge: "a".repeat(43), oauthState: "DUMMYSTATE" });
    assert.equal(state.saved.binding.sessionId, cookie); assert.equal(state.saved.binding.userId, userId);
    assert.deepEqual(state.saved.input.providerResult, { consent: { grantId: "DUMMYGRANT" } });
    assert.equal(state.saved.input.displayModel.homeWorkspaceName, "TEST Home");
    assert.equal(state.saved.input.displayModel.workspaceCount, 1);
    assert.doesNotMatch(JSON.stringify(state.saved.input.displayModel), /DUMMYSTATE|DUMMYCODE|DUMMYGRANT|callback/u);
  }
  const off = fixture({ finish: false }); off.details.prompt = { name: "consent", details: {} };
  const res = await off.run(`/interaction/${uid}/consent`, { method: "POST" });
  assert.equal(res.headers.location, "/authorize/DUMMYRESUME"); assert.equal(off.state().finished.length, 1);
});

test("failed activation and forbidden Origin cannot prepare Connected or resume the provider", async () => {
  for (const form of [false, true]) {
    const h = fixture({ failure: true }); h.details.prompt = { name: "consent", details: {} };
    const res = await h.run(`/interaction/${uid}/consent`, { method: "POST", form });
    assert.equal(res.status, 502); assert.equal(h.state().saved, undefined); assert.equal(h.state().completed, 0);
    assert.equal(h.state().finished.length, 0);
    if (!form) assert.equal(JSON.parse(res.body).inactive, true);
  }
  const h = fixture(); h.details.prompt = { name: "consent", details: {} };
  const denied = await h.run(`/interaction/${uid}/consent`, { method: "POST", origin: "https://other.example" });
  assert.equal(denied.status, 403); assert.equal(h.state().activated, 0); assert.equal(h.state().saved, undefined);
  assert.equal((await h.run(`/interaction/${uid}/consent`, { method: "POST" })).status, 303);
});

test("revocation after consent consumption prevents activation and finish, with a live control", async () => {
  for (const revoked of [true, false]) {
    const h = fixture({ revokeOnConsume: revoked }); h.details.prompt = { name: "consent", details: {} };
    const res = await h.run(`/interaction/${uid}/consent`, { method: "POST" });
    assert.equal(res.status, revoked ? 502 : 303);
    assert.equal(h.state().activated, revoked ? 0 : 1);
    assert.equal(h.state().saved !== undefined, !revoked);
  }
});

// Cookie retention belongs at the HTTP boundary; the real store/PG test owns
// live binding/adoption, so this test supplies only that boundary's outcomes.
test("verified reuse renews the same persistent handle; a transient lookup cannot replace or clear it", async () => {
  for (const failure of [false, true]) {
    const headers = new Map(); let created = 0;
    const request = { headers: { cookie: `${SESSION_COOKIE}=${cookie}` } };
    const response = { setHeader: (k, v) => headers.set(k, v) };
    const error = Object.assign(new Error("DUMMY database unavailable"), { code: "ECONNRESET" });
    const store = { requireSession: async () => { if (failure) throw error; return { user_id: userId }; },
      createSession: async () => { created++; return "DUMMYUNVERIFIED-new-handle"; } };
    if (failure) {
      await assert.rejects(ensureSession(request, response, store), { code: "ECONNRESET" });
      assert.equal(headers.has("set-cookie"), false);
    } else {
      const reused = await ensureSession(request, response, store);
      assert.equal(reused.id, cookie);
      assert.equal(headers.get("set-cookie"), `${SESSION_COOKIE}=${cookie}; Secure; HttpOnly; Path=/; SameSite=Lax; Max-Age=34560000`);
    }
    assert.equal(created, 0);
  }
});
