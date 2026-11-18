import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

// This owns the renderer's browser behavior, not grant policy or the controller's auth/network flow.
// Credible negatives: optimistic toggling, an unresolved grant rendered Off, a guessed organization,
// duplicate confirmation, expiry extended after it was shown, or clipped actions on a short screen.
const script = `
import { buildSeatAdminPanel, buildSeatAdminConfirmation, buildSeatAdminEndConfirmation } from './src/lib/seat-admin-view';
import { parseSeatAdminGrants, renderSeatAdminHistoryList } from './src/lib/seat-admin';
const root = document.querySelector('live-dashboard');
const checks = [];
const check = (name, pass) => checks.push({name, pass: !!pass});
const calls = [];
const actions = {
  enable: level => calls.push(['enable', level]),
  remove: id => calls.push(['remove', id]),
  retry: () => calls.push(['retry']),
};
const scope = {id:'workspace-1', name:'Operations and Customer Research ' + 'LongWorkspaceName'.repeat(4)};
const agentName = 'Research <img src=x onerror=alert(1)>';
const off = {scope, access:{state:'off'}, mayGrant:true, mayRemove:false};
const on = {scope:{id:'organization-1',name:'Example Organization'}, access:{state:'on',grantId:'organization-grant'}, mayGrant:true, mayRemove:true};
let targets = 0;
const geometry = dialog => {
  const visible = node => node.getClientRects().length > 0;
  const controls = [...root.querySelectorAll('button,select,a')].filter(visible);
  targets += controls.length;
  check('all visible controls have real 44px boxes', controls.length > 0 && controls.every(node => {
    const rect = node.getBoundingClientRect(); return rect.width >= 43.99 && rect.height >= 43.99;
  }));
  const rect = dialog.getBoundingClientRect();
  check('dialog fits the actual browser viewport', rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + .5 && rect.bottom <= innerHeight + .5);
  // The actions are pinned outside the scrolling part, except where the explanation cannot fit above them: the
  // organization grant on the narrowest phones, and both grants on a short screen. There the confirmation is a single
  // scrolling form with the actions at its end. They must be reachable by scrolling the form to its end, which is
  // where it is left, so later focus checks do not move it.
  const form = dialog.querySelector('.sa-confirm__form');
  const oneScroll = getComputedStyle(form).overflowY === 'auto';
  // The notice about permissions not available yet must be read before Grant: fully on screen beside pinned actions as
  // the confirmation opens, or ahead of the actions in the one scrolling form. Measured before anything is scrolled.
  const later = dialog.querySelector('[data-seat-admin-later]');
  if (later) {
    const notice = later.getBoundingClientRect(), scroller = dialog.querySelector('.sa-confirm__body').getBoundingClientRect();
    const actionsTop = dialog.querySelector('footer').getBoundingClientRect().top;
    check('the future-permissions notice is read before Grant', oneScroll
      ? notice.height > 0 && notice.bottom <= actionsTop + .5
      : notice.height > 0 && notice.top >= scroller.top - .5 && notice.bottom <= scroller.bottom + .5 && notice.bottom <= actionsTop + .5);
  }
  if (oneScroll) form.scrollTop = form.scrollHeight;
  const footer = dialog.querySelector('footer').getBoundingClientRect();
  check('actions stay visible outside the scrolling permissions', footer.top >= rect.top && footer.bottom <= innerHeight + .5);
  check('one scrolling form only where the explanation cannot fit above pinned actions', oneScroll === (innerHeight < 640 || (innerWidth < 384 && dialog.getAttribute('data-seat-admin-confirm') === 'organization')));
  const body = dialog.querySelector('.sa-confirm__body');
  body.focus({preventScroll:true});
  check('permission scroller is in the keyboard focus order', body.tabIndex === 0 && document.activeElement === body);
  body.scrollTop = body.scrollHeight;
  check('permission content can scroll to the end-date field', body.scrollHeight <= body.clientHeight + 1 || body.scrollTop > 0);
  check('dialog content has no horizontal overflow', dialog.scrollWidth <= dialog.clientWidth + 1 && body.scrollWidth <= body.clientWidth + 1);
};
try {
  check('hidden availability builds nothing', buildSeatAdminPanel(document,{state:'hidden'},actions) === null && calls.length === 0);
  const failed = buildSeatAdminPanel(document,{state:'error',agentName},actions); root.append(failed);
  check('read failure makes no checked or unchecked switches', failed.querySelector('[role=switch]') === null);
  failed.querySelector('button').click(); failed.remove();
  check('read failure has a working retry', calls.length === 1 && calls[0][0] === 'retry');

  const unresolved = buildSeatAdminPanel(document,{state:'ready',agentName,workspace:{...off,access:{state:'unresolved'}}},actions); root.append(unresolved);
  check('unresolved active grant is not rendered Off', !unresolved.querySelector('[role=switch]') && unresolved.textContent.includes('Not checked'));
  unresolved.remove();
  const panel = buildSeatAdminPanel(document,{state:'ready',agentName,workspace:off,organization:on,historyHref:'/app?admin=history'},actions); root.append(panel);
  const workspace = panel.querySelector('[data-seat-admin-toggle=workspace]');
  const organization = panel.querySelector('[data-seat-admin-toggle=organization]');
  workspace.click(); organization.click();
  check('enable emits an intent without optimistic On', calls[1][0] === 'enable' && calls[1][1] === 'workspace' && workspace.getAttribute('aria-checked') === 'false');
  check('remove identifies only the selected grant', calls[2][0] === 'remove' && calls[2][1] === 'organization-grant' && organization.getAttribute('aria-checked') === 'true');
  const confirmationCalls = [], signIns = []; let cancelled = 0, refreshed = 0;
  const confirmation = buildSeatAdminConfirmation(document,{
    principalId:'agent-1', agentName, level:'workspace', scopes:[scope], scopeId:scope.id,
    confirm: draft => confirmationCalls.push(draft), signIn: draft => signIns.push(draft),
    refresh: () => refreshed++, cancel: () => cancelled++,
  });
  root.append(confirmation.dialog); confirmation.open(workspace);
  const dialog = confirmation.dialog;
  check('opening does not grant and initial focus is Cancel', confirmationCalls.length === 0 && document.activeElement.textContent === 'Cancel');
  const permissionSection = (dialog, heading) => [...dialog.querySelectorAll('.sa-confirm__permissions')].find(section => section.querySelector('h3').textContent === heading);
  const available = permissionSection(dialog, 'Available now');
  const deferred = permissionSection(dialog, 'Included, not available yet');
  check('confirmation separates live actions from deferred grant powers',
    available?.textContent.includes('Cancel member invitations you created') &&
    available?.textContent.includes('their agents and Lists & docs access') &&
    available?.textContent.includes('Create new agent seats you own in this workspace') &&
    !available?.textContent.includes('Invite people') && !available?.textContent.includes('Renew agent seats') &&
    deferred?.textContent.includes('Invite people as members') && deferred?.textContent.includes('Change member roles') &&
    deferred?.textContent.includes('Renew agent seats') && !deferred?.textContent.includes('Create'));
  check('agent permissions do not promise access to the owner history', !available?.textContent.includes('history'));
  check('exact permission exclusions are shown', dialog.textContent.includes('Billing, sign-in and passwords') && dialog.textContent.includes('Giving anyone admin access'));
  check('No end date is the default with the approved line', dialog.querySelector('[data-seat-admin-duration]').value === 'none' && dialog.textContent.includes('Admin access stays on until you remove it or retire this agent.'));
  check('names stay text, never HTML', dialog.querySelector('img') === null && dialog.textContent.includes(agentName));
  geometry(dialog);
  const grant = dialog.querySelector('[data-seat-admin-grant]');
  const before = grant.getBoundingClientRect(); grant.focus(); const after = grant.getBoundingClientRect();
  check('focus does not change action geometry', before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height);
  const now = Date.now, selectedAt = Date.UTC(2026,10,10,21);
  Date.now = () => selectedAt;
  const duration = dialog.querySelector('[data-seat-admin-duration]'); duration.value = '7'; duration.dispatchEvent(new Event('change'));
  Date.now = () => selectedAt + 3600000;
  grant.click(); grant.click(); Date.now = now;
  check('confirmation is single-submit with the exact displayed expiry', confirmationCalls.length === 1 && confirmationCalls[0].days === 7 && confirmationCalls[0].expiresAt === selectedAt + 7*86400000 && confirmationCalls[0].scopeId === scope.id);
  check('pending cannot create another confirmation', grant.disabled && workspace.getAttribute('aria-checked') === 'false');
  confirmation.setState({phase:'reauthenticate'});
  const signIn = [...dialog.querySelectorAll('button')].find(node => node.textContent === 'Sign in again'); signIn.click();
  check('fresh sign-in is an intent, never an automatic grant', signIns.length === 1 && confirmationCalls.length === 1 && grant.hidden);
  confirmation.setState({phase:'unknown'});
  const refresh = [...dialog.querySelectorAll('button')].find(node => node.textContent === 'Refresh admin access'); refresh.click(); refresh.click();
  check('unknown outcome offers reconciliation without a second grant', refreshed === 1 && confirmationCalls.length === 1 && grant.hidden);
  confirmation.setState({phase:'error',notice:'Access was refused. Refresh and try again.'});
  check('refusal is announced without changing accepted switch state', dialog.querySelector('[role=alert]').textContent.includes('refused') && workspace.getAttribute('aria-checked') === 'false');
  dialog.querySelector('footer button').click();
  check('Cancel closes and returns focus to the opener', !dialog.open && document.activeElement === workspace && cancelled === 1);
  confirmation.dispose();

  const orgCalls = [];
  const org = buildSeatAdminConfirmation(document,{
    principalId:'agent-1',agentName,level:'organization',scopes:[{id:'org-1',name:'First Organization'},{id:'org-2',name:'Second Organization'}],
    confirm:draft=>orgCalls.push(draft),signIn:()=>{},refresh:()=>{},
  });
  root.append(org.dialog); org.open(organization);
  check('organization confirmation retains workspace limits and deferred powers',
    permissionSection(org.dialog, 'Available now')?.textContent.includes("workspaces you own and this agent belongs to") &&
    permissionSection(org.dialog, 'Available now')?.textContent.includes("organization's display name") &&
    permissionSection(org.dialog, 'Included, not available yet')?.textContent.includes('Stop agent seats or revoke their credentials'));
  const choose = org.dialog.querySelector('[data-seat-admin-scope]');
  const orgGrant = org.dialog.querySelector('[data-seat-admin-grant]');
  check('organization is not selected by sort order', choose.value === '' && orgGrant.disabled);
  geometry(org.dialog);
  choose.value = 'org-2'; choose.dispatchEvent(new Event('change')); orgGrant.click();
  check('organization confirmation keeps its own scope and no end date', orgCalls.length === 1 && orgCalls[0].level === 'organization' && orgCalls[0].scopeId === 'org-2' && orgCalls[0].expiresAt === null);
  org.dispose();

  let ends = 0, kept = 0;
  const ending = () => buildSeatAdminEndConfirmation(document,{agentName,level:'organization',coverage:['Example Organization'],confirm:()=>ends++,cancel:()=>kept++});
  const keep = ending(); root.append(keep.dialog); keep.open(organization);
  check('ending asks in plain words, names stay text', keep.dialog.querySelector('h2').textContent === 'End organization admin access for ' + agentName + ' in Example Organization?'
    && keep.dialog.textContent.includes('It stays off until you turn it on again.') && keep.dialog.querySelector('img') === null);
  const workspaceEnding = buildSeatAdminEndConfirmation(document,{agentName:'Atlas',level:'workspace',coverage:['Studio'],confirm:()=>{}});
  check('workspace and organization endings read differently', workspaceEnding.dialog.querySelector('h2').textContent === 'End workspace admin access for Atlas in Studio?'
    && workspaceEnding.dialog.dataset.seatAdminEnd === 'workspace' && keep.dialog.dataset.seatAdminEnd === 'organization');
  workspaceEnding.dispose();
  check('opening ends nothing and initial focus is Keep', ends === 0 && document.activeElement.textContent === 'Keep');
  const endControls = [...keep.dialog.querySelectorAll('button')];
  targets += endControls.length;
  check('end actions have real 44px boxes', endControls.map(node => node.textContent).join() === 'Keep,End access' && endControls.every(node => {
    const rect = node.getBoundingClientRect(); return rect.width >= 43.99 && rect.height >= 43.99;
  }));
  const endRect = keep.dialog.getBoundingClientRect();
  check('end dialog fits the actual browser viewport', endRect.left >= 0 && endRect.top >= 0 && endRect.right <= innerWidth + .5 && endRect.bottom <= innerHeight + .5);
  endControls[0].click();
  check('Keep sends nothing, closes and returns focus to the switch', ends === 0 && kept === 1 && !keep.dialog.open && document.activeElement === organization
    && organization.getAttribute('aria-checked') === 'true');
  keep.dispose();
  const end = ending(); root.append(end.dialog); end.open(organization);
  const endButton = end.dialog.querySelector('[data-seat-admin-end-confirm]'); endButton.click(); endButton.click();
  check('End access ends once and closes', ends === 1 && kept === 1 && !end.dialog.open);
  end.dispose();

  // The account list: Remove admin access asks first, names the row's grant, and ends only that row once.
  const viewer = '11111111-1111-4111-8111-111111111111', otherOwner = '22222222-2222-4222-8222-222222222222';
  const agentId = '33333333-3333-4333-8333-333333333333', ws = '44444444-4444-4444-8444-444444444444', orgId = '55555555-5555-4555-8555-555555555555';
  const row = (id, patch) => ({ grant_id: id, principal_id: agentId, level: 'workspace', organization_id: null, scope_names: ['role:workspace_admin'],
    workspace_ids: [ws], registry_version: 3, expires_at: null, state: 'active', created_at: '2026-11-01T00:00:00.000Z', ended_at: null, end_reason: null, ...patch });
  const grants = parseSeatAdminGrants({ grants: [
    row('a0000000-0000-4000-8000-000000000001', {}),
    row('a0000000-0000-4000-8000-000000000002', { level: 'organization', organization_id: orgId, scope_names: ['role:organization_admin'], workspace_ids: [] }),
    row('a0000000-0000-4000-8000-000000000003', { level: 'scoped', scope_names: ['admin:read', 'invites:create'] }),
    row('a0000000-0000-4000-8000-000000000004', { state: 'downgraded', ended_at: '2026-11-17T21:04:00.000Z', end_reason: 'owner_downgrade', ended_by: viewer }),
    row('a0000000-0000-4000-8000-000000000005', { state: 'downgraded', ended_at: '2026-11-16T21:04:00.000Z', end_reason: 'owner_downgrade', ended_by: otherOwner }),
    row('a0000000-0000-4000-8000-000000000006', { state: 'expired', ended_at: '2026-11-15T08:00:00.000Z', expires_at: '2026-11-15T08:00:00.000Z', end_reason: 'expired' }),
    row('a0000000-0000-4000-8000-000000000007', { state: 'downgraded', ended_at: '2026-11-14T08:00:00.000Z', end_reason: 'owner_downgrade' }),
  ] });
  const removed = [];
  const list = document.createElement('div'); list.setAttribute('data-kylon-account', ''); root.append(list);
  renderSeatAdminHistoryList(list, grants, { viewerUserId: viewer, agentsByPrincipalId: new Map([[agentId, 'Atlas']]),
    workspacesById: new Map([[ws, 'Studio']]), organizationsById: new Map([[orgId, 'Acme']]), onRemove: (g) => removed.push(g.grantId) });
  const card = id => list.querySelector('[data-admin-seat-grant="' + id + '"]');
  const label = id => card(id).querySelector('[data-admin-seat-state-label]').textContent;
  check('history says who ended each grant, in words', label('a0000000-0000-4000-8000-000000000004') === 'Ended Nov 17, 2026 by you'
    && label('a0000000-0000-4000-8000-000000000005') === 'Ended Nov 16, 2026 by another owner'
    && label('a0000000-0000-4000-8000-000000000006') === 'Expired Nov 15, 2026'
    && label('a0000000-0000-4000-8000-000000000007') === 'Ended Nov 14, 2026'
    && !list.textContent.includes('owner_downgrade'));
  check('the machine reason and actor stay in the row data', card('a0000000-0000-4000-8000-000000000004').dataset.adminSeatEndReason === 'owner_downgrade'
    && card('a0000000-0000-4000-8000-000000000004').dataset.adminSeatEndedBy === 'you'
    && card('a0000000-0000-4000-8000-000000000005').dataset.adminSeatEndedBy === 'another_owner'
    && card('a0000000-0000-4000-8000-000000000007').dataset.adminSeatEndedBy === undefined);
  const removeButton = id => card(id).querySelector('[data-admin-seat-remove]');
  const openEnd = id => { removeButton(id).click(); return list.querySelector('dialog[data-seat-admin-end]'); };
  const wsDialog = openEnd('a0000000-0000-4000-8000-000000000001');
  check('Remove admin access asks first and sends nothing', wsDialog?.open && removed.length === 0
    && wsDialog.querySelector('h2').textContent === 'End workspace admin access for Atlas in Studio?' && document.activeElement.textContent === 'Keep');
  removeButton('a0000000-0000-4000-8000-000000000001').click();
  check('a second click opens no second confirmation', list.querySelectorAll('dialog[data-seat-admin-end]').length === 1);
  [...wsDialog.querySelectorAll('button')].find(node => node.textContent === 'Keep').click();
  check('Keep sends nothing and returns focus to the row button', removed.length === 0 && !wsDialog.isConnected
    && document.activeElement === removeButton('a0000000-0000-4000-8000-000000000001'));
  const orgDialog = openEnd('a0000000-0000-4000-8000-000000000002');
  check('the organization row names its organization', orgDialog.querySelector('h2').textContent === 'End organization admin access for Atlas in Acme?');
  orgDialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  check('Escape sends nothing and returns focus', removed.length === 0 && !orgDialog.isConnected
    && document.activeElement === removeButton('a0000000-0000-4000-8000-000000000002'));
  const scopedDialog = openEnd('a0000000-0000-4000-8000-000000000003');
  check('the scoped row names its scopes and workspace', scopedDialog.querySelector('h2').textContent === 'End scoped admin access for Atlas in Studio?'
    && scopedDialog.textContent.includes('Scopes: admin:read, invites:create'));
  const confirmEnd = scopedDialog.querySelector('[data-seat-admin-end-confirm]'); confirmEnd.click(); confirmEnd.click();
  check('End access ends exactly that row, once', removed.length === 1 && removed[0] === 'a0000000-0000-4000-8000-000000000003'
    && !scopedDialog.isConnected && document.activeElement === removeButton('a0000000-0000-4000-8000-000000000003'));
  list.remove();

  // A scoped grant over 10 unnamed workspaces with every scope: a short heading, details scroll, actions stay put.
  const wide = buildSeatAdminEndConfirmation(document, { agentName: 'Atlas', level: 'scoped',
    coverage: Array.from({ length: 10 }, (_, i) => 'Workspace ' + String(i).padStart(8, '0') + '-0000-4000-8000-000000000000'),
    scopeNames: ['admin:read', 'invites:create', 'invites:revoke', 'onboarding:connect', 'seats:create', 'seats:renew', 'seats:revoke', 'workspaces:rename'],
    confirm: () => ends++, cancel: () => kept++ });
  root.append(wide.dialog); wide.open(organization);
  const wideTitle = wide.dialog.querySelector('h2'), wideBody = wide.dialog.querySelector('.sa-confirm__body');
  check('many workspaces are counted in the heading', wideTitle.textContent === 'End scoped admin access for Atlas in 10 workspaces?'
    && wide.dialog.querySelector('[data-seat-admin-end-workspaces]').textContent.includes('Workspace 00000009-0000-4000-8000-000000000000'));
  const titleHeight = wideTitle.getBoundingClientRect().height;
  check('the heading stays short (' + Math.round(titleHeight) + ' px)', innerWidth >= 800 && innerHeight <= 420 ? titleHeight <= 64 : titleHeight <= 80);
  check('Keep still has the initial focus', document.activeElement.textContent === 'Keep');
  const lastScope = wide.dialog.querySelector('[data-seat-admin-end-scopes]');
  lastScope.scrollIntoView({ block: 'end' });
  const bodyRect = wideBody.getBoundingClientRect(), scopeRect = lastScope.getBoundingClientRect();
  check('the last scope is reachable inside the scrolling body', lastScope.textContent.endsWith('workspaces:rename')
    && scopeRect.bottom <= bodyRect.bottom + 1 && scopeRect.top >= bodyRect.top - 1 && wideBody.tabIndex === 0);
  const wideRect = wide.dialog.getBoundingClientRect();
  const wideButtons = [...wide.dialog.querySelectorAll('footer button')];
  check('both actions stay whole inside the dialog and the viewport', wideButtons.length === 2 && wideButtons.every(node => {
    const rect = node.getBoundingClientRect();
    return rect.width >= 43.99 && rect.height >= 43.99 && rect.top >= wideRect.top - .5 && rect.bottom <= wideRect.bottom + .5
      && rect.left >= wideRect.left - .5 && rect.right <= wideRect.right + .5 && rect.top >= 0 && rect.bottom <= innerHeight + .5;
  }) && wideRect.bottom <= innerHeight + .5 && wideRect.top >= 0);
  const endsBefore = ends;
  wideButtons[0].click();
  check('Keep on the long dialog sends nothing', ends === endsBefore && !wide.dialog.open);
  wide.dispose();
  check('no page overflow', document.documentElement.scrollWidth <= innerWidth);
} catch (error) { check('fixture completed: ' + error.message, false); }
document.documentElement.dataset.seatAdminResults = encodeURIComponent(JSON.stringify({checks,targets,width:innerWidth,height:innerHeight}));
`;

test("seat admin view keeps confirmation explicit, grants independent and actions reachable", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-seat-admin-view-"));
  try {
    const root = resolve(import.meta.dirname, "../../..");
    const bundle = await build({ stdin: { contents: script, resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "iife", platform: "browser",
      define: { "import.meta.env": JSON.stringify({}) } });
    const styles = await Promise.all(["kylon-tokens.css", "carbon-theme.css", "kylon-people-profile.css", "kylon-seat-admin.css"].map(name => readFile(join(root, "src/styles", name), "utf8")));
    const fixture = join(directory, "index.html");
    const chrome = await findChrome();
    for (const theme of ["light", "dark"]) {
      await writeFile(fixture, `<!doctype html><html lang="en" data-theme="${theme}"><meta charset="utf-8"><style>
        body { margin:0; } live-dashboard { display:block; padding:16px; } ${styles.join("\n")}
      </style><body><live-dashboard class="dashboard" data-kylon-shell></live-dashboard><script>${bundle.outputFiles[0]!.text}</script></body></html>`);
      for (const [width, height] of [[360,740],[390,844],[430,932],[844,390],[768,1024],[1024,1366]]) {
        const { stdout } = await launchChrome(chrome, [`--window-size=${width},${height}`, "--virtual-time-budget=1000", "--dump-dom", `file://${fixture}`], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
        const encoded = stdout.match(/data-seat-admin-results="([^"]+)"/u)?.[1];
        assert.ok(encoded, `${theme}/${width}×${height}: real renderer completed`);
        const result = JSON.parse(decodeURIComponent(encoded!));
        assert.ok(result.targets > 10, "positive control: visible controls measured");
        assert.deepEqual(result.checks.filter((item: { pass: boolean }) => !item.pass), [], `${theme}/${width}×${height}, actual ${result.width}×${result.height}`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
