import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { AdminTransactionCoordinator, AdminTransactionError, adminQuery, adminTransactionContext, withAdminRole, joinAdminTransaction,
  scopedAdminPool } from "../src/admin-transaction.js";

const latch = () => { let release; return { promise: new Promise(r => { release = r; }), release: () => release() }; };
function database({ commit, beforeQuery, principal = "commonswarm_admin_issuer" } = {}) {
  let id = 0;
  const clients = [];
  return { clients, connect: async () => {
    const client = { processID: ++id, sql: [], releases: [],
      async query(sql) {
        this.sql.push(sql);
        await beforeQuery?.(sql, this);
        if (sql === "SELECT session_user AS principal") return { rows: [{ principal }] };
        if (sql === "COMMIT" && commit) return commit(this);
        return { command: sql.split(" ")[0], rows: [], rowCount: 0 };
      }, release(unknown) { this.releases.push(unknown); } };
    clients.push(client); return client;
  } };
}
async function serverFixture(t, pool, callback) {
  const coordinator = new AdminTransactionCoordinator(pool);
  const server = createServer((request, response) => coordinator.run(response, scope => callback(request, response, scope)));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("production coordinator buffers direct interaction/HTTP output until COMMIT and separates overlapping requests", async t => {
  const entered = latch(), finish = latch(), pool = database({ commit: async client => {
    if (client.processID === 1) { entered.release(); await finish.promise; }
    return { command: "COMMIT" };
  } });
  const origin = await serverFixture(t, pool, async (request, response, scope) => {
    await withAdminRole("swarm_command", () => adminQuery("SELECT 1"));
    await adminQuery("SELECT 2");
    assert.equal(adminTransactionContext(), scope);
    response.writeHead(303, { location: "/next" }); response.end("held");
  });
  let returned = false;
  const first = fetch(origin, { redirect: "manual" }).then(response => { returned = true; return response; });
  await entered.promise;
  const second = await fetch(origin, { redirect: "manual" });
  assert.equal(second.status, 303); assert.equal(await second.text(), "held");
  assert.equal(returned, false);
  assert.equal(pool.clients.length, 2);
  assert.notEqual(pool.clients[0].processID, pool.clients[1].processID);
  finish.release(); const response = await first;
  assert.equal(response.status, 303);
  assert.equal(await response.text(), "held");
  for (const client of pool.clients) {
    assert.equal(client.sql.filter(sql => sql === "BEGIN").length, 1);
    assert.equal(client.sql.filter(sql => sql === "COMMIT").length, 1);
    assert.ok(client.sql.includes("SET LOCAL ROLE swarm_command"));
  }
  assert.throws(() => adminTransactionContext(), { code: "admin_transaction_required" });
  await assert.rejects(scopedAdminPool().connect(), { code: "admin_transaction_required" });
});

test("failed admin units release their client; failed rollback destroys it and a later unit commits", async t => {
  for (const mode of ["begin", "role", "write", "nested-write", "callback", "rollback"]) await t.test(mode, async t => {
    const failure = Object.assign(new Error("injected database failure"), { code: "22012" });
    const pool = database({ beforeQuery: (sql, client) => {
      if (client.processID !== 1) return;
      if ((mode === "begin" && sql === "BEGIN") ||
          (mode === "role" && sql === "SET LOCAL ROLE swarm_command") ||
          (["write", "nested-write"].includes(mode) && sql === "UPDATE revoke_fixture") ||
          (mode === "rollback" && sql === "ROLLBACK")) throw failure;
    } });
    const origin = await serverFixture(t, pool, async (request, response) => {
      response.end("staged-result");
      if (request.url === "/healthy") return;
      const write = () => withAdminRole("swarm_command", () => adminQuery("UPDATE revoke_fixture"));
      // A provider catching its adapter's fault still poisons the whole unit.
      if (mode === "nested-write") await joinAdminTransaction(write).catch(() => {});
      else await write();
      if (["callback", "rollback"].includes(mode)) throw failure;
    });
    const refused = await fetch(origin);
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).error, "temporarily_unavailable");
    assert.equal(pool.clients[0].sql.includes("COMMIT"), false);
    assert.equal(pool.clients[0].sql.includes("ROLLBACK"), true);
    assert.deepEqual(pool.clients[0].releases, [mode === "rollback"]);

    const healthy = await fetch(`${origin}/healthy`);
    assert.equal(healthy.status, 200);
    assert.equal(await healthy.text(), "staged-result");
    assert.equal(pool.clients[1].sql.includes("COMMIT"), true);
    assert.deepEqual(pool.clients[1].releases, [false]);
  });
});

test("production coordinator refuses missing context, non-issuer login, caught faults, flushed/overflowed output and aborted commits", async t => {
  for (const mode of ["healthy", "wrong-login", "caught-fault", "flush", "oversize", "rollback-tag"]) {
    await t.test(mode, async t => {
      const pool = database({ principal: mode === "wrong-login" ? "supabase_admin" : undefined,
        commit: mode === "rollback-tag" ? async () => ({ command: "ROLLBACK" }) : undefined });
      const origin = await serverFixture(t, pool, async (_request, response) => {
        if (mode === "caught-fault") await joinAdminTransaction(async () => { throw new Error("fault"); }).catch(() => {});
        if (mode === "flush") { try { response.flushHeaders(); } catch {} }
        if (mode === "oversize") { try { response.write("x".repeat(65537)); } catch {} }
        response.end("secret-response-must-not-escape");
      });
      const response = await fetch(origin), body = await response.text();
      assert.equal(response.status, mode === "healthy" ? 200 : 503);
      assert.equal(body.includes("secret-response"), mode === "healthy");
      assert.equal(pool.clients[0].sql.includes("COMMIT"), ["healthy", "rollback-tag"].includes(mode));
    });
  }
});

test("production coordinator reports uncertain COMMIT as unknown, destroys the client and never retries issuance", async t => {
  let executions = 0;
  const pool = database({ commit: async () => { throw Object.assign(new Error("lost connection"), { code: "ECONNRESET" }); } });
  const origin = await serverFixture(t, pool, async (_request, response) => {
    ++executions; response.end("signed-token");
  });
  const response = await fetch(origin), body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.error, "issuance_outcome_unknown");
  assert.equal(typeof body.request_id, "string"); assert.equal(executions, 1);
  assert.deepEqual(pool.clients[0].releases, [true]);
  assert.equal(pool.clients[0].sql.includes("ROLLBACK"), false);
});

test("coordinator retains the private cause for setup and provider refusals without exposing it over HTTP", async t => {
  for (const mode of ["setup", "provider"]) await t.test(mode, async t => {
    const pool = database({ principal: mode === "setup" ? "supabase_admin" : undefined });
    const coordinator = new AdminTransactionCoordinator(pool);
    let outcome;
    const server = createServer(async (_request, response) => {
      outcome = await coordinator.run(response, () => {
        response.statusCode = 400;
        response.end('{"error":"invalid_scope","private":"staged-artifact"}');
      });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}`);
    assert.equal(response.status, 503);
    assert.equal(outcome.outcome, "refused");
    assert.equal(outcome.cause.code, mode === "setup" ? "admin_issuer_role_required" : "admin_provider_refused");
    const body = await response.text();
    assert.equal(body.includes(outcome.cause.code), false);
    assert.equal(body.includes("staged-artifact"), false);
    assert.equal(pool.clients[0].sql.includes("COMMIT"), false);
  });
});

test("production coordinator uses savepoints for nested adapter work; intentional error fences COMMIT before invalid_grant", async t => {
  const pool = database();
  const origin = await serverFixture(t, pool, async (_request, response, scope) => {
    await joinAdminTransaction(async () => {
      await adminQuery("SELECT 1");
      await joinAdminTransaction(() => adminQuery("SELECT 2"));
    });
    scope.fenceCommittedOnError = true;
    response.statusCode = 400; response.end('{"error":"invalid_grant"}');
  });
  const response = await fetch(origin);
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: "invalid_grant" });
  const commands = pool.clients[0].sql;
  assert.equal(commands.filter(sql => sql === "COMMIT").length, 1);
  assert.equal(commands.filter(sql => sql.startsWith("SAVEPOINT ")).length, 2);
  assert.equal(commands.filter(sql => sql.startsWith("RELEASE SAVEPOINT ")).length, 2);
});

test("every coordinator refusal rolls back to a safe OAuth 503 without releasing staged credentials", async t => {
  const codes = [
    "admin_transaction_required", "admin_transaction_control_forbidden", "admin_role_forbidden",
    "admin_parallel_nested_transaction_forbidden", "admin_response_already_ended",
    "admin_response_too_large", "admin_response_flush_forbidden", "admin_response_incomplete",
    "admin_nested_unit_forbidden", "admin_issuer_role_required", "admin_unawaited_write",
    "admin_provider_refused", "admin_commit_rolled_back", "admin_proof_admission_must_be_separate",
    "admin_failure_audit_must_be_separate", "admin_projection_inconsistent",
    "admin_lifecycle_capability_required", "admin_verified_proof_required", "admin_fresh_human_required",
    "issuance_outcome_unknown", "future_coordinator_refusal",
  ];
  for (const code of codes) await t.test(code, async t => {
    const pool = database(), refusal = new AdminTransactionError(code);
    const origin = await serverFixture(t, pool, async (_request, response) => {
      response.end("staged-credential");
      throw refusal;
    });
    const response = await fetch(origin), body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error, "temporarily_unavailable");
    assert.equal(typeof body.request_id, "string");
    assert.ok(!JSON.stringify(body).includes("staged-credential"));
    assert.ok(pool.clients[0].sql.includes("ROLLBACK"));
    assert.ok(!pool.clients[0].sql.includes("COMMIT"));
    assert.deepEqual(pool.clients[0].releases, [false]);
  });
  const pool = database();
  const origin = await serverFixture(t, pool, async (_request, response) => response.end("healthy"));
  const control = await fetch(origin);
  assert.equal(control.status, 200);
  assert.equal(await control.text(), "healthy");
  assert.ok(pool.clients[0].sql.includes("COMMIT"));
});
