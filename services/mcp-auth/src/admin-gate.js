import { ADMIN_AS_ISSUANCE_ENABLED, AdminConsentError } from "./admin-consent.js";
import { requireMeasuredAdminRelease } from "./admin-lifecycle.js";
import { AdminTransactionCoordinator, adminQuery } from "./admin-transaction.js";

// Keep the coordinator's buffered error response private. The public read has
// exactly one field, including when connection, query or commit fails.
function privateResponse() {
  const headers = new Map();
  return { statusCode: 200, headersSent: false, destroyed: false,
    setHeader: (key, value) => headers.set(key, value),
    getHeaderNames: () => [...headers.keys()], removeHeader: key => headers.delete(key),
    writeHead() {}, write() {}, end() {}, flushHeaders() {} };
}

export async function readAdminGate(enabled, coordinator, timeoutMs = 2000) {
  if (!enabled || !coordinator) return "closed";
  let timer;
  try {
    return await Promise.race([
      (async () => {
        let state = "unavailable";
        const response = privateResponse();
        const result = await coordinator.run(response, async () => {
          // The existing predicate takes a shared row lock; READ ONLY would
          // refuse that lock. Its queries and this route perform no writes.
          await adminQuery("SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$1,true)", [String(timeoutMs)]);
          try { await requireMeasuredAdminRelease(); state = "open"; }
          catch (error) {
            if (!(error instanceof AdminConsentError)) throw error;
            state = "closed";
          }
          response.end();
        });
        return result.outcome === "committed" ? state : "unavailable";
      })(),
      new Promise(resolve => { timer = setTimeout(() => resolve("unavailable"), timeoutMs); }),
    ]);
  } catch { return "unavailable"; }
  finally { clearTimeout(timer); }
}

export function createAdminGateHandler({ issuerPool }) {
  const coordinator = issuerPool ? new AdminTransactionCoordinator(issuerPool) : null;
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
    const state = await readAdminGate(ADMIN_AS_ISSUANCE_ENABLED, coordinator);
    response.writeHead(200);
    response.end(request.method === "HEAD" ? undefined : JSON.stringify({ state }));
  };
}
