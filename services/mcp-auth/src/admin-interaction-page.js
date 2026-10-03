import { adminConsentOptions, ADMIN_GRANT_TTL_SECONDS } from "./admin-policy.generated.js";
import { escapeHtml as e, renderConsentDestination } from "./interaction-page.js";

export const FULL_ACCOUNT_WARNING = "This client can create workspaces and change seats and invitations within these limits. That includes future workspaces you own. Workers it creates may read workspace messages and files. If the client or agent host is compromised, someone else can use this access until it expires or you revoke it.";

const LIMIT_LABELS = {
  workspaces: "Workspaces created", live_seats: "Live seats", total_seats: "Seats created in total",
  invitations: "Invitations", live_agent_invitations: "Live agent invitations",
  worker_credentials: "Worker access credentials", connection_attempts: "Connection attempts",
  bearer_seconds: "Worker access lifetime (seconds)", horizon_seconds: "Worker renewal period (seconds)",
  successors_per_worker: "Renewals per worker", successors_per_grant: "Renewals in total",
};
function limits(values) {
  return `<dl>${Object.entries(values).filter(([key]) => key in LIMIT_LABELS)
    .map(([key, value]) => `<dt>${e(LIMIT_LABELS[key])}</dt><dd>${e(value)}</dd>`).join("")}</dl>`;
}
function words(value) { return value.length ? value.map(e).join(", ") : "None"; }

export function renderAdminConsentPage({ uid, user, params, policy, csrfToken, version,
  workspaces = [], receipt, summary, scriptNonce }) {
  const verified = !!policy?.verification && !!policy?.approval;
  const manifest = receipt?.manifest;
  const requested = new Set(policy?.resourceScopes ?? []);
  const options = adminConsentOptions();
  const defaultExpiry = new Date(Date.now() + ADMIN_GRANT_TTL_SECONDS * 1000).toISOString().slice(0, 16);
  const selectedCapabilities = new Set(manifest?.capability_names ?? []);
  const capabilities = manifest
    ? options.flatMap(o => o.capability_names.filter(name => selectedCapabilities.has(name))
      .map(name => `<li>${e(o.label)} — ${e(name.replace(/^admin_/u, "").replaceAll("_", " "))}</li>`)).join("")
    : "";
  const unavailable = options.filter(o => !o.available).map(o => `<li>${e(o.label)} — unavailable</li>`).join("");
  const identity = `<p>Signed in as <strong>${e(user.displayName || user.email || user.userId)}</strong> (${e(user.userId)})</p>
    <p>Client name (supplied by the client): ${e(policy?.metadata?.client_name ?? "Unnamed client")}</p>
    <p>Client ID: ${e(params.client_id)}</p><p>HTTPS client host: ${e(new URL(params.client_id).host)}</p>
    <p>Authorization returns to: ${e(new URL(params.redirect_uri).host)}</p>
    <p>${verified ? `Independently verified publisher: ${e(policy.verification.publisher_identity)}; active verification ${e(policy.verification.verification_version)}. Approved by account owner ${e(policy.approval.owner_user_id)}.` : "This client is unverified. Admin access is unavailable."}</p>`;
  const destination = renderConsentDestination({ clientName: policy?.metadata?.client_name,
    redirectUri: params.redirect_uri, metadataHost: new URL(params.client_id).hostname });
  let form = "";
  if (verified && !manifest) {
    form = `<form method="post" action="/interaction/${encodeURIComponent(uid)}/selection">
      <input type="hidden" name="csrf_token" value="${e(csrfToken)}">
      <input type="hidden" name="selection_version" value="${e(version)}">
      <fieldset><legend>Choose permissions</legend><label><input type="radio" name="mode" value="granular" checked> Choose permissions</label>
      ${policy.fullAccountEligible ? '<label><input type="radio" name="mode" value="full_account"> Full account (requires another confirmation)</label>' : ""}
      ${options.map(o => `<label><input type="checkbox" name="scope_names" value="${e(o.scope)}"${o.scope === "admin:read" ? " checked" : ""}${!o.available || !requested.has(o.scope) ? " disabled" : ""}> ${e(o.label)}${!o.available ? " — unavailable" : ""}</label>`).join("")}
      <p>Read-only views this connection's permissions, expiry and access status. It cannot read messages or files.</p>
      <label><input type="checkbox" disabled> Billing changes are not available</label></fieldset>
      <fieldset><legend>Selected workspaces (optional for account setup)</legend>${workspaces.map(w => `<label><input type="checkbox" name="workspace_ids" value="${e(w.id)}"> ${e(w.name)}</label>`).join("")}</fieldset>
      <label>Access ends (UTC, at most thirty days)<input type="datetime-local" name="expires_at" value="${defaultExpiry}" required></label>
      ${destination}
      <button type="submit">Review exact permissions and limits</button></form>`;
  } else if (manifest && summary) {
    const expiry = new Date(manifest.expires_at);
    form = `<section aria-labelledby="summary"><h2 id="summary">${manifest.mode === "full_account" ? "Full account" : "Chosen permissions"}</h2>
      <p>Named connection: Admin connection ${e(manifest.connection_id)}</p>
      <p>Coverage: ${manifest.workspace_selector === "owned_and_selected" ? "Existing and future workspaces you own, plus selected shared workspaces" : "Only the selected workspaces and expressly approved newly created workspaces"}.</p>
      <p>Selected workspaces: ${words(manifest.workspace_ids.map(id => workspaces.find(w => w.id === id)?.name ?? id))}</p>
      <ul>${capabilities}${unavailable}<li>Billing — unavailable</li><li>Admin delegation — unavailable; this connection cannot create admin grants</li></ul>
      <p>Seat targets: ${manifest.target_rules.own_seats ? "Your own seats" : "No own seats"}; ${manifest.target_rules.grant_created_seats ? "seats created by this connection" : "no grant-created seats"}; named seats: ${words(manifest.target_rules.seat_ids)}.</p>
      <p>Recipients: ${words(manifest.target_rules.recipient_user_ids)}. Recipient connections: ${words(manifest.target_rules.recipient_connection_ids)}.</p>
      <p>Transports: ${words(manifest.target_rules.transports)}. Maximum member role: ${e(manifest.role_ceiling)}.</p>
      <p>Worker content permissions: ${words(manifest.worker_scope_ceiling)}. Workers depend on this grant; replacement or revocation ends dependent access.</p>
      <p>Permissions in newly created workspaces: ${words(manifest.created_workspace_policy.scope_names)}</p>
      <h3>Creation limits</h3>${limits(manifest.issuance_limits)}<h3>Renew seats limits</h3>${limits(manifest.renewal_limits)}
      <p>Worker grant kinds: ${words(manifest.renewal_limits.grant_kinds)}. Existing worker principals: ${words(manifest.renewal_limits.principal_ids)}.</p>
      <p>Access ends on <time id="local-expiry" datetime="${expiry.toISOString()}">${e(expiry.toISOString())}</time><span id="expiry-zone"> (UTC)</span>; UTC: ${e(expiry.toISOString())}. Renewal requires your approval again. You can revoke it in /app.</p>
      <p>Refresh cannot extend this deadline: ${e(new Date(manifest.refresh_deadline).toISOString())}.</p>
      <p id="full-account-warning">${e(FULL_ACCOUNT_WARNING)}</p></section>
      <form method="post" action="/interaction/${encodeURIComponent(uid)}/consent">
        <input type="hidden" name="csrf_token" value="${e(summary.token)}">
        <input type="hidden" name="summary_digest" value="${e(summary.digest)}">
        <input type="hidden" name="selection_version" value="${e(version)}">
        ${manifest.mode === "full_account" ? `<input type="hidden" name="second_token" value="${e(summary.secondToken)}"><label><input type="checkbox" name="confirm_full_account" value="yes" aria-describedby="full-account-warning" required> I confirm this exact full account summary</label>` : ""}
        ${destination}
        <button type="submit">${manifest.mode === "full_account" ? "Confirm full account access" : "Confirm chosen permissions"}</button></form>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review CommonSwarm admin access</title>
    <style>body{font-family:system-ui;max-width:48rem;margin:3rem auto;padding:1rem}label{display:block;margin:.7rem 0}fieldset{margin:1rem 0}dt{font-weight:bold}dd{margin-bottom:.5rem}button{padding:.7rem 1rem}.notice{border:1px solid;padding:1rem}</style></head>
    <body><main><h1>Review admin access</h1>${identity}<p>Admin connections are not available yet. Reviewing a selection does not connect the client.</p>${form}<form method="get" action="https://commonswarm.com/app"><button type="submit">Cancel and return to /app</button></form></main>
    ${manifest && scriptNonce ? `<script nonce="${e(scriptNonce)}">const expiry=document.getElementById("local-expiry");expiry.textContent=new Date(expiry.dateTime).toLocaleString();document.getElementById("expiry-zone").textContent=" (your local time)";</script>` : ""}</body></html>`;
}
