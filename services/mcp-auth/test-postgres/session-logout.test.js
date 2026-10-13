// Prove exchange claim/live binding locally; CI proves real GoTrue logout and
// original auth time against measured v2.197.0 in a disposable database.
// Inputs: dummy credentials and CI database; output: token-free status/version evidence.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createGoTrueClient, readGoTrueSession } from "../src/gotrue.js";

const userId = randomUUID(), sessionId = randomUUID();
const root = "https://auth.example.test/auth/v1", now = Math.floor(Date.now() / 1000);
const sign = text => createHmac("sha256", "DUMMYJWTSECRET").update(text).digest("base64url");
const token = claims => {
  const text = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `${text}.${sign(text)}`;
};
const claims = { iss: root, aud: "authenticated", sub: userId, session_id: sessionId, exp: now + 3600 };

test("exchange requires verified token claims and original live authentication", async () => {
  let jwt = token(claims), live = true, verified = 0;
  const client = createGoTrueClient({ baseUrl: root, provider: "github", pool: {
    query: async (_sql, [sid, uid]) => ({ rows: live && sid === sessionId && uid === userId
      ? [{ session_id: sid, user_id: uid, authenticated_at: new Date((now - 60) * 1000) }] : [] }),
  }, fetch: async (url, options) => {
    if (new URL(url).pathname.endsWith("/token")) return Response.json({ access_token: jwt, refresh_token: "DUMMYREFRESH" });
    const parts = options.headers.authorization.slice(7).split(".");
    verified++;
    return parts[2] === sign(parts.slice(0, 2).join(".")) ? Response.json({ id: userId }) : new Response(null, { status: 401 });
  } });
  const exchange = () => client.exchange({ code: "DUMMYCODE", verifier: "DUMMYVERIFIER" });
  const result = await exchange();
  assert.equal(result.identity.gotrueSessionId, sessionId);
  assert.equal(result.identity.interactiveAuthAtSeconds, now - 60);
  assert.equal(JSON.stringify(result).includes(jwt), false);
  assert.equal(JSON.stringify(result).includes("DUMMYREFRESH"), false);
  for (const changed of [{ iss: "https://wrong.test" }, { aud: "anon" }, { sub: randomUUID() }, { exp: now - 1 }, { session_id: null }]) {
    jwt = token({ ...claims, ...changed });
    await assert.rejects(exchange(), { code: "gotrue_session_unverified" });
  }
  jwt = `${token(claims)}tampered`;
  await assert.rejects(exchange(), { code: "gotrue_refused" });
  jwt = token(claims); live = false;
  await assert.rejects(exchange(), { code: "gotrue_session_unverified" });
  assert.equal(verified, 8);
  assert.equal(await readGoTrueSession(null, { sessionId, userId }), null);
});

const ci = process.env.CI === "true";
test("CI only: box-matched global logout invalidates all linked AS sessions", {
  skip: ci ? false : "CI only: requires Docker and PostgreSQL", timeout: 180_000,
}, async t => {
  // No fallback to a different runtime: missing tools/schema/image fail in CI.
  const { Pool } = await import("pg");
  const databaseUrl = process.env.MCP_OAUTH_TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  const image = "public.ecr.aws/supabase/gotrue:v2.197.0";
  const name = `oauth-logout-${randomUUID()}`, baseUrl = "http://127.0.0.1:18091/auth/v1";
  // Direct container routes lack the gateway's /auth/v1 prefix; issuer retains it.
  const wireFetch = (url, options) => {
    const target = new URL(url); target.pathname = target.pathname.replace(/^\/auth\/v1/u, "");
    return fetch(target, options);
  };
  const docker = args => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 });
  const directory = mkdtempSync(join(tmpdir(), "cs-oauth-fixture-"));
  assert.match(directory, /^\/private\/tmp\/anvil-secret\.[A-Za-z0-9]+$/u);
  chmodSync(directory, 0o700);
  const envFile = join(directory, "env");
  const users = [];
  let started = false, isolated, pool;
  const runtime = { query: async (...args) => {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL ROLE commonswarm_oauth_runtime");
      return await connection.query(...args);
    } finally { await connection.query("ROLLBACK"); connection.release(); }
  } };
  const request = async (path, body, accessToken) => {
    const response = await wireFetch(`${baseUrl}/${path}`, { method: "POST", redirect: "manual",
      headers: { "content-type": "application/json", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.ok, true, `GoTrue status ${response.status} at ${path.split("?")[0]}`);
    return response.status === 204 ? null : response.json();
  };
  try {
    const { adminEdgeDatabase } = await import("../../../tests/support/admin-edge-database.ts");
    isolated = await adminEdgeDatabase(databaseUrl);
    assert.notEqual(new URL(isolated.url).pathname, new URL(databaseUrl).pathname, "GoTrue must use a disposable database");
    pool = new Pool({ connectionString: isolated.url, max: 2 });
    const sourceUrl = new URL(databaseUrl); sourceUrl.username = "supabase_admin";
    const source = new Pool({ connectionString: sourceUrl.href, max: 1 });
    try {
      // Schema-only restore needs GoTrue's ledger to prevent replaying its DDL.
      const ledger = await source.query("SELECT version FROM auth.schema_migrations ORDER BY version");
      assert.ok(ledger.rows.length, "GoTrue migration evidence is required");
      for (const { version } of ledger.rows) await pool.query("INSERT INTO auth.schema_migrations(version) VALUES($1)", [version]);
    } finally { await source.end(); }
    const manifest = JSON.parse(docker(["buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest}}"]));
    assert.match(manifest.digest, /^sha256:[0-9a-f]{64}$/u);
    const resolved = `${image.split(":v")[0]}@${manifest.digest}`;
    docker(["pull", resolved]);
    writeFileSync(envFile, ["GOTRUE_API_HOST=0.0.0.0", "GOTRUE_API_PORT=18091", "GOTRUE_DB_DRIVER=postgres",
      `GOTRUE_DB_DATABASE_URL=${isolated.url}`, `API_EXTERNAL_URL=${baseUrl}`, `GOTRUE_JWT_ISSUER=${baseUrl}`,
      "GOTRUE_SITE_URL=http://localhost", "GOTRUE_JWT_SECRET=DUMMYJWTSECRET-FOR-DISPOSABLE-CI-ONLY",
      "GOTRUE_JWT_AUD=authenticated", "GOTRUE_EXTERNAL_EMAIL_ENABLED=true", "GOTRUE_MAILER_AUTOCONFIRM=true",
      "GOTRUE_DISABLE_SIGNUP=false", "GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true", "GOTRUE_LOG_LEVEL=error", ""].join("\n"), { mode: 0o600 });
    docker(["run", "--detach", "--name", name, "--network", "host", "--env-file", envFile, resolved]); started = true;
    let health;
    for (let attempt = 0; attempt < 120; attempt++) {
      health = await wireFetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok ? r.json() : null).catch(() => null);
      if (health) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(health?.version, "v2.197.0");
    t.diagnostic(`production=${image}; CI=${health.version}; registry=${manifest.digest}`);
    const login = async email => request("token?grant_type=password", { email, password: "DUMMYPASSWORD-for-CI-42!" });
    for (let i = 0; i < 2; i++) {
      const email = `oauth-${randomUUID()}@example.test`;
      const signup = await request("signup", { email, password: "DUMMYPASSWORD-for-CI-42!" });
      users.push({ id: signup.user?.id ?? signup.id, email });
    }
    const tokens = [await login(users[0].email), await login(users[0].email), await login(users[1].email)];
    // Match the stack's explicit issuer; API_EXTERNAL_URL alone omits iss.
    for (const { access_token } of tokens) {
      const payload = JSON.parse(Buffer.from(access_token.split(".")[1], "base64url").toString("utf8"));
      assert.equal(payload.iss, baseUrl, "GoTrue's configured issuer must equal API_EXTERNAL_URL");
    }
    const client = accessToken => createGoTrueClient({ baseUrl, provider: "github", pool: runtime,
      fetch: (url, options) => new URL(url).pathname.endsWith("/token")
        ? Promise.resolve(Response.json({ access_token: accessToken })) : wireFetch(url, options) });
    const exchange = accessToken => client(accessToken).exchange({ code: "DUMMYCODE", verifier: "DUMMYVERIFIER" });
    const identities = await Promise.all(tokens.map(async ({ access_token }) => (await exchange(access_token)).identity));
    for (const identity of identities) {
      await pool.query(`INSERT INTO commonswarm_oauth.browser_sessions(session_hash,user_id,gotrue_session_id,authenticated_at,expires_at)
        VALUES ($1,$2,$3,to_timestamp($4),now()+interval '1 hour')`, [Buffer.from(randomUUID().replaceAll("-", "").repeat(2), "hex"),
        identity.userId, identity.gotrueSessionId, identity.interactiveAuthAtSeconds]);
    }
    // A still-live deadline update must not revoke the AS binding.
    await pool.query("UPDATE auth.sessions SET not_after=now()+interval '1 day' WHERE id=$1", [identities[2].gotrueSessionId]);
    const future = await pool.query("SELECT invalidated_at FROM commonswarm_oauth.browser_sessions WHERE gotrue_session_id=$1", [identities[2].gotrueSessionId]);
    assert.equal(future.rows[0].invalidated_at, null);
    const refreshed = await request("token?grant_type=refresh_token", { refresh_token: tokens[0].refresh_token });
    const refreshIdentity = (await exchange(refreshed.access_token)).identity;
    assert.equal(refreshIdentity.gotrueSessionId, identities[0].gotrueSessionId);
    assert.equal(refreshIdentity.interactiveAuthAtSeconds, identities[0].interactiveAuthAtSeconds);
    await assert.rejects(exchange(`${tokens[2].access_token}tampered`), { code: "gotrue_refused" });
    assert.equal(await readGoTrueSession(runtime, { sessionId: identities[2].gotrueSessionId, userId: users[0].id }), null);
    for (const table of ["sessions", "users", "refresh_tokens", "mfa_amr_claims"]) {
      await assert.rejects(runtime.query(`SELECT * FROM auth.${table} LIMIT 1`), { code: "42501" });
    }
    await request("logout?scope=global", {}, refreshed.access_token);
    const removed = await pool.query("SELECT count(*)::int AS remaining FROM auth.sessions WHERE user_id=$1", [users[0].id]);
    assert.equal(removed.rows[0].remaining, 0, "the observed global logout event deletes auth.sessions rows");
    for (const identity of identities.slice(0, 2)) {
      assert.equal(await readGoTrueSession(runtime, { sessionId: identity.gotrueSessionId, userId: identity.userId }), null);
    }
    await assert.rejects(exchange(tokens[0].access_token));
    const rows = await pool.query("SELECT user_id, invalidated_at FROM commonswarm_oauth.browser_sessions WHERE user_id=ANY($1::uuid[])", [users.map(u => u.id)]);
    assert.equal(rows.rows.filter(r => r.user_id === users[0].id && r.invalidated_at !== null).length, 2);
    assert.equal(rows.rows.filter(r => r.user_id === users[1].id && r.invalidated_at === null).length, 1);
    assert.equal((await exchange(tokens[2].access_token)).identity.userId, users[1].id);
    t.diagnostic("global logout: both linked sessions invalid; unrelated-user control valid; refresh preserves auth time");
  } finally {
    try { if (started) docker(["rm", "--force", name]); } finally {
      try { await pool?.end(); } finally {
        try { await isolated?.close(); } finally {
          if (existsSync(envFile)) execFileSync("rm", ["--", envFile]);
          execFileSync("rm", ["-d", "--", directory]);
        }
      }
    }
  }
});
