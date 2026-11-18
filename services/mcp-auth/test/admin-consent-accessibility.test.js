import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
