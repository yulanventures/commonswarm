import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderAdminConsentPage } from '../src/admin-interaction-page.js';

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

test('admin-site-lifecycle: second-confirmation-accessibility on hosted consent; warning and exact summary', () => {
  const expiry = '2026-10-23T14:15:00.000Z', deadline = '2026-10-22T12:30:00.000Z';
  const manifest = {
    mode: 'full_account', connection_id: 'exact-connection', workspace_selector: 'owned_and_selected', workspace_ids: ['workspace-1'],
    capability_names: ['admin_read_metadata', 'admin_create_workspace'], role_ceiling: 'member',
    target_rules: { own_seats: true, grant_created_seats: false, seat_ids: ['seat-exact'],
      recipient_user_ids: ['recipient-exact'], recipient_connection_ids: ['connection-exact'], transports: ['local'] },
    worker_scope_ceiling: ['signals:read'], created_workspace_policy: { scope_names: ['admin:read', 'workspaces:create'] },
    issuance_limits: { workspaces: 3, live_seats: 4, total_seats: 12, invitations: 6 },
    renewal_limits: { bearer_seconds: 600, horizon_seconds: 3600, successors_per_worker: 7, successors_per_grant: 21,
      grant_kinds: ['timeboxed'], principal_ids: ['worker-exact'] },
    expires_at: Date.parse(expiry), refresh_deadline: Date.parse(deadline),
  };
  const tree = htmlTree(renderAdminConsentPage({ uid: 'exact-interaction', user: { userId: 'owner-1', displayName: 'Owner' },
    params: { client_id: 'https://client.example/oauth.json', redirect_uri: 'https://callback.example/return' },
    policy: { metadata: { client_name: 'Admin <app> & "friends"' }, verification: { publisher_identity: 'Reviewed publisher', verification_version: 2 }, approval: { owner_user_id: 'owner-1' } },
    version: 3, receipt: { manifest }, summary: { token: 'csrf-exact', secondToken: 'second-exact', digest: 'digest-exact' },
    workspaces: [{ id: 'workspace-1', name: 'Selected <workspace>' }],
  }));
  const confirmation = one(tree, node => node.tag === 'input' && node.attrs.name === 'confirm_full_account');
  assert.equal(confirmation.attrs.type, 'checkbox'); assert.equal(confirmation.attrs.value, 'yes');
  assert.ok('required' in confirmation.attrs); assert.ok(!('disabled' in confirmation.attrs));
  assert.ok(confirmation.attrs.tabindex === undefined || Number(confirmation.attrs.tabindex) >= 0, 'confirmation is keyboard focusable');
  const label = one(tree, node => node.tag === 'label' && elements(node).includes(confirmation));
  assert.equal(text(label), 'I confirm this exact full account summary', 'second confirmation has an accessible label');
  const warningIds = confirmation.attrs['aria-describedby']?.trim().split(/\s+/) ?? [];
  assert.ok(warningIds.length, 'second confirmation must describe its full-account warning');
  const described = warningIds.map(id => text(one(tree, node => node.attrs.id === id))).join(' ');
  const spec = readFileSync(new URL('../../../docs/design/2026-10-02-ADMIN-ISSUANCE-SPEC.md', import.meta.url), 'utf8');
  const warning = /Full account requires[^\n]+Warning: “([^”]+)”/.exec(spec)?.[1];
  assert.ok(warning, 'spec defines the full-account warning');
  assert.equal(described, warning, 'all workspace/seat/invitation, future workspace, worker content and compromised-host powers are associated');
  const confirm = one(tree, node => node.tag === 'button' && text(node) === 'Confirm full account access');
  const cancel = one(tree, node => node.tag === 'button' && text(node) === 'Cancel and return to /app');
  for (const button of [confirm, cancel]) {
    assert.equal(button.attrs.type, 'submit'); assert.ok(!('disabled' in button.attrs));
    assert.ok(button.attrs.tabindex === undefined || Number(button.attrs.tabindex) >= 0, 'native button is keyboard operable');
  }
  const consentForm = one(tree, node => node.tag === 'form' && elements(node).includes(confirm));
  assert.equal(consentForm.attrs.method, 'post'); assert.equal(consentForm.attrs.action, '/interaction/exact-interaction/consent');
  assert.ok(elements(consentForm).includes(confirmation));
  assert.ok(text(consentForm).includes('Client name (supplied by the client): Admin <app> & "friends"'));
  assert.ok(text(consentForm).includes('After you approve, you return to callback.example'));
  assert.ok(text(consentForm).includes('Client ID URL host: client.example'));
  for (const [name, value] of [['csrf_token','csrf-exact'], ['second_token','second-exact'], ['summary_digest','digest-exact'], ['selection_version','3']]) {
    assert.equal(one(consentForm, node => node.tag === 'input' && node.attrs.name === name).attrs.value, value);
  }
  const cancelForm = one(tree, node => node.tag === 'form' && elements(node).includes(cancel));
  assert.equal(cancelForm.attrs.method, 'get'); assert.equal(cancelForm.attrs.action, 'https://commonswarm.com/app');
  assert.ok(!elements(cancelForm).includes(confirmation), 'cancel is independent of required confirmation');
  const summary = one(tree, node => node.tag === 'section' && node.attrs['aria-labelledby'] === 'summary');
  assert.equal(text(one(summary, node => node.tag === 'h2')), 'Full account');
  for (const detail of [
    'Named connection: Admin connection exact-connection', 'Existing and future workspaces you own, plus selected shared workspaces',
    'Selected workspaces: Selected <workspace>', 'Read-only', 'Create workspaces', 'Billing — unavailable',
    'Admin delegation — unavailable; this connection cannot create admin grants',
    'Your own seats; no grant-created seats; named seats: seat-exact', 'Recipients: recipient-exact. Recipient connections: connection-exact.',
    'Transports: local. Maximum member role: member.', 'Worker content permissions: signals:read.',
    'Permissions in newly created workspaces: admin:read, workspaces:create', 'Worker grant kinds: timeboxed. Existing worker principals: worker-exact.',
    expiry, deadline, 'Renewal requires your approval again',
  ]) assert.ok(text(summary).includes(detail), `missing exact summary detail: ${detail}`);
  // Match semantic label/value pairs; values alone could be shown under wrong limits.
  for (const [labelText, value] of [['Workspaces created','3'], ['Live seats','4'], ['Seats created in total','12'], ['Invitations','6'],
    ['Worker access lifetime (seconds)','600'], ['Worker renewal period (seconds)','3600'], ['Renewals per worker','7'], ['Renewals in total','21']]) {
    const list = one(summary, node => node.tag === 'dl' && elements(node).some(child => child.tag === 'dt' && text(child) === labelText));
    const children = list.children.filter((child) => typeof child !== 'string');
    const index = children.findIndex(child => child.tag === 'dt' && text(child) === labelText);
    assert.equal(children[index+1]?.tag, 'dd'); assert.equal(text(children[index+1]), value);
  }
  const all = text(tree);
  assert.ok(all.includes('HTTPS client host: client.example'));
  assert.ok(all.includes('Authorization returns to: callback.example'));
  assert.ok(all.includes('After you approve, you return to callback.example'));
});

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
