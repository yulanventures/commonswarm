import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createAdminGateHandler, readAdminGate } from "../src/admin-gate.js";
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
function coordinator({ record = measured, mismatches = 0, failure = false, hang = false } = {}) {
  const statements = [];
  return { statements, instance: new AdminTransactionCoordinator({ connect: async () => ({
    query: async sql => {
      statements.push(sql);
      if (sql.includes("session_user")) return { rows: [{ principal: "commonswarm_admin_issuer" }] };
      if (sql.includes("admin_cutover_state")) {
        if (failure) throw Object.assign(new Error("private diagnostic"), {code:"08006"});
        if (hang) return new Promise(() => {});
        return {rows: record ? [record] : []};
      }
      if (sql.includes("migration_checksum_failures")) return {rowCount:mismatches};
      return {command:sql, rows:[]};
    }, release() {},
  }) }) };
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
  assert.equal(await readAdminGate(true,good.instance),"open");
  assert.ok(good.statements.some(sql=>sql.includes("statement_timeout")));
  assert.ok(!good.statements.some(sql=>/\b(?:INSERT|UPDATE|DELETE)\b/u.test(sql)));
  for (const options of [{record:null},{record:{...measured,admin_issuance_enabled:false}},
    {record:{...measured,invalidated_at:new Date()}},{record:{...measured,measured_mount:"wrong"}}, {mismatches:1}]) {
    assert.equal(await readAdminGate(true,coordinator(options).instance),"closed");
  }
  assert.equal(await readAdminGate(false,good.instance),"closed");
  assert.equal(await readAdminGate(true,null),"closed");
});
test("admin effective gate maps database failure, connection failure and bounded timeout to unavailable", async () => {
  assert.equal(await readAdminGate(true,coordinator({failure:true}).instance),"unavailable");
  const broken = new AdminTransactionCoordinator({connect:async()=>{throw new Error("private");}});
  assert.equal(await readAdminGate(true,broken),"unavailable");
  assert.equal(await readAdminGate(true,coordinator({hang:true}).instance,20),"unavailable");
  assert.equal(await readAdminGate(true,coordinator().instance),"open");
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
