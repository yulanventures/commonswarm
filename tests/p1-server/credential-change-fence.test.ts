/** CS-E04 (option 3): a person's credential change revokes every human session, and PostgREST,
 * Realtime's member policies and command/OAuth admission check that a session is still live.
 * Runs against the local stack's real GoTrue, PostgREST and mail catcher. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";

interface LocalEnvironment { API_URL: string; ANON_KEY: string; SERVICE_ROLE_KEY: string; DB_URL: string; INBUCKET_URL?: string; MAILPIT_URL?: string }
interface Tokens { access_token: string; refresh_token: string; user: { id: string } }

let local: LocalEnvironment;
let sql: postgres.Sql;

before(() => {
  local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  })) as LocalEnvironment;
  assert.ok(local.API_URL && local.ANON_KEY && local.SERVICE_ROLE_KEY && local.DB_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(local.DB_URL).hostname));
  sql = postgres(local.DB_URL, { prepare: false, max: 4 });
});
after(async () => { await sql.end(); });

const auth = (path: string, init: RequestInit & { bearer?: string } = {}) => fetch(`${local.API_URL}/auth/v1${path}`, {
  ...init, redirect: "manual",
  headers: { apikey: local.ANON_KEY, "content-type": "application/json",
    authorization: `Bearer ${init.bearer ?? local.ANON_KEY}`, ...(init.headers as Record<string, string> ?? {}) },
});

async function person(): Promise<{ email: string; password: string; id: string }> {
  const email = `fence-${randomUUID().slice(0, 8)}@example.test`;
  const password = `Fence-${randomUUID()}`;
  const created = await fetch(`${local.API_URL}/auth/v1/admin/users`, { method: "POST",
    headers: { apikey: local.SERVICE_ROLE_KEY, authorization: `Bearer ${local.SERVICE_ROLE_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }) });
  const body = await created.json() as { id?: string };
  assert.equal(created.status, 200, JSON.stringify(body));
  return { email, password, id: body.id! };
}

async function signIn(email: string, password: string): Promise<Tokens> {
  const response = await auth("/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) });
  const body = await response.json() as Tokens;
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

/** A PostgREST read through swarm_read with this access token: status and error code. */
async function restRead(accessToken: string): Promise<{ status: number; code: string | null }> {
  const response = await fetch(`${local.API_URL}/rest/v1/channels?select=channel_id&limit=1`, {
    headers: { apikey: local.ANON_KEY, authorization: `Bearer ${accessToken}`, "accept-profile": "swarm_read" } });
  const body = await response.json().catch(() => null) as { code?: string } | null;
  return { status: response.status, code: Array.isArray(body) ? null : body?.code ?? null };
}

async function refreshes(refreshToken: string): Promise<boolean> {
  const response = await auth("/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: refreshToken }) });
  return response.status === 200;
}

async function liveSessions(userId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM auth.sessions WHERE user_id = ${userId}::uuid`;
  return row!.n;
}

test("a password change through GoTrue ends every session, the changer's included, everywhere they are checked", async () => {
  const who = await person();
  const a = await signIn(who.email, who.password);
  const b = await signIn(who.email, who.password);
  assert.deepEqual(await restRead(a.access_token), { status: 200, code: null });
  assert.deepEqual(await restRead(b.access_token), { status: 200, code: null });

  const changed = await auth("/user", { method: "PUT", bearer: a.access_token, body: JSON.stringify({ password: `${who.password}-new` }) });
  assert.equal(changed.status, 200, await changed.text());

  assert.equal(await liveSessions(who.id), 0, "every session row is gone, the changer's included");
  for (const session of [a, b]) {
    assert.deepEqual(await restRead(session.access_token), { status: 401, code: "session_not_found" });
    assert.notEqual((await auth("/user", { bearer: session.access_token })).status, 200);
    assert.equal(await refreshes(session.refresh_token), false);
  }
  const [record] = await sql<{ generation: string }[]>`SELECT generation::text FROM swarm.human_credential_changes WHERE user_id = ${who.id}::uuid`;
  assert.equal(record?.generation, "1");

  // A fresh sign-in with the new password works, and reads again.
  const fresh = await signIn(who.email, `${who.password}-new`);
  assert.deepEqual(await restRead(fresh.access_token), { status: 200, code: null });
  // Signing in is not a credential change: no new revocation.
  assert.equal(await liveSessions(who.id), 1);
});

test("a pending email change from before a password change can no longer be confirmed", async () => {
  const who = await person();
  const a = await signIn(who.email, who.password);
  const requested = await auth("/user", { method: "PUT", bearer: a.access_token, body: JSON.stringify({ email: `moved-${who.email}` }) });
  assert.equal(requested.status, 200, await requested.text());
  const [pending] = await sql<{ pending: boolean }[]>`SELECT (email_change_token_new <> '' OR email_change_token_current <> '') AS pending
    FROM auth.users WHERE id = ${who.id}::uuid`;
  assert.equal(pending?.pending, true, "GoTrue stored the email-change hashes on the user row");

  const changed = await auth("/user", { method: "PUT", bearer: a.access_token, body: JSON.stringify({ password: `${who.password}-new` }) });
  assert.equal(changed.status, 200, await changed.text());
  const [row] = await sql<{ tokens: string; email_change: string }[]>`
    SELECT confirmation_token || recovery_token || email_change_token_new || email_change_token_current ||
      reauthentication_token || phone_change_token AS tokens, email_change
    FROM auth.users WHERE id = ${who.id}::uuid`;
  assert.deepEqual(row, { tokens: "", email_change: "" }, "every pending verification hash on the user row is cleared");
});

/** Confirmation links from the local mail catcher (Mailpit, or the older Inbucket API). */
async function confirmationLinks(address: string): Promise<string[]> {
  const base = local.MAILPIT_URL ?? local.INBUCKET_URL ?? "http://127.0.0.1:54324";
  const links = (html: string) => [...html.matchAll(/href="([^"]*\/auth\/v1\/verify\?[^"]*)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const search = await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`).catch(() => null);
    if (search?.ok) {
      const found = await search.json() as { messages?: Array<{ ID: string }> };
      const bodies = await Promise.all((found.messages ?? []).map(async (m) =>
        ((await (await fetch(`${base}/api/v1/message/${m.ID}`)).json()) as { HTML?: string }).HTML ?? ""));
      const all = bodies.flatMap(links);
      if (all.length > 0) return all;
    } else {
      const mailbox = address.split("@")[0]!;
      const list = await fetch(`${base}/api/v1/mailbox/${mailbox}`).catch(() => null);
      if (list?.ok) {
        const messages = await list.json() as Array<{ id: string }>;
        const bodies = await Promise.all(messages.map(async (m) =>
          ((await (await fetch(`${base}/api/v1/mailbox/${mailbox}/${m.id}`)).json()) as { body?: { html?: string } }).body?.html ?? ""));
        const all = bodies.flatMap(links);
        if (all.length > 0) return all;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no confirmation link reached ${address}`);
}

test("a confirmed email change through GoTrue's verify links ends every session, including the one the last link issues", async () => {
  const who = await person();
  const a = await signIn(who.email, who.password);
  const b = await signIn(who.email, who.password);
  const moved = `moved-${who.email}`;
  const requested = await auth("/user", { method: "PUT", bearer: a.access_token, body: JSON.stringify({ email: moved }) });
  assert.equal(requested.status, 200, await requested.text());

  // Double confirmation: one link to the current address and one to the new address.
  const issued: string[] = [];
  for (const address of [who.email, moved]) {
    for (const link of await confirmationLinks(address)) {
      const response = await fetch(link, { redirect: "manual" });
      const location = response.headers.get("location") ?? "";
      const token = new URLSearchParams(location.split("#")[1] ?? "").get("access_token");
      if (token) issued.push(token);
    }
  }
  const [user] = await sql<{ email: string }[]>`SELECT email FROM auth.users WHERE id = ${who.id}::uuid`;
  assert.equal(user?.email, moved, "both links confirmed and GoTrue applied the change");

  assert.equal(await liveSessions(who.id), 0, "no session survives, including one the verify request issued");
  for (const token of [a.access_token, b.access_token, ...issued]) {
    assert.deepEqual(await restRead(token), { status: 401, code: "session_not_found" });
  }
  const fresh = await signIn(moved, who.password);
  assert.deepEqual(await restRead(fresh.access_token), { status: 200, code: null });
});

test("a session issued later in the same transaction as the change is gone at commit; the change still commits", async () => {
  const who = await person();
  const session = randomUUID();
  await sql.begin(async (tx) => {
    await tx`UPDATE auth.users SET email = ${`same-tx-${who.email}`} WHERE id = ${who.id}::uuid`;
    await tx`INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES (${session}::uuid, ${who.id}::uuid, now(), now())`;
  });
  const [row] = await sql<{ email: string }[]>`SELECT email FROM auth.users WHERE id = ${who.id}::uuid`;
  assert.equal(row?.email, `same-tx-${who.email}`);
  assert.equal(await liveSessions(who.id), 0);
});

test("only a confirmed account's password or email change revokes; other updates and other people are untouched", async () => {
  const who = await person();
  const other = await person();
  const a = await signIn(who.email, who.password);
  const o = await signIn(other.email, other.password);
  await sql`UPDATE auth.users SET last_sign_in_at = now(), raw_user_meta_data = '{"name":"x"}' WHERE id = ${who.id}::uuid`;
  assert.deepEqual(await restRead(a.access_token), { status: 200, code: null }, "an ordinary update revokes nothing");

  // An unconfirmed account (GoTrue removes an unverified password when a provider identity links).
  const unconfirmed = await person();
  await signIn(unconfirmed.email, unconfirmed.password);
  await sql`UPDATE auth.users SET email_confirmed_at = NULL WHERE id = ${unconfirmed.id}::uuid`;
  await sql`UPDATE auth.users SET encrypted_password = NULL WHERE id = ${unconfirmed.id}::uuid`;
  assert.equal(await liveSessions(unconfirmed.id), 1, "the unconfirmed account's change is not a credential change");

  await sql`UPDATE auth.users SET encrypted_password = 'changed' WHERE id = ${who.id}::uuid`;
  assert.equal(await liveSessions(who.id), 0);
  assert.deepEqual(await restRead(o.access_token), { status: 200, code: null }, "another person keeps their session");
});

test("PostgREST lets anon and service_role through and refuses a human token with no live session", async () => {
  const anon = await fetch(`${local.API_URL}/rest/v1/channels?select=channel_id&limit=1`, {
    headers: { apikey: local.ANON_KEY, authorization: `Bearer ${local.ANON_KEY}`, "accept-profile": "swarm_read" } });
  // anon may be refused by the view's own grants, but never by the session check.
  assert.notEqual((await anon.json() as { code?: string }).code, "session_not_found", "anon is not refused by the session check");
  const service = await fetch(`${local.API_URL}/rest/v1/channels?select=channel_id&limit=1`, {
    headers: { apikey: local.SERVICE_ROLE_KEY, authorization: `Bearer ${local.SERVICE_ROLE_KEY}`, "accept-profile": "swarm_read" } });
  assert.notEqual((await service.json() as { code?: string }).code, "session_not_found");

  // The check itself, as PostgREST runs it: the request's role and claims.
  const check = async (claims: Record<string, unknown>, role: string) => await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    await tx`SELECT swarm_session.require_live_human_session()`;
  });
  const who = await person();
  const live = await signIn(who.email, who.password);
  const sessionId = JSON.parse(Buffer.from(live.access_token.split(".")[1]!, "base64url").toString()).session_id as string;
  await check({ role: "authenticated", sub: who.id, session_id: sessionId }, "authenticated");
  for (const claims of [
    { role: "authenticated", sub: who.id },
    { role: "authenticated", sub: who.id, session_id: "not-a-uuid" },
    { role: "authenticated", sub: who.id, session_id: randomUUID() },
    { role: "authenticated", sub: (await person()).id, session_id: sessionId },
  ]) {
    await assert.rejects(() => check(claims, "authenticated"), (error: { code?: string }) => error.code === "PGRST", JSON.stringify(claims));
  }
  // No agent exemption: agent claims on a dead session are refused too.
  await sql`DELETE FROM auth.sessions WHERE id = ${sessionId}::uuid`;
  await assert.rejects(() => check({ role: "authenticated", sub: who.id, session_id: sessionId, agent_principal_id: randomUUID() }, "authenticated"),
    (error: { code?: string }) => error.code === "PGRST");
  await check({ role: "anon" }, "anon");
  await check({ role: "service_role" }, "service_role");
});

test("command and OAuth admission hold the fence: a change waits for an admitted transaction, then revokes it", async () => {
  const who = await person();
  const live = await signIn(who.email, who.password);
  const sessionId = JSON.parse(Buffer.from(live.access_token.split(".")[1]!, "base64url").toString()).session_id as string;
  const admit = (tx: postgres.TransactionSql, session = sessionId) =>
    tx`SELECT swarm_session.admit_human_session(${who.id}::uuid, ${session}::uuid) AS ok`.then((rows) => (rows[0] as { ok: boolean }).ok);

  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let changed = false;
  const admitted = sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE swarm_command`;
    assert.equal(await admit(tx), true);
    await held; // an authority-changing write would happen here
  });
  await new Promise((r) => setTimeout(r, 200));
  const change = sql`UPDATE auth.users SET encrypted_password = 'changed-under-fence' WHERE id = ${who.id}::uuid`.then(() => { changed = true; });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(changed, false, "the change waits for the admitted transaction");
  release();
  await admitted;
  await change;
  assert.equal(changed, true);
  assert.equal(await sql.begin(async (tx) => { await tx`SET LOCAL ROLE swarm_command`; return await admit(tx); }), false,
    "after the change the session is no longer admitted");
  for (const role of ["anon", "authenticated", "swarm_read"]) {
    await assert.rejects(() => sql.begin(async (tx) => { await tx.unsafe(`SET LOCAL ROLE ${role}`); await admit(tx); }), /permission denied/);
  }
});

test("each real caller role reaches only its own wrapper, and never the swarm schema", async () => {
  // As PostgREST runs it: the impersonated role, a live human session, through the wrapper's schema.
  const who = await person();
  const live = await signIn(who.email, who.password);
  const sessionId = JSON.parse(Buffer.from(live.access_token.split(".")[1]!, "base64url").toString()).session_id as string;
  const asRole = <T>(role: string, claims: Record<string, unknown>, run: (tx: postgres.TransactionSql) => Promise<T>) =>
    sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
      return await run(tx);
    }) as Promise<T>;
  const human = { role: "authenticated", sub: who.id, session_id: sessionId };
  await asRole("authenticated", human, (tx) => tx`SELECT swarm_session.require_live_human_session()`);
  await asRole("anon", { role: "anon" }, (tx) => tx`SELECT swarm_session.require_live_human_session()`);
  await asRole("service_role", { role: "service_role" }, (tx) => tx`SELECT swarm_session.require_live_human_session()`);
  const [own] = await asRole("authenticated", human, (tx) => tx<{ live: boolean }[]>`SELECT swarm_session.current_human_session_live() AS live`);
  assert.equal(own?.live, true);
  const [admitted] = await asRole("swarm_command", {}, (tx) => tx<{ ok: boolean }[]>`SELECT swarm_session.admit_human_session(${who.id}::uuid, ${sessionId}::uuid) AS ok`);
  assert.equal(admitted?.ok, true, "swarm_command");
  // The test connection can't SET ROLE to the OAuth runtime; its reach is checked by privilege.
  const [runtime] = await sql<{ usage: boolean; admit: boolean; inner: boolean; record: boolean }[]>`SELECT
    has_schema_privilege('commonswarm_oauth_runtime', 'swarm_session', 'USAGE') AS usage,
    has_function_privilege('commonswarm_oauth_runtime', 'swarm_session.admit_human_session(uuid,uuid)', 'EXECUTE') AS admit,
    has_function_privilege('commonswarm_oauth_runtime', 'swarm.human_session_live(jsonb)', 'EXECUTE') AS inner,
    has_table_privilege('commonswarm_oauth_runtime', 'swarm.human_credential_changes', 'SELECT') AS record`;
  assert.deepEqual(runtime, { usage: true, admit: true, inner: false, record: false });
  // Nothing broader: no client role reaches the inner checker, the record or the admission.
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(() => asRole(role, human, (tx) => tx`SELECT swarm.human_session_live(${JSON.stringify(human)}::jsonb)`), /permission denied/);
    await assert.rejects(() => asRole(role, human, (tx) => tx`SELECT swarm_session.admit_human_session(${who.id}::uuid, ${sessionId}::uuid)`), /permission denied/);
  }
  const [schemas] = await sql<{ anon: boolean; authn: boolean; runtime: boolean }[]>`SELECT
    has_schema_privilege('anon', 'swarm', 'USAGE') AS anon, has_schema_privilege('authenticated', 'swarm', 'USAGE') AS authn,
    has_schema_privilege('commonswarm_oauth_runtime', 'swarm', 'USAGE') AS runtime`;
  assert.deepEqual(schemas, { anon: false, authn: false, runtime: false });
});

test("the fence's privileges are exactly the narrow ones, and the member Realtime topics need a live session", async () => {
  const [role] = await sql<{ login: boolean; inherit: boolean; bypass: boolean; superuser: boolean }[]>`
    SELECT rolcanlogin AS login, rolinherit AS inherit, rolbypassrls AS bypass, rolsuper AS superuser
    FROM pg_roles WHERE rolname = 'commonswarm_credential_fence'`;
  assert.deepEqual(role, { login: false, inherit: false, bypass: false, superuser: false });
  const [reads] = await sql<{ hash: boolean; update: boolean; inner: boolean }[]>`SELECT
    has_column_privilege('commonswarm_credential_fence', 'auth.users', 'encrypted_password', 'SELECT') AS hash,
    has_table_privilege('commonswarm_credential_fence', 'auth.users', 'UPDATE') AS update,
    has_function_privilege('authenticated', 'swarm.human_session_live(jsonb)', 'EXECUTE') AS inner`;
  assert.deepEqual(reads, { hash: false, update: false, inner: false });
  const policies = await sql<{ name: string; qual: string }[]>`SELECT policyname AS name, qual FROM pg_policies
    WHERE schemaname = 'realtime' AND tablename = 'messages' AND roles @> '{authenticated}'`;
  assert.equal(policies.length, 3);
  for (const policy of policies) assert.match(policy.qual, /current_human_session_live/, policy.name);
});
