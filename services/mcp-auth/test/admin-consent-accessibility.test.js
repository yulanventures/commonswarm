import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { renderAdminConsentPage, renderAdminRefusedPage, FULL_ACCOUNT_WARNING, CHOSEN_COMPROMISE_WARNING, WORKER_READ_WARNING } from '../src/admin-interaction-page.js';
import { createAdminManifest } from '../src/admin-consent.js';
import { adminConsentOptions } from '../src/admin-policy.generated.js';

// Parse actual hosted HTML with the standard-library HTML parser, without a
// browser, service, or synthetic DOM that supplies its own accessibility state.
function htmlTree(html) {
  const parsed = spawnSync('python3', ['-c', `
import json,sys
from html.parser import HTMLParser
class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root={'tag':'document','attrs':{},'children':[]}; self.stack=[self.root]
    def handle_starttag(self,tag,attrs):
        node={'tag':tag,'attrs':dict(attrs),'children':[]}
        self.stack[-1]['children'].append(node)
        if tag not in ('input','meta','br','hr','img','link'): self.stack.append(node)
    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,0,-1):
            if self.stack[i]['tag']==tag:
                del self.stack[i:]; break
    def handle_data(self,data): self.stack[-1]['children'].append(data)
p=Tree(); p.feed(sys.stdin.read()); print(json.dumps(p.root))
`], { input: html, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  return JSON.parse(parsed.stdout);
}
const elements = (node) => [node, ...node.children.flatMap(child => typeof child === 'string' ? [] : elements(child))];
const text = (node) => node.children.map(child => typeof child === 'string' ? child : text(child)).join('').replace(/\s+/g, ' ').trim();
function one(tree, predicate) {
  const matches = elements(tree).filter(predicate);
  assert.equal(matches.length, 1, 'expected exactly one rendered element');
  return matches[0];
}

test('admin consent selection escapes client names and uses the request destination including loopback', () => {
  for (const [redirectUri, destination] of [
    ['https://callback.example:8443/private?code=hidden', 'callback.example'],
    ['http://localhost:4321/callback', 'a program on this computer (localhost)'],
    ['http://127.0.0.1:5432/callback', 'a program on this computer (localhost)'],
    ['http://[::1]:6543/callback', 'a program on this computer (localhost)'],
  ]) {
    const html = renderAdminConsentPage({ uid: 'selection', user: { userId: 'owner' },
      params: { client_id: 'https://metadata.example/oauth.json', redirect_uri: redirectUri },
      policy: { verification: {}, approval: {}, metadata: { client_name: '<script>bad()</script> & "friends\'s"',
        redirect_uris: ['https://unused.example/return', redirectUri] } }, csrfToken: 'csrf', version: 0 });
    assert.doesNotMatch(html, /<script>|code=hidden|unused\.example/u);
    assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt; &amp; &quot;friends&#39;s&quot;'));
    const tree = htmlTree(html);
    const review = one(tree, node => node.tag === 'button' && text(node) === 'Review exact permissions and limits');
    const form = one(tree, node => node.tag === 'form' && elements(node).includes(review));
    assert.ok(text(form).includes(`After you approve, you return to ${destination}`));
    assert.ok(text(form).includes('Client ID URL host: metadata.example'));
  }
});

// The choice screen (verified client, nothing chosen yet): one decision, what can be chosen in view, the rest under More.
function choiceScreen(overrides = {}) {
  return renderAdminConsentPage({ uid: 'choice', version: 0, csrfToken: 'csrf', issuanceState: 'open',
    user: { userId: 'owner-id', displayName: 'Alex Rivera' },
    params: { client_id: 'https://agents.example/oauth/client.json', redirect_uri: 'https://return.example/callback' },
    policy: { verification: { publisher_identity: 'Example Agents Ltd', verification_version: 3 }, approval: { owner_user_id: 'owner-id' },
      metadata: { client_name: 'Example Console' }, fullAccountEligible: true,
      resourceScopes: ['admin:read', 'invites:create', 'members:manage', 'seats:create'] },
    workspaces: [{ id: 'w1', name: 'Home' }, { id: 'w2', name: 'Studio' }], ...overrides });
}

test('admin choice screen leads with the app and the account, and keeps identifiers under More', () => {
  const tree = htmlTree(choiceScreen());
  assert.equal(text(one(tree, node => node.tag === 'h1')), 'Example Console wants admin access');
  const more = one(tree, node => node.tag === 'details');
  assert.equal(text(one(more, node => node.tag === 'summary')), 'More');
  assert.ok(more.attrs.open === undefined, 'More starts closed');
  const outside = text(tree).replace(text(more), '');
  assert.ok(outside.includes('Signed in as Alex Rivera'));
  assert.ok(outside.includes('Verified publisher Example Agents Ltd, from agents.example'));
  assert.ok(outside.includes('After you approve, you return to return.example'), 'where the approval goes stays in view');
  // Identifiers and the long verification line are one tap away, not in the way.
  for (const detail of ['(owner-id)', 'Client ID: https://agents.example/oauth/client.json', 'Authorization returns to: return.example', 'active verification 3']) {
    assert.ok(text(more).includes(detail), detail);
    assert.ok(!outside.includes(detail), `${detail} is not above the choices`);
  }
});

test('admin choice screen offers only what can be chosen, with the same names, values and defaults', () => {
  const html = choiceScreen();
  const tree = htmlTree(html);
  const inputs = elements(tree).filter(node => node.tag === 'input' && node.attrs.type !== 'hidden');
  // Nothing on the page is a control that cannot be used.
  assert.deepEqual(inputs.filter(node => 'disabled' in node.attrs), []);
  const scopes = inputs.filter(node => node.attrs.name === 'scope_names');
  // Requested and available: admin:read, invites:create, seats:create. members:manage is not available yet.
  assert.deepEqual(scopes.map(node => node.attrs.value), ['admin:read', 'invites:create', 'seats:create']);
  assert.deepEqual(scopes.filter(node => 'checked' in node.attrs).map(node => node.attrs.value), ['admin:read'], 'only Read-only starts ticked');
  const modes = inputs.filter(node => node.attrs.name === 'mode');
  assert.deepEqual(modes.map(node => [node.attrs.value, 'checked' in node.attrs]), [['granular', true], ['full_account', false]]);
  assert.deepEqual(inputs.filter(node => node.attrs.name === 'workspace_ids').map(node => [node.attrs.value, 'checked' in node.attrs]), [['w1', false], ['w2', false]]);
  const until = one(tree, node => node.tag === 'input' && node.attrs.name === 'expires_at');
  assert.equal(until.attrs.type, 'datetime-local');
  assert.ok('required' in until.attrs);
  // Every control has a label that wraps it, and the groups are named.
  for (const input of inputs) assert.ok(elements(tree).some(node => node.tag === 'label' && elements(node).includes(input)), input.attrs.name);
  assert.deepEqual(elements(tree).filter(node => node.tag === 'legend').map(text), ['How much access', 'What it may do', 'In which workspaces']);
  const more = one(tree, node => node.tag === 'details');
  assert.ok(text(more).includes('Not available yet: Manage members, Manage seats, Archive workspaces, Billing changes.'));
  assert.ok(text(more).includes('Not asked for by this app:'));
});

test('admin choice screen says what Full account reaches, keeps one submit, and Cancel is a link out', () => {
  const tree = htmlTree(choiceScreen());
  const full = one(tree, node => node.tag === 'label' && elements(node).some(child => child.attrs?.value === 'full_account'));
  assert.equal(text(full), 'Full accountEvery permission this app asked for, in every workspace you own now and later. It asks you again first.');
  assert.equal(elements(tree).filter(node => node.tag === 'button').map(text).join('|'), 'Review exact permissions and limits');
  const cancel = one(tree, node => node.tag === 'a' && text(node) === 'Cancel');
  assert.equal(cancel.attrs.href, 'https://commonswarm.com/app');
  // A client that may not ask for the full account is not shown the choice.
  const limited = htmlTree(choiceScreen({ policy: { verification: { publisher_identity: 'P', verification_version: 1 }, approval: { owner_user_id: 'o' },
    metadata: { client_name: 'C' }, fullAccountEligible: false, resourceScopes: ['admin:read'] } }));
  assert.deepEqual(elements(limited).filter(node => node.tag === 'input' && node.attrs.name === 'mode').map(node => node.attrs.value), ['granular']);
});

// The confirmation screen (a summary is ready): three facts in view, every exact line folded before the decision.
const RW1 = '20000000-0000-4000-8000-000000000001';
const RW2 = '20000000-0000-4000-8000-000000000002';
// Full account takes every permission that can be granted today.
const REVIEW_OPTIONS = adminConsentOptions().filter(option => option.available);
const REVIEW_SCOPES = REVIEW_OPTIONS.map(option => option.scope);
function confirmation(mode, given = {}) {
  const overrides = { ...given };
  const policy = { verification: { publisher_identity: 'Northwind Tools', verification_version: 3, client_id: 'https://ops.example/oauth.json' },
    approval: { owner_user_id: 'owner-1' }, metadata: { client_name: 'Northwind <Ops>' }, fullAccountEligible: true, resourceScopes: REVIEW_SCOPES };
  const selection = mode === 'full_account' ? { mode, workspace_ids: [RW1, RW2] }
    : { mode, scope_names: overrides.scopes ?? ['admin:read', 'seats:create'], workspace_ids: [RW1] };
  delete overrides.scopes;
  const manifest = createAdminManifest(selection, policy, Date.UTC(2026, 10, 18, 22));
  manifest.connection_id = 'connection-1';
  return renderAdminConsentPage({ uid: 'review', version: 2, csrfToken: 'csrf', issuanceState: 'open', scriptNonce: 'nonce-1',
    user: { userId: 'owner-1', displayName: 'Alex' }, policy, workspaces: [{ id: RW1, name: 'One' }, { id: RW2, name: 'Two' }],
    params: { client_id: 'https://ops.example/oauth.json', redirect_uri: 'https://ops.example/callback' },
    receipt: { manifest }, summary: { token: 'summary-token', digest: 'a'.repeat(64), secondToken: 'second-token' }, ...overrides });
}

test('admin confirmation leads with who, where, what and until, and keeps the decision together', () => {
  const html = confirmation('full_account');
  const tree = htmlTree(html);
  assert.equal(text(one(tree, node => node.tag === 'h1')), 'Give Northwind <Ops> full account access?');
  assert.deepEqual(elements(tree).filter(node => node.attrs.class === 'admin-lead').map(text),
    ['Signed in as Alex', 'Verified publisher Northwind Tools, from ops.example']);
  const facts = one(tree, node => node.tag === 'dl' && node.attrs.class === 'admin-facts');
  const rows = elements(facts).filter(node => node.tag === 'dt').map(text);
  assert.deepEqual(rows, ['Where', 'What it may do', 'In workspaces it creates', 'Until']);
  const values = elements(facts).filter(node => node.tag === 'dd').map(text);
  // The reach sentence is the one this screen has always used, with the chosen workspaces named.
  assert.equal(values[0], 'Existing and future workspaces you own, plus selected shared workspaces. Selected workspaces: One, Two');
  assert.equal(values[1], REVIEW_OPTIONS.map(option => option.label).join(', '));
  assert.ok(values[1].startsWith('Read-only, Invite members, ') && values[1].endsWith(', Create workspaces'));
  assert.equal(values[2], 'The same permissions');
  // (The text helper trims the zone's leading space; the page keeps it.)
  assert.match(values[3], /^2026-12-18T22:00:00\.000Z ?\(UTC\)\. Renewal requires your approval again\. You can revoke it in \/app\.$/u);
  // Order: facts, the exact list, the warning, then the form with the confirmation, destination, state and buttons.
  const order = elements(tree);
  const exact = one(tree, node => node.tag === 'details');
  const warning = one(tree, node => node.attrs.id === 'full-account-warning');
  const form = one(tree, node => node.tag === 'form');
  assert.ok(order.indexOf(facts) < order.indexOf(exact) && order.indexOf(exact) < order.indexOf(warning) && order.indexOf(warning) < order.indexOf(form));
  assert.ok(!('open' in exact.attrs), 'the exact list starts folded');
  assert.equal(text(one(exact, node => node.tag === 'summary')), 'Exact permissions and limits');
  assert.equal(text(warning), FULL_ACCOUNT_WARNING);
  // The decision: same fields and values, one unticked required confirmation that points at the warning.
  const inputs = elements(form).filter(node => node.tag === 'input');
  assert.deepEqual(inputs.map(node => [node.attrs.name, node.attrs.value]), [['csrf_token', 'summary-token'],
    ['summary_digest', 'a'.repeat(64)], ['selection_version', '2'], ['second_token', 'second-token'], ['confirm_full_account', 'yes']]);
  const confirm = inputs.at(-1);
  assert.ok('required' in confirm.attrs && !('checked' in confirm.attrs));
  assert.equal(confirm.attrs['aria-describedby'], 'full-account-warning');
  assert.equal(text(one(form, node => node.tag === 'label')), 'I confirm this exact full account summary');
  assert.equal(form.attrs.action, '/interaction/review/consent');
  assert.ok(text(form).includes('After you approve, you return to ops.example'));
  assert.equal(text(one(form, node => node.attrs.class === 'admin-state')),
    'Confirming your selection connects the client with exactly your chosen permissions, and you can revoke this access in /app.');
  assert.deepEqual(elements(form).filter(node => node.tag === 'button').map(text), ['Confirm full account access']);
  const cancel = one(form, node => node.tag === 'a' && text(node) === 'Cancel');
  assert.equal(cancel.attrs.href, 'https://commonswarm.com/app');
  // Only this page's own form: the page's form policy allows no form to another site.
  assert.deepEqual(elements(tree).filter(node => node.tag === 'form').map(node => node.attrs.action), ['/interaction/review/consent']);
  // The local-time script needs exactly one of each target.
  assert.equal(order.filter(node => node.attrs.id === 'local-expiry').length, 1);
  assert.equal(order.filter(node => node.attrs.id === 'expiry-zone').length, 1);
  assert.match(html, /<script nonce="nonce-1">/u);
  assert.doesNotMatch(confirmation('full_account', { scriptNonce: undefined }), /<script/u);
  // While admin connections are closed, the screen says so beside the button.
  assert.equal(text(one(htmlTree(confirmation('full_account', { issuanceState: 'closed' })), node => node.attrs.class === 'admin-state')),
    'Admin connections are not available yet. Reviewing a selection does not connect the client.');
});

test('admin confirmation keeps every exact line, folded in one place', () => {
  for (const mode of ['full_account', 'granular']) {
    const tree = htmlTree(confirmation(mode));
    const exact = text(one(tree, node => node.tag === 'details'));
    const full = mode === 'full_account';
    for (const line of [
      'Named connection: Admin connection connection-1',
      'Signed in as Alex (owner-1)',
      'Client name (supplied by the client): Northwind <Ops>',
      'Client ID: https://ops.example/oauth.json', 'HTTPS client host: ops.example', 'Authorization returns to: ops.example',
      'Independently verified publisher: Northwind Tools; active verification 3. Approved by account owner owner-1.',
      'Read-only — read metadata', 'Create seats — create seat', 'Create seats — provision seat',
      'Manage members — unavailable', 'Billing — unavailable',
      'Admin delegation — unavailable; this connection cannot create admin grants',
      'Seat targets: Your own seats; seats created by this connection; named seats: None.',
      'Recipients: None. Recipient connections: None.',
      'Transports: local, hosted_mcp. Maximum member role: member.',
      'Worker content permissions: None. Workers depend on this grant; replacement or revocation ends dependent access.',
      `Permissions in newly created workspaces: ${full ? [...REVIEW_SCOPES].sort().join(', ') : 'None'}`,
      'Creation limits', 'Workspaces created', 'Renew seats limits', 'Renewals in total',
      'Worker grant kinds: timeboxed. Existing worker principals: None.',
      'Access ends (UTC): 2026-12-18T22:00:00.000Z.',
      'Refresh cannot extend this deadline: 2026-12-18T22:00:00.000Z.',
    ]) assert.ok(exact.includes(line), `${mode}: ${line}`);
    assert.equal(exact.includes('Invite members — invite member'), full);
  }
});

// One witness per kind of grant: the reach line and the warning say what that grant can do, and nothing more.
const reachAndWarning = (html) => {
  const tree = htmlTree(html);
  const facts = one(tree, node => node.tag === 'dl' && node.attrs.class === 'admin-facts');
  const warning = one(tree, node => node.attrs.class === 'admin-warning');
  return { tree, rows: elements(facts).filter(node => node.tag === 'dt').map(text),
    values: elements(facts).filter(node => node.tag === 'dd').map(text), warning: text(warning), warningId: warning.attrs.id };
};

test('a limited grant (read and invite in one workspace) claims no workspace creation, future reach or workers', () => {
  const { tree, rows, values, warning, warningId } = reachAndWarning(confirmation('granular', { scopes: ['admin:read', 'invites:create'] }));
  assert.equal(text(one(tree, node => node.tag === 'h1')), 'Give Northwind <Ops> these permissions?');
  assert.deepEqual(rows, ['Where', 'What it may do', 'Until']);
  assert.equal(values[0], 'Only the selected workspaces. Selected workspaces: One');
  assert.equal(values[1], 'Read-only, Invite members');
  assert.equal(warning, CHOSEN_COMPROMISE_WARNING);
  assert.equal(warningId, 'grant-warning');
  // Nothing in view says what this grant cannot do. (The exact list still names every limit.)
  const inView = elements(tree).filter(node => ['h1', 'dd', 'dt'].includes(node.tag) || node.attrs.class === 'admin-warning').map(text).join(' ');
  assert.doesNotMatch(inView, /create workspaces|future|newly created|Workers|change seats/iu);
  const form = one(tree, node => node.tag === 'form');
  assert.deepEqual(elements(form).filter(node => node.tag === 'input').map(node => node.attrs.name), ['csrf_token', 'summary_digest', 'selection_version']);
  assert.deepEqual(elements(form).filter(node => node.tag === 'button').map(text), ['Confirm chosen permissions']);
});

test('a chosen grant that can create seats says its workers may read; one that can create workspaces keeps that reach', () => {
  const seats = reachAndWarning(confirmation('granular', { scopes: ['admin:read', 'seats:create'] }));
  assert.equal(seats.values[0], 'Only the selected workspaces. Selected workspaces: One');
  assert.equal(seats.values[1], 'Read-only, Create seats');
  assert.equal(seats.warning, `${WORKER_READ_WARNING} ${CHOSEN_COMPROMISE_WARNING}`);
  assert.doesNotMatch(seats.warning, /create workspaces|future/iu);
  // The control: with Create workspaces chosen, the reach names newly created workspaces and what applies there.
  const creates = reachAndWarning(confirmation('granular', { scopes: ['admin:read', 'workspaces:create'] }));
  assert.deepEqual(creates.rows, ['Where', 'What it may do', 'In workspaces it creates', 'Until']);
  assert.equal(creates.values[0], 'Only the selected workspaces and expressly approved newly created workspaces. Selected workspaces: One');
  assert.equal(creates.values[1], 'Read-only, Create workspaces');
  assert.equal(creates.values[2], 'The same permissions');
  assert.equal(creates.warning, CHOSEN_COMPROMISE_WARNING);
  assert.equal(text(one(creates.tree, node => node.tag === 'h2')), 'Chosen permissions');
});

test('a full-account grant keeps its warning, its reach into future workspaces and its separate confirmation', () => {
  const { tree, rows, values, warning, warningId } = reachAndWarning(confirmation('full_account'));
  assert.deepEqual(rows, ['Where', 'What it may do', 'In workspaces it creates', 'Until']);
  assert.equal(values[0], 'Existing and future workspaces you own, plus selected shared workspaces. Selected workspaces: One, Two');
  assert.equal(warning, FULL_ACCOUNT_WARNING);
  assert.equal(warningId, 'full-account-warning');
  const confirm = one(tree, node => node.tag === 'input' && node.attrs.name === 'confirm_full_account');
  assert.equal(confirm.attrs['aria-describedby'], 'full-account-warning');
  assert.ok('required' in confirm.attrs && !('checked' in confirm.attrs));
});

test('the screen for an app that cannot have admin access is unchanged', () => {
  const html = renderAdminConsentPage({ uid: 'refused', user: { userId: 'owner-1' }, csrfToken: 'csrf', version: 0,
    params: { client_id: 'https://ops.example/oauth.json', redirect_uri: 'https://ops.example/callback' }, policy: { metadata: { client_name: 'Ops' } } });
  const tree = htmlTree(html);
  assert.equal(text(one(tree, node => node.tag === 'h1')), 'Review admin access');
  assert.ok(html.includes('This client is unverified. Admin access is unavailable.'));
  assert.deepEqual(elements(tree).filter(node => node.tag === 'button').map(text), ['Cancel and return to /app']);
  assert.equal(elements(tree).filter(node => node.tag === 'details').length, 0);
});

test('the admin refusal page has a heading, the reason, the ordinary way forward and the way back', () => {
  const reasons = {
    unauthorized_client: 'CommonSwarm couldn’t confirm that this app is eligible for admin access to your account.',
    dpop_required: 'This app cannot prove possession of its access key, so it cannot be given admin access.',
  };
  for (const [code, reason] of Object.entries(reasons)) {
    const html = renderAdminRefusedPage(code);
    const tree = htmlTree(html);
    assert.equal(text(one(tree, node => node.tag === 'title')), 'Admin access unavailable');
    assert.equal(text(one(tree, node => node.tag === 'h1')), 'Admin access is not available for this app');
    const paragraphs = elements(tree).filter(node => node.tag === 'p').map(text);
    assert.deepEqual(paragraphs, [reason, 'To connect without admin access, add CommonSwarm as a connector in the app and choose which workspaces it may use.']);
    // One way out, a plain link; no form, no script, nothing from the request.
    const links = elements(tree).filter(node => node.tag === 'a');
    assert.deepEqual(links.map(node => [text(node), node.attrs.href]), [['Return to CommonSwarm', 'https://commonswarm.com/app']]);
    assert.equal(elements(tree).filter(node => ['form', 'script', 'input', 'button', 'img'].includes(node.tag)).length, 0);
    assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  }
  // An unknown code never prints itself; it reads as the general refusal.
  const unknown = renderAdminRefusedPage('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(unknown, /onerror|<img/);
  assert.ok(unknown.includes(reasons.unauthorized_client));
  assert.ok(renderAdminRefusedPage('constructor').includes(reasons.unauthorized_client), 'inherited object keys are not reasons');
});
