import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { PassThrough, Writable } from "node:stream";
import { cloudAcceptOperations } from "../src/cloud/accept-link.js";
import { login } from "../src/cloud/auth.js";
import { ChannelListError, listChannelsAsHuman } from "../src/cloud/channels.js";
import { FileCommandRefused, FileTransportError, listFilesAsHuman } from "../src/cloud/files.js";
import { readSignals, SignalReadTimeoutError } from "../src/cloud/signals.js";
import { cloudWorkspaceDirectory, readWorkspaceAgentPresence } from "../src/cloud/workspaces.js";
import {
  classifyRestReadResponse, fetchRestReadRetrying,
  JWT_ISSUED_AT_FUTURE_RETRY_DELAY_MS,
} from "../src/cloud/rest-read-retry.js";
import type { CloudTarget } from "../src/cloud/config.js";
import type { CredentialStore } from "../src/cloud/storage.js";

const target: CloudTarget = { url: "https://fixture.invalid", anonKey: "fixture-anon", profileId: "fixture" };
const workspaceId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const session = { accessToken: "fixture-access", userId, deviceId: "33333333-3333-4333-8333-333333333333", email: null };
const credential = { kind: "human" as const, accessToken: session.accessToken, userId };
const query = { workspaceId, inbox: false };
const measuredHeader = 'Bearer error="invalid_token", error_description="JWT issued at future"';
const futureBody = '{"code":"PGRST303","details":null,"hint":null,"message":"JWT issued at future"}';
function future(header = true) {
  return new Response(header ? "refused" : futureBody, {
    status: 401, headers: header ? { "WWW-Authenticate": measuredHeader } : {},
  });
}
function expired() {
  return new Response('{"code":"PGRST303","message":"JWT expired"}', {
    status: 401, headers: { "WWW-Authenticate": 'Bearer error="invalid_token", error_description="JWT expired"' },
  });
}

const fixtures: Array<[string, number, string | null, string, boolean]> = [
  ["measured Bearer challenge", 401, measuredHeader, "refused", true],
  ["JSON message", 401, null, futureBody, true],
  ["JSON fallback with unrelated challenge", 401, 'Basic realm="login"', futureBody, true],
  ["quoted comma and escaped character", 401, 'Bearer realm="one,two", error_description="JWT issued at futur\\e"', "refused", true],
  ["case-insensitive scheme and parameter names", 401, 'bEaReR ERROR_DESCRIPTION="JWT issued at future"', "refused", true],
  ["multiple challenges", 401, 'Basic realm="other", Bearer error_description="JWT issued at future"', "refused", true],
  ["first success", 200, measuredHeader, "[]", false],
  ["expired challenge", 401, 'Bearer error_description="JWT expired"', "refused", false],
  ["expired JSON", 401, null, '{"code":"PGRST303","message":"JWT expired"}', false],
  ["non-JSON with no challenge", 401, null, "upstream refused", false],
  ["403 even with header and body", 403, measuredHeader, futureBody, false],
  ["description case differs", 401, 'Bearer error_description="jwt issued at future"', "refused", false],
  ["description trailing space", 401, 'Bearer error_description="JWT issued at future "', "refused", false],
  ["JSON case differs", 401, null, '{"message":"jwt issued at future"}', false],
  ["JSON trailing space", 401, null, '{"message":"JWT issued at future "}', false],
  ["wrong authentication scheme", 401, 'Basic error_description="JWT issued at future"', "refused", false],
  ["text in realm only", 401, 'Bearer realm="JWT issued at future", error_description="JWT expired"', "refused", false],
  ["text hidden in another quoted parameter", 401, 'Bearer realm="error_description=\\"JWT issued at future\\""', "refused", false],
  ["unquoted description", 401, "Bearer error_description=JWT issued at future", "refused", false],
  ["unterminated quoted string", 401, 'Bearer error_description="JWT issued at future', "refused", false],
  ["duplicate description", 401, 'Bearer error_description="JWT expired", error_description="JWT issued at future"', "refused", false],
  ["code alone is not specific", 401, null, '{"code":"PGRST303","message":"JWT not yet valid"}', false],
];
for (const [name, status, header, body, retry] of fixtures) {
  test(`classifier: ${name}; caller retains the original body`, async () => {
    const response = new Response(body, { status, headers: header ? { "WWW-Authenticate": header } : {} });
    assert.equal(await classifyRestReadResponse(response), retry ? "jwt_issued_at_future" : "other");
    assert.equal(await response.text(), body);
  });
}

// Fake only retry sleeps; existing request ceilings remain independent timers.
const realSetTimeout = globalThis.setTimeout;
function fakeRetryWait(t: TestContext, onWait?: (resume: () => void) => void, firstIsDeadline = false) {
  const waits: number[] = [];
  t.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== 1000) return realSetTimeout(callback, ms, ...args);
    if (firstIsDeadline) {
      firstIsDeadline = false;
      return realSetTimeout(callback, ms, ...args);
    }
    waits.push(ms);
    const resume = () => callback(...args);
    if (onWait) onWait(resume); else queueMicrotask(resume);
    return {} as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  return waits;
}
interface RequestSnapshot { url: string; method: string; headers: [string, string][]; body: unknown; signal: unknown }
function snapshot(input: Parameters<typeof fetch>[0], init?: RequestInit): RequestSnapshot {
  return { url: String(input), method: init?.method ?? "GET", headers: [...new Headers(init?.headers)], body: init?.body, signal: init?.signal };
}
function memoryStore(): CredentialStore {
  return {
    kind: "file", location: "memory only",
    read: async () => null, write: async () => {}, delete: async () => {},
    readProfile: async () => ({ version: 1, userId: null, workspaceId: null, pendingCommands: {} }),
    writeProfile: async () => {}, withLock: async (work) => await work(),
  };
}
async function loginWithFetch(t: TestContext, restFetch: typeof fetch): Promise<string | null> {
  let exchanges = 0;
  let registrations = 0;
  t.mock.method(globalThis, "fetch", (async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/rest/v1/memberships") return await restFetch(input, init);
    if (path === "/auth/v1/token") {
      exchanges++;
      return new Response(JSON.stringify({
        access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "bearer", expires_in: 3600,
        user: { id: userId, aud: "authenticated", role: "authenticated", email: "fixture@example.invalid" },
      }), { headers: { "content-type": "application/json" } });
    }
    if (path === "/functions/v1/command") {
      registrations++;
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ status: "accepted", device_id: body.command.device_id }));
    }
    assert.fail(`unexpected fetch: ${path}`);
  }) as typeof fetch);
  const input = new PassThrough();
  let callback = "";
  const output = new Writable({ write(chunk, _encoding, done) {
    if (String(chunk).includes("paste the complete callback")) queueMicrotask(() => input.write(`${callback}\n`));
    done();
  } });
  try {
    const result = await login({ target, store: memoryStore(), input, output, timeoutMs: 5000,
      openBrowser: async (url) => {
        const redirect = new URL(new URL(url).searchParams.get("redirect_to")!);
        redirect.searchParams.set("code", "fixture-code");
        callback = redirect.toString();
        return false;
      },
    });
    assert.equal(exchanges, 1, "retry must not exchange or refresh the session again");
    assert.equal(registrations, 1);
    return result.workspaceId;
  } finally { input.destroy(); output.destroy(); }
}

interface Site {
  name: string; path: string; body: string; expected: unknown; failure: string | null;
  run: (t: TestContext, fetcher: typeof fetch) => Promise<unknown>;
}
const sites: Site[] = [
  { name: "accept-link", path: "/rest/v1/memberships", body: '[{"workspace_id":"11111111-1111-4111-8111-111111111111"}]', expected: true,
    failure: "workspace read failed (HTTP 401)", run: async (_t, fetcher) => await cloudAcceptOperations(target, memoryStore(), fetcher).membershipExists(session, workspaceId) },
  { name: "login sole-workspace discovery", path: "/rest/v1/memberships", body: '[{"workspace_id":"11111111-1111-4111-8111-111111111111"}]', expected: workspaceId,
    failure: null, run: loginWithFetch },
  { name: "channels", path: "/rest/v1/channels", body: "[]", expected: [],
    failure: "The channel list was refused (HTTP 401). Nothing changed.", run: async (_t, fetcher) => await listChannelsAsHuman(target, session.accessToken, workspaceId, fetcher) },
  { name: "files", path: "/rest/v1/files", body: "[]", expected: [],
    failure: "file list failed (HTTP 401)", run: async (_t, fetcher) => await listFilesAsHuman(target, session.accessToken, workspaceId, fetcher) },
  { name: "signals", path: "/rest/v1/signals", body: "[]", expected: [],
    failure: "signal read failed (HTTP 401)", run: async (_t, fetcher) => await readSignals(target, credential, query, fetcher) },
  { name: "workspace directory", path: "/rest/v1/memberships", body: "[]", expected: [],
    failure: "workspace read failed (HTTP 401)", run: async (_t, fetcher) => await cloudWorkspaceDirectory(target, fetcher).list(session) },
  { name: "agent presence", path: "/rest/v1/agent_presence", body: "[]", expected: { available: true, rows: [] },
    failure: "agent presence read failed (HTTP 401)", run: async (_t, fetcher) => await readWorkspaceAgentPresence(target, session.accessToken, workspaceId, fetcher) },
];
for (const site of sites) {
  for (const mode of ["header", "JSON", "expired", "double", "success"] as const) {
    test(`${site.name}: ${mode} response preserves caller behavior and request bytes`, async (t) => {
      const waits = fakeRetryWait(t);
      const requests: RequestSnapshot[] = [];
      const controls: RequestSnapshot[] = [];
      const fetcher: typeof fetch = async (input, init) => {
        const request = snapshot(input, init);
        if (new URL(request.url).pathname !== site.path) {
          // Directory.list also reads workspaces concurrently. Its successful sibling
          // reaches the same rows helper and is a positive control, not the failed read.
          assert.equal(new URL(request.url).pathname, "/rest/v1/workspaces");
          controls.push(request);
          return new Response("[]");
        }
        requests.push(request);
        if (mode === "expired") return expired();
        if (mode === "double" || requests.length === 1 && mode !== "success") return future(mode !== "JSON");
        return new Response(site.body);
      };
      if (mode === "expired" || mode === "double") {
        if (site.failure === null) assert.equal(await site.run(t, fetcher), null);
        else await assert.rejects(site.run(t, fetcher), { message: site.failure });
      } else assert.deepEqual(await site.run(t, fetcher), site.expected);
      const retried = mode === "header" || mode === "JSON" || mode === "double";
      assert.equal(requests.length, retried ? 2 : 1);
      assert.deepEqual(waits, retried ? [1000] : []);
      assert.equal(controls.length, site.name === "workspace directory" ? 1 : 0);
      assert.equal(requests[0]!.method, "GET");
      assert.equal(new Headers(requests[0]!.headers).get("authorization"), "Bearer fixture-access");
      if (retried) assert.deepEqual(requests[1], requests[0], "URL, method, headers, body and signal are reused");
    });
  }
}

test("retry helper injects its clock and sleep, releases the refused response, and is silent", async (t) => {
  assert.equal(JWT_ISSUED_AT_FUTURE_RETRY_DELAY_MS, 1000);
  let clock = 10_000;
  const sleeps: number[] = [];
  const refused = future(false);
  const requests: RequestSnapshot[] = [];
  const stdout = t.mock.method(process.stdout, "write", () => true);
  const stderr = t.mock.method(process.stderr, "write", () => true);
  const fetcher: typeof fetch = async (input, init) => {
    requests.push(snapshot(input, init));
    if (requests.length === 1) return refused;
    assert.equal(refused.bodyUsed, true, "first response body was released before request two");
    return new Response("[]");
  };
  const response = await fetchRestReadRetrying(fetcher, "https://fixture.invalid/rest/v1/files", {
    method: "GET", headers: { authorization: "Bearer fixture-access" },
  }, { deadlineMs: 12_000, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  assert.equal(response.status, 200);
  assert.deepEqual(requests[1], requests[0]);
  assert.deepEqual(sleeps, [1000]);
  assert.equal(stdout.mock.callCount(), 0);
  assert.equal(stderr.mock.callCount(), 0);
});

test("signals: caller abort during the wait prevents request two and keeps timeout classification", async (t) => {
  const controller = new AbortController();
  const waits = fakeRetryWait(t, () => controller.abort());
  let requests = 0;
  await assert.rejects(readSignals(target, credential, query, {
    fetcher: async () => { requests++; return future(); }, signal: controller.signal,
    deadlineMs: 10_000, now: () => 0,
  }), SignalReadTimeoutError);
  assert.equal(requests, 1);
  assert.deepEqual(waits, [1000]);
});

for (const remaining of [999, 1000]) {
  test(`signals: ${remaining} ms left returns today's 401 without sleeping`, async (t) => {
    const waits = fakeRetryWait(t, undefined, remaining === 1000);
    let requests = 0;
    await assert.rejects(readSignals(target, credential, query, {
      fetcher: async () => { requests++; return future(false); }, deadlineMs: remaining, now: () => 0,
    }), { message: "signal read failed (HTTP 401)" });
    assert.equal(requests, 1);
    assert.deepEqual(waits, []);
  });
}

test("signals: one JWT retry across transport retries of the same logical read", async (t) => {
  const waits = fakeRetryWait(t);
  // Fast, fake existing transport backoff too; only the new sleep goes in waits.
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, ms?: number) => {
    if (ms === 250) { queueMicrotask(callback); return {} as ReturnType<typeof setTimeout>; }
    if (ms === 1000) { waits.push(ms); queueMicrotask(callback); return {} as ReturnType<typeof setTimeout>; }
    return realSetTimeout(callback, ms);
  }) as typeof setTimeout);
  let requests = 0;
  await assert.rejects(readSignals(target, credential, query, async () => {
    requests++;
    if (requests === 2) return new Response('{}', { status: 503 });
    return future();
  }), { message: "signal read failed (HTTP 401)" });
  assert.equal(requests, 3, "iat 401, retry 503, transport retry 401, then stop");
  assert.deepEqual(waits, [1000]);
});

test("signals: time spent before the 401 counts against the retry budget", async (t) => {
  const waits = fakeRetryWait(t);
  let clock = 0;
  let requests = 0;
  await assert.rejects(readSignals(target, credential, query, {
    deadlineMs: 2000, now: () => clock,
    fetcher: async () => { requests++; clock = 1500; return future(); },
  }), { message: "signal read failed (HTTP 401)" });
  assert.equal(requests, 1);
  assert.deepEqual(waits, []);
});

test("signals: the original per-read timer stays armed through the retry wait", async (t) => {
  let fireDeadline!: () => void;
  const waits: number[] = [];
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, ms?: number) => {
    if (ms === 30_000) fireDeadline = callback;
    else { assert.equal(ms, 1000); waits.push(ms); queueMicrotask(fireDeadline); }
    return {} as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  let requests = 0;
  await assert.rejects(readSignals(target, credential, query, async () => { requests++; return future(); }),
    { message: "signal read could not reach the cloud service" });
  assert.equal(requests, 1);
  assert.deepEqual(waits, [1000]);
});

test("files: short original budget takes today's 401 path without a retry", async (t) => {
  const waits = fakeRetryWait(t);
  let requests = 0;
  await assert.rejects(listFilesAsHuman(target, session.accessToken, workspaceId,
    async () => { requests++; return future(); }, { deadlineMs: 500, now: () => 0 }), FileCommandRefused);
  assert.equal(requests, 1);
  assert.deepEqual(waits, []);
});

test("files: caller abort in retry wait preserves the existing transport error", async (t) => {
  const controller = new AbortController();
  const waits = fakeRetryWait(t, () => controller.abort());
  let requests = 0;
  await assert.rejects(listFilesAsHuman(target, session.accessToken, workspaceId,
    async () => { requests++; return future(); }, { signal: controller.signal }), FileTransportError);
  assert.equal(requests, 1);
  assert.deepEqual(waits, [1000]);
});

test("channels: a short original request ceiling keeps its 401 result", async (t) => {
  const waits = fakeRetryWait(t);
  let requests = 0;
  await assert.rejects(listChannelsAsHuman(target, session.accessToken, workspaceId,
    async () => { requests++; return future(); }, 500), (error: unknown) => {
    assert.ok(error instanceof ChannelListError);
    assert.equal(error.status, 401);
    assert.equal(error.noResponse, false);
    return true;
  });
  assert.equal(requests, 1);
  assert.deepEqual(waits, []);
});

test("signals: a transport retry after JWT backoff gets only the original remaining time", async (t) => {
  let clock = 0;
  let requests = 0;
  const ceilings: number[] = [];
  let fireDeadline!: () => void;
  t.mock.method(globalThis, "setTimeout", ((callback: () => void, ms?: number) => {
    if (ms === 1000 || ms === 250) {
      clock += ms;
      queueMicrotask(callback);
    } else {
      ceilings.push(ms!);
      fireDeadline = callback;
    }
    return {} as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout);
  await assert.rejects(readSignals(target, credential, query, {
    deadlineMs: 2000, now: () => clock,
    fetcher: async () => {
      requests++;
      if (requests === 1) return future();
      if (requests === 2) return new Response('{}', { status: 503 });
      queueMicrotask(fireDeadline);
      return await new Promise<Response>(() => {});
    },
  }), SignalReadTimeoutError);
  assert.equal(requests, 3);
  assert.deepEqual(ceilings, [2000, 750], "1000 ms JWT wait plus 250 ms backoff were deducted");
});

test("signals: transport backoff cannot spend a budget exhausted by the JWT retry", async (t) => {
  let clock = 0;
  let requests = 0;
  const waits = fakeRetryWait(t, (resume) => { clock = 1000; queueMicrotask(resume); });
  await assert.rejects(readSignals(target, credential, query, {
    deadlineMs: 1100, now: () => clock,
    fetcher: async () => { requests++; return requests === 1 ? future() : new Response('{}', { status: 503 }); },
  }), { message: "signal read failed (HTTP 503)" });
  assert.equal(requests, 2);
  assert.deepEqual(waits, [1000]);
});
