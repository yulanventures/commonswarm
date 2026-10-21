import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { createLogger } from "../src/logger.js";
import { createMcpProvider, ISSUER } from "../src/provider.js";
import { createMemoryRegistrationStore } from "../src/registration.js";
import { createHandler } from "../src/server.js";

// Only the fields known from the incident; this is not the missing rejected body.
const META = {
  redirect_uris: ["https://agent.meta.ai/api/hatch/oauth/callback"],
  token_endpoint_auth_method: "none",
  scope: "mcp offline_access",
  grant_types: ["authorization_code", "refresh_token"],
};

async function harness(t, { maxBodyBytes = 64 * 1024, registrationStore, enabled = true } = {}) {
  const logs = [];
  const provider = await createMcpProvider({ registrationStore });
  const server = createServer(createHandler({ provider, pool: {},
    publicAuthorizationEnabled: enabled, maxBodyBytes,
    logger: createLogger(line => logs.push(JSON.parse(line))),
  }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { logs, provider, async request(body, { accept = "text/html", type = "application/json", method = "POST" } = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/reg`, {
      method, headers: { accept, "content-type": type, "x-forwarded-proto": "https", host: new URL(ISSUER).host },
      ...(method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    assert.match(response.headers.get("content-type"), /^application\/json\b/u);
    return { status: response.status, body: await response.json() };
  } };
}

test("DCR known Meta fields register; metadata and JSON refusals are safe JSON even for HTML Accept", async t => {
  const h = await harness(t);
  const good = await h.request(META);
  assert.equal(good.status, 201);
  assert.equal(good.body.token_endpoint_auth_method, "none");
  assert.equal(good.body.client_secret, undefined);
  assert.deepEqual(good.body.redirect_uris, META.redirect_uris);
  for (const [body, code, description, options] of [
    ["{", "invalid_request", "failed to parse the request body"],
    ["null", "invalid_request", "client registration request must be a JSON object"],
    [{ ...META, response_types: ["token"] }, "invalid_client_metadata", "response_types metadata is invalid"],
    [{ ...META, client_uri: "private-value-not-a-url" }, "invalid_client_metadata", "client_uri must be a valid URL", { accept: "application/json" }],
    [{ ...META, post_logout_redirect_uris: "private-value-not-an-array" }, "invalid_client_metadata", "post_logout_redirect_uris must be an array of URLs", { accept: "application/json" }],
    [{ ...META, post_logout_redirect_uris: ["private-value-not-a-url"] }, "invalid_client_metadata", "post_logout_redirect_uris must contain valid URLs", { accept: "application/json" }],
    [META, "invalid_request", "registration requests require application/json", { type: "text/plain" }],
  ]) {
    await t.test(description, async () => {
      const rejected = await h.request(body, options);
      assert.equal(rejected.status, 400);
      assert.deepEqual(rejected.body, { error: code, error_description: description });
      assert.doesNotMatch(JSON.stringify(rejected.body), /private-value/u);
    });
  }
  assert.equal((await h.request(META)).status, 201, "rejections leave registration usable");
  assert.ok(h.logs.some(row => row.event === "registration_create.error" && row.error_code === "invalid_client_metadata" &&
    row.registration_error_description === "response_types metadata is invalid"));
  assert.doesNotMatch(JSON.stringify(h.logs), /private-value|meta\.ai/u);
});

test("DCR discards optional Cursor logos before validation and persistence without relaxing policy", async t => {
  const store = createMemoryRegistrationStore();
  const h = await harness(t, { registrationStore: store });
  const cursor = { ...META, client_name: "Cursor", client_uri: "https://cursor.com",
    redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/user-server/callback"] };
  const control = await h.request(cursor);
  assert.equal(control.status, 201);
  for (const logo_uri of ["https://cursor.com/logo.png", null, { url: "https://cursor.com/logo.png" },
    "private-value-not-a-url", "javascript:private-value", ["https://cursor.com/logo.png"], 42]) {
    const registered = await h.request({ ...cursor, logo_uri });
    assert.equal(registered.status, 201);
    assert.equal(Object.hasOwn(registered.body, "logo_uri"), false);
    assert.equal(registered.body.application_type, "native");
    assert.deepEqual(registered.body.redirect_uris, cursor.redirect_uris);
    const persisted = await store.find(registered.body.client_id);
    assert.ok(persisted, "registration was persisted by the real provider adapter path");
    assert.equal(Object.hasOwn(persisted, "logo_uri"), false);
    assert.deepEqual(persisted.redirect_uris, cursor.redirect_uris);
    const client = await h.provider.Client.find(registered.body.client_id);
    assert.ok(client);
    assert.equal(Object.hasOwn(client.metadata(), "logo_uri"), false);
  }
  const count = (await store.list()).length;
  for (const overrides of [
    { redirect_uris: ["http://evil.example/callback"] },
    { client_name: "claude.ai" },
    { client_uri: "https://evil.example" },
  ]) {
    const rejected = await h.request({ ...cursor, logo_uri: "https://cursor.com/logo.png", ...overrides });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "invalid_client_metadata");
  }
  assert.equal((await store.list()).length, count, "invalid registrations were not persisted");
  assert.doesNotMatch(JSON.stringify(h.logs), /private-value|cursor\.com\/logo/u);
});

test("DCR storage faults stay private beside a successful real-store control", async t => {
  const store = createMemoryRegistrationStore();
  const upsert = store.upsert;
  const h = await harness(t, { registrationStore: store });
  const good = await h.request(META);
  assert.equal(good.status, 201);
  store.upsert = async () => { throw new Error("private-database-password"); };
  const failed = await h.request(META);
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: "server_error", error_description: "registration could not be saved; retry later" });
  assert.doesNotMatch(JSON.stringify(h.logs), /private-database-password/u);
  store.upsert = upsert;
  assert.equal((await h.request(META)).status, 201);
});

test("DCR origin wrapper failures also use OAuth JSON errors", async t => {
  const h = await harness(t, { maxBodyBytes: 512 });
  assert.equal((await h.request(META)).status, 201);
  const large = await h.request({ ...META, logo_uri: "x".repeat(512) });
  assert.equal(large.status, 413);
  assert.deepEqual(large.body, { error: "invalid_request", error_description: "registration request body is too large" });
  const wrongMethod = await h.request(undefined, { method: "GET" });
  assert.equal(wrongMethod.status, 404);
  assert.deepEqual(wrongMethod.body, { error: "invalid_request",
    error_description: "registration requires POST on an enabled registration endpoint" });
  const disabled = await harness(t, { enabled: false });
  const unavailable = await disabled.request(META);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(unavailable.body, { error: "temporarily_unavailable", error_description: "client registration is unavailable" });
});
