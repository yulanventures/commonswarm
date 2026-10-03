import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifyAdminProof, admitAdminProof, adminProofAdmitted } from "../src/admin-dpop.js";

async function fixture() {
  const key = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(key.privateKey);
  const jwk = await exportJWK(key.publicKey), jkt = await calculateJwkThumbprint(jwk);
  async function request(claims = {}, header = {}) {
    const proof = await new SignJWT({ htm: "POST", htu: "https://mcp.commonswarm.com/token",
      iat: Math.floor(Date.now()/1000), jti: randomUUID(), nonce: "test-nonce", ...claims })
      .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk, ...header }).sign(key.privateKey, { crit: { custom: true } });
    return { method: "POST", headers: { dpop: proof, "x-forwarded-host": "attacker.example" }, rawHeaders: ["DPoP", proof] };
  }
  return { request, jkt, privateJwk };
}

test("as-dpop-required: canonical same-key proof succeeds; missing/duplicate, key, method, forwarded URI and private-key proofs refuse", async t => {
  const { request, jkt, privateJwk } = await fixture();
  assert.equal((await verifyAdminProof(await request(), jkt)).jkt, jkt);
  const cases = [
    [{ htu: "https://attacker.example/token" }], [{ htu: "https://mcp.commonswarm.com/token?q=1" }],
    [{ htm: "GET" }], [{ iat: 1.5 }], [{ jti: "" }], [{ jti: "é".repeat(101) }],
    [{}, { crit: ["custom"], custom: true }], [{}, { jwk: privateJwk }],
  ];
  for (const [claims, header] of cases) await assert.rejects(verifyAdminProof(await request(claims, header), jkt), { code: "invalid_dpop_proof" });
  const good = await request();
  await assert.rejects(verifyAdminProof(good, "a".repeat(43)), { code: "invalid_dpop_proof" });
  await assert.rejects(verifyAdminProof({ ...good, headers: {} }, jkt), { code: "invalid_dpop_proof" });
  await assert.rejects(verifyAdminProof({ ...good, rawHeaders: [...good.rawHeaders, ...good.rawHeaders] }, jkt), { code: "invalid_dpop_proof" });
});

test("as-dpop-required: admission outcomes COMMIT independently; only verified accepted proofs reach issuance", async () => {
  const { request, jkt } = await fixture();
  for (const status of ["accepted", "nonce_required", "stale_proof", "replay"]) {
    const sql = [], client = { async query(query) {
      sql.push(query);
      if (query.includes("session_user")) return { rows: [{ principal: "commonswarm_admin_issuer" }] };
      if (query.includes("admit_dpop_proof")) return { rows: [{ status }] };
      if (query.includes("register_dpop_nonce")) return { rows: [{ accepted: true }] };
      return { command: query, rows: [] };
    }, release() {} };
    const proof = await verifyAdminProof(await request(), jkt);
    const pool = { connect: async () => client };
    if (status === "accepted") {
      assert.equal(await admitAdminProof(pool, proof), proof); assert.equal(adminProofAdmitted(proof), true);
    } else {
      await assert.rejects(admitAdminProof(pool, proof), error => {
        assert.equal(sql.includes("COMMIT"), true);
        assert.equal(error.code, status === "nonce_required" ? "use_dpop_nonce" : "invalid_dpop_proof");
        if (status === "nonce_required") assert.equal(error.nonce.length, 43);
        return true;
      });
      assert.equal(adminProofAdmitted(proof), false);
    }
    assert.equal(sql.filter(query => query === "COMMIT").length, 1);
    await assert.rejects(admitAdminProof(pool, { ...proof }), { code: "invalid_dpop_proof" });
  }
});
