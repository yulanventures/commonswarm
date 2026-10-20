import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import {
  login,
  logout,
  logoutMessage,
  refreshedCredential,
  HumanSessionError,
  humanSessionFetch,
  validateCallbackUrl,
} from "../../src/cloud/auth.js";
import { encodeInviteLink } from "../../src/cloud/invite-link.js";
import { ThinCommandClient } from "../../src/cloud/command-client.js";
import { cloudTarget } from "../../src/cloud/config.js";
import {
  readCurrentTarget,
  writeCurrentTarget,
} from "../../src/cloud/current-target.js";
import {
  type CredentialProfile,
  credentialStore,
  type CredentialRecord,
  type CredentialStore,
  defaultCredentialStateDirectory,
  withFileLock,
} from "../../src/cloud/storage.js";

// The config directory moved from ~/.coswarm to ~/.cswarm with the CommonSwarm rename,
// and nothing else in the suite pins it. A half-reverted rename would otherwise only
// show up as an install that has silently forgotten its login.
test("default credential state is ~/.cswarm/credentials.d, not the pre-rename path", () => {
  assert.equal(
    defaultCredentialStateDirectory(),
    join(homedir(), ".cswarm", "credentials.d"),
  );
});

class MemoryCredentialStore implements CredentialStore {
  readonly kind = "keychain" as const;
  readonly location = "test memory";
  record: CredentialRecord | null = null;
  profile: CredentialProfile = {
    version: 1,
    userId: null,
    workspaceId: null,
    pendingCommands: {},
  };

  async read(): Promise<CredentialRecord | null> {
    return this.record ? { ...this.record } : null;
  }

  async write(record: CredentialRecord): Promise<void> {
    this.record = { ...record };
  }

  async delete(): Promise<void> {
    this.record = null;
  }

  async readProfile(): Promise<CredentialProfile> {
    return structuredClone(this.profile);
  }

  async writeProfile(profile: CredentialProfile): Promise<void> {
    this.profile = structuredClone(profile);
  }

  async withLock<T>(work: () => Promise<T>): Promise<T> {
    return await work();
  }
}

function sink(): { output: Writable; text(): string } {
  let value = "";
  return {
    output: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    text: () => value,
  };
}

async function authServer(): Promise<{
  url: string;
  close(): Promise<void>;
  setChallenge(value: string): void;
  workspaceId: string;
  registrations(): number;
}> {
  let expectedChallenge: string | null = null;
  let registrationCount = 0;
  const workspaceId = randomUUID();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      request.method === "POST" &&
      url.pathname === "/functions/v1/command"
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        command?: { kind?: string; device_id?: string };
      };
      assert.equal(request.headers.authorization, "Bearer test-access-token");
      assert.equal(body.command?.kind, "register_device");
      assert.match(String(body.command?.device_id), /^[0-9a-f-]{36}$/i);
      registrationCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "accepted",
        ok: true,
        event_ids: [],
        device_id: body.command?.device_id,
      }));
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/rest/v1/memberships"
    ) {
      assert.equal(request.headers.authorization, "Bearer test-access-token");
      assert.equal(request.headers["accept-profile"], "swarm_read");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{ workspace_id: workspaceId }]));
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/auth/v1/token") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      auth_code?: string;
      code_verifier?: string;
    };
    assert.equal(body.auth_code, "test-auth-code");
    assert.ok(body.code_verifier);
    assert.equal(
      createHash("sha256").update(body.code_verifier).digest("base64url"),
      expectedChallenge,
      "the verifier held by the CLI must match the browser challenge",
    );
    const now = new Date().toISOString();
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({
      access_token: "test-access-token",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "test-rotating-refresh-token",
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        aud: "authenticated",
        role: "authenticated",
        email: "dogfood@example.test",
        email_confirmed_at: now,
        phone: "",
        confirmed_at: now,
        last_sign_in_at: now,
        app_metadata: { provider: "github", providers: ["github"] },
        user_metadata: {},
        identities: [],
        created_at: now,
        updated_at: now,
        is_anonymous: false,
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      ),
    setChallenge(value: string) {
      expectedChallenge = value;
    },
    workspaceId,
    registrations: () => registrationCount,
  };
}

async function refreshServer(options: {
  delayMs?: number;
  afterRotation?: (generation: number) => Promise<void>;
  failures?: Array<{ status: number; code: string }>;
  apiStatus?: number;
  apiCode?: string;
  apiRejectUntil?: number;
  dropAfterRotation?: boolean;
  beforeRefusal?: () => Promise<void>;
  delaySecondApiRefusalMs?: number;
} = {}): Promise<{
  url: string;
  close(): Promise<void>;
  refreshes(): number;
  attempts(): number;
  apiCalls: Array<{ body: string; authorization: string; requestId: string }>;
  logouts(): number;
  logoutScopes(): string[];
}> {
  let refreshCount = 0;
  let attempts = 0;
  const apiCalls: Array<{ body: string; authorization: string; requestId: string }> = [];
  let logoutCount = 0;
  const logoutScopes: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/functions/v1/") || url.pathname.startsWith("/rest/v1/")) {
      let body = "";
      for await (const chunk of request) body += chunk;
      apiCalls.push({ body, authorization: String(request.headers.authorization), requestId: String(request.headers["x-request-id"]) });
      const refused = options.apiStatus !== undefined && (options.apiStatus !== 401 || refreshCount < (options.apiRejectUntil ?? 2));
      if (refused && apiCalls.length === 2 && options.delaySecondApiRefusalMs) {
        await new Promise(resolve => setTimeout(resolve, options.delaySecondApiRefusalMs));
      }
      response.writeHead(refused ? options.apiStatus! : 200, { "content-type": "application/json" });
      response.end(JSON.stringify(refused ? { error: options.apiCode ?? "unauthenticated" } :
        url.pathname.startsWith("/rest/") ? [] : { status: "accepted", ok: true, event_ids: [] }));
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/auth/v1/token" &&
      url.searchParams.get("grant_type") === "refresh_token"
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        refresh_token?: string;
      };
      attempts += 1;
      const failure = options.failures?.shift();
      if (failure) {
        await options.beforeRefusal?.();
        if (failure.status === 0) request.socket.destroy();
        else response.writeHead(failure.status, { "content-type": "application/json" }).end(JSON.stringify({ code: failure.code }));
        return;
      }
      if (body.refresh_token !== `refresh-${refreshCount}`) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ code: "refresh_token_already_used" }));
        return;
      }
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
      refreshCount += 1;
      await options.afterRotation?.(refreshCount);
      if (options.dropAfterRotation) { request.socket.destroy(); return; }
      const now = new Date().toISOString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: `access-${refreshCount}`,
        token_type: "bearer",
        expires_in: 3600,
        refresh_token: `refresh-${refreshCount}`,
        user: {
          id: "22222222-2222-4222-8222-222222222222",
          aud: "authenticated",
          role: "authenticated",
          email: "refresh@example.test",
          app_metadata: { provider: "github", providers: ["github"] },
          user_metadata: {},
          identities: [],
          created_at: now,
          updated_at: now,
          is_anonymous: false,
        },
      }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/auth/v1/logout") {
      logoutCount += 1;
      logoutScopes.push(url.searchParams.get("scope") ?? "global");
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      ),
    refreshes: () => refreshCount,
    attempts: () => attempts,
    apiCalls,
    logouts: () => logoutCount,
    logoutScopes: () => [...logoutScopes],
  };
}

test("state mismatch is rejected for callback and copy/paste paths", () => {
  const origin = "http://127.0.0.1:54321";
  assert.throws(
    () =>
      validateCallbackUrl(
        `${origin}/callback?state=attacker&code=injected`,
        origin,
        "expected-state",
      ),
    /state mismatch/,
  );
  assert.equal(
    validateCallbackUrl(
      `${origin}/callback?state=expected-state&code=good-code`,
      origin,
      "expected-state",
    ),
    "good-code",
  );
});

test("PKCE loopback holds verifier client-side and preserves the compact refresh record", async () => {
  const server = await authServer();
  const credentials = new MemoryCredentialStore();
  const output = sink();
  const input = new PassThrough();
  try {
    const result = await login({
      target: cloudTarget(server.url, "test-anon-key"),
      store: credentials,
      input,
      output: output.output,
      openBrowser: async (authorizationUrl) => {
        const authorize = new URL(authorizationUrl);
        server.setChallenge(authorize.searchParams.get("code_challenge")!);
        const callback = new URL(authorize.searchParams.get("redirect_to")!);
        assert.ok(callback.searchParams.get("state"));
        callback.searchParams.set("code", "test-auth-code");
        const response = await fetch(callback);
        assert.equal(response.status, 200);
        return true;
      },
      timeoutMs: 2_000,
      pasteFallbackDelayMs: 1_000,
    });
    assert.equal(result.userId, "11111111-1111-4111-8111-111111111111");
    assert.equal(credentials.record?.refreshToken, "test-rotating-refresh-token");
    assert.equal(credentials.record?.generation, 0);
    assert.ok(credentials.record?.deviceId);
    assert.equal(result.workspaceId, server.workspaceId);
    assert.equal(credentials.profile.workspaceId, server.workspaceId);
    assert.equal(credentials.profile.userId, result.userId);
    assert.equal(result.email, "dogfood@example.test");
    assert.equal(credentials.profile.email, "dogfood@example.test");
    assert.equal(server.registrations(), 1);
    assert.doesNotMatch(output.text(), /paste the complete callback/i);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(
      JSON.stringify(credentials.record).includes("test-access-token"),
      false,
      "access cache must not enlarge the compact refresh record",
    );
  } finally {
    input.end();
    await server.close();
  }
});

test("no-browser path prints the OAuth URL and verifies pasted callback state", async () => {
  const server = await authServer();
  const credentials = new MemoryCredentialStore();
  const input = new PassThrough();
  const output = sink();
  try {
    const result = await login({
      target: cloudTarget(server.url, "test-anon-key"),
      store: credentials,
      input,
      output: output.output,
      openBrowser: async (authorizationUrl) => {
        const authorize = new URL(authorizationUrl);
        server.setChallenge(authorize.searchParams.get("code_challenge")!);
        const callback = new URL(authorize.searchParams.get("redirect_to")!);
        callback.searchParams.set("code", "test-auth-code");
        setTimeout(() => input.write(`${callback}\n`), 10);
        return false;
      },
      timeoutMs: 2_000,
    });
    assert.equal(result.userId, "11111111-1111-4111-8111-111111111111");
    assert.match(output.text(), /Open this URL/);
    assert.match(output.text(), /paste the complete callback/i);
  } finally {
    input.end();
    await server.close();
  }
});

test("refresh rotates under generation control and logout revokes then wipes", async () => {
  const server = await refreshServer();
  const targetStateDirectory = await mkdtemp(
    join(tmpdir(), "cswarm-logout-target-"),
  );
  const credentials = new MemoryCredentialStore();
  credentials.record = {
    version: 1,
    refreshToken: "refresh-0",
    generation: 4,
    deviceId: randomUUID(),
    userId: "22222222-2222-4222-8222-222222222222",
  };
  const target = cloudTarget(server.url, "test-anon-key");
  try {
    await writeCurrentTarget(target, {
      stateDirectory: targetStateDirectory,
    });
    const refreshed = await refreshedCredential(target, credentials);
    assert.equal(refreshed.accessToken, "access-1");
    assert.equal(credentials.record?.refreshToken, "refresh-1");
    assert.equal(credentials.record?.generation, 5);
    assert.equal(server.refreshes(), 1);
    assert.equal(await logout(target, credentials), "revoked");
    assert.equal(server.refreshes(), 2);
    assert.equal(server.logouts(), 1);
    assert.deepEqual(server.logoutScopes(), ["local"]);
    assert.equal(credentials.record, null);
    assert.deepEqual(
      await readCurrentTarget({ stateDirectory: targetStateDirectory }),
      target,
      "local logout removes auth but keeps the non-secret target pointer",
    );

    credentials.record = {
      version: 1,
      refreshToken: "refresh-2",
      generation: 7,
      deviceId: randomUUID(),
      userId: "22222222-2222-4222-8222-222222222222",
    };
    assert.equal(await logout(target, credentials, "global"), "revoked");
    assert.equal(server.refreshes(), 3);
    assert.equal(server.logouts(), 2);
    assert.deepEqual(server.logoutScopes(), ["local", "global"]);
    assert.deepEqual(
      await readCurrentTarget({ stateDirectory: targetStateDirectory }),
      target,
      "global logout revokes sessions but does not forget which host to re-login to",
    );
  } finally {
    await server.close();
    await rm(targetStateDirectory, { recursive: true, force: true });
  }
});

// One server, many response shapes: the point of these cases is CONTRAST. The earlier
// regression tested a single terminal shape and passed while the code deleted credentials on
// transient errors too -- it could not tell the fix from the bug.
async function refreshFailureServer(status: number, body: unknown): Promise<{
  target: ReturnType<typeof cloudTarget>;
  close(): Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return {
    target: cloudTarget(`http://127.0.0.1:${address.port}`, "test-anon-key"),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function storeWith(token: string): { store: MemoryCredentialStore; record: CredentialRecord } {
  const record: CredentialRecord = {
    version: 1,
    refreshToken: token,
    generation: 1,
    deviceId: randomUUID(),
    userId: "33333333-3333-4333-8333-333333333333",
  };
  const store = new MemoryCredentialStore();
  store.record = { ...record };
  return { store, record };
}

test("logout RETAINS the credential for every non-terminal refresh failure", async () => {
  // Each of these was previously deleted. A 429 is the sharpest: it is server-answered, so
  // the transport check does not catch it, yet it is explicitly a "try again later"
  // condition and the token is untouched.
  const transient: Array<[string, number, unknown]> = [
    ["429 rate limit", 429, { code: "over_request_rate_limit", msg: "Request rate limit reached" }],
    // (a server-answered 5xx is the same AuthRetryableFetchError class as the closed-port
    //  case below, which covers it for a fraction of the retry-backoff cost)
    ["400 legacy invalid_grant with no code", 400, { error: "invalid_grant", error_description: "Invalid Refresh Token" }],
    ["418 unrecognised", 418, { code: "some_future_code", msg: "unknown" }],
  ];
  for (const [label, status, body] of transient) {
    const server = await refreshFailureServer(status, body);
    const { store, record } = storeWith("possibly-still-valid");
    try {
      await assert.rejects(
        () => logout(server.target, store),
        /credential was kept/,
        `${label}: must not be reported as an expired session`,
      );
      assert.deepEqual(
        store.record,
        record,
        `${label}: the credential must survive, because a failed refresh does not imply a dead token`,
      );
    } finally {
      await server.close();
    }
  }

  // Pure transport failure: nothing answers at all. Port 1 is closed.
  const { store, record } = storeWith("possibly-still-valid");
  await assert.rejects(
    () => logout(cloudTarget("http://127.0.0.1:1", "test-anon-key"), store),
    /credential was kept/,
    "unreachable server: must not be reported as an expired session",
  );
  assert.deepEqual(store.record, record, "unreachable server: the credential survives");
});

test("logout --local clears the device without contacting the server", async () => {
  // NOT "always" (Plumb). This proves the SERVER is never contacted and the credential is
  // removed from THIS store. It cannot prove a clean device in general: production deletion
  // can throw -- storage.ts raises on a non-zero, non-44 Keychain code, and the file store
  // can fail too. The old name promised what the assertions do not reach.
  // The escape hatch that makes retain-by-default safe: when local storage CAN be changed, an
  // unclassifiable failure has a way out of the status-fails/logout-fails corner. NOT "never
  // leaves a user stuck" -- that universal is false when the delete itself throws, and it
  // survived here as a sibling claim after the test NAME was fixed, which is the exact shape
  // the AGENTS.md claim-granularity rule describes.
  const server = await refreshFailureServer(429, { code: "over_request_rate_limit" });
  const { store } = storeWith("unknown-state");
  try {
    assert.equal(await logout(server.target, store, "local", { localOnly: true }), "cleared-unverified");
    assert.equal(store.record, null, "the device is clean");
  } finally {
    await server.close();
  }
});

test("logout copy claims a revocation ONLY when the server confirmed one", async () => {
  // The copy IS the fix on this lane. Three earlier versions asserted a containment they had
  // not established, and the worst of them printed "Every refresh session for this identity
  // was revoked" after a no-op. So every line is asserted here, not just the happy one.
  const claims = (outcome: Parameters<typeof logoutMessage>[0], all: boolean) =>
    logoutMessage(outcome, all);

  // ONLY the confirmed path may say the server confirmed it.
  assert.match(claims("revoked", true), /server confirmed/);
  assert.match(claims("revoked", true), /confirmed the account-wide sign-out/);
  // AND MUST NOT claim more than a 200 establishes: the endpoint revokes refresh tokens;
  // already-issued access JWTs live until they expire. The previous version of this
  // assertion REQUIRED /every session/, so the test was enforcing the overclaim.
  assert.doesNotMatch(claims("revoked", true), /every session/);
  // AND NOT the same claim in different words (Plumb's second survivor): "Signed out on all
  // devices" asserts account-wide COMPLETION, which a 200 does not establish -- the endpoint
  // revokes refresh tokens while already-issued access JWTs can still authorize a device.
  // The first clause had to change too; fixing only the second left the claim standing.
  assert.doesNotMatch(claims("revoked", true), /on all devices/);
  assert.match(claims("revoked", false), /server confirmed it/);
  assert.match(claims("revoked", false), /other machines stay signed in/);

  // THE CONTROL, and it is the whole point: no other outcome may claim confirmation or
  // account-wide containment, on EITHER flag setting.
  for (const outcome of ["already-logged-out", "local-only", "cleared-unverified"] as const) {
    for (const all of [true, false]) {
      const line = claims(outcome, all);
      assert.doesNotMatch(line, /confirmed/, `${outcome}/${all} must not claim confirmation`);
      assert.doesNotMatch(line, /account-wide/, `${outcome}/${all} must not claim containment`);
      assert.doesNotMatch(line, /revoked for/, `${outcome}/${all} must not claim revocation`);
    }
  }

  // The unconfirmed paths must route the user somewhere, not just report failure.
  assert.match(claims("cleared-unverified", false), /--all-devices/);
  assert.match(claims("local-only", false), /other devices are unaffected/);

  // No provider internals leak into user-facing copy (GoTrue shipped in these strings once).
  for (const outcome of ["already-logged-out", "revoked", "local-only", "cleared-unverified"] as const) {
    assert.doesNotMatch(claims(outcome, true), /GoTrue|Supabase/i);
  }
});

test("logout REFUSES to clear or claim anything when the server rejects the sign-out", async () => {
  // auth-js's signOut swallows 401/403/404 from /logout and returns error:null. The outcome
  // must not be a word that asserts the server agreed.
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/auth/v1/token") {
      const now = new Date().toISOString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        access_token: "a", token_type: "bearer", expires_in: 3600, refresh_token: "rotated-refresh-two",
        user: { id: "33333333-3333-4333-8333-333333333333", aud: "authenticated", role: "authenticated",
          app_metadata: {}, user_metadata: {}, created_at: now, updated_at: now },
      }));
      return;
    }
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: "forbidden", msg: "nope" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  const { store } = storeWith("live-token");
  const before = { ...store.record! };
  try {
    // The high-level SDK call swallows this 403 and returns error:null. Using it would make
    // the CLI print "the server confirmed it" about a request the server REFUSED.
    await assert.rejects(
      () => logout(cloudTarget(`http://127.0.0.1:${address.port}`, "test-anon-key"), store, "global"),
      /did not confirm the session ended/,
      "a refused sign-out must not be reported as success",
    );
    // The credential must SURVIVE -- the session is live and unrevoked, so this is the only
    // handle for retrying. It is expected to be ROTATED rather than identical: the refresh
    // consumed the old token, and persisting the new one is what makes "run cswarm logout
    // again" work on a token we actually hold instead of on GoTrue's parent-token grace.
    assert.notEqual(store.record, null, "the retry handle must not be destroyed");
    // deviceId is ours and must be stable; userId is the SERVER's and is refreshed from the
    // session, matching what refreshedCredential already does.
    assert.equal(store.record!.deviceId, before.deviceId);
    assert.notEqual(
      store.record!.refreshToken,
      before.refreshToken,
      "the rotated token must be persisted, or the retry uses a spent credential",
    );
    assert.equal(store.record!.generation, before.generation + 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("logout non-author control: 404 and 500 retain the rotated credential without inventing a refusal", async () => {
  // A non-2xx response establishes that the sign-out was not confirmed. It does not
  // establish why: 404 can be a missing route or version skew, and 500 is a server
  // failure rather than an intentional refusal. Both must retain the only retry handle,
  // and both need observation-only copy.
  const copyObservations: Array<{
    status: number;
    reportsObservation: boolean;
    inventsRefusal: boolean;
    inventsNoAnswer: boolean;
  }> = [];
  for (const status of [404, 500]) {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/auth/v1/token") {
        const now = new Date().toISOString();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          access_token: `access-${status}`,
          token_type: "bearer",
          expires_in: 3600,
          refresh_token: `rotated-${status}`,
          user: {
            id: "33333333-3333-4333-8333-333333333333",
            aud: "authenticated",
            role: "authenticated",
            app_metadata: {},
            user_metadata: {},
            created_at: now,
            updated_at: now,
          },
        }));
        return;
      }
      if (url.pathname === "/auth/v1/logout") {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: `logout_${status}`, msg: "not confirmed" }));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    const { store, record } = storeWith(`original-${status}`);
    let failure: unknown;
    try {
      await logout(
        cloudTarget(`http://127.0.0.1:${address.port}`, "test-anon-key"),
        store,
        "global",
      );
    } catch (error) {
      failure = error;
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    assert.ok(failure instanceof Error, `HTTP ${status}: logout must fail`);
    copyObservations.push({
      status,
      reportsObservation: /server did not confirm/i.test(failure.message),
      inventsRefusal: /server refused/i.test(failure.message),
      inventsNoAnswer: /could not reach the server/i.test(failure.message),
    });
    assert.notEqual(store.record, null, `HTTP ${status}: retain the retry handle`);
    assert.equal(store.record!.refreshToken, `rotated-${status}`);
    assert.equal(store.record!.generation, record.generation + 1);
    assert.equal(store.record!.deviceId, record.deviceId);
  }
  assert.deepEqual(
    copyObservations,
    [
      {
        status: 404,
        reportsObservation: true,
        inventsRefusal: false,
        inventsNoAnswer: false,
      },
      {
        status: 500,
        reportsObservation: true,
        inventsRefusal: false,
        inventsNoAnswer: false,
      },
    ],
    "both HTTP failures must report only that sign-out was not confirmed",
  );
});

test("logout with a terminal refresh refusal and no journal clears locally instead of wedging", async t => {
  for (const { status, code } of [
    { status: 400, code: "refresh_token_not_found" },
    { status: 403, code: "session_not_found" },
    { status: 404, code: "session_expired" },
  ]) await t.test(`${status}/${code}`, async () => {
    // Regression: logout used to throw when refreshSession failed, which meant it never
    // reached store.delete(). A user whose session had expired was told by `status` to log
    // in, but `logout` -- the obvious way to reset -- failed and left the credential on
    // disk. There was no way out of that state from the CLI.
    let refreshAttempts = 0, logoutAttempts = 0;
    const server = await createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/auth/v1/token") {
        // A NAMED terminal condition. The legacy `invalid_grant` shape carries no code, so it
        // is deliberately NOT terminal any more -- it retains and routes the user to
        // `--local` instead. That case is covered in the retain test above.
        refreshAttempts += 1;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            code,
            error_code: code,
            msg: "Fixture terminal session refusal",
          }),
        );
        return;
      }
      if (url.pathname === "/auth/v1/logout") logoutAttempts += 1;
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    const target = cloudTarget(`http://127.0.0.1:${address.port}`, "test-anon-key");
    const credentials = new MemoryCredentialStore();
    credentials.record = {
      version: 1,
      refreshToken: "expired-token",
      generation: 1,
      deviceId: randomUUID(),
      userId: "33333333-3333-4333-8333-333333333333",
    };
    try {
      assert.equal((await credentials.readProfile()).humanSession?.successor, undefined, "no journal can recover this parent");
      assert.equal(
        await logout(target, credentials),
        "local-only",
        "an unrevokable session reports local-only, so the caller never claims a revocation",
      );
      assert.equal(
        credentials.record,
        null,
        "the credential is removed, so the user is not stuck between a failing status and a failing logout",
      );
      assert.equal(refreshAttempts, 1, "the named terminal refusal is not retried");
      assert.equal(logoutAttempts, 0, "no server revocation was possible");
      assert.equal(
        await logout(target, credentials),
        "already-logged-out",
        "and logout stays idempotent afterwards",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
test("headless file fallback warns and enforces 0700/0600", async () => {
  const parent = await mkdtemp(join(tmpdir(), "swarm-cloud-store-"));
  const directory = join(parent, "credentials");
  const warnings: string[] = [];
  const target = cloudTarget("http://127.0.0.1:54321", "anon");
  try {
    const store = await credentialStore({
      target,
      stateDirectory: directory,
      forceFile: true,
      platform: "linux",
      warn: (message) => warnings.push(message),
    });
    const record: CredentialRecord = {
      version: 1,
      refreshToken: "refresh-token-long-enough",
      generation: 0,
      deviceId: randomUUID(),
      userId: randomUUID(),
    };
    await store.write(record);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(store.location)).mode & 0o777, 0o600);
    assert.deepEqual(await store.read(), record);
    const workspaceId = randomUUID();
    await store.writeProfile({
      version: 1,
      userId: record.userId,
      workspaceId,
      pendingCommands: {
        ["a".repeat(64)]: {
          commandId: "cmd_pending123",
          kind: "invite_member",
          createdAt: 1,
        },
      },
    });
    assert.deepEqual(await store.readProfile(), {
      version: 1,
      userId: record.userId,
      workspaceId,
      pendingCommands: {
        ["a".repeat(64)]: {
          commandId: "cmd_pending123",
          kind: "invite_member",
          createdAt: 1,
        },
      },
    });
    assert.ok(warnings.some((warning) => warning.startsWith("⚠")));

    await chmod(store.location, 0o644);
    await assert.rejects(store.read(), /must be mode 0600/);

    await chmod(store.location, 0o600);
    await chmod(directory, 0o755);
    await assert.rejects(
      store.write(record),
      /directory must be mode 0700/,
      "a credential must never be written below a traversable directory",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("keychain writer keeps the credential off argv and answers both secure prompts", async () => {
  const parent = await mkdtemp(join(tmpdir(), "swarm-fake-keychain-"));
  const securityPath = join(parent, "security");
  const stateDirectory = join(parent, "state");
  const fakeSecurity = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const action = args[0];
const vault = process.argv[1] + ".secret";
if (args.join("\\0").includes("rrrrrrrr")) process.exit(9);
if (action === "add-generic-password") {
  const lines = fs.readFileSync(0, "utf8").trimEnd().split("\\n");
  if (lines.length !== 2 || lines[0] !== lines[1]) process.exit(8);
  if (Buffer.byteLength(lines[0], "utf8") > 126) process.exit(7);
  if (lines[0].startsWith("{")) process.exit(6);
  fs.writeFileSync(vault, lines[0], { mode: 0o600 });
  process.exit(0);
}
if (action === "find-generic-password") {
  if (!fs.existsSync(vault)) process.exit(44);
  process.stdout.write(fs.readFileSync(vault));
  process.exit(0);
}
if (action === "delete-generic-password") {
  if (!fs.existsSync(vault)) process.exit(44);
  fs.unlinkSync(vault);
  process.exit(0);
}
process.exit(2);
`;
  try {
    await writeFile(securityPath, fakeSecurity, { mode: 0o700 });
    await chmod(securityPath, 0o700);
    const store = await credentialStore({
      target: cloudTarget(
        `https://${randomUUID()}.example.test`,
        "test-anon-key",
      ),
      stateDirectory,
      platform: "darwin",
      securityPath,
    });
    const record: CredentialRecord = {
      version: 1,
      refreshToken: "r".repeat(43),
      generation: 7,
      deviceId: randomUUID(),
      userId: randomUUID(),
    };
    assert.equal(store.kind, "keychain");
    await store.write(record);
    assert.deepEqual(await store.read(), record);
    await store.delete();
    assert.equal(await store.read(), null);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("malformed credential errors never echo stored secret material", async () => {
  const parent = await mkdtemp(join(tmpdir(), "swarm-malformed-store-"));
  const directory = join(parent, "credentials");
  try {
    const store = await credentialStore({
      target: cloudTarget("https://malformed.example.test", "anon"),
      stateDirectory: directory,
      forceFile: true,
      platform: "linux",
      warn: () => undefined,
    });
    await store.write({
      version: 1,
      refreshToken: "refresh-token-long-enough",
      generation: 0,
      deviceId: randomUUID(),
      userId: randomUUID(),
    });
    await writeFile(
      store.location,
      '{"version":1,"refreshToken":"must-never-appear',
      { mode: 0o600 },
    );
    const error = await store.read().then(
      () => null,
      (failure: unknown) => failure as Error,
    );
    assert.ok(error);
    assert.equal(error.message, "stored credential record is malformed");
    assert.equal(error.message.includes("must-never-appear"), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("file fallback hard-refuses when disabled", async () => {
  const target = cloudTarget("http://127.0.0.1:54321", "anon");
  await assert.rejects(
    credentialStore({
      target,
      forceFile: true,
      platform: "linux",
      allowFileFallback: false,
    }),
    /fallback is disabled/,
  );
});

// These tests own the human continuity contract at actual HTTP/files/processes.
// Transient fixture responses exercise transport policy, not GoTrue reuse semantics.
async function fileHuman(t: TestContext, target: ReturnType<typeof cloudTarget>, cliHome = false) {
  const root = await mkdtemp(join(tmpdir(), "cswarm-human-continuity-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const store = await credentialStore({ target, stateDirectory: cliHome ? join(root, ".cswarm", "credentials.d") : root, forceFile: true, warn: () => {} });
  const parent: CredentialRecord = { version: 1, refreshToken: "refresh-0", generation: 0,
    userId: "22222222-2222-4222-8222-222222222222", deviceId: randomUUID() };
  await store.withLock(async () => {
    await store.write(parent);
    await store.writeProfile({ version: 1, userId: parent.userId, workspaceId: randomUUID(),
      pendingCommands: { ["a".repeat(64)]: { commandId: "retained-command", kind: "invite_member", createdAt: Date.now() } } });
  });
  return { root, store, parent };
}

function humanChild(root: string, url: string, mode: "normal" | "before-save" | "after-save" | "cli" | "accept" = "normal", link?: string) {
  const authPath = new URL("../../src/cloud/auth.ts", import.meta.url).href;
  const storagePath = new URL("../../src/cloud/storage.ts", import.meta.url).href;
  const configPath = new URL("../../src/cloud/config.ts", import.meta.url).href;
  const cliPath = new URL("../../src/cli.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module"], { stdio: ["pipe", "pipe", "pipe"] });
  const code = `
    import os from 'node:os';
    import {syncBuiltinESMExports} from 'node:module';
    import {fileURLToPath} from 'node:url';
    import {refreshedCredential} from ${JSON.stringify(authPath)};
    import {credentialStore} from ${JSON.stringify(storagePath)};
    import {cloudTarget} from ${JSON.stringify(configPath)};
    const target=cloudTarget(${JSON.stringify(url)},'test-anon-key');
    const store=await credentialStore({target,stateDirectory:${JSON.stringify(root)},forceFile:true,warn:()=>{}});
    const mode=${JSON.stringify(mode)};
    if(mode==='cli'||mode==='accept') {
      // Redirect filesystem discovery only. HOME and auth behavior are unchanged.
      os.homedir=()=>${JSON.stringify(root)};
      syncBuiltinESMExports();
      process.argv=[process.execPath,fileURLToPath(${JSON.stringify(cliPath)}),...(mode==='accept'
        ? ['accept',${JSON.stringify(link)},'--no-browser','--force-file-store','--json']
        : ['workspaces','--url',${JSON.stringify(url)},'--anon-key','test-anon-key','--force-file-store','--json'])];
      await import(${JSON.stringify(cliPath)});
    } else {
    if(mode!=='normal') {
      const write=store.write.bind(store);
      store.write=async record=>{
        if(mode==='after-save') await write(record);
        process.kill(process.pid,'SIGKILL');
        await new Promise(()=>{});
      };
    }
    const result=await refreshedCredential(target,store);
    process.stdout.write(JSON.stringify({userId:result.userId,generation:(await store.read()).generation}));
    }
  `;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  let sawLogin = false;
  child.stderr.on("data", chunk => {
    stderr += chunk;
    if (mode === "accept" && stderr.includes("Open this URL in a browser to sign in")) {
      sawLogin = true;
      // Boundary reached: never launch a browser or contact an identity provider.
      child.kill("SIGTERM");
    }
  });
  child.stdin.end(code);
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; sawLogin: boolean }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("human CLI subprocess exceeded its deadline")); }, 45_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (mode !== "accept" && code !== 0 && signal !== "SIGKILL") reject(new Error(`human CLI subprocess failed (${code}): ${stderr}`));
      else resolve({ code, signal, stdout, sawLogin });
    });
  });
}

test("parallel human processes share one rotation and later processes use the protected cache", { timeout: 50_000 }, async t => {
  const server = await refreshServer({ delayMs: 200 });
  t.after(server.close);
  const target = cloudTarget(server.url, "test-anon-key");
  const { root, store, parent } = await fileHuman(t, target);
  await store.withLock(async () => {
    await writeFile(store.location, [parent.version, parent.refreshToken, parent.generation, parent.deviceId, parent.userId].join("|"), { mode: 0o600 });
  });
  assert.deepEqual(await store.read(), parent, "legacy five-field credentials remain readable");
  const results = await Promise.all(Array.from({ length: 6 }, () => humanChild(root, server.url)));
  assert.ok(results.every(result => result.code === 0 && JSON.parse(result.stdout).generation === 1));
  assert.equal(server.refreshes(), 1);
  const restarted = await credentialStore({ target, stateDirectory: root, forceFile: true, warn: () => {} });
  assert.equal((await refreshedCredential(target, restarted)).userId, parent.userId);
  assert.equal(server.refreshes(), 1, "a later invocation must not consume the successor");
  const profile = await store.readProfile();
  assert.equal(profile.pendingCommands["a".repeat(64)]?.commandId, "retained-command");
  assert.equal(profile.humanSession?.successor, undefined);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(store.location)).mode & 0o777, 0o600);
  assert.equal((await stat(store.location.replace(/\.json$/, ".profile.json"))).mode & 0o777, 0o600);
});

test("an interrupted successor publication is adopted after process death on either side of the credential write", { timeout: 50_000, skip: process.platform === "win32" }, async t => {
  for (const mode of ["before-save", "after-save"] as const) await t.test(mode, async t => {
    const server = await refreshServer();
    t.after(server.close);
    const target = cloudTarget(server.url, "test-anon-key");
    const { root, store } = await fileHuman(t, target);
    const stopped = await humanChild(root, server.url, mode);
    assert.equal(stopped.signal, "SIGKILL");
    assert.ok((await store.readProfile()).humanSession?.successor, "journal must be written by the production refresh before interruption");
    assert.equal((await humanChild(root, server.url)).code, 0);
    assert.equal(server.refreshes(), 1, "restart must adopt the published token without rotating again");
    assert.equal((await store.read())!.generation, 1);
    assert.equal((await store.readProfile()).humanSession?.successor, undefined);
  });
});

test("expired and invalid optional access caches refresh once while legacy credentials remain readable", async t => {
  const server = await refreshServer();
  t.after(server.close);
  const target = cloudTarget(server.url, "test-anon-key");
  const { store } = await fileHuman(t, target);
  await refreshedCredential(target, store); // Legacy v1 with no optional cache.
  for (const invalid of ["expired", "identity", "digest", "generation", "malformed"] as const) {
    await store.withLock(async () => {
      const profile = await store.readProfile();
      const state = profile.humanSession!;
      if (invalid === "expired") state.expiresAt = 1;
      if (invalid === "identity") state.userId = randomUUID();
      if (invalid === "digest") state.parentDigest = "0".repeat(64);
      if (invalid === "generation") state.generation += 7;
      if (invalid === "malformed") state.accessToken = 42 as unknown as string;
      await store.writeProfile(profile);
    });
    const before = server.refreshes();
    await refreshedCredential(target, store);
    assert.equal(server.refreshes(), before + 1, invalid);
    await refreshedCredential(target, store);
    assert.equal(server.refreshes(), before + 1, `${invalid}: repaired cache is reused`);
  }
});

test("bounded transient refresh failures retain the exact credential; terminal advice requires a recognized refusal", async t => {
  for (const { status, code, terminal } of [
    { status: 0, code: "network", terminal: false },
    { status: 429, code: "over_request_rate_limit", terminal: false },
    { status: 503, code: "unexpected_failure", terminal: false },
    { status: 400, code: "refresh_token_already_used", terminal: true },
    { status: 400, code: "invalid_grant", terminal: false },
    { status: 403, code: "session_not_found", terminal: true },
    { status: 404, code: "session_expired", terminal: true },
    { status: 403, code: "permission_denied", terminal: false },
    { status: 503, code: "session_not_found", terminal: false },
    { status: 400, code: "refresh_token_not_found", terminal: true },
  ]) await t.test(`${status}/${code}`, async t => {
    const retryable = status === 0 || status === 429 || status >= 500;
    const server = await refreshServer({ failures: Array.from({ length: retryable ? 3 : 1 }, () => ({ status, code })) });
    t.after(server.close);
    const target = cloudTarget(server.url, "test-anon-key");
    const { store, parent } = await fileHuman(t, target);
    await assert.rejects(refreshedCredential(target, store), error => error instanceof HumanSessionError &&
      error.code === (terminal ? "human_session_refresh_failed" : "human_session_transient") &&
      (terminal || !error.message.includes("cswarm login")));
    assert.deepEqual(await store.read(), parent);
    assert.equal(server.attempts(), retryable ? 3 : 1);
    assert.equal((await refreshedCredential(target, store)).userId, parent.userId);
  });
});

test("read-back and final-cache errors reconcile the durable winner before returning", async t => {
  for (const phase of ["journal-save", "read-back", "cache-save"] as const) await t.test(phase, async t => {
    const server = await refreshServer(); t.after(server.close);
    const target = cloudTarget(server.url, "test-anon-key");
    const { store } = await fileHuman(t, target);
    const realRead = store.read.bind(store), realWrite = store.write.bind(store), realProfile = store.writeProfile.bind(store);
    let saved = false, failed = false;
    store.write = async record => { await realWrite(record); saved = true; };
    store.read = async () => {
      if (phase === "read-back" && saved && !failed) { failed = true; throw new Error("fixture read interruption"); }
      return await realRead();
    };
    store.writeProfile = async profile => {
      if (phase === "journal-save" && !failed && profile.humanSession?.successor) {
        failed = true; throw new Error("fixture journal interruption");
      }
      if (phase === "cache-save" && saved && !failed && !profile.humanSession?.successor) {
        failed = true; throw new Error("fixture profile interruption");
      }
      await realProfile(profile);
    };
    assert.equal((await refreshedCredential(target, store)).userId, (await realRead())!.userId);
    assert.equal(failed, true);
    assert.equal(server.refreshes(), 1);
    assert.equal((await store.readProfile()).humanSession?.successor, undefined);
  });
});

test("logout invalidates journal/cache and stale saved state cannot resurrect a deleted or replaced identity", { skip: process.platform === "win32" }, async t => {
  const failures: Array<{ status: number; code: string }> = [];
  const server = await refreshServer({ failures }); t.after(server.close);
  const target = cloudTarget(server.url, "test-anon-key");
  const { root, store, parent } = await fileHuman(t, target);
  assert.equal((await humanChild(root, server.url, "before-save")).signal, "SIGKILL");
  const stale = await store.readProfile();
  assert.ok(stale.humanSession?.successor);
  assert.equal(await logout(target, store, "local", { localOnly: true }), "cleared-unverified");
  assert.equal((await store.readProfile()).humanSession, undefined);
  await store.withLock(async () => { await store.writeProfile(stale); });
  await assert.rejects(refreshedCredential(target, store), (error: unknown) => error instanceof HumanSessionError && error.code === "human_session_missing");
  await store.withLock(async () => { await store.write({ ...parent, userId: randomUUID(), generation: 9, refreshToken: "foreign-parent" }); });
  failures.push(...Array.from({ length: 3 }, () => ({ status: 503, code: "unexpected_failure" })));
  await assert.rejects(refreshedCredential(target, store), (error: unknown) => error instanceof HumanSessionError && error.code === "human_session_transient");
  assert.equal((await store.read())!.refreshToken, "foreign-parent");
});

test("eligible human 401 replays preserve the serialized command and request ID; refusal and body exclusions never rotate", async t => {
  for (const scenario of ["command", "read-get", "read-post", "403", "fresh-auth", "unknown-policy", "repeat401", "stream", "foreign", "agent", "redirect", "abort", "identity-switch"] as const) await t.test(scenario, async t => {
    const server = await refreshServer({ apiStatus: scenario === "403" ? 403 : 401,
      apiCode: scenario === "fresh-auth" ? "fresh_auth_required" : scenario === "unknown-policy" ? "policy_denied" : "unauthenticated",
      apiRejectUntil: scenario === "repeat401" ? 99 : 2 });
    t.after(server.close);
    const target = cloudTarget(server.url, "test-anon-key");
    const { store } = await fileHuman(t, target);
    const human = await refreshedCredential(target, store);
    const bound = humanSessionFetch(target, store, human);
    const init = { method: "POST", headers: { authorization: `Bearer ${human.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ command_id: "fixed-command-id", command: { kind: "fixture" } }) };
    if (scenario === "command" || scenario === "repeat401") {
      const client = new ThinCommandClient(target, bound);
      const send = client.sendConnect({ workspaceId: randomUUID(), credential: human.accessToken,
        commandId: "fixed-command-id", command: { kind: "invite_member", email: "fixture@example.test" } });
      if (scenario === "repeat401") await assert.rejects(send);
      else assert.equal((await send).httpStatus, 200);
    } else if (scenario === "identity-switch") {
      await store.withLock(async () => { await store.write({ ...(await store.read())!, userId: randomUUID() }); });
      await assert.rejects(bound(`${server.url}/functions/v1/command`, init), HumanSessionError);
      assert.notEqual((await store.read())!.userId, human.userId);
    } else if (scenario === "foreign") {
      await assert.rejects(bound("http://127.0.0.1:1/functions/v1/command", init), HumanSessionError);
    } else if (scenario === "stream") {
      const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(init.body)); controller.close(); } });
      const request = new Request(`${server.url}/functions/v1/command`, { ...init, body, duplex: "half" } as RequestInit);
      assert.equal((await bound(request)).status, 401);
    } else if (scenario === "agent") {
      assert.equal((await bound(`${server.url}/functions/v1/command`, { ...init, headers: { authorization: "Bearer swm_agt_fixture" } })).status, 401);
    } else if (scenario === "abort") {
      const controller = new AbortController(); controller.abort();
      await assert.rejects(bound(`${server.url}/functions/v1/command`, { ...init, signal: controller.signal }));
    } else if (scenario === "redirect") {
      // A separate HTTP redirect exercises the native redirect policy rather than mocking fetch.
      const redirect = createServer((_request, response) => response.writeHead(302, { location: `${server.url}/rest/v1/memberships` }).end());
      await new Promise<void>(resolve => redirect.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise<void>(resolve => redirect.close(() => resolve())));
      const port = (redirect.address() as { port: number }).port;
      const redirectTarget = cloudTarget(`http://127.0.0.1:${port}`, "test-anon-key");
      await assert.rejects(humanSessionFetch(redirectTarget, store, human)(`${redirectTarget.url}/rest/v1/memberships`, { headers: init.headers }));
    } else {
      const response = scenario === "read-get"
        ? await bound(`${server.url}/rest/v1/memberships`, { headers: init.headers })
        : await bound(`${server.url}/functions/v1/${scenario === "read-post" ? "read" : "command"}`, init);
      assert.equal(response.status, scenario === "read-get" || scenario === "read-post" ? 200 : scenario === "403" ? 403 : 401);
    }
    const replayed = ["command", "read-get", "read-post", "repeat401"].includes(scenario);
    assert.equal(server.refreshes(), replayed ? 2 : 1);
    if (replayed) {
      assert.equal(server.apiCalls.length, 2);
      assert.equal(server.apiCalls[0]!.body, server.apiCalls[1]!.body);
      assert.equal(server.apiCalls[0]!.requestId, server.apiCalls[1]!.requestId);
      assert.match(server.apiCalls[0]!.requestId, /^[0-9a-f-]{36}$/);
      assert.equal(server.apiCalls[1]!.authorization, "Bearer access-2");
      assert.equal((await store.readProfile()).humanSession?.operationId, server.apiCalls[0]!.requestId);
    }
  });
});

test("a dropped rotation response before journal publication retains the parent and reports the recovery ceiling", async t => {
  const server = await refreshServer({ dropAfterRotation: true }); t.after(server.close);
  const target = cloudTarget(server.url, "test-anon-key");
  const { store, parent } = await fileHuman(t, target);
  await assert.rejects(refreshedCredential(target, store), (error: unknown) =>
    error instanceof HumanSessionError && error.code === "human_session_refresh_failed");
  assert.equal(server.refreshes(), 1, "fixture rotated before dropping its response");
  assert.deepEqual(await store.read(), parent, "an unseen successor cannot be reconstructed locally");
  assert.equal((await store.readProfile()).humanSession?.successor, undefined);
  await assert.rejects(refreshedCredential(target, store), (error: unknown) =>
    error instanceof HumanSessionError && error.code === "human_session_refresh_failed");
  assert.deepEqual(await store.read(), parent);
  // This deliberately refusing HTTP fixture is not GoTrue parent-reuse proof.
});

test("a terminal response cannot condemn a same-generation winner with a different exact credential", async t => {
  for (const refusal of [{ status: 400, code: "refresh_token_already_used" },
    { status: 403, code: "session_not_found" }, { status: 404, code: "session_expired" }]) await t.test(`${refusal.status}/${refusal.code}`, async t => {
  const failures: Array<{ status: number; code: string }> = [];
  let publishWinner: (() => Promise<void>) | undefined;
  const server = await refreshServer({ failures, beforeRefusal: async () => { await publishWinner?.(); } });
  t.after(server.close);
  const target = cloudTarget(server.url, "test-anon-key");
  const primary = await fileHuman(t, target), winner = await fileHuman(t, target);
  await winner.store.withLock(async () => { await winner.store.write(primary.parent); });
  const expected = await refreshedCredential(target, winner.store);
  // Model a legacy writer publishing while our request is in flight. The
  // winner itself is produced by the real refresh/journal/file implementation.
  await primary.store.withLock(async () => { await primary.store.write({ ...primary.parent, generation: 1 }); });
  publishWinner = async () => {
    await primary.store.write((await winner.store.read())!);
    await primary.store.writeProfile(await winner.store.readProfile());
  };
  failures.push(refusal);
  assert.equal((await refreshedCredential(target, primary.store)).accessToken, expected.accessToken);
  assert.equal(server.refreshes(), 1);
  assert.deepEqual(await primary.store.read(), await winner.store.read());
  });
});

test("a delayed old-token 401 adopts the winner instead of rejecting its new access token", async t => {
  const server = await refreshServer({ apiStatus: 401, delaySecondApiRefusalMs: 300 }); t.after(server.close);
  const target = cloudTarget(server.url, "test-anon-key");
  const { store } = await fileHuman(t, target);
  const human = await refreshedCredential(target, store);
  const client = new ThinCommandClient(target, humanSessionFetch(target, store, human));
  const workspaceId = randomUUID();
  const results = await Promise.all(["first-command", "second-command"].map(commandId => client.sendConnect({
    workspaceId, commandId, credential: human.accessToken,
    command: { kind: "invite_member", email: "fixture@example.test" },
  })));
  assert.ok(results.every(result => result.httpStatus === 200));
  assert.equal(server.refreshes(), 2, "the delayed refusal names the token actually sent, not the winner");
  for (const commandId of ["first-command", "second-command"]) {
    const attempts = server.apiCalls.filter(call => JSON.parse(call.body).command_id === commandId);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]!.body, attempts[1]!.body);
    assert.equal(attempts[0]!.requestId, attempts[1]!.requestId);
  }
});

test("caller cancellation interrupts a human refresh lock wait without rotating or removing its live owner", async t => {
  const server = await refreshServer(); t.after(server.close);
  const target = cloudTarget(server.url, "test-anon-key");
  const { store } = await fileHuman(t, target);
  const human = await refreshedCredential(target, store);
  const before = await store.read();
  await store.withLock(async () => {
    const controller = new AbortController();
    const pending = refreshedCredential(target, store, { rejectedAccessToken: human.accessToken, signal: controller.signal });
    const rejection = assert.rejects(pending, { name: "AbortError" });
    await new Promise(resolve => setTimeout(resolve, 50));
    const started = Date.now(); controller.abort();
    await rejection;
    assert.ok(Date.now() - started < 1000, "a canceled request must not wait for the thirty-second lock deadline");
    assert.deepEqual(await store.read(), before);
  });
  assert.equal((await refreshedCredential(target, store)).accessToken, human.accessToken);
  assert.equal(server.refreshes(), 1);
});

test("the actual CLI caller recovers an eligible 401 and a later command reuses its saved session", { timeout: 50_000 }, async t => {
  const server = await refreshServer({ apiStatus: 401 }); t.after(server.close);
  const target = cloudTarget(server.url, "test-anon-key");
  const { root, store, parent } = await fileHuman(t, target, true);
  const first = await humanChild(root, server.url, "cli");
  assert.equal(first.code, 0);
  assert.equal(JSON.parse(first.stdout).identity.user_id, parent.userId);
  assert.equal(server.refreshes(), 2, "CLI workspace fetch must use the bound human transport");
  const second = await humanChild(root, server.url, "cli");
  assert.equal(second.code, 0);
  assert.equal(JSON.parse(second.stdout).identity.user_id, parent.userId);
  assert.equal(server.refreshes(), 2, "a separate command process reuses the valid cache");
  assert.equal((await store.read())!.generation, 2);
});


// F1: an API deadline must not lose an already-issued refresh successor or
// release its lock before durable completion. Existing lock-wait cancellation
// covers a different lifecycle boundary and cannot reach this in-flight case.
test("caller cancellation during rotation awaits durable completion under the same lock without API replay", { timeout: 10_000 }, async t => {
  const controller = new AbortController();
  let rotated!: () => void, release!: () => void;
  const rotation = new Promise<void>(resolve => { rotated = resolve; });
  const response = new Promise<void>(resolve => { release = resolve; });
  const server = await refreshServer({ apiStatus: 401, afterRotation: async generation => {
    if (generation === 2) { controller.abort(); rotated(); await response; }
  } });
  t.after(async () => { release(); await server.close(); });
  const target = cloudTarget(server.url, "test-anon-key");
  const { store } = await fileHuman(t, target);
  const human = await refreshedCredential(target, store);
  let completed = false;
  const pending = humanSessionFetch(target, store, human)(`${server.url}/rest/v1/memberships`, {
    headers: { authorization: `Bearer ${human.accessToken}` }, signal: controller.signal,
  });
  const canceled = assert.rejects(pending, { name: "AbortError" }).finally(() => { completed = true; });
  await rotation;
  let contenderCompleted = false;
  const contender = refreshedCredential(target, store).then(value => { contenderCompleted = true; return value; });
  contender.catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(completed, false, "cancellation cannot finish before successor publication");
  assert.equal(contenderCompleted, false, "the same lock must cover the entire critical section");
  release();
  await canceled;
  const adopted = await contender;
  assert.equal(adopted.accessToken, "access-2");
  assert.equal((await store.read())!.generation, 2);
  assert.equal((await store.readProfile()).humanSession?.successor, undefined);
  assert.equal(server.refreshes(), 2);
  assert.equal(server.apiCalls.length, 1, "canceled API request must not be resent");
});

// F3 is owned at the real CLI boundary: a helper-only accept test would bypass
// runLinkAccept.currentSession, where the regression occurred.
test("accept with an invitation link resumes its existing login flow only for a terminal saved session", { timeout: 25_000 }, async t => {
  for (const terminal of [true, false]) await t.test(terminal ? "terminal" : "transient", async t => {
    const server = await refreshServer({ failures: Array.from({ length: terminal ? 1 : 3 }, () => ({
      status: terminal ? 400 : 503, code: terminal ? "refresh_token_not_found" : "unexpected_failure",
    })) });
    t.after(server.close);
    const target = cloudTarget(server.url, "test-anon-key");
    const { root, store, parent } = await fileHuman(t, target, true);
    const link = encodeInviteLink({ v: 1, url: server.url, anon_key: "test-anon-key",
      workspace_id: randomUUID(), invitation_token: `swm_inv_${"B".repeat(43)}`,
      workspace_name: "Test workspace", inviter_display_name: "Test inviter", inviter_user_id: randomUUID() });
    const result = await humanChild(root, server.url, "accept", link);
    assert.equal(result.sawLogin, terminal, "terminal sessions resume in-flow login; transient sessions retain retry advice");
    assert.equal(server.attempts(), terminal ? 1 : 3, "the real refresh boundary must be reached");
    if (!terminal) {
      assert.notEqual(result.code, 0);
      assert.match(result.stdout, /human_session_transient/);
      assert.doesNotMatch(result.stdout, /cswarm login/);
    }
    assert.deepEqual(await store.read(), parent);
  });
});

test("a retained unknown credential lock reports its exact cause and safe recovery without exposing owner payloads", async t => {
  const server = await refreshServer(); t.after(server.close);
  const target = cloudTarget(server.url, "test-anon-key");
  const { root, store, parent } = await fileHuman(t, target);
  const lockPath = join(root, `${target.profileId}.lock`);
  await writeFile(lockPath, JSON.stringify({ pid: 12345, host: "foreign-host", createdAt: Date.now() - 120_000 }), { mode: 0o600 });
  store.withLock = (work, options) => withFileLock(root, target.profileId, work, { ...options, timeoutMs: 50 });
  await assert.rejects(refreshedCredential(target, store), (error: unknown) => {
    assert.ok(error instanceof HumanSessionError);
    assert.equal(error.code, "human_session_transient");
    assert.equal(error.phase, "lock");
    assert.ok(error.message.includes(lockPath));
    assert.match(error.message, /owner pid 12345, host foreign-host/);
    assert.match(error.message, /credential was kept/);
    assert.match(error.message, /verify the recorded host and process/);
    assert.doesNotMatch(error.message, /rm --|cswarm doctor|cswarm login/);
    return true;
  });
  assert.deepEqual(await store.read(), parent);
  assert.equal(server.attempts(), 0);
});


// A late journal is different from a changed credential: its parent bytes are
// still identical when the refusal arrives. Both callers must reconcile it.
test("terminal refresh and logout reconcile a journal published during the refusal before acting", async t => {
  for (const ending of ["refresh", "logout"] as const) await t.test(ending, async t => {
    const failures: Array<{ status: number; code: string }> = [];
    let publish: (() => Promise<void>) | undefined;
    const server = await refreshServer({ failures, beforeRefusal: async () => { await publish?.(); } });
    t.after(server.close);
    const target = cloudTarget(server.url, "test-anon-key");
    const primary = await fileHuman(t, target), publisher = await fileHuman(t, target);
    await publisher.store.withLock(async () => { await publisher.store.write(primary.parent); });
    const originalWrite = publisher.store.write.bind(publisher.store);
    publisher.store.write = async () => { throw new Error("fixture stops after durable publication"); };
    await assert.rejects(refreshedCredential(target, publisher.store), HumanSessionError);
    publisher.store.write = originalWrite;
    const journal = await publisher.store.readProfile();
    assert.ok(journal.humanSession?.successor);
    publish = async () => { await primary.store.writeProfile(journal); };
    failures.push({ status: 404, code: "session_not_found" });
    if (ending === "refresh") {
      assert.equal((await refreshedCredential(target, primary.store)).accessToken, "access-1");
      assert.equal((await primary.store.read())!.generation, 1);
      assert.equal(server.refreshes(), 1);
    } else {
      assert.equal(await logout(target, primary.store), "revoked");
      assert.equal(server.logouts(), 1);
      assert.equal(await primary.store.read(), null);
    }
  });
});
