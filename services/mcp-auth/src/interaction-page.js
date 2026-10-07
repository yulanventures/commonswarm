const CONSENT_WARNING = "Chats using this Claude connection can use any seat created by the connection. Seat names do not isolate chats. These seats check messages during a chat turn; they do not run a listener.";

// Sign-in providers the page may name. Any other value (null, unknown, inherited
// object keys) renders the account without a provider, never the raw value.
const PROVIDER_LABELS = new Map([["google", "Google"], ["github", "GitHub"], ["email", "email"]]);

// Above this many rows the workspace list becomes a bounded scroll area.
const LONG_WORKSPACE_LIST = 8;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function initial(value) {
  const first = Array.from(String(value ?? "").trim())[0] ?? "?";
  return escapeHtml(first.toUpperCase());
}

// Inline icons only: the page CSP allows no images, fonts or scripts.
const ICON_ATTRS = 'width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const ICONS = {
  workspaces: `<svg ${ICON_ATTRS}><rect x="2.75" y="2.75" width="6" height="6" rx="1.8"/><rect x="11.25" y="2.75" width="6" height="6" rx="1.8"/><rect x="2.75" y="11.25" width="6" height="6" rx="1.8"/><rect x="11.25" y="11.25" width="6" height="6" rx="1.8"/></svg>`,
  seats: `<svg ${ICON_ATTRS}><rect x="3" y="3" width="14" height="14" rx="4.5"/><path d="M7 10.5h6M10 7.5v6"/></svg>`,
  revoke: `<svg ${ICON_ATTRS}><path d="M4 10a6 6 0 1 0 1.8-4.3"/><path d="M4 3.5v3.2h3.2"/></svg>`,
  chat: `<svg ${ICON_ATTRS}><path d="M3.5 5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3h0a2 2 0 0 1-2-2z"/></svg>`,
  alert: `<svg ${ICON_ATTRS}><path d="M10 3 2.5 16.5h15z"/><path d="M10 8.2v3.6M10 14.2v.1"/></svg>`,
};
const PROVIDER_GLYPHS = {
  github: '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.82a9.6 9.6 0 0 1 2.5.34c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.77c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/></svg>',
  google: '<svg width="11" height="11" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29A11.99 11.99 0 0 0 0 12c0 1.94.47 3.76 1.29 5.38z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42A11.96 11.96 0 0 0 12 0 11.99 11.99 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"/></svg>',
  email: '<svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="2.5" y="4.5" width="15" height="11" rx="2"/><path d="m3 5.5 7 5.5 7-5.5"/></svg>',
};
const BRAND_MARK = '<svg class="brand-mark" width="24" height="24" viewBox="0 0 28 28" fill="none" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="8" fill="#D4F04A"/><rect x="12" y="12" width="14" height="14" rx="4.5" stroke="currentColor" stroke-width="2"/></svg>';

export function renderConsentDestination({ clientName, redirectUri, metadataHost }) {
  const hostname = new URL(redirectUri).hostname;
  const destination = ["localhost", "127.0.0.1", "[::1]"].includes(hostname)
    ? "a program on this computer (localhost)"
    : hostname;
  // Shared with admin-interaction-page.js: line breaks stay in the markup so the
  // facts keep one line each without this page's stylesheet.
  return `<p class="notice destination"><span class="destination-line">Client name (supplied by the client): <strong>${escapeHtml(clientName ?? "Unnamed client")}</strong></span><br>
    <span class="destination-line destination-return">After you approve, you return to <strong>${escapeHtml(destination)}</strong>.</span>
    ${metadataHost ? `<br><span class="destination-line">Client ID URL host: <strong>${escapeHtml(metadataHost)}</strong>.</span>` : ""}</p>`;
}

function stepLabel(step, names) {
  if (step.kind === "begin") return "Connection created in pending state";
  if (step.kind === "activate") return "Connection activated";
  if (step.kind === "consent") {
    return `Workspace consent recorded for ${names.get(step.workspaceId) ?? step.workspaceId}`;
  }
  return "Connection update recorded";
}

function renderClientIdentity(clientDisplay) {
  const primary = escapeHtml(clientDisplay.primary);
  const heading = `Choose workspaces for ${primary}`;
  if (clientDisplay.verified) {
    return {
      verified: true,
      badge: `<span class="badge badge-neutral">HTTPS client ID</span>`,
      heading,
      facts: `<p class="app-fact">Client: <strong>${primary}</strong></p>`,
      warning: "",
    };
  }
  const declared = clientDisplay.declaredName
    ? `<p class="app-fact">It calls itself &ldquo;${escapeHtml(clientDisplay.declaredName)}&rdquo;.</p>`
    : "";
  return {
    verified: false,
    badge: `<span class="badge badge-unverified">${ICONS.alert}Unverified app</span>`,
    heading,
    facts: `<p class="app-fact">Authorization will return to <strong>${primary}</strong>.</p>${declared}`,
    warning: `<p class="warning unverified-warning">${ICONS.alert}<span><strong>Not verified:</strong> CommonSwarm has not checked who runs this app. Only continue if you trust <strong>${primary}</strong> to receive your authorization code and access your workspaces.</span></p>`,
  };
}

function renderAccount(identity, csrfToken, switchAccount) {
  const label = identity.displayName || identity.email || identity.userId;
  const provider = typeof identity.provider === "string" && PROVIDER_LABELS.has(identity.provider)
    ? identity.provider
    : null;
  const signedIn = provider
    ? `Signed in with ${PROVIDER_LABELS.get(provider)} as <strong>${escapeHtml(label)}</strong>`
    : `Signed in as <strong>${escapeHtml(label)}</strong>`;
  const email = identity.displayName && identity.email && identity.email !== identity.displayName
    ? `<span class="account-email">${escapeHtml(identity.email)}</span>`
    : "";
  const badge = provider
    ? `<span class="provider-badge provider-${provider}">${PROVIDER_GLYPHS[provider]}</span>`
    : "";
  const switchForm = switchAccount
    ? `<form method="post" action="${escapeHtml(switchAccount.action)}" class="switch-form">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <button type="submit" class="switch-button">Use a different account</button>
      </form>`
    : "";
  return `<div class="account">
      <span class="avatar" aria-hidden="true">${initial(label)}${badge}</span>
      <p class="account-text"><span>${signedIn}</span>${email}</p>
      ${switchForm}
    </div>`;
}

export function renderConsentPage({
  interactionUid,
  clientDisplay,
  redirectUri,
  identity,
  workspaces,
  selectedWorkspaceIds = [],
  homeWorkspaceId = null,
  selectionLocked = false,
  selectionVersion,
  csrfToken,
  progress = [],
  failure = null,
  validationError = null,
  switchAccount = null,
}) {
  const selected = new Set(selectedWorkspaceIds);
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
  const choices = selectionLocked
    ? selectedWorkspaceIds.map((id) => ({ id, name: names.get(id) ?? id, fixed: true }))
    : workspaces.map((workspace) => ({ ...workspace, fixed: false }));
  const workspaceRows = choices.map((workspace) => {
    const checked = selected.has(workspace.id) ? " checked" : "";
    const fixed = workspace.fixed ? " disabled" : "";
    const hidden = workspace.fixed
      ? `<input type="hidden" name="workspace_ids" value="${escapeHtml(workspace.id)}">`
      : "";
    return `<li class="workspace-choice">
      ${hidden}<label class="workspace-pick"><input type="checkbox" name="workspace_ids" value="${escapeHtml(workspace.id)}"${checked}${fixed}> <span>${escapeHtml(workspace.name)}</span></label>
      <label class="home-choice"><input type="radio" name="home_workspace_id" value="${escapeHtml(workspace.id)}"${homeWorkspaceId === workspace.id ? " checked" : ""}${fixed}> Home workspace</label>
    </li>`;
  }).join("");
  const lockedHome = selectionLocked && homeWorkspaceId !== null
    ? `<input type="hidden" name="home_workspace_id" value="${escapeHtml(homeWorkspaceId)}">`
    : "";
  const longList = choices.length > LONG_WORKSPACE_LIST;
  const countText = `${choices.length} workspace${choices.length === 1 ? "" : "s"}${longList ? " · scroll for more" : ""}`;
  const pickerHelp = selectionLocked
    ? "These choices are locked because this connection has already started."
    : "Check each workspace this app may reach. If you select more than one workspace, choose one of them as Home workspace.";
  const emptyRow = choices.length === 0
    ? `<li class="workspace-empty">You have no workspaces to choose from. Create one in CommonSwarm first.</li>`
    : "";
  const completed = progress.filter((step) => step.complete);
  const progressMarkup = completed.length || failure
    ? `<section class="progress" aria-live="polite"><h2>Consent progress</h2>
        ${completed.length ? `<p>Completed:</p><ul>${completed.map((step) => `<li>${escapeHtml(stepLabel(step, names))}</li>`).join("")}</ul>` : ""}
        ${failure ? `<p class="error" role="alert">${escapeHtml(failure)} The connection stays inactive. Reloading this page safely resumes the unfinished steps.</p>` : ""}
      </section>`
    : "";
  const client = renderClientIdentity(clientDisplay);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Connect Claude to CommonSwarm</title>
<style>
:root{
  color-scheme:light dark;
  --canvas:#EEF2EA;--card:#FCFDFA;--soft:#F1F5EC;--soft-strong:#E7EDE1;--hair:#E3E9DD;--border:#D3DBCC;--lip:#C9D2C1;
  --ink:#17231C;--muted:#4F5E54;--lime:#D4F04A;--lime-ink:#17231C;
  --primary-bg:#17231C;--primary-fg:#FCFDFA;--primary-hover:#2F4438;--link:#17231C;--focus:#17231C;
  --tile-bg:#DDE7FA;--tile-line:#2A5DBF;--tile-ink:#1B3F87;--avatar:#2A5DBF;
  --warn-bg:#FCEBCB;--warn-line:#F0B25A;--warn-ink:#5E3300;--warn-icon:#8A4B00;
  --danger:#8C2A14;--danger-bg:#FBE4D5;--danger-line:#E9B79B;
  --pill-dot:#D4F04A;
  --display:"Bricolage Grotesque",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;
  --body:"Instrument Sans",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  --canvas:#0F1712;--card:#17231C;--soft:#1E2D24;--soft-strong:#22332A;--hair:#2C3F34;--border:#2A3D32;--lip:#0A100C;
  --ink:#EEF2EA;--muted:#B4C2B8;--lime:#D4F04A;--lime-ink:#17231C;
  --primary-bg:#D4F04A;--primary-fg:#17231C;--primary-hover:#E4F78A;--link:#D4F04A;--focus:#D4F04A;
  --tile-bg:#1E3156;--tile-line:#7FA3EC;--tile-ink:#DDE7FA;--avatar:#3B6FD4;
  --warn-bg:#3A2B10;--warn-line:#8A5A12;--warn-ink:#FCEBCB;--warn-icon:#F0B25A;
  --danger:#FFB4A0;--danger-bg:#3A1D14;--danger-line:#7A3420;
  --pill-dot:#17231C;
}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100vh;background:var(--canvas);color:var(--ink);font-family:var(--body);font-size:16px;line-height:1.45;-webkit-font-smoothing:antialiased}
.page{max-width:620px;margin:0 auto;padding:28px 16px 48px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 4px 18px}
.brand{display:inline-flex;align-items:center;gap:8px;font-family:var(--display);font-weight:700;font-size:18px;letter-spacing:-.01em;color:var(--ink)}
.top-note{font-size:13px;font-weight:600;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--border);border-radius:18px;box-shadow:0 2px 0 var(--lip);padding:28px 28px 24px}
.card>*+*{margin-top:22px}
h1,h2{font-family:var(--display);font-weight:700;color:var(--ink);margin:0}
h1{font-size:clamp(28px,5.4vw,34px);line-height:1.08;letter-spacing:-.025em;overflow-wrap:anywhere;text-wrap:balance}
h2{font-size:19px;line-height:1.2;letter-spacing:-.01em}
p{margin:0}
strong{font-weight:700}
svg{flex:none}
.connect-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pair{display:inline-flex;align-items:center;gap:6px;padding:4px;border-radius:999px;background:var(--soft);border:1px solid var(--hair)}
.app-mark,.cs-mark{width:40px;height:40px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;flex:none}
.app-mark{background:var(--tile-bg);border:1.5px solid var(--tile-line);color:var(--tile-ink);font-family:var(--display);font-weight:700;font-size:18px}
.unverified .app-mark{background:var(--warn-bg);border:1.5px dashed var(--warn-icon);color:var(--warn-ink)}
.cs-mark{background:#17231C;color:#EEF2EA}
.pair-link{display:inline-flex;gap:3px}
.pair-link i{width:4px;height:4px;border-radius:50%;background:var(--muted);opacity:.7}
.badge{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:3px 11px 3px 8px;border-radius:999px;font-size:13px;font-weight:700}
.badge svg{width:15px;height:15px}
.badge-neutral{padding:3px 11px;background:var(--card);color:var(--muted);border:1px solid var(--border)}
.badge-unverified{background:var(--warn-bg);color:var(--warn-ink);border:1px solid var(--warn-line)}
.intro{display:flex;flex-direction:column;gap:10px}
.intro .connect-row{margin-bottom:6px}
.lede{font-size:17px;color:var(--muted);text-wrap:pretty}
.app-facts{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:14px;color:var(--muted)}
.app-facts strong{color:var(--ink);overflow-wrap:anywhere}
.warning{display:flex;gap:10px;align-items:flex-start;padding:14px 16px;border-radius:14px;font-size:15px;text-wrap:pretty}
.unverified-warning{background:var(--warn-bg);color:var(--warn-ink);border:1px solid var(--warn-line)}
.unverified-warning svg{color:var(--warn-icon);margin-top:2px}
.unverified-warning strong{overflow-wrap:anywhere}
.account{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 10px 10px 10px;border-radius:16px;background:var(--soft);border:1px solid var(--hair)}
.avatar{position:relative;width:40px;height:40px;border-radius:50%;background:var(--avatar);color:#fff;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex:none}
.provider-badge{position:absolute;right:-3px;bottom:-3px;width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:#FFFFFF;color:#17231C;box-shadow:0 0 0 2px var(--soft)}
.provider-github{background:#17231C;color:#FFFFFF}
.account-text{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;font-size:15px;line-height:1.35}
.account-text strong{overflow-wrap:anywhere}
.account-email{font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.switch-form{margin:0;flex:none}
.switch-button{min-height:40px;padding:0 16px;border:1.5px solid var(--ink);border-radius:999px;background:transparent;color:var(--ink);font:inherit;font-size:14px;font-weight:700;cursor:pointer}
.switch-button:hover{background:var(--soft-strong)}
.scope ul{list-style:none;margin:12px 0 0;padding:0;border-top:1px solid var(--hair)}
.scope li{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--hair);font-size:15px;text-wrap:pretty}
.scope-icon{width:32px;height:32px;border-radius:10px;background:var(--soft);display:inline-flex;align-items:center;justify-content:center;flex:none;color:var(--ink);margin-top:-5px}
.notices>*+*{margin-top:22px}
.error{color:var(--danger);font-weight:600}
.card>.error,.progress .error{padding:12px 14px;border-radius:12px;background:var(--danger-bg);border:1px solid var(--danger-line)}
.progress{padding:16px 18px;border-radius:14px;background:var(--soft);border:1px solid var(--hair)}
.progress h2{font-size:17px}
.progress>p{margin-top:8px;font-size:14px;color:var(--muted);font-weight:600}
.progress ul{list-style:none;margin:6px 0 0;padding:0}
.progress li{position:relative;padding:4px 0 4px 26px;font-size:15px}
.progress li::before{content:"";position:absolute;left:2px;top:9px;width:14px;height:14px;border-radius:50%;background:var(--lime);box-shadow:inset 0 0 0 1.5px #17231C}
.progress .error{margin-top:10px;font-weight:600;color:var(--danger);font-size:15px}
form{margin:0}
form[action$="/consent"]>*+*{margin-top:22px}
fieldset{border:0;margin:0;padding:0;min-width:0;counter-reset:chosen}
legend{padding:0;font-family:var(--display);font-weight:700;font-size:19px;letter-spacing:-.01em;line-height:1.2;float:left;width:100%}
legend+*{clear:both}
.picker-help{padding-top:6px;font-size:14px;color:var(--muted);text-wrap:pretty}
.workspace-list{list-style:none;margin:12px 0 0;padding:0;border:1px solid var(--border);border-radius:14px;background:var(--card);overflow:hidden}
.workspace-list.is-long{max-height:min(27rem,62vh);overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;scroll-padding-block:64px 80px}
.workspace-choice{display:flex;align-items:center;gap:8px 12px;padding:6px 10px 6px 4px;border-top:1px solid var(--hair)}
.workspace-choice:first-child{border-top:0}
.workspace-choice:has(input[type=checkbox]:checked){background:var(--soft)}
.workspace-pick{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:12px;min-height:48px;padding:4px 8px;border-radius:10px;cursor:pointer;font-weight:600;overflow-wrap:anywhere}
.workspace-pick span{min-width:0}
.workspace-pick input,.home-choice input{flex:none;margin:0;accent-color:var(--ink);cursor:pointer}
.workspace-pick input{width:20px;height:20px}
.home-choice input{width:16px;height:16px}
.home-choice{flex:none;display:inline-flex;align-items:center;gap:7px;min-height:44px;padding:0 13px 0 11px;border:1px solid var(--border);border-radius:999px;background:var(--card);font-size:13px;font-weight:600;color:var(--muted);cursor:pointer;white-space:nowrap}
.home-choice:has(input:checked){background:var(--primary-bg);border-color:var(--primary-bg);color:var(--primary-fg)}
.home-choice:has(input:checked) input{accent-color:var(--pill-dot)}
.workspace-pick input:checked{accent-color:var(--ink)}
.workspace-list input[type=checkbox]:checked{counter-increment:chosen}
input:disabled,input:disabled+span{cursor:default}
.workspace-pick:has(input:disabled),.home-choice:has(input:disabled){cursor:default}
.workspace-empty{padding:16px;color:var(--muted);font-size:15px}
.picker-foot{display:flex;justify-content:space-between;gap:12px;margin-top:8px;padding:0 4px;font-size:13px;color:var(--muted)}
.picker-selected::before{content:counter(chosen) " selected";font-weight:700;color:var(--ink)}
form[action$="/consent"]>.warning{background:var(--soft);border:1px solid var(--hair)}
form[action$="/consent"]>.warning svg{margin-top:2px}
.destination{display:flex;flex-direction:column;gap:4px;padding:14px 16px 14px 16px;border-radius:14px;border:1px dashed var(--border);font-size:14px;color:var(--muted)}
.destination strong{color:var(--ink);overflow-wrap:anywhere}
.destination br{display:none}
.destination-line{padding-left:26px}
.destination-return{order:-1;position:relative;margin-bottom:2px;font-size:15px;font-weight:600;color:var(--ink)}
.destination-return::before{content:"→";content:"→"/"";position:absolute;left:2px;top:-1px;font-weight:700}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px 20px;padding-top:18px;border-top:1px solid var(--hair)}
.actions button{min-height:52px;padding:0 30px;border:0;border-radius:999px;background:var(--primary-bg);color:var(--primary-fg);font:inherit;font-size:17px;font-weight:700;cursor:pointer}
.actions button:hover{background:var(--primary-hover)}
.actions a{display:inline-flex;align-items:center;min-height:44px;color:var(--link);font-weight:600;font-size:15px;text-underline-offset:3px}
:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:6px}
.actions button:focus-visible,.switch-button:focus-visible{outline-offset:3px;border-radius:999px}
.workspace-pick:has(input:focus-visible),.home-choice:has(input:focus-visible){outline:3px solid var(--focus);outline-offset:1px}
.workspace-pick input:focus-visible,.home-choice input:focus-visible{outline:0}
@media (prefers-reduced-motion:no-preference){.switch-button,.actions button,.home-choice,.workspace-choice{transition:background-color .15s ease,color .15s ease,border-color .15s ease}}
@media (max-width:560px){
  body{background:var(--card)}
  .page{padding:18px 16px 32px}
  .card{border:0;border-radius:0;box-shadow:none;padding:0;background:transparent}
  .top{padding-bottom:20px}
  .workspace-choice{flex-wrap:wrap;padding:2px 8px 10px 2px;gap:0}
  .workspace-pick{flex:1 1 100%;gap:12px;min-height:46px;padding:4px 8px;font-size:15px}
  .home-choice{margin-left:40px;min-height:44px;padding:0 14px 0 11px;font-size:13px;gap:7px}
  .switch-form{margin-left:52px}
  .actions{flex-direction:column;align-items:stretch;text-align:center}
  .actions button{width:100%}
  .actions a{justify-content:center}
}
@media (forced-colors:active){.home-choice,.badge,.account,.workspace-list,.warning,.destination{border:1px solid CanvasText}}
</style></head><body><main class="page">
  <header class="top"><span class="brand">${BRAND_MARK}<span>CommonSwarm</span></span><span class="top-note">Connect an app</span></header>
  <div class="card${client.verified ? "" : " unverified"}">
  <section class="intro" aria-labelledby="consent-title">
    <div class="connect-row">
      <span class="pair" aria-hidden="true"><span class="app-mark">${initial(clientDisplay.primary)}</span><span class="pair-link"><i></i><i></i><i></i></span><span class="cs-mark">${BRAND_MARK}</span></span>
      ${client.badge}
    </div>
    <h1 id="consent-title">${client.heading}</h1>
    <p class="lede">This app is asking to connect to your CommonSwarm account. Choose where it can work, then allow the connection.</p>
    <div class="app-facts">${client.facts}</div>
    ${client.warning}
  </section>
  ${renderAccount(identity, csrfToken, switchAccount)}
  <section class="scope" aria-labelledby="scope-title">
    <h2 id="scope-title">What this connection can do</h2>
    <ul>
      <li><span class="scope-icon">${ICONS.workspaces}</span><span>Reach only the workspaces you select below.</span></li>
      <li><span class="scope-icon">${ICONS.seats}</span><span>This connection can create up to <strong>10 hosted seats</strong> across the selected workspaces.</span></li>
      <li><span class="scope-icon">${ICONS.revoke}</span><span>You can revoke the whole connection or one seat later in <strong>/app → Connected apps</strong>.</span></li>
    </ul>
  </section>
  ${progressMarkup}
  ${validationError ? `<p class="error" role="alert">${escapeHtml(validationError)}</p>` : ""}
  <form method="post" action="/interaction/${encodeURIComponent(interactionUid)}/consent">
    <input type="hidden" name="selection_version" value="${escapeHtml(selectionVersion)}">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
    ${lockedHome}
    <fieldset><legend>Select at least one workspace</legend>
      <p class="picker-help">${pickerHelp}</p>
      <ul class="workspace-list${longList ? " is-long" : ""}">${workspaceRows}${emptyRow}</ul>
      <p class="picker-foot"><span>${countText}</span><span class="picker-selected" aria-hidden="true"></span></p>
    </fieldset>
    <p class="warning">${ICONS.chat}<span><strong>Before you continue:</strong> ${CONSENT_WARNING}</span></p>
    ${renderConsentDestination({ clientName: clientDisplay.declaredName, redirectUri, metadataHost: clientDisplay.metadataHost })}
    <div class="actions"><button type="submit">Allow connection</button><a href="https://commonswarm.com/app">Cancel and return to /app</a></div>
  </form>
  </div>
</main></body></html>`;
}

export { CONSENT_WARNING, PROVIDER_LABELS, escapeHtml };
