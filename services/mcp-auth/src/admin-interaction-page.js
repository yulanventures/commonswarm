import { adminConsentOptions, ADMIN_GRANT_TTL_SECONDS } from "./admin-policy.generated.js";
import { escapeHtml as e, renderConsentDestination, BRAND_MARK, CONSENT_STYLES } from "./interaction-page.js";

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
/** Render consent copy from the shared issuance gate state supplied by the handler. */
export function renderAdminConsentPage({ uid, user, params, policy, csrfToken, version,
  workspaces = [], receipt, summary, scriptNonce, issuanceState }) {
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
  const technical = `<p>Signed in as <strong>${e(user.displayName || user.email || user.userId)}</strong> (${e(user.userId)})</p>
    <p>Client name (supplied by the client): ${e(policy?.metadata?.client_name ?? "Unnamed client")}</p>
    <p>Client ID: ${e(params.client_id)}</p><p>HTTPS client host: ${e(new URL(params.client_id).host)}</p>
    <p>Authorization returns to: ${e(new URL(params.redirect_uri).host)}</p>
    <p>${verified ? `Independently verified publisher: ${e(policy.verification.publisher_identity)}; active verification ${e(policy.verification.verification_version)}. Approved by account owner ${e(policy.approval.owner_user_id)}.` : "This client is unverified. Admin access is unavailable."}</p>`;
  const issuanceLine = issuanceState === "open" ? "Confirming your selection connects the client with exactly your chosen permissions, and you can revoke this access in /app." : "Admin connections are not available yet. Reviewing a selection does not connect the client.";
  const choosing = verified && !manifest;
  // The choice screen leads with who is asking and whose account answers; every other state keeps the full lines.
  const identity = choosing
    ? `<p class="admin-lead">Signed in as <strong>${e(user.displayName || user.email || user.userId)}</strong></p>
    <p class="admin-lead">Verified publisher <strong>${e(policy.verification.publisher_identity)}</strong>, from <strong>${e(new URL(params.client_id).host)}</strong></p>`
    : technical;
  const destination = renderConsentDestination({ clientName: policy?.metadata?.client_name,
    redirectUri: params.redirect_uri, metadataHost: new URL(params.client_id).hostname });
  let form = "";
  if (verified && !manifest) {
    // The choice screen. One decision: how much this app may manage, where, and until when.
    // What can be chosen stays visible; what cannot (not built yet, or not asked for) and the
    // identifiers go under More. Field names, values and defaults are unchanged.
    const offered = options.filter(o => o.available && requested.has(o.scope));
    const notAvailable = [...options.filter(o => !o.available).map(o => o.label), "Billing changes"];
    const notRequested = options.filter(o => o.available && !requested.has(o.scope)).map(o => o.label);
    form = `<form method="post" action="/interaction/${encodeURIComponent(uid)}/selection">
      <input type="hidden" name="csrf_token" value="${e(csrfToken)}">
      <input type="hidden" name="selection_version" value="${e(version)}">
      <fieldset><legend>How much access</legend>
      <label><input type="radio" name="mode" value="granular" checked> <span>Only what I choose below</span></label>
      ${policy.fullAccountEligible ? '<label><input type="radio" name="mode" value="full_account"> <span>Full account<small>Every permission this app asked for, in every workspace you own now and later. It asks you again first.</small></span></label>' : ""}</fieldset>
      <fieldset><legend>What it may do</legend>
      ${offered.map(o => `<label><input type="checkbox" name="scope_names" value="${e(o.scope)}"${o.scope === "admin:read" ? " checked" : ""}> <span>${e(o.label)}${o.scope === "admin:read" ? '<small>Its own permissions, end date and status. No messages or files.</small>' : ""}</span></label>`).join("")}</fieldset>
      ${workspaces.length ? `<fieldset><legend>In which workspaces</legend>${workspaces.map(w => `<label><input type="checkbox" name="workspace_ids" value="${e(w.id)}"> <span>${e(w.name)}</span></label>`).join("")}</fieldset>` : ""}
      <label class="admin-until">Until (UTC, at most thirty days)<input type="datetime-local" name="expires_at" value="${defaultExpiry}" required></label>
      ${destination}
      <p class="admin-state">${issuanceLine}</p>
      <div class="admin-actions"><button type="submit">Review exact permissions and limits</button>
      <a class="admin-quiet" href="https://commonswarm.com/app">Cancel</a></div>
      <details class="admin-more"><summary>More</summary>
      ${notAvailable.length ? `<p>Not available yet: ${notAvailable.map(e).join(", ")}.</p>` : ""}
      ${notRequested.length ? `<p>Not asked for by this app: ${notRequested.map(e).join(", ")}.</p>` : ""}
      ${technical}</details></form>`;
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Review CommonSwarm admin access</title>
    <style>${CONSENT_STYLES}
.admin-stack label{display:block;margin:.7rem 0}
.admin-stack fieldset{margin:1rem 0;padding:12px 0}
.admin-stack dt{font-weight:700}
.admin-stack dd{margin:0 0 .5rem}
.admin-stack button{min-height:52px;padding:0 30px;border:0;border-radius:999px;background:var(--primary-bg);color:var(--primary-fg);font:inherit;font-size:17px;font-weight:700;cursor:pointer}
.admin-stack button:hover{background:var(--primary-hover)}
.admin-cancel{margin-top:22px}
.admin-lead{color:var(--muted)}
.admin-lead strong{color:var(--ink);overflow-wrap:anywhere}
.admin-lead+.admin-lead{margin-top:6px}
.admin-stack fieldset{border:0;min-width:0}
.admin-stack legend{padding:0;font-family:var(--display);font-weight:700;font-size:19px}
.admin-stack form label{display:flex;gap:12px;align-items:flex-start;min-height:44px;margin:0;padding:10px 0;border-bottom:1px solid var(--hair)}
.admin-stack form label input[type=checkbox],.admin-stack form label input[type=radio]{flex:none;width:22px;height:22px;margin:1px 0 0;accent-color:var(--accent)}
.admin-stack form label small{display:block;color:var(--muted);font-size:14px}
.admin-stack form label.admin-until{display:block;border:0;font-weight:700}
.admin-until input{display:block;width:100%;max-width:320px;min-height:44px;margin-top:8px;padding:0 12px;border:1.5px solid var(--border);border-radius:10px;background:var(--card);color:var(--ink);font:inherit;font-weight:400}
.admin-stack form label span{min-width:0;overflow-wrap:anywhere}
.admin-state{margin-top:16px;color:var(--muted)}
.admin-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;margin-top:22px}
.admin-quiet{display:inline-flex;align-items:center;min-height:44px;padding:0 6px;color:var(--link);font-weight:700}
.admin-more{margin-top:22px;border-top:1px solid var(--hair);color:var(--muted);font-size:14px}
.admin-more summary{display:flex;align-items:center;min-height:44px;color:var(--ink);font-size:16px;font-weight:700;cursor:pointer}
.admin-more p{margin:0 0 10px;overflow-wrap:anywhere}
.admin-stack :is(input,button,summary,a):focus-visible{outline:3px solid var(--focus);outline-offset:3px}
</style></head>
    <body><main class="page"><header class="top"><span class="brand">${BRAND_MARK}<span>CommonSwarm</span></span><span class="top-note">Admin access</span></header>
    <div class="card admin-stack"><h1>${choosing ? `${e(policy?.metadata?.client_name ?? "Unnamed client")} wants admin access` : "Review admin access"}</h1>${identity}${choosing ? "" : `<p>${issuanceLine}</p>`}${form}${choosing ? "" : '<form method="get" action="https://commonswarm.com/app" class="admin-cancel"><button type="submit">Cancel and return to /app</button></form>'}</div></main>
    ${manifest && scriptNonce ? `<script nonce="${e(scriptNonce)}">const expiry=document.getElementById("local-expiry");expiry.textContent=new Date(expiry.dateTime).toLocaleString();document.getElementById("expiry-zone").textContent=" (your local time)";</script>` : ""}</body></html>`;
}
