import { createHash, randomBytes } from "node:crypto";
import { calculateJwkThumbprint, compactVerify, decodeProtectedHeader, importJWK } from "jose";
import { adminTransactionContext, AdminTransactionError } from "./admin-transaction.js";

const verified = new WeakSet(), admitted = new WeakSet();
export const adminProofAdmitted = proof => proof != null && admitted.has(proof);
const TOKEN_URI = "https://mcp.commonswarm.com/token";
const digest = value => createHash("sha256").update(value).digest();
export class AdminDpopError extends Error {
  constructor(code, nonce) { super(code); this.code = code; this.nonce = nonce; this.status = 400; }
}

// Header/URI/signature checks precede nonce challenges. Forwarded headers never
// enter this function: the AS endpoint is a constant from the reviewed contract.
export async function verifyAdminProof(request, expectedJkt) {
  const values = request.rawHeaders?.filter((_value, index) => index % 2 === 0)
    .filter(value => value.toLowerCase() === "dpop");
  const proof = request.headers.dpop;
  if ((values && values.length !== 1) || typeof proof !== "string" ||
      proof.length > 8192 || proof.includes(",") || proof.split(".").length !== 3) {
    throw new AdminDpopError("invalid_dpop_proof");
  }
  try {
    const header = decodeProtectedHeader(proof), jwk = header.jwk;
    if (header.typ !== "dpop+jwt" || header.alg !== "ES256" || header.crit || header.jku || header.x5u ||
        !jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.d ||
        Object.keys(jwk).some(key => !["kty", "crv", "x", "y", "alg", "use", "key_ops", "kid"].includes(key))) {
      throw new AdminDpopError("invalid_dpop_proof");
    }
    const jkt = await calculateJwkThumbprint(jwk);
    if (jkt !== expectedJkt) throw new AdminDpopError("invalid_dpop_proof");
    const { payload } = await compactVerify(proof, await importJWK(jwk, "ES256"), { algorithms: ["ES256"] });
    const claims = JSON.parse(new TextDecoder().decode(payload));
    if (request.method !== "POST" || claims.htm !== "POST" || claims.htu !== TOKEN_URI ||
        !Number.isSafeInteger(claims.iat) || typeof claims.jti !== "string" ||
        Buffer.byteLength(claims.jti) < 1 || Buffer.byteLength(claims.jti) > 200 ||
        (claims.nonce != null && (typeof claims.nonce !== "string" || claims.nonce.length > 512))) {
      throw new AdminDpopError("invalid_dpop_proof");
    }
    const result = Object.freeze({ jkt, jti: claims.jti, iat: claims.iat, nonce: claims.nonce });
    verified.add(result);
    return result;
  } catch (error) {
    if (error instanceof AdminDpopError) throw error;
    throw new AdminDpopError("invalid_dpop_proof");
  }
}

// This physical transaction MUST complete before the issuance coordinator
// starts its unit. A later rollback cannot unconsume an admitted proof.
export async function admitAdminProof(pool, proof) {
  if (adminTransactionContext(false)) throw new AdminTransactionError("admin_proof_admission_must_be_separate");
  if (!verified.has(proof)) throw new AdminDpopError("invalid_dpop_proof");
  const client = await pool.connect();
  let committing = false, committed = false, unknown = false;
  try {
    await client.query("BEGIN");
    const principal = (await client.query("SELECT session_user AS principal")).rows[0]?.principal;
    if (principal !== "commonswarm_admin_issuer") throw new AdminTransactionError("admin_issuer_role_required");
    await client.query("SET LOCAL ROLE commonswarm_oauth_runtime");
    const status = (await client.query(
      "SELECT commonswarm_oauth.admit_dpop_proof($1,$2,'as',$3,$4) AS status",
      [proof.jti, proof.jkt, proof.iat, proof.nonce == null ? null : digest(proof.nonce)],
    )).rows[0]?.status;
    let nonce;
    if (status === "nonce_required") {
      nonce = randomBytes(32).toString("base64url");
      const row = (await client.query("SELECT commonswarm_oauth.register_dpop_nonce($1,$2,'as') AS accepted",
        [digest(nonce), proof.jkt])).rows[0];
      if (!row?.accepted) throw new AdminDpopError("temporarily_unavailable");
    }
    if (status !== "accepted") {
      await client.query("SELECT commonswarm_oauth.record_admin_security_failure($1)",
        [status === "nonce_required" ? "nonce_required" : status === "replay" ? "replay" : "invalid_dpop"]);
    }
    committing = true;
    const result = await client.query("COMMIT");
    if (result.command !== "COMMIT") throw new AdminTransactionError("admin_commit_rolled_back");
    committing = false; committed = true;
    if (status === "nonce_required") throw new AdminDpopError("use_dpop_nonce", nonce);
    if (status !== "accepted") throw new AdminDpopError("invalid_dpop_proof");
    admitted.add(proof);
    return proof;
  } catch (error) {
    unknown = committing && error.code !== "admin_commit_rolled_back";
    if (!committing && !committed) await client.query("ROLLBACK").catch(() => {});
    if (unknown) throw new AdminTransactionError("issuance_outcome_unknown");
    throw error;
  } finally { client.release(unknown); }
}

export async function recordAdminSecurityFailure(pool, reason) {
  if (adminTransactionContext(false)) throw new AdminTransactionError("admin_failure_audit_must_be_separate");
  const client = await pool.connect(); let uncertain = false, committing = false;
  try {
    await client.query("BEGIN");
    if ((await client.query("SELECT session_user AS principal")).rows[0]?.principal !== "commonswarm_admin_issuer") {
      throw new AdminTransactionError("admin_issuer_role_required");
    }
    await client.query("SET LOCAL ROLE commonswarm_oauth_runtime");
    await client.query("SELECT commonswarm_oauth.record_admin_security_failure($1)", [reason]);
    committing = true;
    if ((await client.query("COMMIT")).command !== "COMMIT") throw new AdminTransactionError("admin_commit_rolled_back");
  } catch (error) {
    uncertain = committing && error.code !== "admin_commit_rolled_back";
    if (!uncertain) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(uncertain); }
}
