import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const edgeBase = required("EDGE_BASE_URL");
const supabaseUrl = required("LOCAL_SUPABASE_URL");
const anonKey = required("LOCAL_ANON_KEY");
const serviceRoleKey = required("LOCAL_SERVICE_ROLE_KEY");

async function response(path, init) {
  return await fetch(`${edgeBase}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
}

async function json(response) {
  return await response.json().catch(() => null);
}

function report(name, status) {
  process.stdout.write(`${name}: HTTP ${status}\n`);
}

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
let userId;

try {
  const email = `edge-parity-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  userId = created.data.user.id;

  const browser = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await browser.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  const accessToken = signedIn.data.session?.access_token;
  assert.ok(accessToken);

  const h0 = await response("/functions/v1/h0/agent-doc/parity");
  assert.equal(h0.status, 200);
  assert.equal(typeof await json(h0), "object");
  report("h0 agent document", h0.status);

  const command = await response("/functions/v1/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(command.status, 400);
  assert.deepEqual(await json(command), { error: "invalid_request" });
  report("malformed command", command.status);

  const read = await response("/functions/v1/read", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      apikey: anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      resource: "renewal_grants",
      workspace_id: randomUUID(),
    }),
  });
  const readBody = await json(read);
  assert.equal(read.status, 200, JSON.stringify(readBody));
  assert.ok(Array.isArray(readBody?.grants));
  report("authenticated read", read.status);

  const activity = await response("/functions/v1/activity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(activity.status, 401);
  assert.deepEqual(await json(activity), { error: "unauthenticated" });
  report("unauthenticated activity", activity.status);

  const capability = await response("/functions/v1/capability/parity");
  assert.equal(capability.status, 405);
  assert.deepEqual(await json(capability), { error: "method_not_allowed" });
  report("capability method control", capability.status);

  const unknown = await response("/functions/v1/not-a-function");
  assert.equal(unknown.status, 404);
  assert.deepEqual(await json(unknown), { error: "function_not_found" });
  report("unknown function", unknown.status);
} finally {
  if (userId) {
    const removed = await admin.auth.admin.deleteUser(userId);
    assert.ifError(removed.error);
  }
}
