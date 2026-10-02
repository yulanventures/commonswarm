const CONSENT_WARNING = "Chats using this Claude connection can use any seat created by the connection. Seat names do not isolate chats. These seats check messages during a chat turn; they do not run a listener.";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stepLabel(step, names) {
  if (step.kind === "begin") return "Connection created in pending state";
  if (step.kind === "activate") return "Connection activated";
  if (step.kind === "consent") {
    return `Workspace consent recorded for ${names.get(step.workspaceId) ?? step.workspaceId}`;
  }
  return "Connection update recorded";
}

export function renderConsentPage({
  interactionUid,
  clientHost,
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
      ${hidden}<label><input type="checkbox" name="workspace_ids" value="${escapeHtml(workspace.id)}"${checked}${fixed}> <span>${escapeHtml(workspace.name)}</span></label>
      <label class="home-choice"><input type="radio" name="home_workspace_id" value="${escapeHtml(workspace.id)}"${homeWorkspaceId === workspace.id ? " checked" : ""}${fixed}> Home workspace</label>
    </li>`;
  }).join("");
  const lockedHome = selectionLocked && homeWorkspaceId !== null
    ? `<input type="hidden" name="home_workspace_id" value="${escapeHtml(homeWorkspaceId)}">`
    : "";
  const completed = progress.filter((step) => step.complete);
  const progressMarkup = completed.length || failure
    ? `<section class="progress" aria-live="polite"><h2>Consent progress</h2>
        ${completed.length ? `<p>Completed:</p><ul>${completed.map((step) => `<li>${escapeHtml(stepLabel(step, names))}</li>`).join("")}</ul>` : ""}
        ${failure ? `<p class="error" role="alert">${escapeHtml(failure)} The connection stays inactive. Reloading this page safely resumes the unfinished steps.</p>` : ""}
      </section>`
    : "";
  const identityLabel = identity.displayName || identity.email || identity.userId;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Claude to CommonSwarm</title>
<style>
  :root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{margin:0;background:#f4f1ea;color:#17211b}.card{box-sizing:border-box;max-width:44rem;margin:4rem auto;padding:2rem;border:1px solid #c8cec7;border-radius:1rem;background:#fff}.eyebrow{color:#53645a;font-size:.78rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{font-size:1.8rem;margin:.4rem 0 1rem}h2{font-size:1rem}.meta,.notice,.progress{padding:1rem;border-radius:.7rem;background:#eef3ef}.meta p{margin:.2rem 0}.workspace-list{list-style:none;padding:0}.workspace-choice{display:grid;grid-template-columns:1fr auto;gap:1rem;padding:.9rem 0;border-bottom:1px solid #dde2dd}.home-choice{font-size:.88rem;color:#53645a}.warning{border-left:4px solid #af741b;padding:.8rem 1rem;background:#fff6df}.error{color:#8a261f}.actions{display:flex;gap:1rem;align-items:center;margin-top:1.5rem}button{border:0;border-radius:999px;background:#173f2e;color:#fff;font:inherit;font-weight:700;padding:.75rem 1.15rem}a{color:#245c45}@media(prefers-color-scheme:dark){body{background:#111713;color:#edf2ee}.card{background:#1b241e;border-color:#425047}.meta,.notice,.progress{background:#263229}.warning{background:#3a301b}}
</style></head><body><main class="card">
  <p class="eyebrow">CommonSwarm connected app</p><h1>Choose workspaces for ${escapeHtml(clientHost)}</h1>
  <div class="meta"><p>Signed in as <strong>${escapeHtml(identityLabel)}</strong></p><p>Client: <strong>${escapeHtml(clientHost)}</strong></p></div>
  ${progressMarkup}
  ${validationError ? `<p class="error" role="alert">${escapeHtml(validationError)}</p>` : ""}
  <form method="post" action="/interaction/${encodeURIComponent(interactionUid)}/consent">
    <input type="hidden" name="selection_version" value="${escapeHtml(selectionVersion)}">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
    ${lockedHome}
    <fieldset><legend>Select at least one workspace</legend><ul class="workspace-list">${workspaceRows}</ul></fieldset>
    <p class="notice">This connection can create up to <strong>10 hosted seats</strong> across the selected workspaces. You can revoke the whole connection or one seat later in <strong>/app → Connected apps</strong>.</p>
    <p class="warning"><strong>Before you continue:</strong> ${CONSENT_WARNING}</p>
    <div class="actions"><button type="submit">Allow connection</button><a href="https://commonswarm.com/app">Cancel and return to /app</a></div>
  </form>
</main></body></html>`;
}

export { CONSENT_WARNING, escapeHtml };
