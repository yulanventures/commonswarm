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
import { buildSeatAdminPanel, buildSeatAdminConfirmation } from './src/lib/seat-admin-view';
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
  const footer = dialog.querySelector('footer').getBoundingClientRect();
  check('actions stay visible outside the scrolling permissions', footer.top >= rect.top && footer.bottom <= innerHeight);
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
  const choose = org.dialog.querySelector('[data-seat-admin-scope]');
  const orgGrant = org.dialog.querySelector('[data-seat-admin-grant]');
  check('organization is not selected by sort order', choose.value === '' && orgGrant.disabled);
  geometry(org.dialog);
  choose.value = 'org-2'; choose.dispatchEvent(new Event('change')); orgGrant.click();
  check('organization confirmation keeps its own scope and no end date', orgCalls.length === 1 && orgCalls[0].level === 'organization' && orgCalls[0].scopeId === 'org-2' && orgCalls[0].expiresAt === null);
  org.dispose();
  check('no page overflow', document.documentElement.scrollWidth <= innerWidth);
} catch (error) { check('fixture completed: ' + error.message, false); }
document.documentElement.dataset.seatAdminResults = encodeURIComponent(JSON.stringify({checks,targets,width:innerWidth,height:innerHeight}));
`;

test("seat admin view keeps confirmation explicit, grants independent and actions reachable", { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-seat-admin-view-"));
  try {
    const root = resolve(import.meta.dirname, "../../..");
    const bundle = await build({ stdin: { contents: script, resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "iife", platform: "browser" });
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
