import { AdminConsentError } from "./admin-consent.js";
import { requireMeasuredAdminRelease } from "./admin-lifecycle.js";
import { AdminTransactionCoordinator, adminQuery, adminTransactionContext } from "./admin-transaction.js";

// Keep the coordinator's buffered error response private. The public read has
// exactly one field, including when connection, query or commit fails.
function privateResponse() {
  const headers = new Map();
  return { statusCode: 200, headersSent: false, destroyed: false,
    setHeader: (key, value) => headers.set(key, value),
    getHeaderNames: () => [...headers.keys()], removeHeader: key => headers.delete(key),
    writeHead() {}, write() {}, end() {}, flushHeaders() {} };
}

// One gate for public status and every admin issuance reader. Inside an
// issuance transaction, reuse its client/locks; never cache a positive result.
export async function effectiveAdminGate({ coordinator, timeoutMs = 2000, signal, onRefusal } = {}) {
  // Diagnostics receive only owned, stable reasons; never database messages,
  // release records or SQL. Public gate responses still contain only state.
  const refuse = (state, reason) => { onRefusal?.(reason); return state; };
  const scope = adminTransactionContext(false);
  coordinator ??= scope?.coordinator;
  if (!coordinator || coordinator.adminIssuanceEnabled !== true) return refuse("closed", "admin_issuance_disabled");
  if (scope) {
    try { await requireMeasuredAdminRelease(); return "open"; }
    catch (error) {
      if (error instanceof AdminConsentError) return refuse("closed",
        error.code === "admin_migration_evidence_incomplete" ? error.code : "admin_issuance_disabled");
      return refuse("unavailable", "admin_gate_unavailable");
    }
  }
  const controller = new AbortController();
  const aborted = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let state = "unavailable";
    const response = privateResponse();
    const result = await coordinator.run(response, async () => {
      await adminQuery("SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$1,true)", [String(timeoutMs)]);
      state = await effectiveAdminGate({ onRefusal });
      response.end();
    }, undefined, { signal: controller.signal });
    return result.outcome === "committed" ? state : refuse("unavailable", "admin_gate_unavailable");
  } catch { return refuse("unavailable", "admin_gate_unavailable"); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", aborted);
  }
}

export function createAdminGateHandler({ issuerPool, adminIssuanceEnabled = false }) {
  const coordinator = issuerPool ? new AdminTransactionCoordinator(issuerPool, { adminIssuanceEnabled }) : null;
  return async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json");
    // Public, credential-free state read by the static site's browser.
    response.setHeader("access-control-allow-origin", "*");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }
    const state = await effectiveAdminGate({ coordinator });
    response.writeHead(200);
    response.end(request.method === "HEAD" ? undefined : JSON.stringify({ state }));
  };
}
