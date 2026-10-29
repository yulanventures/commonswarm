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
