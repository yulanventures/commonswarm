import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createAdminGateHandler, effectiveAdminGate } from "../src/admin-gate.js";
import { AdminTransactionCoordinator } from "../src/admin-transaction.js";
import { createHandler } from "../src/server.js";

const measured = {
  admin_issuance_enabled: true, legacy_closed: true, auth_contract_version: 2,
  lane8_evidence_digest: "d".repeat(64), measurement_evidence_ref: "reviewed-step", measured_at: new Date(),
  approved_edge_release_sha: "a".repeat(40), measured_edge_release_sha: "a".repeat(40),
  measured_edge_target: `/home/commonswarm/edge/releases/${"a".repeat(40)}`,
  measured_mount: `/home/commonswarm/edge/releases/${"a".repeat(40)}`,
  measured_generation: 1, release_generation: 1, measured_artifact_digest: "e".repeat(64),
  measured_image_digest: `sha256:${"f".repeat(64)}`,
};
function coordinator({ record = measured, mismatches = 0, failure = false, hang = false, hangAt } = {}) {
  const statements = [];
  const releases = []; let pendingReject, ended = 0, pending = 0;
  const wait = () => {
    pending++;
    return new Promise((_, reject) => { pendingReject = reject; }).finally(() => { pending--; });
  };
  return { statements, releases, get ended() { return ended; }, get pending() { return pending; }, instance: new AdminTransactionCoordinator({ connect: async () => ({
    query: async sql => {
      statements.push(sql);
      if (sql === hangAt) return wait();
      if (sql.includes("session_user")) return { rows: [{ principal: "commonswarm_admin_issuer" }] };
      if (sql.includes("admin_cutover_state")) {
        if (failure) throw Object.assign(new Error("private diagnostic"), {code:"08006"});
        if (hang) return wait();
        return {rows: record ? [record] : []};
      }
      if (sql.includes("migration_checksum_failures")) return {rowCount:mismatches};
      return {command:sql, rows:[]};
    }, async end() { ended++; pendingReject?.(new Error("connection terminated")); },
    release(discard) { releases.push(discard); },
  }) }, { adminIssuanceEnabled: true }) };
}
function response() {
  const headers = new Map();
  return { statusCode:200, headersSent:false, body:"", destroyed:false,
    setHeader:(k,v)=>headers.set(k,v), getHeader:k=>headers.get(k),
    writeHead(status, extra={}) { this.statusCode=status; for(const [k,v] of Object.entries(extra)) headers.set(k,v); },
    end(body) { this.body=body ?? ""; }, write() {}, flushHeaders() {},
    getHeaderNames:()=>[...headers.keys()], removeHeader:k=>headers.delete(k),
  };
}
test("admin effective gate reuses measured release and ledger refusals with a valid open control", async () => {
  const good = coordinator();
  assert.equal(await effectiveAdminGate({ coordinator: good.instance }),"open");
  assert.ok(good.statements.some(sql=>sql.includes("statement_timeout")));
  assert.ok(!good.statements.some(sql=>/\b(?:INSERT|UPDATE|DELETE)\b/u.test(sql)));
  for (const options of [{record:null},{record:{...measured,admin_issuance_enabled:false}},
    {record:{...measured,invalidated_at:new Date()}},{record:{...measured,measured_mount:"wrong"}}, {mismatches:1}]) {
    assert.equal(await effectiveAdminGate({ coordinator: coordinator(options).instance }),"closed");
  }
  assert.equal(await effectiveAdminGate({ coordinator: new AdminTransactionCoordinator({ connect() { throw new Error("OFF must not connect"); } }) }),"closed");
  assert.equal(await effectiveAdminGate(),"closed");
});
test("admin effective gate maps database failure, connection failure and bounded timeout to unavailable", async () => {
  assert.equal(await effectiveAdminGate({ coordinator: coordinator({failure:true}).instance }),"unavailable");
  const broken = new AdminTransactionCoordinator({connect:async()=>{throw new Error("private");}}, { adminIssuanceEnabled: true });
  assert.equal(await effectiveAdminGate({ coordinator: broken }),"unavailable");
  const hung = coordinator({hang:true});
  assert.equal(await effectiveAdminGate({coordinator: hung.instance, timeoutMs:20}),"unavailable");
  assert.equal(hung.pending, 0, "no query may remain pending after the gate returns");
  assert.equal(hung.ended, 1, "deadline must terminate the query connection");
  assert.deepEqual(hung.releases, [true], "cancelled client must not return to the pool");
  assert.ok(!hung.statements.includes("COMMIT"));
  assert.equal(await effectiveAdminGate({ coordinator: coordinator().instance }),"open");
});
test("public admin gate is closed today, GET/HEAD only and exposes exactly a no-store state", async () => {
  const handler = createAdminGateHandler({issuerPool:{connect(){throw new Error("must not connect while OFF");}}});
  for (const method of ["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"]) {
    const res=response(); await handler({method},res);
    assert.equal(res.getHeader("cache-control"),"no-store");
    assert.equal(res.getHeader("access-control-allow-origin"),"*");
    assert.equal(res.statusCode,["GET","HEAD"].includes(method)?200:405);
    assert.equal(res.body,method==="GET"?'{"state":"closed"}':"");
    if(res.statusCode===405) assert.equal(res.getHeader("allow"),"GET, HEAD");
  }
});
test("server routes the gate while public authorization is disabled and preserves health and provider controls", async () => {
  const provider = new EventEmitter(); let calls=0;
  provider.callback=()=>async(_req,res)=>{calls++;res.writeHead(204);res.end();};
  const pool={query:async()=>({rows:[{healthy:true}]})},logger={info(){},error(){}};
  const make=enabled=>createHandler({provider,pool,logger,publicAuthorizationEnabled:enabled,maxBodyBytes:100});
  for(const [url,status,body] of [["/admin/gate",200,'{"state":"closed"}'],["/admin/gate?resource=https://api.commonswarm.com/admin",200,'{"state":"closed"}'],["/health",200,'{"status":"ok"}'],["/authorize",503,'{"error":"authorization_service_disabled"}']]) {
    const req=Readable.from([]);Object.assign(req,{url,method:"GET",headers:{}});
    const res=response();await make(false)(req,res);assert.equal(res.statusCode,status);assert.equal(res.body,body);
  }
  const req=Readable.from([]);Object.assign(req,{url:"/register",method:"GET",headers:{}});
  const res=response();await make(true)(req,res);assert.equal(res.statusCode,204);assert.equal(calls,1);
});


test("public admin gate mirrors the effective predicate for open, closed and unavailable states", async () => {
  for (const [options, enabled, expected] of [
    [{}, true, "open"], [{}, false, "closed"], [{record: null}, true, "closed"],
    [{record: {...measured, admin_issuance_enabled: false}}, true, "closed"],
    [{record: {...measured, legacy_closed: false}}, true, "closed"],
    [{record: {...measured, invalidated_at: new Date()}}, true, "closed"],
    [{mismatches: 1}, true, "closed"], [{failure: true}, true, "unavailable"],
  ]) {
    const c = coordinator(options);
    const handler = createAdminGateHandler({ issuerPool: c.instance.pool, adminIssuanceEnabled: enabled });
    for (const method of ["GET", "HEAD"]) {
      const res = response(); await handler({method}, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body, method === "HEAD" ? "" : JSON.stringify({state: expected}));
      assert.equal(res.getHeader("cache-control"), "no-store");
    }
  }
  const absent = response();
  await createAdminGateHandler({adminIssuanceEnabled:true})({method:"GET"}, absent);
  assert.equal(absent.body, '{"state":"closed"}');
});

test("admin gate cancellation releases a client acquired after its deadline without starting queries", async () => {
  let resolve, queries = 0;
  const releases = [];
  const c = new AdminTransactionCoordinator({connect:() => new Promise(r => { resolve = r; })}, {adminIssuanceEnabled:true});
  assert.equal(await effectiveAdminGate({coordinator:c, timeoutMs:20}), "unavailable");
  resolve({query() { queries++; }, release(discard) { releases.push(discard); }});
  await new Promise(r => setImmediate(r));
  assert.equal(queries, 0);
  assert.deepEqual(releases, [true]);
  assert.equal(await effectiveAdminGate({coordinator:coordinator().instance}), "open");
});


test("admin gate deadline also terminates transaction setup and uncertain COMMIT", async () => {
  for (const hangAt of ["BEGIN", "SELECT session_user AS principal", "SET LOCAL ROLE commonswarm_oauth_runtime", "COMMIT"]) {
    const c = coordinator({hangAt});
    assert.equal(await effectiveAdminGate({coordinator:c.instance, timeoutMs:20}), "unavailable");
    assert.equal(c.ended, 1);
    assert.equal(c.pending, 0);
    assert.deepEqual(c.releases, [true]);
    assert.equal(c.statements.includes("ROLLBACK"), false, "aborted connection cannot be reused for rollback");
  }
  assert.equal(await effectiveAdminGate({coordinator:coordinator().instance}), "open");
});
