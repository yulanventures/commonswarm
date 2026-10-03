import assert from "node:assert/strict";

// Test-only allowlists: never print arbitrary provider text, SQL, identifiers,
// Location query/fragment/userinfo, or response artifacts.
const oauthCodes = new Set(["invalid_request", "invalid_scope", "invalid_grant", "invalid_target",
  "invalid_client", "invalid_client_metadata", "unauthorized_client", "access_denied",
  "login_required", "consent_required", "interaction_required", "server_error",
  "temporarily_unavailable", "issuance_outcome_unknown", "consent_receipt_invalid", "invalid_dpop_proof",
  "use_dpop_nonce", "ERR_ASSERTION", "ECONNRESET"]);
const descriptions = new Set(["requested scope is not allowed", "scope contains invalid characters",
  "admin issuance closed", "verified hosted admin client required", "admin transaction required",
  "resource indicator is required", "exactly one resource indicator is required",
  "unsupported resource", "grant resource mismatch", "grant request is invalid",
  "request is invalid", "client authentication failed", "oops! something went wrong",
  "End-User authentication is required", "interaction is required from the end-user"]);
const roles = new Set(["supabase_admin", "commonswarm_admin_issuer", "commonswarm_oauth_runtime",
  "swarm_command", "swarm_admin", "none"]);
const phases = new Set(["authorize", "resume", "interaction", "login", "consent-selection",
  "consent-confirmation", "token", "revoke"]);

export async function restoreCutoverState(client, original) {
  const columns = Object.keys(original);
  assert.ok(columns.every(name => /^[a-z_][a-z0-9_]*$/u.test(name)), "invalid cutover column name");
  return client.query(`UPDATE commonswarm_oauth.admin_cutover_state SET ${columns.map((name, i) => `${name}=$${i + 1}`).join(",")}`,
    columns.map(name => original[name]));
}

export function failureCode(error) {
  const code = error?.code ?? error?.error;
  return typeof code === "string" && (oauthCodes.has(code) || /^(?:[A-Z0-9]{5}|admin_[a-z_]+)$/u.test(code))
    ? code : "unclassified_failure";
}
export function safeRole(role) { return roles.has(role) ? role : "other_role"; }
export function safeDescription(value) {
  return value == null ? null : descriptions.has(value) ? value : "[redacted]";
}
export function safeLocation(value) {
  if (!value) return null;
  try {
    const url = new URL(value, "https://mcp.commonswarm.com");
    const host = ["mcp.commonswarm.com", "client.example", "127.0.0.1"].includes(url.hostname)
      ? url.host : "[redacted-host]";
    // Continuation/interaction paths embed opaque IDs; retain their route only.
    const path = /^\/(?:interaction|authorize)\/[^/]+/u.test(url.pathname)
      ? url.pathname.replace(/^(\/(?:interaction|authorize))\/.*$/u, "$1/[redacted]")
      : ["/authorize", "/token", "/callback", "/test-revoke", "/"].includes(url.pathname)
        ? url.pathname : "/[redacted]";
    return `${host}${path}`;
  } catch { return "[redacted-location]"; }
}
export function responseDiagnostic(status, body, location) {
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = undefined; }
  }
  let redirected;
  try { redirected = new URL(location, "https://mcp.commonswarm.com").searchParams; } catch {}
  const code = body?.error ?? redirected?.get("error");
  return { status, error: code == null ? null : failureCode({ error: code }),
    error_description: safeDescription(body?.error_description ?? redirected?.get("error_description")),
    location: safeLocation(location) };
}
export function eventDiagnostic(event, error) {
  const causes = [], seen = new Set();
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    causes.push({ code: failureCode(current), error_description: safeDescription(current.error_description) });
  }
  return { event, causes };
}
export function httpStepDiagnostic(step, method, trace) {
  return { step, method: ["GET", "POST"].includes(method) ? method : "[redacted]",
    phase: phases.has(trace.phase) ? trace.phase : "[redacted]",
    provider_response: trace.providerResponse ?? "not_reached",
    http_response: trace.httpResponse ?? "not_recorded",
    failure: trace.failure == null ? null : failureCode({ code: trace.failure }),
    events: trace.events ?? [], outcome: trace.outcome ?? "not_recorded" };
}
export function atomicDiagnostic(trace) {
  // Only these already-redacted fields reach assertions / CI output.
  const identity = trace.failureIdentity ?? trace.lastStatementIdentity;
  return JSON.stringify({ phase: trace.phase, failure: trace.failure ?? "not_recorded",
    statement: trace.failureStatement ?? "not_recorded", role: trace.failureRole ?? "not_recorded",
    current_user: identity?.current_user ?? "not_recorded",
    selected_role: identity?.role ?? "not_recorded",
    provider_response: trace.providerResponse ?? "not_reached", http_response: trace.httpResponse ?? "not_recorded",
    http_steps: trace.httpSteps,
    events: trace.events, gate: trace.gate, gate_inputs: trace.gateInputs, outcome: trace.outcome });
}
